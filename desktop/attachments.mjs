import { randomUUID } from 'node:crypto'
import {
  closeSync, constants, createWriteStream, fstatSync, lstatSync, mkdirSync, openSync, readdirSync,
  readSync, realpathSync, rmSync,
} from 'node:fs'
import { lstat, mkdir, open, opendir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { protectedNativePaths } from './codex-permissions.mjs'

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const maxFiles = 32
const maxTransferBytes = 32 * 1024 * 1024
const maxInlineBytes = 16 * 1024
const maxFolderBytes = 64 * 1024 * 1024
const maxFolderEntries = 512
const maxFolderDepth = 16
const ignoredDirectories = new Set(['node_modules', 'vendor', 'bower_components', 'dist', 'build',
  'target', 'coverage', 'out', 'release', 'venv', '__pycache__', 'deriveddata', 'pods'])
const privateKey = /^id_(?:rsa|dsa|ecdsa|ed25519)(?:[._-].*)?$|\.(?:key|pem|p12|pfx|jks|keystore|keychain(?:-db)?|kdbx)$|\.env(?:[.-].*)?$|-firebase-adminsdk-.*\.json$/i
const credentialName = /^(?:credentials?|secrets?|api[_-]?keys?|private[_-]?keys?|client[_-]?secrets?|service[_-]?accounts?)(?:[-_.].*)?$|^(?:tokens?|auth)(?:\.(?:json|ya?ml|toml|xml|db|sqlite3?|plist|txt))?$/i
const flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0)
const decoder = new TextDecoder('utf-8', { fatal: true })

function fileName(value) {
  if (typeof value !== 'string') throw new Error('附件缺少文件名。')
  let name = basename(value.replaceAll('\\', '/'))
    .replace(/[\u0000-\u001f\u007f<>:"|?*\u202a-\u202e\u2066-\u2069]/gu, '_')
    .trim()
  // Leave room for filesystem-specific normalization and avoid reserved DOS names.
  let result = ''
  for (const char of name) {
    if (Buffer.byteLength(result + char) > 180) break
    result += char
  }
  name = result.replace(/[. ]+$/u, '') || '附件'
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name) ? '_' + name : name
}

function transferredFile(file) {
  const name = fileName(file?.name)
  let bytes, kind
  if (typeof file.text === 'string') {
    if (Buffer.byteLength(file.text) > maxTransferBytes) throw new Error('文字片段过大，请从文件选择器添加。')
    bytes = Buffer.from(file.text)
    kind = 'text'
  } else {
    if (file.bytes instanceof ArrayBuffer) bytes = Buffer.from(file.bytes)
    else if (file.bytes instanceof Uint8Array)
      bytes = Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength)
    else throw new Error('没有收到文件内容，请重新添加附件。')
    if (bytes.length > maxTransferBytes) throw new Error('超过 32 MiB 的文件请通过文件选择器添加。')
    kind = 'file'
  }
  return {
    name, kind, size: bytes.length,
    async save(destination) {
      await writeFile(destination, bytes, { flag: 'wx', mode: 0o400 })
      return { size: bytes.length }
    },
  }
}

async function copyFileSnapshot(source, destination, remaining = Infinity) {
  const handle = await open(source, flags)
  try {
    const info = await handle.stat()
    const current = await lstat(source)
    if (!info.isFile() || info.dev !== current.dev || info.ino !== current.ino || await realpath(source) !== source)
      throw new Error('文件已移动或变为链接，请重试。')
    if (info.size > remaining) throw new Error('文件夹附件最多支持 64 MiB，请选择较小的子目录。')
    if (info.size) {
      // A growing input cannot exceed the size checked against the folder budget.
      await pipeline(handle.createReadStream({ end: info.size - 1 }),
        createWriteStream(destination, { flags: 'wx', mode: 0o400 }))
      if ((await stat(destination)).size !== info.size) throw new Error('文件大小已变化，请重新添加。')
    } else await writeFile(destination, '', { flag: 'wx', mode: 0o400 })
    return info.size
  } finally {
    await handle.close()
  }
}

function within(path, directory) {
  return path === directory || path.startsWith(directory.endsWith(sep) ? directory : directory + sep)
}

function omittedName(name, isDirectory) {
  return name.startsWith('.') || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(name) ||
    privateKey.test(name) || credentialName.test(name) ||
    (isDirectory && ignoredDirectories.has(name.toLowerCase()))
}

