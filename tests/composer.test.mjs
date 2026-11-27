import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises'
import { Workspace } from '../desktop/workspace.mjs'

async function fixture(t, adapter) {
  const root = await mkdtemp(join(tmpdir(), 'boteam-composer-'))
  const options = { root, adapters: { codex: adapter } }
  const app = new Workspace(options)
  t.after(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  app.db.run(
    'INSERT INTO accounts(id,provider,identity,info) VALUES(?,?,?,?)',
    'a',
    'codex',
    'owner',
    JSON.stringify({ status: 'ready' }),
  )
  const bot = await app.handle('createBot', { accountId: 'a', name: '一' })
  const other = await app.handle('createBot', { accountId: 'a', name: '二' })
  const dm = await app.handle('createChat', { kind: 'direct', members: [bot] })
  const group = await app.handle('createChat', {
    kind: 'group',
    name: '项目',
    members: [bot, other],
  })
  return { app, options, bot, other, dm, group }
}

test('the picker reuses the account catalog until refreshed and saves against the refreshed choices', async t => {
  let current = 'first', reads = 0
  const { app, bot, dm } = await fixture(t, {
    options: async () => {
      reads++
      return { models: [{ id: current, efforts: [] }], defaultModel: current }
    },
  })
  const read = (refresh = false) => app.handle('botOptions', { accountId: 'a', refresh })
  const first = await read()
  assert.equal(first.defaultModel, 'first')
  assert.equal(Object.hasOwn(first, 'cached'), false)
  current = 'second'
  assert.deepEqual(await read(), { ...first, cached: true })
  assert.equal(reads, 1)
  const second = await read(true)
  assert.equal(second.defaultModel, 'second')
  assert.equal(Object.hasOwn(second, 'cached'), false)
  assert.deepEqual(await read(), { ...second, cached: true })
  await assert.rejects(
    app.handle('setComposerSettings', { chatId: dm, botId: bot, model: 'first', effort: '' }),
    /未提供所选模型/,
  )
  await app.handle('setComposerSettings', { chatId: dm, botId: bot, model: 'second', effort: '' })
  await assert.rejects(app.handle('editBot', { id: bot, name: '一', model: 'first' }), /未提供所选模型/)
  assert.equal(reads, 2)
})

test('background refreshes share a CLI query, leave the menu readable, and reject a changed binding', async t => {
  const pending = []
  const { app } = await fixture(t, {
    options: () => {
      const query = Promise.withResolvers()
      pending.push(query)
      return query.promise
    },
  })
  const read = (refresh = false) => app.handle('botOptions', { accountId: 'a', refresh })
  const previous = { models: [{ id: 'previous' }], defaultModel: 'previous' }
  const warmup = read()
  pending[0].resolve(previous)
  await warmup
  const first = read(true)
  const same = read(true)
  const cached = await Promise.race([read(), nextTurn('still waiting for the CLI')])
  const started = pending.length
  app.db.run("UPDATE accounts SET identity='another-owner' WHERE id='a'")
  const next = read()
  const result = { models: [{ id: 'current' }], defaultModel: 'current' }
  for (const query of pending) query.resolve(result)
  await Promise.all([assert.rejects(first, /账号配置已变化/), assert.rejects(same, /账号配置已变化/)])
  assert.deepEqual(cached, { ...previous, cached: true })
  assert.deepEqual(await next, result)
  assert.equal(started, 2)
  assert.equal(pending.length, 3)
})

test('a failed catalog query can be retried while another account keeps its own catalog', async t => {
  const calls = []
  let failNext = true
  const { app } = await fixture(t, {
    async options({ account }) {
      calls.push(account.id)
      if (failNext) {
        failNext = false
        throw new Error('CLI temporarily unavailable')
      }
      const id = account.identity
      return { models: [{ id }], defaultModel: id }
    },
  })
  app.db.run('INSERT INTO accounts(id,provider,identity,info) VALUES(?,?,?,?)',
    'b', 'codex', 'another-owner', JSON.stringify({ status: 'ready' }))
  const read = (accountId, refresh = false) => app.handle('botOptions', { accountId, refresh })
  await assert.rejects(read('a'), /temporarily unavailable/)
  assert.equal((await read('b')).defaultModel, 'another-owner')
  assert.equal((await read('a')).defaultModel, 'owner')
  assert.equal((await read('b')).defaultModel, 'another-owner')
  assert.equal((await read('a')).defaultModel, 'owner')
  assert.deepEqual(calls, ['a', 'b', 'a'])
  failNext = true
  await assert.rejects(read('a', true), /temporarily unavailable/)
  const retained = await read('a')
  assert.equal(retained.defaultModel, 'owner')
  assert.equal(retained.cached, true)
  assert.equal((await read('a', true)).defaultModel, 'owner')
  assert.deepEqual(calls, ['a', 'b', 'a', 'a', 'a'])
})

test('composer settings follow each chat member and queue submission, native usage survives restart', async (t) => {
  let begin, proceed
  const started = new Promise((resolve) => {
    begin = resolve
  })
  const waiting = new Promise((resolve) => {
    proceed = resolve
  })
  const calls = []
  const { app, options, bot, other, dm, group } = await fixture(t, {
    permissionModes: ['default', 'read-only'],
    options: async () => ({ models: [{ id: 'fast', efforts: [{ id: 'low' }] }] }),
    async run({ bot, chatId, threadId, permission, prompt, emit }) {
      calls.push([prompt, bot.model, bot.effort, permission])
      emit({ type: 'identity', key: 'owner', value: 'owner' })
      emit({ type: 'session', value: threadId || chatId + bot.id })
      if (prompt === 'first') {
        begin()
        await waiting
      }
      emit({ type: 'context', value: { used: 710, limit: 8192, model: 'fast' } })
    },
  })
  const set = (args) => app.handle('setComposerSettings', { chatId: dm, botId: bot, ...args })
  await assert.rejects(set({ permission: 'all' }))
  await assert.rejects(set({ model: 'no', effort: '' }))
  await assert.rejects(set({ botId: other, permission: 'read-only' }))
  await set({ model: 'fast', effort: 'low' })
  await set({ permission: 'read-only' })
  const send = (text, chatId = dm, recipients = [bot]) =>
    app.handle('send', { chatId, recipients, text })
  await send('first')
  await started
  await send('queued')
  await set({ model: null, effort: null, permission: 'default' })
  await send('later')
  await send('group', group, [other])
  proceed()
  for (let i = 0; i < 100 && app.snapshot().tasks.some((t) => t.status !== 'done'); i++)
    await delay(15)
  assert.deepEqual(
    calls.find((c) => c[0] === 'queued'),
    ['queued', 'fast', 'low', 'read-only'],
  )
  assert.deepEqual(
    calls.find((c) => c[0] === 'later'),
    ['later', '', '', 'default'],
  )
  assert.deepEqual(
    calls.find((c) => c[0] === 'group'),
    ['group', '', '', 'default'],
  )
  assert.deepEqual(
    app
      .snapshot()
      .contextUsage.map((c) => c.chatId)
      .sort(),
    [dm, group].sort(),
  )
  await app.close()
  const restarted = new Workspace(options)
  try {
    const row = restarted.snapshot().contextUsage.find((c) => c.chatId === dm)
    assert.equal(row.botId, bot)
    assert.equal(row.used, 710)
    assert.equal(row.limit, 8192)
  } finally {
    await restarted.close()
  }
})

test('quota refresh deduplicates requests and retains native account scope and only unexpired windows', async (t) => {
  let count = 0
  const { app, dm, bot, other } = await fixture(t, {
    async quota() {
      count++
      await delay(5)
      return {
        scope: 'account',
        windows: [
          { minutes: 300, remainingPercent: 0, resetsAt: Date.now() + 50000 },
          { minutes: 10080, remainingPercent: 85.5 },
          { minutes: 1440, remainingPercent: 45 },
          { minutes: 300, remainingPercent: 50, resetsAt: Date.now() - 5000 },
        ],
      }
    },
  })
  const refresh = () => app.handle('refreshQuota', { chatId: dm, botId: bot })
  await Promise.all([refresh(), refresh()])
  await refresh()
  assert.equal(count, 1)
  const [quota] = app.snapshot().quotas
  assert.equal(quota.accountId, 'a')
  assert.equal(quota.scope, 'account')
  assert.deepEqual(
    quota.windows.map((w) => w.remainingPercent),
    [0, 85.5],
  )
  await assert.rejects(app.handle('refreshQuota', { chatId: dm, botId: other }))
})

test('an attachment alone reaches its addressed group member and remains linked to the message', async (t) => {
  const calls = []
  const { app, group, dm, bot, other } = await fixture(t, {
    async run({ bot, prompt, attachments, emit }) {
      calls.push({ id: bot.id, prompt, attachments })
      emit({ type: 'identity', key: 'owner', value: 'owner' })
    },
  })
  const [file] = await app.handle('addAttachments', {
    scope: group,
    files: [{ name: '设计笔记.txt', text: 'draft-marker-29' }],
  })
  await assert.rejects(
    app.handle('send', { chatId: dm, text: '', attachmentIds: [file.id], recipients: [bot] }),
    /草稿/,
  )
  const result = await app.handle('send', {
    chatId: group,
    text: '',
    attachmentIds: [file.id],
    recipients: [other],
  })
  for (let n = 0; n < 100 && !calls.length; n++) await delay(5)
  assert.deepEqual(
    calls.map((c) => c.id),
    [other],
  )
  assert.match(calls[0].prompt, /draft-marker-29/)
  assert.equal(calls[0].attachments[0].mimeType, 'text/plain')
  const sent = app.snapshot().messages.find((m) => m.id === result)
  assert.equal(sent.text, '')
  assert.deepEqual(
    sent.attachments.map((a) => a.name),
    ['设计笔记.txt'],
  )
  assert.equal(sent.attachments[0].path, undefined)
  assert.deepEqual(await app.handle('listAttachments', { scope: group }), [])
})

test('runtime discovery updates existing Codex accounts while keeping their explicit Bot settings and thread history', async t => {
  const catalog = { models:[{id:'migrated',efforts:[]}], defaultModel:'migrated' }
  const {app, options, bot, dm} = await fixture(t, { options: async () => catalog })
  app.db.run("UPDATE accounts SET info=json_set(info,'$.bin','/old/codex','$.model','old','$.credentialSource','/profile') WHERE id='a'")
  app.db.run("UPDATE bots SET model='chosen' WHERE id=?",bot)
  app.db.run("INSERT INTO threads VALUES(?,?,?,?,?)",dm,bot,'a','old-session','/work')
  await app.close()
  const next = new Workspace({...options,codexExecutable:'/new/codex'})
  try {
    const bound=next.db.account('a')
    assert.equal(bound.identity,'owner')
    assert.equal(bound.credentialSource,'/profile')
    assert.equal(bound.bin,'/new/codex')
    assert.equal(bound.model,undefined)
    assert.equal((await next.handle('botOptions',{accountId:'a'})).defaultModel,'migrated')
    assert.equal(next.db.account('a').model,'migrated')
    assert.equal(next.bot(bot).model,'chosen')
    assert.equal(next.db.get('SELECT threadId FROM threads WHERE chatId=? AND botId=?',dm,bot).threadId,'old-session')
  } finally { await next.close() }
})

test('extensions and plan mode address only the chosen member and goals reuse its exact thread after restart', async t => {
  const goals = new Map(), calls = []
  const adapter = {
    composerActions: async () => ({ plan: true, autoReview: true, goal: true, extensions: [] }),
    permissionModes: ['default','auto-review'],
    async threadGoal({ action, threadId, objective, status, onSession }) {
      if (!threadId) { threadId = 'paused-thread'; onSession(threadId) }
      if (action === 'clear') goals.delete(threadId)
      if (action === 'set') goals.set(threadId, { objective,status })
      return { threadId, goal: goals.get(threadId) ?? null }
    },
    async run({ bot, chatId, prompt, emit, threadId, planMode, extensionIds, goalObjective }) {
      const session = threadId || chatId + '/' + bot.id
      calls.push({ id: bot.id, session, planMode, extensionIds, goalObjective, prompt })
      emit({ type:'identity', key:'owner', value:'owner' })
      emit({ type:'session', value:session })
      if (goalObjective) goals.set(session, { objective:goalObjective, status:'complete' })
    },
  }
  const { app, options, group, dm, bot, other } = await fixture(t, adapter)
  const select = (props) => app.handle('setComposerSettings', { chatId:group, botId:bot, ...props })
  const send = (props) => app.handle('send',{chatId:group,recipients:[bot,other],text:'hello',...props})
  const goal = (action,p={}) => app.handle('threadGoal',{chatId:group,botId:bot,action,...p})
  await assert.rejects(app.handle('composerActions',{chatId:dm,botId:other}),/不属于/)
  await assert.rejects(send({recipients:[other],nativeActions:{[bot]:{extensionIds:['id']}}}),/成员/)
  await assert.rejects(send({nativeActions:{[bot]:{extensionIds:'bad'}}}),/选择无效/)
  await select({planMode:true,permission:'auto-review'})
  assert.equal((await goal('set',{status:'paused',objective:'待开始'})).threadId,'paused-thread')
  await send({nativeActions:{[bot]:{extensionIds:['skill:A']}}})
  await Promise.all(app.lanes.values())
  assert.deepEqual(calls.find(x=>x.id===bot).extensionIds,['skill:A'])
  assert.equal(calls.find(x=>x.id===bot).planMode,true)
  assert.deepEqual(calls.find(x=>x.id===other).extensionIds,[])
  assert.equal(calls.find(x=>x.id===other).planMode,false)
  const active = await goal('set',{objective:'请完成',status:'active'})
  await Promise.all(app.lanes.values())
  const goalTask = app.snapshot().tasks.find(x=>x.messageId===active.messageId)
  assert.equal(goalTask.runSettings.goalObjective,'请完成')
  assert.deepEqual([calls.at(-1).session,calls.at(-1).planMode],['paused-thread',false])
  await app.close()
  const reopened=new Workspace(options)
  try {
    const scope={chatId:group,botId:bot}
    assert.equal((await reopened.handle('threadGoal',{...scope,action:'get'})).goal.status,'complete')
    assert.equal((await reopened.handle('threadGoal',{...scope,action:'clear'})).goal,null)
    assert.equal(reopened.composer.read(group,reopened.bot(bot)).planMode,true)
  } finally { await reopened.close() }
})

test('task questions only accept answers to the matching request and member', async t => {
  let asked, result
  const start = new Promise(resolve=>{ asked=resolve })
  const { app, dm, bot } = await fixture(t,{
    async run({emit, ask}) {
      emit({type:'identity',key:'owner',value:'owner'})
      const options=[{label:'左',description:'靠左'},{label:'右',description:'靠右'}]
      const waiting=ask([{id:'position',question:'选哪侧？',options}])
      asked()
      result=await waiting
    },
  })
  await app.handle('send',{chatId:dm,recipients:[bot],text:'plan'})
  await start
  const [task]=app.snapshot().tasks
  assert.equal(task.approval.kind,'questions')
  await assert.rejects(app.handle('approve',{taskId:task.id,approvalId:task.approval.id,allow:true}))
  await assert.rejects(app.handle('answerQuestions',{taskId:task.id,requestId:'old',answers:{position:'左'}}))
  await assert.rejects(app.handle('answerQuestions',{taskId:task.id,requestId:task.approval.id,answers:{position:'top'}}))
  await app.handle('answerQuestions',{taskId:task.id,requestId:task.approval.id,answers:{position:'左'}})
  await Promise.all(app.lanes.values())
  assert.deepEqual(result.position,{answers:['左']})
  assert.equal(app.snapshot().tasks[0].status,'done')
})

test('slash commands use the selected member’s native catalog, transcript and argument body', async t => {
  const calls = []
  const { app, group, dm, bot, other } = await fixture(t, {
    async composerActions({ bot: member }) {
      return { slashCommands: member.name === '一' ? [
        { name: 'review', action: 'prompt' }, { name: 'compact', action: 'compact' },
        { name: 'format', action: 'extension', extensionId: 'skill:A' },
        { name: 'model', action: 'model' },
      ] : [] }
    },
    async slashInfo(scope, { name }) { return { title: name, lines: [scope.bot.name] } },
    async run({ bot, prompt, slashCommand, extensionIds, emit }) {
      calls.push({ bot: bot.id, prompt, slashCommand, extensionIds })
      emit({ type: 'identity', key: 'owner', value: 'owner' })
    },
  })
  const scope = { chatId: group, recipients: [bot] }
  const send = (name, args = '', props = {}) => app.handle('send', {
    ...scope, text: 'renderer text', slash: { botId: bot, name, arguments: args }, ...props,
  })
  await assert.rejects(send('review', '', { recipients: [bot, other] }), /成员/)
  await assert.rejects(send('review', '', { recipients: [other] }), /成员/)
  await assert.rejects(send('review', '', { recipients: [other], slash: { botId: other, name: 'review', arguments: '' } }))
  await assert.rejects(send('compact', 'ignored'), /参数/)
  await assert.rejects(send('model'), /命令/)
  await assert.rejects(send('format', '', { nativeActions: { [bot]: { extensionIds: ['other'] } } }))
  assert.equal(app.snapshot().tasks.length, 0)
  const id = await send('review', '当前改动')
  await send('format', '这个文件')
  await app.handle('send', { ...scope, text: '/tmp/example.txt' })
  await Promise.all(app.lanes.values())
  assert.deepEqual(calls, [
    { bot, prompt: '当前改动', slashCommand: 'review', extensionIds: [] },
    { bot, prompt: '这个文件', slashCommand: undefined, extensionIds: ['skill:A'] },
    { bot, prompt: '/tmp/example.txt', slashCommand: undefined, extensionIds: [] },
  ])
  assert.equal(app.db.get('SELECT text FROM messages WHERE id=?', id).text, '/review 当前改动')
  assert.equal(app.snapshot().tasks.find(task => task.messageId === id).runSettings.slashCommand, 'review')
  await assert.rejects(app.handle('slashInfo', { chatId: dm, botId: other, name: 'mcp' }), /不属于/)
  assert.deepEqual(await app.handle('slashInfo', { chatId: dm, botId: bot, name: 'mcp' }), { title: 'mcp', lines: ['一'] })
})

test('slash discovery shares native reads and discards outstanding results after a same-path reauthorization', async t => {
  let gate, started
  let reads = 0
  const { app, dm, bot } = await fixture(t, {
    prepare: async ({ candidate }) => candidate,
    async composerActions() {
      const name = 'command-' + ++reads
      started?.resolve()
      if (gate) await gate.promise
      return { slashCommands: [{ name, action: 'prompt' }] }
    },
  })
  const candidate = { provider: 'codex', identity: 'owner', status: 'ready', source: app.root }
  app.db.run("UPDATE accounts SET info=json_set(info,'$.source',?) WHERE id='a'", candidate.source)
  const read = (refresh = false) => app.handle('composerActions', { chatId: dm, botId: bot, refresh })
  const [first, same] = await Promise.all([read(), read()])
  assert.equal(reads, 1)
  assert.deepEqual(same, first)
  assert.deepEqual(await read(), { ...first, cached: true })
  gate = Promise.withResolvers()
  started = Promise.withResolvers()
  const old = read(true)
  const shared = read(true)
  await started.promise
  try {
    assert.deepEqual(await Promise.race([read(), nextTurn('waiting')]), { ...first, cached: true })
    await app.accounts.adopt(candidate, 'a')
  } finally { gate.resolve() }
  await Promise.all([assert.rejects(old, /已变化/), assert.rejects(shared, /已变化/)])
  assert.equal(app.snapshot().accounts[0].bindingRevision, 1)
  const next = await read()
  assert.equal(next.slashCommands[0].name, 'command-3')
  assert.equal(next.cached, undefined)
  assert.equal(reads, 3)
})

test('cached command listings cannot submit removed commands or authorize a disabled permission', async t => {
  let enabled = true, reads = 0
  const { app, dm, bot } = await fixture(t, {
    permissionModes: ['default', 'auto-review'],
    async composerActions() {
      reads++
      return { autoReview: enabled, slashCommands: enabled ? [{ name: 'sketch', action: 'prompt' }] : [] }
    },
  })
  const scope = { chatId: dm, botId: bot }
  await app.handle('composerActions', scope)
  enabled = false
  await assert.rejects(app.handle('send', { chatId: dm, recipients: [bot], slash: { botId: bot, name: 'sketch', arguments: '' } }), /未提供/)
  enabled = true
  await app.handle('composerActions', { ...scope, refresh: true })
  enabled = false
  await assert.rejects(app.handle('setComposerSettings', { ...scope, permission: 'auto-review' }), /自动审批/)
  assert.equal(reads, 4)
  assert.equal(app.snapshot().tasks.length, 0)
})

test('draft command discovery uses validated member settings and separates draft, project and native thread scopes', async t => {
  const seen = []
  const { app, dm, bot } = await fixture(t, {
    permissionModes: ['default', 'read-only', ...(process.platform === 'darwin' ? ['full'] : [])],
    options: async () => ({ models: [{ id: 'fast', efforts: [{ id: 'low' }] }] }),
    async composerActions(scope) {
      seen.push(scope)
      return { slashCommands: [] }
    },
  })
  const draft = { id: randomUUID(), kind: 'direct', members: [bot] }
  const settings = { model: 'fast', effort: 'low', permission: 'read-only' }
  const read = p => app.handle('composerActions', { botId: bot, ...p })
  await read({ draft, settings })
  assert.equal((await read({ draft, settings })).cached, true)
  await assert.rejects(read({ draft, settings: { model: 'removed' } }), /模型/)
  await assert.rejects(read({ draft, settings: { permission: 'unsupported' } }), /权限/)
  const projectId = await app.handle('createProject', { name: 'folder', folders: [app.root] })
  await read({ draft: { ...draft, projectId }, settings })
  await read({ draft: { ...draft, projectId }, settings: {} })
  await read({ chatId: dm })
  app.associateThread(dm, bot, 'a', 'native-session', app.root)
  await read({ chatId: dm })
  assert.deepEqual(seen.map(s => [s.bot.model, s.bot.effort, s.permission, s.threadId]), [
    ['fast', 'low', 'read-only', null], ['fast', 'low', 'read-only', null], ['', '', 'default', null],
    ['', '', 'default', null], ['', '', 'default', 'native-session'],
  ])
  assert.notEqual(seen[0].cwd, seen[1].cwd)
  assert.deepEqual(app.snapshot().nativeThreads.map(row => row.threadId), ['native-session'])
  if (process.platform === 'darwin') {
    await read({ draft, settings: { permission: 'full' } })
    assert.equal(seen.at(-1).chatId, draft.id)
    assert.ok(seen.at(-1).protectedPaths.length)
  }
})

test('fork binds an independent direct thread to its source member and keeps both after restart', async t => {
  let release, began
  const wait = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { began = resolve })
  const { app, options, bot, other, dm, group } = await fixture(t, {
    async forkChat(scope, { destinationChatId }) {
      assert.equal(scope.threadId, 'original-thread')
      assert.equal(scope.chatId, group)
      assert.equal(scope.bot.id, bot)
      began()
      await wait
      return { threadId: 'fork-' + destinationChatId }
    },
  })
  const cwd = app.root
  app.associateThread(group, bot, 'a', 'original-thread', cwd)
  app.db.run("INSERT INTO composer_settings(chatId,botId,permission) VALUES(?,?,'read-only')",group,bot)
  const fork = (chatId, botId) => app.handle('forkChat', { chatId, botId })
  await assert.rejects(fork(dm, other), /不属于/)
  await assert.rejects(fork(group, other), /原生会话/)
  const pending = fork(group, bot)
  await started
  try {
    await assert.rejects(fork(group, bot), /稍后|正在/)
    await assert.rejects(app.handle('send', { chatId: group, recipients:[bot], text:'later' }), /稍后/)
  } finally { release() }
  const id = await pending
  await app.close()
  const reopened = new Workspace(options)
  try {
    const chat = reopened.snapshot().chats.find(c => c.id === id)
    assert.equal(chat.sourceChatId, group)
    assert.deepEqual(chat.members, [bot])
    assert.equal(chat.kind, 'direct')
    assert.equal(reopened.db.get('SELECT threadId FROM threads WHERE chatId=?', group).threadId, 'original-thread')
    assert.deepEqual({ ...reopened.db.get('SELECT threadId,accountId,cwd FROM threads WHERE chatId=?',id) },
      { threadId: 'fork-' + id, accountId: 'a', cwd })
    assert.equal(reopened.composer.read(id, reopened.bot(bot)).permission, 'read-only')
    let discarded = false
    reopened.adapters.codex.forkChat = async () => ({
      threadId: 'fork-' + id, discard: async () => { discarded = true },
    })
    await assert.rejects(reopened.handle('forkChat', { chatId: group, botId: bot }))
    assert.equal(discarded, true)
    assert.equal(reopened.snapshot().chats.filter(c => c.sourceChatId === group).length, 1)
  } finally { await reopened.close() }
})

