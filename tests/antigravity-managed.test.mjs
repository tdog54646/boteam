import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import * as adapter from '../desktop/adapters/antigravity.mjs'
import { withAcp } from '../desktop/adapters/antigravity-acp.mjs'
import { privateProfile } from '../desktop/adapters/antigravity-profile.mjs'

const mac = { skip: process.platform !== 'darwin' }
const sid = '1f584663-512d-456f-98c9-4bf98f249ab4'
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'boteam-agy-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'profile'),
    cwd = join(root, 'project'),
    bin = join(root, 'agy')
  await mkdir(source, { mode: 0o700 })
  await mkdir(cwd)
  const fixture = await readFile(
    new URL('./antigravity-native-fixture.cjs', import.meta.url),
    'utf8',
  )
  await writeFile(bin, `#!${process.execPath}\n${fixture}`, { mode: 0o700 })
  const state = (data = {}) =>
    writeFile(
      join(source, 'fixture'),
      JSON.stringify({
        email: 'Member@example.com',
        plan: 'Google AI Pro',
        ...data,
      }),
    )
  await state()
  return {
    account: { source, bin, managed: true },
    cwd,
    state,
    seen: () => readFile(join(source, 'seen'), 'utf8'),
  }
}

test('the isolated native store can stat its parent and persist its own SQLite without listing other accounts', mac, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'boteam-agy-store-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = await mkdtemp(join(root, 'profile-'))
  const sibling = await mkdtemp(join(root, 'profile-'))
  await writeFile(join(sibling, 'private'), 'test-only')
  const profile = await privateProfile('/usr/bin/sqlite3', home)
  const native = (program, ...args) => execFileSync('/usr/bin/sandbox-exec',
    ['-p', profile.shield, program, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const db = join(home, 'history.db')
  assert.equal(native('/usr/bin/stat', '-f', '%HT', root).trim(), 'Directory')
  native('/usr/bin/sqlite3', db, "pragma journal_mode=wal;create table t(v);insert into t values ('saved');")
  assert.equal(native('/usr/bin/sqlite3', db, 'select v from t;').trim(), 'saved')
  assert.throws(() => native('/bin/ls', root), /permitted|denied/i)
  assert.throws(() => native('/bin/cat', join(sibling, 'private')), /permitted|denied/i)
  assert.throws(() => native('/usr/bin/sqlite3', join(sibling, 'other.db'), 'create table t(v);'))
})

test('a completed native turn has time to finish its background save after EOF', mac, async (t) => {
  const { account, cwd, state } = await setup(t)
  Object.assign(account, await adapter.detect(account))
  await state({ simulateAsyncSave: true })
  await adapter.run({ account, cwd, bot: {}, prompt: 'save', emit: () => {}, approve: () => false })
  assert.equal(await readFile(join(account.source, 'saved'), 'utf8'), 'persisted')
})

test('ACP distinguishes input-size errors, subscription limits and a max_tokens stop', mac, async t => {
  const { account, cwd, state } = await setup(t)
  Object.assign(account, await adapter.detect(account))
  for (const [outcome, expected] of [
    [{ promptError: { code: -32000, message: 'The input token count (40970) exceeds the maximum number of tokens allowed (32768). private-marker' } }, /输入.*窗口/],
    [{ promptError: { code: -32603, message: 'rate limit exceeded for input tokens per minute: private-marker' } }, /额度|速率/],
    [{ stopReason: 'max_tokens' }, /token 上限/i],
  ]) {
    await state(outcome)
    await assert.rejects(adapter.run({ account, cwd, prompt: 'request', emit() {} }),
      error => expected.test(error.message) && !error.message.includes('private-marker'))
  }
})

test(
  'managed native profile binds paid statusline identity, reads per-model effort, and runs ACP',
  mac,
  async (t) => {
    const { account, cwd, seen } = await setup(t)
    const found = await adapter.detect(account)
    assert.equal(found.status, 'ready', found.reason)
    assert.equal(found.email, 'member@example.com')
    Object.assign(account, found)
    const catalog = await adapter.options({ account })
    const importedDefault = await adapter.options({ account: { ...account, model: 'gemini-flash' } })
    assert.equal(importedDefault.defaultModel, 'gemini-flash')
    assert.deepEqual(importedDefault.efforts.map(level => level.id), ['low'])
    assert.deepEqual(
      catalog.models.map((m) => [m.id, m.efforts.map((e) => e.id)]),
      [
        ['gemini-pro', ['low', 'high']],
        ['gemini-flash', ['low']],
      ],
    )
    const events = []
    await adapter.run({
      account,
      bot: { model: 'gemini-flash', effort: 'low' },
      cwd,
      threadId: sid,
      prompt: 'requested text',
      emit: (e) => events.push(e),
      approve: () => false,
    })
    assert.deepEqual(
      events.filter((e) => e.type === 'text').map((e) => e.value),
      ['reply'],
    )
    assert.equal(events[0].key, account.identity)
    assert.match(await seen(), /"model":"gemini-flash","effort":"low"/)
    assert.match(await seen(), /"optionId":"no"/)
    assert.doesNotMatch(JSON.stringify([events, account]), /SHOULD_NOT_LEAK/)
  },
)
test('fresh ACP catalogs reflect changed models and preserve the initial native effort', mac, async t => {
  const { account, state } = await setup(t)
  await state({ initialSession: { model: 'gemini-flash', effort: 'low' } })
  Object.assign(account, await adapter.detect(account))
  const previous = await adapter.options({ account })
  assert.deepEqual(previous.models.map(model => model.id), ['gemini-pro', 'gemini-flash'])
  assert.equal(previous.defaultModel, 'gemini-flash')
  assert.equal(previous.defaultEffort, 'low')

  await state({ modelOptions: [
    { value: 'new-native-id', name: 'New native model' },
    { value: 'gemini-pro', name: 'Renamed Pro' },
  ] })
  const catalog = await adapter.options({ account })
  assert.deepEqual(catalog.models.map(({ id, label }) => [id, label]), [
    ['new-native-id', 'New native model'], ['gemini-pro', 'Renamed Pro'],
  ])
  assert.equal(catalog.defaultModel, 'gemini-pro')
  assert.equal(catalog.defaultEffort, 'high')
  assert.equal(catalog.models[1].defaultEffort, catalog.defaultEffort)
})

test(
  'stale binding, unpaid native identity, tier mismatch and unsupported effort never send a prompt',
  mac,
  async (t) => {
    const { account, cwd, state, seen } = await setup(t)
    const found = await adapter.detect(account)
    Object.assign(account, found)
    const run = (bot) =>
      adapter.run({
        account,
        cwd,
        bot,
        prompt: 'sensitive',
        emit: () => {},
        approve: () => false,
      })
    await state({ email: 'other@example.com' })
    await assert.rejects(run({}), /身份|绑定/)
    await state({ plan: 'Free' })
    await assert.rejects(run({}), /订阅|套餐/)
    await state({ acpPlan: 'Google AI Ultra' })
    await assert.rejects(run({}), /订阅|套餐/)
    await state()
    await assert.rejects(run({ model: 'gemini-flash', effort: 'high' }), /档位|推理|强度/)
    await assert.rejects(seen(), { code: 'ENOENT' })
  },
)

test('clearing both selectors restores native defaults on a resumed session', mac, async (t) => {
  const { account, cwd, seen } = await setup(t)
  Object.assign(account, await adapter.detect(account))
  const events = []
  await adapter.run({
    account,
    bot: {},
    cwd,
    threadId: sid,
    prompt: 'next turn',
    emit: (e) => events.push(e),
    approve: () => true,
  })
  const called = JSON.parse((await seen()).split('\n')[0])
  assert.equal(called.params.sessionId, sid)
  assert.equal(called.model, 'gemini-pro')
  assert.equal(called.effort, 'high')
  assert.equal(called.mode, 'default')
  assert.ok(
    events.some(
      (e) => e.type === 'tool' && e.value.includes('Gemini Pro') && e.value.includes('high'),
    ),
  )
})

test('workspace auto requires native confirmation on the original Antigravity thread', mac, async t => {
  const { account, cwd, seen, state } = await setup(t)
  Object.assign(account, await adapter.detect(account))
  const modes = ['default', 'accept-edits', 'auto', 'plan']
  const settings = { modes, traceSessions: true, recordModeChanges: true }
  const args = { account, cwd, permission: 'workspace-auto', prompt: 'first', emit() {}, approve: () => false }
  const calls = async () => (await seen()).trim().split('\n').map(line => JSON.parse(line))
  await state(settings)
  await adapter.run(args)
  const first = (await calls()).find(call => call.method === 'session/prompt')
  assert.equal(first.mode, 'auto')
  const threadId = first.params.sessionId

  for (const [name, overrides, fails] of [
    ['resume with auto only in the legacy picker', { modes: ['default'], restoredModes: ['default'], legacyModes: modes, acceptedModes: modes }],
    ['load with auto only in the fresh picker', { loadOnly: true, restoredModes: ['default'], legacyModes: ['default'] }],
    ['model and effort changes omit the previously advertised mode', { modesAfterSelection: null }],
    ['native mode write rejected', { restoredModes: [], acceptedModes: ['default'] }, true],
    ['native mode write unconfirmed', { restoredModes: [], ignoreModeChange: true }, true],
  ]) await t.test(name, async () => {
    await state({ ...settings, ...overrides })
    const offset = (await calls()).length
    const run = adapter.run({ ...args, threadId, prompt: 'continue' })
    if (fails) await assert.rejects(run)
    else await run

    const records = (await calls()).slice(offset)
    const restored = records.filter(r => ['session/resume', 'session/load'].includes(r.method))
    assert.deepEqual(restored.map(r => r.sessionId), [threadId])
    const changes = records.filter(r => r.method === 'session/set_config_option' && r.params.value === 'auto')
    assert.deepEqual(changes.map(r => r.params.sessionId), [threadId], 'ask the target CLI to confirm auto')
    const prompts = records.filter(r => r.method === 'session/prompt')
    assert.deepEqual(prompts.map(r => [r.params.sessionId, r.mode]), fails ? [] : [[threadId, 'auto']])
    const closed = new Set(records.filter(r => r.method === 'session/close').map(r => r.sessionId))
    assert.ok(records.filter(r => r.method === 'session/new').every(r => closed.has(r.sessionId)),
      'temporary catalog sessions must not become replacement threads')
  })
})

test('scoped native slash catalog and permissions are rechecked by the actual ACP session', mac, async (t) => {
  const { account, cwd, state, seen } = await setup(t)
  Object.assign(account, await adapter.detect(account))
  const skill = join(cwd, '.agents/skills/check-copy')
  await mkdir(skill, { recursive: true })
  await writeFile(join(skill, 'SKILL.md'), '---\nname: check-copy\ndescription: Check writing\n---\n')
  const commands = ['goal','clear','schedule','check-copy','grill-me','unverified'].map(name => ({ name, description: name }))
  await state({ commands, modes: ['default', 'plan', 'auto'] })
  const result = await adapter.composerActions({ account, cwd })
  assert.equal(result.workspaceAuto, true)
  assert.equal(result.plan, true)
  assert.equal(result.goal, false)
  assert.equal(result.maxExtensions, 1)
  assert.deepEqual(result.extensions.map(item => item.label).sort(), ['/check-copy','/grill-me'])
  const extensionIds = [result.extensions.find(item => item.label === '/check-copy').id]
  const args = { account, cwd, extensionIds, prompt: 'draft', emit: () => {}, approve: () => false }
  await adapter.run({ ...args, permission: 'workspace-auto' })
  const first = JSON.parse((await seen()).split('\n')[0])
  assert.equal(first.params.prompt[0].text, '/check-copy draft')
  assert.equal(first.mode, 'auto')
  await state({ commands, modes: ['default'], legacyModes: ['default', 'plan', 'auto'] })
  const legacy = await adapter.composerActions({ account, cwd })
  assert.equal(legacy.workspaceAuto, true)
  assert.equal(legacy.plan, true)
  const count = (await seen()).length
  await state({ commands: [], modes: ['default'] })
  await assert.rejects(adapter.run(args), /不可用/)
  await assert.rejects(adapter.run({ ...args, extensionIds: [], permission: 'workspace-auto' }), /权限模式/)
  await assert.rejects(adapter.run({ ...args, extensionIds: [], planMode: true }), /权限模式/)
  assert.equal((await seen()).length, count)
})

test('Antigravity advertises ACP commands and revalidates them on the target session', mac, async (t) => {
  const { account, cwd, state, seen } = await setup(t)
  Object.assign(account, await adapter.detect(account))
  const commands = [
    { name: 'compact', description: 'Summarize this conversation', input: { hint: '[focus]' } },
    { name: 'browser', description: 'Use a browser' }, { name: 'login' },
    { name: 'bad name' }, { name: 'compact', description: 'duplicate' },
  ]
  await state({ commands })
  const { slashCommands } = await adapter.composerActions({ account, cwd })
  assert.deepEqual(slashCommands.map(c => [c.name,c.action]), [
    ['compact','prompt'], ['browser','prompt'], ['login','unavailable'],
  ])
  assert.equal(slashCommands[0].argumentHint, '[focus]')
  const task = { account, cwd, slashCommand: 'compact', prompt: 'the first step', emit: () => {}, approve: () => false }
  await adapter.run(task)
  assert.equal(JSON.parse((await seen()).split('\n')[0]).params.prompt[0].text, '/compact the first step')
  const count = (await seen()).length
  await assert.rejects(adapter.run({ ...task, slashCommand: 'login' }), /命令/)
  await state({ commands: [] })
  await assert.rejects(adapter.run(task), /命令/)
  assert.equal((await seen()).length, count)
})

test('load restores the exact thread after a native read error or on a load-only CLI, suppressing replay', mac, async (t) => {
  const { account, cwd, state } = await setup(t)
  Object.assign(account, await adapter.detect(account))
  const resumeError = { code: -32603, message: 'Failed to read session; retry, or load it with session/load' }
  for (const behavior of [{ resumeError }, { loadOnly: true }]) {
    await state(behavior)
    const events = [], approvals = []
    await adapter.run({
      account, cwd, threadId: sid, prompt: 'next turn',
      bot: { model: 'gemini-flash', effort: 'low' },
      emit: (event) => events.push(event),
      approve: (req) => { approvals.push(req.detail); return false },
    })
    assert.deepEqual(events.filter((e) => e.type === 'session').map((e) => e.value), [sid])
    assert.deepEqual(events.filter((e) => e.type === 'text').map((e) => e.value), ['reply'])
    assert.deepEqual(approvals, ['Edit file'])
  }
  await state({ resumeError: { code: -32000, message: 'Authentication required' } })
  await assert.rejects(adapter.run({
    account, cwd, threadId: sid, bot: { model: 'gemini-flash', effort: 'low' },
    emit: () => assert.fail('expired grant must not load history'), prompt: 'private',
  }), /登录/)
})

test(
  'reauthorizing an existing account migrates just the referenced native conversations',
  mac,
  async (t) => {
    const { account } = await setup(t)
    const previous = await mkdtemp(join(tmpdir(), 'boteam-agy-old-'))
    t.after(() => rm(previous, { recursive: true, force: true }))
    const cli = (base) => join(base, '.gemini', 'antigravity-cli')
    await mkdir(join(cli(previous), 'conversations'), { recursive: true })
    await writeFile(join(cli(previous), 'conversations', sid + '.db'), 'native conversation')
    await writeFile(join(cli(previous), 'unrelated-private-file'), 'old state')
    const candidate = { ...account, ...(await adapter.detect(account)) }
    const ready = await adapter.prepare({
      candidate,
      existing: { ...candidate, source: previous },
      threadIds: [sid],
    })
    assert.equal(ready.source, account.source)
    assert.equal(
      await readFile(join(cli(account.source), 'conversations', sid + '.db'), 'utf8'),
      'native conversation',
    )
    await assert.rejects(readFile(join(cli(account.source), 'unrelated-private-file')), {
      code: 'ENOENT',
    })
  },
)

test(
  'discovery checks the live ACP subscription before marking a managed account ready',
  mac,
  async (t) => {
    const { account, state } = await setup(t)
    await state({ acpPlan: 'Free' })
    const found = await adapter.detect(account)
    assert.notEqual(found.status, 'ready')
    assert.match(found.reason, /订阅/)
  },
)

test('simultaneous native runs stay in their independently bound account homes', mac, async (t) => {
  const [a, b] = await Promise.all([setup(t), setup(t)])
  await b.state({ email: 'Second@example.com', plan: 'Google AI Ultra' })
  const [first, second] = await Promise.all([adapter.detect(a.account), adapter.detect(b.account)])
  const results = await Promise.all(
    [
      [a, first],
      [b, second],
    ].map(async ([native, found]) => {
      const identity = []
      await adapter.run({
        account: { ...native.account, ...found },
        cwd: native.cwd,
        prompt: found.email,
        emit: (e) => {
          if (e.type === 'identity') identity.push(e.value)
        },
        approve: () => false,
      })
      return [identity, JSON.parse((await native.seen()).split('\n')[0]).params.prompt[0].text]
    }),
  )
  assert.deepEqual(results, [
    [['member@example.com'], 'member@example.com'],
    [['second@example.com'], 'second@example.com'],
  ])
})

test(
  'managed profiles configured for API billing cannot inherit a historical subscription identity',
  mac,
  async (t) => {
    const { account } = await setup(t)
    const settings = join(account.source, '.gemini', 'antigravity-cli')
    await mkdir(settings, { recursive: true })
    await writeFile(
      join(settings, 'settings.json'),
      JSON.stringify({ auth: { type: 'gemini-api-key' }, modelProvider: 'gemini' }),
    )
    const found = await adapter.detect(account)
    assert.notEqual(found.status, 'ready')
    assert.match(found.reason, /Google.*订阅|OAuth/)
  },
)

test('Google OAuth returns to agy on localhost and a verified grant resumes without another browser', mac, async (t) => {
  const { account, state } = await setup(t)
  let opened = 0
  const openUrl = async (raw) => {
    const url = new URL(raw)
    assert.equal(url.origin, 'https://accounts.google.com')
    assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:24680/auth/callback')
    opened++
  }
  await state({ failGrant: true })
  await assert.rejects(adapter.login({ ...account, openUrl }), /登录/)
  assert.equal(await adapter.hasStagedLogin(account), false)
  await state()
  await adapter.login({ ...account, openUrl })
  assert.equal(opened, 1)
  assert.equal(await adapter.hasStagedLogin(account), true)
  await adapter.login({ ...account, openUrl })
  assert.equal(opened, 1)
})

test('a foreign browser destination or callback fails before forwarding the login request', mac, async (t) => {
  const { account, state } = await setup(t)
  const openUrl = () => assert.fail('unexpected browser launch')
  for (const authUrl of [
    'https://elsewhere.invalid/oauth',
    'https://accounts.google.com/o/oauth2/auth?response_type=code&state=fixture&code_challenge=fixture&code_challenge_method=S256&redirect_uri=https://elsewhere.invalid/auth/callback',
  ]) {
    await state({ authUrl })
    await assert.rejects(adapter.login({ ...account, openUrl }), /登录地址及本机回调/)
    assert.equal(await adapter.hasStagedLogin(account), false)
  }
})

test('cancelling one pending Google browser grant leaves another agy login intact', mac, async (t) => {
  const [first, second] = await Promise.all([setup(t), setup(t)])
  const controller = new AbortController()
  await first.state({ holdGrant: true })
  let ready
  const waiting = new Promise((resolve) => { ready = resolve })
  const cancelled = assert.rejects(adapter.login({
    ...first.account,
    signal: controller.signal,
    openUrl: async () => ready(),
  }), /停止/)
  await waiting
  await adapter.login({ ...second.account, openUrl: async () => controller.abort() })
  await cancelled
  assert.equal(await adapter.hasStagedLogin(first.account), false)
  assert.equal(await adapter.hasStagedLogin(second.account), true)
})

test(
  'ACP applies and confirms plan with native context, image input and weekly-only model quota',
  mac,
  async (t) => {
    const { account, cwd, seen } = await setup(t)
    Object.assign(account, await adapter.detect(account))
    const events = [],
      image = join(cwd, 'x.png')
    await writeFile(image, 'snapshot')
    await adapter.run({
      account,
      cwd,
      bot: { model: 'gemini-pro' },
      permission: 'plan',
      prompt: 'snapshot',
      attachments: [{ path: image, size: 8, mimeType: 'image/png' }],
      emit: (e) => events.push(e),
      approve: () => false,
    })
    const sent = JSON.parse((await seen()).split('\n')[0])
    assert.equal(sent.mode, 'plan')
    assert.deepEqual(sent.params.prompt[1], {
      type: 'image',
      mimeType: 'image/png',
      data: Buffer.from('snapshot').toString('base64'),
    })
    assert.deepEqual(events.find((e) => e.type === 'context')?.value, {
      used: 701,
      limit: 65000,
      model: 'gemini-pro',
    })
    assert.deepEqual((await adapter.quota({ account, model: 'gemini-pro' })).windows, [
      { minutes: 10080, remainingPercent: 80 },
    ])
    assert.deepEqual((await adapter.quota({ account, model: 'gemini-flash' })).windows, [
      { minutes: 300, remainingPercent: 40 },
    ])
    await assert.rejects(adapter.run({ account, cwd, permission: 'invalid' }), /权限/)
  },
)

test('ACP titles use scoped session info notifications or negotiated session metadata', mac, async t => {
  const { account, cwd, state } = await setup(t)
  Object.assign(account, await adapter.detect(account))
  for (const field of ['eventTitle', 'listTitle']) {
    await state({ [field]: '核对子目录' })
    const titles = []
    await adapter.run({ account, cwd, bot: {}, prompt: 'request', titleRequest: () => !titles.length && 'request',
      emit: e => { if (e.type === 'title') titles.push(e.value) }, approve: () => false })
    assert.deepEqual(titles, ['核对子目录'])
  }
})

test('ACP drains batched dispatch updates before the prompt consumer continues', mac, async t => {
  const { account, cwd, state } = await setup(t)
  await state({
    modes: ['default', 'plan', 'accept-edits', 'auto'],
    recordModeChanges: true,
    batchPromptResult: true,
    promptUpdates: [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Dispatched' } },
      { sessionUpdate: 'tool_call', toolCallId: 'call_batched', name: 'invoke_subagent', status: 'completed' },
    ],
  })
  const profile = await privateProfile(account.bin, account.source)
  const observed = []
  let rpc
  await withAcp(profile, undefined, async ({ params }) => {
    if (params.update.name === 'invoke_subagent') {
      const { sessions } = await rpc('session/list', { cwd }, 1200)
      assert.ok(sessions.some(session => session.sessionId === params.sessionId))
    }
    observed.push(params.update.sessionUpdate)
  }, async (request, _capabilities, drainEvents) => {
    rpc = request
    const { sessionId } = await request('session/new', { cwd, mcpServers: [] })
    const result = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Fixture' }] })
    assert.equal(result.stopReason, 'end_turn')
    await drainEvents()
    assert.deepEqual(observed, ['agent_message_chunk', 'tool_call'])
  })
})

test('ACP reports a current subagent dispatch and its prompt without assuming child completion', mac, async t => {
  const { account, cwd, state } = await setup(t)
  Object.assign(account, await adapter.detect(account))
  const dispatch = { sessionUpdate: 'tool_call', toolCallId: 'call_8112314', name: 'invoke_subagent',
    title: 'Run invoke_subagent', kind: 'other', status: 'in_progress',
    args: { TypeName: 'self', Role: 'Documentation review', Prompt: '核对文档。 access_token=private-value' },
    rawInput: { Prompt: 'raw-input-marker' } }
  const oldChild = '4cddec86-07af-4575-a10d-9342be6b8794'
  const directory = join(account.source, '.gemini', 'antigravity-cli')
  const logs = join(directory, 'brain', oldChild, '.system_generated', 'logs')
  await mkdir(logs, { recursive: true })
  const index = new DatabaseSync(join(directory, 'conversation_summaries.db'))
  try {
    index.exec(`CREATE TABLE conversation_summaries(conversation_id TEXT,parent_conversation_id TEXT,status TEXT,
      not_fully_idle INTEGER,killed INTEGER)`)
    index.prepare("INSERT INTO conversation_summaries VALUES(?,?,'CASCADE_RUN_STATUS_IDLE',0,0)").run(oldChild, sid)
  } finally { index.close() }
  await writeFile(join(logs, 'transcript.jsonl'), [
    { type: 'SYSTEM_MESSAGE', source: 'SYSTEM', step_index: 0, content: dispatch.args.Prompt },
    { type: 'PLANNER_RESPONSE', source: 'MODEL', step_index: 1, status: 'DONE', content: 'old-child-report' },
  ].map(step => JSON.stringify(step)).join('\n'))
  await state({ promptUpdates: [
    { ...dispatch, sessionId: 'foreign', toolCallId: 'call_999999', args: { Prompt: 'foreign-marker' } },
    { ...dispatch, toolCallId: 'call_1234', name: 'other_tool', title: 'Native tool unaffected' },
    { sessionUpdate: 'tool_call_update', toolCallId: 'call_999999', name: 'invoke_subagent', status: 'completed' },
    dispatch,
    dispatch,
    { ...dispatch, sessionUpdate: 'tool_call_update', sessionId: 'foreign', status: 'failed' },
    { ...dispatch, sessionUpdate: 'tool_call_update', status: 'completed', rawOutput: 'raw-output-marker' },
    { ...dispatch, toolCallId: 'call_8112315', args: { TypeName: 'unavailable' } },
    { sessionUpdate: 'tool_call_update', toolCallId: 'call_8112315', status: 'failed' },
  ] })
  const events = []
  await assert.rejects(
    adapter.run({ account, cwd, threadId: sid, bot: { model: 'gemini-flash', effort: 'low' },
      prompt: 'parent prompt', emit: e => events.push(e), approve: () => false }),
    /已收到 0\/1 份报告/,
  )
  const activity = events.filter(e => e.type === 'tool' && e.agent)
  assert.deepEqual(activity.map(e => e.agent.status), ['pendingInit', 'dispatched', 'pendingInit', 'errored'])
  const [{ agent }] = activity
  assert.equal(agent.name, 'Documentation review')
  assert.equal(activity[1].agent.id, agent.id)
  assert.notEqual(activity[3].agent.id, agent.id)
  assert.equal(activity[3].agent.id, activity[2].agent.id)
  const entries = events.filter(e => e.type === 'agentTranscript')
  assert.ok(events.indexOf(activity[0]) < events.indexOf(entries[0]))
  assert.ok(entries.every(e => e.agent.id === agent.id))
  assert.deepEqual(entries.flatMap(e => e.entries).filter(e => e.role !== 'activity').map(({ role, text }) => ({ role, text })),
    [{ role: 'user', text: '核对文档。 access_token=[已隐藏]' }])
  assert.ok(events.some(e => e.type === 'tool' && e.value === 'Native tool unaffected' && !e.agent))
  assert.deepEqual(events.filter(e => e.type === 'text').map(e => e.value), ['reply'])
  assert.doesNotMatch(JSON.stringify(entries), /private-value|foreign-marker|raw-(?:input|output)-marker/)
})

test('ACP keeps an idle-indexed child connected until the web search report wakes its parent', mac, async t => {
  const { account, cwd, state } = await setup(t)
  Object.assign(account, await adapter.detect(account))
  const currentTime = performance.now.bind(performance)
  let simulatedTime = 0
  t.mock.method(performance, 'now', () => currentTime() + simulatedTime)
  const directory = join(account.source, '.gemini', 'antigravity-cli')
  const child = '6aaaa0df-093f-4dac-9610-cad07c3eb145'
  const logs = join(directory, 'brain', child, '.system_generated', 'logs')
  await mkdir(logs, { recursive: true })
  const childPrompt = 'Collect the synthetic fixture results'
  const transcript = join(logs, 'transcript.jsonl')
  const writeSteps = (...steps) => writeFile(transcript, [
    { type: 'SYSTEM_MESSAGE', source: 'SYSTEM', content: childPrompt },
    ...steps,
  ].map((step, step_index) => JSON.stringify({ status: 'DONE', step_index, ...step })).join('\n'))
  const nativeFile = join(directory, 'conversation_summaries.db')
  await state({ promptUpdates: [
    { sessionUpdate: 'tool_call', toolCallId: 'call_178', name: 'invoke_subagent', status: 'completed',
      args: { Role: 'Reader', Prompt: childPrompt } },
  ], backgroundResult: { sessionId: sid, text: 'parent combined result', delay: 13_000 } })
  const events = []
  let archive
  const run = adapter.run({ account, cwd, threadId: sid, bot: { model: 'gemini-flash', effort: 'low' },
    prompt: 'parent prompt', approve: () => false, emit(event) {
      events.push(event)
      if (archive || event.agent?.status !== 'dispatched') return
      archive = (async () => {
        await new Promise(resolve => setTimeout(resolve, 650))
        const index = new DatabaseSync(nativeFile)
        try {
          index.exec(`CREATE TABLE conversation_summaries(conversation_id TEXT,parent_conversation_id TEXT,status TEXT,
            not_fully_idle INTEGER,killed INTEGER)`)
          index.prepare("INSERT INTO conversation_summaries VALUES(?,?,'CASCADE_RUN_STATUS_IDLE',0,0)").run(child, sid)
          index.prepare("INSERT INTO conversation_summaries VALUES(?,NULL,'CASCADE_RUN_STATUS_IDLE',0,0)").run(sid)
          const search = { type: 'PLANNER_RESPONSE', source: 'MODEL', tool_calls: [
            { name: 'search_web' }, { name: 'search_web' },
          ] }
          const result = { type: 'GENERIC', source: 'MODEL', content: 'Search result' }
          await writeSteps(search)
          await new Promise(resolve => setTimeout(resolve, 3500))
          simulatedTime = 570_000
          await new Promise(resolve => setTimeout(resolve, 3000))
          await writeSteps(search, result)
          await new Promise(resolve => setTimeout(resolve, 3000))
          // Exceed ten minutes in total, but only after the search result landed.
          simulatedTime = 630_000
          await new Promise(resolve => setTimeout(resolve, 2300))
          await writeSteps(search, result, result,
            { type: 'PLANNER_RESPONSE', source: 'MODEL', tool_calls: [
              { name: 'send_message', args: { Recipient: JSON.stringify(sid), Message: '"Relevant source found"' } },
            ] }, { type: 'GENERIC', source: 'MODEL', content: `Message sent to "${sid}".` })
          index.prepare("UPDATE conversation_summaries SET status='CASCADE_RUN_STATUS_RUNNING',not_fully_idle=1 WHERE conversation_id=?").run(sid)
          await new Promise(resolve => setTimeout(resolve, 2100))
          index.exec("UPDATE conversation_summaries SET status='CASCADE_RUN_STATUS_IDLE',not_fully_idle=0")
        } finally { index.close() }
      })()
    } })
  try {
    await run
    assert.deepEqual(events.filter(event => event.type === 'text').map(event => event.value), ['reply', 'parent combined result'])
    assert.ok(events.some(event => event.agent?.status === 'completed' && event.agent.nativeThreadId === child))
    assert.ok(events.some(event => event.type === 'agentTranscript' &&
      event.entries.some(entry => entry.role === 'assistant' && entry.text === 'Relevant source found')))
  } finally { await archive }
})

test('ACP detects a child subagent stuck in CORTEX_STEP_STATUS_WAITING and wakes the parent to recover', mac, async t => {
  const { account, cwd, state, seen } = await setup(t)
  Object.assign(account, await adapter.detect(account))
  const directory = join(account.source, '.gemini', 'antigravity-cli')
  const blockedChild = '30c5d45d-87d9-4a85-9f51-10bcc138787b'
  const okChild = '342c8c58-7e79-4e94-a030-e0be2196ef97'
  const blockedPrompt = '检索真实面经与面试轮次'
  const okPrompt = '调研核心业务与技术栈'

  await mkdir(join(directory, 'conversations'), { recursive: true })
  for (const id of [blockedChild, okChild]) {
    await mkdir(join(directory, 'brain', id, '.system_generated', 'logs'), { recursive: true })
  }

  await state({
    modes: ['default', 'plan', 'accept-edits', 'auto'],
    recordModeChanges: true,
    batchPromptResult: true,
    recoveryReply: '主会话已终止挂起的子智能体并完成完整面试题库汇总。',
    promptUpdates: [
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '已派发 2 个并行子 Agent。' },
      },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_blocked',
        name: 'invoke_subagent',
        status: 'completed',
        args: { Role: '面经检索Agent', Prompt: blockedPrompt },
      },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_ok',
        name: 'invoke_subagent',
        status: 'completed',
        args: { Role: '技术栈调研Agent', Prompt: okPrompt },
      },
    ],
  })

  const events = []
  let archive
  const run = adapter.run({
    account,
    cwd,
    threadId: sid,
    bot: { model: 'gemini-flash', effort: 'low' },
    prompt: '生成面经题库',
    approve: () => false,
    emit(event) {
      events.push(event)
      if (archive || event.agent?.id !== `agy:${sid}:call_ok` || event.agent?.status !== 'dispatched') return
      archive = (async () => {
        await new Promise(resolve => setTimeout(resolve, 350))
        const index = new DatabaseSync(join(directory, 'conversation_summaries.db'))
        try {
          index.exec(`CREATE TABLE conversation_summaries(conversation_id TEXT,parent_conversation_id TEXT,status TEXT,
            not_fully_idle INTEGER,killed INTEGER)`)
          index.prepare("INSERT INTO conversation_summaries VALUES(?,?,'CASCADE_RUN_STATUS_IDLE',0,0)").run(blockedChild, sid)
          index.prepare("INSERT INTO conversation_summaries VALUES(?,?,'CASCADE_RUN_STATUS_IDLE',0,0)").run(okChild, sid)
          index.prepare("INSERT INTO conversation_summaries VALUES(?,NULL,'CASCADE_RUN_STATUS_IDLE',0,0)").run(sid)
        } finally { index.close() }

        // Blocked child called search_web then run_command, which entered CORTEX_STEP_STATUS_WAITING (status=9)
        await writeFile(join(directory, 'brain', blockedChild, '.system_generated', 'logs', 'transcript.jsonl'), [
          { step_index: 0, type: 'SYSTEM_MESSAGE', source: 'SYSTEM', status: 'DONE', content: blockedPrompt },
          { step_index: 1, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', tool_calls: [{ name: 'search_web' }] },
          { step_index: 2, type: 'GENERIC', source: 'MODEL', status: 'DONE', content: 'search summary' },
          { step_index: 3, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', tool_calls: [{ name: 'run_command', args: { CommandLine: '"mkdir -p agents/cpp && clang++ solution.cpp"' } }] },
        ].map(s => JSON.stringify(s)).join('\n'))
        const blockedDb = new DatabaseSync(join(directory, 'conversations', blockedChild + '.db'))
        try {
          blockedDb.exec('CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER)')
          blockedDb.prepare('INSERT INTO steps VALUES(3, 15, 3), (4, 132, 9)').run()
        } finally { blockedDb.close() }

        // OK child completed and sent report to parent
        await writeFile(join(directory, 'brain', okChild, '.system_generated', 'logs', 'transcript.jsonl'), [
          { step_index: 0, type: 'SYSTEM_MESSAGE', source: 'SYSTEM', status: 'DONE', content: okPrompt },
          {
            step_index: 1,
            type: 'PLANNER_RESPONSE',
            source: 'MODEL',
            status: 'DONE',
            tool_calls: [{ name: 'send_message', args: { Recipient: JSON.stringify(sid), Message: '"技术栈报告已送达"' } }],
          },
          { step_index: 2, type: 'GENERIC', source: 'MODEL', status: 'DONE', content: `Message sent to "${sid}".` },
        ].map(s => JSON.stringify(s)).join('\n'))
        const okDb = new DatabaseSync(join(directory, 'conversations', okChild + '.db'))
        try {
          okDb.exec('CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER)')
          okDb.prepare('INSERT INTO steps VALUES(2, 132, 3)').run()
        } finally { okDb.close() }
      })()
    },
  })

  try {
    await run
    const texts = events.filter(e => e.type === 'text')
    assert.deepEqual(texts.map(e => e.value), [
      '已派发 2 个并行子 Agent。',
      '主会话已终止挂起的子智能体并完成完整面试题库汇总。',
    ])
    assert.notEqual(texts[0].itemId, texts[1].itemId)
    assert.ok(events.some(e => e.agent?.nativeThreadId === blockedChild && e.agent?.status === 'interrupted'))
    assert.ok(events.some(e => e.agent?.nativeThreadId === okChild && e.agent?.status === 'completed'))
    assert.ok(events.some(e => e.type === 'agentTranscript' &&
      e.entries.some(entry => entry.role === 'activity' && entry.text.includes('等待权限确认 · 运行命令'))))
    const recordedCalls = (await seen()).trim().split('\n').map(line => JSON.parse(line))
    const recoveryCall = recordedCalls.find(c => c.recovery)
    assert.ok(recoveryCall)
    assert.match(recoveryCall.params.prompt[0].text, new RegExp(blockedChild))
    assert.match(recoveryCall.params.prompt[0].text, /manage_subagents/)
  } finally {
    await archive
  }
})

