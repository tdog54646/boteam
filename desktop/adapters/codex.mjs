import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { redact } from '../native.mjs'
import { CodexRpc, nativeError } from './codex-rpc.mjs'

import {
  allowsAutoReview, checkedGoal, extensionCatalog, goalFields, hasPlanMode,
  nativeFeatures, parkActiveGoal, readGoal, resolveExtensions, respondToQuestions, validateExtensionIds,
} from './codex-composer.mjs'
import { stageFork, verifyFork } from './codex-fork.mjs'
import { codexCommands, compactThread, installedMethods, mcpInfo } from './codex-slash.mjs'
import { contextUsage, imageSnapshots, quotaWindow } from './usage.mjs'
import { codexActivity } from './chat-activity.mjs'
import { codexSubagents } from './codex-subagents.mjs'

export const permissionModes = [
  'default',
  'auto-review',
  'read-only',
  ...(process.platform === 'darwin' ? ['full'] : []),
]
const paidPlans = new Set([
  'go',
  'plus',
  'pro',
  'prolite',
  'team',
  'business',
  'self_serve_business_usage_based',
  'enterprise',
  'enterprise_cbp_usage_based',
  'edu',
])
const invalidIdentity = '无法确认 Codex 订阅身份，请用 ChatGPT 重新授权。'
const mismatch = 'Codex 当前身份与绑定的用户或工作区不一致，已停止派活。'
const expired = 'Codex 访问令牌已过期，请在原客户端刷新登录，或在此重新授权。'

class ProfileError extends Error {
  constructor(message, status = 'blocked') {
    super(message)
    this.status = status
  }
}

async function plainDir(dir, create = false) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir))
    throw new ProfileError('需要 Codex 配置目录的绝对路径。')
  if (create) await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const info = await fs.lstat(dir)
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new ProfileError('Codex 配置目录必须是独立的本机目录。')
}

// Open the file itself with O_NOFOLLOW. A selected profile must never redirect us to credentials elsewhere.
async function readProfileFile(dir, filename, maxBytes) {
  const file = await fs.open(
    path.join(dir, filename),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const s = await file.stat()
    if (!s.isFile() || s.size > maxBytes || (process.getuid && s.uid !== process.getuid()))
      throw new ProfileError('无法安全读取所选 Codex 配置。')
    return await file.readFile('utf8')
  } finally {
    await file.close()
  }
}

async function configHints(source) {
  let config
  try {
    config = await readProfileFile(source, 'config.toml', 1024 * 1024)
  } catch (e) {
    if (e.code === 'ENOENT') return {}
    throw e
  }
  // Only copy a simple native top-level model hint. No arbitrary source configuration enters the runtime.
  const top = config.split(/^\s*\[/m, 1)[0]
  const hint = (name) =>
    top.match(
      new RegExp('^\\s*' + name + '\\s*=\\s*["\']([^"\'\\r\\n]+)["\']\\s*(?:#.*)?$', 'm'),
    )?.[1]
  const provider = hint('model_provider')
  const model = hint('model')
  const openaiUrl = hint('openai_base_url')?.replace(/\/$/, '')
  const chatgptUrl = hint('chatgpt_base_url')?.replace(/\/$/, '')
  const external =
    (provider && provider !== 'openai') ||
    (openaiUrl && openaiUrl !== 'https://chatgpt.com/backend-api/codex') ||
    (chatgptUrl && chatgptUrl !== 'https://chatgpt.com/backend-api') ||
    /^\s*\[\s*model_providers\.(?:"openai"|'openai'|openai)\s*\]/m.test(config)
  return {
    external: Boolean(external),
    store: hint('cli_auth_credentials_store'),
    model: /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,79}$/.test(model || '') ? model : undefined,
    effort: hint('model_reasoning_effort'),
  }
}

async function credential(source) {
  let raw
  try {
    raw = JSON.parse(await readProfileFile(source, 'auth.json', 128 * 1024))
  } catch (e) {
    if (e.code === 'ENOENT')
      throw new ProfileError(
        '未发现可复用的 Codex 文件登录。使用系统钥匙串的账号可在此重新授权。',
        'login',
      )
    throw new ProfileError('无法安全读取 Codex 原生登录文件。')
  }
  if (!raw || (raw.auth_mode && raw.auth_mode !== 'chatgpt') || raw.OPENAI_API_KEY)
    throw new ProfileError('该配置未使用 ChatGPT 订阅登录。')
  const token = raw.tokens?.access_token
  const parts = typeof token === 'string' ? token.split('.') : []
  let claims
  try {
    if (parts.length !== 3 || !parts[2]) throw new Error()
    const header = JSON.parse(Buffer.from(parts[0], 'base64url'))
    if (header.alg !== 'RS256') throw new Error()
    claims = JSON.parse(Buffer.from(parts[1], 'base64url'))
  } catch {
    throw new ProfileError(invalidIdentity)
  }
  const workspace = raw.tokens.account_id
  const auth = claims?.['https://api.openai.com/auth']
  const email = claims?.['https://api.openai.com/profile']?.email || claims?.email
  if (
    claims?.iss !== 'https://auth.openai.com' ||
    typeof claims.sub !== 'string' ||
    !claims.sub ||
    typeof workspace !== 'string' ||
    !workspace ||
    workspace !== auth?.chatgpt_account_id ||
    typeof email !== 'string' ||
    !email ||
    email.length > 320 ||
    /[\r\n\0]/.test(email) ||
    !Number.isFinite(claims.exp)
  )
    throw new ProfileError(invalidIdentity)
  const identity =
    'codex:' +
    createHash('sha256')
      .update(JSON.stringify([claims.sub, workspace]))
      .digest('hex')
  return {
    token,
    workspace,
    email,
    identity,
    expires: claims.exp * 1000,
    plan: auth.chatgpt_plan_type,
  }
}

