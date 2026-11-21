import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import * as adapter from '../desktop/adapters/antigravity.mjs'
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
