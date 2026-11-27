import { randomUUID } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { Database } from './database.mjs'
import { beginChatTitle, applyNativeTitle, suggestChatTitle } from './chat-titles.mjs'
import { WorkspacePanel } from './workspace-panel.mjs'
import { attachmentPreview } from './panel-files.mjs'
import { Schedules } from './schedules.mjs'
import { Accounts } from './accounts.mjs'
import { authExpiredError, isAuthExpiredError } from './auth-errors.mjs'
import { redact } from './native.mjs'
import { ComposerSettings, validateSelection } from './composer.mjs'
import { AttachmentStore } from './attachments.mjs'
import { protectedNativePaths } from './codex-permissions.mjs'
import { commandName } from './adapters/native-slash.mjs'
import { groupPrompt } from './group-context.mjs'
import { forkConversation, directForkPrompt } from './chat-fork.mjs'
import { manageChat } from './chat-management.mjs'
import { agentEntries, agentSummary, saveAgentEntries } from './subagents.mjs'
import { labelLegacySubagents } from './subagent-names.mjs'
import { readAntigravityChildren } from './adapters/antigravity-subagents.mjs'
import { agentActivity } from './adapters/chat-activity.mjs'
import { draftProjectCwd, chatProjectCwd, configureNewChatProject, inheritProject, manageProject } from './projects.mjs'

const active = "('queued','running','approval')"
const stamp = () => new Date().toISOString()
function catalogKey(account) {
  return JSON.stringify([account.id, account.provider, account.identity, account.status, account.bin,
    account.source, account.credentialSource, account.managed, account.plan,
    account.provider === 'antigravity' ? account.model : null])
}
function actionCatalogKey(scope) {
  return JSON.stringify([catalogKey(scope.account), scope.cwd, scope.threadId,
    scope.bot.model || scope.account.model, scope.bot.effort, scope.permission, scope.bot.planMode || false])
}
function draftActionSettings(input, bot, adapter) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('草稿会话设置无效。')
  const model = input.model ?? bot.model, effort = input.effort ?? bot.effort
  if (typeof model !== 'string' || model.length > 500 || typeof effort !== 'string' || effort.length > 120)
    throw new Error('请选择原生工具列出的模型和思考强度。')
  const permission = Object.hasOwn(input, 'permission') ? input.permission : 'default'
  if (!(adapter.permissionModes || ['default']).includes(permission))
    throw new Error('此原生工具不支持所选权限模式。')
  if (input.planMode !== undefined && typeof input.planMode !== 'boolean') throw new Error('计划模式设置无效。')
  return { model, effort, permission, planMode: permission === 'plan' || input.planMode === true }
}
function required(value, max = 120) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error('内容为空或超过长度限制。')
  return redact(value.trim())
}
const draftIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
function requireDraftId(draft) {
  if (typeof draft?.id !== 'string' || !draftIdPattern.test(draft.id)) throw new Error('无效的会话草稿。')
}
function slashName(name) {
  if (typeof name !== 'string' || name.length > 200 || !commandName.test(name))
    throw new Error('快捷命令名称无效。')
  return name
}
function directory(value) {
  if (!value) return ''
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0'))
    throw new Error('请选择有效的绝对工作目录。')
  return value
}

