import { ChannelError, jsonRequest, socketConnection, verifiedUrl } from './transport.mjs'

export async function telegram(ctx, { token }) {
  if (!/^\d+:[\w-]+$/.test(token)) throw new ChannelError('Bot Token 格式无效。')
  const call = async (method, body, beforeSend) => {
    const data = await jsonRequest('https://api.telegram.org/bot' + token + '/' + method, {
      body, beforeSend, signal: ctx.signal, timeout: method === 'getUpdates' ? 45_000 : 20_000, retry429: method === 'sendMessage',
    })
    if (!data.ok) throw new ChannelError('Telegram ' + (Number(data.error_code) || 'API error'))
    return data.result
  }
  const self = await call('getMe', {})
  const webhook = await call('getWebhookInfo', {})
  if (webhook.url) throw new ChannelError('该 Bot 已绑定 Webhook，请先解除绑定后使用长轮询。')
  ctx.ready(self.username || String(self.id), String(self.id))
  let offset = Number(ctx.load('cursor:' + self.id)) || 0
  while (!ctx.signal.aborted) {
    const updates = await call('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] })
    ctx.ready(self.username || String(self.id), String(self.id))
    for (const update of updates) {
      const m = update.message
      if (m?.text && m.from && !m.from.is_bot && m.chat) {
        ctx.receive({ id: String(update.update_id), room: String(m.chat.id), sender: String(m.from.id),
          roomName: m.chat.title, group: m.chat.type === 'group' || m.chat.type === 'supergroup',
          mentioned: m.reply_to_message?.from?.id === self.id || (m.entities || []).some(entity =>
            entity.type === 'text_mention' ? entity.user?.id === self.id :
            entity.type === 'mention' && m.text.slice(entity.offset, entity.offset + entity.length).toLowerCase() === '@' + self.username?.toLowerCase()),
          name: [m.from.first_name, m.from.last_name].filter(Boolean).join(' '), text: m.text,
          reply: (text, options) => call('sendMessage', { chat_id: m.chat.id, ...(m.message_thread_id && { message_thread_id: m.message_thread_id }), text }, options?.beforeSend) })
      }
      offset = update.update_id + 1
      ctx.store('cursor:' + self.id, String(offset))
    }
  }
}

export async function dingtalk(ctx, { id, secret }) {
  const topic = '/v1.0/im/bot/messages/get'
  const info = await jsonRequest('https://api.dingtalk.com/v1.0/gateway/connections/open', {
    signal: ctx.signal, body: { clientId: id, clientSecret: secret, ua: 'BoTeam/0.1',
      subscriptions: [{ type: 'CALLBACK', topic }] },
  })
  const url = verifiedUrl(info.endpoint, 'dingtalk.com', 'wss:')
  if (!info.ticket) throw new ChannelError('钉钉没有返回连接票据。')
  url.searchParams.set('ticket', info.ticket)
  await socketConnection(url, ctx, (event, socket) => {
    if (event.type === 'SYSTEM' && event.headers.topic === 'disconnect') return socket.fail(new ChannelError('钉钉已断开连接。'))
    if (event.type === 'SYSTEM' && event.headers.topic === 'ping') {
      socket.send({ code: 200, headers: event.headers, message: 'OK', data: event.data })
      return
    }
    if (event.type !== 'CALLBACK' || event.headers?.topic !== topic) return
    const m = JSON.parse(event.data)
    if (m.msgtype === 'text') {
      const webhook = verifiedUrl(m.sessionWebhook, 'dingtalk.com')
      ctx.receive({ id: m.msgId, room: m.conversationId, sender: m.senderStaffId || m.senderId, name: m.senderNick,
        roomName: m.conversationTitle, group: String(m.conversationType) === '2', mentioned: m.isInAtList === true,
        text: m.text?.content, reply: async text => {
          const result = await jsonRequest(webhook, { signal: ctx.signal, body: { msgtype: 'text', text: { content: text } } })
          if (result.errcode) throw new ChannelError('DingTalk ' + Number(result.errcode))
        } })
    }
    socket.send({ code: 200, headers: { messageId: event.headers.messageId, contentType: 'application/json' }, message: 'OK', data: '{}' })
  }, socket => socket.ready(id))
}

export async function discord(ctx, { token }) {
  const headers = { Authorization: 'Bot ' + token }
  const info = await jsonRequest('https://discord.com/api/v10/gateway/bot', { signal: ctx.signal, headers })
  const url = verifiedUrl(info.url, 'discord.gg', 'wss:')
  url.search = 'v=10&encoding=json'
  let sequence = null, heartbeatAcknowledged = true, botUserId
  await socketConnection(url, ctx, (frame, socket) => {
    if (frame.s != null) sequence = frame.s
    if (frame.op === 10) {
      socket.heartbeat(frame.d.heartbeat_interval, () => {
        if (!heartbeatAcknowledged) throw new ChannelError('Discord 心跳超时。')
        heartbeatAcknowledged = false
        socket.send({ op: 1, d: sequence })
      })
      socket.send({ op: 2, d: { token, intents: (1 << 9) | (1 << 12) | (1 << 15),
        properties: { os: process.platform, browser: 'BoTeam', device: 'BoTeam' } } })
    } else if (frame.op === 11) heartbeatAcknowledged = true
    else if (frame.op === 1) socket.send({ op: 1, d: sequence })
    else if (frame.op === 7 || frame.op === 9) socket.fail(new ChannelError('Discord 要求重新连接。'))
    else if (frame.t === 'READY') {
      botUserId = frame.d.user.id
      socket.ready(frame.d.user.username, botUserId)
    }
    else if (frame.t === 'MESSAGE_CREATE') {
      const m = frame.d
      if (!m.author || m.author.bot || m.webhook_id || ![0, 19].includes(m.type)) return
      const messages = 'https://discord.com/api/v10/channels/' + encodeURIComponent(m.channel_id) + '/messages'
      ctx.receive({ id: m.id, room: m.channel_id, sender: m.author.id, name: m.author.username, text: m.content,
        guild: m.guild_id, group: Boolean(m.guild_id),
        mentioned: m.mentions?.some(user => user.id === botUserId) || m.referenced_message?.author?.id === botUserId,
        acknowledge: emoji => jsonRequest(messages + '/' + encodeURIComponent(m.id) + '/reactions/' + encodeURIComponent(emoji) + '/@me',
          { signal: ctx.signal, headers, method: 'PUT', retry429: true }),
        reply: (text, options) => jsonRequest(messages, { signal: ctx.signal, headers, retry429: true, beforeSend: options?.beforeSend, body: {
          content: text, allowed_mentions: { parse: [], replied_user: false },
          ...(options?.reference && { message_reference: { message_id: m.id, fail_if_not_exists: false } }),
        } }) })
    }
  })
}

