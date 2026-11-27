import { redact } from './native.mjs'

export function validateSelection(catalog, model, effort) {
  if (
    typeof model !== 'string' ||
    typeof effort !== 'string' ||
    model.length > 500 ||
    effort.length > 120
  )
    throw new Error('请选择原生工具列出的模型和思考强度。')
  if (!model && !effort) return
  if (catalog.reason && !catalog.models?.length) throw new Error(catalog.reason)
  const selected = catalog.models?.find((item) => item.id === (model || catalog.defaultModel))
  if (model && !selected) throw new Error('此账号的原生工具未提供所选模型，请重新选择。')
  const levels = model ? selected?.efforts : (catalog.efforts ?? selected?.efforts)
  if (effort && !levels?.some((level) => level.id === effort))
    throw new Error('所选模型不支持此思考强度，请重新选择。')
}

export class ComposerSettings {
  constructor(workspace) {
    this.workspace = workspace
    this.db = workspace.db
    this.pendingQuota = new Map()
    this.recentQuota = new Map()
  }
  member(chatId, botId) {
    const bot = this.workspace.bot(botId)
    if (!this.db.get('SELECT 1 FROM members WHERE chatId=? AND botId=?', chatId, botId))
      throw new Error('该 Bot 不属于当前会话。')
    return bot
  }
  defaultPermission(bot, projectId) {
    return this.db.get(`SELECT coalesce(p.permission,b.permission,'default') AS mode FROM accounts a
      LEFT JOIN project_permission_defaults p ON p.provider=a.provider AND p.projectId=?
      LEFT JOIN bot_permission_defaults b ON b.botId=? WHERE a.id=?`,
      projectId ?? null, bot.id, bot.accountId)?.mode ?? 'default'
  }
  async setDefaultPermission({ botId, projectId, provider, permission, expected }) {
    const project = projectId != null
    if (project === (botId != null) || expected !== null && typeof expected !== 'string')
      throw new Error('请选择 Bot 或项目的默认权限。')
    let bot
    if (project) {
      if (typeof projectId !== 'string' || !this.db.get('SELECT 1 FROM projects WHERE id=?', projectId))
        throw new Error('项目已不存在。')
      if (typeof provider !== 'string' || !Object.hasOwn(this.workspace.adapters, provider))
        throw new Error('请选择项目使用的原生工具。')
      bot = this.db.get(`SELECT b.* FROM bots b JOIN accounts a ON a.id=b.accountId
        WHERE a.provider=? AND b.archived=0 AND json_extract(a.info,'$.status')='ready' ORDER BY b.rowid LIMIT 1`, provider)
    } else {
      bot = this.workspace.bot(botId)
      provider = this.db.account(bot.accountId).provider
    }
    if (permission !== null) {
      this.validateMode(provider, permission)
      await this.validateNativePermission(provider, permission, { botId: bot?.id, ...(project && { catalogProject: { projectId } }) })
      this.workspace.lifetime.signal.throwIfAborted()
    }
    this.db.transaction(() => {
      if (project && !this.db.get('SELECT 1 FROM projects WHERE id=?', projectId)) throw new Error('项目已不存在。')
      if (!project) this.workspace.bot(botId)
      const table = project ? 'project_permission_defaults' : 'bot_permission_defaults'
      const where = project ? 'projectId=? AND provider=?' : 'botId=?'
      const keys = project ? [projectId,provider] : [botId]
      const current = this.db.get(`SELECT permission FROM ${table} WHERE ${where}`, ...keys)?.permission ?? null
      if (current !== expected) throw new Error('默认权限已在其他窗口更改，请重新选择。')
      if (permission === null) this.db.run(`DELETE FROM ${table} WHERE ${where}`, ...keys)
      else this.db.run(`INSERT OR REPLACE INTO ${table} VALUES(${keys.map(() => '?').join(',')},?)`, ...keys, permission)
    })
    this.workspace.notify()
  }
  validateMode(provider, permission) {
    if (!(this.workspace.adapters[provider]?.permissionModes || ['default']).includes(permission))
      throw new Error('此原生工具不支持所选权限模式。')
  }
  async validateNativePermission(provider, permission, scope, checkPlan = false) {
    const autoReview = permission === 'auto-review'
    const workspaceAuto = permission === 'workspace-auto' && provider === 'antigravity'
    if (!checkPlan && !autoReview && !workspaceAuto) return
    if (!scope.botId) throw new Error('请先绑定可用的 Bot 以核实此工具的原生权限。')
    const capabilities = await this.workspace.composerActions({ ...scope, refresh: true })
    if (checkPlan && !capabilities.plan) throw new Error('当前原生工具未提供计划模式。')
    if (autoReview && !capabilities.autoReview) throw new Error('当前原生工具未提供自动审批。')
    if (workspaceAuto && !capabilities.workspaceAuto) throw new Error('当前 Antigravity 未提供工作区自动执行。')
  }
  read(chatId, bot) {
    const row = this.db.get(
      'SELECT * FROM composer_settings WHERE chatId=? AND botId=?',
      chatId,
      bot.id,
    )
    const explicit = row?.permission
    const permission = explicit && explicit !== 'inherit' ? explicit
      : this.defaultPermission(bot, this.db.get('SELECT projectId FROM chat_projects WHERE chatId=?', chatId)?.projectId)
    return {
      model: row?.model ?? bot.model,
      effort: row?.effort ?? bot.effort,
      permission,
      planMode: Boolean(row?.planMode) || permission === 'plan',
    }
  }
  async set(p) {
    const { chatId, botId } = p
    const bot = this.member(chatId, botId)
    const save = await this.prepare(p, bot)
    this.db.transaction(() => save(chatId))
    this.workspace.notify()
    return this.read(chatId, bot)
  }
  async prepare(p, bot, draft) {
    const chatId = p.chatId, botId = bot.id
    const account = this.db.account(bot.accountId)
    const hasModel = Object.hasOwn(p, 'model'),
      hasEffort = Object.hasOwn(p, 'effort')
    const adapter = this.workspace.adapters[account.provider]
    const hasPlan = Object.hasOwn(p, 'planMode')
    const hasPermission = Object.hasOwn(p, 'permission')
    if (!(hasModel || hasEffort || hasPermission || hasPlan)) throw new Error('请选择要更改的会话设置。')
    if (hasPlan && typeof p.planMode !== 'boolean') throw new Error('计划模式设置无效。')
    if (hasPermission && p.permission !== null) this.validateMode(account.provider, p.permission)
    const previous = draft ? { ...bot, permission: this.defaultPermission(bot, draft.projectId) } : this.read(chatId, bot)
    const planIsPermission = adapter.permissionModes?.includes('plan')
    const checkPlan = hasPlan && p.planMode && (!planIsPermission || adapter.composerActions)
    await this.validateNativePermission(account.provider, p.permission, { chatId, botId, draft }, checkPlan)
    const model = hasModel ? (p.model ?? bot.model) : previous.model
    const effort = hasEffort ? (p.effort ?? bot.effort) : previous.effort
    if (hasModel || hasEffort) {
      const catalog = model || effort ? await this.workspace.botOptions(account.id) : {}
      validateSelection(catalog, model, effort)
    }
    return chatId => {
      this.member(chatId, botId)
      this.db.run(
        "INSERT OR IGNORE INTO composer_settings(chatId,botId,permission) VALUES(?,?,'inherit')",
        chatId,
        botId,
      )
      if (hasModel)
        this.db.run(
          'UPDATE composer_settings SET model=? WHERE chatId=? AND botId=?',
          p.model,
          chatId,
          botId,
        )
      if (hasEffort)
        this.db.run(
          'UPDATE composer_settings SET effort=? WHERE chatId=? AND botId=?',
          p.effort,
          chatId,
          botId,
        )
      if (hasPermission) {
        this.db.run(
          'UPDATE composer_settings SET permission=? WHERE chatId=? AND botId=?',
          p.permission ?? 'inherit',
          chatId,
          botId,
        )
        if (planIsPermission && !hasPlan && p.permission !== 'plan') {
          this.db.run(
            'UPDATE composer_settings SET planMode=0 WHERE chatId=? AND botId=?',
            chatId,
            botId,
          )
        }
      }
      if (hasPlan) {
        if (planIsPermission) {
          if (p.planMode || previous.permission === 'plan') {
            this.db.run('UPDATE composer_settings SET permission=? WHERE chatId=? AND botId=?',
              p.planMode ? 'plan' : 'default', chatId, botId)
          }
        } else {
          this.db.run('UPDATE composer_settings SET planMode=? WHERE chatId=? AND botId=?',
            Number(p.planMode), chatId, botId)
        }
      }
    }
  }
  recordContext(chatId, botId, value) {
    if (
      !Number.isSafeInteger(value?.used) ||
      value.used < 0 ||
      !Number.isSafeInteger(value.limit) ||
      value.limit <= 0
    )
      return
    this.db.run(
      'INSERT OR REPLACE INTO context_usage(chatId,botId,used,"limit",model,updatedAt) VALUES(?,?,?,?,?,?)',
      chatId,
      botId,
      value.used,
      value.limit,
      redact(value.model || '').slice(0, 500),
      new Date().toISOString(),
    )
  }
  recordMetrics(chatId, botId, value, taskId = '') {
    if (!value || typeof value !== 'object') return
    const inputTokens = Number.isSafeInteger(value.inputTokens) && value.inputTokens >= 0 ? value.inputTokens : 0
    const cachedInputTokens =
      Number.isSafeInteger(value.cachedInputTokens) && value.cachedInputTokens >= 0
        ? Math.min(value.cachedInputTokens, inputTokens || value.cachedInputTokens)
        : 0
    const cacheCreationTokens =
      Number.isSafeInteger(value.cacheCreationTokens) && value.cacheCreationTokens >= 0
        ? value.cacheCreationTokens
        : 0
    const outputTokens = Number.isSafeInteger(value.outputTokens) && value.outputTokens >= 0 ? value.outputTokens : 0
    const reasoningTokens =
      Number.isSafeInteger(value.reasoningTokens) && value.reasoningTokens >= 0 ? value.reasoningTokens : 0
    const durationMs = Number.isSafeInteger(value.durationMs) && value.durationMs >= 0 ? value.durationMs : 0
    if (inputTokens <= 0 && outputTokens <= 0) return
    const tokensPerSecond =
      outputTokens > 0 && durationMs > 0
        ? Math.round((outputTokens / (durationMs / 1000)) * 10) / 10
        : Number.isFinite(value.tokensPerSecond) && value.tokensPerSecond >= 0
          ? Math.round(value.tokensPerSecond * 10) / 10
          : null
    const cacheHitPercent =
      inputTokens > 0
        ? Math.round((cachedInputTokens / inputTokens) * 1000) / 10
        : Number.isFinite(value.cacheHitPercent) && value.cacheHitPercent >= 0 && value.cacheHitPercent <= 100
          ? Math.round(value.cacheHitPercent * 10) / 10
          : null
    const safeTaskId = typeof taskId === 'string' ? taskId.slice(0, 120) : ''
    const prev = this.db.get('SELECT * FROM token_metrics WHERE chatId=? AND botId=?', chatId, botId)
    const sameTask = Boolean(prev && safeTaskId && prev.lastTaskId === safeTaskId)
    const priorInputTokens = !prev
      ? 0
      : sameTask
        ? prev.priorInputTokens
        : (prev.priorInputTokens || 0) + (prev.inputTokens || 0)
    const priorCachedTokens = !prev
      ? 0
      : sameTask
        ? prev.priorCachedTokens
        : (prev.priorCachedTokens || 0) + (prev.cachedInputTokens || 0)
    const priorOutputTokens = !prev
      ? 0
      : sameTask
        ? prev.priorOutputTokens
        : (prev.priorOutputTokens || 0) + (prev.outputTokens || 0)
    const priorDurationMs = !prev
      ? 0
      : sameTask
        ? prev.priorDurationMs
        : (prev.priorDurationMs || 0) + (prev.durationMs || 0)
    const turnCount = !prev ? 1 : sameTask ? prev.turnCount || 1 : (prev.turnCount || 1) + 1
    const model = redact(value.model || prev?.model || '').slice(0, 500)
    this.db.run(
      `INSERT OR REPLACE INTO token_metrics(
        chatId,botId,lastTaskId,inputTokens,cachedInputTokens,cacheCreationTokens,
        outputTokens,reasoningTokens,durationMs,tokensPerSecond,cacheHitPercent,
        priorInputTokens,priorCachedTokens,priorOutputTokens,priorDurationMs,
        turnCount,model,updatedAt
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      chatId,
      botId,
      safeTaskId,
      inputTokens,
      cachedInputTokens,
      cacheCreationTokens,
      outputTokens,
      reasoningTokens,
      durationMs,
      tokensPerSecond,
      cacheHitPercent,
      priorInputTokens,
      priorCachedTokens,
      priorOutputTokens,
      priorDurationMs,
      turnCount,
      model,
      new Date().toISOString(),
    )
  }
  recordQuota(accountId, value) {
    if (!Array.isArray(value?.windows)) return null
    const model =
      typeof value.model === 'string' && value.scope !== 'account'
        ? redact(value.model).slice(0, 500)
        : ''
    if (value.scope === 'model' && !model) return null
    const windows = []
    for (const w of value.windows) {
      if (
        !w ||
        ![300, 10080].includes(w.minutes) ||
        !Number.isFinite(w.remainingPercent) ||
        w.remainingPercent < 0 ||
        w.remainingPercent > 100 ||
        windows.some((v) => v.minutes === w.minutes)
      )
        continue
      if (w.resetsAt != null && (!Number.isSafeInteger(w.resetsAt) || w.resetsAt <= Date.now()))
        continue
      windows.push({
        minutes: w.minutes,
        remainingPercent: w.remainingPercent,
        ...(w.shared === true ? { shared: true } : {}),
        ...(typeof w.group === 'string' && w.group ? { group: redact(w.group).slice(0,120) } : {}),
        ...(w.resetsAt == null ? {} : { resetsAt: w.resetsAt }),
      })
    }
    if (!windows.length) return null
    windows.sort((a, b) => a.minutes - b.minutes)
    const updatedAt = new Date().toISOString()
    this.db.run(
      'INSERT OR REPLACE INTO quota_usage(accountId,model,windows,updatedAt) VALUES(?,?,?,?)',
      accountId,
      model,
      JSON.stringify(windows),
      updatedAt,
    )
    return { accountId, model, scope: model ? 'model' : 'account', windows, updatedAt }
  }
  async refresh({ chatId, botId, draftModel }) {
    const bot = chatId ? this.member(chatId, botId) : this.workspace.bot(botId)
    const account = this.db.account(bot.accountId)
    const adapter = this.workspace.adapters[account.provider]
    if (account.status !== 'ready' || !adapter.quota) return null
    let model = (chatId ? this.read(chatId, bot).model : bot.model) || account.model || ''
    if (!chatId && draftModel !== undefined) {
      const catalog = await this.workspace.botOptions(account.id)
      validateSelection(catalog, draftModel, '')
      model = draftModel || catalog.defaultModel || ''
    }
    return this.readQuota(account, model)
  }
  async accountQuota({ accountId, model = '' }) {
    const account = this.db.account(accountId)
    if (account.status !== 'ready') throw new Error(account.reason || '请先重新授权订阅账号。')
    if (!this.workspace.adapters[account.provider].quota) return null
    if (typeof model !== 'string' || model.length > 500 || (model && !this.db.get(
      'SELECT 1 FROM bots WHERE accountId=? AND archived=0 AND model=? UNION ALL SELECT 1 FROM quota_usage WHERE accountId=? AND model=? LIMIT 1',
      accountId, model, accountId, model,
    ))) throw new Error('请选择该订阅账号关联的模型。')
    return this.readQuota(account, model || account.model || '', true)
  }
  async readQuota(account, model, force = false) {
    if (this.workspace.accounts.updating.has(account.id)) throw new Error('账号绑定正在更新，请稍后读取额度。')
    const adapter = this.workspace.adapters[account.provider]
    const revision = this.workspace.bindingRevisions.get(account.id) || 0
    const key = JSON.stringify([account.id, revision, account.identity, account.source, model])
    const inFlight = this.pendingQuota.get(key)
    if (inFlight) return inFlight
    const cached = this.recentQuota.get(key)
    if (!force && cached && cached.until > Date.now()) return cached.value
    const check = (async () => {
      const quota = await adapter.quota({ account, model, signal: this.workspace.lifetime.signal })
      if (this.workspace.closed) throw new Error('工作台已关闭。')
      const current = this.db.account(account.id)
      if ((this.workspace.bindingRevisions.get(account.id) || 0) !== revision || this.workspace.accounts.updating.has(account.id) ||
        ['identity', 'source', 'credentialSource', 'bin', 'status'].some(
          (k) => current[k] !== account[k],
        )
      )
        throw new Error('账号配置已变化，请重新读取额度。')
      const value = this.recordQuota(account.id, quota)
      const until = Math.min(
        Date.now() + 60_000,
        ...(value?.windows || []).map((w) => w.resetsAt ?? Infinity),
      )
      if (this.recentQuota.size >= 400)
        this.recentQuota.delete(this.recentQuota.keys().next().value)
      this.recentQuota.set(key, { value, until })
      if (value) this.workspace.notify()
      return value
    })()
    this.pendingQuota.set(key, check)
    try {
      return await check
    } finally {
      this.pendingQuota.delete(key)
    }
  }
}
