import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { nativeEnv } from '../native.mjs'
import { codexFullInvocation } from '../codex-permissions.mjs'

export function nativeError(message) {
  const text = String(message || '')
  if (/quota|usage.limit|rate.limit|429|credits|usage_limit_reached/i.test(text))
    return new Error('Codex 订阅额度或速率已达上限，请稍后重试。')
  if (/unauthorized|401|authentication|re-?login|invalid.token|expired|refresh.token/i.test(text))
    return new Error('Codex 登录已失效，请重新授权该账号。')
  if (/model.+(not supported|not found|unavailable)|unsupported.model/i.test(text))
    return new Error('此订阅当前无法使用配置的 Codex 模型。')
  if (/network|connect|timeout|timed out|dns|disconnect/i.test(text))
    return new Error('Codex 连接失败，请检查网络后重试。')
  return new Error('Codex 原生请求失败，请检查账号状态和 CLI 版本。')
}

const notifications = new Set([
  'boteam/refreshRejected',
  'account/login/completed',
  'account/rateLimits/updated',
  'thread/tokenUsage/updated',
  'model/rerouted',
  'thread/compacted',
  'thread/goal/updated',
  'thread/goal/cleared',
  'turn/started',
  'item/autoApprovalReview/started',
  'item/autoApprovalReview/completed',
  'item/agentMessage/delta',
  'item/started',
  'item/completed',
  'turn/completed',
])

export class CodexRpc {
  #child
  #pending = new Map()
  #events = []
  #waiter
  #failure
  #nextId = 1
  #signal
  #abort
  #closed = false
  #exited

  constructor({ bin, source, signal, managed = false, permissionMode, protectedPaths }) {
    if (signal?.aborted) throw new Error('Codex 任务已停止。')
    const args = [
      'app-server',
      '--listen',
      'stdio://',
      '-c',
      'sandbox_workspace_write.network_access=false',
      '-c',
      'sandbox_workspace_write.exclude_tmpdir_env_var=true',
      '-c',
      'sandbox_workspace_write.exclude_slash_tmp=true',
      '-c',
      'sandbox_workspace_write.writable_roots=[]',
      '-c',
      'forced_login_method="chatgpt"',
      '-c',
      'model_provider="openai"',
      '-c',
      'openai_base_url="https://chatgpt.com/backend-api/codex"',
      '-c',
      'chatgpt_base_url="https://chatgpt.com/backend-api/"',
      '-c',
      'cli_auth_credentials_store=' + (managed ? '"file"' : '"ephemeral"'),
    ]
    this.#signal = signal
    const [command, commandArgs] =
      permissionMode === 'full'
        ? codexFullInvocation(bin, args, source, protectedPaths)
        : [bin, args]
    this.#child = spawn(command, commandArgs, {
      cwd: source,
      // This mode isolates user keychains. Use the system's public CA bundle
      // for native TLS verification inside the same account boundary.
      env: nativeEnv({
        CODEX_HOME: source,
        ...(permissionMode === 'full' && { CODEX_CA_CERTIFICATE: '/etc/ssl/cert.pem' }),
      }),
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    })
    this.#abort = () => this.close()
    signal?.addEventListener('abort', this.#abort, { once: true })
    this.#child.once('error', () =>
      this.#fail(new Error('无法启动 Codex CLI，请检查安装和执行权限。')),
    )
    this.#exited = new Promise((resolve) =>
      this.#child.once('close', () => {
        this.#fail(new Error('Codex 原生进程已退出，任务已停止。'))
        resolve()
      }),
    )
    this.#child.stdin.on('error', () => this.#fail(new Error('Codex 原生连接已断开。')))
    const lines = createInterface({ input: this.#child.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => {
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        this.close(new Error('Codex 返回了无法识别的原生协议数据。'))
        return
      }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
        this.close(new Error('Codex 返回了无效的原生协议消息。'))
        return
      }
      if (msg.method) {
        // A refresh may arrive while another request is awaiting its reply.
        if (msg.method === 'account/chatgptAuthTokens/refresh' && msg.id !== undefined) {
          if (this.#failure) return
          this.unsupported(msg.id)
          msg = { method: 'boteam/refreshRejected', params: {} }
        }
        if (msg.id === undefined && !notifications.has(msg.method)) return
        if (this.#waiter) {
          this.#waiter.resolve(msg)
          this.#waiter = undefined
        } else if (!this.#failure) this.#events.push(msg)
        return
      }
      const p = this.#pending.get(msg.id)
      if (!p) return
      this.#pending.delete(msg.id)
      clearTimeout(p.timeout)
      if (msg.error) {
        const error = nativeError(msg.error.message)
        const unknown =
          msg.error.code === -32600 &&
          String(msg.error.message).startsWith(
            'Invalid request: unknown variant `' + p.method + '`,',
          )
        error.rpcCode = unknown ? -32601 : msg.error.code
        error.goalsDisabled =
          msg.error.code === -32600 && msg.error.message === 'goals feature is disabled'
        p.reject(error)
      } else p.resolve(msg.result)
    })
  }

  #fail(err) {
    if (this.#failure) return
    this.#failure = err
    for (const p of this.#pending.values()) {
      clearTimeout(p.timeout)
      p.reject(err)
    }
    this.#pending.clear()
    this.#waiter?.reject(err)
    this.#waiter = undefined
  }

  send(msg) {
    if (this.#failure) throw this.#failure
    this.#child.stdin.write(JSON.stringify(msg) + '\n')
  }

  request(method, params, optionalTimeout) {
    if (this.#failure) return Promise.reject(this.#failure)
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const error = new Error('Codex 原生请求超时，请重试。')
        if (optionalTimeout) {
          this.#pending.delete(id)
          reject(error)
        } else this.close(error)
      }, optionalTimeout || 45_000)
      this.#pending.set(id, { resolve, reject, timeout, method })
      this.send({ id, method, params })
    })
  }

  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'boteam', title: 'BoTeam', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    })
    this.send({ method: 'initialized' })
  }

  next() {
    if (this.#events.length) return Promise.resolve(this.#events.shift())
    if (this.#failure) return Promise.reject(this.#failure)
    return new Promise((resolve, reject) => {
      this.#waiter = { resolve, reject }
    })
  }

  async decision(approve, details) {
    if (this.#failure) throw this.#failure
    // A dead child can no longer consume a decision. Release the pending UI approval immediately.
    return await Promise.race([
      approve(details),
      this.#exited.then(() => {
        throw this.#failure
      }),
    ])
  }

  unsupported(id) {
    this.send({ id, error: { code: -32601, message: 'Unsupported client request' } })
  }

  close(err = new Error('Codex 任务已停止。')) {
    this.#fail(err)
    if (this.#closed) return this.#exited
    this.#closed = true
    this.#signal?.removeEventListener('abort', this.#abort)
    const child = this.#child
    const kill = (sig) => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, sig)
        else child.kill(sig)
      } catch {
        /* An exited process needs no signal. */
      }
    }
    child.stdin.end()
    kill('SIGTERM')
    const timer = setTimeout(() => kill('SIGKILL'), 1000)
    timer.unref()
    child.once('close', () => clearTimeout(timer))
    return this.#exited
  }
}
