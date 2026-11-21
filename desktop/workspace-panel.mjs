import { mkdir, realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { localPath, panelFiles, panelRead, panelSave } from './panel-files.mjs'
import { panelChanges, panelDiff } from './panel-git.mjs'
import { PanelTerminals } from './panel-terminals.mjs'
import { chatProjectCwd, draftProjectCwd } from './projects.mjs'

export class WorkspacePanel {
  constructor(workspace) {
    this.workspace = workspace
    this.writes = new Map()
    this.pendingWrites = new Map()
    this.terminals = new PanelTerminals()
  }

  projectCwd({ chatId, draft }) {
    return draft && !chatId ? draftProjectCwd(this.workspace.db, draft) : chatProjectCwd(this.workspace.db, chatId)
  }

  async directory({ chatId, botId, draft }) {
    const app = this.workspace
    const managed = join(app.root, 'workspaces')
    let cwd
    if (chatId) {
      if (!app.db.get('SELECT 1 FROM chats WHERE id=?', chatId)) throw new Error('会话已不存在。')
      botId ||= app.db.get(`SELECT m.botId FROM members m JOIN bots b ON b.id=m.botId
        WHERE m.chatId=? ORDER BY b.archived,m.rowid LIMIT 1`, chatId)?.botId
      if (!app.db.get('SELECT 1 FROM members WHERE chatId=? AND botId=?', chatId, botId || null))
        throw new Error('该 Bot 不属于当前会话。')
      return realpath(await app.ensureChatDirectory(chatId, app.bot(botId, true)))
    } else if (draft) {
      const bot = app.bot(botId || draft.members?.[0])
      return realpath(await app.ensureChatDirectory(null, bot, draft))
    } else if (botId) {
      const bot = app.bot(botId)
      cwd = bot.cwd || app.db.account(bot.accountId).cwd || join(managed, '.draft-' + botId)
    } else cwd = join(managed, '.draft')
    if (dirname(cwd) === managed) await mkdir(cwd, { recursive: true, mode: 0o700 })
    const resolved = await realpath(cwd).catch(() => null)
    if (!resolved || !(await stat(resolved)).isDirectory()) throw new Error('工作目录已不存在。')
    return resolved
  }

  async handle(method, p, terminals = this.terminals) {
    const scopeId = p.chatId || p.draft?.id
    const scope = JSON.stringify([scopeId || '', p.botId || ''])
    if (['panelTerminalRead', 'panelTerminalInput', 'panelTerminalInterrupt', 'panelTerminalResize', 'panelTerminalClose'].includes(method))
      return terminals.handle(method, scope, p)
    const initialCwd = this.projectCwd(p)
    if (p.expectedProjectCwd !== undefined && p.expectedProjectCwd !== initialCwd)
      throw new Error('聊天工作目录已更改，请重新打开工作区。')
    if (method !== 'panelSave' || !scopeId) return this.run(method,p,terminals,scope,initialCwd)
    const count = this.pendingWrites.get(scopeId) || 0
    this.pendingWrites.set(scopeId,count + 1)
    try { return await this.run(method,p,terminals,scope,initialCwd) }
    finally {
      const remaining = this.pendingWrites.get(scopeId) - 1
      if (remaining) this.pendingWrites.set(scopeId,remaining)
      else this.pendingWrites.delete(scopeId)
    }
  }

  async run(method, p, terminals, scope, initialCwd) {
    const generation = terminals.generation
    const root = await this.directory(p)
    if (this.workspace.closed) throw new Error('工作台已关闭。')
    switch (method) {
      case 'panelFiles': return panelFiles(root, p, false)
      case 'panelSearch': return panelFiles(root, { query: p.query }, true)
      case 'panelRead': return panelRead(root, p)
      case 'panelSave': {
        const name = localPath(root, p.path)
        const previous = this.writes.get(name) || Promise.resolve()
        const save = previous.catch(() => {}).then(() => panelSave(root, p))
        this.writes.set(name, save)
        try { return await save } finally { if (this.writes.get(name) === save) this.writes.delete(name) }
      }
      case 'panelChanges': return panelChanges(root, this.workspace.lifetime.signal)
      case 'panelDiff': return panelDiff(root, p, this.workspace.lifetime.signal)
      case 'panelTerminalStart':
        if (p.chatId && !this.workspace.db.get('SELECT 1 FROM chats WHERE id=?', p.chatId))
          throw new Error('会话已不存在。')
        if (this.projectCwd(p) !== initialCwd)
          throw new Error('聊天工作目录已更改，请重新打开终端。')
        if (generation !== terminals.generation) throw new Error('终端视图已关闭。')
        return terminals.start(scope, root, p)
      default: throw new Error('不支持的工作区操作。')
    }
  }
}
