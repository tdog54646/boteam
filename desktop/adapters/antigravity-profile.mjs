import { spawn } from 'node:child_process'
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { nativeEnv } from '../native.mjs'

const quote = (v) => "'" + v.replaceAll("'", "'\\''") + "'"
export const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
export function paidTier(name) {
  const match = /^(?:google\s+(?:one\s+)?ai\s+|ai\s+)?(plus|pro|ultra)(?:\s+(?:plan|\d+x))?$/i.exec(
    String(name || '').trim(),
  )
  return match?.[1].toLowerCase()
}

export async function privateProfile(bin, source) {
  if (process.platform !== 'darwin' || !bin || !path.isAbsolute(bin) || !source)
    throw new Error('需要在 macOS 安装 agy 并授权独立身份。')
  try {
    await access(bin, constants.X_OK)
    const info = await lstat(source)
    if (!info.isDirectory() || info.uid !== process.getuid() || info.mode & 0o077) throw new Error()
  } catch {
    throw new Error('无法启动 agy 或访问隔离的账号目录。')
  }
  const home = await realpath(source)
  const sharedGemini = path.join(homedir(), '.gemini')
  if (
    home === homedir() ||
    home === '/' ||
    home === sharedGemini ||
    home.startsWith(sharedGemini + '/')
  )
    throw new Error('请选择 BoTeam 创建的隔离账号目录。')
  const shield = [
    '(version 1)(allow default)',
    // The macOS keyring backend uses /usr/bin/security. Deny direct Security.framework
    // lookups and reads as well. The native CLI handles its own file fallback.
    '(deny process-exec (literal "/usr/bin/security"))',
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.secd") (global-name-regex #"^com[.]apple[.]security"))',
    ...['.gemini', 'Library/Keychains', 'Library/Application Support/Antigravity'].map(
      (dir) =>
        `(deny file-read* file-write* (subpath ${JSON.stringify(path.join(homedir(), dir))}))`,
    ),
  ]
  // Sibling managed homes may contain another account's native file-backed login.
  if (/^profile-[A-Za-z0-9]{6}$/.test(path.basename(home))) {
    const parent = JSON.stringify(path.dirname(home))
    shield.push(
      `(deny file-read* file-write* (require-all (subpath ${parent}) (require-not (subpath ${JSON.stringify(home)}))))`,
      // The native SQLite VFS stats every ancestor while opening its backing DB.
      // Only the parent inode's metadata is needed. Listing it or reading a sibling stays denied.
      `(allow file-read-metadata (literal ${parent}))`,
    )
  }
  const env = nativeEnv({
    HOME: home,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin:' + nativeEnv().PATH,
    AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
    TERM: 'xterm-256color',
  })
  delete env.SSH_AUTH_SOCK
  return { bin, home, env, shield: shield.join('') }
}

export function invocation(profile, args) {
  const policy = profile.shield + '(deny process-exec (literal "/usr/bin/open"))'
  return ['/usr/bin/sandbox-exec', '-p', policy, profile.bin, ...args]
}

