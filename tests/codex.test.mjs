import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as codex from '../desktop/adapters/codex.mjs'
import { detect, login, options, prepare, run } from '../desktop/adapters/codex.mjs'
import { locate } from '../desktop/native.mjs'
import { nativeError } from '../desktop/adapters/codex-rpc.mjs'

test('Codex discovery uses the installed desktop client ahead of an older standalone CLI', async (t) => {
  const desktop = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
  if (process.platform !== 'darwin' || !(await fs.stat(desktop).catch(() => null))?.isFile()) {
    return t.skip('Requires the installed macOS desktop client')
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'boteam-cli-path-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  await fs.writeFile(path.join(dir, 'codex'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
  const previous = process.env.PATH
  process.env.PATH = dir + path.delimiter + previous
  t.after(() => { process.env.PATH = previous })
  const result = await locate('codex', dir)
  assert.equal(result.bin, desktop)
  assert.equal(result.source, dir)
  assert.equal(result.appInstalled, true)
})

// Speaks the native JSON-lines protocol and rejects credentials or API overrides on disk/env.
const program = `#!/usr/bin/env node
const fs = require('node:fs'), readline = require('node:readline');
const out = (o) => process.stdout.write(JSON.stringify(o)+'\\n');
const notify = (method,params) => out({method,params});
let account, threadId, turnId = 'turn-1';
const optFile = require('node:path').join(__dirname, 'scenario.json');
const scenario = fs.existsSync(optFile) ? JSON.parse(fs.readFileSync(optFile, 'utf8')) : {};
if(process.argv.includes('generate-json-schema')) {
 const names=scenario.schemaMethods || ['model/list','mcpServerStatus/list','thread/compact/start','thread/start','account/rateLimits/read','skills/list','collaborationMode/list','thread/goal/set','review/start','thread/read','thread/fork'];
 const dir=process.argv[process.argv.indexOf('--out')+1];
 fs.writeFileSync(require('node:path').join(dir,'ClientRequest.json'),JSON.stringify({oneOf:names.map(name=>({properties:{method:{enum:[name]}}}))}));
 process.exit(0);
}
if(process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL || process.env.CODEX_ACCESS_TOKEN) process.exit(1);
readline.createInterface({input:process.stdin}).on('line', line => {
 const {method,id,params:p,result:r} = JSON.parse(line);
 const reply = result => out({id,result});
 if (method === 'initialize') return reply({});
 if (method === 'initialized') return;
 if (method === 'config/read') return reply({config:{model_provider:'openai',cli_auth_credentials_store:process.argv.includes('cli_auth_credentials_store="file"')?'file':'ephemeral',forced_login_method:'chatgpt',chatgpt_base_url:'https://chatgpt.com/backend-api/',openai_base_url:scenario.external ? 'https://example.test' : 'https://chatgpt.com/backend-api/codex'}});
 if (method === 'account/login/start') {
   if(p.type==='chatgpt') {
     reply({type:p.type,loginId:'login',authUrl:scenario.externalLogin ? 'https://example.test/oauth' : 'https://auth.openai.com/oauth/authorize'});
     notify('account/login/completed',{loginId:'login',success:true});return;
   }
   fs.writeFileSync(__dirname+'/bootstrap-seen','yes');
   if(p.type!=='chatgptAuthTokens' || p.refreshToken || fs.existsSync(process.env.CODEX_HOME+'/auth.json')) process.exit(2);
   const claims=JSON.parse(Buffer.from(p.accessToken.split('.')[1],'base64url'));
   account={type:'chatgpt',email:claims['https://api.openai.com/profile'].email,planType:p.chatgptPlanType};return reply({type:p.type});
 }
 if(method==='model/list') return reply(p.cursor
   ? {data:[{model:'second',displayName:'Second',supportedReasoningEfforts:[{reasoningEffort:'high'}],defaultReasoningEffort:'high'}]}
   : {data:[{model:'fixture',isDefault:true,displayName:'Fixture',supportedReasoningEfforts:[{reasoningEffort:'low'}],defaultReasoningEffort:'low'}],nextCursor:'page2'});
 if(method==='account/rateLimits/read') return scenario.noQuota ? out({id,error:{code:-1,message:'rate endpoint unavailable'}}) : reply({rateLimits:{primary:{usedPercent:15,windowDurationMins:300,resetsAt:1893456000}}});
 if(method==='account/read') return reply({account,requiresOpenaiAuth:true});
 if(scenario.audit) fs.appendFileSync(__dirname+'/audit',JSON.stringify({method,p})+'\\n');
 const goalFile = require('node:path').join(process.env.CODEX_HOME,'fixture-goal.json');
 const goal = () => fs.existsSync(goalFile) ? JSON.parse(fs.readFileSync(goalFile)) : null;
 if(method==='thread/goal/get') {
   if(scenario.legacyGoal) return out({id,error:{code:-32600,message:'Invalid request: unknown variant '+String.fromCharCode(96)+'thread/goal/get'+String.fromCharCode(96)+', expected one of ...'}});
   return reply({goal:goal()});
 }
 if(method==='thread/goal/clear') { fs.rmSync(goalFile,{force:true}); return reply({cleared:true}); }
 if(method==='thread/goal/set'){
   const next={...(goal()||{threadId:p.threadId,objective:p.objective,tokensUsed:0,timeUsedSeconds:0,tokenBudget:null}),status:p.status||'active',...(p.objective&&{objective:p.objective})};
   fs.writeFileSync(goalFile,JSON.stringify(next));reply({goal:next});
   notify('thread/goal/updated',{threadId:p.threadId,goal:next});
   if(threadId && next.status==='active') {
     notify('turn/started',{threadId,turn:{id:'goal-1'}});
     notify('item/agentMessage/delta',{threadId,turnId:'goal-1',itemId:'x',delta:'first'});
     if(!scenario.holdGoal) {
       notify('turn/completed',{threadId,turn:{id:'goal-1',status:'completed'}});
       const completeSecond=()=>{
         notify('turn/started',{threadId,turn:{id:'goal-2'}});
         notify('item/agentMessage/delta',{threadId,turnId:'goal-2',itemId:'x',delta:'second'});
         const complete={...next,status:'complete',tokensUsed:70};fs.writeFileSync(goalFile,JSON.stringify(complete));
         notify('thread/goal/updated',{threadId,turnId:'goal-2',goal:complete});
         notify('turn/completed',{threadId,turn:{id:'goal-2',status:'completed'}});
       };if(scenario.staleGoal) completeSecond(); else setTimeout(completeSecond,30)
     }
   }
   return;
 }
 if(method==='configRequirements/read') return reply({requirements:null});
 if(method==='experimentalFeature/list')return reply({data:['apps','plugins','goals','guardian_approval'].map(name=>({name,enabled:!scenario.disabled}))});
 if(method==='collaborationMode/list') return reply({data:scenario.disabled?[]:[{mode:'plan'},{mode:'default'}]});
 if(method==='skills/list')return reply({data:[{cwd:p.cwds[0],skills:[{name:'sketch',enabled:true,path:'/fixtures/SKILL.md'},{name:'disabled',enabled:false,path:'/disabled'}]}]});
 if(method==='plugin/installed')return reply({marketplaces:[{plugins:[{id:'drawing@native',name:'drawing',enabled:true,installed:true},{id:'missing',name:'missing',enabled:true,installed:false}]}]});
 if(method==='app/installed')return reply({apps:[{id:'app1',runtimeName:'Notes',enabled:true,callable:true},{id:'unusable',enabled:true,callable:false}]});
 if(method==='thread/settings/update') return reply({});
 if(method==='thread/start'||method==='thread/resume'){
   if(scenario.composer && (p.approvalPolicy!=='never'||p.sandbox!=='read-only')) process.exit(4);
   if(p.modelProvider!=='openai'||!p.approvalPolicy||!['workspace-write','read-only'].includes(p.sandbox))process.exit(3);
   fs.appendFileSync(__dirname+'/requests',JSON.stringify({method,model:p.model,effort:p.config?.model_reasoning_effort})+'\\n');
   threadId=p.threadId||require('node:crypto').randomUUID();
   if(scenario.staleGoal && method==='thread/resume' && goal()) notify('thread/goal/updated',{threadId,goal:goal()});
   return reply({thread:{id:threadId},approvalsReviewer:scenario.wrongReviewer?'user':p.approvalsReviewer,collaborationMode:scenario.priorPlan?{mode:'plan'}:null,model:scenario.wrongModel?'different':p.model,reasoningEffort:p.config?.model_reasoning_effort,modelProvider:'openai',approvalPolicy:p.approvalPolicy,sandbox:{type:p.sandbox==='read-only'?'readOnly':'workspaceWrite',networkAccess:false}});
 }
 if(method==='thread/read' || method==='thread/fork'){
   const path=require('node:path');
   const dir=path.join(process.env.CODEX_HOME,'sessions','2026','11','20');
   const rollout=(id)=>path.join(dir,'rollout-2026-11-20T00-00-00-'+id+'.jsonl');
   const read=(id)=>{
     const v=JSON.parse(fs.readFileSync(rollout(id),'utf8'));
     return {id,modelProvider:'openai',cwd:v.cwd,ephemeral:false,forkedFromId:v.parent||null,path:scenario.wrongForkPath?__filename:rollout(id)};
   };
   try {
     if(method==='thread/read')return reply({thread:read(p.threadId)});
     if(p.sandbox!=='read-only'||p.approvalPolicy!=='never'||!p.deferGoalContinuation||p.path!==rollout(p.threadId))throw Error();
     const parent=read(p.threadId);
     const child=require('node:crypto').randomUUID();
     fs.writeFileSync(rollout(child),JSON.stringify({parent:p.threadId,cwd:p.cwd}));
     return reply({thread:{...read(child),forkedFromId:scenario.wrongForkParent?'other':parent.id},model:p.model,modelProvider:p.modelProvider,reasoningEffort:p.config?.model_reasoning_effort,approvalPolicy:'never',sandbox:{type:'readOnly'}});
   }catch{return out({id,error:{code:-32600,message:'no rollout found'}})}
 }
 if(method==='mcpServerStatus/list')return reply({data:[{name:'notes',tools:{search:{description:'secret data'}},toolsError:null,runtimeStatus:'connected',httpOrigin:'sensitive url',authStatus:'oAuth'}],nextCursor:null});
 if(method==='thread/compact/start') {
   reply({});
   if(scenario.waitCompact)return;
   const c='compact-turn';
   notify('turn/started',{threadId,turn:{id:c}});
   notify('turn/completed',{threadId:'foreign',turn:{id:c,status:'completed'}});
   notify('item/completed',{threadId,turnId:'unrelated',item:{type:'contextCompaction'}});
   notify('turn/completed',{threadId,turn:{id:'unrelated',status:'failed'}});
   if(!scenario.skipCompact)notify('item/completed',{threadId,turnId:c,item:{type:'contextCompaction'}});
   notify('model/rerouted',{threadId,turnId:c,toModel:'compact-model'});
   notify('thread/tokenUsage/updated',{threadId,turnId:c,tokenUsage:{last:{totalTokens:24},modelContextWindow:200}});
   notify('turn/completed',{threadId,turn:{id:c,status:'completed'}});
   return;
 }
 if(method==='review/start') {
   const id='review-turn', item={type:'exitedReviewMode',id:'review-output',review:'Native review findings'};
   reply({turn:{id},reviewThreadId:scenario.foreignReview?'other':threadId});
   notify('item/completed',{threadId:'other',turnId:id,item:{...item,review:'WRONG'}});
   if(scenario.reviewProgress) {
     const progress={type:'agentMessage',id:'progress',phase:'commentary',text:'Review progress'};
     notify('item/agentMessage/delta',{threadId,turnId:id,itemId:progress.id,delta:'Review'});
     notify('item/completed',{threadId,turnId:id,item:progress});
     notify('item/completed',{threadId,turnId:id,item:{type:'plan',id:'plan',text:'Review plan'}});
   }
   if(!scenario.missingReview)notify('item/completed',{threadId,turnId:id,item});
   notify('turn/completed',{threadId,turn:{id,status:'completed',items:scenario.missingReview?[]:[item]}});
   return;
 }
 if(method==='turn/start') {
   fs.appendFileSync(__dirname+'/requests',JSON.stringify({method,model:p.model,effort:p.effort})+'\\n');
   if(scenario.refresh) {
     out({id:'external-refresh',method:'account/chatgptAuthTokens/refresh',params:{}});return reply({turn:{id:turnId}});
   }
   reply({turn:{id:turnId}});
   if(scenario.turnError) {
     notify('turn/completed',{threadId,turn:{id:turnId,status:'failed',error:scenario.turnError,items:[]}});
     return;
   }
   if(scenario.questions) {
     const questions=[{id:'color',header:'Color',question:'Which color?',isOther:true,isSecret:false,options:[{label:'Blue',description:'Use blue'}]}];
     out({method:'item/tool/requestUserInput',id:'ask-foreign',params:{threadId:'foreign',turnId,questions}});
     out({method:'item/tool/requestUserInput',id:'ask-1',params:{threadId,turnId,questions}});
     return;
   }
   if(scenario.composer) {
     fs.writeFileSync(__dirname+'/input',JSON.stringify(p.input));
     const usage = (tokens) => ({last:{totalTokens:tokens},total:{totalTokens:10000},modelContextWindow:64000});
     notify('thread/tokenUsage/updated',{threadId,turnId,tokenUsage:usage(300)});
     notify('model/rerouted',{threadId,turnId,fromModel:p.model,toModel:'fixture-routing-target'});
     notify('model/rerouted',{threadId,turnId:'other',toModel:'wrong-turn'});
     notify('model/rerouted',{threadId:'other',turnId,toModel:'wrong-thread'});
     notify('thread/tokenUsage/updated',{threadId,turnId,tokenUsage:usage(325)});
     notify('thread/tokenUsage/updated',{threadId:'other',turnId,tokenUsage:usage(500)});
     notify('account/rateLimits/updated',{rateLimits:{limitId:'codex',secondary:{usedPercent:40,windowDurationMins:10080}}});
   }
   if(p.collaborationMode?.mode==='plan')notify('item/completed',{threadId,turnId,item:{type:'plan',id:'plan1',text:'### Proposed plan'}});
   notify('item/agentMessage/delta',{threadId,turnId,itemId:'a',delta:'A'});
   notify('item/agentMessage/delta',{threadId:'other',turnId,itemId:'x',delta:'OTHER'});
   out({id:'approve-1',method:'item/commandExecution/requestApproval',params:{threadId,turnId,itemId:'x',command:'echo fixture-sensitive-string > ./artifact.txt',cwd:'/tmp'}});
   if(scenario.exitDuringApproval) setTimeout(()=>process.exit(0),15);
   return;
 }
 if(id==='ask-1') {
   fs.writeFileSync(__dirname+'/answers',JSON.stringify(r||{}));
   notify('turn/completed',{threadId,turn:{id:turnId,status:'completed',items:[]}});return;
 }
 if(id==='approve-1' && r?.decision==='decline') {
   notify('item/completed',{threadId,turnId,item:{type:'agentMessage',id:'a',text:'AB'}});
   notify('turn/completed',{threadId,turn:{id:turnId,status:'completed',items:[]}}); return;
 }
});
`
function record({ workspace = 'ws1', sub = 'user1', offset = 3600, mode = 'chatgpt' } = {}) {
  const claim = {
    iss: 'https://auth.openai.com',
    sub,
    exp: Date.now() / 1000 + offset,
    'https://api.openai.com/auth': { chatgpt_account_id: workspace, chatgpt_plan_type: 'pro' },
    'https://api.openai.com/profile': { email: 'member@example.test' },
  }
  const token = [
    Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url'),
    Buffer.from(JSON.stringify(claim)).toString('base64url'),
    'fixture',
  ].join('.')
  return {
    auth_mode: mode,
    tokens: { access_token: token, account_id: workspace, refresh_token: 'never-send' },
  }
}
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'boteam-codex-test-'))
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  const source = path.join(base, 'native'),
    profile = path.join(base, 'runtime'),
    bin = path.join(base, 'codex.cjs')
  await fs.mkdir(source, { mode: 0o700 })
  await fs.writeFile(bin, program, { mode: 0o700 })
  const write = (o) =>
    fs.writeFile(path.join(source, 'auth.json'), JSON.stringify(o), { mode: 0o600 })
  await write(record())
  const scenario = (o) => fs.writeFile(path.join(base, 'scenario.json'), JSON.stringify(o))
  return { base, source, profile, bin, write, scenario }
}
test('verified source binds workspace and subject without copying login; run resumes and routes approvals', async (t) => {
  const f = await fixture(t)
  const previous = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = 'fixture'
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previous
  })
  const detected = await detect(f)
  assert.equal(detected.status, 'ready')
  assert.match(detected.quota, /5 小时剩余 85%/)
  assert.match(detected.quota, /2030-01-01T00:00:00.000Z/)
  const account = await prepare({
    candidate: { ...detected, source: f.source, bin: f.bin },
    profile: f.profile,
  })
  assert.equal(account.source, f.profile)
  assert.equal(account.credentialSource, f.source)
  assert.equal(account.identity, detected.identity)
  assert.ok(!JSON.stringify(account).includes('never-send'))
  let prompt
  const events = []
  await run({
    account,
    bot: {},
    threadId: 'resumed',
    prompt: 'hello',
    cwd: f.base,
    emit: (e) => events.push(e),
    approve: async (p) => ((prompt = p), false),
  })
  assert.ok(
    events.some(
      (e) =>
        e.type === 'identity' && e.value === 'member@example.test' && e.key === detected.identity,
    ),
  )
  assert.ok(events.some((e) => e.type === 'session' && e.value === 'resumed'))
  assert.equal(
    events
      .filter((e) => e.type === 'text')
      .map((e) => e.value)
      .join(''),
    'AB',
  )
  assert.ok(prompt.title)
  assert.match(prompt.detail, /artifact.txt/)
  assert.ok(!JSON.stringify(prompt).includes('fixture-sensitive-string'))
  assert.ok(!(await fs.readdir(f.profile)).includes('auth.json'))
  await f.write(record({ workspace: 'ws2' }))
  await assert.rejects(
    run({
      account,
      bot: {},
      prompt: 'no',
      cwd: f.base,
      emit: () => assert.fail('started wrong account'),
      approve: () => false,
    }),
    /身份|绑定/,
  )
})
test('expired credentials, linked files and API key modes cannot start a task', async (t) => {
  const f = await fixture(t)
  await f.write(record({ offset: -100 }))
  assert.notEqual((await detect(f)).status, 'ready')
  await f.write(record({ mode: 'apikey' }))
  assert.notEqual((await detect(f)).status, 'ready')
  const original = path.join(f.base, 'other.json')
  await fs.writeFile(original, JSON.stringify(record()))
  await fs.unlink(path.join(f.source, 'auth.json'))
  await fs.symlink(original, path.join(f.source, 'auth.json'))
  assert.notEqual((await detect(f)).status, 'ready')
})

