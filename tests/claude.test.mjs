import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, stat, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { composerActions, detect, options, prepare, run } from '../desktop/adapters/claude.mjs'
import { Workspace } from '../desktop/workspace.mjs'

const session = 'ad455e90-d911-41a1-a9f2-7c276497c548'
const email = 'member@example.com'
const oauth = {
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email,
  orgId: 'org-a',
  orgName: 'My workspace',
  subscriptionType: 'max',
}
const live = {
  email,
  subscriptionType: 'Claude Max',
  apiProvider: 'firstParty',
  organization: 'My workspace',
}
const models = [
  {
    value: 'default',
    resolvedModel: 'claude-a',
    displayName: 'Default',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'high'],
  },
  {
    value: 'a',
    resolvedModel: 'claude-a',
    displayName: 'A',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'high'],
  },
  { value: 'b[1m]', resolvedModel: 'claude-b', displayName: 'B' },
]

async function fixture(t, status = oauth, account = live, resultError = null) {
  const source = await mkdtemp(path.join(os.tmpdir(), 'boteam-claude-'))
  t.after(() => rm(source, { recursive: true, force: true }))
  const bin = path.join(source, 'fake-claude.mjs')
  await writeFile(
    bin,
    `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const args = process.argv.slice(2)
if (args.includes('auth')) {
  console.log(JSON.stringify(${JSON.stringify(status)}))
  process.exit(${status.loggedIn ? 0 : 1})
}
const write = m => console.log(JSON.stringify(m))
const session = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id')+1]
let model, afterClose = []
for await (const line of createInterface({input:process.stdin})) {
  const m = JSON.parse(line)
  if (m.type === 'control_request') {
    if (m.request.subtype === 'generate_session_title') {
      appendFileSync(process.env.CLAUDE_CONFIG_DIR + '/titles', JSON.stringify(m.request)+'\\n')
      const unsupported = existsSync(process.env.CLAUDE_CONFIG_DIR + '/no-titles')
      write({type:'control_response',response:{subtype:unsupported?'error':'success', request_id:m.request_id, response:{title:'Trace subscription usage'}}})
      continue
    }
    if (m.request.subtype === 'set_model') model = m.request.model
    const data = m.request.subtype === 'set_permission_mode' ? {mode:m.request.mode} : m.request.subtype === 'get_usage' ? {rate_limits_available:true,rate_limits:{five_hour:{utilization:10},seven_day:{utilization:49},seven_day_sonnet:{utilization:77}}} : m.request.subtype === 'get_context_usage' ? {totalTokens:901,maxTokens:100000,rawMaxTokens:120000,model:'claude-a'} : m.request.subtype === 'get_settings'
      ? {applied:{model:existsSync(process.env.CLAUDE_CONFIG_DIR + '/mismatch') ? 'different' : model || 'claude-a',effort:args.includes('--effort') ? args[args.indexOf('--effort')+1] : undefined}}
      : {account:${JSON.stringify(account)},models:${JSON.stringify(models)},commands:existsSync(process.env.CLAUDE_CONFIG_DIR + '/commands-removed') ? [] : [{name:'dataviz',description:'Draw a chart',argumentHint:'[table]'},{name:'clear',aliases:['new']},{name:'usage',aliases:['cost']},{name:'context'},{name:'goal'}]}
    write({ type:'control_response',response:{subtype:'success',request_id:m.request_id,response:data}})
  } else if (m.type === 'user') {
    appendFileSync(process.env.CLAUDE_CONFIG_DIR + '/submitted', JSON.stringify({args,model,text:m.message.content,override:!!process.env.ANTHROPIC_API_KEY})+'\\n')
    write({type:'system',subtype:'init',session_id:session})
    if (${JSON.stringify(resultError)} !== null) {
      write({type:'result',subtype:'error_during_execution',is_error:true,errors:[${JSON.stringify(resultError)}],session_id:session})
      continue
    }
    const scenario = process.env.CLAUDE_CONFIG_DIR + '/stream-fixture.json'
    if (existsSync(scenario)) {
      const fixture = JSON.parse(readFileSync(scenario, 'utf8'))
      for (const frame of fixture.frames) write({session_id:session,...frame})
      afterClose = fixture.afterClose
      continue
    }
    write({type:'control_request',request_id:'ask1',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'echo sk-ant-fake-private'}}})
  } else if (m.type === 'control_response') {
    const decision = m.response.response.behavior
    write({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'part1'}}})
    write({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:decision}}})
    write({type:'assistant',message:{content:[{type:'text',text:'part1'+decision}]}})
    write({type:'result',subtype:'success',is_error:false,result:'part1'+decision,session_id:session})
  }
}
for (const { delay, ...frame } of afterClose) {
  if (delay) await new Promise(resolve => setTimeout(resolve, delay))
  write({session_id:session,...frame})
}
`,
    { mode: 0o700 },
  )
  return { source, bin, managed: true }
}

