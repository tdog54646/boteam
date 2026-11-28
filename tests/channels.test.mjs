import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Workspace } from '../desktop/workspace.mjs'
import { platforms } from '../desktop/channels/catalog.mjs'
import { telegram, discord, dingtalk } from '../desktop/channels/gateways.mjs'
import { wechat } from '../desktop/channels/wechat.mjs'
import { chunks, verifiedUrl, jsonRequest } from '../desktop/channels/transport.mjs'
import { permissionModes as codexModes } from '../desktop/adapters/codex.mjs'
import { permissionModes as claudeModes } from '../desktop/adapters/claude.mjs'
import { permissionModes as agyModes } from '../desktop/adapters/antigravity.mjs'
import { antigravityLocationError } from '../desktop/adapters/antigravity-errors.mjs'

const safeStorage = { isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(value).reverse(), decryptString: bytes => Buffer.from(bytes).reverse().toString() }
function untilAborted(signal) {
  return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
}
async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'boteam-channel-'))
  const adapters = Object.fromEntries(['claude', 'codex', 'antigravity'].map(provider => [provider, {
    run: async ({ emit, account, prompt }) => {
      emit({ type: 'identity', key: account.identity, value: account.identity })
      emit({ type: 'text', value: account.provider + '/' + prompt })
    },
  }]))
  const options = { root, safeStorage, adapters }
  let ws = new Workspace(options)
  const contexts = new Map()
  const fixtures = Object.fromEntries(platforms.map(({ id }) => [id, async ctx => {
    contexts.set(id, ctx)
    ctx.ready(id + '-account')
    await untilAborted(ctx.signal)
  }]))
  assert.deepEqual(Object.keys(ws.channels.connectors).sort(), platforms.map(p => p.id).sort())
  ws.channels.connectors = fixtures
  const bots = {}
  for (const provider of Object.keys(adapters)) {
    ws.db.run('INSERT INTO accounts(id,provider,identity,info) VALUES(?,?,?,?)', provider, provider, provider, '{"status":"ready"}')
    bots[provider] = await ws.handle('createBot', { name: provider, accountId: provider })
  }
  t.after(async () => { await ws.close(); await rm(root, { recursive: true, force: true }) })
  return { get ws() { return ws }, contexts, bots, async restart() {
    options.channelConnectors = ws.channels.connectors
    await ws.close()
    ws = new Workspace(options)
  } }
}

test('every listed platform routes only explicitly paired peers to its configured native CLI, without duplicate delivery', async t => {
  const f = await workspace(t)
  assert.deepEqual(Object.keys(f.ws.channels.connectors).sort(), platforms.map(p => p.id).sort())
  const replies = []
  for (const [i, platform] of platforms.entries()) {
    const { id } = platform
    const provider = Object.keys(f.bots)[i % 3]
    const payload = { id, botId: f.bots[provider], fields: { token: '123:secretToken', secret: 'secretToken', id: 'application', region: 'lark' } }
    if (platform.qr) {
      await assert.rejects(f.ws.handle('channelSave', payload), /扫码/)
      await f.ws.handle('channelBeginSetup', { id, setupId:'pairing' })
      await f.ws.handle('channelSetBot', { id, botId:payload.botId })
    } else await f.ws.handle('channelSave', payload)
    const ctx = f.contexts.get(id)
    const sent = (messageId, room = 'one') => ctx.receive({ id: messageId, room, sender: 'peer', name: 'Sender',
      text: 'hello', reply: async text => { replies.push(text) } })
    sent('untrusted')
    let config = f.ws.channels.snapshot().find(c => c.id === id)
    assert.equal(config.chats.length, 0)
    assert.equal(config.pending.length, 1)
    assert.doesNotMatch(JSON.stringify(config), /secretToken/)
    await f.ws.handle('channelPair', { id, requestId: config.pending[0].id })
    sent('message')
    sent('message')
    sent('other-room', 'two')
    await Promise.all([...f.ws.lanes.values()])
    config = f.ws.channels.snapshot().find(c => c.id === id)
    assert.equal(config.chats.length, 1)
    assert.equal(config.pending[0].room, 'two')
    assert.equal(replies.filter(text => !text.includes('配对码')).length, i + 1)
    assert.equal(replies.at(-1), provider + '/hello')
    assert.equal(f.ws.db.get("SELECT count(*) AS n FROM channel_events WHERE channel=? AND event='message'", id).n, 1)
  }
})