async function copyFolderSnapshot(source, destination, protectedPaths) {
  const entries = []
  let size = 0, visited = 0, skippedCount = 0, fileCount = 0
  async function walk(relative, depth) {
    const from = join(source, relative)
    if (await realpath(from) !== from) throw new Error('文件夹已变为符号链接，请重试。')
    await mkdir(join(destination, relative), { mode: 0o700 })
    const reader = await opendir(from)
    for await (const item of reader) {
      if (++visited > maxFolderEntries) throw new Error('文件夹超过 512 项，请选择较小的子目录。')
      const entry = join(relative, item.name)
      const path = join(source, entry)
      if ((!item.isFile() && !item.isDirectory()) || omittedName(item.name, item.isDirectory()) ||
          protectedPaths.has(path)) {
        skippedCount++
        continue
      }
      if (item.isDirectory()) {
        if (depth >= maxFolderDepth) throw new Error('文件夹超过 16 层，请选择较小的子目录。')
        entries.push({ path: entry, kind: 'folder' })
        await walk(entry, depth + 1)
      } else {
        const bytes = await copyFileSnapshot(path, join(destination, entry), maxFolderBytes - size)
        size += bytes
        fileCount++
        entries.push({ path: entry, bytes })
      }
    }
  }
  await walk('', 0)
  entries.sort((a, b) => a.path.localeCompare(b.path))
  return { size, fileCount, skippedCount, entries }
}

async function selectedEntry(source, storeDir, protectedPaths) {
  if (typeof source !== 'string' || !isAbsolute(source)) throw new Error('请选择本地文件或文件夹。')
  const info = await lstat(source)
  if (!info.isFile() && !info.isDirectory()) throw new Error('请选择普通文件或文件夹，符号链接不能作为附件。')
  const path = await realpath(source)
  const current = await lstat(path)
  if (info.dev !== current.dev || info.ino !== current.ino) throw new Error('选择的文件或文件夹已移动，请重试。')
  const name = fileName(basename(path))
  if (info.isDirectory()) {
    if (omittedName(basename(path), true) || within(storeDir, path) ||
        [...protectedPaths].some(privatePath => within(path, privatePath)))
      throw new Error('此文件夹包含应用数据、凭据或构建产物，请选择具体的项目子目录。')
    return { name, kind: 'folder', save: destination => copyFolderSnapshot(path, destination, protectedPaths) }
  }
  return { name, kind: 'file', save: async destination => ({ size: await copyFileSnapshot(path, destination) }) }
}

export function imageType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('latin1', 0, 6))) return 'image/gif'
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

