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
  read(chatId, bot) {
    const row = this.db.get(
      'SELECT * FROM composer_settings WHERE chatId=? AND botId=?',
      chatId,
      bot.id,
    )
    return {
      model: row?.model ?? bot.model,
      effort: row?.effort ?? bot.effort,
      permission: row?.permission || 'default',
      planMode: Boolean(row?.planMode) || row?.permission === 'plan',
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
    if (
      hasPermission &&
      !(adapter.permissionModes || ['default']).includes(
        p.permission,
      )
    )
      throw new Error('此原生工具不支持所选权限模式。')
    const previous = draft ? { ...bot, permission: 'default' } : this.read(chatId, bot)
    const planIsPermission = adapter.permissionModes?.includes('plan')
    if ((hasPlan && p.planMode && (!planIsPermission || adapter.composerActions)) ||
        p.permission === 'auto-review' || (p.permission === 'workspace-auto' && account.provider === 'antigravity')) {
      const capabilities = await this.workspace.composerActions({ chatId, botId, draft })
      if (hasPlan && p.planMode && !capabilities.plan) throw new Error('当前原生工具未提供计划模式。')
      if (p.permission === 'auto-review' && !capabilities.autoReview) throw new Error('当前原生工具未提供自动审批。')
      if (p.permission === 'workspace-auto' && account.provider === 'antigravity' && !capabilities.workspaceAuto)
        throw new Error('当前 Antigravity 未提供工作区自动执行。')
    }
    const model = hasModel ? (p.model ?? bot.model) : previous.model
    const effort = hasEffort ? (p.effort ?? bot.effort) : previous.effort
    if (hasModel || hasEffort) {
      const catalog = model || effort ? await this.workspace.botOptions(account.id) : {}
      validateSelection(catalog, model, effort)
    }
    return chatId => {
      this.member(chatId, botId)
      this.db.run(
        'INSERT OR IGNORE INTO composer_settings(chatId,botId) VALUES(?,?)',
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
      if (hasPermission)
        this.db.run(
          'UPDATE composer_settings SET permission=? WHERE chatId=? AND botId=?',
          p.permission,
          chatId,
          botId,
        )
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
    const key = JSON.stringify([account.id, account.identity, account.source, model])
    const inFlight = this.pendingQuota.get(key)
    if (inFlight) return inFlight
    const cached = this.recentQuota.get(key)
    if (cached && cached.until > Date.now()) return cached.value
    const check = (async () => {
      const quota = await adapter.quota({ account, model, signal: this.workspace.lifetime.signal })
      if (this.workspace.closed) throw new Error('工作台已关闭。')
      const current = this.db.account(account.id)
      if (
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