test('account catalog drives independent new and resumed model/effort overrides', async (t) => {
  const f = await fixture(t)
  const account = await prepare({ candidate: { ...f, ...(await detect(f)) }, profile: f.profile })
  const catalog = await options({ account })
  assert.equal(catalog.defaultModel, 'fixture')
  assert.deepEqual(
    catalog.models.map((m) => [m.id, m.label, ...m.efforts.map((e) => e.id)]),
    [
      ['fixture', 'Fixture', 'low'],
      ['second', 'Second', 'high'],
    ],
  )
  let threadId
  const task = {
    account,
    cwd: f.base,
    prompt: 'test',
    approve: async () => false,
    emit(e) {
      if (e.type === 'session') threadId = e.value
    },
  }
  await run({ ...task, bot: { model: 'second', effort: 'high' } })
  await run({ ...task, threadId, bot: { effort: 'low' } })
  const readRequests = async () =>
    (await fs.readFile(path.join(f.base, 'requests'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(await readRequests(), [
    { method: 'thread/start', model: 'second', effort: 'high' },
    { method: 'turn/start', model: 'second', effort: 'high' },
    { method: 'thread/resume', model: 'fixture', effort: 'low' },
    { method: 'turn/start', model: 'fixture', effort: 'low' },
  ])
  for (const bot of [{ model: 'removed' }, { model: 'second', effort: 'low' }])
    await assert.rejects(run({ ...task, threadId, bot }), /模型|推理/)
  assert.equal((await readRequests()).length, 4)
  await f.scenario({ wrongModel: true })
  await assert.rejects(run({ ...task, threadId, bot: { model: 'second' } }), /模型/)
  assert.equal((await readRequests()).at(-1).method, 'thread/resume')
})

test('each account and assigned bot gets independent native storage and its own subscription binding', async (t) => {
  const [a, b] = await Promise.all([fixture(t), fixture(t)])
  await b.write(record({ workspace: 'ws2', sub: 'user2' }))
  async function adopt(f) {
    const info = await detect(f)
    return prepare({ candidate: { ...info, source: f.source, bin: f.bin }, profile: f.profile })
  }
  const [one, two] = await Promise.all([adopt(a), adopt(b)])
  assert.notEqual(one.identity, two.identity)
  const inputs = [
    [one, 'group', 'bot1'],
    [one, 'group', 'bot2'],
    [one, 'direct', 'bot1'],
    [two, 'group', 'bot3'],
  ]
  const sessions = await Promise.all(
    inputs.map(async ([account, chatId, id]) => {
      let session
      await run({
        account,
        chatId,
        bot: { id },
        prompt: 'hello',
        cwd: a.base,
        signal: AbortSignal.timeout(5000),
        approve: async () => false,
        emit: (e) => {
          if (e.type === 'session') session = e.value
        },
      })
      return session
    }),
  )
  assert.equal(new Set(sessions).size, 4)
  assert.equal((await fs.readdir(path.join(one.source, 'contexts'))).length, 3)
  assert.equal((await fs.readdir(path.join(two.source, 'contexts'))).length, 1)
})
test('effective transport is checked before credentials enter the runtime; unexpected external refresh stops', async (t) => {
  const f = await fixture(t),
    meta = await detect(f)
  const account = await prepare({
    candidate: { ...meta, source: f.source, bin: f.bin },
    profile: f.profile,
  })
  await fs.unlink(path.join(f.base, 'bootstrap-seen'))
  await f.scenario({ external: true })
  const input = {
    account,
    cwd: f.base,
    prompt: 'test',
    emit: () => {},
    approve: async () => false,
    signal: AbortSignal.timeout(5000),
  }
  await assert.rejects(run(input), /服务地址|认证方式/)
  await assert.rejects(fs.access(path.join(f.base, 'bootstrap-seen')), { code: 'ENOENT' })
  await f.scenario({ refresh: true })
  await assert.rejects(run(input), /刷新/)
  await f.scenario({ noQuota: true })
  const again = await detect(f)
  assert.equal(again.status, 'ready')
  assert.equal(again.quota, undefined)
})
test('native browser flow validates official URL and waits for matching completion', async (t) => {
  const f = await fixture(t)
  let opened
  await login({
    ...f,
    source: f.profile,
    openUrl: async (url) => {
      opened = new URL(url)
    },
  })
  assert.equal(opened.hostname, 'auth.openai.com')
  await f.scenario({ externalLogin: true })
  await assert.rejects(
    login({ ...f, source: f.profile, openUrl: () => assert.fail('external redirect') }),
    /官方授权/,
  )
})

test('native exit releases an unanswered approval', async (t) => {
  const f = await fixture(t),
    meta = await detect(f)
  const account = await prepare({
    candidate: { ...meta, source: f.source, bin: f.bin },
    profile: f.profile,
  })
  await f.scenario({ exitDuringApproval: true })
  let requested = false
  const approve = () => {
    requested = true
    return new Promise(() => {})
  }
  await assert.rejects(
    run({
      account,
      cwd: f.base,
      prompt: 'test',
      approve,
      emit: () => {},
      signal: AbortSignal.timeout(2000),
    }),
    /退出/,
  )
  assert.equal(requested, true)
})

test('read-only resumes deny approvals, use the matching turn context and native quota windows', async (t) => {
  const f = await fixture(t)
  const account = await prepare({ candidate: { ...f, ...(await detect(f)) }, profile: f.profile })
  await f.scenario({ composer: true })
  const events = []
  const image = path.join(f.base, 'snap.png')
  await fs.writeFile(image, 'local snapshot')
  const task = {
    account,
    bot: {},
    cwd: f.base,
    threadId: 'resumed',
    permission: 'read-only',
    prompt: 'image',
    attachments: [{ path: image, mimeType: 'image/png', size: 14 }],
    emit: (e) => events.push(e),
    approve: () => assert.fail('read-only cannot escalate'),
  }
  await run(task)
  assert.deepEqual(
    events.filter((e) => e.type === 'context').map((e) => [e.value.used, e.value.limit, e.value.model]),
    [[300, 64000, account.model], [325, 64000, 'fixture-routing-target']],
  )
  assert.deepEqual(
    events
      .filter((e) => e.type === 'quota')
      .at(-1)
      ?.value.windows.map((w) => [w.minutes, w.remainingPercent]),
    [
      [300, 85],
      [10080, 60],
    ],
  )
  assert.ok(
    JSON.parse(await fs.readFile(path.join(f.base, 'input'))).some(
      (i) => i.type === 'localImage' && i.path === image,
    ),
  )
  await assert.rejects(run({ ...task, permission: 'invalid' }), /权限/)
})

async function composerFixture(t) {
  const f = await fixture(t)
  const account = await prepare({ candidate: { ...f, ...(await detect(f)) }, profile: f.profile })
  await f.scenario({ audit: true })
  const events = []
  const task = {
    account,
    cwd: f.base,
    chatId: 'chat',
    bot: { id: 'bot' },
    prompt: 'hello',
    signal: AbortSignal.timeout(5000),
    emit: (e) => events.push(e),
    approve: () => false,
  }
  const audit = async () =>
    (await fs.readFile(path.join(f.base, 'audit'), 'utf8')).trim().split('\n').map(JSON.parse)
  return { f, task, events, audit }
}

test('native composer resolves enabled extensions, plan and auto-review for the bound task', async (t) => {
  const { f, task, events, audit } = await composerFixture(t)
  assert.equal(typeof codex.composerActions, 'function')
  const actions = await codex.composerActions(task)
  assert.deepEqual([actions.goal, actions.autoReview, actions.plan], [true, true, true])
  assert.deepEqual(actions.extensions.map((x) => x.label).sort(), ['Notes', 'drawing', 'sketch'])
  assert.ok(!JSON.stringify(actions).includes('/fixtures'))
  const extensionIds = actions.extensions.map((x) => x.id)
  let humanFallback = 0
  await run({
    ...task,
    permission: 'auto-review',
    planMode: true,
    extensionIds,
    approve: () => {
      humanFallback++
      return false
    },
  })
  assert.equal(humanFallback, 1)
  const calls = await audit()
  const open = calls.filter((x) => x.method === 'thread/start').at(-1).p
  assert.equal(open.approvalsReviewer, 'auto_review')
  assert.equal(open.approvalPolicy, 'on-request')
  assert.equal(open.sandbox, 'workspace-write')
  const turn = calls.find((x) => x.method === 'turn/start').p
  assert.deepEqual(turn.collaborationMode, {
    mode: 'plan',
    settings: { model: 'fixture', reasoning_effort: 'low', developer_instructions: null },
  })
  assert.deepEqual(
    turn.input.slice(1).sort((a, b) => a.path.localeCompare(b.path)),
    [
      { type: 'skill', name: 'sketch', path: '/fixtures/SKILL.md' },
      { type: 'mention', name: 'Notes', path: 'app://app1' },
      { type: 'mention', name: 'drawing', path: 'plugin://drawing@native' },
    ],
  )
  assert.ok(events.some((e) => e.type === 'text' && e.value.includes('Proposed plan')))
  await assert.rejects(run({ ...task, extensionIds: ['forged'] }), /扩展/)
  await f.scenario({ audit: true, wrongReviewer: true })
  await assert.rejects(run({ ...task, permission: 'auto-review' }), /审查|审批/)
  await f.scenario({ audit: true, priorPlan: true })
  await run({ ...task, threadId: 'resumed' })
  assert.equal(
    (await audit()).filter((x) => x.method === 'turn/start').at(-1).p.collaborationMode.mode,
    'default',
  )
})

test('goal activation tracks two native turns then reads and clears the same durable goal', async (t) => {
  const { task, events, audit } = await composerFixture(t)
  assert.equal(typeof codex.threadGoal, 'function')
  await run({ ...task, goalObjective: 'finish the drawing' })
  const threadId = events.find((e) => e.type === 'session').value
  assert.ok(events.some((e) => e.type === 'text' && e.value.includes('first')))
  assert.ok(events.some((e) => e.type === 'text' && e.value.includes('second')))
  assert.ok(events.some((e) => e.type === 'goal' && e.value?.status === 'complete'))
  const saved = await codex.threadGoal({ ...task, threadId, action: 'get' })
  assert.equal(saved.goal.objective, 'finish the drawing')
  assert.equal(saved.goal.tokensUsed, 70)
  assert.equal((await codex.threadGoal({ ...task, threadId, action: 'clear' })).goal, null)
  assert.equal((await codex.threadGoal({ ...task, threadId, action: 'get' })).goal, null)
  const calls = await audit()
  assert.equal(calls.filter((x) => x.method === 'turn/start').length, 0)
  assert.ok(
    calls.some(
      (x) => x.method === 'thread/goal/set' && x.p.origin === 'user' && x.p.status === 'active',
    ),
  )
})

test('cancelling a tracked native goal parks it before the next ordinary resume', async (t) => {
  const { task, f, audit } = await composerFixture(t)
  await f.scenario({ audit: true, holdGoal: true })
  const controller = new AbortController()
  let threadId
  await assert.rejects(
    run({
      ...task,
      goalObjective: 'draw',
      signal: controller.signal,
      emit(e) {
        if (e.type === 'session') threadId = e.value
        if (e.type === 'text') controller.abort()
      },
    }),
  )
  assert.equal((await codex.threadGoal({ ...task, threadId, action: 'get' })).goal.status, 'paused')
  await run({ ...task, threadId })
  assert.equal((await audit()).filter((x) => x.method === 'turn/start').length, 1)
})

test('disabled native features refuse sends before associating a fresh thread', async (t) => {
  const { task, f, events } = await composerFixture(t)
  await f.scenario({ disabled: true, audit: true })
  const actions = await codex.composerActions(task)
  assert.deepEqual([actions.goal, actions.autoReview, actions.plan], [false, false, false])
  await assert.rejects(run({ ...task, permission: 'auto-review' }), /审批|审查/)
  await assert.rejects(run({ ...task, planMode: true }), /计划/)
  await assert.rejects(run({ ...task, goalObjective: 'draw' }), /目标/)
  assert.ok(!events.some((e) => e.type === 'session'))
})

test('paused goal creation binds exactly one new native thread before mutation, without a model turn', async (t) => {
  const { task, audit } = await composerFixture(t)
  let bound
  const saved = await codex.threadGoal({
    ...task,
    action: 'set',
    status: 'paused',
    objective: 'sketch',
    onSession: async (id) => {
      assert.ok(!(await audit()).some((x) => x.method === 'thread/goal/set'))
      bound = id
    },
  })
  assert.equal(saved.threadId, bound)
  assert.equal(saved.goal.status, 'paused')
  assert.ok(!(await audit()).some((x) => x.method === 'turn/start'))
})

test('native questions accept only user answers from the matching chat and turn', async (t) => {
  const { task, f } = await composerFixture(t)
  await f.scenario({ questions: true })
  let count = 0
  await run({
    ...task,
    planMode: true,
    ask(questions) {
      count++
      assert.equal(questions[0].question, 'Which color?')
      assert.equal(questions[0].options[0].label, 'Blue')
      return { color: { answers: ['Green'] }, unrequested: { answers: ['x'] } }
    },
  })
  assert.equal(count, 1)
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.base, 'answers'), 'utf8')), {
    answers: { color: { answers: ['Green'] } },
  })
})

