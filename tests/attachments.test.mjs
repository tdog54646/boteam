import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { Database } from '../desktop/database.mjs'
import { AttachmentStore } from '../desktop/attachments.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'boteam-attachments-'))
  let db = new Database(root)
  let store = new AttachmentStore(root, db)
  db.run("INSERT INTO bots(id,name,accountId,cwd) VALUES('b','Bot','account','')")
  for (const chatId of ['first', 'second']) {
    db.run('INSERT INTO chats VALUES(?,?,?,?)', chatId, 'direct', '聊天', '')
    db.run('INSERT INTO members VALUES(?,?)', chatId, 'b')
    db.run("INSERT INTO messages(id,chatId,author,name,text,createdAt,recipients) VALUES(?,?,'user','我','','','[]')", chatId + '-msg', chatId)
  }
  t.after(async () => {
    db.db.close()
    await rm(root, { recursive: true, force: true })
  })
  return {
    root, get store() { return store }, snapshot() { return db.snapshot() },
    restart() {
      db.db.close()
      db = new Database(root)
      store = new AttachmentStore(root, db)
    },
    claim(chatId, ids, homeBotId = null) {
      return db.transaction(() => store.claim({chatId, messageId: chatId + '-msg', ids, homeBotId}))
    },
  }
}

test('picker snapshots survive source removal and restart and retain the selected display names', async (t) => {
  const f = await fixture(t)
  const source = join(f.root, '额度 计划.md')
  await writeFile(source, 'first edition\nhello')
  const second = join(f.root, 'image.bin')
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  await writeFile(second, png)
  const added = await f.store.pick('first', async () => [source, second])
  assert.deepEqual(added.map(a => [a.name,a.size,a.kind]), [['额度 计划.md',19,'file'],['image.bin',16,'file']])
  assert.deepEqual(Object.keys(added[0]).sort(), ['id','kind','name','size'])
  await rm(source)
  await writeFile(second, 'replacement')
  f.restart()
  assert.deepEqual(f.store.list('first'), added)
  const { context, attachments } = f.claim('first', added.map(a => a.id))
  assert.ok(context.includes('first edition'))
  assert.ok(context.includes('额度 计划.md'))
  assert.ok(context.includes(attachments[1].path))
  assert.ok(attachments.every(a => isAbsolute(a.path)))
  assert.equal(await readFile(attachments[0].path, 'utf8'), 'first edition\nhello')
  assert.deepEqual(await readFile(attachments[1].path), png)
  assert.equal(attachments[1].mimeType, 'image/png')
  assert.equal((await stat(attachments[0].path)).mode & 0o077, 0)
  f.restart()
  assert.deepEqual(f.store.list('first'), [])
  assert.equal(await readFile(attachments[0].path, 'utf8'), 'first edition\nhello')
})

test('mixed file and folder selections preserve the tree, exclusions and draft across restart', async (t) => {
  const f = await fixture(t)
  const project = join(f.root, '小项目')
  const source = join(f.root, 'loose.txt')
  await writeFile(source, 'another file')
  await mkdir(join(project, 'src', 'empty'), { recursive: true })
  await writeFile(join(project, 'src', 'page.js'), 'original source')
  for (const ignored of ['.git', 'node_modules', '.ssh']) {
    await mkdir(join(project, ignored))
    await writeFile(join(project, ignored, 'private'), 'omitted')
  }
  for (const secret of ['.env', 'private.pem', 'credentials.json', 'id_ed25519']) {
    await writeFile(join(project, secret), 'omitted')
  }
  await symlink(source, join(project, 'alias'))
  await symlink(project, join(project, 'cycle'))
  const added = await f.store.pick('first', async () => [source, project])
  assert.deepEqual(added.map(file => file.kind), ['file', 'folder'])
  assert.deepEqual([added[1].name, added[1].size, added[1].fileCount, added[1].skippedCount],
    ['小项目', 15, 1, 9])
  await rm(project, { recursive: true })
  f.restart()
  assert.deepEqual(f.store.list('first'), added)
  assert.throws(() => f.claim('second', [added[1].id]))
  const { context, attachments } = f.claim('first', added.map(a => a.id))
  const folder = attachments[1]
  assert.equal(folder.kind, 'folder')
  assert.ok(isAbsolute(folder.path))
  assert.deepEqual(await readdir(folder.path), ['src'])
  assert.deepEqual(await readdir(join(folder.path, 'src', 'empty')), [])
  assert.equal(await readFile(join(folder.path, 'src', 'page.js'), 'utf8'), 'original source')
  assert.match(context, /src\/page\.js/)
  assert.match(context, /original source/)
  assert.ok(context.includes(folder.path))
  assert.doesNotMatch(context, /omitted/)
  f.restart()
  assert.deepEqual(f.snapshot().messages.find(m => m.id === 'first-msg').attachments, added)
})