test('archived channel chats stay archived, restarting preserves grants, revocation and credential changes cut off delivery', async t => {
  const f = await workspace(t)
  const id = 'telegram', botId = f.bots.claude, token = '000:fake'
  const submit = () => f.ws.handle('channelSave', { id, botId, fields: { token } })
  const incoming = (event, ctx = f.contexts.get(id)) => ctx.receive({
    id: event, sender: 'u', room: 'r', text: 'one', reply: async () => {},
  })
  const config = () => f.ws.channels.snapshot().find(c => c.id === id)
  await submit()
  incoming('request')
  await f.ws.handle('channelPair', { id, requestId: config().pending[0].id })
  incoming('one')
  await Promise.all([...f.ws.lanes.values()])
  const archived = config().chats[0].id
  await f.ws.handle('setChatArchived', { chatId: archived, archived: true })
  assert.equal(config().chats.length, 0)
  incoming('two')
  await Promise.all([...f.ws.lanes.values()])
  assert.equal(config().chats.length, 1)
  assert.notEqual(config().chats[0].id, archived)
  const active = config().chats[0].id
  const stale = f.contexts.get(id)
  await f.ws.handle('channelDisconnect', { id })
  await f.restart()
  assert.equal(config().status, 'disconnected')
  assert.equal(config().allowed.length, 1)
  incoming('stopped', stale)
  await f.ws.handle('channelSave', { id, botId, fields: {} })
  incoming('two')
  incoming('three')
  await Promise.all([...f.ws.lanes.values()])
  assert.equal(config().chats[0].id, active)
  assert.equal(f.ws.db.get("SELECT count(*) AS n FROM messages WHERE author='user'").n, 3)
  await f.ws.handle('channelPair', { id, requestId: config().allowed[0].id, revoke: true })
  incoming('denied')
  assert.equal(config().pending.length, 1)
  await f.ws.handle('channelPair', { id, requestId: config().pending[0].id })
  await f.ws.handle('channelSave', { id, botId, fields: { token: '555:replacement' } })
  assert.equal(config().allowed.length, 0)
  await f.ws.handle('channelRemove', { id })
  assert.equal(config().chats[0].id, active)
  assert.equal(f.ws.db.get('SELECT count(*) AS n FROM channel_keys').n, 0)
})

test('authorized overload is visible and answered, and disconnecting during a run retains an unconfirmed reply', async t => {
  const f = await workspace(t), id = 'telegram'
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  f.ws.adapters.claude.run = async ({ emit }) => {
    emit({ type: 'identity', key: 'claude', value: 'claude' })
    entered.resolve()
    await release.promise
    emit({ type: 'text', value: 'local answer' })
  }
  const replies = []
  await f.ws.handle('channelSave', { id, botId: f.bots.claude, fields: { token: '123:token' } })
  const sent = event => f.contexts.get(id).receive({ id: event, room: 'r', sender: 'u', text: 'work', reply: async text => replies.push(text) })
  sent('request')
  assert.match(replies.shift(), /配对码 \d{6}/)
  await f.ws.handle('channelPair', { id, requestId: f.ws.channels.snapshot()[0].pending[0].id })
  const live = f.ws.channels.sessions.get(id)
  live.pendingReplies = 32
  sent('overload')
  sent('overload')
  assert.equal(replies.length, 1)
  assert.match(replies[0], /队列繁忙/)
  assert.match(f.ws.channels.snapshot()[0].detail, /队列已满/)
  assert.equal(f.ws.snapshot().tasks.length, 0)
  live.pendingReplies = 0
  sent('retry')
  await entered.promise
  await f.ws.handle('channelDisconnect', { id })
  release.resolve()
  await Promise.all([...f.ws.lanes.values()])
  assert.equal(replies.length, 1)
  assert.equal(f.ws.channels.snapshot()[0].chats[0].unconfirmed, 1)
  assert.ok(f.ws.snapshot().messages.some(m => m.text === 'local answer'))
  await f.restart()
  assert.equal(f.ws.channels.snapshot()[0].chats[0].unconfirmed, 1)
})

test('Telegram reports a regional refusal once and keeps other native error details on the desktop', async t => {
  const f = await workspace(t), id = 'telegram'
  const replies = []
  let attempts = 0
  f.ws.adapters.antigravity.run = async ({ emit, account }) => {
    emit({ type: 'identity', key: account.identity, value: account.identity })
    if (++attempts === 1) throw antigravityLocationError()
    throw new Error('private fixture detail')
  }
  await f.ws.handle('channelSave', { id, botId: f.bots.antigravity, fields: { token: '123:fixture' } })
  const receive = event => f.contexts.get(id).receive({ id: event, room: 'r', sender: 'u', text: 'hi',
    reply: async text => replies.push(text) })
  receive('pair')
  await f.ws.handle('channelPair', { id, requestId: f.ws.channels.snapshot()[0].pending[0].id })
  receive('first')
  receive('first')
  await Promise.all([...f.ws.lanes.values()])
  assert.equal(attempts, 1)
  assert.match(replies.at(-1), /Google.*地区.*频道配置/)
  const task = f.ws.snapshot().tasks[0]
  assert.equal(task.status, 'failed')
  assert.match(task.error, /400 FAILED_PRECONDITION/)
  assert.ok(!task.authExpired)
  receive('next')
  await Promise.all([...f.ws.lanes.values()])
  assert.equal(attempts, 2)
  assert.match(replies.at(-1), /桌面端查看任务状态/)
  assert.doesNotMatch(replies.join(' '), /private fixture detail/)
})

