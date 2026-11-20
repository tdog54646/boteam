import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../desktop/workspace.mjs'

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'boteam-import-agy-'))
  const shared = join(root, '.gemini', 'antigravity')
  await mkdir(shared, {recursive:true})
  const privateLogins = new Map()
  const probes = []
  let externalState = 'unknown'
  let previous = 'first@example.test', authorizeAs = previous
  const ready = email => ({ status:'ready', loginState:'signed-in', identity:'google:' + email, email, plan:'pro' })
  const adapter = {
    async detect({ source, managed }) {
      probes.push({source,managed})
      if (!managed) return { sourceKind:'desktop', identity:'source:' + source, status:'blocked', loginState:externalState, email:previous }
      return privateLogins.has(source) ? ready(privateLogins.get(source)) : {status:'login',reason:'需要 Google 授权'}
    },
    async login({source}) { privateLogins.set(source, authorizeAs) },
    async prepare({candidate}) {
      const found = await adapter.detect(candidate)
      if (found.identity !== candidate.identity || found.status !== candidate.status) throw new Error('原生身份已变化')
      return { ...found, source:candidate.source }
    },
  }
  const app = new Workspace({root:join(root,'workbench'),adapters:{antigravity:adapter},
    discoverySources:()=>[shared],locate:async (_key,source)=>({source,bin:'/test/agy'})})
  t.after(async () => { await app.close(); await rm(root,{recursive:true,force:true}) })
  const scan = source => app.handle('detect',{provider:'antigravity',source})
  const login = p => app.handle('login',{provider:'antigravity',...p})
  const submit = c => app.handle('import',{candidateIds:[c.candidateId]})
  return {app, root, probes, privateLogins, previous, shared, adapter, scan, login, submit, authorize(email){authorizeAs=email}, history(email,state='unknown'){previous=email;externalState=state} }
}

test('a fresh workspace discovers external configuration, then binds the selected Google account', async t => {
  const {app,scan,login,submit,shared,previous,probes} = await setup(t)
  const [fresh] = await scan()
  assert.equal(fresh.source,shared)
  assert.equal(fresh.sourceKind,'desktop')
  assert.equal(fresh.email,previous)
  assert.equal(fresh.loginState,'unknown')
  assert.ok(fresh.requiresAuthorization)
  await assert.rejects(submit(fresh),/授权/)
  assert.equal(app.snapshot().accounts.length,0)
  assert.ok(probes.every(p => !p.managed))
  const result = await login({candidateId:fresh.candidateId})
  const account = app.db.account(result)
  assert.equal(account.origin,shared)
  assert.notEqual(account.source,shared)
  assert.equal(account.status,'ready')
})

test('only external sources appear, repeat import rechecks the identity and keeps the bound profile, Bot and thread', async t => {
  const {app, root, login, scan, submit, shared, authorize, previous, probes} = await setup(t)
  const bound = await login()
  const profile = app.db.account(bound).source
  app.db.run("UPDATE accounts SET info=json_set(info,'$.cwd','/project','$.model','saved-model') WHERE id=?",bound)
  const bot = await app.handle('createBot',{name:'work',accountId:bound})
  const chat = await app.handle('createChat',{kind:'direct',members:[bot]})
  app.db.run('INSERT INTO threads VALUES(?,?,?,?,?)',chat,bot,bound,'existing-native-session',profile)
  app.db.run('UPDATE accounts SET note=? WHERE id=?','my note',bound)
  authorize('second@example.test')
  await login()
  probes.length = 0
  const all = await scan()
  assert.equal(all.length,1)
  const [current] = all
  assert.equal(current.existingAccountId,bound)
  assert.equal(current.source,shared)
  assert.equal(current.email,previous)
  assert.equal(current.loginState,'unknown')
  assert.equal(current.status,'blocked')
  assert.equal(current.plan,undefined)
  assert.equal(current.canReuseBinding,true)
  assert.ok(probes.every(p => p.source === shared && !p.managed))
  assert.ok(!JSON.stringify(current).includes(profile))
  assert.deepEqual(await submit(current),[bound])
  for (const [key,value] of Object.entries({source:profile,origin:shared,cwd:'/project',model:'saved-model',note:'my note'}))
    assert.equal(app.db.account(bound)[key],value)
  assert.equal(app.bot(bot).accountId,bound)
  assert.equal(app.db.get('SELECT threadId FROM threads WHERE botId=?',bot).threadId,'existing-native-session')
  assert.equal(app.snapshot().accounts.length,2)
  await assert.rejects(scan(profile),/原生配置/)
  await assert.rejects(scan(join(app.root,'workspaces','untrusted','.gemini','antigravity-cli')),/原生配置/)
  await assert.rejects(scan(join(app.accounts.appDirectories.at(-1),'profiles','external')),/原生配置/)
  const link=join(root,'link-to-private')
  await symlink(profile,link)
  await assert.rejects(scan(link),/原生配置/)
})

