import { constants, createWriteStream } from 'node:fs'
import { link, lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { initSettings, privateProfile } from './antigravity-profile.mjs'

const cliToken = 'antigravity-oauth-token'
const cliDir = home => path.join(home, '.gemini', 'antigravity-cli')
const isDir = p => lstat(p).then(s => s.isDirectory(), () => false)

const desktopDirs = home => ['Antigravity', 'Antigravity IDE'].map(name => path.join(home, 'Library/Application Support', name))
const isFile = file => lstat(file).then(entry => entry.isFile(), () => false)

export async function externalSource(selected) {
  const dir = path.resolve(selected)
  const home = path.basename(dir) === '.gemini' ? path.dirname(dir) : dir
  // A manual selection may be a native config directory, ~/.gemini or the
  // profile's home. Always return the actual directory providing the evidence.
  if (dir === path.join(os.homedir(), '.gemini', 'antigravity')) {
    for (const desktop of desktopDirs(os.homedir()))
      if (await isDir(desktop)) return { source: desktop, sourceKind: 'desktop', configFound: true }
  }
  const standardCli = cliDir(home)
  if (await isDir(standardCli)) return { source: standardCli, sourceKind: 'cli', configFound: true }
  for (const desktop of [...desktopDirs(home), path.join(home, '.gemini', 'antigravity')])
    if (await isDir(desktop)) return { source: desktop, sourceKind: 'desktop', configFound: true }
  const sourceKind = path.basename(dir) === 'antigravity-cli' || await isFile(path.join(dir, cliToken)) ? 'cli' : 'desktop'
  const expected = [cliDir(os.homedir()), ...desktopDirs(os.homedir()), path.join(os.homedir(), '.gemini', 'antigravity')].includes(dir)
  const nativeDesktopState = sourceKind === 'desktop' && await isFile(path.join(dir, 'antigravity_state.pbtxt'))
  const configFound = (expected && await isDir(dir)) || (sourceKind === 'cli'
    ? await isFile(path.join(dir, cliToken)) || await isFile(path.join(dir, 'settings.json'))
    : nativeDesktopState || await isFile(path.join(dir, 'app_storage.json')))
  return { source: dir, sourceKind, configFound, expected,
    checkStorage: sourceKind === 'desktop' && configFound && !expected && !nativeDesktopState }
}

export async function cliPreferences(source) {
  const file = path.join(source, 'settings.json')
  const metadata = await lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error })
  if (!metadata) return {}
  if (!metadata.isFile() || metadata.size > 1024 * 1024 || (process.getuid && metadata.uid !== process.getuid()))
    throw new Error('无法核验所选 agy 配置。')
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > 1024 * 1024 || info.ino !== metadata.ino || info.dev !== metadata.dev)
      throw new Error('所选 agy 配置已变化，请重新检测。')
    const data = JSON.parse(await handle.readFile('utf8'))
    const incompatible = Boolean(data.modelProvider || (data.auth?.type && data.auth.type !== 'oauth-personal'))
    const model = typeof data.model === 'string' && data.model.length <= 200 ? data.model : undefined
    return { incompatible, model }
  } finally { await handle.close() }
}

export async function hasCliLogin(source) {
  return lstat(path.join(source, cliToken)).then(() => true, error => {
    if (error.code === 'ENOENT') return false
    throw error
  })
}

// Transfer only the native CLI's personal file-backed login. The desktop's
// credential stores and OS keychain stay under the native clients' control.
async function copyCliLogin(source, output, signal) {
  const directory = await lstat(source)
  if (!directory.isDirectory() || directory.uid !== process.getuid() || directory.mode & 0o022)
    throw new Error('所选 agy 配置目录的所有者或写入权限无效。')
  const input = await open(path.join(source, cliToken), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await input.stat()
    if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077 || info.nlink !== 1 ||
        info.size <= 0 || info.size > 256 * 1024)
      throw new Error('原生 CLI 登录文件需要由当前用户独占并安全存储。')
    await pipeline(input.createReadStream({ end: info.size - 1 }),
      createWriteStream(output, { flags: 'wx', mode: 0o600 }), { signal })
    const after = await lstat(path.join(source, cliToken))
    if (after.ino !== info.ino || after.dev !== info.dev || after.size !== info.size || after.mtimeMs !== info.mtimeMs)
      throw new Error('原生 CLI 登录在检测期间发生变化，请重新检测。')
  } finally { await input.close() }
}

export async function withCliLogin(source, bin, signal, work) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'boteam-agy-import-'))
  try {
    const profile = await privateProfile(bin, scratch)
    await initSettings(profile)
    await copyCliLogin(source, path.join(cliDir(profile.home), cliToken), signal)
    return await work(profile)
  } finally { await rm(scratch, { recursive: true, force: true }) }
}

export async function installCliLogin(source, destination, bin, signal) {
  const target = await privateProfile(bin, destination)
  // A restored or externally modified execution profile must not redirect
  // this write into the native client's original directory.
  for (const dir of [path.join(target.home, '.gemini'), cliDir(target.home)]) {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    if (await realpath(dir) !== dir) throw new Error('独立 agy 登录目录无效。')
  }
  await initSettings(target)
  const dir = cliDir(target.home)
  const staged = path.join(dir, '.boteam-import-' + randomUUID())
  try {
    await copyCliLogin(source, staged, signal)
    signal?.throwIfAborted()
    // Publish the complete native file only into a new execution profile.
    // Never overwrite a previous binding, including if the operation is retried.
    await link(staged, path.join(dir, cliToken))
  } finally { await rm(staged, { force: true }) }
}
