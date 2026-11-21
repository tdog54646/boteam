import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Workspace } from '../desktop/workspace.mjs'
import { Database } from '../desktop/database.mjs'

async function fixture(t, overrides = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'boteam-projects-')))
  const root = join(dir, 'app-data'), a = join(dir, 'api'), b = join(dir, 'web')
  await Promise.all([mkdir(a), mkdir(b)])
  const calls = [], opened = [], revealed = []
  const adapter = { async run(scope) {
    calls.push(scope)
    scope.emit({ type: 'identity', value: 'local', key: 'local' })
    scope.emit({ type: 'session', value: scope.threadId || scope.chatId + '/' + scope.bot.id })
    scope.emit({ type: 'text', value: 'done' })
  } }
  const options = { root, adapters: { claude: adapter }, openProjectDirectory: async directory => opened.push(directory),
    revealProjectDirectory: directory => revealed.push(directory), ...overrides }
  let ws = new Workspace(options)
  t.after(async () => { await ws.close(); await rm(dir, { recursive: true, force: true }) })
  ws.db.run("INSERT INTO accounts(id,provider,identity,info) VALUES ('a','claude','local','{\"status\":\"ready\"}')")
  const bots = []
  for (const name of ['Alice', 'Bob']) bots.push(await ws.handle('createBot', { accountId:'a', name, cwd:a }))
  return { dir, root, a, b, bots, calls, opened, revealed,
    get ws() { return ws }, snapshot: () => ws.snapshot(),
    call: (method, p) => ws.handle(method, p),
    async restart() { await ws.close(); ws = new Workspace(options) },
  }
}

test('project sources are verified, canonical, ordered and persistent; opening a source uses the registered path', async t => {
  const f = await fixture(t)
  const alias = join(f.dir, 'alias')
  await symlink(f.a, alias, 'dir')
  const projectId = await f.call('createProject', { folders:[alias,f.a,f.b] })
  const project = () => f.snapshot().projects.find(p => p.id === projectId)
  assert.deepEqual(project(), { id:projectId, name:'api', folders:[f.a,f.b], pinned:false, sectionId:null })
  await f.call('revealProjectFolder',{projectId})
  for (const folder of ['relative', join(f.dir,'missing')]) {
    await assert.rejects(f.call('updateProject',{projectId, name:'should roll back', folders:[folder]}))
    assert.equal(project().name,'api')
  }
  await assert.rejects(f.call('updateProject',{projectId,folders:[]}))
  const expected = {name:'api',folders:[f.a,f.b]}
  await f.call('setProjectPinned',{projectId,pinned:true})
  await f.call('updateProject',{projectId,expected,folders:[f.b,f.a]})
  await assert.rejects(f.call('updateProject',{projectId,expected,name:'Stale'}),/其他窗口/)
  assert.equal(project().name,'api')
  await f.call('updateProject',{projectId,name:'Product'})
  await assert.rejects(f.call('updateProject',{projectId,expected:{name:'api',folders:[f.b,f.a]},folders:[f.a]}),/其他窗口/)
  await f.restart()
  assert.deepEqual(project(), {id:projectId,name:'Product',folders:[f.b,f.a],pinned:true,sectionId:null})
  await f.call('revealProjectFolder',{projectId,folder:f.dir})
  await f.call('openProjectFolder',{projectId,folder:f.b})
  await assert.rejects(f.call('openProjectFolder',{projectId,folder:f.dir}))
  await rm(f.b,{recursive:true})
  await symlink(f.root,f.b,'dir')
  await assert.rejects(f.call('openProjectFolder',{projectId,folder:f.b}))
  await assert.rejects(f.call('revealProjectFolder',{projectId}))
  await assert.rejects(f.call('revealProjectFolder',{projectId:'missing'}))
  assert.deepEqual(f.revealed,[f.a,f.b])
  assert.deepEqual(f.opened,[f.b])
})

