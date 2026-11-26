import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, opendir, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { imageType } from './attachments.mjs'
import {
  CODEX_EDITOR_LIMIT,
  CODEX_THUMBNAIL_MAX_SIZE,
  classifyPreviewFile,
  formatByteLimit,
} from './file-preview-rules.mjs'
import {
  parseDelimitedSheet,
  parseDocxPreview,
  parsePptxPreview,
  parseXlsxPreview,
} from './openxml-preview.mjs'

const maxText = CODEX_EDITOR_LIMIT
const excludedFromSearch = new Set(['node_modules', '.git', '.cache', 'dist', 'build', 'release', 'target', '.venv'])
const noFollow = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function hasDisallowedSegment(relPath) {
  const parts = sep === '/' ? relPath.split('/') : relPath.split(/[\\/]/)
  return parts.some(part => {
    if (!part || part === '.' || part === '..') return true
    const lower = part.toLowerCase()
    return lower === '.git' || lower === '.system_generated'
  })
}

export function localPath(root, path) {
  if (typeof path !== 'string' || isAbsolute(path) || path.includes('\0') ||
      (sep === '/' ? path.split('/') : path.split(/[\\/]/)).some(part => {
        if (part === '..') return true
        const lower = part.toLowerCase()
        return lower === '.git' || lower === '.system_generated'
      }))
    throw new Error('请选择工作目录内的文件。')
  return join(root, path)
}

async function verifyDirectory(path) {
  if (await realpath(path) !== path) throw new Error('请选择工作目录内的普通文件或文件夹。')
}