test('Claude diagnoses an oversized prompt without exposing its error text or misclassifying token auth', async t => {
  for (const [reason, expected] of [
    ['prompt is too long: 220000 tokens > 200000 maximum private-marker', /输入.*窗口/],
    ['invalid token private-marker', /授权/],
  ]) {
    const f = await fixture(t, oauth, live, reason)
    const account = { ...f, ...await detect(f) }
    await assert.rejects(run({ account, bot: {}, cwd: f.source, prompt: 'request', emit() {} }),
      error => expected.test(error.message) && !error.message.includes('private-marker'))
  }
})

test('discovery returns verified subscription metadata only and preserves the native profile', async (t) => {
  const f = await fixture(t)
  const candidate = { ...f, ...(await detect(f)) }
  assert.equal(candidate.status, 'ready')
  assert.equal(candidate.email, email)
  assert.equal(candidate.plan, 'max')
  assert.ok(candidate.identity)
  assert.equal(
    (await prepare({ candidate, profile: path.join(f.source, 'unused') })).source,
    f.source,
  )
})

test('Claude print-mode skills are discovered and revalidated inside its verified process', async t => {
  const f = await fixture(t)
  const account = { ...f, ...(await detect(f)) }
  const actions = await composerActions({ account, cwd: f.source })
  assert.deepEqual(actions.extensions.map(item => item.id), ['claude:/dataviz'])
  const task = { account, cwd:f.source, prompt:'plot this', emit:()=>{}, approve:async()=>false }
  await assert.rejects(run({...task,extensionIds:['claude:/clear']}),/未提供/)
  await assert.rejects(stat(path.join(f.source, 'submitted')), { code: 'ENOENT' })
  await run({...task,extensionIds:['claude:/dataviz']})
  const {args,text} = JSON.parse((await readFile(path.join(f.source,'submitted'),'utf8')).trim())
  assert.ok(args.includes('--safe-mode') && args.includes('--strict-mcp-config'))
  assert.ok(!args.includes('--disable-slash-commands'))
  assert.equal(text,'/dataviz plot this')
})

test('Claude slash commands use verified initialize metadata and preserve the selected session', async t => {
  const f = await fixture(t)
  const account = { ...f, ...(await detect(f)) }
  const { slashCommands } = await composerActions({ account, cwd: f.source })
  assert.deepEqual(slashCommands.map(c => [c.name, c.action]), [
    ['dataviz','prompt'], ['clear','unavailable'], ['usage','quota'], ['context','context'], ['goal','prompt'],
    ['new','unavailable'], ['cost','quota'],
  ])
  assert.equal(slashCommands[0].argumentHint, '[table]')
  const task = { account, cwd: f.source, prompt: 'plot this', emit: () => {}, approve: () => false }
  await assert.rejects(run({...task, slashCommand: 'clear'}), /命令/)
  await assert.rejects(run({...task, slashCommand: 'dataviz --resume'}), /命令/)
  await run({...task, slashCommand: 'dataviz'})
  await writeFile(path.join(f.source, 'commands-removed'), '')
  await assert.rejects(run({...task, slashCommand: 'dataviz'}), /命令/)
  await run(task)
  const sent = (await readFile(path.join(f.source,'submitted'),'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(sent.map(entry => entry.text), ['/dataviz plot this', 'plot this'])
  assert.deepEqual(sent.map(entry => entry.args.includes('--disable-slash-commands')), [false, true])
})

test('discovery distinguishes missing CLI, absent subscription, and credential overrides', async (t) => {
  assert.equal((await detect({ bin: null, source: '/missing' })).status, 'missing')
  const f = await fixture(t, { loggedIn: false })
  assert.equal((await detect(f)).status, 'login')
  await writeFile(
    path.join(f.source, 'settings.json'),
    JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'https://proxy.invalid', ANTHROPIC_AUTH_TOKEN: 'hidden-secret' },
    }),
  )
  const blocked = await detect(f)
  assert.equal(blocked.status, 'blocked')
  assert.ok(blocked.identity.startsWith('source:'))
  assert.doesNotMatch(JSON.stringify(blocked), /hidden-secret|proxy\.invalid/)
})