// Resolve the provider from the actual native configuration, including project and managed layers.
async function verifyTransport(rpc, cwd, store = 'ephemeral') {
  const { config } = await rpc.request('config/read', { cwd, includeLayers: false })
  if (
    !config ||
    config.model_provider !== 'openai' ||
    config.cli_auth_credentials_store !== store ||
    config.forced_login_method !== 'chatgpt' ||
    config.chatgpt_base_url !== 'https://chatgpt.com/backend-api/' ||
    config.model_providers?.openai ||
    config.openai_base_url !== 'https://chatgpt.com/backend-api/codex'
  ) {
    throw new ProfileError('Codex 的有效服务地址或认证方式不匹配，已阻止使用该登录。')
  }
}

async function attest(rpc, auth) {
  if (auth.expires <= Date.now()) throw new ProfileError(expired, 'login')
  await rpc.request('account/login/start', {
    type: 'chatgptAuthTokens',
    accessToken: auth.token,
    chatgptAccountId: auth.workspace,
    chatgptPlanType: auth.plan,
  })
  const { account } = await rpc.request('account/read', { refreshToken: false })
  if (
    account?.type !== 'chatgpt' ||
    typeof account.email !== 'string' ||
    account.email.toLowerCase() !== auth.email.toLowerCase()
  )
    throw new ProfileError(invalidIdentity)
  return { identity: auth.identity, email: account.email, plan: account.planType }
}

async function temporary(fn) {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), 'boteam-codex-'))
  try {
    return await fn(source)
  } finally {
    await fs.rm(source, { recursive: true, force: true })
  }
}

function diagnostic(e) {
  return e instanceof ProfileError
    ? e.message
    : '无法检查 Codex 原生配置，请检查 CLI、目录权限和登录状态。'
}

function codexQuota(result, model) {
  const buckets = result?.rateLimitsByLimitId
  const direct = result?.rateLimits
  const specific = model && (buckets?.[model] || (direct?.limitId === model && direct))
  const limits =
    specific ||
    buckets?.codex ||
    (!direct?.limitId || direct.limitId === 'codex' ? direct : undefined)
  const windows = [limits?.primary, limits?.secondary].flatMap((w) =>
    w && Number.isFinite(w.usedPercent)
      ? quotaWindow(w.windowDurationMins, 100 - w.usedPercent, w.resetsAt * 1000) || []
      : [],
  )
  if (windows.length)
    return { windows, ...(specific ? { scope: 'model', model } : { scope: 'account' }) }
}

async function readQuota(rpc, model, wait = 3500) {
  try {
    return codexQuota(await rpc.request('account/rateLimits/read', {}, wait), model)
  } catch {
    // Quota may be unavailable for a verified account.
  }
}

function quotaSummary(quota) {
  if (!quota) return
  const parts = quota.windows.map(({ minutes, remainingPercent, resetsAt }) => {
    const label =
      minutes % 1440 === 0
        ? minutes / 1440 + ' 天'
        : minutes % 60 === 0
          ? minutes / 60 + ' 小时'
          : minutes + ' 分钟'
    return (
      label +
      '剩余 ' +
      remainingPercent +
      '%' +
      (resetsAt ? '，' + new Date(resetsAt).toISOString() + ' 重置' : '')
    )
  })
  return parts.join(' · ') + '（读取于 ' + new Date().toISOString() + '）'
}

async function modelCatalog(rpc, hints) {
  const models = []
  const seenCursors = new Set()
  let cursor, defaultModel
  do {
    const page = await rpc.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) })
    if (!Array.isArray(page?.data)) throw new Error('Codex 未返回模型列表。')
    for (const item of page.data) {
      if (!item?.model || item.hidden || models.some((m) => m.id === item.model)) continue
      const efforts = (item.supportedReasoningEfforts || [])
        .filter((e) => typeof e.reasoningEffort === 'string')
        .map((e) => ({ id: e.reasoningEffort, label: e.reasoningEffort }))
      models.push({
        id: item.model,
        label: item.displayName || item.model,
        efforts,
        defaultEffort: item.defaultReasoningEffort,
      })
      if (item.isDefault) defaultModel = item.model
    }
    cursor = page.nextCursor
    if (cursor && seenCursors.has(cursor)) throw new Error('Codex 模型列表分页异常。')
    seenCursors.add(cursor)
  } while (cursor)
  if (models.some((m) => m.id === hints.model)) defaultModel = hints.model
  return { models, defaultModel }
}