function inspectCopy(path, row, budget) {
  let fd
  try {
    fd = openSync(path, flags)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size !== row.size || realpathSync(path) !== path) throw new Error()
    const inline = row.size <= Math.min(budget, maxInlineBytes)
    const bytes = Buffer.alloc(inline ? row.size : Math.min(row.size, 16))
    if (bytes.length && readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error()
    const image = imageType(bytes)
    if (image) return { mimeType: image }
    if (inline) {
      try {
        const text = decoder.decode(bytes)
        if (!/[\x00-\x08\x0b\x0e-\x1f\x7f]/u.test(text)) return { mimeType: 'text/plain', text }
      } catch { /* Non-UTF-8 files are delivered by their local path. */ }
    }
    return { mimeType: row.kind === 'text' ? 'text/plain' : 'application/octet-stream' }
  } catch {
    throw new Error('附件「' + row.name + '」的本地副本已不可用，请移除后重新添加。')
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function folderManifest(path, row, folder, previewBytes, budget) {
  let entries
  try {
    if (!folder || realpathSync(path) !== path || !lstatSync(path).isDirectory()) throw new Error()
    entries = JSON.parse(folder.entries)
    let actualCount = readdirSync(path).length
    for (const entry of entries) {
      const child = join(path, entry.path)
      const info = lstatSync(child)
      if (entry.kind === 'folder') {
        if (!info.isDirectory()) throw new Error()
        actualCount += readdirSync(child).length
      } else if (!info.isFile() || info.size !== entry.bytes) throw new Error()
    }
    if (actualCount !== entries.length) throw new Error()
  } catch {
    throw new Error('文件夹「' + row.name + '」的本地快照已不可用，请重新添加。')
  }
  const preview = []
  for (const entry of entries) {
    const bytes = Buffer.byteLength(JSON.stringify(entry))
    if (preview.length >= 64 || (preview.length && bytes > previewBytes)) break
    previewBytes -= bytes
    const item = { ...entry }
    if (entry.kind !== 'folder' && entry.bytes <= Math.min(maxInlineBytes, budget.text)) {
      const { text } = inspectCopy(join(path, entry.path), { size: entry.bytes, name: entry.path }, budget.text)
      if (text !== undefined) {
        item.text = text
        budget.text -= entry.bytes
      }
    }
    preview.push(item)
  }
  return { kind: 'folder', name: row.name, path, bytes: row.size,
    fileCount: folder.fileCount, skippedCount: folder.skippedCount, entries: preview,
    ...(preview.length < entries.length && { additionalEntries: entries.length - preview.length }) }
}

export class AttachmentStore {
  constructor(root, db) {
    this.dir = resolve(root, 'attachments')
    this.db = db
    mkdirSync(this.dir, { mode: 0o700, recursive: true })
    this.dir = realpathSync(this.dir)
    db.run("DELETE FROM attachments WHERE messageId IS NULL AND scope LIKE 'draft:%'")
    // Recover an interrupted copy or removal. A draft for a removed bot has no composer.
    db.run(`DELETE FROM attachments WHERE messageId IS NULL AND scope LIKE 'home:%'
            AND NOT EXISTS (SELECT 1 FROM bots WHERE id=substr(attachments.scope,6) AND archived=0)`)
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (entry.isDirectory() && uuid.test(entry.name) && !db.get('SELECT 1 FROM attachments WHERE id=?', entry.name))
        rmSync(join(this.dir, entry.name), { recursive: true, force: true })
    }
  }
  validateScope(scope) {
    if (typeof scope !== 'string' || scope.length > 180) throw new Error('附件草稿无效。')
    if (scope.startsWith('draft:') && uuid.test(scope.slice(6)) &&
        !this.db.get('SELECT 1 FROM chats WHERE id=?', scope.slice(6))) return
    const valid = scope.startsWith('home:')
      ? this.db.get('SELECT 1 FROM bots WHERE id=? AND archived=0', scope.slice(5))
      : this.db.get('SELECT 1 FROM chats WHERE id=?', scope)
    if (!valid) throw new Error('此会话或接收 Bot 已不可用。')
  }
  list(scope) {
    this.validateScope(scope)
    return this.db.all(
      'SELECT a.id,name,size,kind,fileCount,skippedCount FROM attachments a LEFT JOIN attachment_folders USING(id) WHERE scope=? AND messageId IS NULL ORDER BY a.rowid', scope,
    ).map(({ fileCount, skippedCount, ...row }) => row.kind === 'folder' ? { ...row, fileCount, skippedCount } : row)
  }
  visible(scope, id) {
    if (typeof scope !== 'string' || !scope || typeof id !== 'string' || !uuid.test(id)) return null
    return this.db.get(`SELECT a.* FROM attachments a
      WHERE a.id=? AND
      ((a.messageId IS NULL AND a.scope=?) OR EXISTS (
        SELECT 1 FROM message_attachments ma JOIN messages m ON m.id=ma.messageId
        WHERE ma.attachmentId=a.id AND m.chatId=?))`, id, scope, scope)
  }
  async thumbnail(scope, id, makeThumbnail) {
    if (!makeThumbnail) return null
    const row = this.visible(scope, id)
    if (row?.kind !== 'file') return null
    const path = join(this.dir, id, row.name)
    if (!inspectCopy(path, row, 0).mimeType.startsWith('image/')) return null
    return makeThumbnail(path)
  }
  async pick(scope, choose) {
    this.validateScope(scope)
    const paths = await choose()
    if (!paths?.length) return []
    if (!Array.isArray(paths) || paths.length > maxFiles) throw new Error('每条消息最多添加 32 个附件。')
    const storeDir = this.dir
    const protectedPaths = new Set([storeDir, ...protectedNativePaths(dirname(storeDir),
      this.db.all('SELECT id FROM accounts').map(row => this.db.account(row.id)))])
    try {
      const entries = await Promise.all(paths.map(path => selectedEntry(path, storeDir, protectedPaths)))
      return await this.stage(scope, entries)
    } catch (error) {
      if (error.code) throw new Error('无法复制附件，请确认文件仍然可读且磁盘空间充足。', { cause: error })
      throw error
    }
  }
  async add(scope, files) {
    this.validateScope(scope)
    if (!Array.isArray(files) || files.length > maxFiles) throw new Error('每条消息最多添加 32 个附件。')
    const entries = files.map(transferredFile)
    if (entries.reduce((total, item) => total + item.size, 0) > 2 * maxTransferBytes)
      throw new Error('单次拖放或粘贴最多支持 64 MiB，大文件请通过文件选择器添加。')
    return this.stage(scope, entries)
  }
  async stage(scope, entries) {
    const copies = [], directories = []
    const checkCapacity = () => {
      const { count } = this.db.get('SELECT count(*) AS count FROM attachments WHERE scope=? AND messageId IS NULL', scope)
      if (count + entries.length > maxFiles) throw new Error('每条消息最多添加 32 个附件。')
    }
    checkCapacity()
    try {
      for (const { name, kind, save } of entries) {
        const id = randomUUID()
        const dir = join(this.dir, id)
        await mkdir(dir, { mode: 0o700 })
        directories.push(dir)
        const metadata = await save(join(dir, name))
        copies.push({ id, name, kind, ...metadata })
      }
      this.db.transaction(() => {
        this.validateScope(scope)
        checkCapacity()
        for (const { id, name, size, kind, entries, fileCount, skippedCount } of copies) {
          this.db.run('INSERT INTO attachments(id,scope,name,size,kind) VALUES(?,?,?,?,?)', id, scope, name, size, kind)
          if (kind === 'folder')
            this.db.run('INSERT INTO attachment_folders(id,fileCount,skippedCount,entries) VALUES(?,?,?,?)',
              id, fileCount, skippedCount, JSON.stringify(entries))
        }
      })
      return copies.map(({ entries, ...summary }) => summary)
    } catch (error) {
      await Promise.all(directories.map(path => rm(path, { recursive: true, force: true })))
      throw error
    }
  }
  async remove(scope, id) {
    this.validateScope(scope)
    if (typeof id !== 'string' || !uuid.test(id)) throw new Error('附件无效。')
    const result = this.db.run('DELETE FROM attachments WHERE scope=? AND id=? AND messageId IS NULL', scope, id)
    if (!result.changes) throw new Error('附件不在当前草稿中。')
    await this.discardSnapshots([id])
  }
  async discardSnapshots(ids) {
    if (!ids.length) return
    if (await realpath(this.dir) !== this.dir) throw new Error('附件目录已移动，无法清理本机快照。')
    for (const id of ids) {
      if (uuid.test(id)) await rm(join(this.dir, id), { recursive: true, force: true })
    }
  }
  // Called inside the send transaction after its user message has been inserted.
  claim({ chatId, homeBotId, draftScope, messageId, ids = [] }) {
    if (!Array.isArray(ids) || ids.length > maxFiles || new Set(ids).size !== ids.length)
      throw new Error('附件列表无效。')
    const budget = { text: 32 * 1024 }
    const attachments = [], manifest = []
    for (const id of ids) {
      if (typeof id !== 'string' || !uuid.test(id)) throw new Error('附件无效。')
      const row = this.db.get('SELECT * FROM attachments WHERE id=? AND messageId IS NULL', id)
      if (!row || (draftScope ? row.scope !== draftScope :
          row.scope !== chatId && (!homeBotId || row.scope !== 'home:' + homeBotId)))
        throw new Error('附件不在当前草稿中。')
      const path = join(this.dir, id, row.name)
      if (row.kind === 'folder') {
        const folder = this.db.get('SELECT * FROM attachment_folders WHERE id=?', id)
        manifest.push(folderManifest(path, row, folder, Math.floor(32 * 1024 / ids.length), budget))
        attachments.push({ kind: 'folder', name: row.name, path, size: row.size, mimeType: 'inode/directory' })
        continue
      }
      const { mimeType, text } = inspectCopy(path, row, budget.text)
      attachments.push({ path, name: row.name, size: row.size, mimeType })
      manifest.push({ name: row.name, path, bytes: row.size, ...(text !== undefined ? { text } : {}) })
      if (text !== undefined) budget.text -= row.size
    }
    for (const id of ids) this.db.run('UPDATE attachments SET messageId=? WHERE id=?', messageId, id)
    const context = manifest.length
      ? '用户为本条消息添加了附件。顶层 path 是本机快照的绝对路径。文件夹 entries 中的路径相对于该快照，additionalEntries 表示未展开的条目数，可在快照中读取。text 是小型文本文件内容。\n' + JSON.stringify(manifest)
      : ''
    return { context, attachments }
  }
}
