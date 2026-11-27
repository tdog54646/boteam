import { setTimeout as delay } from 'node:timers/promises'

// Only explicitly constructed diagnostics may reach the renderer. SDK errors
// can contain an entire HTTP request, including tokens embedded in its URL.
export class ChannelError extends Error {}
export class PairingExpired extends ChannelError {}
export class PairingRestart extends ChannelError {}
export const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this } }

export async function jsonRequest(url, { signal, body, headers, method, beforeSend, timeout = 20_000, retry429 = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    beforeSend?.()
    const deadline = AbortSignal.timeout(timeout)
    const response = await fetch(url, {
      method: method ?? (body === undefined ? 'GET' : 'POST'), redirect: 'error',
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    })
    if (!response.ok && response.status !== 429) throw new ChannelError('HTTP ' + response.status)
    if (response.status === 204) return null
    const data = response.status === 429 ? await response.json().catch(() => ({})) : await response.json()
    const limited = response.status === 429 || (retry429 && data.error_code === 429)
    if (!limited) return data
    // Only an explicit rejection can be retried safely. Timeout and network
    // errors are ambiguous and must not duplicate a successfully sent chunk.
    if (!retry429 || attempt >= 3) throw new ChannelError('HTTP 429')
    const raw = response.headers.get('Retry-After') ?? data.parameters?.retry_after ?? data.retry_after ?? 1
    const ms = Number.isFinite(Number(raw)) ? Number(raw) * 1000 : Date.parse(raw) - Date.now()
    if (!Number.isFinite(ms) || ms > 60_000) throw new ChannelError('HTTP 429')
    await delay(Math.max(25, Math.ceil(ms)), undefined, { signal })
  }
}

export function verifiedUrl(value, domain, protocol = 'https:') {
  const url = new URL(value)
  if (url.protocol !== protocol || url.username || url.password || (url.port && url.port !== '443') ||
      !(url.hostname === domain || url.hostname.endsWith('.' + domain)))
    throw new ChannelError('平台返回的地址无效。')
  return url
}

// The outer connection owns retries. Each attempt tears down its own SDK
// client / socket and heartbeat before the next one is constructed.
export async function connectedUntilClosed(signal, setup) {
  signal.throwIfAborted()
  const { promise, resolve, reject } = Promise.withResolvers()
  const aborted = () => resolve()
  signal.addEventListener('abort', aborted, { once: true })
  let cleanup
  try {
    cleanup = setup(reject)
    await promise
  } finally {
    signal.removeEventListener('abort', aborted)
    cleanup?.()
  }
}

export async function socketConnection(url, ctx, onFrame, onOpen) {
  return connectedUntilClosed(ctx.signal, fail => {
    const socket = new WebSocket(url)
    let heartbeat, deadline = setTimeout(() => fail(new ChannelError('连接超时。')), 30_000)
    const session = {
      send: data => socket.send(JSON.stringify(data)),
      heartbeat: (ms, callback) => {
        clearInterval(heartbeat)
        heartbeat = setInterval(() => { try { callback() } catch (e) { fail(e) } }, ms)
      },
      ready: (who, identity) => { clearTimeout(deadline); ctx.ready(who, identity) },
      fail,
    }
    socket.onopen = () => { try { onOpen?.(session) } catch (e) { fail(e) } }
    socket.onerror = () => fail(new ChannelError('WebSocket 连接失败。'))
    socket.onclose = event => fail(new ChannelError('WebSocket ' + event.code))
    socket.onmessage = event => {
      if (ctx.signal.aborted) return
      try { onFrame(JSON.parse(event.data), session) } catch (error) { fail(error) }
    }
    return () => {
      clearTimeout(deadline)
      clearInterval(heartbeat)
      socket.onmessage = socket.onopen = socket.onclose = null
      socket.onerror = () => {}
      socket.close()
    }
  })
}

// Keep each chunk inside the provider's UTF-8 byte and character limits.
export function chunks(text, budget = 1800) {
  const result = []
  let chunk = '', size = 0
  for (const char of text) {
    const bytes = Buffer.byteLength(char)
    if (size + bytes > budget) { result.push(chunk); chunk = ''; size = 0 }
    chunk += char
    size += bytes
  }
  if (chunk) result.push(chunk)
  return result
}