export async function detect({ source, bin, appInstalled, signal }) {
  if (!bin)
    return {
      status: 'missing',
      reason: appInstalled ? '已找到桌面端，但未找到可执行的 Codex CLI。' : '未找到 Codex CLI。',
    }
  try {
    await plainDir(source)
    const hints = await configHints(source)
    if (hints.store === 'keyring' || hints.store === 'auto' || hints.store === 'ephemeral')
      throw new ProfileError('该配置使用独立凭据存储，请通过 BoTeam 的原生登录添加账号。')
    const auth = await credential(source)
    return await temporary(async (scratch) => {
      const rpc = new CodexRpc({ bin, source: scratch, signal })
      try {
        await rpc.initialize()
        await verifyTransport(rpc, scratch)
        const info = await attest(rpc, auth)
        const reason = hints.external
          ? '所选配置使用自定义模型服务，请使用官方 ChatGPT 授权。'
          : !paidPlans.has(info.plan)
            ? '未能核实该账号具有 ChatGPT 订阅套餐。'
            : undefined
        const { defaultModel } = await modelCatalog(rpc, hints)
        const quota = quotaSummary(await readQuota(rpc, defaultModel, 1500))
        return {
          ...info,
          model: defaultModel,
          quota,
          status: reason ? 'blocked' : 'ready',
          reason,
        }
      } finally {
        await rpc.close()
      }
    })
  } catch (e) {
    if (e.code === 'ENOENT') return { status: 'login', reason: '尚未找到 Codex 配置目录。' }
    return { status: e.status || 'blocked', reason: diagnostic(e) }
  }
}

export async function prepare({ candidate, profile, existing }) {
  const verified = await detect(candidate)
  if (
    !verified.identity ||
    verified.identity !== candidate.identity ||
    (existing?.identity && existing.identity !== verified.identity)
  )
    throw new Error(verified.reason || mismatch)
  await plainDir(profile, true)
  if ((await fs.realpath(profile)) === (await fs.realpath(candidate.source)))
    throw new Error('账号登录目录与会话目录必须独立。')
  return {
    provider: 'codex',
    bin: candidate.bin,
    source: profile,
    credentialSource: candidate.source,
    managed: candidate.managed === true,
    ...verified,
  }
}

export async function login({ source, bin, openUrl, signal }) {
  await plainDir(source, true)
  const rpc = new CodexRpc({ source, bin, signal, managed: true })
  try {
    await rpc.initialize()
    await verifyTransport(rpc, source, 'file')
    const { authUrl, loginId } = await rpc.request('account/login/start', { type: 'chatgpt' })
    let url
    try {
      url = new URL(authUrl)
    } catch {
      throw new Error('Codex 返回了无效的登录地址。')
    }
    if (
      !loginId ||
      url.protocol !== 'https:' ||
      url.hostname !== 'auth.openai.com' ||
      url.username ||
      url.password ||
      url.port
    )
      throw new Error('Codex 未返回官方授权地址。')
    await openUrl(url.href)
    for (;;) {
      const msg = await rpc.next()
      if (msg.id !== undefined) rpc.unsupported(msg.id)
      else if (msg.method === 'account/login/completed' && msg.params.loginId === loginId) {
        if (!msg.params.success) throw new Error('Codex 登录未完成，请重试。')
        return
      }
    }
  } finally {
    await rpc.close()
  }
}

const refreshes = new Map()
async function managedCredential(account, initial) {
  if (!account.managed || initial.expires > Date.now() + 60000) return initial
  // Refresh belongs solely to the app-owned, signed-in profile. Concurrent bots share this native refresh.
  if (!refreshes.has(account.credentialSource)) {
    const job = (async () => {
      const rpc = new CodexRpc({
        bin: account.bin,
        source: account.credentialSource,
        managed: true,
      })
      try {
        await rpc.initialize()
        await verifyTransport(rpc, account.credentialSource, 'file')
        await rpc.request('account/read', { refreshToken: true })
        return await credential(account.credentialSource)
      } finally {
        await rpc.close()
      }
    })().finally(() => refreshes.delete(account.credentialSource))
    refreshes.set(account.credentialSource, job)
  }
  return await refreshes.get(account.credentialSource)
}

const toolNames = {
  commandExecution: '执行命令',
  fileChange: '修改文件',
  mcpToolCall: '调用 MCP 工具',
  imageView: '查看图片',
  dynamicToolCall: '调用原生工具',
}
const verbs = new Set([
  'git',
  'ls',
  'pwd',
  'cat',
  'head',
  'tail',
  'find',
  'rg',
  'grep',
  'sed',
  'awk',
  'mkdir',
  'touch',
  'mv',
  'cp',
  'rm',
  'chmod',
  'sh',
  'bash',
  'zsh',
  'npm',
  'pnpm',
  'yarn',
  'node',
  'python',
  'python3',
  'cargo',
  'go',
  'make',
  'echo',
  'curl',
  'wget',
  'open',
])
const subcommands = new Set([
  'add',
  'branch',
  'build',
  'checkout',
  'clean',
  'clone',
  'commit',
  'diff',
  'fetch',
  'install',
  'log',
  'merge',
  'pull',
  'push',
  'rebase',
  'reset',
  'restore',
  'rm',
  'run',
  'status',
  'switch',
  'test',
  'update',
])
const operators = new Set(['&&', '||', '|', ';', '>', '>>', '<', '2>', '2>>', '&'])

function shownPath(value) {
  if (typeof value !== 'string' || !value || /[\r\n\x00-\x1f]/.test(value)) return '［路径已隐藏］'
  return redact(value).slice(0, 320)
}