test('Telegram authenticates, confirms long-poll eligibility, routes one text and acknowledges its update', async t => {
  const controller = new AbortController(), calls = [], received = [], saved = new Map()
  let poll = 0
  t.mock.method(globalThis, 'fetch', async (address, options) => {
    const method = new URL(address).pathname.split('/').at(-1), body = JSON.parse(options.body)
    calls.push({ method, body })
    const data = { getMe: { id: 77, username: 'fixture' }, getWebhookInfo: { url: '' }, sendMessage: {} }
    if (method === 'getUpdates') {
      if (++poll > 1) { controller.abort(); return Response.json({ ok: true, result: [] }) }
      return Response.json({ ok: true, result: [{ update_id: 100, message: { chat: { id: 13 }, from: { id: 15 }, text: 'hello' } }] })
    }
    return Response.json({ ok: true, result: data[method] })
  })
  await telegram({ signal: controller.signal, load: key => saved.get(key), store: (key, value) => saved.set(key, value),
    ready: () => {}, receive: event => { received.push(event); event.reply('world') } }, { token: '42:fixture' })
  assert.deepEqual(received.map(m => [m.room, m.sender, m.text]), [['13', '15', 'hello']])
  assert.equal(calls.find(c => c.method === 'sendMessage').body.chat_id, 13)
  assert.equal(calls.at(-1).body.offset, 101)
})

test('WeChat pairs by QR, keeps session material local and sends replies with their inbound context token', async t => {
  const controller = new AbortController(), saved = new Map(), received = [], replies = []
  let qr, polls = 0
  t.mock.method(globalThis, 'fetch', async (address, options) => {
    const name = new URL(address).pathname.split('/').at(-1)
    const body = options.body && JSON.parse(options.body)
    if (name === 'get_bot_qrcode') return Response.json({ qrcode: 'fixture', qrcode_img_content: 'scan-payload' })
    if (name === 'get_qrcode_status') return Response.json({ status: 'confirmed', bot_token: 'fixture-secret', ilink_bot_id: 'account' })
    assert.equal(options.headers.Authorization, 'Bearer fixture-secret')
    if (name === 'sendmessage') { replies.push(body); return Response.json({ ret: 0 }) }
    if (++polls > 1) { controller.abort(); return Response.json({}) }
    return Response.json({ msgs: [{ message_id: 4, from_user_id: 'u', message_type: 1, context_token: 'thread',
      item_list: [{ type: 1, text_item: { text: 'hi' } }] }], get_updates_buf: 'cursor' })
  })
  await wechat({ signal: controller.signal, qr: value => { qr = value }, load: key => saved.get(key),
    store: (key, value) => saved.set(key, value), ready: () => {}, receive: event => { received.push(event.text); event.reply('reply') } })
  assert.equal(qr, 'scan-payload')
  assert.deepEqual(received, ['hi'])
  assert.equal(replies[0].msg.context_token, 'thread')
  assert.equal(replies[0].msg.item_list[0].text_item.text, 'reply')
  assert.equal(saved.get('cursor'), 'cursor')
})

test('expired WeChat sessions discard the old token and cursor for a fresh QR pairing', async t => {
  const keys = new Map([['account', JSON.stringify({ token: 'expired', id: 'account', host: 'https://ilinkai.weixin.qq.com' })], ['cursor', 'cursor']])
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ret: 1, errcode: -14 }))
  await assert.rejects(wechat({ signal: new AbortController().signal, load: key => keys.get(key), clearKeys: () => keys.clear() }), /重新配对/)
  assert.equal(keys.size, 0)
})

