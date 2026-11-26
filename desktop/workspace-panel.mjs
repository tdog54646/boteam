import { mkdir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { localPath, panelFiles, panelRead, panelSave, resolveWorkspaceFilePath } from './panel-files.mjs'
import { panelChanges, panelDiff } from './panel-git.mjs'
import { PanelTerminals } from './panel-terminals.mjs'
import { chatProjectCwd, draftProjectCwd } from './projects.mjs'

const sessionUuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i

export class WorkspacePanel {
  constructor(workspace) {
    this.workspace = workspace
    this.writes = new Map()
    this.pendingWrites = new Map()
    this.terminals = new PanelTerminals()
  }

  chatPreviewScopes(chatId) {
    if (!chatId) return { extraRoots: [], allowedFiles: [] }
    const db = this.workspace.db
    const lineage = []
    const seenChats = new Set()
    let cur = chatId
    while (cur && !seenChats.has(cur) && lineage.length < 16) {
      seenChats.add(cur)
      lineage.push(cur)
      cur = db.get('SELECT sourceChatId FROM chat_forks WHERE chatId=?', cur)?.sourceChatId
    }

    const extraRootSet = new Set()
    const allowedFileSet = new Set()

    for (const id of lineage) {
      for (const item of this.workspace.chatDirectories(id)) {
        if (item?.directory) extraRootSet.add(item.directory)
      }
      for (const row of db.all(
        `SELECT pf.path FROM chat_projects cp JOIN project_folders pf ON pf.projectId=cp.projectId
         WHERE cp.chatId=? ORDER BY pf.position`,
        id,
      )) {
        if (row?.path) extraRootSet.add(row.path)
      }

      const threadRows = db.all(
        `SELECT t.threadId, a.provider, json_extract(a.info, '$.source') AS source
         FROM threads t JOIN accounts a ON a.id=t.accountId
         WHERE t.chatId=?`,
        id,
      )
      for (const row of threadRows) {
        if (
          row?.provider === 'antigravity' &&
          typeof row.source === 'string' &&
          row.source &&
          sessionUuid.test(row.threadId || '')
        ) {
          extraRootSet.add(join(row.source, '.gemini', 'antigravity-cli', 'brain', row.threadId))
        }
      }

      const taskRows = db.all(
        `SELECT t.events, a.provider, json_extract(a.info, '$.source') AS source
         FROM tasks t LEFT JOIN accounts a ON a.id=t.accountId
         WHERE t.chatId=?`,
        id,
      )
      for (const task of taskRows) {
        const source = typeof task?.source === 'string' ? task.source : ''
        let events = []
        try {
          events = JSON.parse(task.events || '[]')
        } catch {
          continue
        }
        for (const ev of events) {
          if (!ev) continue
          if (task.provider === 'antigravity' && source) {
            const childId = ev.agent?.nativeThreadId
            if (sessionUuid.test(childId || '')) {
              extraRootSet.add(join(source, '.gemini', 'antigravity-cli', 'brain', childId))
            }
            const parts = typeof ev.agent?.id === 'string' ? ev.agent.id.split(':') : []
            if (parts[0] === 'agy' && sessionUuid.test(parts[1] || '')) {
              extraRootSet.add(join(source, '.gemini', 'antigravity-cli', 'brain', parts[1]))
            }
          }
          if (task.provider === 'claude' && source) {
            const plansDir = join(source, 'plans')
            const candidates = [
              ev.path,
              ...(Array.isArray(ev.files) ? ev.files.map(f => f?.path) : []),
            ]
            for (const p of candidates) {
              if (
                typeof p === 'string' &&
                isAbsolute(p) &&
                p.startsWith(plansDir + sep) &&
                /\.md$/i.test(p)
              ) {
                allowedFileSet.add(p)
              }
            }
          }
        }
      }
    }

    return { extraRoots: [...extraRootSet], allowedFiles: [...allowedFileSet] }
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
    const { extraRoots, allowedFiles } = this.chatPreviewScopes(p.chatId)
    switch (method) {
      case 'panelFiles': return panelFiles(root, p, false)
      case 'panelSearch': return panelFiles(root, { query: p.query }, true)
      case 'panelRead':
        return panelRead(root, p, {
          makeThumbnail: this.workspace.makeThumbnail,
          extraRoots,
          allowedFiles,
          allowWorkspaceAbsolute: p.allowWorkspaceAbsolute === true,
        })
      case 'panelReveal': {
        const { absolute } = await resolveWorkspaceFilePath(root, p.path, extraRoots, true, allowedFiles)
        const info = await stat(absolute).catch(() => null)
        if (!info) throw new Error('文件不存在。')
        await this.workspace.revealProjectDirectory?.(absolute)
        return true
      }
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