test('matching a local label never certifies a private login, and stale selection cannot replace a Bot', async t => {
  const {app,login,scan,submit,privateLogins,shared,previous,history} = await setup(t)
  const id = await login()
  const [old] = await scan(shared)
  const profile = app.db.account(id).source
  privateLogins.delete(profile)
  await assert.rejects(submit(old),/授权|核验/)
  privateLogins.set(profile,'another@example.test')
  await assert.rejects(submit(old),/授权|不符/)
  assert.equal(app.db.account(id).identity,'google:' + previous)
  privateLogins.set(profile,previous)
  history('new@example.test')
  await assert.rejects(submit(old),/变化|重新检测/)
  await assert.rejects(login({candidateId:old.candidateId}),/变化|重新检测/)
  const [fresh] = await scan()
  assert.equal(fresh.existingAccountId,undefined)
  assert.equal(fresh.email,'new@example.test')
  history(previous,'signed-out')
  const [signedOut] = await scan()
  assert.ok(!signedOut.canReuseBinding)
  await assert.rejects(submit(signedOut),/授权/)
  history(previous)
  await app.handle('removeAccount',{id})
  await assert.rejects(submit(old),/移除|变化|重新检测/)
  assert.equal(app.snapshot().accounts.length,0)
})

test('authorizing an external hint checks the native identity and preserves a legacy Bot reference', async t => {
  const {app,login,scan,previous,authorize} = await setup(t)
  const [hint] = await scan()
  authorize('different@example.test')
  await assert.rejects(login({candidateId:hint.candidateId}),/邮箱|身份/)
  assert.equal(app.snapshot().accounts.length,0)
  // Historical versions allowed storing a blocked source before authorizing.
  const id = await app.accounts.adopt(hint)
  const bot = await app.handle('createBot',{accountId:id,name:'old'})
  const [existing] = await scan()
  assert.equal(existing.existingAccountId,id)
  authorize(previous)
  assert.equal(await login({candidateId:existing.candidateId}),id)
  assert.equal(app.bot(bot).accountId,id)
  assert.equal(app.db.account(id).status,'ready')
  assert.equal(app.snapshot().accounts.length,1)
})

test('a different desktop label cannot transfer a legacy Bot to the new Google account', async t => {
  const {app,login,scan,submit,history,authorize,previous} = await setup(t)
  const [a] = await scan()
  const first = await app.accounts.adopt(a)
  const bot = await app.handle('createBot',{accountId:first,name:'original'})
  history('second@example.test')
  authorize('second@example.test')
  const [b] = await scan()
  assert.equal(b.existingAccountId,undefined)
  await assert.rejects(submit(b),/授权/)
  const second=await login({candidateId:b.candidateId})
  assert.notEqual(first,second)
  assert.equal(app.db.account(first).email,previous)
  assert.equal(app.db.account(first).status,'blocked')
  assert.equal(app.bot(bot).accountId,first)
  assert.equal(app.db.account(second).email,'second@example.test')
  assert.equal(app.db.account(second).status,'ready')
})

test('only the matching authorization window can cancel a candidate login', async t => {
  const {app,scan,login,adapter} = await setup(t)
  let opened
  const started = new Promise(resolve => { opened=resolve })
  adapter.login=async ({signal}) => {
    opened()
    await new Promise((_,reject) => signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}))
  }
  const [hint]=await scan()
  const pending=login({candidateId:hint.candidateId,requestId:'first-window'})
  await started
  assert.equal(app.accounts.cancelLogin({requestId:'old-window'}),false)
  assert.equal(app.accounts.cancelLogin({requestId:'first-window'}),true)
  await assert.rejects(pending,/已取消本次授权/)
  assert.equal(app.accounts.cancelLogin({requestId:'first-window'}),false)
  assert.equal(app.snapshot().accounts.length,0)
})