test('ACP prompts user approval for CORTEX_STEP_STATUS_WAITING=9 subagents under default permission and elevates then restores mode when approved', mac, async t => {
  const { account, cwd, state, seen } = await setup(t)
  Object.assign(account, await adapter.detect(account))
  const directory = join(account.source, '.gemini', 'antigravity-cli')
  const blockedChild = 'bc65f2eb-906b-4f6d-9884-25441e01586c'
  const blockedPrompt = '写出整数划分最优雅 C++ 解法并编译运行验证 n=1..8'

  await mkdir(join(directory, 'conversations'), { recursive: true })
  await mkdir(join(directory, 'brain', blockedChild, '.system_generated', 'logs'), { recursive: true })

  await state({
    modes: ['default', 'plan', 'accept-edits', 'auto'],
    recordModeChanges: true,
    batchPromptResult: true,
    recoveryReply: '已在授权后完成全部编译验证并汇总最优雅解。',
    promptUpdates: [
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '已派出子智能体并行求解。' },
      },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_cpp',
        name: 'invoke_subagent',
        status: 'completed',
        args: { Role: 'C++ Backtracking Solver', Prompt: blockedPrompt },
      },
    ],
  })

  const approvals = []
  const events = []
  let archive
  const run = adapter.run({
    account,
    cwd,
    threadId: sid,
    permission: 'default',
    bot: { model: 'gemini-flash', effort: 'low' },
    prompt: '派发多agent生成该题目最优雅解',
    approve: async (req) => {
      approvals.push(req)
      return true
    },
    emit(event) {
      events.push(event)
      if (archive || event.agent?.id !== `agy:${sid}:call_cpp` || event.agent?.status !== 'dispatched') return
      archive = (async () => {
        await new Promise(resolve => setTimeout(resolve, 250))
        const index = new DatabaseSync(join(directory, 'conversation_summaries.db'))
        try {
          index.exec(`CREATE TABLE conversation_summaries(conversation_id TEXT,parent_conversation_id TEXT,status TEXT,
            not_fully_idle INTEGER,killed INTEGER)`)
          index.prepare("INSERT INTO conversation_summaries VALUES(?,?,'CASCADE_RUN_STATUS_IDLE',0,0)").run(blockedChild, sid)
          index.prepare("INSERT INTO conversation_summaries VALUES(?,NULL,'CASCADE_RUN_STATUS_IDLE',0,0)").run(sid)
        } finally { index.close() }

        await writeFile(join(directory, 'brain', blockedChild, '.system_generated', 'logs', 'transcript.jsonl'), [
          { step_index: 0, type: 'SYSTEM_MESSAGE', source: 'SYSTEM', status: 'DONE', content: blockedPrompt },
          {
            step_index: 1,
            type: 'PLANNER_RESPONSE',
            source: 'MODEL',
            status: 'DONE',
            tool_calls: [{ name: 'run_command', args: { CommandLine: '"mkdir -p agents/cpp && clang++ -std=c++17 -O2 -o sol solution.cpp"' } }],
          },
        ].map(s => JSON.stringify(s)).join('\n'))
        const blockedDb = new DatabaseSync(join(directory, 'conversations', blockedChild + '.db'))
        try {
          blockedDb.exec('CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER)')
          blockedDb.prepare('INSERT INTO steps VALUES(1, 15, 3), (2, 132, 9)').run()
        } finally { blockedDb.close() }
      })()
    },
  })

  try {
    await run
    assert.equal(approvals.length, 1)
    assert.equal(approvals[0].title, 'Antigravity 子智能体工具授权')
    assert.match(approvals[0].detail, /C\+\+ Backtracking Solver · 运行命令/)
    assert.match(approvals[0].detail, /clang\+\+ -std=c\+\+17/)

    const recordedCalls = (await seen()).trim().split('\n').map(line => JSON.parse(line))
    const modeCalls = recordedCalls
      .filter(c => c.method === 'session/set_config_option' && c.params?.configId === 'mode')
      .map(c => c.params.value)
    // Initial default -> elevated to auto for approved recovery -> restored back to default
    assert.deepEqual(modeCalls.slice(-2), ['auto', 'default'])

    const recoveryCall = recordedCalls.find(c => c.recovery)
    assert.ok(recoveryCall)
    assert.match(recoveryCall.params.prompt[0].text, /允许本次操作/)
    assert.deepEqual(events.filter(e => e.type === 'text').map(e => e.value), [
      '已派出子智能体并行求解。',
      '已在授权后完成全部编译验证并汇总最优雅解。',
    ])
  } finally {
    await archive
  }
})

