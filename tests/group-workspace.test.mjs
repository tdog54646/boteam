import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../desktop/workspace.mjs'

async function groupFixture(t, respond) {
  const root = await mkdtemp(join(tmpdir(), 'boteam-group-history-'))
  const calls = []
  const adapter = {
    composerActions: async () => ({ slashCommands: ['compact', 'review'].map(name => ({ name, action: name })) }),
    async run(scope) {
      const { bot, account, threadId, emit } = scope
      emit({ type: 'identity', value: bot.name, key: account.identity })
      emit({ type: 'session', value: threadId || `${scope.chatId}-${bot.id}` })
      calls.push(scope)
      if (respond) return respond(scope)
      emit({ type: 'text', value: `公开结果-${bot.name}` })
    },
  }
  const options = { root, adapters: { codex: adapter, claude: adapter, antigravity: adapter } }
  let ws = new Workspace(options)
  t.after(async () => { await ws.close(); await rm(root, { recursive: true, force: true }) })
  const bots = []
  for (const provider of Object.keys(options.adapters)) {
    ws.db.run('INSERT INTO accounts(id,provider,identity,info) VALUES(?,?,?,?)', provider, provider, provider, '{"status":"ready"}')
    bots.push(await ws.handle('createBot', { accountId: provider, name: provider }))
  }
  const group = await ws.handle('createChat', { kind: 'group', name: '上线评审', members: bots })
  const send = (recipients, text, extra) => ws.handle('send', { chatId: group, recipients, text, ...extra })
  return { bots, group, calls, send, get ws() { return ws },
    async done() { await Promise.all([...ws.lanes.values()]) },
    async restart() { await ws.close(); ws = new Workspace(options) },
  }
}

test('members resume their native threads, receive peer replies and can quote across compaction and restart', async t => {
  const f = await groupFixture(t, ({ bot, slashCommand, emit }) => {
    emit({ type: 'tool', value: 'internal-tool-marker' })
    emit({ type: 'text', value: slashCommand === 'compact' ? 'internal-compact-receipt' : bot.name + ' 发布的回滚阈值 2% / 5 分钟' })
  })
  const [a,b,c] = f.bots
  await f.send([a], '列出上线条件')
  await f.done()
  const source = f.ws.snapshot().messages.find(m => m.botId === a)
  assert.ok(source.publishSeq > 0)
  await f.restart()
  const id = await f.send([b,c], '评审上述条件')
  await f.done()
  for (const call of f.calls.slice(1)) {
    assert.match(call.prompt, /codex 发布的回滚阈值 2% \/ 5 分钟/)
    assert.match(call.prompt, /列出上线条件/)
    assert.doesNotMatch(call.prompt, /internal-tool-marker|claude 发布的|antigravity 发布的/)
  }
  assert.deepEqual(f.calls.map(c => c.bot.id).sort(), [...f.bots].sort())
  const compact = { slash: { name: 'compact', arguments: '', botId: b } }
  await assert.rejects(f.send([b], '', { ...compact, replyToMessageId: source.id }), /引用/)
  await f.send([b], '', compact)
  await f.done()
  assert.equal(f.calls.at(-1).prompt, '')
  await f.restart()
  const quoted = await f.send([b], '把阈值改成 1%，时间不变', { replyToMessageId: source.id })
  await f.done()
  const last = f.calls.at(-1)
  assert.equal(last.threadId, f.group + '-' + b)
  assert.ok(last.prompt.includes(source.text))
  assert.equal(last.prompt.split(source.text).length, 2)
  assert.doesNotMatch(last.prompt, /internal-compact-receipt|internal-tool-marker/)
  assert.equal(f.ws.snapshot().messages.find(m => m.id === quoted).replyToMessageId, source.id)
  const review = await f.send([a], '', { slash: { name: 'review', arguments: '', botId: a } })
  await f.done()
  assert.equal(f.calls.at(-1).prompt, '')
  const task = f.ws.db.get('SELECT id FROM tasks WHERE messageId=?', review)
  assert.ok(f.ws.db.get('SELECT publishSeq FROM messages WHERE taskId=?', task.id).publishSeq > 0)
  assert.ok(f.ws.db.get('SELECT groupCutoff FROM tasks WHERE messageId=?', id).groupCutoff > 0)
})

