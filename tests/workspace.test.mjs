import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../desktop/workspace.mjs'
import { DatabaseSync } from 'node:sqlite'
import { nativeEnv, redact } from '../desktop/native.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('existing Bots migrate to native defaults and selected options are validated per account and model', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'boteam-options-'))
  const legacy = new DatabaseSync(join(root, 'workspace.sqlite3'))
  legacy.exec("CREATE TABLE bots(id TEXT PRIMARY KEY, accountId TEXT, name TEXT, cwd TEXT, archived INTEGER DEFAULT 0); INSERT INTO bots VALUES('old','a','旧 Bot','',0)")
  legacy.close()
  const catalog = { models: [
    { id: 'standard', label: 'Standard', efforts: [{ id: 'low', label: 'Low' }] },
    { id: 'fast', label: 'Fast', efforts: [] },
  ], defaultModel: 'standard' }
  const seen = []
  const adapter = {
    options: async ({ account }) => {
      assert.equal(account.identity, 'one')
      return catalog
    },
    run: async ({ bot, emit }) => {
      seen.push([bot.model, bot.effort])
      emit({ type: 'identity', key: 'one', value: 'One' })
    },
  }
  const options = { root, adapters: { codex: adapter } }
  let app = new Workspace(options)
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }) })
  app.db.run('INSERT INTO accounts(id,provider,identity,info) VALUES(?,?,?,?)', 'a', 'codex', 'one', JSON.stringify({ status: 'ready' }))
  assert.equal(app.bot('old').effort, '')
  assert.equal(app.bot('old').model, '')
  assert.equal((await app.handle('botOptions', { accountId: 'a' })).models[0].id, 'standard')
  const params = { accountId: 'a', name: '订阅 Bot', model: 'standard', effort: 'low' }
  await assert.rejects(app.handle('createBot', { ...params, model: 'alien' }), /模型/)
  await assert.rejects(app.handle('createBot', { ...params, model: 'fast' }), /强度/)
  const bot = await app.handle('createBot', params)
  await app.handle('editBot', { id: bot, name: '保留选择', cwd: '' })
  const direct = await app.handle('createChat', { kind: 'direct', members: [bot] })
  const group = await app.handle('createChat', { kind: 'group', name: '项目', members: [bot, 'old'] })
  await app.handle('send', { chatId: direct, recipients: [bot], text: 'test' })
  await app.handle('send', { chatId: group, recipients: [bot, 'old'], text: 'test' })
  await until(() => app.snapshot().tasks.every((task) => task.status === 'done'))
  assert.deepEqual(seen.sort(), [['', ''], ['standard', 'low'], ['standard', 'low']])
  await app.close()
  app = new Workspace(options)
  assert.equal(app.bot(bot).effort, 'low')
  await app.handle('editBot', { id: bot, name: '跟随原生', cwd: '', model: '', effort: '' })
  assert.equal(app.bot(bot).model, '')
})
async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await sleep(10)
  }
  assert.fail('后台任务未在测试期限内完成')
}

