import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

function canonical(path) {
  try {
    return realpathSync(path)
  } catch (error) {
    if (error.code !== 'ENOENT' || path === dirname(path)) throw error
    return join(canonical(dirname(path)), basename(path))
  }
}

export function protectedNativePaths(root, accounts) {
  const home = homedir()
  const paths = [
    join(root, 'profiles'),
    ...['', '-wal', '-shm', '-journal'].map((suffix) => join(root, 'workspace.sqlite3' + suffix)),
    ...[
      '.codex',
      '.claude',
      '.claude.json',
      '.gemini',
      'Library/Keychains',
      'Library/Application Support/Antigravity',
    ].map((name) => join(home, name)),
  ]
  for (const account of accounts)
    for (const path of [account.source, account.origin, account.credentialSource])
      if (typeof path === 'string' && isAbsolute(path)) paths.push(path)
  return [...new Set(paths.map((path) => canonical(resolve(path))))]
}

// An explicitly unrestricted Codex task may work outside its checkout. Keep
// native account storage isolated in the OS policy inherited by its tool children.
export function codexFullInvocation(bin, args, source, paths) {
  if (process.platform !== 'darwin' || !Array.isArray(paths) || !paths.length)
    throw new Error('此环境无法在完全访问时隔离订阅账号。')
  const context = canonical(source)
  if (basename(dirname(context)) !== 'contexts' || !/^[a-f\d]{64}$/.test(basename(context)))
    throw new Error('此旧会话与账号配置共用目录。请在新会话使用完全访问。')
  const rules = [
    '(version 1)(allow default)',
    '(deny process-exec (literal "/usr/bin/security"))',
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.secd") (global-name-regex #"^com[.]apple[.]security"))',
    '(deny appleevent-send)',
  ]
  const metadata = new Set()
  for (const path of paths) {
    const delta = relative(path, context)
    if (!delta || !isAbsolute(path) || path === sep)
      throw new Error('账号目录与会话重叠，无法使用完全访问。')
    const inside = delta !== '..' && !delta.startsWith('..' + sep) && !isAbsolute(delta)
    const rootMatch = '(subpath ' + JSON.stringify(path) + ')'
    const filter = inside
      ? '(require-all ' + rootMatch + ' (require-not (subpath ' + JSON.stringify(context) + ')))'
      : rootMatch
    rules.push('(deny file-read* file-write* ' + filter + ')')
    if (inside) {
      for (let parent = dirname(context); ; parent = dirname(parent)) {
        metadata.add(parent)
        if (parent === path) break
      }
    }
  }
  if (metadata.size)
    rules.push(
      '(allow file-read-metadata ' +
        [...metadata].map((p) => '(literal ' + JSON.stringify(p) + ')').join(' ') +
        ')',
    )
  // The standalone installer places its binaries and runtime resources under
  // ~/.codex/packages, alongside the protected login. Permit just this release.
  const executable = canonical(bin)
  const releases = join(homedir(), '.codex', 'packages', 'standalone', 'releases')
  const installed = relative(releases, executable).split(sep)
  const bundled =
    installed.length === 3 &&
    /^[\w.+-]+$/.test(installed[0]) &&
    installed[0] !== '..' &&
    installed[1] === 'bin' &&
    installed[2] === 'codex'
  if (bundled)
    rules.push('(allow file-read* (subpath ' + JSON.stringify(join(releases, installed[0])) + '))')
  else rules.push('(allow file-read* (literal ' + JSON.stringify(executable) + '))')
  // Even a newly introduced login file in this chat's own CODEX_HOME is off limits.
  rules.push(
    '(deny file-read* file-write* (literal ' + JSON.stringify(join(context, 'auth.json')) + '))',
  )
  return ['/usr/bin/sandbox-exec', ['-p', rules.join(''), executable, ...args]]
}
