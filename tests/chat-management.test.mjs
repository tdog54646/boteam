import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../desktop/workspace.mjs'

async function fixture(t, respond) {
  const root = await mkdtemp(join(tmpdir(), 'boteam-chat-menu-'))
  const cwd = join(root, 'project')
  await mkdir(cwd)
  const adapter = { async run(task) {
    task.emit({ type: 'identity', value: 'member' })
    task.emit({ type: 'session', value: task.threadId || task.chatId })
    if (respond) await respond(task)
    task.emit({ type: 'text', value: 'answer' })
  } }
  const options = { root, adapters: { claude: adapter } }
  let ws = new Workspace(options)
  t.after(async () => { await ws.close(); await rm(root, { recursive: true, force: true }) })
  ws.db.run("INSERT INTO accounts(id,provider,identity,info) VALUES('acct','claude','member','{\"status\":\"ready\"}')")
  const bot = await ws.handle('createBot', { accountId:'acct', name:'member', cwd })
  const chatId = await ws.handle('createChat', { kind: 'direct', members:[bot] })
  return { get ws(){ return ws }, root, cwd, bot, chatId,
    call: (method, payload) => ws.handle(method, {chatId, ...payload}),
    async restart(){ await ws.close(); ws = new Workspace(options) },
    chat(id=chatId) { return ws.snapshot().chats.find(c=>c.id===id) },
  }
}

test('chat flags, section placement, archive and restore survive restart and moving home clears a pin', async t => {
  const f = await fixture(t)
  assert.equal(f.chat().pinned, false)
  assert.equal(f.chat().sectionId, null)
  await f.call('renameChat',{name:'  rename  '})
  await f.call('setChatUnread',{unread:true})
  const sectionId = await f.call('createChatSection',{name:' Design '})
  assert.deepEqual(f.ws.snapshot().chatSections.map(s=>({...s})), [{id:sectionId,name:'Design'}])
  await assert.rejects(f.call('createChatSection',{name:'design'}), /同名/)
  await assert.rejects(f.call('renameChat',{name:' '}))
  await assert.rejects(f.call('moveChatToSection',{sectionId:'missing'}))
  await assert.rejects(f.call('setChatPinned',{pinned:'yes'}))
  await f.call('setChatPinned',{pinned:true})
  await f.call('setChatArchived',{archived:true})
  await f.restart()
  const { name, pinned, unread, archived } = f.chat()
  assert.deepEqual({ name, pinned, unread, archived },{name:'rename',pinned:true,unread:true,archived:true})
  assert.equal(f.chat().sectionId, sectionId)
  await assert.rejects(f.call('send',{recipients:[f.bot],text:'test'}), /归档/)
  await f.call('setChatArchived',{archived:false})
  await f.call('setChatUnread',{unread:false})
  await f.call('moveChatToSection',{sectionId:null})
  assert.equal(f.chat().pinned, false)
  assert.equal(f.chat().sectionId, null)
})

test('deletion and archiving wait for running tasks and cancelled native cleanup', async t => {
  const start = Promise.withResolvers(), stop = Promise.withResolvers()
  const f = await fixture(t, async () => { start.resolve(); await stop.promise })
  await f.call('send',{recipients:[f.bot],text:'pending'})
  await start.promise
  try {
    await assert.rejects(f.call('deleteChat'),/任务/)
    await assert.rejects(f.call('setChatArchived',{archived:true}),/任务/)
    await f.call('cancel',{taskId:f.ws.snapshot().tasks[0].id})
    await assert.rejects(f.call('deleteChat'),/任务/)
  } finally { stop.resolve() }
  await Promise.all(f.ws.lanes.values())
  await f.call('deleteChat')
  assert.equal(f.chat(),undefined)
})