test('two selected identities route independently, retain scoped sessions after restart and preserve removed history', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'boteam-test-'))
  let app
  t.after(async () => {
    app?.close()
    await rm(root, { recursive: true, force: true })
  })
  const calls = []
  let active = 0,
    peak = 0
  const adapter = {
    detect: async ({ source }) => ({
      status: 'ready',
      identity: source,
      email: source.endsWith('work') ? 'work@example.test' : 'personal@example.test',
    }),
    prepare: async ({ candidate, profile }) => ({ ...candidate, source: profile }),
    async run({ account, threadId, prompt, emit, approve }) {
      active++
      peak = Math.max(active, peak)
      try {
        calls.push({ identity: account.identity, threadId, prompt })
        emit({ type: 'identity', value: account.email })
        await sleep(15)
        emit({ type: 'session', value: threadId || crypto.randomUUID() })
        if (prompt === 'permission') {
          assert.equal(await approve({ title: '执行命令', detail: '测试命令' }), false)
        }
        emit({ type: 'tool', value: '读取工作区文件' })
        emit({ type: 'text', value: '完成' })
      } finally {
        active--
      }
    },
  }
  const options = {
    root,
    adapters: { codex: adapter },
    locate: async (_, source) => ({ source, bin: '/example/codex' }),
  }
  app = new Workspace(options)
  const importOne = async (source) => {
    const [candidate] = await app.handle('detect', { provider: 'codex', source })
    const [id] = await app.handle('import', { candidateIds: [candidate.candidateId] })
    return id
  }
  assert.equal(app.snapshot().onboarded, false)
  const work = await importOne(join(root, 'work')),
    personal = await importOne(join(root, 'personal'))
  assert.equal(await importOne(join(root, 'work')), work)
  assert.equal(app.snapshot().accounts.length, 2)
  const bot = await app.handle('createBot', { accountId: work, name: '工作号' })
  const second = await app.handle('createBot', { accountId: personal, name: '个人号' })
  const dm = await app.handle('createChat', { kind: 'direct', members: [bot] })
  const another = await app.handle('createChat', { kind: 'direct', members: [bot] })
  const group = await app.handle('createChat', {
    kind: 'group',
    name: '项目组',
    members: [bot, second],
  })
  await assert.rejects(app.handle('send', { chatId: dm, recipients: [second], text: '禁止发送' }))
  await assert.rejects(app.handle('send', { chatId: group, recipients: [], text: '请选择' }))
  const send = (chatId, recipients, text) => app.handle('send', { chatId, recipients, text })
  const done = () => app.snapshot().tasks.every((r) => r.status === 'done')
  await send(dm, [bot], 'private')
  await until(done)
  await send(group, [bot, second], 'team')
  await until(done)
  assert.equal(peak, 2)
  assert.deepEqual(
    calls.map((c) => c.threadId),
    [null, null, null],
  )
  assert.equal(new Set(calls.filter((c) => c.prompt === 'team').map((c) => c.identity)).size, 2)
  await send(another, [bot], 'permission')
  await until(() => app.snapshot().tasks.some((r) => r.approval))
  const pending = app.snapshot().tasks.find((r) => r.approval)
  await assert.rejects(
    app.handle('approve', { taskId: pending.id, approvalId: 'stale', allow: true }),
  )
  await app.handle('approve', { taskId: pending.id, approvalId: pending.approval.id, allow: false })
  await until(done)
  await app.handle('finishOnboarding')
  app.close()
  app = new Workspace(options)
  assert.equal(app.snapshot().onboarded, true)
  await send(dm, [bot], 'resume')
  await send(group, [bot], 'resume in group')
  await until(done)
  assert.ok(calls.at(-1).threadId)
  assert.notEqual(calls.at(-1).threadId, calls.at(-2).threadId)
  assert.equal(
    app
      .snapshot()
      .messages.filter((m) => m.author === 'bot')
      .every((m) => m.text === '完成'),
    true,
  )
  const managedHome = app.snapshot().accounts.find((a) => a.id === work).source
  await app.handle('removeAccount', { id: work })
  assert.equal(app.snapshot().accounts.length, 1)
  assert.equal(app.snapshot().bots.find((b) => b.id === bot).archived, true)
  assert.ok(app.snapshot().messages.find((m) => m.name === '工作号'))
  await assert.rejects(access(managedHome))
  await assert.rejects(send(dm, [bot], 'archived'))
})

test('native environment excludes auth and routing overrides and persisted text masks tokens', () => {
  const env = nativeEnv()
  for (const key of [
    'ANTHROPIC_BASE_URL',
    'OPENAI_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CODEX_HOME',
  ])
    assert.equal(env[key], undefined)
  assert.doesNotMatch(
    redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz'),
    /abcdefghijklmnopqrstuvwxyz/,
  )
  assert.doesNotMatch(redact('{"refresh_token":"forbidden-example"}'), /forbidden-example/)
  assert.equal(redact('4/0' + 'synthetic-for-test'.repeat(3)), '[已隐藏授权码]')
})

test('cancel invalidates an approval immediately and protects the account until the native child exits', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'boteam-cancel-'))
  let finish
  const childExit = new Promise((resolve) => {
    finish = resolve
  })
  const adapter = {
    detect: async () => ({ status: 'ready', identity: 'fixture' }),
    prepare: async ({ profile }) => ({ source: profile }),
    async run({ emit, approve }) {
      emit({ type: 'identity', value: 'fixture' })
      await approve({ title: '测试审批', detail: '一次文件读取' })
      await childExit
    },
  }
  const app = new Workspace({
    root,
    adapters: { codex: adapter },
    locate: async () => ({ source: root, bin: '/test/codex' }),
  })
  t.after(async () => {
    finish()
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const [found] = await app.handle('detect', {})
  const [accountId] = await app.handle('import', { candidateIds: [found.candidateId] })
  const bot = await app.handle('createBot', { name: '测试', accountId })
  const chatId = await app.handle('createChat', { kind: 'direct', members: [bot] })
  await app.handle('send', { chatId, recipients: [bot], text: 'permission' })
  await until(() => app.snapshot().tasks[0].approval)
  const task = app.snapshot().tasks[0]
  await app.handle('cancel', { taskId: task.id })
  await assert.rejects(
    app.handle('approve', { taskId: task.id, approvalId: task.approval.id, allow: true }),
  )
  await assert.rejects(app.handle('removeAccount', { id: accountId }))
  assert.equal(app.snapshot().tasks[0].status, 'interrupted')
  finish()
  await until(() => !app.busyAccount(accountId))
  await app.handle('removeAccount', { id: accountId })
})