test('rejects an API key or unverifiable OAuth identity', async (t) => {
  for (const status of [
    { ...oauth, authMethod: 'api_key' },
    { ...oauth, email: null },
    { ...oauth, subscriptionType: 'free' },
  ]) {
    const f = await fixture(t, status)
    assert.equal((await detect(f)).status, 'blocked')
  }
})

test('same-process account verification rejects a changed login before submitting the prompt', async (t) => {
  const f = await fixture(t, oauth, { ...live, email: 'other@example.com' })
  const account = { ...f, ...(await detect(f)) }
  await assert.rejects(
    run({
      account,
      cwd: f.source,
      prompt: 'secret prompt',
      emit: () => {},
      approve: async () => true,
    }),
    /身份|账号/,
  )
  await assert.rejects(stat(path.join(f.source, 'submitted')), { code: 'ENOENT' })
})

test('resumes exact native UUID, waits for approvals, emits only text deltas', async (t) => {
  const f = await fixture(t)
  const account = { ...f, ...(await detect(f)) }
  for (const allowed of [true, false]) {
    const events = []
    const approvals = []
    await run({
      account,
      cwd: f.source,
      threadId: session,
      prompt: 'hello',
      emit: (e) => events.push(e),
      approve: async (e) => {
        approvals.push(e)
        return allowed
      },
    })
    assert.equal(events[0].type, 'identity')
    assert.ok(events.some((e) => e.type === 'session' && e.value === session))
    assert.equal(
      events
        .filter((e) => e.type === 'text')
        .map((e) => e.value)
        .join(''),
      'part1' + (allowed ? 'allow' : 'deny'),
    )
    assert.equal(approvals.length, 1)
    assert.doesNotMatch(JSON.stringify([...events, ...approvals]), /sk-ant-fake-private/)
  }
  const submissions = (await readFile(path.join(f.source, 'submitted'), 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse)
  for (const { args, text } of submissions) {
    assert.equal(args[args.indexOf('--resume') + 1], session)
    assert.equal(args[args.indexOf('--permission-prompt-tool') + 1], 'stdio')
    assert.equal(text, 'hello')
  }
})

const nativeText = text => ({ type: 'text', text })
const nativeAssistant = (content, parent_tool_use_id = null, uuid) => ({
  type: 'assistant', parent_tool_use_id, uuid, message: { role: 'assistant', content },
})
const nativeUser = (content, parent_tool_use_id, uuid) => ({
  type: 'user', parent_tool_use_id, uuid, message: { role: 'user', content },
})
const agentTool = (id, description, name = 'Agent') => ({
  type: 'tool_use', id, name, input: { description },
})
const started = (task_id, tool_use_id, description) => ({
  type: 'system', subtype: 'task_started', task_type: 'local_agent', task_id, tool_use_id, description,
})
const finished = (task_id, output_file) => ({
  type: 'system', subtype: 'task_notification', status: 'completed', task_id, output_file,
})

async function observeAgents(t, frames, prepare, afterClose = [], { signal, onEvent } = {}) {
  const f = await fixture(t)
  const account = { ...f, ...await detect(f) }
  if (prepare) await prepare(f.source)
  await writeFile(path.join(f.source, 'stream-fixture.json'), JSON.stringify({
    frames: [...frames, { type: 'result', subtype: 'success', is_error: false, result: 'Main reply' }],
    afterClose,
  }))
  const events = []
  await run({ account, cwd: f.source, threadId: session, prompt: 'request', signal, emit(e) {
    events.push(e)
    onEvent?.(e)
  } })
  return events
}

test('Claude forwards visible child messages from Agent and nested Task without duplicating parent streaming', async t => {
  const userId = '12ffa329-fcd8-42c4-926b-4d57fc8bde06'
  const answerId = '22ffa329-fcd8-42c4-926b-4d57fc8bde06'
  const nestedId = '32ffa329-fcd8-42c4-926b-4d57fc8bde06'
  const events = await observeAgents(t, [
    nativeAssistant([agentTool('tool-root', 'Inspect fixture')]),
    started('agent-root', 'tool-root', 'Inspect fixture'),
    nativeUser([nativeText('Check fixture'), { type: 'tool_result', content: 'raw user tool result' }], 'tool-root', userId),
    nativeAssistant([agentTool('tool-nested', 'Double check', 'Task')], 'tool-root'),
    started('agent-nested', 'tool-nested', 'Double check'),
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Main reply' } } },
    nativeAssistant([{ type: 'thinking', thinking: 'hidden thinking' }, nativeText('Inspecting fixture')], 'tool-root', answerId),
    nativeAssistant([nativeText('Nested result')], 'tool-nested', nestedId),
    nativeAssistant([nativeText('Unknown child content')], 'unregistered-tool'),
    nativeAssistant([nativeText('Main reply')]),
    finished('agent-nested'),
    finished('agent-root'),
  ])
  assert.deepEqual(events.filter(e => e.type === 'text').map(e => e.value), ['Main reply'])
  assert.deepEqual(events.filter(e => e.agent?.status).map(e => [e.agent.id, e.agent.status]), [
    ['tool-root', 'running'], ['tool-nested', 'running'], ['tool-nested', 'completed'], ['tool-root', 'completed'],
  ])
  assert.deepEqual(events.filter(e => e.type === 'agentTranscript').map(e => [e.agent.id, e.entries.map(row => [row.role, row.text])]), [
    ['tool-root', [['user', 'Check fixture']]],
    ['tool-root', [['assistant', 'Inspecting fixture']]],
    ['tool-nested', [['assistant', 'Nested result']]],
  ])
  assert.doesNotMatch(JSON.stringify(events), /hidden thinking|raw user tool result|Unknown child content/)
})

test('Claude reads only the announced managed session transcript and falls back to the typed Agent result', async t => {
  const rowId = '42ffa329-fcd8-42c4-926b-4d57fc8bde06'
  const row = (agentId, text, sessionId = session) => JSON.stringify({
    isSidechain: true, type: 'assistant', agentId, sessionId, uuid: rowId,
    message: { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'hidden persisted data' }, nativeText(text)] },
  })
  const events = await observeAgents(t, [
    nativeAssistant([agentTool('tool-real', 'Background work'), agentTool('tool-link', 'Foreground work')]),
    started('agent-real', 'tool-real'),
    started('agent-link', 'tool-link'),
    finished('agent-real'),
    finished('agent-link', '/another-profile/agent-link.jsonl'),
    {
      ...nativeUser([{ type: 'tool_result', tool_use_id: 'tool-real', content: [] }], null, rowId),
      tool_use_result: { status: 'completed', agentId: 'agent-real', content: [nativeText('Same result in another frame')] },
    },
    {
      ...nativeUser([{ type: 'tool_result', tool_use_id: 'tool-link', content: [nativeText('raw tool metadata')] }], null, rowId),
      tool_use_result: { status: 'completed', agentId: 'agent-link', content: [nativeText('Verified final result')] },
    },
  ], async source => {
    const project = (await realpath(source)).replace(/[^a-zA-Z0-9]/g, '-')
    const nativeDir = path.join(source, 'projects', project, session, 'subagents')
    await mkdir(nativeDir, { recursive: true })
    await writeFile(path.join(nativeDir, 'agent-agent-real.jsonl'), [
      row('agent-real', 'wrong native session', 'another-session'),
      row('agent-unknown', 'wrong native agent'),
      row('agent-real', 'Verified persisted text'),
    ].join('\n'))
    const outside = path.join(source, 'outside.jsonl')
    await writeFile(outside, row('agent-link', 'linked private content'))
    await symlink(outside, path.join(nativeDir, 'agent-agent-link.jsonl'))
  })
  assert.deepEqual(events.filter(e => e.type === 'agentTranscript').map(e => [e.agent.id, e.entries.map(row => row.text)]), [
    ['tool-real', ['Verified persisted text']], ['tool-link', ['Verified final result']],
  ])
  assert.doesNotMatch(JSON.stringify(events), /wrong native|linked private|raw tool metadata|hidden persisted/)
})