const grantMarker = (home) => path.join(home, '.boteam-oauth-completed')
export async function markStagedLogin(home) {
  try {
    await writeFile(grantMarker(home), '', { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error.code !== 'EEXIST' || !(await hasStagedLogin({ source: home }))) throw error
  }
}
export async function hasStagedLogin({ source }) {
  if (!source) return false
  try {
    const info = await lstat(grantMarker(source))
    return info.isFile() && info.uid === process.getuid()
  } catch {
    return false
  }
}

export async function statusline(profile, signal, interactive = false) {
  signal?.throwIfAborted()
  const dir = await mkdtemp(path.join(tmpdir(), 'boteam-agy-'))
  const launcher = path.join(dir, 'Antigravity.command')
  const result = path.join(dir, 'identity.json'),
    pidFile = path.join(dir, 'pid')
  let child,
    ended = false,
    failed = false
  try {
    // Only the native statusline's documented public fields are retained, even
    // if a future client extends its payload. Each invocation uses a fresh path.
    const command = `/usr/bin/jq -ce 'select(.product == "antigravity" and .agent_state == "idle" and (.email | type) == "string" and (.plan_tier | type) == "string" and (.plan_tier | length) > 0) | {email,plan_tier}' > ${quote(result + '.part')} && /bin/mv -f ${quote(result + '.part')} ${quote(result)}`
    const settings = {
      statusLine: { type: 'command', command },
      trustedWorkspaces: [await realpath(dir)],
      toolPermission: 'strict',
    }
    const argv = invocation(profile, ['--log-file', '/dev/null', '--settings', JSON.stringify(settings)])
    const envArgs = Object.entries(profile.env).map(([k, v]) => `${k}=${v}`)
    // Terminal owns the PTY. The watchdog also closes the native login on cancel,
    // application exit, or timeout, even after the launching `open` process exits.
    const environmentCommand = (args) =>
      ['/usr/bin/env', '-i', ...envArgs, ...args].map(quote).join(' ')
    const script = [
      '#!/bin/bash',
      'umask 077',
      `cd ${quote(dir)} || exit 1`,
      `echo "$$" > ${quote(pidFile)}`,
      'native_pid=$$',
      '(',
      '  n=0',
      `  while [ -e ${quote(launcher)} ] && [ "$n" -lt 1860 ] && kill -0 "$native_pid" 2>/dev/null; do /bin/sleep 1; n=$((n + 1)); done`,
      // This launcher's random working directory is part of the native argv.
      // If the PID was recycled after agy exited, leave its new owner alone.
      `  /bin/ps -ww -p "$native_pid" -o command= | /usr/bin/grep -Fq -- ${quote(dir + '/')} && kill -TERM "$native_pid" 2>/dev/null`,
      ') </dev/null >/dev/null 2>&1 &',
      'exec ' + environmentCommand(argv),
      '',
    ].join('\n')
    await writeFile(launcher, script, { mode: 0o700 })
    child = interactive
      ? spawn('/usr/bin/open', ['-a', 'Terminal', launcher], {
          stdio: 'ignore',
        })
      : spawn(
          '/bin/sh',
          ['-c', '/bin/cat | /usr/bin/script -q /dev/null "$1"', 'boteam', launcher],
          { cwd: dir, env: profile.env, stdio: ['pipe', 'ignore', 'ignore'] },
        )
    child.on('error', () => {
      failed = true
    })
    child.stdin?.on('error', () => {})
    child.once('exit', (code) => {
      ended = true
      failed = !!code
    })
    const deadline = Date.now() + (interactive ? 30 * 60_000 : 15_000)
    while (Date.now() < deadline) {
      signal?.throwIfAborted()
      try {
        const { email, plan_tier } = JSON.parse(await readFile(result, 'utf8'))
        if (
          typeof email === 'string' &&
          email.length <= 254 &&
          /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)
        ) {
          const plan = paidTier(plan_tier)
          if (!plan) throw new Error('当前 Google 账号未返回可识别的付费 AI 订阅。')
          const address = email.toLowerCase()
          return {
            email: address,
            plan,
            identity: `google:${address}`,
            status: 'ready',
            loginState: 'signed-in',
          }
        }
      } catch (e) {
        if (e.code !== 'ENOENT') throw e
      }
      if (failed || (!interactive && ended)) break
      try {
        const pid = Number(await readFile(pidFile, 'utf8'))
        if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, 0)
      } catch (e) {
        if (e.code === 'ESRCH') break
        if (e.code !== 'ENOENT') throw e
      }
      await delay(120, undefined, { signal })
    }
    if (!interactive) {
      throw Object.assign(new Error('未能从隔离的 agy 会话核验当前邮箱和付费订阅，请继续原生设置。'), {
        code: 'AGY_SETUP_REQUIRED',
      })
    }
    throw new Error('Antigravity 首次设置已关闭或超时，请继续设置。')
  } finally {
    await rm(dir, { recursive: true, force: true })
    child?.stdin?.end()
    if (child && !ended && !interactive) child.kill('SIGTERM')
  }
}

export async function initSettings(profile) {
  const dir = path.join(profile.home, '.gemini', 'antigravity-cli')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  try {
    await writeFile(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        auth: { type: 'oauth-personal' },
        toolPermission: 'strict',
      }),
      { flag: 'wx', mode: 0o600 },
    )
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
  }
}
