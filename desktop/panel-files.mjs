import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, opendir, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { imageType } from './attachments.mjs'

const maxText = 1024 * 1024
const maxImage = 4 * maxText
const excludedFromSearch = new Set(['node_modules', '.git', '.cache', 'dist', 'build', 'release', 'target', '.venv'])
const noFollow = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export function localPath(root, path) {
  if (typeof path !== 'string' || isAbsolute(path) || path.includes('\0') ||
      (sep === '/' ? path.split('/') : path.split(/[\\/]/)).some(part => part === '..' || part.toLowerCase() === '.git'))
    throw new Error('请选择工作目录内的文件。')
  return join(root, path)
}

async function verifyDirectory(path) {
  if (await realpath(path) !== path) throw new Error('请选择工作目录内的普通文件或文件夹。')
}

export async function panelFiles(root, { path = '', query }, search) {
  const start = localPath(root, path)
  await verifyDirectory(start)
  const needle = String(query || '').toLowerCase().trim()
  const entries = []
  const queue = [start]
  const limit = search ? 100 : 2000
  let visited = 0
  let truncated = false
  scan: for (let i = 0; i < queue.length; i++) {
    const current = queue[i]
    let dir
    try {
      await verifyDirectory(current)
      dir = await opendir(current)
    } catch (error) {
      if (current === start) throw error
      continue
    }
    for await (const item of dir) {
      if (++visited > 50_000 && search) { truncated = true; break scan }
      if (item.name.toLowerCase() === '.git' || (!item.isFile() && !item.isDirectory())) continue
      const absolute = join(current, item.name)
      const path = relative(root, absolute).split(sep).join('/')
      if (!search || path.toLowerCase().includes(needle)) {
        if (entries.length === limit) { truncated = true; break scan }
        entries.push({ name: item.name, path, kind: item.isDirectory() ? 'directory' : 'file' })
      }
      if (search && item.isDirectory() && !excludedFromSearch.has(item.name)) queue.push(absolute)
    }
  }
  entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
    a.path.localeCompare(b.path, 'zh-CN', { numeric: true }))
  return { root, entries, truncated }
}

export async function panelRead(root, { path }, { expectedSize, makeThumbnail } = {}) {
  const absolute = localPath(root, path)
  await verifyDirectory(dirname(absolute))
  const handle = await open(absolute, noFollow)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('请选择普通文件。')
    if (expectedSize != null && info.size !== expectedSize) throw new Error('此附件的本地快照已发生变化。')
    const header = Buffer.alloc(16)
    await handle.read(header, 0, header.length, 0)
    const mime = imageType(header)
    const length = Math.min(info.size, mime ? maxImage : maxText)
    const chunks = []
    if (length) {
      for await (const chunk of handle.createReadStream({ start: 0, end: length - 1, autoClose: false }))
        chunks.push(chunk)
    }
    const bytes = Buffer.concat(chunks)
    const truncated = info.size > length
    const result = { path, name: basename(path), binary: true, truncated, content: null, revision: null }
    if (mime) {
      if (!truncated) result.src = 'data:' + mime + ';base64,' + bytes.toString('base64')
      else if (makeThumbnail && await realpath(absolute) === absolute) result.src = await makeThumbnail(absolute)
    } else if (!bytes.includes(0)) {
      try {
        result.content = decoder.decode(bytes, { stream: false })
        result.binary = false
        if (!truncated) result.revision = digest(bytes)
      } catch {
        // A preview may end partway through a multibyte character.
        if (truncated) {
          try {
            result.content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
              .decode(bytes, { stream: true })
            result.binary = false
          } catch {}
        }
      }
    }
    return result
  } finally { await handle.close() }
}

export async function attachmentPreview(store, { chatId, attachmentId, path = '' }, makeThumbnail) {
  const item = store.visible(chatId, attachmentId)
  if (!item) throw new Error('此附件不在当前聊天中。')
  const directory = join(store.dir, item.id)
  let root = directory, file = item.name, expectedSize = item.size
  if (item.kind === 'folder') {
    root = localPath(directory, item.name)
    const folder = store.db.get('SELECT entries FROM attachment_folders WHERE id=?', item.id)
    if (!folder) throw new Error('文件夹快照已不可用。')
    const entries = JSON.parse(folder.entries)
    const entry = path === '' ? { kind: 'folder' } : entries.find(e => e.path === path)
    if (!entry) throw new Error('此项不在文件夹快照中。')
    if (entry.kind === 'folder') {
      const listing = await panelFiles(root, { path }, false)
      const manifest = new Map(entries.map(e => [e.path, e.kind === 'folder' ? 'directory' : 'file']))
      return { kind: 'folder', entries: listing.entries.filter(e => manifest.get(e.path) === e.kind) }
    }
    file = path
    expectedSize = entry.bytes
  } else if (path !== '') throw new Error('此附件没有子文件。')
  const { name, binary, truncated, content, src } = await panelRead(root, { path: file }, { expectedSize, makeThumbnail })
  return { kind: 'file', name, binary, truncated, content, src }
}

export async function panelSave(root, { path, content, revision }) {
  const absolute = localPath(root, path)
  const parent = dirname(absolute)
  await verifyDirectory(parent)
  if (!path || typeof content !== 'string' || Buffer.byteLength(content) > maxText)
    throw new Error('页面内容最多支持 1 MiB。')
  const partial = join(parent, '.boteam-' + randomUUID() + '.tmp')
  const updating = revision != null
  const handle = await open(partial, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(content)
      if (updating) {
        const current = await panelRead(root, { path })
        if (!current.revision || current.revision !== revision)
          throw new Error('文件已被修改，请重新打开后保存。')
        await handle.chmod((await lstat(absolute)).mode & 0o777)
      }
    } finally { await handle.close() }
    if (updating) await rename(partial, absolute)
    else await link(partial, absolute)
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('同名文件已存在，请更换文件名。')
    throw error
  } finally {
    await unlink(partial).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
  return { path, revision: digest(content) }
}