test('Claude announces an older Task before its result when the CLI omits task_started', async t => {
  const events = await observeAgents(t, [
    nativeAssistant([agentTool('tool-legacy', 'Review legacy fixture', 'Task')]),
    nativeAssistant([nativeText('Main reply')]),
    nativeUser([{ type: 'tool_result', tool_use_id: 'tool-legacy', content: [] }], null),
  ])
  assert.deepEqual(events.flatMap(e => e.agent?.status ? [e.agent.status] : e.type === 'text' ? [e.value] : []),
    ['running', 'Main reply', 'completed'])
})

test('Claude leaves an asynchronously launched Agent running until its native completion notification', async t => {
  const events = await observeAgents(t, [
    nativeAssistant([agentTool('tool-background', 'Run in background')]),
    started('agent-background', 'tool-background'),
    {
      ...nativeUser([{ type: 'tool_result', tool_use_id: 'tool-background', content: [] }], null),
      tool_use_result: { status: 'async_launched', agentId: 'agent-background' },
    },
    nativeAssistant([nativeText('Main reply')]),
    { type: 'result', subtype: 'success', is_error: false, result: 'Main reply' },
    finished('agent-background'),
  ])
  assert.deepEqual(events.flatMap(e => e.agent?.status ? [[e.agent.id, e.agent.status]] : e.type === 'text' ? [e.value] : []),
    [['tool-background', 'running'], 'Main reply', ['tool-background', 'completed']])
})