test('projects move between shared sidebar sections, with atomic creation and persistent pin placement', async t => {
  const f = await fixture(t)
  const projectId = await f.call('createProject', {folders:[f.a]})
  // A workspace saved before project sections did not have the placement column.
  f.ws.db.db.exec('ALTER TABLE projects DROP COLUMN sectionId')
  await f.restart()
  const project = () => f.snapshot().projects.find(p => p.id === projectId)
  assert.equal(project().sectionId,null)
  const sectionId = await f.call('createChatSection',{name:'保留'})
  await f.call('setProjectPinned',{projectId,pinned:true})
  await f.call('moveProjectToSection',{projectId,sectionId})
  assert.equal(project().pinned,false)
  assert.equal(project().sectionId,sectionId)
  for (const pinned of [true,false]) {
    await f.call('setProjectPinned',{projectId,pinned})
    assert.equal(project().sectionId,sectionId)
  }
  const second = await f.call('createChatSection',{name:'新分区',projectId})
  assert.equal(project().sectionId,second)
  await assert.rejects(f.call('createChatSection',{name:'新分区',projectId}),/同名/)
  await assert.rejects(f.call('createChatSection',{name:'孤立',projectId:'missing'}),/项目/)
  await assert.rejects(f.call('moveProjectToSection',{projectId,sectionId:'missing'}),/分区/)
  await f.restart()
  assert.equal(f.snapshot().chatSections.length,2)
  assert.equal(project().sectionId,second)
  await f.call('setProjectPinned',{projectId,pinned:true})
  await f.call('moveProjectToSection',{projectId,sectionId:null})
  assert.equal(project().sectionId,null)
  assert.equal(project().pinned,false)
})

test('bulk archiving is scoped, idempotent, and rejects active work or newly added chats without partially archiving', async t => {
  const f = await fixture(t)
  const projectId = await f.call('createProject',{folders:[f.a]})
  const create = p => f.call('createChat',{kind:'direct',members:[f.bots[0]],...p})
  const first = await create({projectId}), second = await create({projectId}), offProject = await create({})
  const expectedChatIds = [first,second]
  const archived = id => f.snapshot().chats.find(c=>c.id===id).archived
  await f.call('setChatPinned',{chatId:first,pinned:true})
  const started = Promise.withResolvers(), stopped = Promise.withResolvers()
  f.ws.adapters.claude.run = async () => { started.resolve(); await stopped.promise }
  await f.call('send',{chatId:second,recipients:[f.bots[0]],text:'still working'})
  await started.promise
  try {
    await assert.rejects(f.call('archiveProjectChats',{projectId}),/任务/)
    assert.equal(archived(first),false)
    await f.call('cancel',{taskId:f.snapshot().tasks[0].id})
    await assert.rejects(f.call('archiveProjectChats',{projectId}),/任务/)
  } finally { stopped.resolve() }
  await Promise.all(f.ws.lanes.values())
  const late = await create({projectId})
  await assert.rejects(f.call('archiveProjectChats',{projectId,expectedChatIds}),/其他窗口/)
  assert.ok([first,second,late].every(id => !archived(id)))
  await f.call('moveChatToProject',{chatId:late,projectId:null})
  await f.call('setChatArchived',{chatId:second,archived:true})
  let notifications = 0
  f.ws.notify = () => { notifications++ }
  assert.equal(await f.call('archiveProjectChats',{projectId,expectedChatIds}),1)
  assert.equal(await f.call('archiveProjectChats',{projectId,expectedChatIds}),0)
  assert.equal(notifications,1)
  await f.restart()
  assert.equal(archived(offProject),false)
  assert.equal(archived(late),false)
  for (const id of [first,second]) assert.equal(archived(id),true)
  assert.equal(f.snapshot().chats.find(c => c.id===first).pinned,true)
  await assert.rejects(f.call('send',{chatId:first,recipients:[f.bots[0]],text:'stale composer'}),/归档/)
  await assert.rejects(f.call('archiveProjectChats',{projectId:'missing'}),/项目/)
})

