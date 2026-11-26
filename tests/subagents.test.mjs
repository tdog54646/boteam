import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

test('Antigravity recovers only uniquely matched visible child archive messages for its verified owner', async t => {
  const root = await mkdtemp(join(tmpdir(), 'boteam-agy-subagent-archive-'))
  const workspace = new Workspace({ root, adapters: {} })
  t.after(async () => { await workspace.close(); await rm(root, { recursive: true, force: true }) })
  const source = await workspace.accounts.privateDir()
  const dir = join(source, '.gemini', 'antigravity-cli')
  await mkdir(dir, { recursive: true })
  const parent = '6da07ea3-d35d-436f-bdda-3c0438b65504'
  const child = 'be1af14f-e99e-4c67-8aae-e17963895384'
  const other = 'fc3ddf9b-7089-47f7-b971-5227f19069a7'
  const agentId = 'agy:' + parent + ':call_127'
  const prompt = '独立检查回归测试的执行路径。'
  const native = new DatabaseSync(join(dir, 'conversation_summaries.db'))
  try {
    native.exec(`CREATE TABLE conversation_summaries(conversation_id TEXT, parent_conversation_id TEXT, status TEXT,
      not_fully_idle INTEGER, killed INTEGER)`)
    const add = native.prepare("INSERT INTO conversation_summaries VALUES(?,?,'CASCADE_RUN_STATUS_IDLE',0,0)")
    add.run(child, parent)
    add.run(other, '7170531e-3383-4e25-8684-709ee2c02aba')
  } finally { native.close() }
  for (const [id, response] of [[child, '子智能体找到了验收脚本。'], [other, 'outside scope']]) {
    const folder = join(dir, 'brain', id, '.system_generated', 'logs')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'transcript.jsonl'), [
      { type: 'SYSTEM_MESSAGE', source: 'SYSTEM', step_index: 0, status: 'DONE', content: 'hidden instructions\n' + prompt },
      { type: 'PLANNER_RESPONSE', source: 'MODEL', step_index: 1, status: 'DONE', tool_calls: [{ name: 'search_web', args: { prompt: 'private arguments' } }] },
      { type: 'GENERIC', source: 'MODEL', step_index: 2, status: 'DONE', content: 'hidden tool data' },
      { type: 'PLANNER_RESPONSE', source: 'MODEL', step_index: 3, status: 'DONE', model: 'gemini-flash',
        content: response, thinking: 'hidden thought' },
    ].map(value => JSON.stringify(value)).join('\n'))
  }
  const { db } = workspace
  db.run('INSERT INTO accounts(id,provider,identity,info) VALUES(?,?,?,?)', 'account', 'antigravity', 'fixture',
    JSON.stringify({ source, managed: true, status: 'ready' }))
  db.run("INSERT INTO chats VALUES('chat','direct','Fixture','')")
  db.run(`INSERT INTO messages(id,chatId,author,name,text,createdAt,recipients)
    VALUES('message','chat','user','Fixture','request','','["bot"]')`)
  db.run(`INSERT INTO tasks(id,chatId,botId,accountId,messageId,status,tool,createdAt)
    VALUES('task','chat','bot','account','message','done','agy','')`)
  workspace.event('task', '子智能体 · 已派发', { agent: { id: agentId, name: '独立核对', status: 'dispatched' } })
  saveAgentEntries(db, 'task', { agent: { id: agentId }, entries: [{ id: 'dispatch-prompt', role: 'user', text: prompt }] })
  const scope = { chatId: 'chat', botId: 'bot', agentId }
  await workspace.handle('refreshSubagents', { chatId: 'chat' })
  assert.deepEqual((await workspace.handle('agentTranscript', scope)).map(entry => entry.role), ['user'])
  db.run('INSERT INTO threads(chatId,botId,accountId,threadId,cwd) VALUES(?,?,?,?,?)', 'chat', 'bot', 'account', parent, root)
  await workspace.handle('refreshSubagents', { chatId: 'chat' })
  await workspace.handle('refreshSubagents', { chatId: 'chat' })
  const entries = await workspace.handle('agentTranscript', scope)
  assert.deepEqual(entries.map(entry => [entry.role, entry.text]), [
    ['user', prompt], ['activity', '搜索网页'], ['assistant', '子智能体找到了验收脚本。'],
  ])
  const events = workspace.snapshot().tasks[0].events
  assert.equal(events.length, 2)
  assert.equal(events.at(-1).agent.nativeThreadId, child)
  assert.equal(events.at(-1).agent.status, 'completed')
  assert.equal(events.at(-1).agent.model, 'gemini-flash')
})

