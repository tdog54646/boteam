import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Database } from '../desktop/database.mjs'
import { exportWorkspaceBackup, stageWorkspaceRestore, applyWorkspaceRestore, readStorageUsage } from '../desktop/settings-data.mjs'

test('portable backup restores data, local verified binding and snapshots without exporting credentials or following links', async t => {
  const root = mkdtempSync(join(tmpdir(), 'boteam-backup-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const from = join(root, 'from'), to = join(root, 'to'), dest = join(root, 'workspace.boteam')
  const source = new Database(from)
  source.run("INSERT INTO accounts VALUES ('account','codex','identity',?,'test')", JSON.stringify({status:'ready',source:'/private/profile',bin:'SECRET-PROVIDER-CONFIG'}))
  source.run("INSERT INTO chats VALUES ('chat','direct','Original',?)", new Date().toISOString())
  const id = '3447f919-ca21-4fc1-b1dc-99de73442ca6'
  source.run("INSERT INTO attachments VALUES (?,'chat','note.txt',4,'file',NULL)", id)
  for (const path of ['attachments/' + id,'workspaces/chat','profiles/credential']) mkdirSync(join(from,path),{recursive:true})
  writeFileSync(join(from,'profiles/credential/token'),'SECRET-PROVIDER-TOKEN')
  writeFileSync(join(from,'attachments',id,'note.txt'),'note')
  writeFileSync(join(from,'workspaces/chat','saved.md'),'page')
  if (process.platform !== 'win32') writeFileSync(join(from,'workspaces/chat','12:30\\notes.md'),'legal filename')
  symlinkSync(join(from,'profiles'),join(from,'workspaces/chat','ignored-link'))
  await exportWorkspaceBackup(from,dest)
  source.db.close()
  const bytes = readFileSync(dest)
  for (const secret of ['SECRET-PROVIDER-CONFIG','SECRET-PROVIDER-TOKEN']) assert.equal(bytes.includes(Buffer.from(secret)),false)
  const target = new Database(to)
  target.run("INSERT INTO accounts VALUES ('local','codex','identity',?,'local')",JSON.stringify({status:'ready',bin:'/locally/verified'}))
  target.run("INSERT INTO chats VALUES ('old','direct','replace','2026')")
  target.db.close()
  await stageWorkspaceRestore(to,dest)
  await applyWorkspaceRestore(to)
  const restored = new Database(to)
  try {
    assert.equal(restored.get("SELECT count(*) AS n FROM chats").n,1)
    assert.equal(restored.get("SELECT name FROM chats").name,'Original')
    assert.equal(restored.account('account').bin,'/locally/verified')
    assert.equal(readFileSync(join(to,'attachments',id,'note.txt'),'utf8'),'note')
    assert.equal(readFileSync(join(to,'workspaces/chat/saved.md'),'utf8'),'page')
    assert.equal(existsSync(join(to,'workspaces/chat/ignored-link')),false)
    if (process.platform !== 'win32') assert.equal(readFileSync(join(to,'workspaces/chat','12:30\\notes.md'),'utf8'),'legal filename')
    assert.equal((await readStorageUsage(to)).attachments,4)
  } finally { restored.db.close() }
  const corrupt = new DatabaseSync(dest)
  corrupt.prepare('UPDATE files SET path=? WHERE path=?').run('../escape','workspaces/chat/saved.md')
  corrupt.close()
  await assert.rejects(() => stageWorkspaceRestore(to,dest))
  assert.equal(existsSync(join(root,'escape')),false)
  assert.equal(readFileSync(join(to,'workspaces/chat/saved.md'),'utf8'),'page')
})

test('failed file installation rolls back both the SQLite database and managed directories', async t => {
  const root = mkdtempSync(join(tmpdir(),'boteam-rollback-test-'))
  t.after(() => rmSync(root,{recursive:true,force:true}))
  const active = join(root,'app'), archive = join(root,'restore.boteam')
  const db = new Database(active)
  db.run("INSERT INTO chats VALUES ('chat','direct','backup','now')")
  mkdirSync(join(active,'workspaces/chat'),{recursive:true})
  writeFileSync(join(active,'workspaces/chat/data'),'backup')
  await exportWorkspaceBackup(active,archive)
  db.run("UPDATE chats SET name='local'")
  writeFileSync(join(active,'workspaces/chat/data'),'local')
  db.db.close()
  await stageWorkspaceRestore(active,archive)
  rmSync(join(active,'.boteam-restore-pending/incoming/workspaces'),{recursive:true})
  await assert.rejects(() => applyWorkspaceRestore(active), /恢复失败/)
  const restored = new Database(active)
  try { assert.equal(restored.get('SELECT name FROM chats').name,'local') } finally { restored.db.close() }
  assert.equal(readFileSync(join(active,'workspaces/chat/data'),'utf8'),'local')
  assert.equal(existsSync(join(active,'.boteam-restore-pending')),false)
})

test('a live workspace backup excludes channel secrets and pauses recovered schedules', async t => {
  const { Workspace } = await import('../desktop/workspace.mjs')
  const root = mkdtempSync(join(tmpdir(),'boteam-channel-backup-'))
  t.after(() => rmSync(root,{recursive:true,force:true}))
  const active = join(root,'active'), backup = join(root,'workspace.boteam')
  const options = {root:active,adapters:{codex:{}}}
  let ws = new Workspace(options)
  try {
    ws.db.run("INSERT INTO accounts VALUES ('a','codex','identity','{}','')")
    ws.db.run("INSERT INTO bots(id,accountId,name,cwd) VALUES ('bot','a','Bot','')")
    ws.db.run("INSERT INTO channels VALUES ('telegram','bot',0,?,'g')",Buffer.from('TEST-CHANNEL-SECRET'))
    ws.db.run("INSERT INTO channel_events VALUES ('telegram','identity','room','test-event',?)",Date.now())
    for (const id of ['changed', 'identical']) {
      ws.insertChat(id,{kind:'direct',members:['bot']})
      ws.db.run('INSERT INTO threads VALUES(?,?,?,?,?)',id,'bot','a','thread-'+id,'/tmp')
    }
    ws.db.run("INSERT INTO channel_keys VALUES ('telegram','token',?)",Buffer.from('TEST-CHANNEL-TOKEN'))
    ws.db.run("INSERT INTO schedules(id,name,prompt,botId,rule,enabled,nextRunAt) VALUES ('job','test','hello','bot',?,1,?)",
      JSON.stringify({frequency:'once',at:Date.now()+86400000}),Date.now()+86400000)
    ws.db.run("INSERT INTO settings VALUES ('notification.completed','on')")
    ws.db.run("INSERT INTO bot_permission_defaults VALUES ('bot','read-only')")
    await exportWorkspaceBackup(active,backup)
    const data = readFileSync(backup)
    for (const secret of ['TEST-CHANNEL-SECRET','TEST-CHANNEL-TOKEN']) assert.equal(data.includes(Buffer.from(secret)),false)
    ws.db.run("INSERT INTO messages(id,chatId,author,name,text,createdAt,recipients) VALUES('after','changed','user','User','After backup','later','[]')")
    await stageWorkspaceRestore(active,backup)
    await ws.close()
    await applyWorkspaceRestore(active)
    ws = new Workspace(options)
    assert.equal(ws.db.get("SELECT enabled FROM schedules WHERE id='job'").enabled,0)
    assert.equal(ws.snapshot().notifications.completed,true)
    assert.equal(ws.db.get("SELECT permission FROM bot_permission_defaults WHERE botId='bot'").permission,'read-only')
    assert.equal(ws.db.get('SELECT count(*) AS n FROM channels').n,0)
    assert.equal(ws.db.get('SELECT event FROM channel_events').event,'test-event')
    assert.deepEqual(ws.db.all('SELECT threadId FROM threads').map(t => t.threadId),['thread-identical'])
  } finally { await ws.close() }
})

test('canceling a backup keeps the previous export and abandons staged recovery', async t => {
  const root = mkdtempSync(join(tmpdir(),'boteam-backup-cancel-'))
  t.after(() => rmSync(root,{recursive:true,force:true}))
  const data = join(root,'data'), backup = join(root,'save.boteam')
  const db = new Database(data)
  try {
    db.run("INSERT INTO chats VALUES ('first','direct','Original','now')")
    await exportWorkspaceBackup(data,backup)
    const original = readFileSync(backup)
    for (let index=0; index<160; index++)
      db.run('INSERT INTO chats VALUES(?,?,?,?)','chat-' + index,'direct','New','now')
    const cancellation = new AbortController()
    cancellation.abort(new Error('canceled'))
    await assert.rejects(() => exportWorkspaceBackup(data,backup,cancellation.signal),/canceled/)
    assert.deepEqual(readFileSync(backup),original)
    await assert.rejects(() => stageWorkspaceRestore(data,backup,() => true,cancellation.signal),/canceled/)
    assert.equal(existsSync(join(data,'.boteam-restore-pending')),false)
    assert.equal(db.get('SELECT count(*) AS n FROM chats').n,161)
  } finally { db.db.close() }
})