test('direct and group chat directories are frozen at creation, regardless of moving chats or editing/removing projects', async t => {
  const f = await fixture(t)
  const p = await f.call('createProject',{name:'P',folders:[f.b,f.a]})
  const q = await f.call('createProject',{name:'Q',folders:[f.a]})
  const dm = await f.call('createChat',{kind:'direct',members:[f.bots[0]],projectId:p})
  const group = await f.call('createChat',{kind:'group',name:'G',members:f.bots,projectId:p,folder:f.a})
  const projectOf = id => f.snapshot().chats.find(c=>c.id===id)?.projectId
  const dirs = id => f.ws.chatDirectories(id).map(binding => binding.directory)
  assert.deepEqual(dirs(dm),[f.b]); assert.deepEqual(dirs(group),[f.a])
  await assert.rejects(f.call('createChat',{kind:'direct',members:[f.bots[0]],projectId:p,folder:f.dir}))
  assert.equal(f.snapshot().chats.length,2)
  await f.call('send',{chatId:dm,recipients:[f.bots[0]],text:'at web'})
  await Promise.all(f.ws.lanes.values())
  const branch = await f.call('forkChat',{chatId:dm})
  assert.equal(projectOf(branch),p)
  f.ws.adapters.claude.forkChat = async (_, {destinationChatId}) => ({threadId:'native-'+destinationChatId})
  const native = await f.call('forkChat',{chatId:dm,botId:f.bots[0]})
  assert.equal(projectOf(native),p)
  assert.deepEqual(dirs(native),[f.b])
  const creationOrder = id => f.snapshot().chats.find(chat => chat.id===id).creationOrder
  assert.ok(creationOrder(dm) < creationOrder(group) && creationOrder(group) < creationOrder(native))
  await f.call('moveChatToProject',{chatId:dm,projectId:q})
  assert.equal(projectOf(dm),q); assert.deepEqual(dirs(dm),[f.b])
  await f.call('updateProject',{projectId:p,folders:[f.a]})
  assert.deepEqual(dirs(branch),[f.b])
  await writeFile(join(f.a,'keep.txt'),'keep me')
  await f.call('removeProject',{projectId:p})
  await f.restart()
  assert.equal(projectOf(group),null); assert.equal(projectOf(branch),null)
  assert.deepEqual(dirs(group),[f.a]); assert.deepEqual(dirs(branch),[f.b])
  await f.call('send',{chatId:dm,recipients:[f.bots[0]],text:'same session'})
  await Promise.all(f.ws.lanes.values())
  assert.equal(f.calls.at(-1).cwd,f.b)
  assert.equal(f.calls.at(-1).threadId,dm+'/'+f.bots[0])
  assert.equal(await readFile(join(f.a,'keep.txt'),'utf8'),'keep me')
  await f.call('moveChatToProject',{chatId:dm,projectId:null})
  assert.equal(projectOf(dm),null)
  assert.equal(f.snapshot().chats.length,4)
})

test('legacy conversations sharing external working directories import once, private and managed paths stay out', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(),'boteam-legacy-projects-')))
  t.after(() => rm(dir,{recursive:true,force:true}))
  const root=join(dir,'data'), external=join(dir,'project'), subdir=join(external,'src'), other=join(dir,'other'), secrets=join(dir,'private-profile')
  const db = new Database(root)
  const managed = join(root,'workspaces','managed')
  for (const folder of [subdir,other,secrets,managed]) await mkdir(folder,{recursive:true})
  db.run('INSERT INTO accounts(id,provider,identity,info) VALUES(?,?,?,?)','a','claude','legacy',JSON.stringify({source:secrets}))
  for (const [id,cwd] of [['one',external],['two',subdir],['three',other],['detached',external],['managed',managed],['private',secrets],['empty','']]) {
    db.run('INSERT INTO bots(id,name,cwd,accountId) VALUES(?,?,?,?)',id,id,cwd,'a')
    db.run('INSERT INTO chats VALUES(?,?,?,?)',id,'direct',id,'old')
    db.run('INSERT INTO members VALUES(?,?)',id,id)
  }
  db.run('INSERT INTO threads VALUES(?,?,?,?,?)','three','three','a','old-thread',external)
  for (const member of ['empty','private','managed']) {
    const id = 'mixed-'+member
    db.run('INSERT INTO chats VALUES(?,?,?,?)',id,'group',id,'old')
    db.run('INSERT INTO members VALUES(?,?)',id,'one')
    db.run('INSERT INTO members VALUES(?,?)',id,member)
  }
  db.db.close()
  let ws = new Workspace({ root, adapters:{} })
  t.after(()=>ws.close())
  assert.equal(ws.snapshot().projects.length,0)
  await ws.handle('moveChatToProject',{chatId:'detached',projectId:null})
  await ws.handle('createProject',{folders:[other]})
  const [project]=ws.snapshot().projects
  assert.ok(ws.snapshot().chats.every(c=>c.projectId===null))
  await ws.handle('updateProject',{projectId:project.id,folders:[other,external]})
  for (const c of ws.snapshot().chats) assert.equal(c.projectId, ['one','two','three'].includes(c.id) ? project.id : null)
  await ws.handle('removeProject',{projectId:project.id})
  await ws.close(); ws=new Workspace({root,adapters:{}})
  assert.deepEqual(ws.snapshot().projects,[])
  assert.ok(ws.snapshot().chats.every(c=>c.projectId===null))
  await ws.handle('createProject',{folders:[external,managed,secrets]})
  assert.ok(ws.snapshot().chats.every(c=>c.projectId===null))
})