test('Discord and DingTalk gateway fixtures route messages and reply only to the originating platform', async t => {
  for (const id of ['discord', 'dingtalk']) await t.test(id, async t => {
    const controller = new AbortController(), received = [], sent = [], requests = []
    const discordMode = id === 'discord'
    const event = discordMode ? { t: 'MESSAGE_CREATE', d: { id: 'm', type: 0, channel_id: 'room', author: { id: 'sender' }, content: 'hi' } }
      : { type: 'CALLBACK', headers: { topic: '/v1.0/im/bot/messages/get', messageId: 'm' }, data: JSON.stringify({ msgId: 'm',
        conversationId: 'room', senderId: 'sender', msgtype: 'text', text: { content: 'hi' }, sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession' }) }
    class FixtureSocket {
      constructor() {
        setImmediate(() => {
          this.onopen()
          if (discordMode) for (const frame of [{ op: 10, d: { heartbeat_interval: 40000 } }, { t: 'READY', d: { user: { id: 'a', username: 'bot' } } }])
            this.onmessage({ data: JSON.stringify(frame) })
          this.onmessage({ data: JSON.stringify(event) })
        })
      }
      send(data) { sent.push(JSON.parse(data)) }
      close() {}
    }
    const originalSocket = globalThis.WebSocket
    globalThis.WebSocket = FixtureSocket
    t.after(() => { globalThis.WebSocket = originalSocket })
    t.mock.method(globalThis, 'fetch', async (address, options) => {
      requests.push(String(address))
      return Response.json(requests.length > 1 ? {} : discordMode ? { url: 'wss://gateway.discord.gg' }
        : { endpoint: 'wss://fixture.dingtalk.com/connect', ticket: 'ticket' })
    })
    await (discordMode ? discord : dingtalk)({ signal: controller.signal, ready() {}, receive: event => {
      received.push([event.id, event.sender, event.room, event.text])
      event.reply('hi').then(() => controller.abort())
    } }, { id: 'id', token: 'token', secret: 'secret' })
    assert.deepEqual(received, [['m','sender','room','hi']])
    assert.equal(sent.length, 1)
    assert.equal(requests[1], discordMode ? 'https://discord.com/api/v10/channels/room/messages' : 'https://oapi.dingtalk.com/robot/sendBySession')
  })
})

test('gateway URLs reject off-platform redirects and chunked replies preserve Unicode', () => {
  assert.throws(() => verifiedUrl('https://example.org/a', 'dingtalk.com'))
  assert.throws(() => verifiedUrl('http://oapi.dingtalk.com', 'dingtalk.com'))
  const input = '中文🙂'.repeat(1000)
  const parts = chunks(input)
  assert.equal(parts.join(''), input)
  assert.ok(parts.every(part => Buffer.byteLength(part) <= 1800))
})

test('rate-limited chunks use Telegram or Discord retry delays, bound attempts, and cancel outstanding waits', async t => {
  for (const [name, data, headers] of [
    ['Telegram', { parameters: { retry_after: 0.001 } }, {}],
    ['Discord', { retry_after: 0.001 }, { 'Retry-After': '0.001' }],
  ]) await t.test(name, async t => {
    const controller = new AbortController(), payloads = []
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      payloads.push(JSON.parse(options.body))
      return payloads.length === 2 ? Response.json({ ok: true }) : Response.json(data, { status: 429, headers })
    })
    const options = { signal: controller.signal, body: { text: 'current chunk' }, retry429: true }
    assert.deepEqual(await jsonRequest('https://fixture.invalid', options), { ok: true })
    assert.deepEqual(payloads, [{ text: 'current chunk' }, { text: 'current chunk' }])
    await assert.rejects(jsonRequest('https://fixture.invalid', options), /429/)
    assert.equal(payloads.length, 6)
    const waiting = jsonRequest('https://fixture.invalid', options)
    controller.abort()
    await assert.rejects(waiting, { name: 'AbortError' })
    assert.equal(payloads.length, 7)
  })
})

test('QR setup is scoped to its window, refresh discards old keys and closing the dialog never persists an unfinished pairing', async t => {
  const f = await workspace(t)
  const id = 'wechat', setupId = 'setup-1', owner = { window: {} }, other = { window: {} }
  const attempts = []
  f.ws.channels.connectors.wechat = async ctx => { attempts.push(ctx); await untilAborted(ctx.signal) }
  const config = () => f.ws.channels.snapshot().find(row => row.id === id)
  await f.ws.handle('channelBeginSetup', { id, setupId }, owner)
  await attempts[0].qr('real-provider-payload-fixture')
  attempts[0].store('account', 'secret-a')
  assert.equal(config().configured, false)
  assert.match(config().setup.qr, /^data:image\/png;base64,/)
  assert.equal(f.ws.db.get('SELECT count(*) AS n FROM channels').n, 0)
  assert.equal(f.ws.db.get('SELECT count(*) AS n FROM channel_keys').n, 0)
  await assert.rejects(f.ws.handle('channelBeginSetup', { id, setupId: 'other' }, other), /另一个窗口/)
  await f.ws.handle('channelCancelSetup', { id, setupId }, other)
  assert.equal(attempts[0].signal.aborted, false)
  await f.ws.handle('channelBeginSetup', { id, setupId, refresh: true }, owner)
  assert.equal(attempts[0].signal.aborted, true)
  assert.equal(attempts[1].load('account'), null)
  attempts[0].ready('stale')
  assert.equal(config().configured, false)
  await f.ws.handle('channelCancelSetup', { id, setupId }, owner)
  assert.equal(attempts[1].signal.aborted, true)
  assert.equal(config(), undefined)
  await f.ws.handle('channelBeginSetup', { id, setupId: 'next' }, owner)
  f.ws.channels.cancelSetupsForWindow(other.window)
  assert.equal(attempts[2].signal.aborted, false)
  f.ws.channels.cancelSetupsForWindow(owner.window)
  assert.equal(attempts[2].signal.aborted, true)
  await f.restart()
  assert.equal(config(), undefined)
})

test('successful QR pairing persists without a Bot; explicit native Bot rebinding keeps the connection and survives restarts', async t => {
  const f = await workspace(t), id = 'whatsapp', owner = { window: {} }
  const attempts = [], resumes = []
  f.ws.channels.connectors.whatsapp = async ctx => {
    attempts.push(ctx)
    const saved = ctx.load('creds')
    if (saved) { resumes.push(saved); ctx.ready('account', 'stable') }
    await untilAborted(ctx.signal)
  }
  const config = () => f.ws.channels.snapshot().find(row => row.id === id)
  const replies = []
  const incoming = (ctx, event) => ctx.receive({ id: event, sender: 'friend', room: 'chat', text: 'hello',
    reply: async text => replies.push(text) })
  await f.ws.handle('channelBeginSetup', { id, setupId: 'first' }, owner)
  let ctx = attempts[0]
  ctx.store('creds', 'secret fixture')
  ctx.ready('account', 'stable')
  assert.equal(config().configured, true)
  assert.equal(config().setup, null)
  assert.equal(config().botId, '')
  assert.equal(config().status, 'connected')
  await f.ws.handle('channelCancelSetup', { id, setupId: 'first' }, owner)
  assert.equal(ctx.signal.aborted, false)
  incoming(ctx, 'request')
  await f.ws.handle('channelPair', { id, requestId: config().pending[0].id })
  incoming(ctx, 'no-bot')
  assert.equal(f.ws.snapshot().tasks.length, 0)
  for (const [provider, botId] of Object.entries(f.bots)) {
    await f.ws.handle('channelSetBot', { id, botId })
    assert.equal(attempts.length, 1)
    assert.equal(ctx.signal.aborted, false)
    incoming(ctx, provider)
    await Promise.all([...f.ws.lanes.values()])
    assert.equal(replies.at(-1), provider + '/hello')
  }
  await f.ws.handle('channelBeginSetup', { id, setupId: 'replacement' }, owner)
  await f.ws.handle('channelCancelSetup', { id, setupId: 'replacement' }, owner)
  assert.equal(config().allowed.length, 1)
  assert.equal(ctx.signal.aborted, false)
  await f.restart()
  assert.equal(config().botId, f.bots.antigravity)
  assert.equal(config().status, 'connected')
  assert.deepEqual(resumes, ['secret fixture'])
  assert.equal(config().allowed.length, 1)
  ctx = attempts.at(-1)
  await f.ws.handle('channelSetBot', { id, botId: '' })
  incoming(ctx, 'unbound')
  assert.equal(f.ws.snapshot().tasks.length, 3)
  assert.equal(ctx.signal.aborted, false)
})

test('credential-based channels can connect before a Bot is selected', async t => {
  const f = await workspace(t), id = 'telegram'
  await f.ws.handle('channelSave', { id, fields: { token: '123:token' } })
  const config = f.ws.channels.snapshot().find(row => row.id === id)
  assert.equal(config.status, 'connected')
  assert.equal(config.botId, '')
  assert.equal(config.configured, true)
  assert.doesNotMatch(JSON.stringify(config), /123:token/)
  await assert.rejects(f.ws.handle('channelSetBot', { id, botId: 'absent' }))
  assert.equal(f.ws.channels.snapshot()[0].status, 'connected')
})

test('re-pairing the same native account retains its rights; scanning a different account replaces the keys and clears grants atomically', async t => {
  const f = await workspace(t), id = 'wechat', owner = { window:{} }, attempts = []
  f.ws.channels.connectors.wechat = async ctx => { attempts.push(ctx); await untilAborted(ctx.signal) }
  const pair = async (setupId, account) => {
    await f.ws.handle('channelBeginSetup', { id,setupId }, owner)
    const ctx = attempts.at(-1)
    ctx.store('account', 'secret/' + setupId)
    ctx.ready(account, account)
    return ctx
  }
  const cfg = () => f.ws.channels.snapshot()[0]
  const generation = () => f.ws.db.get('SELECT generation FROM channels WHERE id=?',id).generation
  const first = await pair('initial','account-one')
  await f.ws.handle('channelSetBot', { id,botId:f.bots.claude })
  await first.receive({ id:'request',sender:'friend',room:'dm',text:'hello',reply:async () => {} })
  await f.ws.handle('channelPair', { id,requestId:cfg().pending[0].id })
  await f.ws.handle('channelSetAccess', { id, access:{ ...cfg().access, allowFrom:['friend-two'] } })
  const oldGeneration = generation()
  const same = await pair('same','account-one')
  assert.equal(first.signal.aborted, true)
  assert.equal(generation(), oldGeneration)
  assert.equal(cfg().allowed[0].sender, 'friend')
  assert.deepEqual(cfg().access.allowFrom, ['friend-two'])
  const next = await pair('replacement','account-two')
  assert.equal(same.signal.aborted, true)
  assert.notEqual(generation(), oldGeneration)
  assert.deepEqual(cfg().allowed, [])
  assert.deepEqual(cfg().access.allowFrom, [])
  assert.equal(cfg().botId, f.bots.claude)
  assert.equal(next.load('account'), 'secret/replacement')
  assert.doesNotMatch(JSON.stringify(cfg()), /secret\//)
})

test('DM pairing codes are shown once and grant no authority; old incoming events cannot replay after an approval', async t => {
  const f = await workspace(t), id = 'telegram', replies = []
  await f.ws.handle('channelSave', { id, botId: f.bots.codex, fields: { token: '123:token' } })
  const ctx = f.contexts.get(id), config = () => f.ws.channels.snapshot()[0]
  const incoming = (event, text) => ctx.receive({ id: event, room: 'one', sender: 'peer', text, reply: async s => replies.push(s) })
  incoming('first', 'first')
  const req = config().pending[0]
  assert.match(req.code, /^\d{6}$/)
  assert.ok(replies[0].includes(req.code))
  incoming('second', req.code)
  assert.equal(replies.length, 1)
  assert.equal(f.ws.snapshot().tasks.length, 0)
  await f.ws.handle('channelPair', { id, requestId: req.id })
  incoming('first', 'first')
  incoming('second', req.code)
  assert.equal(f.ws.snapshot().tasks.length, 0)
  incoming('third', 'authorized')
  await Promise.all([...f.ws.lanes.values()])
  assert.equal(f.ws.snapshot().tasks.length, 1)
  assert.equal(replies.at(-1), 'codex/authorized')
})

test('Discord checks group mentions and members before reactions or native tasks, then delivers configured reply chunks', async t => {
  const f = await workspace(t), id = 'discord', replies = [], acknowledgements = []
  await f.ws.handle('channelSave', { id, botId: f.bots.codex, fields: { token: 'example' } })
  const access = f.ws.channels.snapshot()[0].access
  await f.ws.handle('channelSetAccess', { id, access: { ...access, dmPolicy: 'allowlist', groups: [{ room: 'room', requireMention: true, allowFrom: ['member'] }],
    delivery: { ...access.delivery, chunkSize: 3, ackReaction: '✅', replyMode: 'first', mentionPatterns: ['hey bot'] } } })
  const incoming = (event, sender, room, text) => f.contexts.get(id).receive({ id: event, group: true, sender, room, text,
    reply: async (content, opts) => { replies.push([content, opts.reference]) }, acknowledge: emoji => { acknowledgements.push(emoji) } })
  incoming('other-room', 'member', 'wrong', 'hey bot')
  incoming('other-user', 'other', 'room', 'hey bot')
  incoming('no-mention', 'member', 'room', 'skip')
  assert.equal(f.ws.snapshot().tasks.length, 0)
  assert.deepEqual(acknowledgements, [])
  await incoming('allowed', 'member', 'room', 'hey bot🙂')
  assert.deepEqual(acknowledgements, ['✅'])
  assert.match(replies.map(([text]) => text).join(''), /member[^\n]*\nhey bot🙂$/)
  assert.ok(replies.every(([text], i) => text.length <= 3 && replies[i][1] === (i === 0)))
  const current = f.ws.channels.snapshot()[0].access, before = replies.length
  await f.ws.handle('channelSetAccess', { id, access: { ...current, delivery:{ ...current.delivery, chunkSize:1 } } })
  await incoming('small-limit', 'member', 'room', 'hey bot🙂')
  assert.equal(replies.length, before)
  assert.match(f.ws.channels.snapshot()[0].detail, /分段长度设为至少 2/)
  await f.ws.handle('channelSave', { id, fields: { token: 'new-token' } })
  assert.deepEqual(f.ws.channels.snapshot()[0].access.groups, [])
  incoming('changed-identity', 'member', 'room', 'hey bot')
  assert.equal(f.ws.snapshot().tasks.length, 2)
})

test('members share a group conversation scoped to room, account and native Bot, with explicit authors and no old private history', async t => {
  const f = await workspace(t), id = 'telegram'
  const cfg = () => f.ws.channels.snapshot()[0]
  await f.ws.handle('channelSave', { id, botId: f.bots.codex, fields: { token: '123:token' } })
  const groups = ['room-A','room-B'].map(room => ({ room, requireMention: false, allowFrom: ['one','two'] }))
  await f.ws.handle('channelSetAccess', { id, access: { ...cfg().access, dmPolicy: 'allowlist', allowFrom: ['one'], groups } })
  let seq = 0
  const replies = []
  const receive = (sender, room, text, group = true) => f.contexts.get(id).receive({
    id: String(++seq), sender, name: sender === 'one' ? 'Alice' : 'Bob', room, roomName: room === 'room-A' ? 'Design' : '',
    group, text, reply: async value => replies.push(value),
  })
  await receive('one','room-A','private legacy message', false)
  const legacyChat = cfg().chats[0].id
  await receive('one','room-A','first public message')
  const group = cfg().chats.find(c => c.id !== legacyChat)
  assert.equal(group.name, 'Telegram · Design')
  await receive('two','room-A','second public message')
  assert.equal(cfg().chats.length, 2)
  assert.doesNotMatch(replies.at(-1), /private legacy message/)
  assert.match(replies.at(-1), /Alice \(one\)/)
  assert.match(replies.at(-1), /Bob \(two\)/)
  assert.deepEqual(f.ws.db.all("SELECT name FROM messages WHERE chatId=? AND author='user' ORDER BY publishSeq", group.id).map(r => r.name),
    ['Alice (one)', 'Bob (two)'])
  const count = f.ws.snapshot().tasks.length
  await receive('outsider','room-A','unauthorized message')
  assert.equal(f.ws.snapshot().tasks.length, count)
  await receive('one','room-B','separate room')
  assert.equal(cfg().chats.length, 3)
  assert.equal(cfg().chats[0].name, 'Telegram · room-B')
  await f.ws.handle('setChatArchived', { chatId: group.id, archived: true })
  await receive('two','room-A','new archive successor')
  assert.equal(cfg().chats.length, 3)
  assert.ok(!cfg().chats.some(c => c.id === group.id))
  assert.doesNotMatch(replies.at(-1), /first public message/)
  await f.ws.handle('channelSetBot', { id, botId: f.bots.antigravity })
  await receive('one','room-A','different bot')
  assert.match(replies.at(-1), /^antigravity\//)
  assert.equal(cfg().chats.length, 4)
  await f.ws.handle('channelSave', { id, fields: { token: '456:another-account' } })
  await f.ws.handle('channelSetAccess', { id, access: { ...cfg().access, groups } })
  await receive('one','room-A','different account')
  assert.equal(cfg().chats.length, 5)
  assert.doesNotMatch(replies.at(-1), /different bot/)
})

test('pairing approvals survive unrelated policy edits and expire with a local status and a fresh code request', async t => {
  const f = await workspace(t), id = 'discord'
  t.mock.timers.enable({ apis: ['Date','setTimeout'], now: Date.now() })
  await f.ws.handle('channelSave', { id, fields: { token: 'example' } })
  const cfg = () => f.ws.channels.snapshot()[0]
  const send = (sender, event) => f.contexts.get(id).receive({ id:event, room:sender, sender, text:'hello', reply:async () => {} })
  assert.match(cfg().detail, /尚未绑定/)
  await send('one','first')
  await send('two','second')
  const [one,two] = cfg().pending
  const access = cfg().access
  await f.ws.handle('channelSetAccess', { id, expectedAccess:access, access:{ ...access, delivery:{ ...access.delivery, ackReaction:'👋' } } })
  assert.deepEqual(cfg().pending.map(req => req.id), [one.id,two.id])
  await f.ws.handle('channelSetAccess', { id, access:{ ...cfg().access, allowFrom:['one'] } })
  assert.deepEqual(cfg().pending.map(req => req.id), [two.id])
  await f.ws.handle('channelSetBot', { id, botId:f.bots.claude })
  t.mock.timers.tick(31 * 60_000)
  assert.deepEqual(cfg().pending, [])
  assert.match(cfg().detail, /配对申请已过期/)
  await assert.rejects(f.ws.handle('channelPair', { id, requestId:two.id }), /过期/)
  await send('two','third')
  assert.notEqual(cfg().pending[0].id, two.id)
  assert.equal(cfg().detail, '')
  assert.equal(f.ws.snapshot().tasks.length, 0)
})

test('a queued channel request checks its sender and bound Bot again before launching the CLI', async t => {
  const f = await workspace(t), id = 'telegram'
  const started = Promise.withResolvers(), finish = Promise.withResolvers(), runs = [], replies = []
  f.ws.adapters.claude.run = async ({ emit, prompt }) => {
    runs.push(prompt)
    emit({ type:'identity', key:'claude', value:'claude' })
    started.resolve()
    await finish.promise
    emit({ type:'text', value:'answer' })
  }
  await f.ws.handle('channelSave', { id, botId:f.bots.claude, fields:{ token:'123:token' } })
  const cfg = () => f.ws.channels.snapshot()[0]
  const access = { ...cfg().access, allowFrom:['user'] }
  await f.ws.handle('channelSetAccess', { id, access })
  const send = msg => f.contexts.get(id).receive({ id:msg, room:'room', sender:'user', text:msg, reply:async s => replies.push(s) })
  const first = send('first')
  await started.promise
  const second = send('second')
  await f.ws.handle('channelSetAccess', { id, access:{ ...access, dmPolicy:'disabled' } })
  finish.resolve()
  await Promise.all([first,second])
  assert.deepEqual(runs, ['first'])
  assert.deepEqual(replies, [])
  assert.equal(cfg().chats[0].unconfirmed, 2)
  await f.ws.handle('channelSetAccess', { id, access })
  const third = send('third')
  await f.ws.handle('channelSetBot', { id, botId:'' })
  await third
  assert.deepEqual(runs, ['first'])
  assert.deepEqual(replies, [])
})

test('each channel permission reaches its bound CLI without changing manual chat settings, and Bot or account switches reset it', async t => {
  const f = await workspace(t), id = 'telegram', seen = []
  const nativeModes = { claude:claudeModes, codex:codexModes, antigravity:agyModes }
  for (const [provider, modes] of Object.entries(nativeModes)) {
    const adapter = f.ws.adapters[provider]
    adapter.permissionModes = modes
    adapter.composerActions = async () => ({ autoReview:true, workspaceAuto:true })
    adapter.run = async ({ permission, planMode, emit, protectedPaths }) => {
      seen.push({ provider, permission, planMode, protectedPaths })
      emit({ type:'identity', key:provider, value:provider })
      emit({ type:'text', value:'reply' })
    }
  }
  const cfg = () => f.ws.channels.snapshot()[0]
  const set = (permission, expectedRevision = cfg().permissionRevision) =>
    f.ws.handle('channelSetPermission', { id, botId:cfg().botId, permission, expectedRevision })
  let seq = 0
  const send = () => f.contexts.get(id).receive({ id:String(++seq), room:'room',sender:'peer',text:'incoming',reply:async () => {} })
  await f.ws.handle('channelSave', { id, fields:{token:'123:fixture'} })
  await f.ws.handle('channelSetAccess', { id, access:{ ...cfg().access, allowFrom:['peer'] } })
  await assert.rejects(f.ws.handle('channelPermissionOptions', { id,botId:f.bots.claude }), /已更改/)
  for (const [provider, modes] of Object.entries(nativeModes)) {
    const botId = f.bots[provider]
    await f.ws.handle('channelSetBot', { id, botId, expectedBotId:cfg().botId, expectedRevision:cfg().permissionRevision })
    assert.equal(cfg().permission, 'default')
    await send()
    const chatId = cfg().chats.find(c => f.ws.db.get('SELECT id FROM members m JOIN bots b ON m.botId=b.id WHERE m.chatId=? AND b.id=?', c.id,botId))?.id
    assert.ok(chatId)
    await f.ws.handle('setComposerSettings', { chatId, botId, permission:provider === 'codex' ? 'read-only' : 'plan' })
    assert.deepEqual((await f.ws.handle('channelPermissionOptions', { id,botId })).modes, modes)
    for (const mode of modes) {
      await set(mode)
      assert.equal(cfg().permission, mode)
      await send()
      assert.equal(seen.at(-1).provider, provider)
      assert.equal(seen.at(-1).permission, mode)
      if (modes.includes('plan')) assert.equal(seen.at(-1).planMode, mode === 'plan')
      if (mode === 'full') assert.ok(seen.at(-1).protectedPaths?.length)
    }
    await assert.rejects(set(provider === 'claude' ? 'full' : 'bogus'), /不支持/)
    const manual = await f.ws.handle('send', { chatId, recipients:[botId],text:'from desktop' })
    await Promise.all([...f.ws.lanes.values()])
    assert.equal(seen.at(-1).permission, provider === 'codex' ? 'read-only' : 'plan')
    assert.ok(f.ws.db.get('SELECT id FROM tasks WHERE messageId=?',manual))
  }
  await set('edits')
  await f.restart()
  assert.equal(cfg().permission,'edits')
  const oldRevision = cfg().permissionRevision
  f.ws.db.run("UPDATE accounts SET identity='replacement' WHERE id='antigravity'")
  assert.equal(cfg().permission, 'default')
  assert.notEqual(cfg().permissionRevision, oldRevision)
  await assert.rejects(set('edits',oldRevision), /已更改/)
})

test('legacy channel permissions follow the existing chat until selected explicitly', async t => {
  const f = await workspace(t), id = 'telegram', botId = f.bots.claude
  f.ws.adapters.claude.permissionModes = claudeModes
  await f.ws.handle('channelSave', { id,botId,fields:{token:'123:fixture'} })
  // Pre-upgrade channels have no channel_permissions row.
  f.ws.db.run('DELETE FROM channel_permissions WHERE channel=?',id)
  await f.restart()
  const cfg = () => f.ws.channels.snapshot()[0]
  assert.equal(cfg().permission, null)
  await f.ws.handle('channelSetAccess', { id, access:{ ...cfg().access, allowFrom:['peer'] } })
  const send = n => f.contexts.get(id).receive({ id:n,room:'dm',sender:'peer',text:'hello',reply:async () => {} })
  const settings = () => JSON.parse(f.ws.db.get('SELECT runSettings FROM tasks ORDER BY rowid DESC LIMIT 1').runSettings)
  await send('first')
  const chatId = cfg().chats[0].id
  assert.equal(settings().permission,'default')
  await f.ws.handle('setComposerSettings', { chatId,botId,permission:'edits' })
  await send('second')
  assert.equal(settings().permission,'edits')
  await f.ws.handle('channelSetPermission', { id,botId,permission:'default',expectedRevision:cfg().permissionRevision })
  await send('third')
  assert.equal(settings().permission,'default')
  assert.equal(f.ws.composer.read(chatId,f.ws.bot(botId)).permission,'edits')
})

test('channel permission changes reject stale or unsupported native capabilities and cannot elevate an already queued request', async t => {
  const f = await workspace(t), id = 'telegram', botId = f.bots.antigravity
  const cfg = () => f.ws.channels.snapshot()[0]
  let workspaceAuto = true, gate, entered
  const runs = []
  f.ws.adapters.antigravity.permissionModes = agyModes
  f.ws.adapters.antigravity.composerActions = async () => {
    entered?.resolve()
    if (gate) await gate.promise
    return { workspaceAuto }
  }
  f.ws.adapters.antigravity.run = async ({ permission,emit }) => {
    runs.push(permission)
    emit({ type:'identity',key:'antigravity',value:'antigravity' })
    emit({ type:'text',value:'done' })
  }
  await f.ws.handle('channelSave', { id,botId,fields:{token:'123:fixture'} })
  await f.ws.handle('channelSetAccess', { id, access:{ ...cfg().access, allowFrom:['peer'] } })
  const set = (permission, expectedRevision = cfg().permissionRevision) =>
    f.ws.handle('channelSetPermission', { id,botId,permission,expectedRevision })
  const recv = event => f.contexts.get(id).receive({ id:event,room:'room',sender:'peer',text:'hello',reply:async () => {} })
  workspaceAuto = false
  assert.ok(!(await f.ws.handle('channelPermissionOptions', { id,botId })).modes.includes('workspace-auto'))
  await assert.rejects(set('workspace-auto'), /未提供/)
  assert.equal(cfg().permission, 'default')
  workspaceAuto = true
  entered = Promise.withResolvers(); gate = Promise.withResolvers()
  const previous = cfg().permissionRevision
  const late = set('workspace-auto')
  await entered.promise
  await set('edits')
  gate.resolve()
  await assert.rejects(late, /已更改/)
  await assert.rejects(f.ws.handle('channelSetBot', { id,botId:'',expectedRevision:previous }), /已更改/)
  gate = null; entered = null
  await set('workspace-auto')
  workspaceAuto = false
  await recv('no-more-capability')
  assert.deepEqual(runs, [])
  assert.match(f.ws.db.get('SELECT error FROM tasks WHERE status=?','failed').error, /未提供/)
  workspaceAuto = true
  entered = Promise.withResolvers(); gate = Promise.withResolvers()
  const held = recv('queued')
  await entered.promise
  await set('plan')
  gate.resolve()
  await held
  assert.deepEqual(runs, [])
  await recv('after-change')
  assert.deepEqual(runs,['plan'])
})