test('file-backed agy import verifies a private copy and repeat import keeps the existing account and sessions', async t => {
  const {root,app,scan,submit,adapter} = await setup(t)
  const source = join(root, 'external-cli')
  const alias = join(root, 'alias-cli')
  await mkdir(source)
  await symlink(source,alias)
  app.accounts.discoverySources = async () => [source, alias]
  const found = {email:'cli@example.test', identity:'google:cli@example.test', status:'ready',
    sourceKind:'cli', loginState:'signed-in', plan:'pro', model:'native-default', requiresAuthorization:false}
  const prepared = []
  const privateLogins = new Map()
  let failMigration = false
  adapter.detect = async ({source,managed}) => managed ? privateLogins.get(source) : {...found}
  adapter.prepare = async ({candidate,profile,existing,threadIds}) => {
    if (candidate.managed) assert.equal(profile,candidate.source)
    else {
      assert.equal(candidate.source,source)
      assert.notEqual(profile,candidate.source)
    }
    prepared.push({profile,managed:!!candidate.managed,previous:existing?.id,threadIds})
    if (failMigration) throw new Error('原生会话迁移失败')
    privateLogins.set(profile,{...found})
    return {...found,source:profile,managed:true}
  }
  adapter.login = async () => assert.fail('a portable verified source does not need OAuth again')
  const first = await scan()
  assert.equal(first.length,1)
  assert.equal(first[0].requiresAuthorization,false)
  const [id] = await submit(first[0])
  const initial = app.db.account(id).source
  const bot = await app.handle('createBot',{name:'cli',accountId:id})
  const chat = await app.handle('createChat',{kind:'direct',members:[bot]})
  app.db.run('INSERT INTO threads VALUES(?,?,?,?,?)',chat,bot,id,'native-thread',root)
  const [repeat] = await scan()
  assert.equal(repeat.source,source)
  assert.equal(repeat.existingAccountId,id)
  assert.deepEqual(await submit(repeat),[id])
  assert.equal(app.db.account(id).origin,source)
  assert.equal(app.db.account(id).model,found.model)
  assert.deepEqual(prepared,[{profile:initial,managed:false,previous:undefined,threadIds:[]},
    {profile:initial,managed:true,previous:id,threadIds:['native-thread']}])
  assert.equal(app.db.get('SELECT threadId FROM threads WHERE chatId=?',chat).threadId,'native-thread')
  assert.equal(app.snapshot().accounts.length,1)
  // A plan change requires verification in a fresh home. A failed move must preserve the old binding.
  app.db.run("UPDATE accounts SET info=json_set(info,'$.cwd','/saved/project') WHERE id=?",id)
  found.plan='ultra'
  delete found.model
  failMigration=true
  await assert.rejects(submit(repeat),/迁移失败/)
  const failed = prepared.at(-1).profile
  assert.notEqual(failed,initial)
  await assert.rejects(access(failed),{code:'ENOENT'})
  await access(initial)
  assert.equal(app.db.account(id).source,initial)
  failMigration=false
  assert.deepEqual(await submit(repeat),[id])
  const recovered=app.db.account(id)
  assert.notEqual(recovered.source,initial)
  await assert.rejects(access(initial),{code:'ENOENT'})
  assert.equal(recovered.model,'native-default')
  assert.equal(recovered.cwd,'/saved/project')
  assert.equal(recovered.origin,source)
  assert.equal(recovered.plan,'ultra')
  assert.deepEqual(prepared.at(-1).threadIds,['native-thread'])
  assert.equal(app.bot(bot).accountId,id)
  const [refreshed] = await scan()
  found.email='different@example.test'
  found.identity='google:'+found.email
  await assert.rejects(submit(refreshed),/变化|重新检测/)
  const [different] = await scan()
  adapter.prepare = async () => ({...found,source,managed:false})
  await assert.rejects(submit(different),/独立/)
  assert.equal(app.snapshot().accounts.length,1)
})

test('non-personal CLI settings remain blocked and cannot initiate OAuth via a detected candidate', async t => {
  const {app,scan,submit,login,adapter} = await setup(t)
  adapter.detect = async () => ({status:'blocked',sourceKind:'cli',requiresAuthorization:false,
    reason:'此来源未使用个人 Google OAuth。'})
  const [item] = await scan()
  assert.equal(item.requiresAuthorization,false)
  assert.equal(item.canReuseBinding,false)
  await assert.rejects(login({candidateId:item.candidateId}),/不支持/)
  await assert.rejects(submit(item))
  assert.equal(app.snapshot().accounts.length,0)
})

test('a normalized CLI subdirectory that resolves into a BoTeam workspace is excluded before native sign-in checks', async t => {
  const {app,adapter,root,scan} = await setup(t)
  const selection = join(root,'external-home')
  const internalGemini = join(app.root,'private-data','.gemini')
  await mkdir(join(internalGemini,'antigravity-cli'),{recursive:true})
  await mkdir(selection)
  await symlink(internalGemini,join(selection,'.gemini'))
  let inspected = false
  adapter.detect = async ({source,checkExternalSource}) => {
    await checkExternalSource(join(source,'.gemini','antigravity-cli'))
    inspected = true
    return {status:'ready',identity:'unreachable'}
  }
  await assert.rejects(scan(selection),/原生配置/)
  app.accounts.discoverySources = () => [selection]
  assert.deepEqual(await scan(),[])
  assert.equal(inspected,false)
})

test('a source that disappears during Google authorization cannot be committed as an external import', async t => {
  const {app, login, scan, adapter} = await setup(t)
  const originalDetect = adapter.detect, originalLogin = adapter.login
  let present = true
  adapter.detect = async options => options.managed ? originalDetect(options) : {
    sourceKind:'desktop', identity:'source:native-desktop', status:'blocked', configFound:present,
    requiresAuthorization: true, loginState:'unknown',
  }
  adapter.login = async options => { await originalLogin(options); present=false }
  const [source] = await scan()
  assert.equal(source.configFound,true)
  await assert.rejects(login({candidateId:source.candidateId}),/变化|重新检测/)
  assert.equal(app.snapshot().accounts.length,0)
})