test('closing during official login aborts cleanly and removes the uncommitted staging profile', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'boteam-login-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let staging
  const app = new Workspace({
    root,
    adapters: {
      codex: {
        login: async ({ source, signal }) => {
          staging = source
          await new Promise((resolve) => signal.addEventListener('abort', resolve))
          throw new Error('已取消登录。')
        },
      },
    },
    locate: async (_, source) => ({ source, bin: '/test/codex' }),
  })
  const pending = assert.rejects(app.handle('login', { provider: 'codex' }), /已取消登录/)
  await until(() => staging)
  await app.close()
  await pending
  await assert.rejects(access(staging))
})

test('a restricted group member fails locally while a verified member completes, and queued sends resume serially', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'boteam-groups-'))
  const threads = []
  const good = {
    detect: async () => ({ identity: 'verified', status: 'ready' }),
    prepare: async ({ profile }) => ({ source: profile }),
    run: async ({ threadId, emit }) => {
      threads.push(threadId)
      emit({ type: 'identity', value: 'verified' })
      await sleep(15)
      emit({ type: 'session', value: 'native-group-1' })
      emit({ type: 'text', value: '已完成' })
    },
  }
  const blocked = {
    detect: async () => ({
      identity: 'source:unverified',
      status: 'blocked',
      reason: '系统共享登录无法核实。',
    }),
    prepare: async ({ candidate }) => candidate,
    run: () => assert.fail('blocked member cannot invoke native runtime'),
  }
  const app = new Workspace({
    root: join(root,'workbench'),
    adapters: { codex: good, antigravity: blocked },
    locate: async (p) => ({ bin: null, source: join(root, p) }),
  })
  t.after(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const found = await app.handle('detect')
  const accounts = await app.handle('import', { candidateIds: [found[0].candidateId] })
  // Keep exercising a restricted historical member. New imports require a verified subscription.
  accounts.push(await app.accounts.adopt(found[1]))
  const bots = await Promise.all(
    accounts.map((accountId, i) =>
      app.handle('createBot', { accountId, name: i ? '受限' : '已核验' }),
    ),
  )
  const chatId = await app.handle('createChat', { kind: 'group', name: '混合群', members: bots })
  await app.handle('send', { chatId, recipients: bots, text: '并行' })
  await app.handle('send', { chatId, recipients: [bots[0]], text: '继续' })
  await until(() => app.snapshot().tasks.every((t) => ['failed', 'done'].includes(t.status)))
  assert.deepEqual(threads, [null, 'native-group-1'])
  assert.deepEqual(
    app.snapshot().tasks.map((t) => t.status),
    ['done', 'failed', 'done'],
  )
  assert.match(app.snapshot().tasks[1].error, /共享登录/)
})

test('official login can bind a restricted source, add a second identity and reject reauthorizing the wrong account', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'boteam-reauth-'))
  let loginAs = 'work'
  const identities = new Map()
  const adapter = {
    login: async ({ source }) => {
      identities.set(source, loginAs)
    },
    detect: async ({ source, managed }) =>
      managed
        ? {
            status: 'ready',
            identity: identities.get(source),
            email: identities.get(source) + '@example.test',
          }
        : { status: 'blocked', identity: 'source:unknown', reason: '未能验证此配置' },
    prepare: async ({ candidate }) => ({ source: candidate.source, identity: candidate.identity }),
  }
  const app = new Workspace({
    root,
    adapters: { claude: adapter },
    locate: async (_, source) => ({ source: source || root, bin: '/fixture/claude' }),
  })
  t.after(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const [source] = await app.handle('detect', { provider: 'claude' })
  const [first] = await app.handle('import', { candidateIds: [source.candidateId] })
  const bot = await app.handle('createBot', { name: '工作号', accountId: first })
  assert.equal(await app.handle('login', { provider: 'claude', accountId: first }), first)
  assert.equal(app.snapshot().bots.find((b) => b.id === bot).accountId, first)
  loginAs = 'personal'
  await assert.rejects(app.handle('login', { accountId: first }), /身份/)
  assert.equal(app.snapshot().accounts.find((a) => a.id === first).identity, 'work')
  const second = await app.handle('login', { provider: 'claude' })
  assert.notEqual(first, second)
  assert.equal(app.snapshot().accounts.length, 2)
  assert.equal(await app.handle('login', { provider: 'claude' }), second)
  assert.equal(app.snapshot().accounts.length, 2)
})