function commandSummary(command) {
  if (typeof command !== 'string') return '执行原生命令（未提供命令文本）'
  // Summarize shell text for display only. Never pass the displayed text to a shell.
  const wrapper = command.trim().match(/^(?:\S*\/)?(?:ba|z)?sh\s+-(?:l?c|cl)\s+(['"])([\s\S]+)\1$/)
  const parts =
    (wrapper?.[2] || command).match(/"[^"\n]*"|'[^'\n]*'|&&|\|\||[12]?>>?|[;<|&]|[^\s;<|&>]+/g) ||
    []
  const result = []
  let executable = true,
    secret = false,
    literal = false
  for (const raw of parts.slice(0, 48)) {
    const token = raw.replace(/^(['"])(.*)\1$/, '$2')
    if (operators.has(raw)) {
      result.push(raw)
      executable = ['&&', '||', '|', ';', '&'].includes(raw)
      secret = false
      literal = false
    } else if (executable) {
      const verb = path.basename(token)
      result.push(verbs.has(verb) ? verb : '［自定义命令］')
      executable = false
      literal = ['echo', 'printf'].includes(verb)
    } else if (secret || literal) {
      if (result.at(-1) !== '［参数已隐藏］') result.push('［参数已隐藏］')
      secret = false
    } else if (/^--?[a-zA-Z0-9][\w-]{0,50}$/.test(token)) {
      result.push(token)
      secret =
        /token|password|passphrase|secret|authorization|header|cookie|api-key|^-H$|^-u$/i.test(
          token,
        )
    } else if (
      /^(?:[.~]?\/|\.\.\/)[\p{L}\p{N}/._ -]*$/u.test(token) ||
      /^[\w.-]+\.(?:js|mjs|ts|py|json|md|txt|toml|sh|tsx|css|html)$/.test(token)
    ) {
      result.push(shownPath(token))
    } else if (subcommands.has(token)) result.push(token)
    else if (/^https?:\/\//.test(token)) {
      try {
        result.push(new URL(token).origin)
      } catch {
        result.push('［网址已隐藏］')
      }
    } else if (result.at(-1) !== '［参数已隐藏］') result.push('［参数已隐藏］')
  }
  if (parts.length > 48) result.push('…')
  return result.join(' ').slice(0, 1500) || '执行原生命令'
}

function permissionScope(request) {
  const rows = []
  if (request.network?.enabled) rows.push('允许访问网络')
  const file = request.fileSystem
  if (file) {
    for (const [mode, paths] of [
      ['读取', file.read],
      ['写入', file.write],
    ]) {
      if (Array.isArray(paths))
        rows.push(...paths.slice(0, 10).map((p) => mode + ' ' + shownPath(p)))
    }
    for (const e of (file.entries || []).slice(0, 10)) {
      const target = e.path?.path || e.path?.pattern || e.path?.value?.kind
      rows.push(
        (e.access === 'write' ? '写入' : e.access === 'read' ? '读取' : '文件范围') +
          ' ' +
          shownPath(target),
      )
    }
    if (!rows.length) rows.push('额外的文件系统权限')
  }
  return rows.join('\n') || '额外的本地访问权限'
}

async function requestApproval(rpc, msg, approve, changedFiles) {
  const { method, id, params: p } = msg
  const command = method === 'item/commandExecution/requestApproval'
  const files = method === 'item/fileChange/requestApproval'
  const access = method === 'item/permissions/requestApproval'
  if (!command && !files && !access) return rpc.unsupported(id)
  const requested = p.permissions || {}
  const title = command ? '命令执行审批' : files ? '文件修改审批' : '权限审批'
  const lines = []
  if (command) {
    lines.push(commandSummary(p.command))
    if (p.cwd) lines.push('工作目录 ' + shownPath(p.cwd))
    if (p.networkApprovalContext?.host)
      lines.push('网络主机 ' + shownPath(p.networkApprovalContext.host))
  } else if (files) {
    lines.push(...(changedFiles.get(p.itemId) || []))
    if (p.grantRoot) lines.push('授权目录 ' + shownPath(p.grantRoot))
    if (!lines.length) lines.push('Codex 请求修改文件，原生工具未提供路径。')
  } else lines.push(permissionScope(requested))
  const detail = lines.join('\n')
  const allow = await rpc.decision(approve, { title, detail })
  const result = access
    ? {
        scope: 'turn',
        permissions: allow
          ? Object.fromEntries(
              Object.entries(requested).filter(
                ([k, v]) => ['network', 'fileSystem'].includes(k) && v != null,
              ),
            )
          : {},
      }
    : { decision: allow ? 'accept' : 'decline' }
  rpc.send({ id, result })
}

function contextHome(parent, chatId, botId) {
  const key = createHash('sha256').update(JSON.stringify([chatId, botId])).digest('hex')
  return path.join(parent, 'contexts', key)
}

async function sessionHome(parent, chatId, botId, threadId) {
  if (!chatId || !botId) return parent
  const context = contextHome(parent, chatId, botId)
  // Early versions placed all sessions in the account home. Keep an existing thread resumable.
  if (threadId) {
    try {
      await plainDir(context)
      return context
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
    try {
      await plainDir(path.join(parent, 'sessions'))
      return parent
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
  }
  await plainDir(path.dirname(context), true)
  await plainDir(context, true)
  return context
}

async function boundCredential(account) {
  await plainDir(account.source)
  await plainDir(account.credentialSource)
  const hints = await configHints(account.credentialSource)
  if (hints.external || ['keyring', 'auto', 'ephemeral'].includes(hints.store))
    throw new Error('原始 Codex 服务或凭据存储已变更，请重新绑定。')
  let auth = await credential(account.credentialSource)
  if (auth.identity !== account.identity) throw new Error(mismatch)
  auth = await managedCredential(account, auth)
  if (auth.identity !== account.identity) throw new Error(mismatch)
  return { auth, hints }
}

async function boundSession(rpc, cwd, auth) {
  await rpc.initialize()
  await verifyTransport(rpc, cwd)
  const info = await attest(rpc, auth)
  if (!paidPlans.has(info.plan)) throw new Error('未能核实此账号具有 ChatGPT 订阅。')
  return info
}

async function withBoundAccount(account, signal, work) {
  const { auth, hints } = await boundCredential(account)
  return temporary(async (scratch) => {
    const rpc = new CodexRpc({ source: scratch, bin: account.bin, signal })
    try {
      await boundSession(rpc, scratch, auth)
      return await work(rpc, hints)
    } finally {
      await rpc.close()
    }
  })
}

export function quota({ account, model, signal }) {
  return withBoundAccount(account, signal, (rpc, hints) => readQuota(rpc, model || hints.model))
}

export function options({ account, signal }) {
  return withBoundAccount(account, signal, async (rpc, hints) => {
    const { models, defaultModel } = await modelCatalog(rpc, hints)
    for (const model of models) {
      if (model.efforts.some(level => level.id === hints.effort)) model.defaultEffort = hints.effort
    }
    const selected = models.find(model => model.id === defaultModel)
    return {
      models,
      defaultEffort: selected?.defaultEffort,
      defaultModel,
      efforts: selected?.efforts || [],
      ...(!models.length && { reason: '当前 Codex CLI 未提供可选模型列表。' }),
    }
  })
}

async function withTaskSession(scope, work) {
  const {
    account,
    bot,
    chatId,
    threadId,
    protectedPaths,
    signal,
    cwd,
    permission = 'default',
  } = scope
  if (!permissionModes.includes(permission)) throw new Error('所选 Codex 权限模式无效。')
  const full = permission === 'full'
  if (full && (!Array.isArray(protectedPaths) || !protectedPaths.length))
    throw new Error('完全访问需要受保护的账号目录。')
  const { auth, hints } = await boundCredential(account)
  const source = await sessionHome(account.source, chatId, bot?.id, threadId)
  const rpc = new CodexRpc({
    source,
    bin: account.bin,
    signal,
    ...(full && { permissionMode: 'full', protectedPaths }),
  })
  try {
    const verified = await boundSession(rpc, cwd, auth)
    return await work(rpc, hints, verified, source)
  } finally {
    await rpc.close()
  }
}

async function openThread(rpc, hints, scope, ephemeral = false, fork) {
  const { bot, cwd, permission = 'default' } = scope
  const threadId = ephemeral ? null : scope.threadId
  const { models, defaultModel } = await modelCatalog(rpc, hints)
  const choice = models.find((m) => m.id === (bot?.model || defaultModel))
  if (bot?.model && !choice) throw new Error('该订阅当前无法使用所选 Codex 模型，请重新选择。')
  if (bot?.effort && !choice?.efforts.some((e) => e.id === bot.effort))
    throw new Error('当前 Codex 模型不支持所选推理强度，请重新选择。')
  const preferredEffort = choice?.efforts.some((e) => e.id === hints.effort) && hints.effort
  const effort = bot?.effort || preferredEffort || choice?.defaultEffort
  const full = permission === 'full'
  const readOnly = permission === 'read-only'
  const automatic = permission === 'auto-review'
  const options = {
    modelProvider: 'openai',
    cwd,
    sandbox: full ? 'danger-full-access' : readOnly ? 'read-only' : 'workspace-write',
    approvalPolicy: full || readOnly ? 'never' : 'on-request',
    approvalsReviewer: automatic ? 'auto_review' : 'user',
    ...(choice && { model: choice.id }),
    ...(effort && { config: { model_reasoning_effort: effort } }),
  }
  const method = fork ? 'thread/fork' : threadId ? 'thread/resume' : 'thread/start'
  const opened = await rpc.request(method, {
    ...options,
    ...(threadId && { threadId }),
    ...(ephemeral && { ephemeral: true }),
    ...(fork && { threadId: fork.parentId, path: fork.path, deferGoalContinuation: true, excludeTurns: true }),
  })
  if (fork && (opened.thread?.id === fork.parentId || opened.thread?.forkedFromId !== fork.parentId))
    throw new Error('Codex 未确认新分支的来源。')
  if (
    !opened.thread?.id ||
    (threadId && opened.thread.id !== threadId) ||
    opened.modelProvider !== 'openai' ||
    opened.approvalPolicy !== options.approvalPolicy ||
    opened.sandbox?.type !==
      (full ? 'dangerFullAccess' : readOnly ? 'readOnly' : 'workspaceWrite') ||
    (!full && opened.sandbox.networkAccess)
  )
    throw new Error('Codex 未确认预期的原生会话或模型提供方。')
  if (
    automatic
      ? !['auto_review', 'guardian_subagent'].includes(opened.approvalsReviewer)
      : opened.approvalsReviewer && opened.approvalsReviewer !== 'user'
  )
    throw new Error('Codex 未确认所选原生审批方式。')
  if ((choice && opened.model !== choice.id) || (effort && opened.reasoningEffort !== effort))
    throw new Error('Codex 未确认所选模型或推理强度，请重新选择。')
  return opened
}

export function composerActions(scope) {
  return withTaskSession(scope, async (rpc, hints) => {
    // Opening a picker must never resume a durable thread or restart an active goal.
    const opened = await openThread(rpc, hints, scope, true)
    const [featureResult, plan, reviewer, methods] = await Promise.allSettled([
      nativeFeatures(rpc, opened.thread.id),
      hasPlanMode(rpc),
      allowsAutoReview(rpc),
      installedMethods(scope.account.bin),
    ])
    const features = featureResult.value || new Set()
    const { found, partial } = await extensionCatalog(rpc, scope.cwd, opened, features)
    const actions = {
      plan: plan.value === true,
      goal: features.has('goals'),
      autoReview: features.has('guardian_approval') && reviewer.value === true,
      extensions: [...found.values()].map((item) => item.entry),
      ...((partial || featureResult.status === 'rejected' || methods.status === 'rejected') && {
        note: '部分原生功能列表当前不可用。',
      }),
    }
    return { ...actions, slashCommands: codexCommands(methods.value, actions) }
  })
}

export async function slashInfo(scope, { name }) {
  if (name !== 'mcp') throw new Error('不支持此 Codex 状态命令。')
  return withTaskSession(scope, async (rpc, hints) => {
    const opened = await openThread(rpc, hints, scope, true)
    return mcpInfo(rpc, opened.thread.id)
  })
}

export async function forkChat(scope, { destinationChatId, destinationCwd = scope.cwd }) {
  if (!scope.threadId || !scope.bot?.id || !scope.chatId || !destinationChatId ||
      destinationChatId === scope.chatId)
    throw new Error('请选择已有原生历史的成员，并使用新的聊天创建分支。')
  const sourceScope = { ...scope, permission: 'read-only' }
  const targetScope = { ...sourceScope, chatId: destinationChatId, threadId: null, cwd: destinationCwd }
  const home = contextHome(scope.account.source, destinationChatId, scope.bot.id)
  await plainDir(scope.account.source)
  await plainDir(path.dirname(home), true)
  try {
    await fs.mkdir(home, { mode: 0o700 })
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('目标分支的会话目录已存在。')
    throw error
  }
  const created = await fs.lstat(home)
  let discarded = false
  const discard = async () => {
    if (discarded) return
    const current = await fs.lstat(home).catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
    if (current?.dev === created.dev && current.ino === created.ino)
      await fs.rm(home, { recursive: true, force: true })
    discarded = true
  }
  try {
    const staged = await withTaskSession(sourceScope, (rpc, _hints, _identity, sourceHome) =>
      stageFork(rpc, scope, sourceHome, home))
    const parentId = scope.threadId
    const opened = await withTaskSession(targetScope, (rpc, hints) =>
      openThread(rpc, hints, targetScope, false, { parentId, path: staged }))
    const threadId = opened.thread.id
    // A separate process must resolve the child from its own durable store.
    await withTaskSession(targetScope, rpc => verifyFork(rpc, { threadId, parentId, home, cwd: destinationCwd }))
    return { threadId, discard }
  } catch (error) {
    await discard()
    throw error
  }
}

export function threadGoal(scope) {
  const { action, objective, status, tokenBudget, onSession } = scope
  const fields = goalFields(objective, tokenBudget)
  if (
    !['get', 'set', 'clear'].includes(action) ||
    (action === 'set' && !['paused', 'complete'].includes(status))
  )
    throw new Error('请通过会话任务启动或继续 Codex 目标。')
  return withTaskSession(scope, async (rpc, hints) => {
    let threadId = scope.threadId
    if (!threadId) {
      if (action !== 'set') return { threadId: null, goal: null }
      if (!fields.objective) throw new Error('请输入有效的 Codex 目标。')
      const opened = await openThread(rpc, hints, scope)
      threadId = opened.thread.id
      if (!(await nativeFeatures(rpc, threadId)).has('goals'))
        throw new Error('当前 Codex CLI 未启用原生目标。')
      await onSession?.(threadId)
    }
    if (action === 'get') return { threadId, goal: await readGoal(rpc, threadId) }
    if (action === 'clear') {
      const result = await rpc.request('thread/goal/clear', { threadId, origin: 'user' })
      if (typeof result.cleared !== 'boolean') throw new Error('Codex 未确认清除目标。')
      return { threadId, goal: null }
    }
    const result = await rpc.request('thread/goal/set', {
      threadId,
      ...fields,
      status,
      origin: 'user',
    })
    const goal = checkedGoal(result.goal, threadId)
    if (goal?.status !== status) throw new Error('Codex 未确认目标状态。')
    return { threadId, goal }
  })
}

function collaborationMode(opened, mode) {
  return {
    mode,
    settings: {
      model: opened.model,
      reasoning_effort: opened.reasoningEffort ?? null,
      developer_instructions: null,
    },
  }
}

export async function run(scope) {
  const {
    threadId,
    bot,
    planMode = false,
    extensionIds = [],
    goalObjective,
    resumeGoal = false,
    tokenBudget,
  } = scope
  if (scope.slashCommand && !['compact', 'review'].includes(scope.slashCommand))
    throw new Error('不支持此 Codex 原生命令。')
  if (scope.slashCommand === 'compact' && !threadId)
    throw new Error('先在此会话中发送一条消息，再压缩上下文。')
  validateExtensionIds(extensionIds)
  const trackGoal = goalObjective !== undefined || resumeGoal
  if (scope.slashCommand && (trackGoal || extensionIds.length || scope.attachments?.length))
    throw new Error('请单独运行此 Codex 原生命令。')
  const fields = goalFields(goalObjective, tokenBudget)
  if (trackGoal && (extensionIds.length || scope.attachments?.length))
    throw new Error('请在单独的消息中使用扩展或附件。')
  let activeSession
  try {
    return await withTaskSession(scope, async (rpc, hints, verified) => {
      await scope.emit({ type: 'identity', value: verified.email, key: verified.identity })
      if (threadId) await parkActiveGoal(rpc, threadId)
      const opened = await openThread(rpc, hints, scope)
      const session = opened.thread.id
      if (scope.slashCommand === 'compact') {
        await scope.emit({ type: 'session', value: session })
        return compactThread(rpc, scope, opened)
      }
      if (bot?.model || bot?.effort) {
        const detail = ['模型 ' + opened.model]
        if (opened.reasoningEffort) detail.push('思考强度 ' + opened.reasoningEffort)
        await scope.emit({ type: 'tool', value: detail.join(' · ') })
      }
      if (trackGoal || scope.permission === 'auto-review') {
        const features = await nativeFeatures(rpc, session)
        if (trackGoal && !features.has('goals')) throw new Error('当前 Codex CLI 未启用原生目标。')
        if (
          scope.permission === 'auto-review' &&
          (!features.has('guardian_approval') || !(await allowsAutoReview(rpc)))
        )
          throw new Error('当前 Codex 配置不支持原生自动审查。')
      }
      const plan = !trackGoal && !scope.slashCommand && planMode
      const mode = plan ? 'plan' : opened.collaborationMode?.mode === 'plan' ? 'default' : null
      if (plan && !(await hasPlanMode(rpc))) throw new Error('当前 Codex CLI 不支持计划模式。')
      const collaboration = mode ? collaborationMode(opened, mode) : null
      if (trackGoal && collaboration)
        await rpc.request('thread/settings/update', {
          threadId: session,
          collaborationMode: collaboration,
        })
      const extraInput = await resolveExtensions(rpc, extensionIds, scope.cwd, opened)
      const setGoalActive = (active) => {
        activeSession = active ? session : null
      }
      await scope.emit({ type: 'session', value: session })
      if (scope.titleRequest?.() && opened.thread.name) await scope.emit({ type: 'title', value: opened.thread.name })
      await runTurns(rpc, scope, opened, {
        trackGoal,
        fields,
        extraInput,
        collaboration,
        setGoalActive,
      })
      // The server may persist the title at completion instead of notifying the running client.
      if (scope.titleRequest?.()) {
        const result = await rpc.request('thread/read', { threadId: session, includeTurns: false }, 1200).catch(() => null)
        if (result?.thread?.id === session && result.thread.name)
          await scope.emit({ type: 'title', value: result.thread.name })
      }
    })
  } finally {
    // Aborting closes the child and its tool children immediately. Park an
    // interrupted goal using an unloaded thread in the same verified account.
    if (activeSession) {
      await withTaskSession(
        { ...scope, threadId: activeSession, signal: AbortSignal.timeout(10000) },
        (rpc) => parkActiveGoal(rpc, activeSession),
      )
    }
  }
}

async function runTurns(
  rpc,
  scope,
  opened,
  { trackGoal, fields, extraInput, collaboration, setGoalActive },
) {
  const { emit, prompt, attachments, permission = 'default', approve } = scope
  const session = opened.thread.id
  const subagents = codexSubagents({ emit, parentId: session, rpc })
  let currentQuota = await readQuota(rpc, opened.model)
  if (currentQuota) await emit({ type: 'quota', value: currentQuota })
  let turn,
    usageModel = opened.model,
    goalStatus,
    activationObserved = false
  const review = scope.slashCommand === 'review'
  const publicReview = review && scope.publicReview
  let finalReview
  if (review) {
    const instructions = prompt?.trim()
    const target = instructions ? { type: 'custom', instructions } : { type: 'uncommittedChanges' }
    const started = await rpc.request('review/start', { threadId: session, delivery: 'inline', target })
    if (started.reviewThreadId !== session || !started.turn?.id)
      throw new Error('Codex 未确认当前会话的原生审查任务。')
    turn = started.turn.id
  } else if (trackGoal) {
    setGoalActive(true)
    const result = await rpc.request('thread/goal/set', {
      threadId: session,
      ...fields,
      status: 'active',
      origin: 'user',
    })
    const goal = checkedGoal(result.goal, session)
    if (goal?.status !== 'active') throw new Error('Codex 未启动所选目标。')
    goalStatus = goal.status
    await emit({ type: 'goal', value: goal })
  } else {
    const started = await rpc.request('turn/start', {
      threadId: session,
      ...(opened.model && { model: opened.model }),
      ...(opened.reasoningEffort && { effort: opened.reasoningEffort }),
      ...(collaboration && { collaborationMode: collaboration }),
      input: [
        { type: 'text', text: prompt, text_elements: [] },
        ...imageSnapshots(attachments).map(({ path }) => ({ type: 'localImage', path })),
        ...extraInput,
      ],
    })
    turn = started.turn?.id
    if (!turn) throw new Error('Codex 未返回原生任务标识。')
  }
  const sent = new Map()
  const changedFiles = new Map()
  const completedAgentItems = new Set()
  const append = (id, delta) => {
    // A group review publishes the native findings after the turn succeeds.
    if (!delta || publicReview) return
    sent.set(id, (sent.get(id) || '') + delta)
    emit({ type: 'text', value: delta })
  }
  for (;;) {
    const msg = await rpc.next()
    const p = msg.params || {}
    if (msg.method === 'boteam/refreshRejected')
      throw new Error('Codex 请求刷新订阅凭据，请刷新原登录或重新授权后重试。')
    if (msg.id !== undefined) {
      if (!turn || p.threadId !== session || p.turnId !== turn) rpc.unsupported(msg.id)
      else if (msg.method === 'item/tool/requestUserInput')
        await respondToQuestions(rpc, msg, scope.ask)
      else
        await requestApproval(
          rpc,
          msg,
          permission === 'default' || permission === 'auto-review' ? approve : () => false,
          changedFiles,
        )
      continue
    }
    if (msg.method === 'account/rateLimits/updated') {
      const update = codexQuota(p, opened.model)
      if (update && (!currentQuota || currentQuota.scope !== 'model' || update.scope === 'model')) {
        const windows = new Map(
          (currentQuota?.scope === update.scope ? currentQuota.windows : []).map((w) => [
            w.minutes,
            w,
          ]),
        )
        for (const w of update.windows) windows.set(w.minutes, { ...windows.get(w.minutes), ...w })
        currentQuota = { ...update, windows: [...windows.values()] }
        await emit({ type: 'quota', value: currentQuota })
      }
      continue
    }
    if (p.threadId !== session) {
      await subagents.childEvent(msg.method, p)
      continue
    }
    if (msg.method === 'thread/name/updated') {
      if (scope.titleRequest?.() && p.threadName) await emit({ type: 'title', value: p.threadName })
      continue
    }
    if (msg.method === 'thread/goal/updated' || msg.method === 'thread/goal/cleared') {
      const goal = checkedGoal(p.goal, session)
      // Resume can queue the previous, parked snapshot ahead of the activation
      // event. Follow message order so a fast turn still delivers its output.
      if (trackGoal && !activationObserved && goal?.status !== 'active') continue
      if (trackGoal) activationObserved = true
      goalStatus = goal?.status
      setGoalActive(goalStatus === 'active')
      await emit({ type: 'goal', value: goal })
      if (trackGoal && !turn && goalStatus !== 'active') return
      continue
    }
    if (trackGoal && msg.method === 'turn/started') {
      if (!p.turn?.id || turn) throw new Error('Codex 原生目标任务顺序异常。')
      activationObserved = true
      turn = p.turn.id
      usageModel = opened.model
      sent.clear()
      changedFiles.clear()
      completedAgentItems.clear()
      continue
    }
    if (!turn || (p.turnId || p.turn?.id) !== turn) continue
    if (msg.method === 'model/rerouted' && typeof p.toModel === 'string' && p.toModel)
      usageModel = p.toModel
    if (review) {
      const items = msg.method === 'item/completed' ? [p.item] :
        msg.method === 'turn/completed' ? p.turn.items || [] : []
      for (const item of items) {
        if (item?.type !== 'exitedReviewMode' || typeof item.review !== 'string') continue
        if (publicReview) finalReview = item.review
        else if (![...sent.values()].includes(item.review)) append(item.id, item.review)
      }
    }
    if (msg.method === 'item/autoApprovalReview/completed') {
      const label = { approved: '已批准', denied: '已拒绝', timedOut: '超时', aborted: '已停止' }[
        p.review?.status
      ]
      if (label) await emit({ type: 'tool', value: '原生自动审查 · ' + label })
    }
    if (
      msg.method === 'item/completed' &&
      p.item?.type === 'plan' &&
      typeof p.item.text === 'string'
    )
      append(p.item.id, '\n\n' + p.item.text)

    if (msg.method === 'thread/tokenUsage/updated') {
      const usage = p.tokenUsage
      const value = contextUsage(usage?.last?.totalTokens, usage?.modelContextWindow, usageModel)
      if (value) await emit({ type: 'context', value })
    }
    if (msg.method === 'item/agentMessage/delta' && typeof p.delta === 'string')
      append(p.itemId, p.delta)
    if (msg.method === 'item/completed' && p.item?.type === 'agentMessage') {
      const full = p.item.text
      const previous = sent.get(p.item.id) || ''
      if (typeof full === 'string' && full.startsWith(previous))
        append(p.item.id, full.slice(previous.length))
    }
    if (msg.method === 'item/started' || msg.method === 'item/completed') {
      if (['subAgentActivity', 'collabAgentToolCall'].includes(p.item?.type)) {
        if (msg.method === 'item/completed' && typeof p.item.id === 'string') completedAgentItems.add(p.item.id)
        await subagents.parentItem(p.item)
      } else {
        for (const activity of codexActivity(p.item, msg.method === 'item/completed')) await emit(activity)
      }
    }
    if (msg.method === 'item/started' && Object.hasOwn(toolNames, p.item?.type)) {
      const item = p.item
      let summary = toolNames[item.type]
      if (item.type === 'commandExecution') summary += ' · ' + commandSummary(item.command)
      if (item.type === 'fileChange' && Array.isArray(item.changes)) {
        const files = item.changes.slice(0, 15).map((c) => shownPath(c.path))
        changedFiles.set(item.id, files)
        if (files.length) summary += ' · ' + files.join('、')
      }
      emit({ type: 'tool', value: summary })
    }
    if (msg.method === 'turn/completed') {
      for (const item of Array.isArray(p.turn.items) ? p.turn.items : []) {
        if (['subAgentActivity', 'collabAgentToolCall'].includes(item?.type) && !completedAgentItems.has(item.id))
          await subagents.parentItem(item)
      }
      // The native server can omit child notifications for unloaded threads.
      // Read only children identified by this parent turn, before closing RPC.
      await subagents.recover()
      if (p.turn.status === 'interrupted') throw new Error('Codex 任务已中断。')
      if (p.turn.status !== 'completed') throw nativeError(p.turn.error?.message, p.turn.error?.codexErrorInfo)
      if (publicReview) {
        if (!finalReview?.trim()) throw new Error('Codex 未返回可在群中发布的最终审查结果。')
        await emit({ type: 'text', value: finalReview })
      }
      if (!trackGoal || goalStatus !== 'active') return
      turn = null
    }
  }
}