test('Claude displays the confirmed background delegation when the CLI omits or repeats the child user frame', async t => {
  const tool = agentTool('tool-background', 'Review fixture')
  tool.input.prompt = 'Check the fixture'
  tool.input.run_in_background = true
  const linked = nativeUser([nativeText(tool.input.prompt)], tool.id, 'typed-user')
  for (const forwardUser of [false, true]) {
    const events = await observeAgents(t, [
      nativeAssistant([tool]),
      { ...started('agent-background', tool.id), prompt: forwardUser ? 'Internal wakeup' : tool.input.prompt },
      {
        ...nativeUser([{ type: 'tool_result', tool_use_id: tool.id, content: [] }], null),
        tool_use_result: { status: 'async_launched', agentId: 'agent-background', prompt: tool.input.prompt },
      },
      ...(forwardUser ? [linked] : []),
      nativeAssistant([nativeText('Child reports success')], tool.id, 'child-answer'),
      finished('agent-background'),
    ])
    assert.deepEqual(events.filter(e => e.type === 'agentTranscript').flatMap(e => e.entries).map(row => [row.role, row.text]), [
      ['user', 'Check the fixture'],
      ['assistant', 'Child reports success'],
    ])
  }
})

test('Claude retains late child output during native shutdown when the parent reply is already done', async t => {
  const id = '52ffa329-fcd8-42c4-926b-4d57fc8bde06'
  const events = await observeAgents(t, [
    nativeAssistant([agentTool('tool-late', 'Finishing in background')]),
    started('agent-late', 'tool-late'),
    nativeAssistant([nativeText('Main reply')]),
  ], null, [
    nativeAssistant([nativeText('Child finished during shutdown')], 'tool-late', id),
    finished('agent-late'),
    nativeAssistant([nativeText('Later native parent reply')]),
  ])
  assert.deepEqual(events.filter(e => e.type === 'text').map(e => e.value), ['Main reply'])
  assert.deepEqual(events.filter(e => e.type === 'agentTranscript').flatMap(e => e.entries), [
    { id, role: 'assistant', text: 'Child finished during shutdown' },
  ])
  assert.deepEqual(events.filter(e => e.agent?.status).map(e => e.agent.status), ['running', 'completed'])
})

test('Claude waits past the normal shutdown grace for a confirmed background Agent', async t => {
  const tool = agentTool('tool-background', 'Finish the background fixture')
  const events = await observeAgents(t, [
    nativeAssistant([tool]),
    started('agent-background', tool.id),
    {
      ...nativeUser([{ type: 'tool_result', tool_use_id: tool.id, content: [] }], null),
      tool_use_result: { status: 'async_launched', agentId: 'agent-background' },
    },
    nativeAssistant([nativeText('Main reply')]),
  ], null, [
    { ...nativeAssistant([nativeText('Completed after the original grace')], tool.id, 'late-child-answer'), delay: 1800 },
    finished('agent-background'),
  ])
  assert.deepEqual(events.filter(e => e.agent?.status).map(e => e.agent.status), ['running', 'completed'])
  assert.deepEqual(events.filter(e => e.type === 'agentTranscript').flatMap(e => e.entries).map(e => e.text),
    ['Completed after the original grace'])
})

