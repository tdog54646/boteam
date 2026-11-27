import { ChannelError, PairingExpired, PairingRestart, connectedUntilClosed, quiet } from './transport.mjs'

export async function qq(ctx, { id, secret }) {
  const { QQBot } = await import('@tencent-connect/qqbot-nodejs')
  ctx.signal.throwIfAborted()
  const bot = new QQBot({ appId: id, appSecret: secret, intents: 1 << 25, logger: quiet, reconnect: { maxAttempts: 3 } })
  bot.on('ready', () => ctx.ready(id))
  bot.on('resumed', () => ctx.ready(id))
  bot.on('disconnected', () => ctx.status('connecting'))
  bot.on('error', () => ctx.status('error', 'QQ 连接失败，请检查机器人凭据和网络。'))
  bot.on('message', (_context, message) => {
    if (!message.replyTarget || message.senderIsBot) return
    ctx.receive({ id: message.messageId, sender: message.senderId, name: message.senderName,
      room: message.replyTarget.targetId, group: message.kind === 'group', mentioned: message.rawEventType === 'GROUP_AT_MESSAGE_CREATE', text: message.content, reply: text => bot.sendText(message.replyTarget, text) })
  })
  await bot.start(ctx.signal)
}

export async function wecom(ctx, { id, secret }) {
  const { WSClient } = await import('@wecom/aibot-node-sdk')
  await connectedUntilClosed(ctx.signal, fail => {
    const client = new WSClient({ botId: id, secret, logger: quiet, maxReconnectAttempts: 0 })
    client.on('authenticated', () => ctx.ready(id))
    client.on('disconnected', () => fail(new ChannelError('企业微信长连接已断开。')))
    client.on('error', () => fail(new ChannelError('企业微信连接失败，请检查 Bot ID 和 Secret。')))
    client.on('message.text', ({ body }) => {
      const sender = body.from?.userid
      const room = body.chattype === 'group' ? body.chatid : sender
      // WeCom only emits group callbacks when this intelligent bot was addressed.
      ctx.receive({ id: body.msgid, room, sender, group: body.chattype === 'group', mentioned: true, text: body.text?.content,
        reply: text => client.sendMessage(room, { msgtype: 'markdown', markdown: { content: text } }) })
    })
    client.connect()
    return () => client.disconnect()
  })
}

export async function feishu(ctx, { id, secret, region }) {
  const { Client, WSClient, Domain, EventDispatcher } = await import('@larksuiteoapi/node-sdk')
  const options = { appId: id, appSecret: secret, domain: region === 'lark' ? Domain.Lark : Domain.Feishu, logger: quiet }
  const api = new Client(options)
  const info = await api.request({ url: '/open-apis/bot/v3/info', method: 'GET' })
  ctx.signal.throwIfAborted()
  const self = info.bot?.open_id
  if (!self) throw new ChannelError('无法读取飞书机器人身份，请检查应用凭据。')
  const events = new EventDispatcher({ logger: quiet }).register({
    'im.message.receive_v1': event => {
      const { message, sender } = event
      if (sender?.sender_type !== 'user' || message?.message_type !== 'text') return
      let text
      try { text = JSON.parse(message.content).text } catch { return }
      ctx.receive({ id: message.message_id, room: message.chat_id, sender: sender.sender_id?.open_id, text,
        group: message.chat_type !== 'p2p', mentioned: message.mentions?.some(item => item.id?.open_id === self) || false,
        reply: async content => {
          const result = await api.im.message.reply({ path: { message_id: message.message_id },
            data: { msg_type: 'text', content: JSON.stringify({ text: content }) } })
          if (result.code) throw new ChannelError('Feishu / Lark ' + Number(result.code))
        } })
    },
  })
  await connectedUntilClosed(ctx.signal, fail => {
    const client = new WSClient({ ...options, handshakeTimeoutMs: 25_000,
      onReady: () => ctx.ready(info.bot.app_name || id, id), onReconnected: () => ctx.ready(info.bot.app_name || id, id),
      onReconnecting: () => ctx.status('connecting'),
      onError: () => fail(new ChannelError('飞书长连接失败，请检查应用凭据与事件订阅。')) })
    client.start({ eventDispatcher: events }).catch(fail)
    return () => client.close({ force: true })
  })
}