test('resuming a regular conversation works on older native servers without goals', async (t) => {
  const { task, f } = await composerFixture(t)
  await f.scenario({ legacyGoal: true })
  await run({ ...task, threadId: 'old-thread' })
})

test('a resumed goal consumes its own turns after an earlier parked notification', async (t) => {
  const { task, f, events } = await composerFixture(t)
  const { threadId } = await codex.threadGoal({
    ...task,
    action: 'set',
    status: 'paused',
    objective: 'existing drawing',
  })
  await f.scenario({ staleGoal: true })
  await run({ ...task, threadId, resumeGoal: true })
  assert.ok(events.some((e) => e.type === 'text' && e.value === 'second'))
  assert.ok(events.some((e) => e.type === 'goal' && e.value?.status === 'complete'))
})

test('Codex slash palette uses the installed protocol and current account capabilities', async (t) => {
  const { task, f } = await composerFixture(t)
  const catalog = await codex.composerActions(task)
  const byName = new Map(catalog.slashCommands.map((c) => [c.name, c.action]))
  for (const [name, action] of Object.entries({
    model: 'model', permissions: 'permission', status: 'quota', mcp: 'mcp', compact: 'compact', goal: 'goal', plan: 'plan',
  })) assert.equal(byName.get(name), action)
  assert.equal(byName.has('schedule'), false)
  await f.scenario({ disabled: true })
  const disabled = await codex.composerActions(task)
  assert.equal(disabled.slashCommands.some((c) => ['goal', 'plan'].includes(c.name)), false)
  const limited = await composerFixture(t)
  await limited.f.scenario({ schemaMethods: ['model/list'] })
  const older = await codex.composerActions(limited.task)
  assert.deepEqual(older.slashCommands.map(c => c.name), ['model'])
})

