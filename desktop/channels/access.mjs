import { RE2JS } from 're2js'

function defaults(channel) {
  return { dmPolicy: 'pairing', allowFrom: [], groups: [],
    delivery: { ackReaction: '', replyMode: 'first', chunkSize: channel === 'discord' ? 2000 : 1800, mentionPatterns: [] } }
}

function identifier(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || /[\u0000-\u001f]/.test(value))
    throw new Error('请输入有效的频道或用户 ID。')
  return value.trim()
}

function identifiers(values) {
  if (!Array.isArray(values) || values.length > 500) throw new Error('名单最多可包含 500 项。')
  return [...new Set(values.map(identifier))]
}

function compilePatterns(patterns) {
  if (!Array.isArray(patterns) || patterns.length > 12) throw new Error('最多可设置 12 条提及规则。')
  return patterns.map(pattern => {
    if (typeof pattern !== 'string' || !pattern.trim() || pattern.length > 256) throw new Error('提及规则须为 1 至 256 个字符。')
    try { return RE2JS.compile(pattern, RE2JS.CASE_INSENSITIVE) }
    catch { throw new Error('提及规则无效，请输入 RE2 正则表达式。') }
  })
}

function normalize(channel, input) {
  const choices = channel === 'discord' ? ['pairing','allowlist','disabled'] : ['pairing','allowlist','open','disabled']
  if (!choices.includes(input?.dmPolicy)) throw new Error('请选择有效的私聊策略。')
  const allowFrom = identifiers(input.allowFrom)
  if (!Array.isArray(input.groups) || input.groups.length > 500) throw new Error('最多可配置 500 个群聊。')
  const groups = input.groups.map(group => {
    if (typeof group?.requireMention !== 'boolean') throw new Error('请选择群聊的提及策略。')
    return { room: identifier(group.room), requireMention: group.requireMention, allowFrom: identifiers(group.allowFrom) }
  })
  if (new Set(groups.map(group => group.room)).size !== groups.length) throw new Error('频道 ID 重复。')
  const { delivery } = defaults(channel)
  if (channel === 'discord') {
    const value = input.delivery
    if (!value || !Number.isInteger(value.chunkSize) || value.chunkSize < 1 || value.chunkSize > 2000)
      throw new Error('消息长度上限应为 1 至 2000。')
    if (!['first', 'all', 'off'].includes(value.replyMode) || typeof value.ackReaction !== 'string' || value.ackReaction.length > 100)
      throw new Error('投递设置无效。')
    compilePatterns(value.mentionPatterns)
    Object.assign(delivery, { replyMode: value.replyMode, chunkSize: value.chunkSize, ackReaction: value.ackReaction.trim(), mentionPatterns: value.mentionPatterns })
  }
  return { dmPolicy: input.dmPolicy, allowFrom, groups, delivery }
}

export class ChannelAccess {
  constructor(db) {
    this.db = db
    this.patternCache = new Map()
    db.db.exec('CREATE TABLE IF NOT EXISTS channel_policies(channel TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE, policy TEXT NOT NULL)')
  }
  read(channel) {
    const row = this.db.get('SELECT policy FROM channel_policies WHERE channel=?', channel)
    if (!row) return defaults(channel)
    return JSON.parse(row.policy)
  }
  save(channel, input, expectedAccess) {
    if (expectedAccess && JSON.stringify(normalize(channel, expectedAccess)) !== JSON.stringify(this.read(channel)))
      throw new Error('其他窗口已更改频道设置，请检查最新配置后再保存。')
    const policy = normalize(channel, input)
    this.db.run('INSERT OR REPLACE INTO channel_policies(channel,policy) VALUES(?,?)', channel, JSON.stringify(policy))
    this.patternCache.delete(channel)
  }
  delivery(channel) { return this.read(channel).delivery }
  decision(channel, event) {
    const access = this.read(channel)
    if (event.group) {
      if (channel === 'discord' && access.dmPolicy === 'disabled') return 'deny'
      const group = access.groups.find(entry => entry.room === event.room)
      // Keep grants from older BoTeam workspaces until a group policy is explicitly saved.
      if (!group) return event.paired && !this.db.get('SELECT 1 FROM channel_policies WHERE channel=?', channel) ? 'allow' : 'deny'
      if (group.allowFrom.length && !group.allowFrom.includes(event.sender)) return 'deny'
      if (!group.requireMention || event.mentioned) return 'allow'
      const patterns = access.delivery.mentionPatterns
      if (!patterns.length) return 'deny'
      const key = JSON.stringify(patterns)
      let entry = this.patternCache.get(channel)
      if (entry?.key !== key) {
        entry = { key, compiled: compilePatterns(patterns) }
        this.patternCache.set(channel, entry)
      }
      return entry.compiled.some(pattern => pattern.test(event.text)) ? 'allow' : 'deny'
    }
    if (access.dmPolicy === 'disabled') return 'deny'
    if (access.dmPolicy === 'open' || event.paired || access.allowFrom.includes(event.sender)) return 'allow'
    return access.dmPolicy === 'pairing' ? 'pair' : 'deny'
  }
}
