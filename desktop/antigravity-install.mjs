import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { access, chmod, link, lstat, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { nativeEnv } from './native.mjs'

const execute = promisify(execFile)
// Google publishes these per-platform manifests through its official CLI installer.
const releases = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests'
const signature = 'anchor apple generic and identifier "cli" and certificate leaf[subject.OU] = "EQHXZ8M8AV"'

async function downloadFile(url, path, signal, maxBytes) {
  try {
    await execute('/usr/bin/curl', ['-q', '--fail', '--silent', '--show-error',
      '--location', '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '15',
      '--max-time', '300', '--max-filesize', String(maxBytes), '--output', path, url], { signal })
  } catch (error) {
    signal?.throwIfAborted()
    throw new Error('无法下载官方 Antigravity CLI，请检查网络或查看官方安装说明。', { cause: error })
  }
}

async function verify(path, signal) {
  try {
    await execute('/usr/bin/codesign', ['--verify', '--strict', '-R=' + signature, path],
      { signal, timeout: 30000, env: nativeEnv() })
  } catch (error) {
    signal?.throwIfAborted()
    throw new Error('Antigravity CLI 未通过 Google 代码签名校验。', { cause: error })
  }
}

export async function installAntigravityCli({
  binDir = join(homedir(), '.local', 'bin'), download = downloadFile, signal,
} = {}) {
  const arch = { arm64: 'arm64', x64: 'amd64' }[process.arch]
  if (process.platform !== 'darwin' || !arch) throw new Error('请通过官方说明安装适合本机的 Antigravity CLI。')
  signal?.throwIfAborted()
  await mkdir(binDir, { recursive: true, mode: 0o755 })
  const target = join(binDir, 'agy')
  async function existingTool() {
    try { await lstat(target) } catch (error) {
      if (error.code === 'ENOENT') return false
      throw error
    }
    try {
      if (!(await stat(target)).isFile()) throw new Error()
      await access(target, constants.X_OK)
      await verify(target, signal)
      return true
    } catch {
      signal?.throwIfAborted()
      throw new Error('目标目录已有 agy，请检查原有安装或使用官方安装说明。')
    }
  }
  if (await existingTool()) return true
  const stage = await mkdtemp(join(binDir, '.boteam-agy-'))
  try {
    const manifest = join(stage, 'manifest.json')
    await download(releases + '/darwin_' + arch + '.json', manifest, signal, 128 * 1024)
    let asset
    try {
      asset = JSON.parse(await readFile(manifest, 'utf8'))
      const url = new URL(asset.url)
      if (url.origin !== 'https://storage.googleapis.com' || url.username || url.password ||
          !url.pathname.startsWith('/antigravity-public/antigravity-cli/') ||
          typeof asset.sha512 !== 'string' || !/^[0-9a-f]{128}$/i.test(asset.sha512)) throw new Error()
    } catch {
      throw new Error('无法核实 Google 发行清单中的下载地址或摘要。')
    }
    const archive = join(stage, 'download')
    await download(asset.url, archive, signal, 500 * 1024 * 1024)
    const digest = createHash('sha512')
    for await (const chunk of createReadStream(archive, { signal })) digest.update(chunk)
    if (digest.digest('hex') !== asset.sha512.toLowerCase()) throw new Error('下载文件未通过官方 SHA-512 校验。')
    let executable = archive
    if (new URL(asset.url).pathname.endsWith('.tar.gz')) {
      await execute('/usr/bin/tar', ['-xzf', archive, '-C', stage, 'antigravity'],
        { signal, timeout: 90000, env: nativeEnv() })
      executable = join(stage, 'antigravity')
    }
    if (!(await lstat(executable)).isFile()) throw new Error('官方发行包内缺少可执行文件。')
    await verify(executable, signal)
    await chmod(executable, 0o755)
    signal?.throwIfAborted()
    try {
      // Publish atomically, including when another installer won the race.
      await link(executable, target)
    } catch (error) {
      if (error.code !== 'EEXIST' || !(await existingTool())) throw error
    }
    return true
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}
