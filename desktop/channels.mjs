import { randomInt, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { platformById } from './channels/catalog.mjs'
import { ChannelAccess } from './channels/access.mjs'
import { ChannelPermissions } from './channels/permissions.mjs'
import { ChannelError, PairingExpired, PairingRestart, chunks } from './channels/transport.mjs'
import { telegram, dingtalk, discord } from './channels/gateways.mjs'
import { wecom, feishu, whatsapp, qq } from './channels/clients.mjs'
import { wechat } from './channels/wechat.mjs'

const adapters = { telegram, dingtalk, discord, qq, wechat, wecom, feishu, whatsapp }
const diagnostic = e => e instanceof ChannelError ? e.message : '请检查网络、平台凭据与机器人配置。'
const missingBot = '频道已连接，尚未绑定可用 Bot。请在频道配置中选择接收消息的 Bot。'
const expiredPairing = '有配对申请已过期。请让发送者重新发一条消息以获得新配对码。'
const displayName = value => String(value).replace(/[\x00-\x1f\x7f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, 120)
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !value.includes('\0')

function discordChunks(text, limit) {
  const parts = []
  let current = ''
  for (const codepoint of text) {
    if (codepoint.length > limit) throw new ChannelError('此回复含有需要两个 UTF-16 单元的字符，请将 Discord 分段长度设为至少 2。')
    if (current && current.length + codepoint.length > limit) { parts.push(current); current = '' }
    current += codepoint
  }
  if (current) parts.push(current)
  return parts
}

export class Channels {
  constructor(workspace, { safeStorage, connectors = adapters } = {}) {
    this.workspace = workspace
    this.db = workspace.db
    this.safeStorage = safeStorage
    this.connectors = connectors
    this.sessions = new Map()
    this.setups = new Map()
    this.closed = false
    this.db.db.exec(`
      CREATE TABLE IF NOT EXISTS channels(
        id TEXT PRIMARY KEY, botId TEXT NOT NULL, enabled INTEGER NOT NULL, credentials BLOB NOT NULL, generation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_identities(
        channel TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE, nativeId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_public(
        channel TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE, fields TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_keys(
        channel TEXT REFERENCES channels(id) ON DELETE CASCADE, key TEXT NOT NULL, value BLOB NOT NULL, PRIMARY KEY(channel,key));
      CREATE TABLE IF NOT EXISTS channel_access(
        id TEXT PRIMARY KEY, channel TEXT REFERENCES channels(id) ON DELETE CASCADE, identity TEXT NOT NULL,
        room TEXT NOT NULL, sender TEXT NOT NULL, name TEXT NOT NULL, UNIQUE(channel,identity,room,sender));
      CREATE TABLE IF NOT EXISTS channel_chats(
        channel TEXT NOT NULL, identity TEXT NOT NULL, room TEXT NOT NULL, sender TEXT NOT NULL, botId TEXT NOT NULL,
        chatId TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS channel_peer ON channel_chats(channel,identity,room,sender,botId);
      CREATE TABLE IF NOT EXISTS channel_events(
        channel TEXT NOT NULL, identity TEXT NOT NULL, room TEXT NOT NULL, event TEXT NOT NULL,
        received INTEGER NOT NULL, PRIMARY KEY(channel,identity,room,event));
      CREATE TABLE IF NOT EXISTS channel_deliveries(
        messageId TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        chatId TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, channel TEXT NOT NULL, state TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS channel_deliveries_by_chat ON channel_deliveries(chatId,state);`)
    this.access = new ChannelAccess(this.db)
    this.permissions = new ChannelPermissions(workspace)
    // An interrupted send has an unknown outcome. Keep the reply available
    // locally without automatically repeating a potentially delivered message.
    this.db.run("UPDATE channel_deliveries SET state='unconfirmed' WHERE state='pending'")
    this.db.run('DELETE FROM channel_events WHERE received < ?', Date.now() - 30 * 86400_000)
    for (const row of this.db.all('SELECT id FROM channels WHERE enabled=1')) this.start(row.id)
  }
  requireStorage() {
    if (!this.safeStorage?.isEncryptionAvailable() ||
        (process.platform === 'linux' && this.safeStorage.getSelectedStorageBackend?.() === 'basic_text'))
      throw new Error('请解锁系统钥匙串或密钥环后再连接频道。')
  }
  seal(text) { this.requireStorage(); return this.safeStorage.encryptString(text) }
  unseal(bytes) { this.requireStorage(); return this.safeStorage.decryptString(Buffer.from(bytes)) }
  snapshot() {
    const sessions = this.db.all(`SELECT cc.channel,c.id,c.name,c.updatedAt,
      (SELECT count(*) FROM channel_deliveries d WHERE d.chatId=c.id AND d.state='unconfirmed') AS unconfirmed
      FROM channel_chats cc JOIN chats c ON c.id=cc.chatId
      LEFT JOIN chat_organization o ON c.id=o.chatId WHERE coalesce(o.archived,0)=0 ORDER BY c.updatedAt DESC`)
    const configs = new Map(this.db.all(`SELECT c.id,c.botId,c.enabled,p.fields,b.id AS activeBot FROM channels c
      LEFT JOIN channel_public p ON c.id=p.channel LEFT JOIN bots b ON b.id=c.botId AND b.archived=0`).map(c => [c.id, c]))
    const ids = new Set([...configs.keys(), ...this.setups.keys(), ...sessions.map(s => s.channel)])
    return [...ids].map(id => {
      const config = configs.get(id), live = this.sessions.get(id), setup = this.setups.get(id)
      return {
        id, access: this.access.read(id), ...this.permissions.read(id),
        configured: !!config, botId: config?.botId || '', fields: JSON.parse(config?.fields || '{}'),
        enabled: !!config?.enabled, status: live?.status || 'disconnected',
        detail: live?.detail || (live?.status === 'connected' && !config?.activeBot ? missingBot : ''),
        account: live?.label || '', qr: live?.qr || '', pending: [...(live?.pending.values() || [])].filter(req => req.expiresAt > Date.now()),
        setup: setup ? { setupId: setup.setupId, status: setup.status, qr: setup.qr || '', detail: setup.detail } : null,
        allowed: this.db.all('SELECT id,room,sender,name FROM channel_access WHERE channel=?', id),
        chats: sessions.filter(chat => chat.channel === id),
      }
    })
  }
  validBot(value) {
    if (value === '' || value === null) return ''
    return this.workspace.bot(value).id
  }
  action(method, p, owner) {
    if (method === 'channelRefresh' && p.id == null) {
      for (const [id, live] of this.sessions) if (live.status === 'error') this.start(id)
      this.workspace.notify()
      return
    }
    const platform = platformById(p.id)
    const id = platform.id
    const row = this.db.get('SELECT * FROM channels WHERE id=?', id)
    if (method === 'channelBeginSetup') {
      if (!platform.qr || !identifier(p.setupId)) throw new Error('频道配对会话无效。')
      const previous = this.setups.get(id)
      if (previous && previous.owner !== owner) throw new Error('另一个窗口正在配置此频道。')
      if (previous?.setupId === p.setupId && !p.refresh) return
      this.cancelSetup(id)
      const live = this.createLive()
      Object.assign(live, { setupId: p.setupId, owner, keys: new Map() })
      this.setups.set(id, live)
      this.run({ id, botId: row?.botId || '', generation: randomUUID() }, live)
        .catch(() => { if (!live.controller.signal.aborted) this.workspace.notify() })
    } else if (method === 'channelCancelSetup') {
      const setup = this.setups.get(id)
      if (setup?.setupId === p.setupId && setup.owner === owner) this.cancelSetup(id)
    } else if (method === 'channelSetAccess' && row) {
      this.access.save(id, p.access, p.expectedAccess)
      const live = this.sessions.get(id)
      if (live) for (const [key, req] of live.pending) {
        if (this.access.decision(id, { ...req, group: false, paired: false }) !== 'pair') live.pending.delete(key)
      }
    } else if (method === 'channelSetBot' && row) {
      if ((p.expectedBotId !== undefined && p.expectedBotId !== row.botId) ||
        (p.expectedRevision !== undefined && p.expectedRevision !== this.permissions.read(id).permissionRevision))
        throw new Error('频道绑定或操作权限已更改，请检查最新设置后重试。')
      const botId = this.validBot(p.botId)
      this.db.run('UPDATE channels SET botId=? WHERE id=?', botId, id)
      const live = this.sessions.get(id)
      if (botId && live?.detail === missingBot) live.detail = ''
    } else if (method === 'channelSave') {
      if (platform.qr && !row) throw new Error('请打开频道配置，扫码完成配对。')
      const botId = this.validBot(p.botId === undefined ? row?.botId || '' : p.botId)
      this.requireStorage()
      const previous = row ? JSON.parse(this.unseal(row.credentials)) : {}
      const credentials = {}
      for (const key of platform.fields) {
        const input = p.fields?.[key]
        if (input != null && typeof input !== 'string') throw new Error('频道配置格式无效。')
        const value = input?.trim() || previous[key] || (key === 'region' && 'feishu')
        if (typeof value !== 'string' || !value || value.length > 4000 ||
            (key === 'region' && !['feishu', 'lark'].includes(value))) throw new Error('请填写完整的平台凭据。')
        credentials[key] = value
      }
      const changed = !row || JSON.stringify(credentials) !== JSON.stringify(previous)
      const sealed = this.seal(JSON.stringify(credentials))
      this.cancelSetup(id)
      this.stop(id)
      this.db.transaction(() => {
        this.db.run(`INSERT INTO channels VALUES (?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET
          botId=excluded.botId,enabled=1,credentials=excluded.credentials,generation=excluded.generation`,
          id, botId, sealed, changed ? randomUUID() : row.generation)
        const { id: appId, region } = credentials
        this.db.run('INSERT OR REPLACE INTO channel_public VALUES(?,?)', id, JSON.stringify({ id: appId, region }))
        if (changed) {
          this.db.run('DELETE FROM channel_keys WHERE channel=?', id)
          this.db.run('DELETE FROM channel_access WHERE channel=?', id)
          this.db.run('DELETE FROM channel_policies WHERE channel=?', id)
          this.db.run('DELETE FROM channel_identities WHERE channel=?', id)
        }
      })
      this.start(id)
    } else if (method === 'channelDisconnect' && row) {
      this.cancelSetup(id)
      this.db.run('UPDATE channels SET enabled=0 WHERE id=?', id)
      this.stop(id)
    } else if (method === 'channelRemove' && row) {
      this.cancelSetup(id)
      this.stop(id)
      this.db.run('DELETE FROM channels WHERE id=?', id)
    } else if (method === 'channelRefresh') {
      if (row?.enabled && this.sessions.get(id)?.status !== 'connected') this.start(id)
    } else if (method === 'channelPair' && (row || p.setupId)) {
      const live = p.setupId ? this.setups.get(id) : this.sessions.get(id)
      if (p.setupId && (live?.setupId !== p.setupId || live.owner !== owner || p.pin === undefined))
        throw new Error('当前配对会话已结束。')
      if (p.pin !== undefined) {
        if (!/^\d{4,12}$/.test(p.pin) || !live?.pin) throw new Error('请输入手机上显示的验证码。')
        live.pin(p.pin)
      } else if (p.revoke === true) {
        this.db.run('DELETE FROM channel_access WHERE channel=? AND id=?', id, p.requestId)
      } else {
        const entry = live?.pending.get(p.requestId)
        if (!entry || entry.expiresAt <= Date.now() || live.status !== 'connected' || !live.identity) throw new Error('配对请求已过期，请重新发送消息。')
        this.db.run('INSERT OR IGNORE INTO channel_access VALUES(?,?,?,?,?,?)',
          entry.id, id, live.identity, entry.room, entry.sender, entry.name)
        live.pending.delete(entry.id)
      }
    } else throw new Error('频道操作无效。')
    this.workspace.notify()
    if (method === 'channelSetBot') return this.permissions.read(id)
  }
  createLive() {
    return { controller: new AbortController(), status: 'connecting', pending: new Map(), detail: '', pendingReplies: 0 }
  }
  cancelSetup(id) {
    const setup = this.setups.get(id)
    if (!setup) return
    this.setups.delete(id)
    setup.controller.abort()
    setup.keys.clear()
  }
  cancelSetupsForWindow(owner) {
    let changed = false
    for (const [id, setup] of this.setups) if (setup.owner === owner) {
      this.cancelSetup(id)
      changed = true
    }
    if (changed) this.workspace.notify()
  }
  commitSetup(row, live, nativeId) {
    if (live !== this.setups.get(row.id)) throw new ChannelError('配对会话已取消。')
    const previous = this.db.get(`SELECT c.botId,c.generation,i.nativeId FROM channels c
      LEFT JOIN channel_identities i ON i.channel=c.id WHERE c.id=?`, row.id)
    const sameAccount = previous?.nativeId === nativeId
    if (sameAccount) row.generation = previous.generation
    const credentials = this.seal('{}')
    const keys = [...live.keys].map(([key, value]) => [key, this.seal(value)])
    this.db.transaction(() => {
      this.db.run(`INSERT INTO channels VALUES(?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET
        enabled=1,credentials=excluded.credentials,generation=excluded.generation`, row.id, previous?.botId || '', credentials, row.generation)
      this.db.run('DELETE FROM channel_keys WHERE channel=?', row.id)
      if (!sameAccount) {
        this.db.run('DELETE FROM channel_access WHERE channel=?', row.id)
        this.db.run('DELETE FROM channel_policies WHERE channel=?', row.id)
      }
      this.db.run('INSERT OR REPLACE INTO channel_identities VALUES(?,?)', row.id, nativeId)
      for (const [key, value] of keys) this.db.run('INSERT INTO channel_keys VALUES(?,?,?)', row.id, key, value)
    })
    this.stop(row.id)
    this.setups.delete(row.id)
    live.keys.clear()
    delete live.keys
    delete live.owner
    live.setupId = null
    row.credentials = credentials
    this.sessions.set(row.id, live)
  }
  stop(id) {
    const live = this.sessions.get(id)
    if (!live) return
    this.sessions.delete(id)
    clearTimeout(live.pendingTimer)
    live.controller.abort()
    this.db.run("UPDATE channel_deliveries SET state='unconfirmed' WHERE channel=? AND state='pending'", id)
  }
  schedulePendingExpiry(live) {
    if (live.pendingTimer || !live.pending.size) return
    const due = Math.min(...[...live.pending.values()].map(entry => entry.expiresAt))
    live.pendingTimer = setTimeout(() => {
      live.pendingTimer = null
      const count = live.pending.size
      for (const [key, entry] of live.pending) if (entry.expiresAt <= Date.now()) live.pending.delete(key)
      if (count !== live.pending.size) {
        if (!live.detail && live.status === 'connected') live.detail = expiredPairing
        this.workspace.notify()
      }
      this.schedulePendingExpiry(live)
    }, Math.max(0, due - Date.now())).unref()
  }
  start(id) {
    this.stop(id)
    const row = this.db.get('SELECT * FROM channels WHERE id=?', id)
    if (!row?.enabled || this.closed) return
    const live = this.createLive()
    this.sessions.set(id, live)
    this.run(row, live).catch(() => {})
  }
  async run(row, live) {
    const signal = live.controller.signal
    let retry = 1000
    while (!signal.aborted) {
      const attempt = new AbortController()
      const current = AbortSignal.any([signal, attempt.signal])
      const update = (status, detail = '') => {
        if (current.aborted || (status === live.status && detail === live.detail)) return
        live.status = status
        live.detail = detail
        this.workspace.notify()
      }
      let qrGeneration = 0, holdSetup = false
      const ctx = {
        signal: current, status: update, canStartPairing: !!live.keys,
        ready: (label, identity = label) => {
          if (current.aborted || !identifier(identity)) return
          if (live.keys) {
            try { this.commitSetup(row, live, identity) }
            catch {
              holdSetup = true
              live.qr = ''
              update('error', '无法保存已配对的频道。请检查系统钥匙串和工作区存储后重试。')
              attempt.abort()
              return
            }
          }
          qrGeneration++
          const scope = JSON.stringify([row.generation, identity])
          if (live.identity !== scope) {
            const previous = this.db.get('SELECT nativeId FROM channel_identities WHERE channel=?', row.id)
            this.db.transaction(() => {
              if (previous && previous.nativeId !== identity) {
                this.db.run('DELETE FROM channel_access WHERE channel=?', row.id)
                this.db.run('DELETE FROM channel_policies WHERE channel=?', row.id)
                this.permissions.reset(row.id)
              }
              this.db.run('INSERT OR REPLACE INTO channel_identities VALUES(?,?)', row.id, identity)
            })
            live.pending.clear()
          }
          live.identity = scope
          live.label = label
          live.qr = ''
          retry = 1000
          if (live.status !== 'connected') update('connected')
        },
        receive: event => {
          if (current.aborted || live.status !== 'connected') return
          return this.receive(row, live, event, current).catch(() => update('connected', '处理频道消息失败，请查看本地会话。'))
        },
        qr: async value => {
          if (!live.keys) throw new PairingExpired('请打开频道配置，重新扫码配对。')
          const sequence = ++qrGeneration
          if (typeof value !== 'string' || !value.length || value.length > 4000) throw new ChannelError('二维码无效。')
          const { toDataURL } = await import('qrcode')
          const image = await toDataURL(value, { margin: 2, width: 240 })
          if (!current.aborted && sequence === qrGeneration) { live.qr = image; live.status = 'pairing'; live.detail = ''; this.workspace.notify() }
        },
        requestPin: async () => {
          current.throwIfAborted()
          const { promise, resolve, reject } = Promise.withResolvers()
          const abort = () => reject(current.reason)
          live.pin = resolve
          current.addEventListener('abort', abort, { once: true })
          update('pin')
          try { return await promise } finally { current.removeEventListener('abort', abort); live.pin = null }
        },
        load: key => {
          if (current.aborted) return null
          if (live.keys) return live.keys.get(key) ?? null
          const result = this.db.get('SELECT value FROM channel_keys WHERE channel=? AND key=?', row.id, key)
          return result ? this.unseal(result.value) : null
        },
        store: (key, value) => {
          if (current.aborted) return
          if (live.keys) {
            if (value == null) live.keys.delete(key)
            else live.keys.set(key, value)
            return
          }
          if (value == null) this.db.run('DELETE FROM channel_keys WHERE channel=? AND key=?', row.id, key)
          else this.db.run('INSERT OR REPLACE INTO channel_keys VALUES(?,?,?)', row.id, key, this.seal(value))
        },
        clearKeys: () => {
          if (current.aborted) return
          if (live.keys) live.keys.clear()
          else this.db.run('DELETE FROM channel_keys WHERE channel=?', row.id)
        },
        transaction: callback => { if (!current.aborted) return live.keys ? callback() : this.db.transaction(callback) },
      }
      try {
        const credentials = live.keys ? {} : JSON.parse(this.unseal(row.credentials))
        await this.connectors[row.id](ctx, credentials)
      } catch (e) {
        if (!current.aborted) {
          live.qr = ''
          if (e instanceof PairingRestart) update('scanned')
          else {
            holdSetup = !!live.keys || e instanceof PairingExpired
            update(e instanceof PairingExpired ? 'expired' : 'error', diagnostic(e))
          }
        }
      } finally {
        attempt.abort()
        if (!signal.aborted && !live.keys) this.db.run("UPDATE channel_deliveries SET state='unconfirmed' WHERE channel=? AND state='pending'", row.id)
      }
      if (holdSetup) return
      if (!signal.aborted) {
        await delay(retry, undefined, { signal, ref: false }).catch(() => {})
        retry = Math.min(60_000, retry * 2)
      }
    }
  }
  async receive(row, live, event, signal) {
    const { id, room, sender, text, reply } = event
    if (!identifier(id) || !identifier(room) || !identifier(sender) || typeof text !== 'string' ||
      !text.trim() || text.length > 200_000 || typeof reply !== 'function') return
    const identity = live.identity
    const args = [row.id, identity, room, sender]
    const paired = () => !!this.db.get('SELECT id FROM channel_access WHERE channel=? AND identity=? AND room=? AND sender=?', ...args)
    const policy = () => this.access.decision(row.id, { ...event, paired: paired() })
    const decision = policy()
    if (decision === 'deny') return
    if (this.db.get('SELECT 1 FROM channel_events WHERE channel=? AND identity=? AND room=? AND event=?', row.id, identity, room, id)) return
    const recordEvent = () => this.db.run('INSERT INTO channel_events VALUES(?,?,?,?,?)', row.id, identity, room, id, Date.now())
    if (decision === 'pair') {
      const now = Date.now()
      for (const [key, req] of live.pending) if (req.expiresAt <= now) live.pending.delete(key)
      recordEvent()
      if (live.pending.size >= 32) return
      if (![...live.pending.values()].some(req => req.room === room && req.sender === sender)) {
        const code = String(randomInt(100000, 1000000))
        const req = { id: randomUUID(), room, sender, code, name: displayName(event.name || sender), expiresAt: now + 30 * 60000 }
        live.pending.set(req.id, req)
        if (live.detail === expiredPairing) live.detail = ''
        this.schedulePendingExpiry(live)
        this.workspace.notify()
        if (!event.group) await reply('BoTeam 配对码 ' + code + '。请在桌面端核对此码并批准访问。')
      }
      return
    }
    const bot = this.db.get(`SELECT b.id FROM channels c JOIN bots b ON b.id=c.botId
      WHERE c.id=? AND c.enabled=1 AND b.archived=0`, row.id)
    if (!bot) {
      recordEvent()
      if (live.detail !== missingBot) { live.detail = missingBot; this.workspace.notify() }
      return
    }
    const botId = bot.id
    const { permission, permissionRevision } = this.permissions.read(row.id)
    const checkAccess = () => {
      if (signal.aborted || live.identity !== identity || !this.db.get(
        'SELECT 1 FROM channels c JOIN bots b ON b.id=c.botId WHERE c.id=? AND c.enabled=1 AND b.id=? AND b.archived=0', row.id, botId))
        throw new ChannelError('频道连接或绑定的 Bot 已更改。')
      if (policy() !== 'allow') throw new ChannelError('发送者授权已撤销。')
    }
    if (live.pendingReplies >= 32) {
      recordEvent()
      live.detail = '频道队列已满，已让发送者稍后重试。'
      this.workspace.notify()
      try { await reply('BoTeam 队列繁忙，这条消息尚未执行，请稍后重试。') }
      catch { if (!signal.aborted) { live.detail = '频道队列已满，提醒未送达。'; this.workspace.notify() } }
      return
    }
    // DM authorizations are scoped to the sender. Registered group members
    // share one native thread for the room. An empty sender marks a room
    // binding and never matches old per-sender histories.
    const binding = [row.id, identity, room, event.group ? '' : sender, botId]
    const previous = this.db.get(`SELECT cc.chatId FROM channel_chats cc
      LEFT JOIN chat_organization o ON o.chatId=cc.chatId WHERE channel=? AND identity=? AND room=? AND sender=? AND botId=?
      AND coalesce(o.archived,0)=0 ORDER BY cc.rowid DESC LIMIT 1`, ...binding)
    const chatId = previous?.chatId || randomUUID()
    const who = displayName(event.name || sender)
    const senderName = event.group ? (who === sender ? who : who + ' (' + displayName(sender) + ')') : undefined
    const topic = event.group ? displayName(event.roomName || room) : who
    const title = (platformById(row.id).name + ' · ' + topic).slice(0, 120)
    const first = previous ? undefined : { scope: 'channel:' + chatId,
      draft: { kind: event.group ? 'group' : 'direct', members: [botId], id: chatId, name: title },
      apply: () => {
        this.db.run('INSERT INTO channel_chats VALUES(?,?,?,?,?,?)', ...binding, chatId)
        this.db.run('UPDATE chats SET name=? WHERE id=?', title, chatId)
        this.db.run('DELETE FROM chat_title_requests WHERE chatId=?', chatId)
      },
    }
    const messageId = this.workspace.send({ chatId, recipients: [botId], text }, undefined, undefined, first, {
      senderName, checkAccess, permission,
      validatePermission: permission === null ? undefined : () => this.permissions.validate(row.id, botId, permission, permissionRevision, signal),
      checkPermission: () => this.permissions.binding(row.id, botId, permissionRevision),
      onEnqueued: localId => {
        recordEvent()
        this.db.run("INSERT INTO channel_deliveries VALUES(?,?,?,'pending')", localId, chatId, row.id)
      },
    })
    live.pendingReplies++
    const delivery = this.access.delivery(row.id)
    if (delivery.ackReaction && event.acknowledge) {
      Promise.resolve().then(() => {
        checkAccess()
        return event.acknowledge(delivery.ackReaction)
      }).catch(() => {})
    }
    try {
      await this.workspace.lanes.get(chatId + '/' + botId)
      if (signal.aborted) return
      checkAccess()
      const result = this.db.get(`SELECT t.status,m.text FROM tasks t LEFT JOIN messages m ON m.taskId=t.id
        WHERE t.messageId=? AND t.botId=?`, messageId, botId)
      const output = result?.status === 'done' && result.text ? result.text : 'BoTeam 未生成回复，请在桌面端查看任务状态。'
      const parts = row.id === 'discord' ? discordChunks(output, delivery.chunkSize) : chunks(output)
      for (const [i, part] of parts.entries()) {
        if (signal.aborted) return
        checkAccess()
        await reply(part, { reference: delivery.replyMode === 'all' || (i === 0 && delivery.replyMode === 'first'), beforeSend: checkAccess })
      }
      if (!signal.aborted) this.db.run('DELETE FROM channel_deliveries WHERE messageId=?', messageId)
    } catch (e) {
      if (!signal.aborted) {
        this.db.run("UPDATE channel_deliveries SET state='unconfirmed' WHERE messageId=?", messageId)
        live.detail = '回复投递失败。' + diagnostic(e)
        this.workspace.notify()
      }
    } finally { live.pendingReplies-- }
  }
  close() {
    this.closed = true
    for (const id of this.setups.keys()) this.cancelSetup(id)
    for (const id of this.sessions.keys()) this.stop(id)
  }
}