test('upgrading a historical Antigravity entry requires the selected Google account and keeps Bot bindings', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'boteam-agy-upgrade-'))
  const app = new Workspace({ root, adapters: { antigravity: {
    prepare: async ({ candidate }) => ({ source: candidate.source }),
  } } })
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }) })
  const source = { provider: 'antigravity', status: 'blocked', source: root,
    identity: 'source:desktop', email: 'previous@example.test' }
  const account = await app.accounts.adopt(source)
  const bot = await app.handle('createBot', { accountId: account, name: '反重力工作号' })
  const verified = { ...source, managed: true, status: 'ready', identity: 'native-user', email: 'other@example.test' }
  await assert.rejects(app.accounts.adopt(verified, account), /Google 登录邮箱/)
  assert.equal(app.db.account(account).status, 'blocked')
  assert.equal(await app.accounts.adopt({ ...verified, email: source.email }, account), account)
  assert.equal(app.bot(bot).accountId, account)
  assert.equal(app.db.account(account).identity, 'native-user')
})

test('an immediately reopened login waits for its cancelled predecessor and owns its own cancellation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'boteam-login-retry-'))
  const launched = [], exits = []
  const adapter = {
    async login({ source, signal }) {
      const exit = Promise.withResolvers()
      exits.push(exit)
      launched.push({ source, signal })
      await exit.promise // The native listener can finish closing after the cancel IPC returns.
    },
    detect: async () => ({status:'ready', identity:'new-account'}),
    prepare: async ({candidate}) => ({...candidate}),
  }
  const app = new Workspace({ root, adapters:{codex:adapter}, locate:async (_, source) => ({source,bin:'/test/codex'}) })
  t.after(async () => {
    exits.forEach(exit => exit.resolve())
    await app.close()
    await rm(root,{recursive:true,force:true})
  })
  const start = requestId => app.handle('login',{provider:'codex',requestId})
  const cancel = requestId => app.handle('cancelLogin',{requestId})
  const prior = assert.rejects(start('old'), /已取消/)
  await until(() => launched.length === 1)
  await assert.rejects(start('accidental-duplicate'), /授权|登录窗口/)
  assert.equal(await cancel('old'), true)
  const skipped = assert.rejects(start('queued-and-closed'), /已取消/)
  assert.equal(await cancel('queued-and-closed'), true)
  const retry = start('retry')
  retry.catch(() => {})
  assert.equal(await cancel('old'), false)
  assert.equal(launched.length,1)
  exits[0].resolve()
  await Promise.all([prior,skipped])
  await until(() => launched.length === 2)
  assert.notEqual(launched[0].source,launched[1].source)
  assert.equal(launched[1].signal.aborted,false)
  assert.equal(app.snapshot().accounts.length,0)
  await assert.rejects(access(launched[0].source),{code:'ENOENT'})
  exits[1].resolve()
  const id = await retry
  assert.equal(app.db.account(id).source,launched[1].source)
  assert.equal(app.accounts.logins.size,0)
})

test('a completed native Google grant survives interrupted setup and can resume or be explicitly replaced', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'boteam-staged-login-'))
  let finish = false
  const authorized = new Set(), calls = []
  const adapter = {
    hasStagedLogin: async ({ source }) => authorized.has(source),
    async login({ source }) {
      calls.push(source)
      authorized.add(source)
      if (!finish) throw new Error('原生设置尚未完成。')
    },
    detect: async () => ({ status: 'ready', identity: 'verified-google', email: 'test@example.test' }),
    prepare: async ({ candidate }) => ({ source: candidate.source }),
  }
  const options = { root, adapters: { antigravity: adapter }, locate: async (_, source) => ({ source, bin: '/fixture/agy' }) }
  let app = new Workspace(options)
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }) })
  const login = (extra) => app.handle('login', { provider: 'antigravity', ...extra })
  await assert.rejects(login(), /已保留本次 Google 授权/)
  await access(calls[0])
  await app.close()
  app = new Workspace(options)
  await assert.rejects(login(), /已保留本次 Google 授权/)
  assert.equal(calls[0], calls[1])
  finish = true
  const id = await login({ fresh: true })
  assert.notEqual(calls[2], calls[0])
  await assert.rejects(access(calls[0]))
  assert.equal(app.db.account(id).source, calls[2])
  assert.equal(app.db.get("SELECT count(*) AS n FROM settings WHERE key LIKE 'pending-login/%'").n, 0)
})
