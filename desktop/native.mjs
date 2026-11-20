import { access, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, join, isAbsolute, sep } from 'node:path'
import { promisify } from 'node:util'

const base = homedir()
const execFileAsync = promisify(execFile)
const applicationDirs = ['/Applications', join(base, 'Applications')]
const defaultUserData = join(base, 'Library/Application Support/BoTeam')
const userBin = [
  join(base, '.local/bin'),
  join(base, '.cargo/bin'),
  join(base, '.antigravity/antigravity/bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
]

export function nativeEnv(extra = {}) {
  const env = {}
  for (const key of [
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'TMP',
    'TEMP',
    'SystemRoot',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS',
    'SSH_AUTH_SOCK',
  ]) {
    if (process.env[key]) env[key] = process.env[key]
  }
  env.PATH = [
    ...new Set([...(process.env.PATH || '').split(delimiter).filter(isAbsolute), ...userBin]),
  ].join(delimiter)
  return { ...env, ...extra }
}

// Human-readable fields only cross IPC. Never pass through raw native protocol frames.
export function redact(input) {
  return String(input ?? '')
    .replace(
      /-----BEGIN [\w ]*PRIVATE KEY-----[\s\S]*?(?:-----END [\w ]*PRIVATE KEY-----|$)/gi,
      '[已隐藏私钥]',
    )
    .replace(
      /(["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|authorization|client[_-]?secret|claude_code_oauth_token)["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^"\s,'}]+/gi,
      '$1[已隐藏]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [已隐藏]')
    .replace(/\b4\/0[A-Za-z0-9_-]{16,}/g, '[已隐藏授权码]')
    .replace(
      /\b(?:sk-[a-z\d_-]{9,}|rt[_-][a-z\d_-]{18,}|gh[pousr]_[a-z\d]{20,}|AIza[a-z\d_-]{30,}|ya29\.[a-z\d._-]+|eyJ[a-z\d_-]+\.[a-z\d_-]+(?:\.[a-z\d_-]*)?)/gi,
      '[已隐藏]',
    )
}

// The model catalog depends on the app-server release. Use the desktop app's
// signed CLI for both enumeration and execution when the user has it installed.
export async function desktopCodexExecutable() {
  if (process.platform !== 'darwin') return null
  for (const dir of applicationDirs) {
    for (const relative of [
      'ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
      'Codex.app/Contents/Resources/codex',
    ]) {
      const bin = join(dir, relative)
      try {
        await access(bin, constants.X_OK)
        if (!(await stat(bin)).isFile()) continue
        await execFileAsync('/usr/bin/codesign', [
          '--verify', '--strict',
          '-R=anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"',
          bin,
        ])
        return bin
      } catch {}
    }
  }
  return null
}

const providers = {
  codex: {
    exe: 'codex',
    config: () => process.env.CODEX_HOME || join(base, '.codex'),
    apps: ['Codex.app'],
    extras: [],
  },
  claude: {
    exe: 'claude',
    config: () => process.env.CLAUDE_CONFIG_DIR || join(base, '.claude'),
    apps: [],
    extras: [],
  },
  antigravity: {
    exe: 'agy',
    config: () => join(base, '.gemini', 'antigravity'),
    apps: ['Antigravity.app', 'Antigravity IDE.app'],
    extras: [
      join(base, '.local/bin/agy'),
      join(base, '.antigravity/bin/agy'),
      ...applicationDirs.map(dir => join(dir, 'Antigravity.app/Contents/Resources/bin/agy')),
    ],
  },
}

export async function discoverySources(provider, home = base) {
  if (provider === 'antigravity') {
    const desktop = join(home, 'Library/Application Support/Antigravity')
    const ide = join(home, 'Library/Application Support/Antigravity IDE')
    const data = join(home, '.gemini', 'antigravity'), cli = join(home, '.gemini', 'antigravity-cli')
    const [hasDesktop, hasIde, hasData, hasCli] = await Promise.all([desktop, ide, data, cli]
      .map(dir => stat(dir).then(info => info.isDirectory(), () => false)))
    const sources = [hasDesktop ? desktop : null, hasIde ? ide : null,
      !hasDesktop && !hasIde && hasData ? data : null, hasCli ? cli : null].filter(Boolean)
    if (sources.length) return sources
    return [(await locate(provider)).appInstalled ? desktop : cli]
  }
  const builtin = {
    codex: join(base, '.codex'),
    claude: join(base, '.claude'),
  }[provider]
  return [...new Set([providers[provider]?.config(), builtin].filter(Boolean))]
}

export async function locate(provider, source, { userData = defaultUserData } = {}) {
  const config = providers[provider]
  if (provider === 'codex') {
    const bin = await desktopCodexExecutable()
    if (bin) return { bin, source: source || config.config(), appInstalled: true }
  }
  const dirs = nativeEnv().PATH.split(delimiter)
  const paths = [...dirs.map((dir) => join(dir, config.exe)), ...config.extras]
  const appRoots = provider === 'antigravity' ? [...new Set([defaultUserData, userData])] : []
  const privateDirs = await Promise.all(appRoots.map(dir => realpath(dir).catch(() => dir)))
  let bin = null
  for (const file of paths) {
    try {
      await access(file, constants.X_OK)
      if (privateDirs.length) {
        const actual = await realpath(file)
        if (privateDirs.some(root => actual.startsWith(root + sep)) || appRoots.some(root => file.startsWith(root + sep))) continue
      }
      if ((await stat(file)).isFile()) {
        bin = file
        break
      }
    } catch {}
  }
  let appInstalled = false
  for (const name of config.apps) {
    for (const dir of applicationDirs) {
      try {
        if ((await stat(join(dir, name))).isDirectory()) appInstalled = true
      } catch {}
    }
  }
  if (provider === 'antigravity') {
    const cliInstalled = Boolean(bin)
    if (!bin) {
      const helper = join(userData, 'tools', 'agy')
      try {
        await access(helper, constants.X_OK)
        if ((await stat(helper)).isFile()) bin = helper
      } catch {}
    }
    return { bin, cliInstalled, source: source || config.config(), appInstalled }
  }
  return { bin, source: source || config.config(), appInstalled }
}