export async function whatsapp(ctx) {
  const { makeWASocket, BufferJSON, initAuthCreds, proto, normalizeMessageContent, jidNormalizedUser, DisconnectReason } =
    await import('@whiskeysockets/baileys')
  ctx.signal.throwIfAborted()
  const read = key => {
    const data = ctx.load(key)
    return data && JSON.parse(data, BufferJSON.reviver)
  }
  const write = (key, value) => ctx.store(key, value ? JSON.stringify(value, BufferJSON.replacer) : null)
  const stored = read('creds')
  if (!stored?.me && ctx.canStartPairing === false) throw new PairingExpired('请打开频道配置，重新关联 WhatsApp。')
  const creds = stored || initAuthCreds()
  const auth = { creds, keys: {
    async get(type, ids) {
      const records = Object.create(null)
      for (const id of ids) {
        const value = read(JSON.stringify([type, id]))
        if (value) records[id] = type === 'app-state-sync-key' ? proto.Message.AppStateSyncKeyData.fromObject(value) : value
      }
      return records
    },
    async set(entries) {
      ctx.transaction(() => {
        for (const [type, records] of Object.entries(entries))
          for (const [id, value] of Object.entries(records)) write(JSON.stringify([type, id]), value)
      })
    },
  } }
  await connectedUntilClosed(ctx.signal, fail => {
    const client = makeWASocket({ auth, logger: quiet, syncFullHistory: false, markOnlineOnConnect: false,
      shouldSyncHistoryMessage: () => false })
    client.ev.on('creds.update', () => { if (!ctx.signal.aborted) write('creds', creds) })
    client.ev.on('connection.update', update => {
      if (ctx.signal.aborted) return
      if (update.qr) ctx.qr(update.qr).catch(fail)
      if (update.isNewLogin) ctx.status('scanned')
      if (update.connection === 'open') ctx.ready(client.user?.name || 'WhatsApp', jidNormalizedUser(client.user.id))
      if (update.connection === 'close') {
        const code = update.lastDisconnect?.error?.output?.statusCode
        if (code === DisconnectReason.loggedOut) {
          ctx.clearKeys()
          return fail(new PairingExpired('WhatsApp 会话已退出，请重新扫码。'))
        }
        if (code === DisconnectReason.restartRequired) return fail(new PairingRestart('WhatsApp 正在完成配对。'))
        if (code === DisconnectReason.timedOut && !creds.registered) return fail(new PairingExpired('WhatsApp 二维码已过期，请刷新。'))
        fail(new ChannelError('WhatsApp ' + (Number(code) || 'disconnected')))
      }
    })
    client.ev.on('messages.upsert', ({ type, messages }) => {
      if (type !== 'notify') return
      for (const m of messages) {
        const room = m.key.remoteJid
        if (!room || m.key.fromMe || room.endsWith('@broadcast') || room.endsWith('@newsletter')) continue
        const sender = room.endsWith('@g.us') ? m.key.participant : room
        const content = normalizeMessageContent(m.message)
        const me = [client.user?.id, client.user?.lid].filter(Boolean).map(jidNormalizedUser)
        const context = content?.extendedTextMessage?.contextInfo
        const mentioned = (context?.mentionedJid || []).some(jid => me.includes(jidNormalizedUser(jid))) ||
          !!(context?.participant && me.includes(jidNormalizedUser(context.participant)))
        ctx.receive({ id: m.key.id, room, sender, name: m.pushName, group: room.endsWith('@g.us'), mentioned,
          text: content?.conversation || content?.extendedTextMessage?.text,
          reply: text => client.sendMessage(room, { text }) })
      }
    })
    return () => { client.end(undefined) }
  })
}