test('Claude can cancel the wait for a confirmed background Agent after the parent reply', async t => {
  const controller = new AbortController()
  const tool = agentTool('tool-background', 'Waiting for cancellation')
  tool.input.run_in_background = true
  const events = await observeAgents(t, [
    nativeAssistant([tool]),
    started('agent-background', tool.id),
    nativeAssistant([nativeText('Main reply')]),
  ], null, [
    nativeAssistant([nativeText('Background Agent is still working')], tool.id, 'before-cancel'),
    { ...nativeAssistant([nativeText('Too late')], tool.id, 'late-child-answer'), delay: 1800 },
    finished('agent-background'),
  ], {
    signal: controller.signal,
    onEvent(event) {
      if (event.type === 'agentTranscript') controller.abort()
    },
  })
  assert.deepEqual(events.filter(e => e.type === 'agentTranscript').flatMap(e => e.entries).map(e => e.text),
    ['Background Agent is still working'])
  assert.deepEqual(events.filter(e => e.agent?.status).map(e => e.agent.status), ['running', 'interrupted'])
})

test('reauthorization transfers only app-owned sessions to the permanent new login directory', async (t) => {
  const a = await fixture(t),
    b = await fixture(t)
  const existing = { ...a, ...(await detect(a)) },
    candidate = { ...b, ...(await detect(b)) }
  const dir = path.join('projects', '-example-project')
  await mkdir(path.join(a.source, dir), { recursive: true })
  await writeFile(path.join(a.source, dir, session + '.jsonl'), 'example transcript')
  await writeFile(path.join(a.source, dir, 'other.jsonl'), 'external transcript')
  const next = await prepare({
    existing,
    candidate,
    isLogin: true,
    threadIds: [session],
    profile: b.source,
  })
  assert.equal(next.source, b.source)
  assert.equal(
    await readFile(path.join(b.source, dir, session + '.jsonl'), 'utf8'),
    'example transcript',
  )
  await assert.rejects(stat(path.join(b.source, dir, 'other.jsonl')), { code: 'ENOENT' })
})

test('native account model choices and effort apply before submission for new and resumed conversations', async (t) => {
  const f = await fixture(t)
  const account = { ...f, ...(await detect(f)) }
  const catalog = await options({ account })
  assert.equal(catalog.defaultModel, 'claude-a')
  assert.deepEqual(
    catalog.models.map((m) => [m.id, ...m.efforts.map((e) => e.id)]),
    [['claude-a', 'low', 'high'], ['claude-b']],
  )
  const events = []
  const task = {
    account,
    cwd: f.source,
    prompt: 'hello',
    emit(e) {
      events.push(e)
    },
    approve: async () => false,
  }
  for (const bot of [{ model: 'unknown' }, { model: 'claude-b', effort: 'low' }])
    await assert.rejects(run({ ...task, bot }), /模型|推理/)
  await assert.rejects(stat(path.join(f.source, 'submitted')), { code: 'ENOENT' })
  await run({ ...task, bot: { model: 'claude-b' } })
  await run({ ...task, bot: { model: 'claude-a', effort: 'high' }, threadId: session })
  const [first, next] = (await readFile(path.join(f.source, 'submitted'), 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse)
  assert.equal(first.model, 'claude-b')
  assert.equal(first.args.includes('--effort'), false)
  assert.equal(next.model, 'claude-a')
  assert.equal(next.args[next.args.indexOf('--effort') + 1], 'high')
  assert.equal(next.args[next.args.indexOf('--resume') + 1], session)
  assert.ok(events.some((e) => e.type === 'tool' && e.value === '模型 claude-a · 思考强度 high'))
  await writeFile(path.join(f.source, 'mismatch'), '')
  await assert.rejects(run({ ...task, bot: { model: 'claude-b' } }), /未确认/)
  assert.equal(
    (await readFile(path.join(f.source, 'submitted'), 'utf8')).trim().split('\n').length,
    2,
  )
})

test('Claude rereads a changed profile model with a native context-window suffix', async (t) => {
  const f = await fixture(t)
  const account = { ...f, ...(await detect(f)) }
  assert.equal((await options({ account })).defaultModel, 'claude-a')
  await writeFile(path.join(f.source, 'settings.json'), JSON.stringify({ model: 'b[1m]' }))
  assert.equal((await options({ account })).defaultModel, 'claude-b')
})

test('verified external profile retains stable identity but needs a private login before dispatch', async (t) => {
  const f = await fixture(t)
  const external = { ...f, managed: false }
  const observed = await detect(external)
  assert.equal(observed.status, 'blocked')
  assert.equal(observed.loginState, 'signed-in')
  assert.equal(observed.identity, (await detect(f)).identity)
  await assert.rejects(run({ account: { ...external, ...observed } }), /独立/)
})

test('rediscovery preserves prior managed transcripts even after its login expires', async (t) => {
  const a = await fixture(t, { loggedIn: false })
  const b = await fixture(t)
  const candidate = { ...b, managed: false, ...(await detect({ ...b, managed: false })) }
  const existing = { ...a, identity: candidate.identity, managed: true }
  const kept = await prepare({ existing, candidate, threadIds: [session] })
  assert.equal(kept.source, a.source)
  assert.equal(kept.managed, true)
  assert.equal(kept.status, 'blocked')
})

test(
  'macOS detection keeps external profile files read-only to the client',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const source = await mkdtemp(path.join(os.tmpdir(), 'boteam-claude-external-'))
    t.after(() => rm(source, { recursive: true, force: true }))
    const bin = path.join(source, 'readonly-probe.mjs')
    await writeFile(
      bin,
      `#!${process.execPath}
import {writeFileSync} from 'node:fs'
try {writeFileSync(process.env.CLAUDE_CONFIG_DIR + '/migration','unwanted')} catch {}
console.log(JSON.stringify({loggedIn:false}))
`,
      { mode: 0o700 },
    )
    assert.equal((await detect({ source, bin })).status, 'login')
    await assert.rejects(stat(path.join(source, 'migration')), { code: 'ENOENT' })
  },
)

