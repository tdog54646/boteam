import { lstat, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { redact } from '../native.mjs'
import { nativeSlashCatalog } from './native-slash.mjs'

// ACP announces commands asynchronously, including after session/new returns.
// A fresh defaults session and the resumed conversation can share one process.
export function commandUpdates() {
  const bySession = new Map()
  let waiting
  return {
    observe({ method, params }) {
      if (method !== 'session/update' || params?.update?.sessionUpdate !== 'available_commands_update') return
      const { sessionId, update } = params
      if (!Array.isArray(update.availableCommands)) return
      bySession.set(sessionId, update.availableCommands)
      if (waiting?.id === sessionId) waiting.resolve()
    },
    async read(id) {
      if (!bySession.has(id)) {
        const next = Promise.withResolvers()
        waiting = { id, resolve: next.resolve }
        const timer = setTimeout(next.resolve, 3500)
        try { await next.promise } finally { clearTimeout(timer); waiting = null }
      }
      return bySession.get(id)
    },
  }
}

const reserved = new Set(('goal compact schedule browser plan teamwork learn boost agy-customizations ' +
  'antigravity-guide run-workflow swarm clear new exit quit logout login usage quota credits model ' +
  'settings config plugins plugin permissions agents mcp hooks rewind undo resume fork').split(' '))
const commandName = /^[a-z0-9][a-z0-9_-]{0,99}(?::[a-z0-9][a-z0-9_-]{0,99})?$/i

// ACP advertises executable commands per session, including its built-ins and
// scoped workflows. Session/account switches belong to the host's binding UI.
export function sessionSlashCommands(commands, planMode) {
  return nativeSlashCatalog(commands, name => {
    if (['login', 'logout', 'auth', 'account', 'accounts'].includes(name))
      return { action: 'unavailable', reason: '请在账号管理中更改此 Bot 的原生登录。' }
    if (['new', 'clear', 'resume', 'fork', 'quit', 'exit'].includes(name))
      return { action: 'unavailable', reason: '此命令会更换或关闭当前绑定的原生会话。' }
    if (name === 'plan' && planMode) return { action: 'plan' }
    if (name === 'model') return { action: 'model' }
    if (name === 'permissions') return { action: 'permission' }
    if (name === 'usage') return { action: 'quota' }
    return { action: 'prompt' }
  })
}

async function projectRoots(cwd) {
  const root = await realpath(cwd)
  const ancestors = [root]
  for (let dir = root; ancestors.length <= 32; ) {
    if (await lstat(join(dir, '.git')).catch(() => null)) return ancestors
    const parent = dirname(dir)
    if (dir === parent) break
    dir = parent
    ancestors.push(dir)
  }
  return [root]
}

async function manifestExists(file) {
  // Never follow customization links into another account's home.
  return await realpath(file).catch(() => '') === file && (await lstat(file).catch(() => null))?.isFile()
}

export async function sessionSkills(commands, profile, cwd) {
  if (!commands?.length) return []
  const roots = await projectRoots(cwd)
  const scopes = [...roots.flatMap(root => ['.agents', '.agent'].map(name => join(root, name))),
    ...['config', 'antigravity-cli', ''].map(name => join(profile.home, '.gemini', name))]
  const seen = new Set()
  const extensions = []
  for (const command of commands) {
    const name = command?.name
    if (typeof name !== 'string' || !commandName.test(name) || reserved.has(name) || seen.has(name)) continue
    seen.add(name)
    if (name !== 'grill-me') {
      const [plugin, skill] = name.split(':')
      const paths = scopes.flatMap(root => skill
        ? [join(root, 'plugins', plugin, 'skills', skill, 'SKILL.md')]
        : [join(root, 'skills', name, 'SKILL.md'), join(root, 'workflows', name + '.md')])
      if (!skill) paths.push(join(profile.home, '.gemini/config/global_workflows', name + '.md'))
      if (!(await Promise.all(paths.map(manifestExists))).some(Boolean)) continue
    }
    extensions.push({ id: 'skill:' + name, label: '/' + name, kind: 'skill',
      description: redact(typeof command.description === 'string' ? command.description : '').slice(0, 400) })
  }
  return extensions.sort((a, b) => a.label.localeCompare(b.label))
}
