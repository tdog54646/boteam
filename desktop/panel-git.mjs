import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { basename, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { nativeEnv } from './native.mjs'
import { localPath } from './panel-files.mjs'

const run = promisify(execFile)
const env = () => nativeEnv({ LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1' })
const base = ['--no-pager', '-c', 'color.ui=false', '-c', 'core.fsmonitor=false']
const diffOptions = ['--no-ext-diff', '--no-textconv', '--no-renames', '--relative']
async function git(cwd, args, { noIndex = false, preview = false, signal } = {}) {
  try {
    return (await run('git', [...base, ...args], {
      cwd, env: env(), maxBuffer: preview ? 512 * 1024 : 16 * 1024 * 1024,
      timeout: 15_000, windowsHide: true, signal,
    })).stdout
  } catch (error) {
    if (noIndex && error.code === 1) return error.stdout
    if (preview && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return error.stdout + '\n…'
    throw error
  }
}

function numbers(source, update) {
  for (const row of source.split('\0')) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(row)
    if (match) update(match[3], Number(match[1]) || 0, Number(match[2]) || 0)
  }
}

async function addedLines(root, path, signal) {
  const file = localPath(root, path)
  let handle
  try {
    const info = await lstat(file)
    if (info.isSymbolicLink()) return 1
    if (!info.isFile() || !info.size) return 0
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0))
    const current = await handle.stat()
    if (!current.isFile() || !current.size) return 0
    const buffer = Buffer.allocUnsafe(Math.min(current.size, 64 * 1024))
    let lines = 0, last = null, position = 0
    while (position < current.size) {
      signal?.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, current.size - position), position)
      if (!bytesRead) break
      const chunk = buffer.subarray(0, bytesRead)
      if (position === 0 && chunk.subarray(0, 8000).includes(0)) return 0
      for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) lines++
      last = chunk.at(-1)
      position += bytesRead
    }
    return lines + Number(last !== null && last !== 10)
  } catch (error) {
    // The working tree can change while the status is being collected.
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return 0
    throw error
  } finally { await handle?.close() }
}

export async function panelChanges(root, signal) {
  let top
  try {
    top = (await git(root, ['rev-parse', '--show-toplevel'], { signal })).trimEnd()
  } catch (error) {
    if (error.stderr?.includes('not a git repository'))
      return { root, repo: null, branch: '', added: 0, removed: 0, files: [] }
    throw error
  }
  const prefix = relative(top, root).split(sep).join('/')
  const [status, unstaged, staged, branch] = await Promise.all([
    git(root, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--', '.'], { signal }),
    git(root, ['diff', ...diffOptions, '--numstat', '-z', '--', '.'], { signal }),
    git(root, ['diff', ...diffOptions, '--cached', '--numstat', '-z', '--', '.'], { signal }),
    git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { signal }).catch(error => {
      if (error.code !== 1) throw error
      return git(root, ['rev-parse', '--short', 'HEAD'], { signal })
    }),
  ])
  const files = new Map()
  const untracked = []
  for (const row of status.split('\0')) {
    if (!row) continue
    const xy = row.slice(0, 2)
    const path = row.slice(3).slice(prefix ? prefix.length + 1 : 0)
    const conflict = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(xy)
    const type = xy === '??' ? 'A' : conflict ? 'U' : xy.trim().at(-1)
    const info = { path, status: type, added: 0, removed: 0 }
    files.set(path, info)
    if (xy === '??') untracked.push(info)
  }
  for (const stats of [unstaged, staged]) numbers(stats, (path, added, removed) => {
    const info = files.get(path)
    if (info) { info.added += added; info.removed += removed }
  })
  // A large new directory should not need one Git process per untracked file.
  let next = 0
  await Promise.all(Array.from({ length: Math.min(untracked.length, 6) }, async () => {
    while (next < untracked.length) {
      const file = untracked[next++]
      signal?.throwIfAborted()
      file.added = await addedLines(root, file.path, signal)
    }
  }))
  let added = 0, removed = 0
  for (const file of files.values()) { added += file.added; removed += file.removed }
  return { root, repo: basename(top), branch: branch.trimEnd(), added, removed, files: [...files.values()] }
}

export async function panelDiff(root, { path }, signal) {
  localPath(root, path)
  if (!path) throw new Error('请选择要查看的变更。')
  const options = { preview: true, signal }
  const [staged, working] = await Promise.all([
    git(root, ['diff', ...diffOptions, '--cached', '--', path], options),
    git(root, ['diff', ...diffOptions, '--', path], options),
  ])
  const parts = []
  if (staged) parts.push('已暂存\n' + staged)
  if (working) parts.push('工作区\n' + working)
  let diff = parts.join('\n')
  if (!diff) {
    const untracked = await git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', path], { signal })
    if (!path.endsWith('/') && untracked.split('\0').includes(path)) {
      diff = await git(root, ['diff', '--no-index', '--no-ext-diff', '--no-textconv',
        '--', '/dev/null', path], { ...options, noIndex: true })
    }
  }
  const limit = 512 * 1024
  return { diff: diff.slice(0, limit), truncated: diff.length > limit || diff.endsWith('\n…') || staged.endsWith('\n…') }
}