test('official browser login uses app profile, confirms the subscription, and excludes inherited credentials', async (t) => {
  const { login } = await import('../desktop/adapters/claude.mjs')
  const source = await mkdtemp(path.join(os.tmpdir(), 'boteam-claude-login-'))
  t.after(() => rm(source, { recursive: true, force: true }))
  const bin = path.join(source, 'fake-authorize.mjs')
  await writeFile(
    bin,
    `#!${process.execPath}
import {writeFileSync,existsSync} from 'node:fs'
const p=process.env.CLAUDE_CONFIG_DIR+'/authorized'
if(process.argv.includes('login')){
 if(!process.argv.includes('--claudeai')||process.env.ANTHROPIC_API_KEY)process.exit(2)
 writeFileSync(p,'native login finished')
} else console.log(JSON.stringify(existsSync(p)?${JSON.stringify(oauth)}:{loggedIn:false}))
`,
    { mode: 0o700 },
  )
  const result = await login({ source, bin })
  assert.equal(result.status, 'ready')
  assert.equal(result.email, email)
  assert.equal(await readFile(path.join(source, 'authorized'), 'utf8'), 'native login finished')
})

test('cancelling Claude login waits for the native callback process to exit', async t => {
  const { login } = await import('../desktop/adapters/claude.mjs')
  const source = await mkdtemp(path.join(os.tmpdir(), 'boteam-claude-cancel-'))
  const bin = path.join(source,'auth.mjs')
  const controller = new AbortController()
  t.after(async () => { controller.abort(); await rm(source,{recursive:true,force:true}) })
  await writeFile(bin, `#!${process.execPath}
import { writeFileSync } from 'node:fs'
process.on('SIGTERM', () => setTimeout(() => process.exit(1), 120))
writeFileSync('listener.pid', String(process.pid))
setTimeout(() => process.exit(1), 5000)
`, { mode:0o700 })
  const cancelled = assert.rejects(login({ source, bin, signal:controller.signal }), /取消|授权/)
  const deadline = Date.now() + 3000
  let pid
  while (!pid && Date.now() < deadline) {
    pid = Number(await readFile(path.join(source,'listener.pid'),'utf8').catch(() => 0))
    if (!pid) await new Promise(done => setTimeout(done,10))
  }
  assert.ok(pid)
  controller.abort()
  await cancelled
  assert.throws(() => process.kill(pid,0), { code:'ESRCH' })
})

