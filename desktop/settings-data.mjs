import { DatabaseSync } from 'node:sqlite'
import { setImmediate as yieldToApp } from 'node:timers/promises'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'

const database = 'workspace.sqlite3'
const folders = ['attachments', 'workspaces']
const sidecars = ['-wal', '-shm', '-journal'].map(suffix => database + suffix)
const pendingName = '.boteam-restore-pending'
const parts = [database, ...sidecars, ...folders]
const chunkSize = 1024 * 1024
const archiveId = 0x42544d31
const supportedTables = new Set((
  'settings accounts bots chats projects project_folders chat_projects chat_sections chat_organization chat_forks ' +
  'members messages tasks subagent_entries threads group_delivery composer_settings context_usage token_metrics ' +
  'pending_chat_goals quota_usage attachments attachment_folders fork_attachments fork_member_context ' +
  'chat_title_requests native_fork_attachments schedules schedule_runs channel_chats channel_deliveries channel_events ' +
  'bot_permission_defaults project_permission_defaults'
).split(' '))
const allowedSetting = key => ['onboarded', 'scheduleLocalZone'].includes(key) || /^notification\./.test(key)
const sqlName = name => '"' + name.replaceAll('"','""') + '"'
const tables = db => db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'").all().map(r => r.name)
const corrupt = () => new Error('备份文件损坏或格式不兼容。')
const optionalStat = path => lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; return null })

function safeAccount(info) {
  const { email, plan, organization } = JSON.parse(info)
  return JSON.stringify({ email, plan, organization, status: 'login', reason: '请重新导入或授权此订阅账号。' })
}

async function diskSize(path, signal) {
  signal?.throwIfAborted()
  const stat = await optionalStat(path)
  if (!stat || stat.isSymbolicLink()) return 0
  if (stat.isFile()) return stat.size
  if (!stat.isDirectory()) return 0
  let bytes = 0
  const children = await readdir(path).catch(error => { if (error.code !== 'ENOENT') throw error; return [] })
  for (const name of children) bytes += await diskSize(join(path, name), signal)
  return bytes
}

export async function readStorageUsage(root, signal) {
  const result = { database: 0, attachments: 0, workspaces: 0, worktrees: 0, profiles: 0, other: 0, total: 0 }
  for (const name of await readdir(root)) {
    const bytes = await diskSize(join(root, name), signal)
    result.total += bytes
    if (name === database || sidecars.includes(name)) result.database += bytes
    else if ([...folders, 'worktrees', 'profiles'].includes(name)) result[name] += bytes
    else result.other += bytes
  }
  return result
}