test('Antigravity subagents prefer transcript_full.jsonl over truncated compact logs and repair truncated JSON fallbacks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'boteam-agy-subagent-full-'))
  const workspace = new Workspace({ root, adapters: {} })
  t.after(async () => { await workspace.close(); await rm(root, { recursive: true, force: true }) })
  const source = await workspace.accounts.privateDir()
  const dir = join(source, '.gemini', 'antigravity-cli')
  await mkdir(dir, { recursive: true })
  const parent = 'e667bea9-e030-43b9-af79-0d0a0ff3d691'
  const fullChild = 'bca5e37c-ba90-426b-beab-502c8e6c4cc2'
  const fallbackChild = 'cfbb2a1a-d3d1-4de3-a3b3-0633d804e28d'
  const fullAgentId = `agy:${parent}:call_full`
  const fallbackAgentId = `agy:${parent}:call_fallback`
  const fullPrompt = '专注整数分拆的数学规范性、工程标杆实现及优雅度评审维度。'
  const fallbackPrompt = '专注迭代均摊算法与极简生成器验证。'

  const native = new DatabaseSync(join(dir, 'conversation_summaries.db'))
  try {
    native.exec(`CREATE TABLE conversation_summaries(conversation_id TEXT, parent_conversation_id TEXT, status TEXT,
      not_fully_idle INTEGER, killed INTEGER)`)
    const add = native.prepare("INSERT INTO conversation_summaries VALUES(?,?,'CASCADE_RUN_STATUS_IDLE',0,0)")
    add.run(fullChild, parent)
    add.run(fallbackChild, parent)
  } finally { native.close() }

  const fullReport = [
    '以下从**数学本质、精确剪枝**完成剖析。',
    '',
    '---',
    '',
    '### 一、数学建模',
    '求正整数 $n$ 的所有真分拆（项数 $k \\ge 2$）：',
    '$$1 \\le a_1 \\le a_2 \\le \\dots \\le a_k, \\quad \\sum_{i=1}^k a_i = n$$',
  ].join('\n')

  // 1) Child with truncated transcript.jsonl + complete transcript_full.jsonl + parent follow-up
  const fullLogs = join(dir, 'brain', fullChild, '.system_generated', 'logs')
  await mkdir(fullLogs, { recursive: true })
  await writeFile(join(fullLogs, 'transcript.jsonl'), [
    { type: 'SYSTEM_MESSAGE', source: 'SYSTEM', step_index: 0, status: 'DONE', content: fullPrompt },
    {
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      step_index: 1,
      status: 'DONE',
      truncated_fields: ['tool_calls'],
      tool_calls: [{ name: 'run_command', args: { CommandLine: '"python3 -c \'\\nprint(1)\\n<truncated 512 bytes>' } }],
    },
    { type: 'GENERIC', source: 'MODEL', step_index: 2, status: 'DONE', content: 'ok' },
    {
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      step_index: 3,
      status: 'DONE',
      truncated_fields: ['tool_calls'],
      tool_calls: [{
        name: 'send_message',
        args: {
          Recipient: JSON.stringify(parent),
          Message: JSON.stringify(fullReport).slice(0, 65) + '\n<truncated 7412 bytes>',
        },
      }],
    },
    { type: 'GENERIC', source: 'MODEL', step_index: 4, status: 'DONE', content: `Message sent to "${parent}".` },
    { type: 'SYSTEM_MESSAGE', source: 'SYSTEM', step_index: 5, status: 'DONE', content: '<SYSTEM_MESSAGE>\nReminder: work efficiently.\n</SYSTEM_MESSAGE>' },
    { type: 'PLANNER_RESPONSE', source: 'MODEL', step_index: 6, status: 'DONE', content: '已完成剖析并通过 `send_message` 发送给主调 Agent。' },
  ].map(s => JSON.stringify(s)).join('\n'))

  await writeFile(join(fullLogs, 'transcript_full.jsonl'), [
    { type: 'SYSTEM_MESSAGE', source: 'SYSTEM', step_index: 0, status: 'DONE', content: fullPrompt },
    {
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      step_index: 1,
      status: 'DONE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: "python3 -c 'print(42)'", WaitMsBeforeAsync: 5000 } }],
    },
    { type: 'GENERIC', source: 'MODEL', step_index: 2, status: 'DONE', content: '42' },
    {
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      step_index: 3,
      status: 'DONE',
      tool_calls: [{ name: 'send_message', args: { Recipient: parent, Message: fullReport } }],
    },
    { type: 'GENERIC', source: 'MODEL', step_index: 4, status: 'DONE', content: `Message sent to "${parent}".` },
    { type: 'SYSTEM_MESSAGE', source: 'SYSTEM', step_index: 5, status: 'DONE', content: '<SYSTEM_MESSAGE>\nReminder: work efficiently.\n</SYSTEM_MESSAGE>' },
    { type: 'PLANNER_RESPONSE', source: 'MODEL', step_index: 6, status: 'DONE', content: '已完成剖析并通过 `send_message` 发送给主调 Agent。' },
    {
      type: 'SYSTEM_MESSAGE',
      source: 'SYSTEM',
      step_index: 7,
      status: 'DONE',
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-26T00:00:00Z sender=${parent} priority=HIGH content=请补充 n=5 的解数量\n</SYSTEM_MESSAGE>`,
    },
    {
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      step_index: 8,
      status: 'DONE',
      tool_calls: [{ name: 'send_message', args: { Recipient: parent, Message: '6' } }],
    },
    { type: 'GENERIC', source: 'MODEL', step_index: 9, status: 'DONE', content: `Message sent to "${parent}".` },
  ].map(s => JSON.stringify(s)).join('\n'))

  // 2) Child with ONLY compact truncated transcript.jsonl (missing transcript_full.jsonl)
  const fallbackLogs = join(dir, 'brain', fallbackChild, '.system_generated', 'logs')
  await mkdir(fallbackLogs, { recursive: true })
  await writeFile(join(fallbackLogs, 'transcript.jsonl'), [
    { type: 'SYSTEM_MESSAGE', source: 'SYSTEM', step_index: 0, status: 'DONE', content: fallbackPrompt },
    {
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      step_index: 1,
      status: 'DONE',
      truncated_fields: ['tool_calls'],
      tool_calls: [{
        name: 'send_message',
        args: {
          Recipient: JSON.stringify(parent),
          Message: '"### 方案结论\\n项数满足 $k \\\\ge 2$，总数为 $p(n)-1$。\\\n<truncated 3200 bytes>',
        },
      }],
    },
    { type: 'GENERIC', source: 'MODEL', step_index: 2, status: 'DONE', content: `Message sent to "${parent}".` },
  ].map(s => JSON.stringify(s)).join('\n'))

  const { db } = workspace
  db.run('INSERT INTO accounts(id,provider,identity,info) VALUES(?,?,?,?)', 'account', 'antigravity', 'fixture',
    JSON.stringify({ source, managed: true, status: 'ready' }))
  db.run("INSERT INTO chats VALUES('chat','direct','Fixture','')")
  db.run(`INSERT INTO messages(id,chatId,author,name,text,createdAt,recipients)
    VALUES('message','chat','user','Fixture','request','','["bot"]')`)
  db.run(`INSERT INTO tasks(id,chatId,botId,accountId,messageId,status,tool,createdAt)
    VALUES('task','chat','bot','account','message','done','agy','')`)
  db.run('INSERT INTO threads(chatId,botId,accountId,threadId,cwd) VALUES(?,?,?,?,?)', 'chat', 'bot', 'account', parent, root)

  for (const [id, name, prompt] of [
    [fullAgentId, 'Math Designer', fullPrompt],
    [fallbackAgentId, 'Fallback Architect', fallbackPrompt],
  ]) {
    workspace.event('task', '子智能体 · 已派发', { agent: { id, name, status: 'dispatched' } })
    saveAgentEntries(db, 'task', { agent: { id }, entries: [{ id: 'dispatch-prompt', role: 'user', text: prompt }] })
  }

  await workspace.handle('refreshSubagents', { chatId: 'chat' })

  const fullEntries = await workspace.handle('agentTranscript', { chatId: 'chat', botId: 'bot', agentId: fullAgentId })
  const reportEntry = fullEntries.find(e => e.id.includes(':3:report:0'))
  assert.equal(reportEntry?.text, fullReport)
  assert.doesNotMatch(reportEntry.text, /^"|<truncated|\\n/)
  const cmdEntry = fullEntries.find(e => e.id.endsWith(':1:0'))
  assert.equal(cmdEntry?.meta?.command, "python3 -c 'print(42)'")
  const followupUser = fullEntries.find(e => e.id.endsWith(':7') && e.role === 'user')
  assert.equal(followupUser?.text, '请补充 n=5 的解数量')
  const numericReport = fullEntries.find(e => e.id.includes(':8:report:0'))
  assert.equal(numericReport?.text, '6')

  const fallbackEntries = await workspace.handle('agentTranscript', { chatId: 'chat', botId: 'bot', agentId: fallbackAgentId })
  const repairedReport = fallbackEntries.find(e => e.id.includes(':1:report:0'))
  assert.equal(repairedReport?.text, '### 方案结论\n项数满足 $k \\ge 2$，总数为 $p(n)-1$。')
})