test('native plan, scoped context and verified subscription usage use controls on the same process', async (t) => {
  const f = await fixture(t)
  const account = { ...f, ...(await detect(f)) }
  const events = [],
    image = path.join(f.source, 'image.png')
  await writeFile(image, 'snapshot')
  const task = {
    account,
    cwd: f.source,
    prompt: 'file',
    permission: 'plan',
    attachments: [{ path: image, mimeType: 'image/png', size: 8 }],
    emit: (e) => events.push(e),
    approve: () => false,
  }
  await run(task)
  const send = JSON.parse((await readFile(path.join(f.source, 'submitted'), 'utf8')).trim())
  assert.equal(send.args[send.args.indexOf('--permission-mode') + 1], 'plan')
  assert.equal(
    send.text.find((i) => i.type === 'image').source.data,
    Buffer.from('snapshot').toString('base64'),
  )
  assert.deepEqual(events.find((e) => e.type === 'context')?.value, {
    used: 901,
    limit: 120000,
    model: 'claude-a',
  })
  const { quota } = await import('../desktop/adapters/claude.mjs')
  assert.deepEqual(
    (await quota({ account, model: 'claude-sonnet-4' })).windows.map((w) => w.remainingPercent),
    [90, 23],
  )
  await assert.rejects(run({ ...task, permission: 'invalid' }), /权限/)
})

test('a group reply and an old quote reach the Claude CLI as one user message per request', async t => {
  const f = await fixture(t)
  const claude = { ...f, ...await detect(f) }
  const options = { root: path.join(f.source, 'workspace'), adapters: {
    claude: { run: scope => run({ ...scope, approve: async () => false }) },
    codex: { async run({ emit }) {
      emit({ type: 'identity', value: 'fixture' })
      emit({ type: 'text', value: '定稿 K9-37：错误率超过 2% 持续五分钟。' })
    } },
  } }
  let ws = new Workspace(options)
  t.after(() => ws.close())
  for (const [tool, metadata] of Object.entries({ claude, codex: { status: 'ready', identity: 'fixture' } })) {
    ws.db.run('INSERT INTO accounts(id,provider,identity,info) VALUES(?,?,?,?)', tool, tool, metadata.identity, JSON.stringify(metadata))
  }
  const writer = await ws.handle('createBot', { accountId: 'codex', name: '作者' })
  const reviewer = await ws.handle('createBot', { accountId: 'claude', name: '评审员' })
  const chatId = await ws.handle('createChat', { kind: 'group', name: '验收群', members: [writer, reviewer] })
  async function send(recipient, text, replyToMessageId) {
    const id = await ws.handle('send', { chatId, recipients: [recipient], text, replyToMessageId })
    await Promise.all(ws.lanes.values())
    const task = ws.db.get('SELECT id,status,error FROM tasks WHERE messageId=?', id)
    assert.equal(task.status, 'done', task.error)
    return ws.db.get('SELECT * FROM messages WHERE taskId=?', task.id)
  }
  const original = await send(writer, '请制定一条规则')
  await send(reviewer, '评审这条规则')
  await ws.close()
  ws = new Workspace(options)
  await send(reviewer, '将引用的阈值降低一半', original.id)
  const frames = (await readFile(path.join(f.source, 'submitted'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(frames.length, 2)
  assert.ok(frames[0].text.includes(original.text) && frames[0].text.includes('作者'))
  assert.ok(frames[1].text.includes(original.text) && frames[1].text.endsWith('将引用的阈值降低一半'))
  assert.equal(frames[1].args[frames[1].args.indexOf('--resume') + 1], frames[0].args[frames[0].args.indexOf('--session-id') + 1])
})

test('Claude generates the first title through a native control and tolerates an older CLI', async t => {
  const f = await fixture(t)
  const account = { ...f, ...await detect(f) }
  const description = 'Review subscription usage across two accounts and compare the reset times.'
  for (const supported of [true, false]) {
    if (!supported) await writeFile(path.join(f.source, 'no-titles'), '')
    const events = []
    await run({ account, cwd: f.source, prompt: 'request', titleRequest: () => description,
      emit: event => events.push(event), approve: () => false })
    assert.deepEqual(events.filter(e => e.type === 'title').map(e => e.value), supported ? ['Trace subscription usage'] : [])
    assert.ok(events.some(e => e.type === 'text'))
  }
  const sent = (await readFile(path.join(f.source, 'titles'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(sent, Array(2).fill({ subtype: 'generate_session_title', description, persist: false }))
})