test('Codex /mcp displays scoped status without exposing native tool or connection details', async (t) => {
  const { task, audit } = await composerFixture(t)
  const info = await codex.slashInfo(task, { name: 'mcp' })
  assert.match(info.lines.join(' '), /notes.*已连接.*1/)
  assert.doesNotMatch(JSON.stringify(info), /sensitive url|secret data/)
  assert.ok((await audit()).some(r => r.method === 'mcpServerStatus/list' && r.p.threadId))
  await assert.rejects(codex.slashInfo(task, { name: 'unknown' }), /不支持/)
})

test('Codex /compact requires the bound existing thread, waits for its native compaction and never sends a prompt', async (t) => {
  const { task, f, events, audit } = await composerFixture(t)
  await assert.rejects(run({ ...task, slashCommand: 'compact' }), /会话/)
  await run({ ...task, threadId: 'existing', slashCommand: 'compact' })
  const calls = await audit()
  assert.equal(calls.find(c => c.method === 'thread/compact/start').p.threadId, 'existing')
  assert.equal(calls.some(c => c.method === 'turn/start' || c.method === 'thread/start'), false)
  assert.ok(events.some(e => e.type === 'identity'))
  assert.ok(events.some(e => e.type === 'context' && e.value.used === 24 && e.value.model === 'compact-model'))
  assert.ok(events.some(e => e.type === 'text' && /已压缩/.test(e.value)))
  await f.scenario({ skipCompact: true })
  await assert.rejects(run({ ...task, threadId: 'existing', slashCommand: 'compact' }), /压缩/)
  await f.scenario({ waitCompact: true })
  await assert.rejects(run({ ...task, threadId: 'existing', slashCommand: 'compact', signal: AbortSignal.timeout(700) }), /停止|退出/)
})

