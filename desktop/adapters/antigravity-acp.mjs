import { spawn } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { invocation } from './antigravity-profile.mjs'
import { inputWindowError } from './usage.mjs'

function rpcError(error, method) {
  if (method === 'session/prompt') {
    const overflow = inputWindowError(error?.message)
    if (overflow) return overflow
  }
  if (error?.code === -32000 || /authenticat|unauthorized|sign in/i.test(error?.message))
    return Object.assign(new Error('Antigravity 原生登录已失效，请重新授权。'), {
      code: 'AGY_AUTH_REQUIRED',
      authExpired: true,
    })
  if (/quota|limit|429|resource.exhausted/i.test(error?.message))
    return new Error('Antigravity 订阅额度或速率已达上限。')
  if (method === 'session/resume' && (
    error?.code === -32601 || (error?.code === -32603 && /load it with.*session\/load/i.test(error.message))
  ))
    return Object.assign(new Error('Antigravity 需要从本机历史载入此会话。'), { code: 'AGY_LOAD_REQUIRED' })
  if (/session|conversation|trajectory not found/i.test(error?.message))
    return new Error('无法恢复此 Antigravity 原生会话。')
  return new Error('Antigravity 原生请求失败，请检查 CLI 和账号状态。')
}

export async function withAcp(profile, signal, handle, work, options = {}) {
  signal?.throwIfAborted()
  const realCwd =
    typeof options.cwd === 'string' && options.cwd
      ? await realpath(options.cwd).catch(() => null)
      : null
  const skipPermissions = options.skipPermissions === true
  const acpArgs = [
    'acp',
    '--include-default-customizations=false',
    '--disable-telemetry',
    '--log-file',
    '/dev/null',
    ...(realCwd && realCwd !== profile.home ? ['--add-dir', realCwd] : []),
    ...(skipPermissions ? ['--dangerously-skip-permissions'] : []),
  ]
  const [command, ...argv] = invocation(profile, acpArgs, {
    ...(skipPermissions && realCwd ? { workspaceWriteRoot: realCwd } : {}),
  })
  const child = spawn(command, argv, {
    cwd: profile.home,
    env: profile.env,
    stdio: ['pipe', 'pipe', 'ignore'],
    detached: true,
  })
  const pending = new Map()
  let seq = 0,
    failure,
    completedTurn = false,
    events = Promise.resolve(),
    finished = false
  const kill = (sig) => {
    try {
      if (child.pid && !finished) process.kill(-child.pid, sig)
    } catch {}
  }
  const fail = (error) => {
    if (failure) return
    failure = error
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    pending.clear()
    kill('SIGTERM')
  }
  const abort = () => fail(new Error('Antigravity 任务已停止。'))
  signal?.addEventListener('abort', abort, { once: true })
  const exited = new Promise((resolve) =>
    child.once('close', () => {
      finished = true
      fail(new Error('Antigravity 原生进程已退出。'))
      resolve()
    }),
  )
  child.once('error', () => fail(new Error('无法启动 Antigravity CLI。')))
  child.stdin.on('error', () => fail(new Error('Antigravity 原生连接已断开。')))
  const write = (message) => {
    if (!failure) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
  }
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  lines.on('line', (line) => {
    let msg
    try {
      msg = JSON.parse(line)
      if (msg?.jsonrpc !== '2.0') throw new Error()
    } catch {
      fail(new Error('Antigravity 返回了无效的 ACP 消息。'))
      return
    }
    if (msg.method) {
      events = events
        .then(async () => {
          if (failure) return
          const result = await handle?.(msg)
          if (msg.id !== undefined)
            write(
              result === undefined
                ? {
                    id: msg.id,
                    error: {
                      code: -32601,
                      message: 'Unsupported client request',
                    },
                  }
                : { id: msg.id, result },
            )
        })
        .catch(fail)
      return
    }
    const waiter = pending.get(msg.id)
    if (!waiter) return
    clearTimeout(waiter.timer)
    pending.delete(msg.id)
    if (msg.error) waiter.reject(rpcError(msg.error, waiter.method))
    else if (waiter.method === 'session/load') {
      // ACP replays session/update before the load response. Finish processing
      // those frames while the task is still suppressing history and approvals.
      events.then(() => failure ? waiter.reject(failure) : waiter.resolve(msg.result), waiter.reject)
    } else {
      if (waiter.method === 'session/prompt' && msg.result?.stopReason === 'end_turn')
        completedTurn = true
      waiter.resolve(msg.result)
    }
  })
  const request = (method, params, optionalTimeout) => {
    if (failure) return Promise.reject(failure)
    const id = ++seq
    return new Promise((resolve, reject) => {
      const timeout = method === 'authenticate' ? 30 * 60_000 : 25_000
      const timer =
        method === 'session/prompt'
          ? null
          : setTimeout(() => {
            const error = new Error('Antigravity 原生请求超时。')
            if (optionalTimeout) { pending.delete(id); reject(error) } else fail(error)
          }, optionalTimeout || timeout)
      pending.set(id, { resolve, reject, timer, method })
      write({ id, method, params })
    })
  }
  // Work can drain queued notifications at an operation boundary. RPC
  // responses stay independent so an update handler can make requests.
  const drainEvents = async () => {
    await events
    if (failure) throw failure
  }
  try {
    const init = await request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'BoTeam', version: '0.1' },
    })
    if (
      init?.protocolVersion !== 1 ||
      init.agentInfo?.name !== 'Antigravity ACP Server' ||
      !init.authMethods?.some((m) => m.id === 'oauth-personal')
    )
      throw new Error('当前 Antigravity CLI 缺少官方 ACP 订阅支持。')
    const value = await work(request, init.agentCapabilities, drainEvents)
    await drainEvents()
    return value
  } finally {
    signal?.removeEventListener('abort', abort)
    lines.close()
    child.stdin.end()
    // agy flushes the conversation archive asynchronously after the ACP client sends EOF.
    const grace = completedTurn && !failure ? 20_000 : 250
    const soft = setTimeout(() => kill('SIGTERM'), grace),
      hard = setTimeout(() => kill('SIGKILL'), grace + 1000)
    await exited
    clearTimeout(soft)
    clearTimeout(hard)
  }
}

