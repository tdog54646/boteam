import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { ChannelError, PairingExpired, jsonRequest, verifiedUrl } from './transport.mjs'

const base = 'https://ilinkai.weixin.qq.com'
const version = '3.0.1/boteam-0.1'
const appHeaders = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String(0x030001) }

function weixin(ctx, host, method, body, token) {
  const headers = { ...appHeaders }
  if (body !== undefined) {
    headers.AuthorizationType = 'ilink_bot_token'
    headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64')
  }
  if (token) headers.Authorization = 'Bearer ' + token
  return jsonRequest(new URL('/ilink/bot/' + method, verifiedUrl(host, 'weixin.qq.com')), {
    signal: ctx.signal, timeout: 48_000, body, headers,
  }).then(data => {
    if (Number(data.ret) === -14 || Number(data.errcode) === -14) {
      ctx.clearKeys()
      throw new PairingExpired('微信会话已过期，请用新二维码重新配对。')
    }
    if (data.ret || data.errcode) throw new ChannelError('WeChat ' + (Number(data.errcode || data.ret) || 'API error'))
    return data
  })
}

async function bind(ctx) {
  const qr = await weixin(ctx, base, 'get_bot_qrcode?bot_type=3', { local_token_list: [] })
  if (!qr.qrcode || !qr.qrcode_img_content) throw new ChannelError('获取微信二维码失败。')
  await ctx.qr(qr.qrcode_img_content)
  let host = base, verifyCode = ''
  while (!ctx.signal.aborted) {
    let path = 'get_qrcode_status?qrcode=' + encodeURIComponent(qr.qrcode)
    if (verifyCode) path += '&verify_code=' + encodeURIComponent(verifyCode)
    const result = await weixin(ctx, host, path)
    if (result.status === 'confirmed' && result.bot_token && result.ilink_bot_id) {
      const account = { token: result.bot_token, id: result.ilink_bot_id,
        host: verifiedUrl(result.baseurl || base, 'weixin.qq.com').origin }
      ctx.store('account', JSON.stringify(account))
      return account
    }
    if (result.status?.includes('need_verifycode')) verifyCode = await ctx.requestPin()
    if (result.status === 'scaned') { verifyCode = ''; ctx.status('scanned') }
    if (result.status === 'scaned_but_redirect') host = verifiedUrl('https://' + result.redirect_host, 'weixin.qq.com').origin
    if (['expired', 'verify_code_blocked', 'binded_redirect'].includes(result.status)) throw new PairingExpired('微信二维码已失效，请重新扫码。')
    await delay(750, undefined, { signal: ctx.signal })
  }
  ctx.signal.throwIfAborted()
}

export async function wechat(ctx) {
  const saved = ctx.load('account')
  if (!saved && ctx.canStartPairing === false) throw new PairingExpired('请打开频道配置，重新扫码登录微信。')
  const account = saved ? JSON.parse(saved) : await bind(ctx)
  if (!saved) ctx.ready(account.id)
  const call = (method, body) => weixin(ctx, account.host, method, {
    ...body, base_info: { channel_version: version, bot_agent: 'BoTeam/0.1' },
  }, account.token)
  let cursor = ctx.load('cursor') || ''
  while (!ctx.signal.aborted) {
    const updates = await call('getupdates', { get_updates_buf: cursor })
    ctx.ready(account.id)
    for (const m of updates.msgs || []) {
      if (m.message_type !== 1 || !m.context_token || !m.from_user_id) continue
      const text = m.item_list?.filter(item => item.type === 1).map(item => item.text_item?.text).join('\n')
      ctx.receive({ id: String(m.client_id || [m.message_id, m.seq, m.create_time_ms].join('/')),
        sender: m.from_user_id, room: m.group_id || m.from_user_id, group: !!m.group_id, mentioned: false, text,
        reply: content => call('sendmessage', { msg: { from_user_id: '', to_user_id: m.from_user_id,
          client_id: randomUUID(), message_type: 2, message_state: 2, context_token: m.context_token,
          item_list: [{ type: 1, text_item: { text: content } }] } }) })
    }
    if (updates.get_updates_buf && cursor !== updates.get_updates_buf) {
      cursor = updates.get_updates_buf
      ctx.store('cursor', cursor)
    }
  }
}