test('settings catalogs and MCP status use registered project folders without creating chats', async t => {
  const { app, bot, dm } = await fixture(t, {
    composerActions: async scope => ({ extensions: [{ id: scope.cwd, label: scope.bot.name }], slashCommands: [] }),
    slashInfo: async scope => ({ title: 'MCP', lines: [scope.cwd] }),
  })
  const directory = await mkdtemp(join(tmpdir(), 'boteam-settings-scope-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const projectId = await app.handle('createProject', { name: 'Scope', folders: [directory] })
  const folder = app.snapshot().projects.find(p => p.id === projectId).folders[0]
  const before = app.snapshot().chats.length
  const scope = { botId: bot, catalogProject: { projectId, folder } }
  const result = await app.handle('composerActions', scope)
  assert.equal(result.extensions[0].id, folder)
  assert.deepEqual(await app.handle('slashInfo', { ...scope, name: 'mcp' }), { title: 'MCP', lines: [folder] })
  assert.equal(app.snapshot().chats.length, before)
  await assert.rejects(app.handle('composerActions', { ...scope, chatId: dm }), /会话/)
  await assert.rejects(app.handle('composerActions', { ...scope, catalogProject: { projectId, folder: tmpdir() } }), /项目/)
  const second = await mkdtemp(join(tmpdir(), 'boteam-settings-scope-'))
  t.after(() => rm(second, { recursive: true, force: true }))
  const projectScope = { botId: bot, catalogProject: { projectId }, name: 'mcp' }
  assert.deepEqual((await app.handle('slashInfo', projectScope)).lines, [folder])
  await app.handle('updateProject', { projectId, name: 'Scope', folders: [second, folder] })
  const primary = app.snapshot().projects.find(p => p.id === projectId).folders[0]
  assert.notEqual(primary, folder)
  assert.deepEqual((await app.handle('slashInfo', projectScope)).lines, [primary])
  assert.equal((await app.handle('composerActions', scope)).extensions[0].id, folder)
})