test('an initial project switches the actual member directories and survives restart; removing it restores member defaults', async t => {
  const f = await fixture(t)
  const projectId = await f.call('createProject',{folders:[f.b,f.a]})
  await f.call('editBot',{id:f.bots[1],name:'Bob',cwd:''})
  const chatId = await f.call('createChat',{kind:'group',members:f.bots})
  const current = () => f.snapshot().chats.find(c => c.id===chatId)
  const set = (projectId,expected={}) => f.call('setInitialChatProject',{chatId,projectId,...expected})
  const directories = () => f.ws.chatDirectories(chatId).map(row => row.directory)
  const defaults = directories()
  assert.deepEqual(defaults,[f.a,join(f.root,'workspaces',chatId)])
  assert.equal(current().canSelectInitialProject,true)
  assert.equal(current().initialProjectCwd,null)
  await assert.rejects(set(undefined))
  await assert.rejects(set('missing'))
  assert.deepEqual(await set(projectId,{expectedProjectId:null}),{projectId,cwd:f.b})
  assert.deepEqual(directories(),[f.b])
  await f.restart()
  assert.equal(current().initialProjectCwd,f.b)
  await assert.rejects(set(null,{expectedProjectId:null}),/其他窗口/)
  await f.call('updateProject',{projectId,folders:[f.a,f.b]})
  assert.deepEqual(directories(),[f.b])
  assert.deepEqual(await set(projectId),{projectId,cwd:f.a})
  await assert.rejects(set(null,{expectedProjectCwd:f.b}),/其他窗口/)
  assert.deepEqual(await set(null),{projectId:null,cwd:null})
  assert.deepEqual(directories(),defaults)
  const outside = await f.call('createChat',{kind:'direct',members:[f.bots[0]],projectId:null})
  await f.call('createProject',{folders:[f.a]})
  assert.equal(current().projectId,null)
  assert.equal(f.snapshot().chats.find(chat => chat.id === outside).projectId,null)
  await f.call('setChatArchived',{chatId,archived:true})
  assert.equal(current().canSelectInitialProject,false)
  await assert.rejects(set(projectId))
  await f.call('setChatArchived',{chatId,archived:false})
  await f.call('send',{chatId,text:'start',recipients:f.bots})
  assert.equal(current().canSelectInitialProject,false)
  await assert.rejects(set(projectId))
  await Promise.all(f.ws.lanes.values())
  await f.call('moveChatToProject',{chatId,projectId})
  assert.deepEqual(directories(),defaults)
  await assert.rejects(set(null))
})

test('importing a project binds the requesting empty chat before legacy adoption or rolls the entire import back', async t => {
  const f = await fixture(t)
  const create = () => f.call('createChat',{kind:'direct',members:[f.bots[0]]})
  const chatId = await create(), legacy = await create()
  const info = id => f.snapshot().chats.find(chat => chat.id===id)
  const initialChat = {chatId,expectedProjectId:null,expectedProjectCwd:null}
  const projectId = await f.call('createProject',{folders:[f.a],initialChat})
  assert.equal(info(chatId).projectId,projectId)
  assert.equal(info(chatId).initialProjectCwd,f.a)
  assert.equal(info(legacy).projectId,projectId)
  assert.equal(info(legacy).initialProjectCwd,null)
  const unclaimed = await create()
  await assert.rejects(f.call('createProject',{folders:[f.b,f.a],initialChat}),/其他窗口/)
  assert.deepEqual(f.snapshot().projects.map(p => p.id),[projectId])
  assert.equal(info(chatId).initialProjectCwd,f.a)
  assert.equal(info(unclaimed).projectId,null)
  assert.deepEqual(f.ws.db.all('SELECT path FROM project_folders').map(row=>row.path),[f.a])
})