test('permission modes enforce distinct behavior, upgrade legacy strict settings, and contain workspace-auto writes via Seatbelt', mac, async t => {
  const { account, cwd, state, seen } = await setup(t)
  Object.assign(account, await adapter.detect(account))

  // Write legacy "toolPermission": "strict" into settings.json and verify it upgrades to "request-review"
  const settingsDir = join(account.source, '.gemini', 'antigravity-cli')
  const settingsFile = join(settingsDir, 'settings.json')
  await mkdir(settingsDir, { recursive: true })
  await writeFile(
    settingsFile,
    JSON.stringify({ auth: { type: 'oauth-personal' }, toolPermission: 'strict' }),
    { mode: 0o600 },
  )

  const homeOutsideTarget = join(
    process.env.HOME,
    `.boteam-seatbelt-probe-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  )
  t.after(() => rm(homeOutsideTarget, { force: true }))
  const workspaceInsideTarget = join(cwd, 'inside-workspace.txt')

  // 1) edits mode: auto-approves workspace edit without calling approve(), upgrades strict -> request-review
  await state({
    modes: ['default', 'plan', 'accept-edits', 'auto'],
    recordAcpArgs: true,
    toolCall: {
      title: 'Write solution.py',
      kind: 'edit',
      locations: [{ path: workspaceInsideTarget }],
    },
  })
  let approveCalls = 0
  const editEvents = []
  await adapter.run({
    account,
    cwd,
    permission: 'edits',
    prompt: 'apply edit',
    emit: (e) => editEvents.push(e),
    approve: async () => {
      approveCalls++
      return false
    },
  })
  assert.equal(approveCalls, 0)
  const upgradedSettings = JSON.parse(await readFile(settingsFile, 'utf8'))
  assert.equal(upgradedSettings.toolPermission, 'request-review')
  assert.ok(
    editEvents.some((e) => e.type === 'tool' && e.kind === 'meta' && e.value.includes('自动接受编辑')),
  )

  // 2) edits mode: still prompts approve() on execute command
  await state({
    modes: ['default', 'plan', 'accept-edits', 'auto'],
    toolCall: {
      title: 'python3 solution.py',
      kind: 'execute',
      locations: [{ path: cwd }],
    },
  })
  await adapter.run({
    account,
    cwd,
    permission: 'edits',
    prompt: 'run script',
    emit: () => {},
    approve: async () => {
      approveCalls++
      return false
    },
  })
  assert.equal(approveCalls, 1)

  // 3) workspace-auto mode: passes --add-dir + --dangerously-skip-permissions inside Seatbelt workspaceWriteRoot
  await rm(join(account.source, 'seen'), { force: true })
  await state({
    modes: ['default', 'plan', 'accept-edits', 'auto'],
    recordAcpArgs: true,
    sandboxProbe: {
      insideWorkspace: workspaceInsideTarget,
      outsideInUserHome: homeOutsideTarget,
    },
    toolCall: {
      title: 'python3 solution.py',
      kind: 'execute',
      locations: [{ path: workspaceInsideTarget }],
    },
  })
  approveCalls = 0
  const autoEvents = []
  await adapter.run({
    account,
    cwd,
    permission: 'workspace-auto',
    prompt: 'auto execute in workspace',
    emit: (e) => autoEvents.push(e),
    approve: async () => {
      approveCalls++
      return false
    },
  })
  assert.equal(approveCalls, 0)
  assert.ok(
    autoEvents.some((e) => e.type === 'tool' && e.kind === 'meta' && e.value.includes('工作区自动执行')),
  )
  const autoRecords = (await seen()).trim().split('\n').map((line) => JSON.parse(line))
  const promptRecord = autoRecords.find((r) => r.method === 'session/prompt')
  assert.ok(promptRecord.acpArgs.includes('--add-dir'))
  assert.ok(promptRecord.acpArgs.includes('--dangerously-skip-permissions'))
  const probeRecord = autoRecords.find((r) => r.sandboxProbe)
  assert.equal(probeRecord.sandboxProbe.insideWorkspace, 'written')
  assert.equal(probeRecord.sandboxProbe.outsideInUserHome, 'EPERM')
  const outcomeRecord = autoRecords.find((r) => r.outcome)
  assert.deepEqual(outcomeRecord.outcome, { outcome: 'selected', optionId: 'one' })
})
