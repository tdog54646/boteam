import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Workspace } from '../desktop/workspace.mjs'

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'boteam-chat-draft-')))
  const runs = [], lookups = [], quotas = []
  const adapter = {
    permissionModes: ['default', 'read-only'],
    options: async () => ({ defaultModel: 'standard', models: [
      { id: 'standard', efforts: [] }, { id: 'fast', efforts: [{ id: 'low' }] },
    ] }),
    async composerActions({ cwd }) {
      lookups.push(cwd)
      return { plan: true, goal: true, slashCommands: [
        { name: 'sketch', action: 'prompt' }, { name: 'compact', action: 'compact' },
      ] }
    },
    async quota({ model }) {
      quotas.push(model)
    },
    async threadGoal() {
      return { goal: null }
    },
    async run(task) {
      runs.push(task)
      task.emit({ type: 'identity', key: 'owner', value: 'owner' })
      task.emit({ type: 'session', value: task.chatId + '/' + task.bot.id })
    },
  }
  const options = { root, adapters: { codex: adapter } }
  let app = new Workspace(options)
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }) })
  app.db.run("INSERT INTO accounts(id,provider,identity,info) VALUES('a','codex','owner','{\"status\":\"ready\"}')")
  const [one, two] = await Promise.all(['one', 'two'].map(name => app.handle('createBot', { name, accountId: 'a' })))
  return { root, runs, lookups, quotas, one, two, get app() { return app }, call: (method, p) => app.handle(method, p),
    async restart() { await app.close(); app = new Workspace(options) } }
}

test('first send atomically claims group attachments, saves member settings, and queues the addressed member once', async t => {
  const f = await fixture(t)
  const draft = { id: randomUUID(), kind: 'group', members: [f.one, f.two], name: 'draft group' }
  const scope = 'draft:' + draft.id
  const [file] = await f.call('addAttachments', { scope, files: [{ name: 'note.txt', text: 'draft text' }] })
  const [foreign] = await f.call('addAttachments', { scope: 'draft:' + randomUUID(), files: [{ name: 'other', text: 'private' }] })
  const settings = { [f.one]: { model: 'fast', effort: 'low', permission: 'read-only', planMode: true } }
  const payload = { draft, recipients: [f.one], attachmentIds: [file.id], settings, pausedGoals: { [f.two]: 'waiting' } }
  const send = overrides => f.call('sendDraft', { ...payload, ...overrides })
  await assert.rejects(send({ settings: { [f.one]: { model: 'removed' } } }), /模型/)
  await assert.rejects(send({ attachmentIds: [file.id, foreign.id] }), /草稿/)
  await assert.rejects(send({ attachmentIds: [], text: '' }), /内容/)
  assert.equal(f.app.snapshot().chats.length, 0)
  assert.equal(f.app.snapshot().tasks.length, 0)
  assert.equal(f.app.snapshot().composerSettings.length, 0)
  assert.equal(f.app.db.get('SELECT count(*) AS n FROM pending_chat_goals').n, 0)
  assert.deepEqual((await f.call('listAttachments', { scope })).map(a => a.id), [file.id])

  const [first, retried] = await Promise.all([send(), send()])
  assert.deepEqual(retried, first)
  assert.equal(first.chatId, draft.id)
  await Promise.all(f.app.lanes.values())
  const chat = f.app.snapshot().chats[0]
  assert.equal(chat.name, 'draft group')
  assert.deepEqual(chat.members, draft.members)
  const message = f.app.snapshot().messages.find(m => m.id === first.messageId)
  assert.deepEqual(message.attachments.map(a => a.id), [file.id])
  assert.equal(f.runs.length, 1)
  const [task] = f.runs
  assert.deepEqual([task.bot.id, task.bot.model, task.bot.effort, task.permission, task.planMode],
    [f.one, 'fast', 'low', 'read-only', true])
  assert.equal(task.attachments[0].name, 'note.txt')

  await f.restart()
  assert.deepEqual(await send(), first)
  const goal = action => f.call('threadGoal', { chatId: first.chatId, botId: f.two, action })
  assert.deepEqual((await goal('get')).goal, { objective: 'waiting', status: 'paused' })
  assert.equal((await goal('clear')).goal, null)
  assert.equal((await goal('get')).goal, null)
})

test('draft commands and the first native turn use the selected project, goals can start as a first message', async t => {
  const f = await fixture(t)
  const folder = join(f.root, 'project')
  await mkdir(folder)
  const projectId = await f.call('createProject', { folders: [folder] })
  const draft = { id: randomUUID(), kind: 'direct', members: [f.one], projectId }
  const slash = { botId: f.one, name: 'sketch', arguments: 'a chart' }
  const send = options => f.call('sendDraft', { draft, recipients: [f.one], ...options })
  const catalog = await f.call('composerActions', { draft, botId: f.one })
  assert.equal(catalog.slashCommands[0].name, 'sketch')
  await assert.rejects(send({ slash: { ...slash, name: 'missing' } }), /命令/)
  await assert.rejects(send({ slash: { ...slash, name: 'compact', arguments: '' } }), /发送一条消息/)
  await assert.rejects(send({ slash, expectedProjectCwd: null }), /工作目录/)
  assert.equal(f.app.snapshot().chats.length, 0)
  const result = await send({ slash, expectedProjectCwd: folder })
  await Promise.all(f.app.lanes.values())
  const command = f.runs[0]
  assert.deepEqual([command.slashCommand, command.prompt, command.cwd], ['sketch', 'a chart', folder])
  assert.ok(f.lookups.every(cwd => cwd === folder))
  assert.equal(f.app.snapshot().chats.find(c => c.id === result.chatId).projectId, projectId)

  const other = { ...draft, id: randomUUID() }
  const [unsent] = await f.call('addAttachments', {
    scope: 'draft:' + other.id, files: [{ name: 'later.txt', text: 'keep with this chat' }],
  })
  await send({ draft: other, goalObjective: 'first goal', pausedGoals: { [f.one]: 'previous goal' } })
  await Promise.all(f.app.lanes.values())
  assert.equal(f.runs[1].goalObjective, 'first goal')
  assert.deepEqual(f.runs[1].attachments, [])
  assert.deepEqual((await f.call('listAttachments', { scope: other.id })).map(a => a.id), [unsent.id])
  assert.equal(f.app.db.get('SELECT count(*) AS n FROM pending_chat_goals WHERE chatId=?', other.id).n, 0)
  assert.equal(f.app.snapshot().messages.find(m => m.chatId === other.id && m.author === 'user').text, '目标 · first goal')
})

test('legacy home attachments remain scoped to their original bot; quota validates the current draft model', async t => {
  const f = await fixture(t)
  const draft = { id: randomUUID(), kind: 'direct', members: [f.one], legacyHome: true }
  const [file] = await f.call('addAttachments', { scope: 'home:' + f.one, files: [{ name: 'old.txt', text: 'previous draft' }] })
  const send = target => f.call('sendDraft', { draft: target, recipients: target.members, attachmentIds: [file.id] })
  await assert.rejects(send({ ...draft, legacyHome: false }), /草稿/)
  await assert.rejects(send({ ...draft, members: [f.two] }), /草稿/)
  assert.equal(f.app.snapshot().chats.length, 0)
  await send(draft)
  await Promise.all(f.app.lanes.values())
  assert.equal(f.runs[0].attachments[0].name, 'old.txt')
  const quota = draftModel => f.call('refreshQuota', { botId: f.one, draftModel })
  await quota('fast')
  await quota('')
  await assert.rejects(quota('unknown'), /模型/)
  assert.deepEqual(f.quotas, ['fast', 'standard'])
})