export class Workspace {
  constructor(options) {
    this.root = options.root
    this.db = new Database(this.root)
    // The executable is discovered at launch. Accounts and native thread IDs
    // have independent lifetimes and survive an upgrade or a change of install.
    if (options.codexExecutable) {
      this.db.run(
        `UPDATE accounts SET info=json_remove(json_set(info,'$.bin',?),'$.model')
         WHERE provider='codex' AND json_extract(info,'$.bin') IS NOT ?`,
        options.codexExecutable, options.codexExecutable,
      )
    }
    this.notify = options.notify || (() => {})
    this.onChatDeleted = options.onChatDeleted
    this.hasWindowChatTerminal = options.hasWindowChatTerminal
    this.pickDirectory = options.pickDirectory
    this.openProjectDirectory = options.openProjectDirectory
    this.revealProjectDirectory = options.revealProjectDirectory
    this.pickFiles = options.pickFiles
    this.makeThumbnail = options.makeThumbnail
    this.openAntigravityInstall = options.openAntigravityInstall
    this.installAntigravityCli = options.installAntigravityCli
    this.adapters = options.adapters
    this.panel = new WorkspacePanel(this)
    this.accounts = new Accounts(this, options)
    this.composer = new ComposerSettings(this)
    this.attachments = new AttachmentStore(this.root, this.db)
    this.lifetime = new AbortController()
    this.pendingAccounts = new Set()
    this.modelCatalogs = new Map()
    this.actionCatalogs = new Map()
    this.bindingRevisions = new Map()
    this.threadEdits = new Map()
    this.lanes = new Map()
    this.running = new Map()
    this.subagentReads = new Map()
    this.closed = false
    this.schedules = new Schedules(this)
  }
  snapshot() {
    const permissionModes = Object.fromEntries(Object.entries(this.adapters)
      .map(([name, adapter]) => [name, adapter.permissionModes || ['default']]))
    const state = this.db.snapshot()
    labelLegacySubagents(this.db, state.tasks, state.messages)
    for (const account of state.accounts) account.bindingRevision = this.bindingRevisions.get(account.id) || 0
    return { ...state, permissionModes, schedules: this.schedules.snapshot(), nativeThreads: this.db.all('SELECT chatId,botId,threadId,cwd FROM threads') }
  }
  invalidateCatalogs(accountId) {
    this.modelCatalogs.delete(accountId)
    this.actionCatalogs.delete(accountId)
    this.bindingRevisions.set(accountId, (this.bindingRevisions.get(accountId) || 0) + 1)
  }
  busyAccount(id) {
    return (
      [...this.threadEdits.values()].some(edit => edit.accountId === id) ||
      [...this.running.values()].some((state) => state.accountId === id) ||
      Boolean(this.db.get(`SELECT 1 FROM tasks WHERE accountId=? AND status IN ${active}`, id))
    )
  }
  bot(id, allowArchived = false) {
    const bot = this.db.get('SELECT * FROM bots WHERE id=?', id)
    if (!bot || (bot.archived && !allowArchived)) throw new Error('此 Bot 已移除。')
    return bot
  }
  members(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100) throw new Error('请选择成员。')
    return [...new Set(ids)].map((id) => this.bot(id))
  }
  async accountOperation(operation) {
    this.pendingAccounts.add(operation)
    try {
      return await operation
    } finally {
      this.pendingAccounts.delete(operation)
    }
  }
  chatDirectory(chatId, bot, draft) {
    if (draft) {
      requireDraftId(draft)
      if (chatId || !Array.isArray(draft.members) || !draft.members.includes(bot.id))
        throw new Error('该 Bot 不属于当前草稿。')
    }
    const thread = chatId && this.db.get('SELECT cwd FROM threads WHERE chatId=? AND botId=?', chatId, bot.id)
    const fork = chatId && this.db.get('SELECT cwd FROM fork_member_context WHERE chatId=? AND botId=?', chatId, bot.id)
    return thread?.cwd || fork?.cwd || (draft ? draftProjectCwd(this.db, draft) : chatProjectCwd(this.db,chatId)) || bot.cwd ||
      this.db.get("SELECT json_extract(info,'$.cwd') AS cwd FROM accounts WHERE id=?", bot.accountId)?.cwd ||
      join(this.root, 'workspaces', chatId || draft?.id || '.catalog')
  }
  chatDirectories(chatId) {
    if (typeof chatId !== 'string' || !this.db.get('SELECT 1 FROM chats WHERE id=?', chatId))
      throw new Error('会话已不存在。')
    const directories = new Map()
    const members = this.db.all(`SELECT b.* FROM members m JOIN bots b ON b.id=m.botId
      WHERE m.chatId=? ORDER BY m.rowid`, chatId)
    for (const bot of members) {
      const cwd = this.chatDirectory(chatId, bot)
      if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.includes('\0')) continue
      const directory = resolve(cwd)
      if (!directories.has(directory)) directories.set(directory, { botId: bot.id, names: [], directory })
      directories.get(directory).names.push(bot.name)
    }
    return [...directories.values()]
  }
  async ensureChatDirectory(chatId, bot, draft) {
    return this.ensureDirectory(this.chatDirectory(chatId, bot, draft), bot)
  }
  async ensureDirectory(cwd, bot) {
    const existing = await stat(cwd).catch(error => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    if (existing?.isDirectory()) return cwd
    // Only lazy-create a managed directory that has never hosted a bound
    // thread. A fork can share that directory with its source.
    if (!existing && dirname(cwd) === join(this.root, 'workspaces') && bot.cwd !== cwd &&
        !this.db.get('SELECT 1 FROM threads WHERE cwd=? LIMIT 1', cwd) &&
        !this.db.get("SELECT 1 FROM accounts WHERE id=? AND json_extract(info,'$.cwd')=?", bot.accountId, cwd)) {
      await mkdir(cwd, { recursive: true, mode: 0o700 })
      return cwd
    }
    throw new Error('原生工作目录已不存在，请恢复目录或新建会话。')
  }
  nativeContext({ chatId, botId, draft, settings: draftSettings }) {
    const bot = chatId ? this.composer.member(chatId, botId) : this.bot(botId)
    const account = this.db.account(bot.accountId)
    if (this.accounts.updating.has(account.id) || account.status !== 'ready')
      throw new Error(account.reason || '请先完成绑定账号的原生登录。')
    const thread = chatId && this.db.get(
      'SELECT threadId,cwd,accountId FROM threads WHERE chatId=? AND botId=?', chatId, botId)
    if (thread && thread.accountId !== account.id) throw new Error('原生会话与绑定账号不符。')
    const cwd = this.chatDirectory(chatId, bot, draft)
    const settings = chatId ? this.composer.read(chatId, bot) : draft && draftSettings !== undefined
      ? draftActionSettings(draftSettings, bot, this.adapters[account.provider]) : {}
    return {
      account, bot: { ...bot, ...settings }, chatId: chatId || draft?.id, cwd, threadId: thread?.threadId || null,
      permission: settings.permission || 'default', signal: this.lifetime.signal,
    }
  }
  async nativeScope(p) {
    const scope = this.nativeContext(p)
    await this.ensureDirectory(scope.cwd, scope.bot)
    if (p.draft && p.settings && (Object.hasOwn(p.settings, 'model') || Object.hasOwn(p.settings, 'effort')) &&
        (scope.bot.model || scope.bot.effort)) {
      validateSelection(await this.botOptions(scope.account.id), scope.bot.model, scope.bot.effort)
    }
    this.lifetime.signal.throwIfAborted()
    return { ...scope, ...this.protections(scope.account, scope.permission) }
  }
  protections(account, permission) {
    if (account.provider !== 'codex' || permission !== 'full') return {}
    return { protectedPaths: protectedNativePaths(this.root,
      this.db.all('SELECT id FROM accounts').map(row => this.db.account(row.id))) }
  }
  async composerActions(p) {
    const scope = this.nativeContext(p)
    const adapter = this.adapters[scope.account.provider]
    if (!adapter.composerActions) {
      await this.nativeScope(p)
      return { plan: Boolean(adapter.permissionModes?.includes('plan')), goal: false, autoReview: false, extensions: [], slashCommands: [] }
    }
    const accountId = scope.account.id
    let catalogs = this.actionCatalogs.get(accountId)
    if (!catalogs) {
      catalogs = new Map()
      this.actionCatalogs.set(accountId, catalogs)
    }
    const slot = JSON.stringify([p.chatId || null, p.draft?.id || null, p.botId])
    const key = actionCatalogKey(scope)
    let entry = catalogs.get(slot)
    if (entry?.key !== key) entry = { key, result: null, pending: null }
    catalogs.delete(slot)
    catalogs.set(slot, entry)
    if (p.refresh !== true && entry.result) return { ...entry.result, cached: true }
    if (entry.pending) return entry.pending
    const assertCurrent = () => {
      this.lifetime.signal.throwIfAborted()
      if (catalogs !== this.actionCatalogs.get(accountId) || catalogs.get(slot) !== entry ||
          actionCatalogKey(this.nativeContext(p)) !== key)
        throw new Error('账号或会话设置已变化，请重新读取原生命令。')
    }
    entry.pending = (async () => {
      const verified = await this.nativeScope(p)
      assertCurrent()
      const result = await adapter.composerActions(verified)
      assertCurrent()
      entry.result = result
      return result
    })()
    try { return await entry.pending } finally {
      entry.pending = null
      // Keep recent chats and drafts reusable without retaining every visited scope.
      for (const [oldSlot, old] of catalogs) {
        if (catalogs.size <= 64) break
        if (!old.pending) catalogs.delete(oldSlot)
      }
    }
  }
  async slashInfo(p) {
    const name = slashName(p.name)
    const scope = await this.nativeScope(p)
    const adapter = this.adapters[scope.account.provider]
    if (!adapter.slashInfo) throw new Error('此工具未提供该命令的状态面板。')
    const result = await adapter.slashInfo(scope, { name })
    return { title: required(result.title, 200),
      lines: result.lines.slice(0, 300).map(line => redact(String(line)).slice(0, 1000)) }
  }
  async forkChat({ chatId, botId }) {
    if (botId === undefined) return forkConversation(this, chatId)
    const bot = this.composer.member(chatId, botId)
    const key = chatId + '/' + botId
    if (this.threadEdits.has(key) || this.lanes.has(key))
      throw new Error('此成员的原生会话正在处理任务，请稍后创建分支。')
    this.threadEdits.set(key, { chatId, botId, accountId: bot.accountId })
    try {
      const scope = await this.nativeScope({ chatId, botId })
      if (!scope.threadId) throw new Error('先与这个成员完成一次对话，再从原生会话创建分支。')
      const adapter = this.adapters[scope.account.provider]
      if (!adapter.forkChat) throw new Error('此原生工具未提供可用的聊天分支。')
      const id = randomUUID()
      const result = await adapter.forkChat(scope, { destinationChatId: id })
      try {
        this.lifetime.signal.throwIfAborted()
        if (result.threadId === scope.threadId) throw new Error('原生工具未返回独立的分支线程。')
        this.db.transaction(() => {
          this.db.run('INSERT INTO chats VALUES(?,?,?,?)', id, 'direct', bot.name + ' · 分支', stamp())
          this.addMembers(id, [bot])
          this.associateThread(id, botId, bot.accountId, result.threadId, scope.cwd)
          this.db.run('INSERT INTO chat_forks VALUES(?,?)', id, chatId)
          inheritProject(this.db, chatId, id, scope.cwd)
          this.db.retainNativeAttachments(chatId, id, botId)
          this.db.run(`INSERT INTO composer_settings(chatId,botId,model,effort,permission,planMode)
            SELECT ?,botId,model,effort,permission,planMode FROM composer_settings WHERE chatId=? AND botId=?`,
            id, chatId, botId)
        })
      } catch (error) {
        await result.discard?.()
        throw error
      }
      this.notify()
      return id
    } finally {
      this.threadEdits.delete(key)
    }
  }
  async sendSlash(p) {
    const command = await this.prepareSlash(p)
    return this.send({ ...p, text: command.text, nativeActions: command.nativeActions }, undefined, command.slash)
  }
  async prepareSlash(p, draft) {
    if (p.replyToMessageId != null) throw new Error('原生命令不能携带群消息引用。')
    const { slash, chatId, recipients } = p
    const name = slashName(slash?.name)
    if ((!chatId && !draft) || !Array.isArray(recipients) || recipients.length !== 1 || recipients[0] !== slash.botId)
      throw new Error('快捷命令每次只能发送给所选成员。')
    if (typeof slash.arguments !== 'string' || slash.arguments.length > 200_000 ||
        (p.nativeActions && Object.keys(p.nativeActions).length))
      throw new Error('快捷命令参数无效，请单独发送所选命令。')
    const args = redact(slash.arguments.trim())
    const catalog = await this.composerActions({ chatId, botId: slash.botId, draft,
      settings: draft && p.settings?.[slash.botId], refresh: true })
    this.lifetime.signal.throwIfAborted()
    const command = catalog.slashCommands?.find(item => item.name === name)
    if (!command || !['prompt', 'compact', 'review', 'extension'].includes(command.action))
      throw new Error('当前成员的原生工具未提供可发送的此项命令，请重新选择。')
    if (draft && command.action === 'compact') throw new Error('先在此会话中发送一条消息，再压缩上下文。')
    if (command.action === 'compact' && (args || p.attachmentIds?.length))
      throw new Error('此压缩命令不接受参数或附件。')
    if (command.action === 'review' && p.attachmentIds?.length)
      throw new Error('原生代码审查仅接受工作区改动或审查说明，请先移除附件。')
    const nativeActions = command.action === 'extension'
      ? { [slash.botId]: { extensionIds: [command.extensionId], labels: [command.title || '/' + name] } }
      : {}
    return { text: '/' + name + (args ? ' ' + args : ''), nativeActions, slash: { name, args, action: command.action } }
  }
  async threadGoal({ chatId, botId, action, objective, status = 'active', replyToMessageId }) {
    if (replyToMessageId != null) throw new Error('原生目标不能携带群消息引用。')
    const bot = this.composer.member(chatId, botId)
    const account = this.db.account(bot.accountId)
    const adapter = this.adapters[account.provider]
    if (!adapter.threadGoal) throw new Error('此原生工具未提供会话目标。')
    if (!['get', 'set', 'clear'].includes(action) || !['active', 'paused'].includes(status))
      throw new Error('目标操作无效。')
    if (action === 'set') objective = required(objective, 12000)
    const key = chatId + '/' + botId
    const currentThread = this.db.get('SELECT threadId FROM threads WHERE chatId=? AND botId=?', chatId, botId)
    const pending = this.db.get('SELECT objective FROM pending_chat_goals WHERE chatId=? AND botId=?', chatId, botId)
    const forgetPending = () => {
      if (pending) this.db.run('DELETE FROM pending_chat_goals WHERE chatId=? AND botId=?', chatId, botId)
    }
    if (pending && action === 'get')
      return { threadId: currentThread?.threadId ?? null, goal: { ...pending, status: 'paused' } }
    if (action === 'get' && !currentThread) return { threadId: null, goal: null }
    const edit = { accountId: account.id, botId, chatId }
    if (action !== 'get') {
      if (this.threadEdits.has(key)) throw new Error('正在更新此成员的原生会话，请稍后重试。')
      this.threadEdits.set(key, edit)
    }
    try {
      if (action !== 'get') {
        const tasks = this.db.all(`SELECT id, json_extract(runSettings,'$.goalObjective') AS goal FROM tasks
          WHERE chatId=? AND botId=? AND status IN ${active}`, chatId, botId)
        if (pending && action === 'clear' && !tasks.some(task => task.goal)) {
          forgetPending()
          this.notify()
          return { threadId: currentThread?.threadId ?? null, goal: null }
        }
        if (tasks.some(task => !task.goal)) throw new Error('请先停止此成员的聊天任务或等待任务结束再更改目标。')
        for (const task of tasks) this.cancel(task.id)
        // A stopped process may still be pausing its native goal. Serialize its
        // cleanup with the next edit, even if the UI already shows interrupted.
        await this.lanes.get(key)
        this.lifetime.signal.throwIfAborted()
      }
      if (action === 'set' && status === 'active') {
        this.threadEdits.delete(key)
        const messageId = this.send({ chatId, recipients: [botId], text: '目标 · ' + objective }, objective)
        return { messageId, queued: true, threadId: currentThread?.threadId ?? null, goal: { objective, status } }
      }
      const scope = await this.nativeScope({ chatId, botId })
      if (action === 'clear' && !scope.threadId) {
        forgetPending()
        return { threadId: null, goal: null }
      }
      const associate = id => this.associateThread(chatId, botId, account.id, id, scope.cwd)
      const result = await adapter.threadGoal({ ...scope, action, objective, status, onSession: associate })
      if (action !== 'get' && result.threadId) associate(result.threadId)
      if (action !== 'get') forgetPending()
      this.notify()
      return result
    } finally {
      if (this.threadEdits.get(key) === edit) this.threadEdits.delete(key)
    }
  }
  associateThread(chatId, botId, accountId, id, cwd) {
    if (typeof id !== 'string' || !id || id.length > 512) throw new Error('原生会话关联无效。')
    const existing = this.db.get('SELECT threadId,accountId FROM threads WHERE chatId=? AND botId=?', chatId, botId)
    if (existing && (existing.threadId !== id || existing.accountId !== accountId))
      throw new Error('原生会话关联不符。')
    if (!existing) this.db.run('INSERT INTO threads VALUES(?,?,?,?,?)', chatId, botId, accountId, id, cwd)
  }
  async warmModelCatalogs() {
    const accounts = this.db.all("SELECT id FROM accounts WHERE json_extract(info,'$.status')='ready' ORDER BY rowid")
    // Warm one account at a time. The active chat can request its account immediately.
    for (const { id } of accounts) {
      if (this.closed) return
      try { await this.botOptions(id) } catch { /* A foreground read can retry a failed startup probe. */ }
    }
  }
  async botOptions(accountId, refresh = false) {
    const account = this.db.account(accountId)
    if (account.status !== 'ready')
      return { models: [], reason: account.reason || '请先核实此账号的原生登录。' }
    const adapter = this.accounts.adapter(account.provider)
    if (!adapter.options) return { models: [], reason: '此版本的原生工具未提供模型选项。' }
    const key = catalogKey(account)
    let entry = this.modelCatalogs.get(accountId)
    if (entry?.key !== key) {
      entry = { key, options: null, pending: null }
      this.modelCatalogs.set(accountId, entry)
    }
    if (!refresh && entry.options) return { ...entry.options, cached: true }
    if (entry.pending) return entry.pending
    entry.pending = this.readBotOptions(adapter, account, entry)
    try {
      return await entry.pending
    } finally {
      entry.pending = null
    }
  }
  async readBotOptions(adapter, account, entry) {
    const options = await adapter.options({ account, signal: this.lifetime.signal })
    if (this.closed) throw new Error('工作台已关闭。')
    const current = this.db.account(account.id)
    if (this.modelCatalogs.get(account.id) !== entry || catalogKey(current) !== entry.key)
      throw new Error('账号配置已变化，请重新读取原生选项。')
    if (account.provider === 'codex' && typeof options.defaultModel === 'string' &&
        options.models?.some(model => model.id === options.defaultModel) &&
        options.defaultModel !== current.model) {
      this.db.run("UPDATE accounts SET info=json_set(info,'$.model',?) WHERE id=?", options.defaultModel, account.id)
      this.notify()
    }
    entry.options = options
    return options
  }
  async saveBot(p, editing) {
    // TODO: add an explicit API-key Bot account type here in a future release.
    const prev = editing ? this.bot(p.id) : null
    const account = this.db.account(prev?.accountId ?? p.accountId)
    const name = required(p.name)
    const cwd = directory(editing ? p.cwd : p.cwd || account.cwd)
    const model = p.model ?? prev?.model ?? ''
    const effort = p.effort ?? prev?.effort ?? ''
    if (typeof model !== 'string' || typeof effort !== 'string')
      throw new Error('请选择原生工具列出的模型和思考强度。')
    if ((model || effort) && (!prev || model !== prev.model || effort !== prev.effort)) {
      const catalog = await this.botOptions(account.id)
      validateSelection(catalog, model, effort)
    }
    const id = prev?.id ?? randomUUID()
    if (prev) {
      this.bot(id)
      this.db.run(
        'UPDATE bots SET name=?,cwd=?,model=?,effort=? WHERE id=?',
        name, cwd, model, effort, id,
      )
    } else {
      this.db.account(account.id)
      this.db.run(
        'INSERT INTO bots(id,accountId,name,cwd,model,effort) VALUES(?,?,?,?,?,?)',
        id, account.id, name, cwd, model, effort,
      )
    }
    this.notify()
    return id
  }
  async handle(method, p = {}, context = {}) {
    if (this.closed) throw new Error('工作台已关闭。')
    if (typeof method === 'string' && method.startsWith('panel')) return this.accountOperation(this.panel.handle(method, p, context.terminals))
    if (typeof method === 'string' && method.startsWith('schedule:')) return this.accountOperation(this.schedules.handle(method, p))
    switch (method) {
      case 'snapshot':
        return this.snapshot()
      case 'agentTranscript':
        return agentEntries(this.db, p)
      case 'refreshSubagents':
        return this.refreshSubagents(p.chatId)
      case 'suggestChatTitle':
        return suggestChatTitle(this.db, p.chatId)
      case 'chatDirectories':
        return this.chatDirectories(p.chatId)
      case 'pickDirectory':
        return this.pickDirectory(context.window)
      case 'pickAttachments':
        return this.accountOperation(this.attachments.pick(p.scope, () => this.pickFiles(context.window)))
      case 'addAttachments':
        return this.accountOperation(this.attachments.add(p.scope, p.files))
      case 'listAttachments':
        return this.attachments.list(p.scope)
      case 'removeAttachment':
        return this.accountOperation(this.attachments.remove(p.scope, p.id))
      case 'attachmentThumbnail':
        return this.accountOperation(this.attachments.thumbnail(p.scope, p.id, this.makeThumbnail))
      case 'attachmentPreview':
        return this.accountOperation(attachmentPreview(this.attachments, p, this.makeThumbnail))
      case 'setComposerSettings':
        return this.accountOperation(this.composer.set(p))
      case 'composerActions':
        return this.accountOperation(this.composerActions(p))
      case 'slashInfo':
        return this.accountOperation(this.slashInfo(p))
      case 'forkChat':
        return this.accountOperation(this.forkChat(p))
      case 'forkChatInWorktree':
        return this.accountOperation(forkConversation(this, p.chatId, true))
      case 'threadGoal':
        return this.accountOperation(this.threadGoal(p))
      case 'refreshQuota':
        return this.accountOperation(this.composer.refresh(p))
      case 'openAntigravityInstall':
        return this.openAntigravityInstall()
      case 'installAntigravityCli':
        return this.accountOperation(this.installAntigravityCli(this.lifetime.signal))
      case 'detect':
        return this.accountOperation(this.accounts.detect(p))
      case 'import':
        return this.accountOperation(this.accounts.import(p))
      case 'login':
        return this.accountOperation(this.accounts.login(p, context.window))
      case 'cancelLogin':
        return this.accounts.cancelLogin(p, context.window)
      case 'removeAccount':
        return this.accountOperation(this.accounts.remove(p))
      case 'finishOnboarding':
        this.db.run("INSERT OR REPLACE INTO settings VALUES ('onboarded','yes')")
        break
      case 'note':
        this.db.account(p.id)
        this.db.run(
          'UPDATE accounts SET note=? WHERE id=?',
          redact(p.note || '').slice(0, 1000),
          p.id,
        )
        break
      case 'botOptions':
        return this.accountOperation(this.botOptions(p.accountId, p.refresh === true))
      case 'createBot':
        return this.accountOperation(this.saveBot(p, false))
      case 'editBot':
        return this.accountOperation(this.saveBot(p, true))
      case 'removeBot':
        this.bot(p.id)
        if ([...this.threadEdits.values()].some(edit => edit.botId === p.id) ||
            this.db.get(`SELECT 1 FROM tasks WHERE botId=? AND status IN ${active}`, p.id))
          throw new Error('请先结束此 Bot 的任务。')
        this.db.run('UPDATE bots SET archived=1 WHERE id=?', p.id)
        break
      case 'createChat':
        return this.createChat(p)
      case 'createProject':
      case 'updateProject':
      case 'setProjectPinned':
      case 'removeProject':
      case 'moveChatToProject':
      case 'setInitialChatProject':
      case 'openProjectFolder':
      case 'revealProjectFolder':
      case 'moveProjectToSection':
      case 'archiveProjectChats':
        return manageProject(this, method, p)
      case 'createChatSection':
        return p.projectId === undefined ? this.accountOperation(manageChat(this, method, p)) : manageProject(this, method, p)
      case 'renameChat':
      case 'setChatPinned':
      case 'setChatUnread':
      case 'setChatArchived':
      case 'moveChatToSection':
      case 'deleteChat':
        return this.accountOperation(manageChat(this, method, p))
      case 'editGroup': {
        if (this.db.get('SELECT kind FROM chats WHERE id=?', p.id)?.kind !== 'group')
          throw new Error('此会话不是群聊。')
        const members = this.members(p.members)
        if ([...this.threadEdits.values()].some(edit => edit.chatId === p.id) ||
            this.db.get(`SELECT 1 FROM tasks WHERE chatId=? AND status IN ${active}`, p.id))
          throw new Error('请在任务结束后修改成员。')
        this.db.transaction(() => {
          const previous = this.db.get('SELECT name FROM chats WHERE id=?', p.id).name
          const name = p.name == null ? previous : required(p.name)
          if (previous !== name)
            this.db.run('DELETE FROM chat_title_requests WHERE chatId=?', p.id)
          this.db.run(
            'UPDATE chats SET name=?,updatedAt=? WHERE id=?',
            name,
            stamp(),
            p.id,
          )
          this.db.run('DELETE FROM members WHERE chatId=?', p.id)
          this.addMembers(p.id, members)
        })
        break
      }
      case 'sendDraft':
        return this.accountOperation(this.sendDraft(p))
      case 'send':
        return p.slash == null ? this.send(p) : this.accountOperation(this.sendSlash(p))
      case 'approve':
        return this.decide(p)
      case 'answerQuestions':
        return this.answerQuestions(p)
      case 'cancel':
        return this.cancel(p.taskId)
      default:
        throw new Error('不支持的工作台操作。')
    }
    this.notify()
  }
  addMembers(chatId, bots) {
    for (const bot of bots) this.db.run('INSERT INTO members VALUES(?,?)', chatId, bot.id)
  }
  createChat(p) {
    const id = randomUUID()
    this.db.transaction(() => this.insertChat(id, p))
    this.notify()
    return id
  }
  insertChat(id, p) {
    const bots = this.members(p.members)
    if (!['direct', 'group'].includes(p.kind) || (p.kind === 'direct' && bots.length !== 1))
      throw new Error('请选择有效的会话成员。')
    const explicitName = p.kind === 'group' && p.name != null && (typeof p.name !== 'string' || p.name.trim())
      ? required(p.name) : null
    this.db.run(
      'INSERT INTO chats VALUES(?,?,?,?)',
      id,
      p.kind,
      explicitName || (p.kind === 'group' ? '新群聊' : bots[0].name),
      stamp(),
    )
    this.addMembers(id, bots)
    configureNewChatProject(this.db, id, p)
    if (!explicitName) this.db.run('INSERT INTO chat_title_requests(chatId) VALUES(?)', id)
  }
  async sendDraft(p) {
    const { draft, settings = {}, pausedGoals = {} } = p
    requireDraftId(draft)
    if (p.chatId != null) throw new Error('请选择草稿或已有会话。')
    const chatId = draft.id
    // The first user message shares the draft UUID. Retrying after a lost IPC
    // reply can recover the committed result without submitting another turn.
    const committed = () => this.db.get("SELECT id FROM messages WHERE chatId=? AND id=? AND author='user'", chatId, chatId)
    const result = { chatId, messageId: chatId }
    if (committed()) return result
    const bots = this.members(draft.members)
    if (!['direct', 'group'].includes(draft.kind) || (draft.kind === 'direct' && bots.length !== 1))
      throw new Error('请选择有效的会话成员。')
    const bindings = bots.map(bot => catalogKey(this.db.account(bot.accountId)))
    for (const values of [settings, pausedGoals]) {
      if (!values || typeof values !== 'object' || Array.isArray(values) ||
          Object.keys(values).some(id => !bots.some(bot => bot.id === id)))
        throw new Error('草稿设置必须属于所选会话成员。')
    }
    const saves = []
    const goals = []
    for (const bot of bots) {
      if (Object.hasOwn(settings, bot.id)) {
        const update = settings[bot.id]
        if (!update || typeof update !== 'object' || Array.isArray(update))
          throw new Error('草稿会话设置无效。')
        if (Object.keys(update).length)
          saves.push(await this.composer.prepare({ ...update, chatId: undefined }, bot, draft))
      }
      if (Object.hasOwn(pausedGoals, bot.id)) {
        if (!this.accounts.adapter(this.db.account(bot.accountId).provider).threadGoal)
          throw new Error('此原生工具未提供会话目标。')
        goals.push([bot.id, required(pausedGoals[bot.id], 12000)])
      }
    }
    let submission = { ...p, chatId }, slash, objective
    if (p.goalObjective !== undefined) {
      const target = Array.isArray(p.recipients) && p.recipients.length === 1 &&
        bots.find(bot => bot.id === p.recipients[0])
      if (!target || p.slash || p.replyToMessageId || p.attachmentIds?.length || Object.keys(p.nativeActions || {}).length)
        throw new Error('请单独向一个成员发送目标。')
      if (!this.accounts.adapter(this.db.account(target.accountId).provider).threadGoal)
        throw new Error('此原生工具未提供会话目标。')
      objective = required(p.goalObjective, 12000)
      submission.text = '目标 · ' + objective
    } else if (p.slash != null) {
      const command = await this.prepareSlash(p, draft)
      submission.text = command.text
      submission.nativeActions = command.nativeActions
      slash = command.slash
    }
    this.lifetime.signal.throwIfAborted()
    if (committed()) return result
    if (bots.some((bot, i) => catalogKey(this.db.account(bot.accountId)) !== bindings[i]))
      throw new Error('账号配置已变化，请重新确认草稿设置。')
    const scope = draft.legacyHome === true && draft.kind === 'direct' ? 'home:' + bots[0].id : 'draft:' + chatId
    this.send(submission, objective, slash, { draft, scope, apply: () => {
      for (const save of saves) save(chatId)
      for (const [botId, goal] of goals)
        this.db.run('INSERT INTO pending_chat_goals VALUES(?,?,?)', chatId, botId, goal)
    } })
    return result
  }
  send({ chatId, recipients, text = '', attachmentIds = [], nativeActions = {}, replyToMessageId = null, expectedProjectCwd }, goalObjective, slash, first) {
    const messageId = first ? first.draft.id : randomUUID()
    const now = stamp()
    const tasks = this.db.transaction(() => {
      if (first) {
        this.insertChat(chatId, first.draft)
        first.apply()
      }
      if (this.db.get('SELECT archived FROM chat_organization WHERE chatId=?', chatId)?.archived)
        throw new Error('请先恢复已归档的聊天，再发送消息。')
      if (!Array.isArray(attachmentIds)) throw new Error('附件列表无效。')
      const bots = this.members(recipients)
      if (!nativeActions || typeof nativeActions !== 'object' || Array.isArray(nativeActions) ||
          Object.keys(nativeActions).some(id => !bots.some(bot => bot.id === id)))
        throw new Error('请将所选扩展发给对应的成员。')
      const extensionIdsByBot = new Map()
      for (const bot of bots) {
        if (!this.db.get('SELECT 1 FROM members WHERE chatId=? AND botId=?', chatId, bot.id))
          throw new Error('接收人必须属于当前会话。')
        if (this.accounts.updating?.has(bot.accountId))
          throw new Error('账号正在更新，请在更新完成后重试。')
        if (this.threadEdits.has(chatId + '/' + bot.id)) throw new Error('原生会话正在更新，请稍后发送。')
        const selection = nativeActions[bot.id]
        if (selection !== undefined) {
          const ids = selection?.extensionIds
          if (!Array.isArray(ids) || ids.length > 32 ||
              ids.some(id => typeof id !== 'string' || !id || id.length > 8192 || id.includes('\0')))
            throw new Error('原生扩展选择无效。')
          if (ids.length && !this.adapters[this.db.account(bot.accountId).provider].composerActions)
            throw new Error('此成员的原生工具未提供所选扩展。')
          if (new Set(ids).size !== ids.length) throw new Error('原生扩展选择重复。')
          extensionIdsByBot.set(bot.id, ids.slice())
        }
      }
      const hasContent = attachmentIds.length || bots.every(bot => extensionIdsByBot.get(bot.id)?.length)
      const message = hasContent && text === '' ? '' : required(text, 200_000)
      if (expectedProjectCwd !== undefined && expectedProjectCwd !== chatProjectCwd(this.db,chatId))
        throw new Error('聊天工作目录已在其他窗口更改，请确认后重新发送。')
      const chat = this.db.get('SELECT kind FROM chats WHERE id=?', chatId)
      const ordinaryGroup = chat.kind === 'group' && !slash && !goalObjective
      if (replyToMessageId !== null && (!ordinaryGroup || typeof replyToMessageId !== 'string' ||
          !this.db.get('SELECT 1 FROM messages WHERE chatId=? AND id=? AND publishSeq IS NOT NULL', chatId, replyToMessageId)))
        throw new Error('只能引用本群已发布的文字消息，请重新选择。')
      this.db.run(
        'INSERT INTO messages(id,chatId,author,name,text,createdAt,recipients,replyToMessageId) VALUES(?,?,?,?,?,?,?,?)',
        messageId,
        chatId,
        'user',
        '我',
        message,
        now,
        JSON.stringify(bots.map((b) => b.id)),
        replyToMessageId,
      )
      let groupCutoff = null
      if (ordinaryGroup) {
        groupCutoff = message ? this.db.publishGroupMessage(chatId, messageId) : this.db.groupBoundary(chatId)
      }
      const attached = attachmentIds.length ? this.attachments.claim({
        chatId, draftScope: first?.scope, homeBotId: chat.kind === 'direct' ? bots[0].id : null, messageId, ids: attachmentIds,
      }) : null
      if (first?.scope.startsWith('draft:'))
        this.db.run('UPDATE attachments SET scope=? WHERE scope=? AND messageId IS NULL', chatId, first.scope)
      const titleDescription = !slash && !goalObjective && beginChatTitle(this.db, chatId, messageId, bots, message, attached?.attachments)
      const prompt = [slash ? slash.args : message, attached?.context].filter(Boolean).join('\n\n')
      this.db.run('UPDATE chats SET updatedAt=? WHERE id=?', now, chatId)
      return bots.map((bot) => {
        const account = this.db.account(bot.accountId),
          id = randomUUID(),
          replyId = randomUUID()
        this.db.run(
          'INSERT INTO messages(id,chatId,botId,author,name,text,createdAt,recipients,taskId) VALUES(?,?,?,?,?,?,?,?,?)',
          replyId,
          chatId,
          bot.id,
          'bot',
          bot.name,
          '',
          now,
          '[]',
          id,
        )
        const extensionIds = extensionIdsByBot.get(bot.id) || []
        const labels = nativeActions[bot.id]?.labels
        // Labels are for the transcript. Only catalog-validated IDs reach the native process.
        const extensionLabels = extensionIds.map((_, index) =>
          (Array.isArray(labels) && typeof labels[index] === 'string' &&
           redact(labels[index]).trim().slice(0, 160)) || '原生扩展')
        const settings = { ...this.composer.read(chatId, bot),
          ...(slash && { slashCommand: slash.name }),
          ...(extensionIds.length && { extensionIds, extensionLabels }), ...(goalObjective && { goalObjective, planMode: false }) }
        this.db.run(
          `INSERT INTO tasks(id,chatId,botId,accountId,messageId,status,tool,createdAt,runSettings,groupCutoff)
          VALUES(?,?,?,?,?,'queued',?,?,?,?)`,
          id,
          chatId,
          bot.id,
          account.id,
          messageId,
          account.bin || account.provider,
          now,
          JSON.stringify(settings),
          groupCutoff,
        )
        return {
          titleDescription: bot.id === bots[0].id ? titleDescription : null,
          id, chatId, bot: { ...bot, model: settings.model, effort: settings.effort },
          account, prompt, replyId, messageId, groupCutoff,
          publishReview: chat.kind === 'group' && account.provider === 'codex' && slash?.action === 'review',
          permission: settings.permission, planMode: settings.planMode,
          extensionIds, goalObjective, slashCommand: slash?.action === 'extension' ? undefined : slash?.name,
          attachments: attached?.attachments || [],
        }
      })
    })
    for (const task of tasks) {
      const key = chatId + '/' + task.bot.id
      const next = (this.lanes.get(key) || Promise.resolve()).then(() => this.execute(task))
      this.lanes.set(key, next)
      next.finally(() => {
        if (this.lanes.get(key) === next) this.lanes.delete(key)
      })
    }
    this.notify()
    return messageId
  }
  async execute({ id, chatId, titleDescription, bot, account, prompt, replyId, messageId, groupCutoff, publishReview, permission, planMode, extensionIds, goalObjective, slashCommand, attachments }) {
    if (this.closed || this.db.get('SELECT status FROM tasks WHERE id=?', id)?.status !== 'queued')
      return
    const controller = new AbortController()
    const state = { controller, accountId: account.id, approval: null, verified: false }
    this.running.set(id, state)
    this.db.run("UPDATE tasks SET status='running',startedAt=? WHERE id=?", stamp(), id)
    this.notify()
    let rawText = '',
      flushTimer,
      sawToolSinceLastSegment = false
    const segments = []
    const joinSegments = () => {
      if (!segments.length) return ''
      if (segments.length === 1) return segments[0].text
      let combined = segments[0].text
      for (let i = 1; i < segments.length; i++) {
        const piece = segments[i].text
        if (!piece) continue
        if (!combined) combined = piece
        else if (combined.endsWith('\n\n') || piece.startsWith('\n\n') || (combined.endsWith('\n') && piece.startsWith('\n')))
          combined += piece
        else if (combined.endsWith('\n') || piece.startsWith('\n'))
          combined += '\n' + piece
        else combined += '\n\n' + piece
      }
      return combined
    }
    const serializedSegments = () =>
      segments.length
        ? JSON.stringify(
            segments.map((s) => ({
              id: redact(String(s.id || '')).slice(0, 160),
              text: redact(s.text),
              ...(s.phase && { phase: redact(String(s.phase)).slice(0, 64) }),
            })),
          )
        : null
    const flushText = () => {
      if (!flushTimer) return
      clearTimeout(flushTimer)
      flushTimer = null
      this.db.run('UPDATE messages SET text=?,segments=? WHERE id=?', redact(rawText), serializedSegments(), replyId)
      if (!this.closed) this.notify()
    }
    try {
      if (account.status !== 'ready') {
        if (account.status === 'login' || account.loginState === 'signed-out') {
          throw authExpiredError(account.reason || '此账号登录已失效，请重新授权。')
        }
        throw new Error(account.reason || '此账号需要重新授权或无法隔离。')
      }
      const thread = this.db.get('SELECT threadId,cwd,accountId FROM threads WHERE chatId=? AND botId=?', chatId, bot.id)
      if (thread && thread.accountId !== account.id) throw new Error('原生会话与绑定账号不符。')
      const cwd = await this.ensureChatDirectory(chatId, bot)
      controller.signal.throwIfAborted()
      let nativeThreadId = thread?.threadId ?? null
      const seed = !goalObjective && !slashCommand && !publishReview && groupCutoff == null &&
        this.db.get('SELECT seedMessageId FROM fork_member_context WHERE chatId=? AND botId=?', chatId, bot.id)?.seedMessageId
      if (seed) prompt = directForkPrompt(this.db, this.attachments.dir, chatId, seed, prompt)
      if (groupCutoff != null) {
        prompt = groupPrompt(this.db, {
          chatId, bot: { ...bot, model: bot.model || account.model }, threadId: nativeThreadId,
          cutoff: groupCutoff, messageId, prompt,
        })
      }
      await this.adapters[account.provider].run({
        account,
        bot,
        chatId,
        cwd,
        threadId: thread?.threadId || null,
        prompt,
        slashCommand,
        publicReview: publishReview,
        permission,
        planMode,
        extensionIds,
        goalObjective,
        attachments,
        titleRequest: titleDescription ? () => !this.closed && !controller.signal.aborted &&
          this.db.get('SELECT 1 FROM chat_title_requests WHERE chatId=? AND messageId=? AND botId=?',
            chatId, messageId, bot.id) && titleDescription : undefined,
        ...this.protections(account, permission),
        signal: controller.signal,
        emit: (event) => {
          if (this.closed || controller.signal.aborted) return
          const val = typeof event.value === 'string' ? redact(event.value) : ''
          if (event.type === 'identity' && val.trim()) {
            if (event.key && event.key !== account.identity)
              throw new Error('原生运行身份与绑定账号不符。')
            state.verified = true
            this.db.run(
              'UPDATE tasks SET identity=?,verifiedKey=? WHERE id=?',
              val.slice(0, 300),
              redact(event.key || '').slice(0, 500),
              id,
            )
          } else {
            if (!state.verified) throw new Error('原生工具尚未核验运行身份，已停止执行。')
            switch (event.type) {
              case 'session':
                this.associateThread(chatId, bot.id, account.id, val, cwd)
                nativeThreadId = val
                break
              case 'title':
                applyNativeTitle(this.db, chatId, messageId, bot.id, event.value)
                break
              case 'goal':
                if (goalObjective && event.value?.objective === goalObjective)
                  this.db.run('DELETE FROM pending_chat_goals WHERE chatId=? AND botId=?', chatId, bot.id)
                if (event.value?.status) this.event(id, '原生目标 · ' + event.value.status)
                break
              case 'text': {
                const chunk = String(event.value)
                const itemId = typeof event.itemId === 'string' && event.itemId ? event.itemId : null
                if (itemId) {
                  let target = segments.at(-1)?.id === itemId ? segments.at(-1) : null
                  if (!target) {
                    const existing = segments.find((s) => s.id === itemId)
                    if (existing && !sawToolSinceLastSegment) target = existing
                    else {
                      target = { id: itemId, text: '', ...(event.phase && { phase: event.phase }) }
                      segments.push(target)
                    }
                  } else if (event.phase && !target.phase) {
                    target.phase = event.phase
                  }
                  target.text += chunk
                } else if (!segments.length || sawToolSinceLastSegment) {
                  segments.push({ id: 'seg-' + segments.length, text: chunk, ...(event.phase && { phase: event.phase }) })
                } else {
                  segments.at(-1).text += chunk
                }
                sawToolSinceLastSegment = false
                rawText = joinSegments()
                if (!flushTimer) flushTimer = setTimeout(flushText, 65)
                return
              }
              case 'tool':
                if (event.kind !== 'meta' && segments.length > 0) sawToolSinceLastSegment = true
                this.event(id, val, { ...event, segment: segments.length })
                break
              case 'agentTranscript':
                saveAgentEntries(this.db, id, event)
                break
              case 'context':
                this.composer.recordContext(chatId, bot.id, event.value)
                break
              case 'metrics':
                this.composer.recordMetrics(chatId, bot.id, event.value, id)
                break
              case 'quota':
                this.composer.recordQuota(account.id, event.value)
                break
            }
          }
          this.notify()
        },
        approve: (request) => this.requestApproval(id, state, request),
        ask: (questions) => this.requestAnswers(id, state, questions),
      })
      if (!state.verified) throw new Error('工具未返回可核验的运行身份。')
      if (!controller.signal.aborted && !this.closed) {
        clearTimeout(flushTimer)
        flushTimer = null
        const text = redact(rawText)
        const savedSegments = serializedSegments()
        const publish = (groupCutoff != null || publishReview) && Boolean(text.trim())
        this.db.transaction(() => {
          this.db.run('UPDATE messages SET text=?,segments=?,nativeThreadId=? WHERE id=?', text, savedSegments, publish ? nativeThreadId : null, replyId)
          this.db.run("UPDATE tasks SET status='done',approval=NULL,completedAt=? WHERE id=?", stamp(), id)
          if (goalObjective)
            this.db.run('DELETE FROM pending_chat_goals WHERE chatId=? AND botId=?', chatId, bot.id)
          if (seed && nativeThreadId)
            this.db.run('UPDATE fork_member_context SET seedMessageId=NULL WHERE chatId=? AND botId=?', chatId, bot.id)
          if (publish) this.db.publishGroupMessage(chatId, replyId)
          if (groupCutoff != null && nativeThreadId) {
            this.db.run(`INSERT INTO group_delivery(chatId,botId,threadId,throughSeq) VALUES(?,?,?,?)
              ON CONFLICT(chatId,botId,threadId) DO UPDATE SET throughSeq=max(throughSeq,excluded.throughSeq)`,
              chatId, bot.id, nativeThreadId, groupCutoff)
          }
        })
      }
    } catch (e) {
      if (!this.closed && !controller.signal.aborted) {
        const message = redact(e.message || '原生工具执行失败。').slice(0, 1200)
        const authExpired = isAuthExpiredError(e) ? 1 : 0
        this.db.run(
          "UPDATE tasks SET status='failed',approval=NULL,error=?,authExpired=?,completedAt=? WHERE id=?",
          message,
          authExpired,
          stamp(),
          id,
        )
      }
    } finally {
      flushText()
      state.approval?.resolve(false)
      this.running.delete(id)
      if (!this.closed) this.notify()
    }
  }
  event(id, text, extra = {}) {
    const { agent, source, segment } = extra
    const summary = agentSummary(agent)
    if (summary) {
      this.db.run(
        "UPDATE tasks SET events=json_insert(events,'$[#]',json(?)) WHERE id=?",
        JSON.stringify({
          text: redact(text).slice(0, 2000),
          agent: summary,
          source,
          ...(Number.isInteger(segment) && { segment }),
          observedAt: Date.now(),
        }),
        id,
      )
      return
    }
    const callId = typeof extra.callId === 'string' && extra.callId ? redact(extra.callId).slice(0, 160) : undefined
    const entry = {
      text: redact(text).slice(0, 2000),
      agent: undefined,
      source,
      ...(typeof extra.kind === 'string' && extra.kind && { kind: extra.kind.slice(0, 40) }),
      ...(callId && { callId }),
      ...(typeof extra.status === 'string' && extra.status && { status: extra.status.slice(0, 32) }),
      ...(typeof extra.command === 'string' && extra.command && { command: redact(extra.command).slice(0, 800) }),
      ...(typeof extra.commandKind === 'string' && extra.commandKind && { commandKind: extra.commandKind.slice(0, 24) }),
      ...(Number.isInteger(extra.exitCode) && { exitCode: extra.exitCode }),
      ...(typeof extra.output === 'string' && extra.output && { output: redact(extra.output).slice(0, 3400) }),
      ...(typeof extra.path === 'string' && extra.path && { path: redact(extra.path).slice(0, 480) }),
      ...(Number.isInteger(extra.line) && extra.line > 0 && { line: extra.line }),
      ...(typeof extra.query === 'string' && extra.query && { query: redact(extra.query).slice(0, 240) }),
      ...(Array.isArray(extra.files) && extra.files.length > 0 && { files: extra.files.slice(0, 24) }),
      ...(typeof extra.label === 'string' && extra.label && { label: redact(extra.label).slice(0, 200) }),
      ...(typeof extra.detail === 'string' && extra.detail && { detail: redact(extra.detail).slice(0, 320) }),
      ...(Number.isInteger(segment) && { segment }),
    }
    if (callId) {
      const row = this.db.get('SELECT events FROM tasks WHERE id=?', id)
      if (row?.events) {
        const list = JSON.parse(row.events)
        const existingIndex = list.findIndex((item) => !item.agent && item.callId === callId)
        if (existingIndex >= 0) {
          const prior = list[existingIndex]
          list[existingIndex] = {
            ...prior,
            ...entry,
            segment: Number.isInteger(prior.segment) ? prior.segment : entry.segment,
            source: entry.source ?? prior.source,
          }
          this.db.run('UPDATE tasks SET events=? WHERE id=?', JSON.stringify(list), id)
          return
        }
      }
    }
    this.db.run(
      "UPDATE tasks SET events=json_insert(events,'$[#]',json(?)) WHERE id=?",
      JSON.stringify(entry),
      id,
    )
  }
  refreshSubagents(chatId) {
    if (typeof chatId !== 'string' || !chatId || chatId.length > 160) return
    const pending = this.subagentReads.get(chatId)
    if (pending) return pending
    const request = this.accountOperation(this.readSubagentArchives(chatId))
    this.subagentReads.set(chatId, request)
    return request.finally(() => this.subagentReads.delete(chatId))
  }
  async readSubagentArchives(chatId) {
    const dispatches = this.db.all(`SELECT t.id AS taskId,t.status AS taskStatus,t.accountId,e.agentId,e.text AS prompt,t.events,n.threadId,
        json_extract(a.info,'$.source') AS home
      FROM tasks t JOIN subagent_entries e ON e.taskId=t.id
      JOIN accounts a ON a.id=t.accountId AND a.provider='antigravity'
      JOIN threads n ON n.chatId=t.chatId AND n.botId=t.botId AND n.accountId=t.accountId
      WHERE t.chatId=? AND e.entryId='dispatch-prompt' AND e.role='user'
        AND substr(e.agentId,1,4)='agy:' AND json_extract(a.info,'$.managed')=1
      ORDER BY t.rowid DESC,e.rowid LIMIT 301`, chatId)
    if (dispatches.length > 300) return
    const groups = new Map()
    const byTask = new Map()
    for (const row of dispatches) {
      if (this.running.has(row.taskId)) continue // The live ACP adapter publishes its own archive updates.
      if (typeof row.home !== 'string' || !this.accounts.ownsProfile(row.home)) continue
      const [, parent, call] = row.agentId.split(':')
      if (!call || parent !== row.threadId) continue
      if (!byTask.has(row.taskId))
        byTask.set(row.taskId, new Map(JSON.parse(row.events).filter(event => event.agent).map(({ agent }) => [agent.id, agent])))
      const agent = byTask.get(row.taskId).get(row.agentId)
      if (
        !agent ||
        (!agent.nativeThreadId && ['errored', 'interrupted'].includes(agent.status)) ||
        (row.taskStatus === 'failed' && !agent.nativeThreadId)
      )
        continue
      const key = JSON.stringify([row.accountId, parent])
      if (!groups.has(key)) groups.set(key, { home: row.home, parent, dispatches: [] })
      groups.get(key).dispatches.push({
        agentId: row.agentId, taskId: row.taskId, prompt: row.prompt,
        nativeThreadId: agent.nativeThreadId,
      })
    }
    let changed = false
    for (const group of groups.values()) {
      if (this.closed) return
      for (const { taskId, agentId, nativeThreadId, status, model, entries } of
        await readAntigravityChildren(group.home, group.parent, group.dispatches)) {
        if (this.closed) return
        const task = this.db.get('SELECT events FROM tasks WHERE id=? AND chatId=?', taskId, chatId)
        if (!task) continue
        const previous = JSON.parse(task.events).findLast(event => event.agent?.id === agentId)?.agent
        if (!previous || (previous.nativeThreadId && previous.nativeThreadId !== nativeThreadId)) continue
        const next =
          ['errored', 'interrupted'].includes(previous.status) ||
          (status === 'unconfirmed' && previous.status === 'completed')
            ? previous.status
            : status
        if (previous.status !== next || previous.nativeThreadId !== nativeThreadId || (model && previous.model !== model)) {
          const activity = agentActivity(agentId, next)
          this.event(taskId, activity.value, { agent: { ...previous, ...activity.agent, nativeThreadId, ...(model && { model }) } })
          changed = true
        }
        changed = saveAgentEntries(this.db, taskId, { agent: { id: agentId }, entries }) || changed
      }
    }
    if (changed) this.notify()
  }
  requestApproval(id, state, request) {
    if (this.closed || !state.verified || state.controller.signal.aborted || state.approval)
      return Promise.resolve(false)
    const approval = {
      id: randomUUID(),
      title: redact(request.title).slice(0, 250),
      detail: redact(request.detail).slice(0, 5000),
    }
    return this.awaitUser(id, state, approval)
  }
  requestAnswers(id, state, questions) {
    if (this.closed || !state.verified || state.controller.signal.aborted || state.approval ||
        !Array.isArray(questions) || !questions.length || questions.length > 8 ||
        questions.some(q => !q || q.isSecret || typeof q.id !== 'string' || !q.id || q.id.length > 200 ||
          typeof q.question !== 'string' || !q.question || (q.options && !Array.isArray(q.options))) ||
        new Set(questions.map(q => q.id)).size !== questions.length)
      return Promise.resolve(null)
    const normalized = questions.map(q => ({
      id: q.id, question: redact(q.question).slice(0, 2400), isOther: q.isOther === true,
      options: (q.options || []).slice(0,32).filter(o => typeof o?.label === 'string' && o.label)
        .map(o => ({ label: redact(o.label).slice(0, 300), description: redact(o.description || '').slice(0, 600) })),
    }))
    return this.awaitUser(id, state, { id: randomUUID(), kind: 'questions', questions: normalized })
  }
  awaitUser(id, state, approval) {
    const answer = new Promise((resolve) => {
      state.approval = { ...approval, resolve }
    })
    this.db.run(
      "UPDATE tasks SET status='approval',approval=? WHERE id=?",
      JSON.stringify(approval),
      id,
    )
    this.notify()
    return answer
  }
  decide({ taskId, approvalId, allow }) {
    const state = this.running.get(taskId)
    if (
      !state?.approval ||
      state.approval.kind === 'questions' ||
      state.controller.signal.aborted ||
      state.approval.id !== approvalId ||
      typeof allow !== 'boolean'
    )
      throw new Error('此权限请求已结束。')
    const pending = state.approval
    state.approval = null
    this.db.run("UPDATE tasks SET status='running',approval=NULL WHERE id=?", taskId)
    this.event(taskId, (allow ? '已允许 · ' : '已拒绝 · ') + pending.title)
    pending.resolve(allow)
    this.notify()
  }
  answerQuestions({ taskId, requestId, answers }) {
    const state = this.running.get(taskId)
    const pending = state?.approval
    if (!pending || pending.kind !== 'questions' || pending.id !== requestId || state.controller.signal.aborted)
      throw new Error('此问题已结束。')
    const result = Object.create(null)
    for (const question of pending.questions) {
      const answer = answers && Object.hasOwn(answers, question.id) && answers[question.id]
      if (typeof answer !== 'string' || !answer.trim() || answer.length > 10000 ||
          (question.options.length && !question.isOther && !question.options.some(o => o.label === answer)))
        throw new Error('请回答原生工具提出的每个问题。')
      result[question.id] = { answers: [answer.trim()] }
    }
    state.approval = null
    this.db.run("UPDATE tasks SET status='running',approval=NULL WHERE id=?", taskId)
    this.event(taskId, '已回复原生工具的提问')
    pending.resolve(result)
    this.notify()
  }
  cancel(id) {
    const state = this.running.get(id)
    const result = this.db.run(
      `UPDATE tasks SET status='interrupted',approval=NULL,error='任务已停止。',completedAt=? WHERE id=? AND status IN ${active}`,
      stamp(),
      id,
    )
    if (!result.changes) throw new Error('此任务已结束。')
    state?.controller.abort()
    if (state?.approval) {
      state.approval.resolve(false)
      state.approval = null
    }
    this.notify()
  }
  close() {
    if (this.closed) return this.closing
    this.closed = true
    this.schedules.close()
    this.panel.terminals.close()
    this.lifetime.abort()
    for (const { controller, approval } of this.running.values()) {
      controller.abort()
      approval?.resolve(false)
    }
    this.accounts.cancelAllLogins()
    const pending = [...this.pendingAccounts, ...this.lanes.values()]
    if (pending.length) this.closing = Promise.allSettled(pending).then(() => this.db.db.close())
    else {
      this.db.db.close()
      this.closing = Promise.resolve()
    }
    return this.closing
  }
}
