import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Workspace } from '../desktop/workspace.mjs'
import { Database } from '../desktop/database.mjs'
import { agentEntries, saveAgentEntries } from '../desktop/subagents.mjs'

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