test('oversized folders roll back the complete selection and can be retried after reducing size', async (t) => {
  const f = await fixture(t)
  const folder = join(f.root, 'project')
  await mkdir(folder)
  const file = join(folder, 'large.bin')
  await writeFile(file, '')
  await truncate(file, 65 * 1024 * 1024)
  await assert.rejects(f.store.pick('first', async () => [folder]), /64 MiB/)
  assert.deepEqual(await readdir(join(f.root, 'attachments')), [])
  await truncate(file, 0)
  const [added] = await f.store.pick('first', async () => [folder])
  await f.store.remove('first', added.id)
  assert.deepEqual(f.store.list('first'), [])
  assert.deepEqual(await readdir(join(f.root, 'attachments')), [])
})

test('a replaced nested folder cannot supply inline content from outside its staged copy', async (t) => {
  const f = await fixture(t)
  const project = join(f.root, 'project')
  await mkdir(join(project, 'docs'), { recursive: true })
  await writeFile(join(project, 'docs', 'note'), 'hello')
  const [added] = await f.store.pick('first', async () => [project])
  const copied = join(f.root, 'attachments', added.id, 'project', 'docs')
  await rm(copied, { recursive: true })
  await symlink(join(project, 'docs'), copied)
  assert.throws(() => f.claim('first', [added.id]), /副本|快照/)
  assert.deepEqual(f.store.list('first'), [added])
})

test('cross-chat IDs, malformed byte payloads, and committed IDs cannot be reused or removed', async (t) => {
  const f = await fixture(t)
  const [file, snippet] = await f.store.add('first', [
    { name: '../../evil\nfile.bin', bytes: new Uint8Array([0, 37, 255]).buffer },
    { name: '片段.txt', text: '多行\n输入' },
  ])
  assert.doesNotMatch(file.name, /[\\/\r\n]/)
  assert.equal(snippet.kind, 'text')
  assert.equal(snippet.size, Buffer.byteLength('多行\n输入'))
  assert.throws(() => f.claim('second', [file.id]))
  await assert.rejects(async () => f.store.remove('second', file.id))
  await assert.rejects(f.store.add('first', [{name: 'auth.json', path: '/private/path'}]))
  await assert.rejects(f.store.add('no-chat', [{name:'snippet.txt',text:'x'}]))
  const ctx = f.claim('first', [file.id,snippet.id])
  assert.deepEqual(await readFile(ctx.attachments[0].path), Buffer.from([0, 37, 255]))
  assert.ok(ctx.context.includes('多行'))
  assert.throws(() => f.claim('first', [file.id]))
  await assert.rejects(async () => f.store.remove('first', file.id))
  assert.equal((await stat(ctx.attachments[0].path)).size, 3)
})

test('cancelling and failed multi-file imports leave no partial drafts and removing a chip releases its bytes', async (t) => {
  const f = await fixture(t)
  assert.deepEqual(await f.store.pick('first', async () => []), [])
  const source = join(f.root,'input.txt')
  await writeFile(source, 'sample')
  await assert.rejects(f.store.pick('first', async () => [source, f.root]))
  assert.deepEqual(f.store.list('first'), [])
  const [attachment] = await f.store.pick('first', async () => [source])
  await f.store.remove('first', attachment.id)
  assert.deepEqual(f.store.list('first'), [])
  assert.deepEqual(await readdir(join(f.root,'attachments')), [])
})

test('home drafts may only be claimed for the chosen direct bot and partial claim rolls back', async (t) => {
  const f = await fixture(t)
  const [a,b] = await f.store.add('home:b', [{name:'a',text:'a'}, {name:'b',text:'b'}])
  assert.throws(() => f.claim('first', [a.id], 'otherBot'))
  assert.throws(() => f.claim('first', [a.id,'missing'], 'b'))
  assert.deepEqual(f.store.list('home:b').map(x=>x.id), [a.id,b.id])
  f.claim('first', [a.id], 'b')
  assert.deepEqual(f.store.list('home:b').map(x=>x.id), [b.id])
})