export async function resolveWorkspaceFilePath(
  root,
  rawPath,
  extraRoots = [],
  allowWorkspaceAbsolute = false,
  allowedFiles = [],
) {
  if (typeof rawPath !== 'string' || !rawPath || rawPath.includes('\0')) {
    throw new Error('请选择工作目录内的文件。')
  }
  const normalizedInput = rawPath.replace(/^(?:\.\/)+/, '')
  if (!isAbsolute(normalizedInput)) {
    const absolute = localPath(root, normalizedInput)
    const displayPath = normalizedInput.split(/[\\/]/).join('/')
    if (!allowWorkspaceAbsolute) {
      await verifyDirectory(dirname(absolute))
      return { absolute, displayPath, inPrimaryRoot: true }
    }
    const primaryParent = await realpath(dirname(absolute)).catch(() => null)
    if (primaryParent === dirname(absolute)) {
      const stat = await lstat(absolute).catch(() => null)
      if (stat?.isFile()) {
        return { absolute, displayPath, inPrimaryRoot: true }
      }
    }
    for (const candidate of extraRoots) {
      if (!candidate) continue
      const canonicalRoot = await realpath(candidate).catch(() => null)
      if (!canonicalRoot) continue
      let extraCandidate
      try {
        extraCandidate = localPath(canonicalRoot, normalizedInput)
      } catch {
        continue
      }
      const parentDir = await realpath(dirname(extraCandidate)).catch(() => null)
      if (!parentDir || (parentDir !== canonicalRoot && !parentDir.startsWith(canonicalRoot + sep))) {
        continue
      }
      const rel = relative(canonicalRoot, extraCandidate)
      if (!rel || isAbsolute(rel) || hasDisallowedSegment(rel)) continue
      const stat = await lstat(extraCandidate).catch(() => null)
      if (stat?.isFile()) {
        return { absolute: extraCandidate, displayPath: rel.split(sep).join('/'), inPrimaryRoot: false }
      }
    }
    await verifyDirectory(dirname(absolute))
    return { absolute, displayPath, inPrimaryRoot: true }
  }
  if (!allowWorkspaceAbsolute) {
    throw new Error('请选择工作目录内的文件。')
  }
  const parentDir = await realpath(dirname(normalizedInput)).catch(() => null)
  const fileName = basename(normalizedInput)
  if (!parentDir || !fileName || fileName === '.' || fileName === '..') {
    throw new Error('请选择工作目录内的普通文件。')
  }
  const lowerName = fileName.toLowerCase()
  if (lowerName === '.git' || lowerName === '.system_generated') {
    throw new Error('请选择工作目录内的普通文件。')
  }
  const target = join(parentDir, fileName)
  const primaryRoot = root ? await realpath(root).catch(() => null) : null
  if (primaryRoot && (parentDir === primaryRoot || parentDir.startsWith(primaryRoot + sep))) {
    const rel = relative(primaryRoot, target)
    if (rel && !isAbsolute(rel) && !hasDisallowedSegment(rel)) {
      return { absolute: target, displayPath: rel.split(sep).join('/'), inPrimaryRoot: true }
    }
  }
  for (const candidate of extraRoots) {
    if (!candidate) continue
    const canonicalRoot = await realpath(candidate).catch(() => null)
    if (!canonicalRoot) continue
    if (parentDir === canonicalRoot || parentDir.startsWith(canonicalRoot + sep)) {
      const rel = relative(canonicalRoot, target)
      if (!rel || isAbsolute(rel) || hasDisallowedSegment(rel)) continue
      return { absolute: target, displayPath: rel.split(sep).join('/'), inPrimaryRoot: false }
    }
  }
  for (const allowed of allowedFiles) {
    if (!allowed) continue
    const allowedParent = await realpath(dirname(allowed)).catch(() => null)
    if (allowedParent && join(allowedParent, basename(allowed)) === target) {
      return { absolute: target, displayPath: fileName, inPrimaryRoot: false }
    }
  }
  throw new Error('只能预览当前会话工作目录内的文件。')
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

async function inlineLocalHtmlAssets(rootDir, htmlContent) {
  if (!htmlContent || htmlContent.length > 2 * 1024 * 1024) return htmlContent
  const replacements = new Map()
  const attrRe = /\b(?:src|href)=["']([^"']+)["']/gi
  let match
  while ((match = attrRe.exec(htmlContent)) !== null && replacements.size < 24) {
    const rawRef = match[1].trim()
    if (!rawRef || /^(?:https?:|data:|blob:|mailto:|javascript:|#|\/\/)/i.test(rawRef)) continue
    const cleanRef = rawRef.split(/[?#]/)[0]
    if (!cleanRef || isAbsolute(cleanRef) || cleanRef.includes('..')) continue
    if (replacements.has(rawRef)) continue
    const spec = classifyPreviewFile(cleanRef)
    if (spec.previewKind !== 'image' && spec.previewKind !== 'svg' && spec.language !== 'css' && spec.language !== 'javascript') {
      continue
    }
    try {
      const assetAbs = localPath(rootDir, cleanRef)
      await verifyDirectory(dirname(assetAbs))
      const assetHandle = await open(assetAbs, noFollow)
      try {
        const stat = await assetHandle.stat()
        if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue
        const buf = await assetHandle.readFile()
        const mime = spec.mime || (spec.language === 'css'
          ? 'text/css'
          : spec.language === 'javascript'
            ? 'text/javascript'
            : imageType(buf.subarray(0, 16)))
        if (mime) {
          replacements.set(rawRef, `data:${mime};base64,${buf.toString('base64')}`)
        }
      } finally {
        await assetHandle.close()
      }
    } catch {
      // Ignore missing local sub-resources and render the document as-is.
    }
  }
  if (!replacements.size) return htmlContent
  return htmlContent.replace(attrRe, (full, ref) => {
    const dataUrl = replacements.get(ref.trim())
    return dataUrl ? full.replace(ref, dataUrl) : full
  })
}

export async function panelRead(
  root,
  { path },
  { expectedSize, makeThumbnail, extraRoots = [], allowedFiles = [], allowWorkspaceAbsolute = false } = {},
) {
  const { absolute, displayPath, inPrimaryRoot } = await resolveWorkspaceFilePath(
    root,
    path,
    extraRoots,
    allowWorkspaceAbsolute,
    allowedFiles,
  )
  const handle = await open(absolute, noFollow)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('请选择普通文件。')
    if (expectedSize != null && info.size !== expectedSize) throw new Error('此附件的本地快照已发生变化。')

    const header = Buffer.alloc(16)
    await handle.read(header, 0, header.length, 0)
    const detectedImageMime = imageType(header)
    const name = basename(displayPath)
    const spec = classifyPreviewFile(name)
    const isImage = spec.previewKind === 'image' || Boolean(detectedImageMime)
    const effectiveMaxBytes = spec.maxBytes

    const baseResult = {
      path: displayPath,
      ...(inPrimaryRoot ? {} : { resolvedDir: dirname(absolute) }),
      name,
      sizeBytes: info.size,
      previewKind: isImage && spec.previewKind !== 'svg' ? 'image' : spec.previewKind,
      category: isImage ? 'image' : spec.category,
      subtitle: spec.subtitle,
      language: spec.language || null,
      mode: spec.mode,
      editable: Boolean(spec.editable && inPrimaryRoot),
      maxBytes: effectiveMaxBytes,
      binary: true,
      truncated: false,
      oversize: false,
      content: null,
      revision: null,
    }

    if (!spec.renderable && !detectedImageMime) {
      return baseResult
    }

    // Strict whole-file preview limits matching Codex (40 MiB for rich/binary media, 1 MiB for TeX).
    const strictWholeFile =
      isImage ||
      ['pdf', 'docx', 'pptx', 'audio', 'video', 'tex'].includes(baseResult.previewKind) ||
      (baseResult.previewKind === 'spreadsheet' && spec.importKind === 'xlsx')

    if (strictWholeFile && info.size > effectiveMaxBytes) {
      baseResult.oversize = true
      baseResult.truncated = true
      baseResult.limitMessage = `文件大小（${formatByteLimit(info.size)}）超出预览上限（${formatByteLimit(effectiveMaxBytes)}）。`
      if (isImage && makeThumbnail && await realpath(absolute) === absolute) {
        baseResult.src = await makeThumbnail(absolute, CODEX_THUMBNAIL_MAX_SIZE)
      }
      return baseResult
    }

    const readLimit = Math.min(info.size, effectiveMaxBytes)
    const chunks = []
    if (readLimit > 0) {
      for await (const chunk of handle.createReadStream({ start: 0, end: readLimit - 1, autoClose: false })) {
        chunks.push(chunk)
      }
    }
    const bytes = Buffer.concat(chunks)
    const truncated = info.size > readLimit
    baseResult.truncated = truncated

    if (isImage && baseResult.previewKind !== 'svg') {
      const mime = detectedImageMime || spec.mime || 'image/png'
      if (spec.tiff) {
        if (makeThumbnail && await realpath(absolute) === absolute) {
          baseResult.src = await makeThumbnail(absolute, 1200)
        }
      } else {
        baseResult.src = `data:${mime};base64,${bytes.toString('base64')}`
      }
      return baseResult
    }

    if (baseResult.previewKind === 'pdf') {
      baseResult.base64 = bytes.toString('base64')
      return baseResult
    }

    if (baseResult.previewKind === 'audio' || baseResult.previewKind === 'video') {
      baseResult.src = `data:${spec.mime};base64,${bytes.toString('base64')}`
      return baseResult
    }

    if (baseResult.previewKind === 'docx') {
      try {
        baseResult.structured = parseDocxPreview(bytes)
      } catch (error) {
        baseResult.previewError = error.message || '无法解析 Word 文档预览。'
      }
      return baseResult
    }

    if (baseResult.previewKind === 'pptx') {
      try {
        baseResult.structured = parsePptxPreview(bytes)
      } catch (error) {
        baseResult.previewError = error.message || '无法解析演示文稿预览。'
      }
      return baseResult
    }

    if (baseResult.previewKind === 'spreadsheet' && spec.importKind === 'xlsx') {
      try {
        baseResult.structured = parseXlsxPreview(bytes)
      } catch (error) {
        baseResult.previewError = error.message || '无法解析电子表格预览。'
      }
      return baseResult
    }

    if (!bytes.includes(0)) {
      let decoded = null
      try {
        decoded = decoder.decode(bytes, { stream: false })
      } catch {
        if (truncated) {
          try {
            decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes, { stream: true })
          } catch {}
        }
      }
      if (decoded !== null) {
        baseResult.content = decoded
        baseResult.binary = false
        if (!truncated && info.size <= maxText) {
          baseResult.revision = digest(bytes)
        }
        if (baseResult.previewKind === 'svg') {
          baseResult.svgSrc = `data:image/svg+xml;base64,${bytes.toString('base64')}`
        } else if (baseResult.previewKind === 'spreadsheet') {
          baseResult.structured = parseDelimitedSheet(decoded, spec.importKind === 'tsv' ? '\t' : ',')
        } else if (baseResult.previewKind === 'html') {
          baseResult.renderedHtml = await inlineLocalHtmlAssets(dirname(absolute), decoded)
        }
      }
    }

    return baseResult
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
  const fileData = await panelRead(root, { path: file }, { expectedSize, makeThumbnail })
  return { ...fileData, kind: 'file' }
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