test('group snapshot is fixed at send; publication and delivery are independent of placeholder order', async t => {
  const started = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const f = await groupFixture(t, async ({ prompt, emit }) => {
    if (prompt.endsWith('long task')) {
      emit({ type: 'text', value: 'partial:' })
      started.resolve()
      await release.promise
      emit({ type: 'text', value: 'final-marker' })
    } else emit({ type: 'text', value: 'ok' })
  })
  const [a,b] = f.bots
  await f.send([a], 'long task')
  await started.promise
  const placeholder = f.ws.snapshot().messages.find(m => m.botId === a)
  await assert.rejects(f.send([b], 'bad', { replyToMessageId: placeholder.id }), /引用/)
  await f.send([b], 'independent')
  await f.ws.lanes.get(f.group + '/' + b)
  assert.doesNotMatch(f.calls.at(-1).prompt, /partial|final-marker/)
  release.resolve()
  await f.done()
  await f.send([b], 'latest')
  await f.done()
  assert.match(f.calls.at(-1).prompt, /partial:final-marker/)
  assert.doesNotMatch(f.calls.at(-1).prompt, /independent/)
})

test('quotes reject foreign or private sources before enqueue and failed runs leave unpublished text', async t => {
  const f = await groupFixture(t, ({ emit, prompt }) => {
    emit({ type: 'text', value: 'scratch' })
    if (prompt.endsWith('fail-me')) throw new Error('offline')
  })
  const [a,b] = f.bots
  const dm = await f.ws.handle('createChat', { kind: 'direct', members: [a] })
  const other = await f.ws.handle('createChat', { kind: 'group', name: '另外的群', members: [a,b] })
  for (const chatId of [dm,other]) {
    const foreign = await f.send([a], 'private-marker', { chatId })
    await f.done()
    await assert.rejects(f.send([b], 'quote', { replyToMessageId: foreign }), /引用/)
  }
  await f.send([a], 'fail-me')
  await f.done()
  const left = f.ws.snapshot().messages.find(m => m.chatId === f.group && m.botId === a)
  assert.equal(left.publishSeq, null)
  await assert.rejects(f.send([b], 'quote', { replyToMessageId: left.id }), /引用/)
  await f.send([b], 'proceed')
  await f.done()
  assert.doesNotMatch(f.calls.at(-1).prompt, /scratch|private-marker/)
})

test('a queued turn keeps the send-time cutoff and the next turn catches a late publication', async t => {
  const busy = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const f = await groupFixture(t, async ({ prompt, emit }) => {
    if (prompt.endsWith('hold lane')) {
      busy.resolve()
      await release.promise
    }
    emit({ type: 'text', value: prompt.endsWith('finish later') ? 'late publication' : 'ordinary reply' })
  })
  const [a,b] = f.bots
  await f.send([b], 'hold lane')
  await busy.promise
  await f.send([b], 'queued at earlier snapshot')
  await f.send([a], 'finish later')
  await f.ws.lanes.get(f.group + '/' + a)
  release.resolve()
  await f.done()
  assert.ok(f.calls.at(-1).prompt.endsWith('queued at earlier snapshot'))
  assert.doesNotMatch(f.calls.at(-1).prompt, /finish later|late publication/)
  await f.send([b], 'read new material')
  await f.done()
  assert.match(f.calls.at(-1).prompt, /late publication/)
})

test('one member failing a large quote leaves its cursor untouched while peers publish', async t => {
  const f = await groupFixture(t)
  const [a,b,c] = f.bots
  await f.send([b], 'establish thread')
  await f.done()
  const cursor = () => f.ws.db.get('SELECT throughSeq FROM group_delivery WHERE chatId=? AND botId=?', f.group, b).throughSeq
  const before = cursor()
  const source = await f.send([a], '早期决议'.repeat(900))
  await f.done()
  f.ws.db.run("UPDATE accounts SET info=json_set(info,'$.model','model-b') WHERE id='claude'")
  // A native usage notification from a previous turn reports a known, small window.
  f.ws.composer.recordContext(f.group, b, { used: 80, limit: 1024, model: 'model-b' })
  const id = await f.send([b,c], '引用一次', { replyToMessageId: source })
  await f.done()
  const tasks = f.ws.db.all('SELECT botId,status,error FROM tasks WHERE messageId=?', id)
  assert.match(tasks.find(task => task.botId === b).error, /窗口|缩短/)
  assert.equal(tasks.find(task => task.botId === c).status, 'done')
  assert.equal(cursor(), before)
  await f.send([b], '改问公开结论')
  await f.done()
  assert.ok(cursor() > before)
  assert.match(f.calls.at(-1).prompt, /antigravity/)
})