function safeRelative(path) {
  if (typeof path !== 'string' || path.length > 8192 || path.includes('\0')) return false
  if (process.platform === 'win32' && /[\\:\x00-\x1f<>|"?*]/.test(path)) return false
  return path.split('/').every(part => part && part !== '.' && part !== '..')
}

function safeIdentifier(id) {
  return safeRelative(id) && !/[\\/:\x00-\x1f]/.test(id)
}

async function walkSnapshot(root, path, archive, signal) {
  signal?.throwIfAborted()
  const target = join(root, path)
  const stat = await optionalStat(target)
  if (!stat || stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile())) return
  if (!safeRelative(path) || await realpath(target) !== target) throw new Error('备份期间工作文件路径已变化。')
  const insert = archive.prepare('INSERT INTO files(path,kind,size,digest,executable) VALUES(?,?,?,?,?)')
  if (stat.isDirectory()) {
    insert.run(path, 'directory', 0, '', 0)
    for (const name of await readdir(target)) {
      if (path === 'workspaces' && name === '.catalog') continue
      await walkSnapshot(root, path + '/' + name, archive, signal)
    }
    return
  }
  const put = archive.prepare('INSERT INTO chunks(path,position,bytes) VALUES(?,?,?)')
  const source = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await source.stat()
    if (!before.isFile() || stat.ino !== before.ino || stat.dev !== before.dev) throw new Error('备份期间工作文件已变化。')
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(chunkSize)
    let position = 0
    for (;;) {
      signal?.throwIfAborted()
      const { bytesRead } = await source.read(buffer)
      if (!bytesRead) break
      const data = buffer.subarray(0, bytesRead)
      put.run(path, position, data)
      hash.update(data)
      position += bytesRead
    }
    const after = await source.stat()
    if (position !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error('备份期间工作文件已变化，请在编辑结束后重试。')
    insert.run(path, 'file', position, hash.digest('hex'), before.mode & 0o111 ? 1 : 0)
  } finally { await source.close() }
}

export async function exportWorkspaceBackup(root, destination, signal) {
  root = await realpath(root)
  const parent = await realpath(dirname(destination))
  if (parent === root || parent.startsWith(root + sep)) throw new Error('请选择工作台数据目录以外的备份位置。')
  const temporary = join(parent, '.boteam-export-' + randomUUID())
  const file = await open(temporary, 'wx', 0o600)
  await file.close()
  let source, archive
  try {
    source = new DatabaseSync(join(root, database), { readOnly: true })
    archive = new DatabaseSync(temporary)
    archive.exec(`PRAGMA journal_mode=OFF; PRAGMA application_id=${archiveId}; PRAGMA user_version=1;
      CREATE TABLE metadata(root TEXT NOT NULL);
      CREATE TABLE records(name TEXT NOT NULL, cells TEXT NOT NULL);
      CREATE TABLE files(path TEXT PRIMARY KEY, kind TEXT NOT NULL, size INTEGER NOT NULL, digest TEXT NOT NULL, executable INTEGER NOT NULL);
      CREATE TABLE chunks(path TEXT NOT NULL,position INTEGER NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(path,position));
      BEGIN;`)
    archive.prepare('INSERT INTO metadata VALUES(?)').run(root)
    source.exec('BEGIN')
    const put = archive.prepare('INSERT INTO records VALUES(?,?)')
    let processed = 0
    for (const name of tables(source).filter(name => supportedTables.has(name))) {
      for (const row of source.prepare('SELECT * FROM ' + sqlName(name) + ' ORDER BY rowid').iterate()) {
        if (name === 'accounts') row.info = safeAccount(row.info)
        if (name === 'settings' && !allowedSetting(row.key)) continue
        put.run(name, JSON.stringify(row))
        if (++processed % 128 === 0) {
          await yieldToApp()
          signal?.throwIfAborted()
        }
      }
    }
    for (const path of folders) await walkSnapshot(root, path, archive, signal)
    const storedFile = archive.prepare('SELECT kind,size FROM files WHERE path=?')
    for (const row of source.prepare('SELECT id,name,kind,size FROM attachments').iterate()) {
      const file = storedFile.get(['attachments',row.id,row.name].join('/'))
      if (!file || (row.kind === 'folder' ? file.kind !== 'directory' : file.kind !== 'file' || row.size !== file.size))
        throw new Error('附件快照缺失或正在更改，请检查附件后重试。')
    }
    signal?.throwIfAborted()
    archive.exec('COMMIT')
    archive.close(); archive = null
    await rename(temporary, destination)
  } finally {
    source?.close(); archive?.close()
    await rm(temporary, { force: true })
  }
}

async function unpackFiles(archive, incoming, signal) {
  const chunks = archive.prepare('SELECT position,bytes FROM chunks WHERE path=? ORDER BY position')
  for (const entry of archive.prepare('SELECT * FROM files ORDER BY path').iterate()) {
    signal?.throwIfAborted()
    const { path, kind, size, digest } = entry
    if (!safeRelative(path) || !folders.includes(path.split('/')[0]) || !Number.isSafeInteger(size) || size < 0) throw corrupt()
    const target = join(incoming, path)
    if (kind === 'directory' && !size) { await mkdir(target, {recursive: true, mode: 0o700}); continue }
    if (kind !== 'file' || !path.includes('/')) throw corrupt()
    const output = await open(target,'wx',0o600)
    try {
      let offset = 0
      const hash = createHash('sha256')
      for (const row of chunks.iterate(path)) {
        if (!(row.bytes instanceof Uint8Array) || row.bytes.length > chunkSize || row.position !== offset) throw corrupt()
        signal?.throwIfAborted()
        await output.writeFile(row.bytes)
        offset += row.bytes.length
        hash.update(row.bytes)
      }
      if (offset !== size || hash.digest('hex') !== digest) throw corrupt()
    } finally { await output.close() }
    if (entry.executable === 1) await chmod(target,0o700)
  }
}

// A native thread cannot be rewound. Reuse it only if this installation still
// has the same account binding and the entire local conversation at backup time.
async function sameHistory(source, staged, chatId, signal) {
  let compared = 0
  for (const table of ['messages', 'tasks']) {
    const query = 'SELECT * FROM ' + sqlName(table) + ' WHERE chatId=? ORDER BY rowid'
    const local = source.prepare(query).iterate(chatId), saved = staged.prepare(query).iterate(chatId)
    try {
      while (true) {
        const current = local.next(), expected = saved.next()
        if (current.done !== expected.done) return false
        if (current.done) break
        if (JSON.stringify(current.value) !== JSON.stringify(expected.value)) return false
        if (++compared % 128 === 0) {
          await yieldToApp()
          signal?.throwIfAborted()
        }
      }
    } finally { local.return?.(); saved.return?.() }
  }
  return true
}

// A local database supplies the schema. The backup only supplies scalar field values.
async function loadRecords(source, staged, archive, oldRoot, root, signal) {
  const localTables = tables(staged)
  const localBindings = source.prepare('SELECT info FROM accounts WHERE provider=? AND identity=?')
  const knownThread = source.prepare(`SELECT a.provider,a.identity FROM threads t JOIN accounts a ON a.id=t.accountId
    WHERE t.threadId=? AND t.accountId=? AND t.botId=? AND t.chatId=?`)
  const inserts = new Map()
  let processed = 0
  staged.exec('PRAGMA foreign_keys=OFF; BEGIN')
  for (const { name, cells } of archive.prepare('SELECT name,cells FROM records ORDER BY rowid').iterate()) {
    if (++processed % 128 === 0) {
      await yieldToApp()
      signal?.throwIfAborted()
    }
    if (!supportedTables.has(name) || !localTables.includes(name)) throw corrupt()
    const row = JSON.parse(cells)
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw corrupt()
    for (const key of ['id','botId','chatId','accountId','attachmentId','messageId','projectId','sourceChatId']) {
      if (row[key] != null && (!safeIdentifier(row[key]))) throw corrupt()
    }
    if (name === 'accounts') row.info = localBindings.get(row.provider,row.identity)?.info || safeAccount(row.info)
    if (name === 'settings' && !allowedSetting(row.key)) throw corrupt()
    if (name === 'threads') {
      const known = knownThread.get(row.threadId,row.accountId,row.botId,row.chatId)
      const saved = staged.prepare('SELECT provider,identity FROM accounts WHERE id=?').get(row.accountId)
      if (!known || !saved || known.provider !== saved.provider || known.identity !== saved.identity) continue
    }
    if (name === 'schedules') row.enabled = 0
    if (name === 'tasks' && ['queued','running','approval'].includes(row.status)) {
      row.status = 'interrupted'; row.approval = null
    }
    if (name === 'attachments' && !safeIdentifier(row.name)) throw corrupt()
    if (name === 'attachment_folders' && !JSON.parse(row.entries).every(item => safeRelative(item.path))) throw corrupt()
    for (const key of ['cwd','path']) {
      if (typeof row[key] === 'string' && row[key].startsWith(oldRoot + '/workspaces/')) {
        const rel = row[key].slice(oldRoot.length + 1)
        if (!safeRelative(rel)) throw corrupt()
        row[key] = join(root,rel)
      }
    }
    let insert = inserts.get(name)
    if (!insert) {
      const columns = staged.prepare('PRAGMA table_info(' + sqlName(name) + ')').all().map(c => c.name)
      const keys = Object.keys(row)
      if (keys.length === 0 || keys.some(key => !columns.includes(key))) throw corrupt()
      insert = { keys, statement: staged.prepare(`INSERT INTO ${sqlName(name)}(${keys.map(sqlName)}) VALUES(${keys.map(() => '?')})`) }
      inserts.set(name,insert)
    }
    if (Object.keys(row).length !== insert.keys.length || !insert.keys.every(key => Object.hasOwn(row,key))) throw corrupt()
    insert.statement.run(...insert.keys.map(key => row[key]))
  }
  for (const { chatId } of staged.prepare('SELECT DISTINCT chatId FROM threads').all()) {
    if (!await sameHistory(source, staged, chatId, signal)) staged.prepare('DELETE FROM threads WHERE chatId=?').run(chatId)
  }
  staged.exec(`DELETE FROM group_delivery WHERE NOT EXISTS (
    SELECT 1 FROM threads t WHERE t.chatId=group_delivery.chatId AND t.botId=group_delivery.botId AND t.threadId=group_delivery.threadId
  )`)
  if (staged.prepare('PRAGMA foreign_key_check').get()) throw corrupt()
  staged.exec('COMMIT')
}

export async function stageWorkspaceRestore(root, path, canCommit = () => true, signal) {
  root = await realpath(root)
  const pending = join(root, pendingName)
  if (await optionalStat(pending)) throw new Error('已有待恢复的备份，请重新启动应用。')
  if (!(await lstat(path)).isFile()) throw corrupt()
  const stage = await mkdtemp(join(root, '.boteam-import-'))
  const incoming = join(stage, 'incoming')
  let archive, source, staged
  try {
    await mkdir(incoming, {mode: 0o700})
    for (const folder of folders) await mkdir(join(incoming,folder), {mode: 0o700})
    archive = new DatabaseSync(path,{readOnly:true})
    archive.exec('PRAGMA trusted_schema=OFF; BEGIN')
    if (archive.prepare('PRAGMA application_id').get().application_id !== archiveId ||
        archive.prepare('PRAGMA user_version').get().user_version !== 1) throw corrupt()
    const actual = archive.prepare("SELECT name,type,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all()
    if (actual.length !== 4 || actual.some(row => row.type !== 'table' || !/^CREATE TABLE /i.test(row.sql) ||
        !['metadata','records','files','chunks'].includes(row.name))) throw corrupt()
    const oldRoot = archive.prepare('SELECT root FROM metadata').get()?.root
    if (typeof oldRoot !== 'string' || !oldRoot) throw corrupt()
    source = new DatabaseSync(join(root, database), {readOnly:true})
    const initialVersion = source.prepare('PRAGMA data_version').get().data_version
    const output = join(incoming, database)
    const empty = await open(output,'wx',0o600)
    await empty.close()
    staged = new DatabaseSync(output)
    source.exec('BEGIN')
    // Copy definitions from this installation, never triggers or SQL from the chosen file.
    const schema = source.prepare(`SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*'
      ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 WHEN 'index' THEN 2 ELSE 3 END,rowid`)
    for (const entry of schema.iterate()) staged.exec(entry.sql)
    await loadRecords(source, staged, archive, oldRoot, root, signal)
    await unpackFiles(archive, incoming, signal)
    for (const row of staged.prepare('SELECT id,name,kind,size FROM attachments').iterate()) {
      const file = await optionalStat(join(incoming, 'attachments', row.id, row.name))
      if (!file || (row.kind === 'folder' ? !file.isDirectory() : !file.isFile() || file.size !== row.size)) throw corrupt()
    }
    source.exec('COMMIT')
    signal?.throwIfAborted()
    if (source.prepare('PRAGMA data_version').get().data_version !== initialVersion || !canCommit())
      throw new Error('工作台数据正在更新，请等待当前操作结束后再恢复。')
    staged.close(); staged = null
    source.close(); source = null
    archive.close(); archive = null
    await rename(stage,pending)
  } finally {
    staged?.close(); source?.close(); archive?.close()
    await rm(stage,{recursive:true,force:true})
  }
}

// Called before SQLite or the native adapters open. Each rename stays on the same volume.
// The journal also lets a subsequent launch roll back an interrupted directory swap.
export async function applyWorkspaceRestore(root) {
  const pending = join(root,pendingName)
  const info = await optionalStat(pending)
  if (!info) return
  if (!info.isDirectory() || info.isSymbolicLink()) throw corrupt()
  const previous = join(pending,'previous'), incoming = join(pending,'incoming')
  const journal = join(pending,'applying.json')
  const cleanup = () => rm(pending,{recursive:true,force:true})
  if (await optionalStat(join(pending,'done'))) { await cleanup(); return }
  async function rollBack(original) {
    for (const name of parts) {
      const old = join(previous,name), target = join(root,name)
      if (await optionalStat(old)) {
        await rm(target,{recursive:true,force:true})
        await rename(old,target)
      } else if (!original.includes(name)) await rm(target,{recursive:true,force:true})
    }
    await cleanup()
  }
  if (await optionalStat(journal)) { await rollBack(JSON.parse(await readFile(journal,'utf8'))); return }
  const original = []
  for (const name of parts) if (await optionalStat(join(root,name))) original.push(name)
  await mkdir(previous, {recursive:true, mode:0o700})
  await writeFile(join(pending,'journal.tmp'),JSON.stringify(original),{mode:0o600})
  await rename(join(pending,'journal.tmp'),journal)
  try {
    for (const name of original) await rename(join(root,name),join(previous,name))
    for (const name of [database,...folders]) await rename(join(incoming,name),join(root,name))
    await writeFile(join(pending,'done'),'1',{mode:0o600})
  } catch (error) {
    await rollBack(original)
    throw new Error('恢复失败，已恢复原工作台。',{cause:error})
  }
  await cleanup()
}
