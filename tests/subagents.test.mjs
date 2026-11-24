import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Workspace } from '../desktop/workspace.mjs'
import { Database } from '../desktop/database.mjs'
import { agentEntries, saveAgentEntries } from '../desktop/subagents.mjs'
import { dispatchAgentName } from '../desktop/subagent-names.mjs'

test('child transcript replaces streamed entries, stays private to its chat and survives restart and fork', async t => {
  const root = await mkdtemp(join(tmpdir(), 'boteam-subagents-'))
  const options = { root, adapters: { codex: {
    async run({ emit }) {
      await emit({ type: 'identity', value: 'Fixture', key: 'fixture' })
      const child = (id, entries) => emit({ type: 'agentTranscript', agent: { id }, entries })
      await child('unregistered', [{ id: 'injected', role: 'assistant', text: 'foreign content' }])
      await emit({ type: 'tool', value: '子智能体 · 运行中', agent: { id: 'child', name: '核对', status: 'running' } })
      await child('child', [
        { id: 'request', role: 'user', text: '检查结果' },
        { id: 'response', role: 'assistant', text: '正在核对' },
      ])
      await child('child', [
        { id: 'response', role: 'assistant', text: '子任务确认了细节' },
        { id: 'hidden', role: 'thinking', text: 'hidden material' },
      ])
      await emit({ type: 'tool', value: '子智能体 · 已完成', agent: { id: 'child', status: 'completed' } })
      await emit({ type: 'text', value: '主回复' })
    },
  } } }
  let workspace = new Workspace(options)
  t.after(async () => { await workspace.close(); await rm(root, { recursive: true, force: true }) })
  workspace.db.run('INSERT INTO accounts(id,provider,identity,info) VALUES(?,?,?,?)',
    'account', 'codex', 'fixture', JSON.stringify({ status: 'ready' }))
  const botId = await workspace.handle('createBot', { accountId: 'account', name: '测试成员', cwd: root })
  const chatId = await workspace.handle('createChat', { kind: 'direct', members: [botId] })
  const other = await workspace.handle('createChat', { kind: 'group', name: '独立会话', members: [botId] })
  await workspace.handle('send', { chatId, recipients: [botId], text: '主请求' })
  await Promise.all([...workspace.lanes.values()])
  const read = (scope = chatId, agentId = 'child') => workspace.handle('agentTranscript', { chatId: scope, botId, agentId })
  const expected = [
    { id: 'request', role: 'user', text: '检查结果' },
    { id: 'response', role: 'assistant', text: '子任务确认了细节' },
  ]
  assert.deepEqual(await read(), expected)
  assert.deepEqual(await read(other), [])
  assert.deepEqual(await read(chatId, 'unregistered'), [])
  const snapshot = workspace.snapshot()
  assert.ok(snapshot.messages.some(message => message.text === '主回复'))
  assert.ok(!JSON.stringify(snapshot).includes('子任务确认了细节'))
  assert.equal(snapshot.tasks[0].status, 'done')
  const branch = await workspace.handle('forkChat', { chatId })
  await workspace.close()
  workspace = new Workspace(options)
  assert.deepEqual(await read(), expected)
  assert.deepEqual(await read(branch), expected)
  await workspace.handle('deleteChat', { chatId: branch })
  assert.deepEqual(await read(branch), [])
  assert.deepEqual(await read(), expected)
})

test('replayed entries retain their position and do not consume the distinct history limit', async t => {
  const root = await mkdtemp(join(tmpdir(), 'boteam-agent-replay-'))
  const db = new Database(root)
  t.after(async () => { db.db.close(); await rm(root, { recursive: true, force: true }) })
  db.run("INSERT INTO chats VALUES('chat','direct','Fixture','')")
  db.run(`INSERT INTO messages(id,chatId,author,name,text,createdAt,recipients)
    VALUES('message','chat','user','Fixture','request','','["bot"]')`)
  for (const id of ['task-1', 'task-2']) {
    db.run(`INSERT INTO tasks(id,chatId,botId,accountId,messageId,status,tool,events,createdAt)
      VALUES(?,'chat','bot','account','message','done','fixture','[{"agent":{"id":"child"}}]','')`, id)
  }
  const entries = Array.from({ length: 200 }, (_, index) => ({ id: String(index), role: 'assistant', text: 'entry ' + index }))
  saveAgentEntries(db, 'task-1', { agent: { id: 'child' }, entries })
  saveAgentEntries(db, 'task-2', { agent: { id: 'child' }, entries: entries.slice(50).map(entry => ({
    ...entry, text: entry.text + ' (updated)',
  })) })
  const result = agentEntries(db, { chatId: 'chat', botId: 'bot', agentId: 'child' })
  assert.deepEqual(result.map(entry => entry.id), entries.map(entry => entry.id))
  assert.equal(result[50].text, 'entry 50 (updated)')
})

test('legacy Antigravity self labels recover the matching roles from this task’s own dispatches', async t => {
  const root = await mkdtemp(join(tmpdir(), 'boteam-agent-legacy-name-'))
  const workspace = new Workspace({ root, adapters: {} })
  t.after(async () => { await workspace.close(); await rm(root, { recursive: true, force: true }) })
  const { db } = workspace
  db.run("INSERT INTO chats VALUES('chat','direct','Fixture','')")
  db.run(`INSERT INTO messages(id,chatId,author,name,text,createdAt,recipients)
    VALUES('message','chat','user','Fixture','request','','["bot"]')`)
  const agents = [
    ['agy:session:backend', '检索后端开发 Java 和 .NET 岗位的笔试题。'],
    ['agy:session:frontend', '检索前端开发及 MES 二次开发岗位的面经。'],
  ]
  const events = JSON.stringify(agents.map(([id]) => ({ agent: { id, name: 'self', status: 'dispatched' } })))
  db.run(`INSERT INTO tasks(id,chatId,botId,accountId,messageId,status,tool,events,createdAt)
    VALUES('task','chat','bot','account','message','done','fixture',?,'')`, events)
  db.run(`INSERT INTO messages(id,chatId,author,name,text,createdAt,recipients,taskId)
    VALUES('reply','chat','bot','Fixture',?,'','[]','task')`,
    '已派发 2 个子 Agent。\n1. **前端与 MES 开发检索员**：整理前端资料。\n2. **后端面经检索员**：整理后端资料。')
  for (const [id, text] of agents)
    saveAgentEntries(db, 'task', { agent: { id }, entries: [{ id: 'dispatch-prompt', role: 'user', text }] })
  assert.deepEqual(workspace.snapshot().tasks[0].events.map(e => e.agent.name), ['后端面经检索员', '前端与 MES 开发检索员'])
  assert.equal(db.get("SELECT events FROM tasks WHERE id='task'").events, events)
  const id = agents[0][0]
  workspace.event('task', '运行中', { agent: { id, status: 'running', name: '原生角色名称' } })
  workspace.event('task', '结束', { agent: { id, status: 'completed' } })
  assert.equal(workspace.snapshot().tasks[0].events.at(-1).agent.name, '原生角色名称')
})

test('an unnamed dispatch uses its saved prompt topic and ignores placeholder types', () => {
  assert.equal(dispatchAgentName({
    TypeName: 'SELF',
    Prompt: '你的任务是使用 search_web 工具，专门检索「BoTeam」的历史迁移说明。返回来源和摘要。',
  }), '历史迁移说明')
  assert.equal(dispatchAgentName({ TypeName: 'self', Prompt: '请研究「Codex 文档」。' }), '「Codex 文档」')
  assert.equal(dispatchAgentName({ Role: '  ', TypeName: 'self' }), undefined)
})