test('Codex /review starts native inline reviews of local changes or supplied instructions', async (t) => {
  const { task, f, events, audit } = await composerFixture(t)
  assert.equal((await codex.composerActions(task)).slashCommands.find(c => c.name === 'review')?.action, 'review')
  await run({ ...task, prompt: '', slashCommand: 'review' })
  const threadId = events.find(e => e.type === 'session').value
  await run({ ...task, threadId, prompt: 'Check type invariants', slashCommand: 'review' })
  const calls = await audit()
  assert.deepEqual(calls.filter(c => c.method === 'review/start').map(c => c.p), [
    { threadId, delivery: 'inline', target: { type: 'uncommittedChanges' } },
    { threadId, delivery: 'inline', target: { type: 'custom', instructions: 'Check type invariants' } },
  ])
  assert.equal(calls.some(c => c.method === 'turn/start'), false)
  assert.deepEqual(events.filter(e => e.type === 'text').map(e => e.value), ['Native review findings', 'Native review findings'])
  await f.scenario({ foreignReview: true })
  await assert.rejects(run({ ...task, threadId, slashCommand: 'review' }), /会话/)
})

test('public group reviews expose only confirmed native findings, including when progress was streamed', async t => {
  const { task, f, events } = await composerFixture(t)
  const review = { ...task, prompt: '', slashCommand: 'review' }
  await f.scenario({ reviewProgress: true })
  await run({ ...review, publicReview: true })
  const text = () => events.filter(e => e.type === 'text').map(e => e.value).join('')
  assert.equal(text(), 'Native review findings')
  events.length = 0
  await f.scenario({ reviewProgress: true, missingReview: true })
  await assert.rejects(run({ ...review, publicReview: true }), /审查/)
  assert.equal(text(), '')
  await run(review)
  assert.match(text(), /Review progress/)
})

