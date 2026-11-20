import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { composerActions, detect, options, prepare, run } from '../desktop/adapters/claude.mjs'

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
  { value: 'b', resolvedModel: 'claude-b', displayName: 'B' },
]

async function fixture(t, status = oauth, account = live) {
  const source = await mkdtemp(path.join(os.tmpdir(), 'boteam-claude-'))
  t.after(() => rm(source, { recursive: true, force: true }))
  const bin = path.join(source, 'fake-claude.mjs')
  await writeFile(
    bin,
    `#!${process.execPath}
import { appendFileSync, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
const args = process.argv.slice(2)
if (args.includes('auth')) {
  console.log(JSON.stringify(${JSON.stringify(status)}))
  process.exit(${status.loggedIn ? 0 : 1})
}
const write = m => console.log(JSON.stringify(m))
const session = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id')+1]
let model
for await (const line of createInterface({input:process.stdin})) {
  const m = JSON.parse(line)
  if (m.type === 'control_request') {
    if (m.request.subtype === 'set_model') model = m.request.model
    const data = m.request.subtype === 'set_permission_mode' ? {mode:m.request.mode} : m.request.subtype === 'get_usage' ? {rate_limits_available:true,rate_limits:{five_hour:{utilization:10},seven_day:{utilization:49},seven_day_sonnet:{utilization:77}}} : m.request.subtype === 'get_context_usage' ? {totalTokens:901,maxTokens:100000,rawMaxTokens:120000,model:'claude-a'} : m.request.subtype === 'get_settings'
      ? {applied:{model:existsSync(process.env.CLAUDE_CONFIG_DIR + '/mismatch') ? 'different' : model || 'claude-a',effort:args.includes('--effort') ? args[args.indexOf('--effort')+1] : undefined}}
      : {account:${JSON.stringify(account)},models:${JSON.stringify(models)},commands:existsSync(process.env.CLAUDE_CONFIG_DIR + '/commands-removed') ? [] : [{name:'dataviz',description:'Draw a chart',argumentHint:'[table]'},{name:'clear',aliases:['new']},{name:'usage',aliases:['cost']},{name:'context'},{name:'goal'}]}
    write({ type:'control_response',response:{subtype:'success',request_id:m.request_id,response:data}})
  } else if (m.type === 'user') {
    appendFileSync(process.env.CLAUDE_CONFIG_DIR + '/submitted', JSON.stringify({args,model,text:m.message.content,override:!!process.env.ANTHROPIC_API_KEY})+'\\n')
    write({type:'system',subtype:'init',session_id:session})
    write({type:'control_request',request_id:'ask1',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'echo sk-ant-fake-private'}}})
  } else if (m.type === 'control_response') {
    const decision = m.response.response.behavior
    write({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'part1'}}})
    write({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:decision}}})
    write({type:'assistant',message:{content:[{type:'text',text:'part1'+decision}]}})
    write({type:'result',subtype:'success',is_error:false,result:'part1'+decision,session_id:session})
  }
}
`,
    { mode: 0o700 },
  )
  return { source, bin, managed: true }
}

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