function googleLoginUrl(input) {
  try {
    const url = new URL(input)
    const callback = new URL(url.searchParams.get('redirect_uri'))
    const localCallback = callback.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname) && callback.port &&
      !callback.username && !callback.password && callback.pathname === '/auth/callback'
    const auth = url.searchParams
    if (
      localCallback && url.origin === 'https://accounts.google.com' && !url.username && !url.password &&
      /^\/o\/oauth2\/(?:v2\/)?auth$/.test(url.pathname) && auth.get('response_type') === 'code' &&
      auth.get('code_challenge_method') === 'S256' && auth.get('code_challenge') && auth.get('state')
    ) return url.href
  } catch {}
  throw new Error('Antigravity 未提供有效的 Google 登录地址及本机回调。')
}

// Only the login process sees this PATH entry. Its "open" forwards the initial
// authorization URL to BoTeam. Google's callback and all credentials go directly to agy.
export async function authenticatePersonal(profile, signal, openUrl) {
  signal?.throwIfAborted()
  if (typeof openUrl !== 'function') throw new Error('无法打开 Google 登录浏览器。')
  const dir = await mkdtemp('/tmp/boteam-agy-open-')
  const address = join(dir, 'browser.sock')
  const stop = new AbortController()
  const loginSignal = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal
  const clients = new Set()
  let launchError, opened = false
  const server = createServer((client) => {
    clients.add(client)
    client.on('error', () => client.destroy())
    client.on('close', () => clients.delete(client))
    client.setEncoding('utf8')
    let input = ''
    client.on('data', async (part) => {
      input += part
      try {
        if (input.length > 16_384) throw new Error('Antigravity 登录地址过长。')
        if (!input.includes('\n')) return
        if (!opened && !loginSignal.aborted) {
          opened = true
          const url = googleLoginUrl(input.trim())
          try {
            await openUrl(url)
          } catch {
            throw new Error('无法在默认浏览器中打开 Google 登录页。')
          }
        }
        client.end()
      } catch (error) {
        launchError = error
        stop.abort()
        client.destroy()
      }
    })
  })
  try {
    const opener = '#!/bin/sh\nprintf "%s\\n" "$1" | /usr/bin/nc -U "$BOTEAM_LOGIN_SOCKET"\n'
    await writeFile(join(dir, 'open'), opener, { mode: 0o700 })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(address, resolve)
    })
    const env = { ...profile.env, PATH: dir + ':' + profile.env.PATH, BOTEAM_LOGIN_SOCKET: address }
    await withAcp({ ...profile, env }, loginSignal, null, (request) =>
      request('authenticate', { methodId: 'oauth-personal' }),
    )
  } catch (error) {
    throw launchError || error
  } finally {
    stop.abort()
    for (const client of clients) client.destroy()
    if (server.listening) await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
}