test('Codex diagnoses a native context window rejection even without a prior window estimate', async t => {
  const { task, f } = await composerFixture(t)
  await f.scenario({ turnError: { codexErrorInfo: 'contextWindowExceeded', message: 'backend rejected private-marker' } })
  await assert.rejects(run(task), error => /输入.*窗口/.test(error.message) && !error.message.includes('private-marker'))
  assert.match(nativeError('Your input exceeds the context window of this model.').message, /输入.*窗口/)
  assert.match(nativeError('input token limit exceeded').message, /输入.*窗口/)
  assert.match(nativeError('prompt exceeds the model’s context window').message, /输入.*窗口/)
  assert.match(nativeError('rate limit exceeded for input tokens per minute').message, /额度|速率/)
  assert.match(nativeError('Rate limit: input token limit exceeded for tokens per minute').message, /额度|速率/)
})

test('Codex /fork stages only its source lineage in a new home and verifies the durable child', async (t) => {
  const { task, f, audit } = await composerFixture(t)
  const { createHash, randomUUID } = await import('node:crypto')
  const key = (chat) => createHash('sha256').update(JSON.stringify([chat, task.bot.id])).digest('hex')
  const storage = (chat) => path.join(task.account.source, 'contexts', key(chat))
  const dirs = ['sessions','2026','11','20']
  const filename = id => 'rollout-2026-11-20T00-00-00-' + id + '.jsonl'
  const threadId = randomUUID(), stranger = randomUUID()
  const dir = path.join(storage(task.chatId), ...dirs)
  await fs.mkdir(dir, { recursive: true })
  for (const id of [threadId, stranger]) await fs.writeFile(path.join(dir, filename(id)), JSON.stringify({ cwd: task.cwd }))
  const catalog = await codex.composerActions(task)
  assert.equal(catalog.slashCommands.find(c => c.name === 'fork').action, 'fork')
  const fork = await codex.forkChat({ ...task, threadId }, { destinationChatId: 'branch' })
  assert.notEqual(fork.threadId, threadId)
  const childDir = path.join(storage('branch'), ...dirs)
  assert.deepEqual((await fs.readdir(childDir)).sort(), [filename(threadId), filename(fork.threadId)].sort())
  assert.equal((await fs.stat(path.join(childDir, filename(threadId)))).mode & 0o777, 0o600)
  const second = await codex.forkChat({ ...task, chatId:'branch', threadId:fork.threadId }, { destinationChatId:'next' })
  assert.deepEqual((await fs.readdir(path.join(storage('next'), ...dirs))).sort(),
    [threadId, fork.threadId, second.threadId].map(filename).sort())
  await assert.rejects(codex.forkChat({ ...task, threadId }, { destinationChatId:'branch' }), /目录|存在/)
  await f.scenario({ wrongForkPath: true })
  await assert.rejects(codex.forkChat({ ...task, threadId }, { destinationChatId:'bad-path' }), /路径|目录|历史/)
  await f.scenario({ wrongForkParent: true })
  await assert.rejects(codex.forkChat({ ...task, threadId }, { destinationChatId:'bad-parent' }), /分支/)
  await assert.rejects(fs.stat(storage('bad-parent')), { code:'ENOENT' })
  await second.discard()
  await assert.rejects(fs.stat(storage('next')), { code:'ENOENT' })
  await fs.mkdir(storage('next'))
  await second.discard()
  assert.ok((await fs.stat(storage('next'))).isDirectory())
  assert.ok((await fs.stat(storage('branch'))).isDirectory())
  assert.equal((await audit()).some(c => c.method === 'turn/start'), false)
})
