import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join, dirname, basename, isAbsolute, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { redact } from './native.mjs'

const validStates = new Set(['ready', 'blocked', 'login', 'missing'])
const allowed = [
  'email',
  'source',
  'sourceKind',
  'origin',
  'bin',
  'status',
  'reason',
  'plan',
  'model',
  'cwd',
  'credentialSource',
  'managed',
  'appInstalled',
  'organization',
  'loginState',
  'quota',
]

function metadata(record) {
  const info = {}
  for (const key of allowed)
    if (record[key] !== undefined && record[key] !== null) {
      info[key] =
        typeof record[key] === 'boolean' ? record[key] : redact(record[key]).slice(0, 8192)
    }
  return info
}

// Resolve existing parents as well: a default config path may not exist yet.
async function canonical(path) {
  try { return await realpath(path) } catch (error) {
    if (error.code !== 'ENOENT' || dirname(path) === path) throw error
    return join(await canonical(dirname(path)), basename(path))
  }
}

export class Accounts {
  constructor(workspace, options) {
    this.workspace = workspace
    this.db = workspace.db
    this.root = join(options.root, 'profiles')
    const appData = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
      : process.platform === 'win32' ? (process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'))
      : (process.env.XDG_CONFIG_HOME || join(homedir(), '.config'))
    this.appDirectories = [...new Set([resolve(options.root), join(appData, 'BoTeam')])]
    this.locate = options.locate
    this.discoverySources = options.discoverySources || (() => [undefined])
    this.adapters = options.adapters
    this.openUrl = options.openUrl
    this.candidates = new Map()
    this.updating = new Set()
    this.logins = new Map()
    this.writes = Promise.resolve()
  }
  adapter(provider) {
    if (!Object.hasOwn(this.adapters, provider)) throw new Error('无法识别此原生工具。')
    return this.adapters[provider]
  }
  async probe(provider, source, managed = false, signal = this.workspace.lifetime.signal) {
    const adapter = this.adapter(provider)
    if (source && (typeof source !== 'string' || !isAbsolute(source)))
      throw new Error('请选择本机配置目录。')
    const paths = await this.locate(provider, source)
    if (provider === 'antigravity' && !managed) await this.externalLocation(paths.source)
    let result
    try {
      result = await adapter.detect({ ...paths, managed, signal,
        ...(provider === 'antigravity' && !managed && { checkExternalSource: path => this.externalLocation(path) }),
      })
    } catch (error) {
      if (error.code === 'INTERNAL_PROFILE') throw error
      signal?.throwIfAborted()
      result = {
        status: paths.bin ? 'blocked' : 'missing',
        reason: '无法读取原生登录状态。请检查工具版本和配置目录。',
      }
    }
    if (!validStates.has(result.status)) throw new Error('原生工具返回了未知的登录状态。')
    return {
      ...metadata({ ...paths, ...result }),
      ...(typeof result.configFound === 'boolean' && { configFound: result.configFound }),
      ...(typeof result.requiresAuthorization === 'boolean' && { requiresAuthorization: result.requiresAuthorization }),
      ...(typeof paths.cliInstalled === 'boolean' && { cliInstalled: paths.cliInstalled }),
      provider,
      identity: result.identity ? redact(result.identity) : null,
    }
  }
  async detect({ provider, source }) {
    const keys = provider ? [provider] : Object.keys(this.adapters)
    const entries = await Promise.all(keys.map(async key => {
      if (key === 'antigravity') return this.detectAntigravity(source)
      return Promise.all((source ? [source] : await this.discoverySources(key)).map(dir => this.probe(key, dir)))
    }))
    return entries.flat().map((record) => {
      const candidateId = randomUUID()
      this.candidates.set(candidateId, record)
      if (this.candidates.size > 500) this.candidates.delete(this.candidates.keys().next().value)
      const { binding, ...visible } = record
      return { candidateId, ...visible }
    })
  }
  matchingAntigravityAccount(external) {
    const email = external.email?.toLowerCase()
    if (!email) return
    const accounts = this.db.all(`SELECT id,identity,json_extract(info,'$.source') AS source,
      json_extract(info,'$.managed') AS managed FROM accounts WHERE provider='antigravity'
      AND lower(json_extract(info,'$.email'))=?`, email)
    const verified = accounts.find(row => row.managed && this.ownsProfile(row.source) &&
      row.identity === 'google:' + email)
    if (verified) return verified
    const legacy = accounts.filter(row => !row.managed && row.identity.startsWith('source:'))
    return legacy.find(row => row.source === external.source || row.identity === external.identity) ||
      (legacy.length === 1 ? legacy[0] : undefined)
  }
  async externalLocation(source) {
    if (typeof source !== 'string' || !isAbsolute(source)) throw new Error('请选择本机原生配置目录。')
    const [dir, ...internal] = await Promise.all([resolve(source), ...this.appDirectories].map(canonical))
    const comparable = path => ['darwin', 'win32'].includes(process.platform) ? path.toLowerCase() : path
    const checked = comparable(dir)
    if (internal.map(comparable).some(root => checked === root || checked.startsWith(root + sep))) {
      const error = new Error('请选择 Antigravity 桌面端或 agy 的原生配置目录。')
      error.code = 'INTERNAL_PROFILE'
      throw error
    }
    return dir
  }
  async detectAntigravity(source) {
    if (source && (typeof source !== 'string' || !isAbsolute(source))) throw new Error('请选择本机配置目录。')
    const dirs = source ? [source] : await this.discoverySources('antigravity')
    const probes = await Promise.all(dirs.map(async dir => {
      try { return await this.probe('antigravity', dir) } catch (error) {
        if (source || error.code !== 'INTERNAL_PROFILE') throw error
        return null
      }
    }))
    const seen = new Set()
    const rows = []
    for (const external of probes.filter(Boolean)) {
      const dir = await this.externalLocation(external.source)
      if (seen.has(dir)) continue
      seen.add(dir)
      const saved = this.matchingAntigravityAccount(external)
      const canAuthorize = external.requiresAuthorization ??
        Boolean(external.bin && external.status === 'blocked' && external.identity?.startsWith('source:'))
      const canReuseBinding = Boolean(canAuthorize && saved?.managed && external.loginState !== 'signed-out')
      rows.push({ ...external, canReuseBinding, requiresAuthorization: canAuthorize && !canReuseBinding,
        ...(saved && { existingAccountId: saved.id, binding: { identity:saved.identity, source:saved.source } }),
      })
    }
    return rows
  }
  async recheckExternal(candidate, signal = this.workspace.lifetime.signal) {
    const current = await this.probe('antigravity', candidate.source, false, signal)
    if (!current.bin || current.status === 'missing' || (candidate.configFound && !current.configFound) ||
        current.identity !== candidate.identity ||
        current.email?.toLowerCase() !== candidate.email?.toLowerCase() ||
        (current.loginState === 'signed-out' && candidate.loginState !== 'signed-out') ||
        (current.status === 'blocked' && current.requiresAuthorization === false))
      throw new Error('外部 Antigravity 配置或登录身份已变化，请重新检测。')
    return current
  }
  candidateAccount(candidate) {
    if (!candidate?.existingAccountId) return null
    const current = this.db.account(candidate.existingAccountId)
    if (current.provider !== candidate.provider || current.identity !== candidate.binding?.identity ||
        current.source !== candidate.binding.source)
      throw new Error('账号绑定已变化，请重新检测。')
    return current
  }
  async privateDir() {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    return mkdtemp(join(this.root, 'profile-'))
  }
  ownsProfile(path) {
    return !!path && dirname(resolve(path)) === this.root && /^profile-[a-zA-Z0-9]{6}$/.test(basename(path))
  }
  async release(path) {
    // Only generated direct children are ours. Native client configuration is never deleted.
    if (this.ownsProfile(path)) {
      const inUse = this.db.all('SELECT info FROM accounts').some(({ info }) => {
        const data = JSON.parse(info)
        return data.source === path || data.credentialSource === path
      })
      if (!inUse) await rm(path, { recursive: true, force: true })
    }
  }
  serialize(fn) {
    const op = this.writes.then(fn)
    this.writes = op.catch(() => {})
    return op
  }
  async adopt(candidate, existingId, signal = this.workspace.lifetime.signal) {
    if (this.workspace.closed) throw new Error('工作台已关闭。')
    signal.throwIfAborted()
    if (!candidate.identity || !['ready', 'blocked'].includes(candidate.status))
      throw new Error('请在原生工具完成登录并重新检测。')
    const known = this.db.get(
      'SELECT id FROM accounts WHERE provider=? AND identity=?',
      candidate.provider,
      candidate.identity,
    )
    const target = existingId ? this.db.account(existingId) : null
    const firstVerifiedLogin =
      target?.status === 'blocked' && target.identity.startsWith('source:') && !known
    if (
      firstVerifiedLogin && target.provider === 'antigravity' && target.email &&
      target.email.toLowerCase() !== candidate.email?.toLowerCase()
    ) throw new Error('Google 登录邮箱与此 Antigravity 来源显示的邮箱不符。请使用原账号重新授权，或单独添加新账号。')
    if (target && known?.id !== existingId && !firstVerifiedLogin)
      throw new Error('本次登录的身份与绑定账号不符，原绑定已保留。')
    const existing = target || (known ? this.db.account(known.id) : null)
    if (candidate.provider === 'antigravity' && !candidate.managed && candidate.status === 'blocked' &&
        existing?.email && existing.email.toLowerCase() !== candidate.email?.toLowerCase())
      throw new Error('同一来源的上次登录邮箱已变更。请直接授权并导入所选 Google 账号。')
    if (existing && this.workspace.busyAccount(existing.id))
      throw new Error('账号仍有待处理任务，请结束任务后更新绑定。')
    const id = existing?.id || randomUUID()
    if (existing) this.updating.add(id)
    let profile
    try {
      const externalAgy = candidate.provider === 'antigravity' && !candidate.managed && candidate.status === 'ready'
      const reusable = !externalAgy && !firstVerifiedLogin && existing?.source
      profile = reusable ? existing.source : await this.privateDir()
      const threadIds = this.db
        .all('SELECT threadId FROM threads WHERE accountId=?', id)
        .map((r) => r.threadId)
      const prepared = await this.adapter(candidate.provider).prepare({
        candidate: { ...candidate, signal },
        profile,
        existing: firstVerifiedLogin ? null : existing,
        isLogin: candidate.managed === true,
        threadIds,
      })
      if (this.workspace.closed) throw new Error('工作台已关闭。')
      signal.throwIfAborted()
      if (prepared.identity && prepared.identity !== candidate.identity)
        throw new Error('导入期间账号身份已变化，请重新检测。')
      if (externalAgy && (!prepared.managed || prepared.source !== profile || prepared.status !== 'ready' ||
          prepared.identity !== candidate.identity))
        throw new Error('未能在独立 agy 配置中核验该订阅，导入已停止。')
      const origin = candidate.managed && candidate.provider === 'antigravity'
        ? (candidate.origin || existing?.origin || candidate.source) : candidate.source
      const info = metadata({ ...candidate, ...prepared, origin })
      if (candidate.provider === 'antigravity' && existing?.managed && existing.identity === candidate.identity) {
        if (!info.cwd && existing.cwd) info.cwd = existing.cwd
        if (!info.model && existing.model) info.model = existing.model
        if (prepared.source === existing.source && !info.credentialSource && existing.credentialSource)
          info.credentialSource = existing.credentialSource
      }
      if (existing)
        this.db.run(
          'UPDATE accounts SET identity=?,info=? WHERE id=?',
          candidate.identity,
          JSON.stringify(info),
          id,
        )
      else
        this.db.run(
          'INSERT INTO accounts(id,provider,identity,info) VALUES(?,?,?,?)',
          id,
          candidate.provider,
          candidate.identity,
          JSON.stringify(info),
        )
      if (existing) {
        await this.release(existing.source)
        if (existing.managed) await this.release(existing.credentialSource)
      }
      await this.release(profile)
      this.workspace.notify()
      return id
    } catch (e) {
      await this.release(profile)
      throw e
    } finally {
      this.updating.delete(id)
    }
  }
  async import({ candidateIds }) {
    if (!Array.isArray(candidateIds) || !candidateIds.length)
      throw new Error('请先选择要导入的账号。')
    const ids = []
    const errors = []
    for (const key of new Set(candidateIds)) {
      const candidate = this.candidates.get(key)
      if (!candidate) {
        errors.push('检测记录已失效，请重新检测。')
        continue
      }
      try {
        ids.push(await this.serialize(async () => {
          const bound = this.candidateAccount(candidate)
          if (candidate.provider !== 'antigravity') return this.adopt(candidate, bound?.id)
          const direct = candidate.status === 'ready'
          if (!direct && !candidate.canReuseBinding) throw new Error('请先通过 Google 官方授权绑定此订阅。')
          const external = await this.recheckExternal(candidate)
          if (direct && external.status !== 'ready') throw new Error('原生登录状态已变化，请重新检测。')
          if (bound?.managed && this.ownsProfile(bound.source)) {
            const verified = await this.probe('antigravity', bound.source, true)
            if (verified.status === 'ready' && verified.identity === bound.identity &&
                verified.email?.toLowerCase() === external.email?.toLowerCase() &&
                (!direct || (verified.identity === external.identity && verified.plan && verified.plan === external.plan))) {
              return this.adopt({ ...verified, managed:true, origin:external.source, sourceKind:external.sourceKind,
                ...(external.model && {model:external.model}), ...(external.cwd && {cwd:external.cwd}),
              }, bound.id)
            }
          }
          if (direct) return this.adopt(external, bound?.id)
          throw new Error('现有绑定无法核验此 Google 账号，请重新授权。')
        }))
      } catch (e) {
        errors.push(redact(e.message))
      }
    }
    if (errors.length)
      throw new Error((ids.length ? `已导入 ${ids.length} 个账号。` : '') + errors.join(' '))
    return [...new Set(ids)]
  }
  async login({ provider, accountId, candidateId, requestId, fresh = false }) {
    const candidate = candidateId ? this.candidates.get(candidateId) : null
    if (candidateId && (!candidate || candidate.provider !== 'antigravity'))
      throw new Error('检测记录已失效，请重新检测。')
    if (candidate && !candidate.requiresAuthorization && !candidate.canReuseBinding)
      throw new Error('此原生配置不支持通过此入口授权，请重新检测。')
    if (candidate && ((provider && provider !== candidate.provider) ||
        (accountId && accountId !== candidate.existingAccountId))) throw new Error('所选账号与检测记录不符。')
    if (requestId != null && (typeof requestId !== 'string' || !/^[\w-]{1,128}$/.test(requestId) ||
        [...this.logins.values()].some(login => login.requestId === requestId))) throw new Error('登录请求无效。')
    const current = candidate ? this.candidateAccount(candidate) : accountId ? this.db.account(accountId) : null
    const key = current?.provider || candidate?.provider || provider
    const adapter = this.adapter(key)
    const previous = this.logins.get(key)
    if (previous && !previous.controller.signal.aborted) throw new Error('该工具已有正在进行的授权，请先取消该次授权。')
    const abort = new AbortController()
    const { promise: done, resolve: finish } = Promise.withResolvers()
    const login = { controller: abort, accountId: current?.id, requestId, done }
    this.logins.set(key, login)
    let source, verified = false, timedOut = false
    const newScope = candidate
      ? 'source-' + createHash('sha256').update(JSON.stringify([candidate.source, candidate.email])).digest('hex')
      : 'new'
    const stageKey = typeof adapter.hasStagedLogin === 'function'
      ? 'pending-login/' + key + '/' + (current?.id || newScope)
      : null
    const timeout = setTimeout(() => {
      timedOut = true
      abort.abort()
    }, (stageKey ? 30 : 5) * 60_000)
    try {
      // Reserve the new UI request immediately, but let the old CLI release its
      // callback listener and finish cleaning its staged profile before starting.
      if (previous) await previous.done
      abort.signal.throwIfAborted()
      if (candidate) await this.recheckExternal(candidate, abort.signal)
      if (stageKey) {
        const saved = this.db.get('SELECT value FROM settings WHERE key=?', stageKey)?.value
        if (this.ownsProfile(saved)) {
          if (!fresh && await adapter.hasStagedLogin({ source: saved })) source = saved
          else await this.release(saved)
        }
      }
      source ||= await this.privateDir()
      if (stageKey) this.db.run('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)', stageKey, source)
      const paths = await this.locate(key, source)
      abort.signal.throwIfAborted()
      await adapter.login({ ...paths, openUrl: this.openUrl, signal: abort.signal })
      abort.signal.throwIfAborted()
      const record = await this.probe(key, source, true, abort.signal)
      abort.signal.throwIfAborted()
      record.managed = true
      if (record.status !== 'ready')
        throw new Error(record.reason || '官方授权完成后仍无法核实账号。')
      verified = true
      if (candidate?.email && record.email?.toLowerCase() !== candidate.email.toLowerCase())
        throw new Error('Google 登录邮箱与所选 Antigravity 账号不符，请选择对应账号重新授权。')
      if (candidate) {
        const external = await this.recheckExternal(candidate, abort.signal)
        record.origin = external.source
        if (external.sourceKind) record.sourceKind = external.sourceKind
        if (external.model) record.model = external.model
        if (external.cwd) record.cwd = external.cwd
      }
      return await this.serialize(() => {
        this.candidateAccount(candidate)
        return this.adopt(record, current?.id, abort.signal)
      })
    } catch (error) {
      const message = timedOut ? '原生登录窗口已超时。' : abort.signal.aborted ? '已取消本次授权。' : redact(error.message)
      if (stageKey && source && !verified && await adapter.hasStagedLogin({ source })) {
        source = null // The native grant can be resumed after closing the window or restarting BoTeam.
        throw new Error(message + ' 已保留本次 Google 授权，可继续完成原生设置。')
      }
      if (timedOut) throw new Error(message + ' 请在账号管理中重新授权。')
      if (requestId && abort.signal.aborted) throw new Error(message)
      throw error
    } finally {
      clearTimeout(timeout)
      try {
        if (source) {
          if (stageKey) this.db.run('DELETE FROM settings WHERE key=? AND value=?', stageKey, source)
          await this.release(source)
        }
      } finally {
        if (this.logins.get(key) === login) this.logins.delete(key)
        finish()
      }
    }
  }
  cancelLogin({ requestId }) {
    if (typeof requestId !== 'string' || !requestId) return false
    const login = [...this.logins.values()].find(entry => entry.requestId === requestId)
    if (!login) return false
    login.controller.abort()
    return true
  }
  cancelAllLogins() {
    for (const { controller } of this.logins.values()) controller.abort()
  }
  async remove({ id }) {
    return this.serialize(async () => {
      const account = this.db.account(id)
      if (this.logins.get(account.provider)?.accountId === id) throw new Error('请先完成或关闭此账号的原生登录。')
      if (this.workspace.busyAccount(id)) throw new Error('请先停止该账号正在执行或排队的任务。')
      const stageKey = 'pending-login/' + account.provider + '/' + id
      const staged = this.db.get('SELECT value FROM settings WHERE key=?', stageKey)?.value
      this.db.transaction(() => {
        this.db.run('UPDATE bots SET archived=1 WHERE accountId=?', id)
        this.db.run('DELETE FROM accounts WHERE id=?', id)
        this.db.run('DELETE FROM settings WHERE key=?', stageKey)
      })
      if (staged) await this.release(staged)
      await this.release(account.source)
      if (account.managed) await this.release(account.credentialSource)
      this.workspace.notify()
    })
  }
}
