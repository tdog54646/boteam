import { webActivity } from './chat-activity.mjs'
import { claudeSubagents } from './claude-subagents.mjs'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { nativeEnv, redact } from '../native.mjs'

import { contextUsage, inlineImages, inputWindowError, quotaWindow } from './usage.mjs'
import { nativeSlashCatalog, slashPrompt } from './native-slash.mjs'

const permissions = { default: 'default', plan: 'plan', edits: 'acceptEdits' }
export const permissionModes = Object.keys(permissions)

const defaults = ['--safe-mode', '--setting-sources', '']
const shutdownGraceMs = 1500
const backgroundWaitMs = 10 * 60_000
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i
const defaultSource = path.join(os.homedir(), '.claude')
const authOverride =
  /^(?:ANTHROPIC_(?:AUTH|API_KEY|BASE_URL|CUSTOM_HEADERS|PROFILE|FOUNDRY|BEDROCK|VERTEX)|CLAUDE_(?:SECURESTORAGE|CONFIG_DIR)|CLAUDE_CODE_(?:OAUTH|USE_|API|HOST_|PROVIDER|SESSION_ACCESS|BASE_URL)|AWS_|GOOGLE_(?:API_KEY|APPLICATION_CREDENTIALS|CLOUD_)|AZURE_|(?:HTTP|HTTPS|ALL)_PROXY$)/i

function environment(source) {
  // On macOS the unqualified default profile uses a different Keychain service
  // from a custom CLAUDE_CONFIG_DIR. Preserve the original lookup for ~/.claude.
  return nativeEnv(
    path.resolve(source) === defaultSource ? {} : { CLAUDE_CONFIG_DIR: path.resolve(source) },
  )
}

function reference(source, reason) {
  const hash = createHash('sha256').update(path.resolve(source)).digest('hex')
  return { status: 'blocked', identity: 'source:' + hash, loginState: 'unknown', reason }
}

function emailOf(value) {
  return typeof value === 'string' &&
    value.length <= 254 &&
    /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)
    ? value.toLowerCase()
    : undefined
}

function paidPlan(value) {
  if (typeof value !== 'string') return undefined
  const match =
    /^(?:claude\s+(?:for\s+)?)?(pro|max|team|teams|enterprise|ultra)(?:\s+(?:plan|\d+x))?$/i.exec(
      value.trim(),
    )
  return match?.[1].toLowerCase().replace(/^teams$/, 'team')
}

async function readSettings(source) {
  const file = path.join(source, 'settings.json')
  let info
  try {
    info = await stat(file)
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error()
  return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''))
}

function getStatus(bin, source, signal, managed) {
  return new Promise((resolve) => {
    const args = [...defaults, 'auth', 'status', '--json']
    // Even "auth status" can run profile migrations. A read-only macOS probe
    // keeps discovery from touching another application's files.
    const readOnly = process.platform === 'darwin' && !managed
    const command = readOnly ? '/usr/bin/sandbox-exec' : bin
    const argv = readOnly
      ? ['-p', '(version 1)(allow default)(deny file-write*)', bin, ...args]
      : args
    execFile(
      command,
      argv,
      {
        cwd: os.tmpdir(),
        env: environment(source),
        timeout: 12_000,
        maxBuffer: 128 * 1024,
        signal,
      },
      (error, stdout) => {
        if (error && error.code !== 1)
          return resolve({ failed: true, missing: error.code === 'ENOENT' })
        try {
          resolve(JSON.parse(stdout))
        } catch {
          resolve({ failed: true })
        }
      },
    )
  })
}

export async function detect({ source = defaultSource, bin, signal, managed = false }) {
  if (!bin) return { status: 'missing', reason: '未找到 Claude Code 命令行工具。' }
  try {
    await access(source)
  } catch {
    return {
      status: 'login',
      loginState: 'signed-out',
      reason: '该配置目录尚未登录 Claude 订阅账号。',
    }
  }
  let settings
  try {
    settings = await readSettings(source)
  } catch {
    return reference(source, '无法读取 Claude 配置并核验认证方式。')
  }
  if (
    settings?.apiKeyHelper ||
    Object.keys(settings?.env || {}).some((key) => authOverride.test(key))
  ) {
    return reference(
      source,
      '配置包含认证或服务地址覆盖项。请在 BoTeam 中单独登录 Claude 订阅账号。',
    )
  }
  const info = await getStatus(bin, source, signal, managed)
  if (info?.missing) return { status: 'missing', reason: '未找到 Claude Code 命令行工具。' }
  if (info?.failed || typeof info?.loggedIn !== 'boolean')
    return reference(source, 'Claude Code 未返回可验证的登录状态，请检查原生工具版本。')
  if (!info.loggedIn)
    return {
      status: 'login',
      loginState: 'signed-out',
      reason: '该配置目录尚未登录 Claude 订阅账号。',
    }
  if (info.authMethod !== 'claude.ai' || info.apiProvider !== 'firstParty') {
    return reference(source, '当前登录方式无法验证为官方 Claude 订阅授权。')
  }
  const email = emailOf(info.email)
  const plan = paidPlan(info.subscriptionType)
  if (!email || !plan) return reference(source, 'Claude Code 未提供可核验的订阅身份及套餐。')
  if (info.configDirectory && path.resolve(info.configDirectory) !== path.resolve(source)) {
    return reference(source, 'Claude Code 使用的账号目录与所选来源不一致。')
  }
  const orgId =
    typeof info.orgId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(info.orgId) ? info.orgId : ''
  const identity = JSON.stringify([email, orgId])
  const result = {
    status: managed ? 'ready' : 'blocked',
    identity,
    email,
    plan,
    loginState: 'signed-in',
  }
  if (!managed)
    result.reason =
      '已确认本机 Claude 订阅。请重新授权到 BoTeam 独立目录，避免原生客户端在任务中途切换账号。'
  if (typeof info.orgName === 'string' && info.orgName.length <= 250)
    result.organization = info.orgName
  const model = settings?.model
  if (typeof model === 'string' && model.length <= 100 && /^[a-z0-9][\w.-]*(?:\[[a-z0-9]+\])?$/i.test(model))
    result.model = model
  return result
}

// Migrate only sessions previously recorded for this BoTeam identity. Never
// copy credential files or other native conversations into the new login.
async function transferSessions(from, to, ids) {
  if (!ids.length) return
  if (!ids.every((id) => uuid.test(id))) throw new Error('保存的 Claude 会话标识无效。')
  const projects = path.join(from, 'projects')
  const pending = new Set(ids)
  try {
    for (const entry of await readdir(projects, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      for (const id of pending) {
        const old = path.join(projects, entry.name, id)
        const transcript = await lstat(old + '.jsonl').catch(() => null)
        if (!transcript?.isFile()) continue
        const dir = path.join(to, 'projects', entry.name)
        await mkdir(dir, { recursive: true, mode: 0o700 })
        await copyFile(old + '.jsonl', path.join(dir, id + '.jsonl'), constants.COPYFILE_EXCL)
        if ((await lstat(old).catch(() => null))?.isDirectory()) {
          await cp(old, path.join(dir, id), {
            recursive: true,
            errorOnExist: true,
            force: false,
            filter: async (file) => !(await lstat(file)).isSymbolicLink(),
          })
        }
        pending.delete(id)
      }
    }
    if (pending.size) throw new Error()
  } catch {
    throw new Error('无法迁移该账号已有的 Claude 会话，已保留原绑定。')
  }
}

export async function prepare({ candidate, existing, threadIds = [], isLogin = false }) {
  const found = await detect({ ...candidate, managed: isLogin || candidate.managed === true })
  if (!found.identity || (candidate.identity && found.identity !== candidate.identity))
    throw new Error('Claude 账号身份已变化，请重新检测。')
  if (existing?.managed && !isLogin && existing.identity === found.identity) {
    const prior = await detect(existing)
    if (prior.status === 'ready' && prior.identity === existing.identity) {
      return { ...prior, source: existing.source, managed: true }
    }
    return {
      ...found,
      source: existing.source,
      managed: true,
      status: 'blocked',
      reason: 'BoTeam 独立登录已失效，请重新授权以续接此账号已有的会话。',
    }
  }
  if (existing && isLogin && existing.source !== candidate.source) {
    if (existing.identity !== found.identity) throw new Error('重新登录的身份与原账号不匹配。')
    await transferSessions(existing.source, candidate.source, threadIds)
  }
  return { ...found, source: candidate.source, managed: isLogin || candidate.managed === true }
}

export async function login({ source, bin, signal }) {
  if (!bin) throw new Error('请先安装 Claude Code 命令行工具。')
  if (!source || !path.isAbsolute(source) || path.resolve(source) === defaultSource)
    throw new Error('需要独立的 Claude 登录目录。')
  await mkdir(source, { mode: 0o700, recursive: true })
  const dir = await realpath(source)
  if (dir === defaultSource || dir === (await realpath(defaultSource).catch(() => defaultSource))) {
    throw new Error('需要独立的 Claude 登录目录。')
  }
  // The native CLI opens the system browser and exchanges its own callback.
  // OAuth codes, URLs and tokens never pass through the renderer or database.
  const timeout = AbortSignal.timeout(10 * 60_000)
  const stop = signal ? AbortSignal.any([signal, timeout]) : timeout
  stop.throwIfAborted()
  await new Promise((resolve, reject) => {
    const child = spawn(bin, [...defaults, 'auth', 'login', '--claudeai'], {
      env: environment(source),
      cwd: dir,
      stdio: 'ignore',
      detached: process.platform !== 'win32',
    })
    let reap
    const cancel = () => {
      stopChild(child, 'SIGTERM')
      reap = setTimeout(() => stopChild(child, 'SIGKILL'), 1000)
    }
    stop.addEventListener('abort', cancel, { once:true })
    child.once('error', () => reject(new Error('无法启动 Claude 原生授权。')))
    child.once('close', code => {
      clearTimeout(reap)
      stop.removeEventListener('abort', cancel)
      if (stop.aborted) reject(new Error('Claude 授权已取消或超时。'))
      else if (code !== 0) reject(new Error('Claude 授权未完成，请重新授权。'))
      else resolve()
    })
  })
  const verified = await detect({ source, bin, signal, managed: true })
  if (verified.status !== 'ready') throw new Error(verified.reason)
  return verified
}

function stopChild(child, how) {
  if (!child.pid) return
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, how)
    else child.kill(how)
  } catch {
    /* The native process may already have stopped. */
  }
}

function failResult(result) {
  const details = [result.result, ...(Array.isArray(result.errors) ? result.errors : [])].join(' ')
  const overflow = inputWindowError(details)
  if (overflow) return overflow
  if (/rate.?limit|usage.?limit|quota|exhausted|overload|429/i.test(details))
    return new Error('Claude 订阅额度已用尽或服务繁忙，请稍后重试。')
  if (/auth|login|log in|sign.?in|token|401|403/i.test(details))
    return new Error('Claude 订阅授权已失效，请重新授权。')
  if (/session|conversation|resume/i.test(details))
    return new Error('无法恢复此 Claude 原生会话，请检查账号及会话历史。')
  return new Error('Claude Code 未能完成本次任务。')
}

const builtins = new Set([
  'Bash',
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'AskUserQuestion',
  'ExitPlanMode',
])
function toolName(name) {
  return builtins.has(name) ? name : '原生工具'
}
function actionDetail(request) {
  const input = request.input || {}
  if (request.tool_name === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : ''
    const preview = redact(command)
      .replace(
        /\b([\w-]*(?:token|secret|password|credential|api[_-]?key)[\w-]*)\s*(?:=|\s+)\s*(?:"[^"\n]*"|'[^'\n]*'|[^;|&\s]+)/gi,
        '$1=[已隐藏]',
      )
      .replace(/\bBasic\s+[a-z0-9+/=]+/gi, 'Basic [已隐藏]')
      .replace(/(?:https?|ssh):\/\/[^/@\s]+:[^/@\s]+@/gi, '[已隐藏连接凭据]@')
      .replace(/([?&](?:key|signature|sig|token|password)=)[^&#\s]+/gi, '$1[已隐藏]')
      .replace(
        /\b(?:gh[pousr]_[a-zA-Z0-9_]+|AIza[\w-]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[\w-]+)/g,
        '[已隐藏]',
      )
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ' ')
    const shortened =
      preview.length > 4500 ? preview.slice(0, 4500) + '\n…（后续参数已省略）' : preview
    return shortened ? '运行终端命令\n' + shortened : null
  }
  if (['Read', 'Edit', 'Write', 'NotebookEdit'].includes(request.tool_name)) {
    const name = path.basename(String(input.file_path || input.notebook_path || ''))
    return /^[\p{L}\p{N} _.-]{1,80}$/u.test(name) &&
      !/(?:token|secret|key|credential|^\.env|sk-|eyJ)/i.test(name)
      ? '访问文件 ' + name
      : '访问工具请求中的文件'
  }
  return '允许此工具完成当前操作'
}

function modelCatalog(entries, configured) {
  const native = Array.isArray(entries) ? entries : []
  const defaultEntry =
    (configured && native.find((m) => m.value === configured || m.resolvedModel === configured)) ||
    native.find((m) => m.value === 'default')
  const levels = (m) =>
    m?.supportsEffort !== false && Array.isArray(m?.supportedEffortLevels)
      ? m.supportedEffortLevels
          .filter((level) => typeof level === 'string')
          .map((id) => ({ id, label: id }))
      : []
  const models = []
  // A native alias and "default" can resolve to the same concrete model.
  // Prefer the model's own display name; keep the concrete ID so future alias changes are detectable.
  for (const m of [
    ...native.filter((m) => m.value !== 'default'),
    ...native.filter((m) => m.value === 'default'),
  ]) {
    const id = m.resolvedModel || m.value
    if (typeof id !== 'string' || id === 'default' || models.some((model) => model.id === id))
      continue
    models.push({
      id,
      label: m.displayName && m.displayName !== id ? m.displayName + ' · ' + id : id,
      efforts: levels(m),
    })
  }
  const defaultId = defaultEntry?.resolvedModel || defaultEntry?.value
  return {
    models,
    defaultModel: models.find((m) => m.id === defaultId)?.id,
    efforts: levels(defaultEntry),
    ...(!models.length && { reason: '当前 Claude Code 未提供可选模型列表。' }),
  }
}

function rateLimits(report, model) {
  const limits = report?.rate_limits
  if (!report?.rate_limits_available || !limits) return
  const window = (entry, minutes) =>
    entry &&
    Number.isFinite(entry.utilization) &&
    quotaWindow(minutes, 100 - entry.utilization, Date.parse(entry.resets_at))
  const words = String(model || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  const family = ['opus', 'sonnet'].find((name) => words.includes(name))
  const entry = limits.model_scoped?.find?.(
    (row) =>
      typeof row?.display_name === 'string' &&
      row.display_name.trim() &&
      row.display_name
        .toLowerCase()
        .trim()
        .split(/[^a-z0-9]+/)
        .every((name) => words.includes(name)),
  )
  const specific = window(entry, 10080) || window(limits['seven_day_' + family], 10080)
  const short = window(limits.five_hour, 300)
  const windows = [
    short && specific ? { ...short, shared: true } : short,
    specific || window(limits.seven_day, 10080),
  ].filter(Boolean)
  if (windows.length)
    return { windows, ...(specific ? { scope: 'model', model } : { scope: 'account' }) }
}

export function options({ account, signal }) {
  return nativeSession({ account, signal, cwd: os.tmpdir() }, 'options')
}

export function quota({ account, model, signal }) {
  return nativeSession({ account, bot: { model }, signal, cwd: os.tmpdir() }, 'quota')
}

// The native initialize catalog includes interactive settings, account and
// background commands as well as task skills. These accept a task in print mode.
const taskCommands = new Set(['deep-research', 'design-sync', 'dataviz', 'verify', 'debug',
  'code-review', 'simplify', 'claude-api', 'run-skill-generator', 'review', 'recap', 'design'])

function commandCatalog(init) {
  return (Array.isArray(init.commands) ? init.commands : [])
    .filter(command => taskCommands.has(command?.name))
    .map(({ name, description }) => ({ id: 'claude:/' + name, kind: 'skill', label: '/' + name,
      description: typeof description === 'string' ? redact(description).slice(0, 300) : '' }))
}

function slashCatalog(init) {
  return nativeSlashCatalog(init.commands, name => {
    if (name === 'context') return { action: 'context' }
    if (name === 'usage') return { action: 'quota' }
    if (name === 'model' || name === 'plan') return { action: name }
    if (name === 'permissions') return { action: 'permission' }
    if (['login', 'logout', 'auth', 'account', 'accounts', 'config', 'update-config', 'fewer-permission-prompts'].includes(name))
      return { action: 'unavailable', reason: '此命令会更改原生配置或登录，请在 Claude Code 中使用。' }
    if (['clear', 'resume', 'fork', 'exit', 'quit', 'rewind'].includes(name))
      return { action: 'unavailable', reason: '此命令会重置或更换当前绑定的原生会话。' }
    if (['loop', 'reload-skills'].includes(name))
      return { action: 'unavailable', reason: '此操作需要持续运行的 Claude Code 进程。' }
    if (['agents', 'heapdump'].includes(name))
      return { action: 'unavailable', reason: '请在 Claude Code 终端中使用此管理命令。' }
    return { action: 'prompt' }
  })
}

export function composerActions({ account, cwd, signal }) {
  return nativeSession({ account, cwd, signal }, 'actions')
}

export function run(task) {
  return nativeSession(task, 'run')
}

async function nativeSession(
  {
    account,
    bot,
    threadId,
    prompt,
    attachments,
    titleRequest,
    extensionIds = [],
    slashCommand,
    cwd,
    signal,
    emit,
    approve,
    permission = 'default',
  },
  operation,
) {
  if (!permissionModes.includes(permission)) throw new Error('所选 Claude 权限模式无效。')
  if (account.managed !== true) throw new Error('请先将 Claude 订阅授权至 BoTeam 独立目录。')
  if (threadId && !uuid.test(threadId)) throw new Error('Claude 原生会话标识无效。')
  if (!Array.isArray(extensionIds) || extensionIds.length > 1) throw new Error('Claude 每条消息可使用一个原生技能。')
  if (slashCommand && extensionIds.length) throw new Error('请选择一个 Claude 命令或技能。')
  const verified = await detect({ ...account, signal })
  if (verified.status !== 'ready') throw new Error(verified.reason)
  if (verified.identity !== account.identity)
    throw new Error('当前 Claude 身份与 Bot 绑定的账号不匹配。')
  const id = threadId || randomUUID()
  const args = [
    ...defaults,
    '-p',
    '--verbose',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--permission-mode',
    permissions[permission],
    '--permission-prompt-tool',
    'stdio',
    '--strict-mcp-config',
  ]
  if (operation !== 'actions' && !extensionIds.length && !slashCommand) args.push('--disable-slash-commands')
  if (operation !== 'run') args.push('--no-session-persistence')
  else args.push(threadId ? '--resume' : '--session-id', id)
  if (bot?.effort) {
    if (typeof bot.effort !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(bot.effort))
      throw new Error('Claude 推理强度无效。')
    args.push('--effort', bot.effort)
  }
  if (signal?.aborted) throw new Error('任务已取消。')
  const group = process.platform !== 'win32'
  const child = spawn(account.bin, args, {
    cwd,
    // Older CLIs ignore this option. Their persisted child transcript is the fallback.
    env: { ...environment(account.source), ...(operation === 'run' && { CLAUDE_CODE_FORWARD_SUBAGENT_TEXT: '1' }) },
    stdio: ['pipe', 'pipe', 'ignore'],
    detached: group,
  })
  const stop = how => stopChild(child, how)
  const abort = () => stop('SIGKILL')
  signal?.addEventListener('abort', abort, { once: true })
  const onClose = new Promise((resolve) => {
    child.once('error', () => {})
    child.once('close', () => resolve(false))
  })
  child.stdin.on('error', () => {})
  const send = (message) => child.stdin.write(JSON.stringify(message) + '\n')
  const input = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const messages = (async function* () {
    for await (const line of input) {
      let message
      try {
        message = JSON.parse(line)
      } catch {
        throw new Error('Claude Code 返回了无法识别的协议数据。')
      }
      yield message
    }
  })()
  let observeAgents
  async function control(request, failure) {
    const requestId = randomUUID()
    send({ type: 'control_request', request_id: requestId, request })
    for (;;) {
      const { value: message, done } = await messages.next()
      if (done) throw new Error(signal?.aborted ? '任务已取消。' : failure)
      if (message.type !== 'control_response' || message.response?.request_id !== requestId) {
        await observeAgents?.(message)
        continue
      }
      if (message.response.subtype !== 'success') throw new Error(failure)
      return message.response.response
    }
  }
  const timer = setTimeout(() => stop('SIGKILL'), 20_000)
  let streamed = false
  let emittedText = false
  let seenSession = false
  try {
    const init = await control(
      { subtype: 'initialize' },
      bot?.effort
        ? 'Claude 无法启动，请检查所选推理强度及 CLI 版本。'
        : 'Claude 原生协议初始化失败。',
    )
    const info = init?.account
    if (
      !info ||
      info.apiProvider !== 'firstParty' ||
      (info.tokenSource && info.tokenSource !== 'claude.ai') ||
      (info.apiKeySource && info.apiKeySource !== 'none') ||
      emailOf(info.email) !== verified.email ||
      paidPlan(info.subscriptionType) !== verified.plan ||
      (verified.organization && verified.organization !== info.organization)
    )
      throw new Error('运行中的 Claude 进程无法核验绑定的订阅账号身份。')
    if (operation === 'actions') {
      return { plan: true, goal: false, autoReview: false, extensions: commandCatalog(init),
        slashCommands: slashCatalog(init), maxExtensions: 1 }
    }
    if (slashCommand) prompt = slashPrompt(slashCatalog(init), slashCommand, prompt, 'Claude')
    const command = extensionIds.length && commandCatalog(init).find(item => item.id === extensionIds[0])
    if (extensionIds.length && !command) throw new Error('当前 Claude 进程未提供所选技能，请重新选择。')
    const catalog = modelCatalog(init.models, verified.model)
    if (operation === 'options') {
      const settings = await control({ subtype: 'get_settings' }, '').catch(() => undefined)
      const applied = settings?.applied
      const model = catalog.models.find((m) => m.id === applied?.model)
      if (model?.efforts.some((e) => e.id === applied.effort)) {
        model.defaultEffort = applied.effort
        if (model.id === catalog.defaultModel) catalog.defaultEffort = applied.effort
      }
      return catalog
    }
    const readQuota = async () =>
      rateLimits(
        await control({ subtype: 'get_usage', skip_behaviors: true }, '无法读取 Claude 订阅额度。'),
        bot?.model || catalog.defaultModel,
      )
    if (operation === 'quota') return await readQuota()
    if (permission !== 'default') {
      const applied = await control(
        { subtype: 'set_permission_mode', mode: permissions[permission] },
        'Claude 未确认所选权限模式。',
      )
      if (applied?.mode !== permissions[permission]) throw new Error('Claude 未确认所选权限模式。')
    }
    const choice = catalog.models.find((m) => m.id === (bot?.model || catalog.defaultModel))
    if (bot?.model && !choice) throw new Error('该订阅当前无法使用所选 Claude 模型，请重新选择。')
    if (bot?.effort && !(choice?.efforts || catalog.efforts).some((e) => e.id === bot.effort))
      throw new Error('当前 Claude 模型不支持所选推理强度，请重新选择。')
    // --model adds even unknown names to the initialize catalog. Read it first,
    // then set the chosen model in this same verified process.
    if (choice && (bot?.model || verified.model || threadId)) {
      await control({ subtype: 'set_model', model: choice.id }, 'Claude Code 未能启用所选模型。')
    }
    await emit({ type: 'identity', value: verified.email, key: verified.identity })
    if (slashCommand) await emit({ type: 'tool', value: 'Claude 原生命令 · /' + slashCommand })
    if (command) {
      prompt = [command.label, prompt].filter(Boolean).join(' ')
      await emit({ type: 'tool', value: 'Claude 原生技能 · ' + command.label })
    }
    if (bot?.model || bot?.effort) {
      const failure = 'Claude Code 未确认所选模型或推理强度，请检查 CLI 版本或重新选择。'
      const settings = await control({ subtype: 'get_settings' }, failure)
      const applied = settings?.applied
      if (
        !applied?.model ||
        (choice && applied.model !== choice.id) ||
        (bot?.effort && applied.effort !== bot.effort)
      )
        throw new Error(failure)
      const detail = ['模型 ' + applied.model]
      if (applied.effort) detail.push('思考强度 ' + applied.effort)
      await emit({ type: 'tool', value: detail.join(' · ') })
    }
    clearTimeout(timer)
    const images = (await inlineImages(attachments)).map(({ data, mimeType }) => ({
      type: 'image',
      source: { type: 'base64', media_type: mimeType, data },
    }))
    send({
      type: 'user',
      message: {
        role: 'user',
        content: images.length ? [{ type: 'text', text: prompt }, ...images] : prompt,
      },
      parent_tool_use_id: null,
      session_id: id,
    })
    const agents = claudeSubagents({ source: account.source, cwd, session: id, emit })
    observeAgents = agents.handle
    for await (const message of messages) {
      if (message.session_id && message.session_id !== id)
        throw new Error('Claude 返回了不匹配的原生会话。')
      if (message.session_id === id && !seenSession) {
        seenSession = true
        await emit({ type: 'session', value: id })
      }
      await observeAgents(message)
      if (message.type === 'control_request') {
        const req = message.request || {}
        const detail = actionDetail(req)
        const ok =
          req.subtype === 'can_use_tool' &&
          detail !== null &&
          (await Promise.race([
            Promise.resolve(approve({ title: toolName(req.tool_name), detail })),
            onClose,
          ]))
        if (child.exitCode !== null || child.signalCode || signal?.aborted) break
        const response = ok
          ? { behavior: 'allow', updatedInput: req.input }
          : { behavior: 'deny', message: '用户未授权此操作。' }
        send({
          type: 'control_response',
          response: { subtype: 'success', request_id: message.request_id, response },
        })
      } else if (message.type === 'stream_event' && !message.parent_tool_use_id) {
        const event = message.event
        if (event?.type === 'message_start') streamed = false
        if (
          event?.type === 'content_block_delta' &&
          event.delta?.type === 'text_delta' &&
          typeof event.delta.text === 'string'
        ) {
          await emit({ type: 'text', value: event.delta.text })
          emittedText = streamed = true
        }
      } else if (message.type === 'assistant' && !message.parent_tool_use_id && !message.error) {
        for (const block of Array.isArray(message.message?.content) ? message.message.content : []) {
          if (block?.type === 'tool_use') {
            if (message.session_id === id && await agents.noteCall(block)) continue
            const event = ['WebFetch', 'WebSearch'].includes(block.name)
              ? webActivity(block.input?.url, block.input?.query)
              : { type: 'tool', value: toolName(block.name) }
            await emit(event)
          }
          if (
            block?.type === 'text' &&
            !streamed &&
            typeof block.text === 'string'
          ) {
            await emit({ type: 'text', value: block.text })
            emittedText = true
          }
        }
        streamed = false
      } else if (message.type === 'result') {
        if (message.is_error || message.subtype !== 'success') throw failResult(message)
        if (!seenSession) throw new Error('Claude 未返回可恢复的原生会话。')
        if (!emittedText && typeof message.result === 'string')
          await emit({ type: 'text', value: message.result })
        // Older CLIs may lack the metrics controls. A completed native turn
        // stays successful if either optional status request fails or stalls.
        const deadline = setTimeout(() => stop('SIGKILL'), 4000)
        try {
          const raw = await control({ subtype: 'get_context_usage', detail: 'summary' }, '').catch(
            () => null,
          )
          const value = contextUsage(
            raw?.totalTokens,
            raw?.rawMaxTokens || raw?.maxTokens,
            raw?.model,
          )
          if (value) await emit({ type: 'context', value })
          const quota = await readQuota().catch(() => null)
          if (quota) await emit({ type: 'quota', value: quota })
        } finally {
          clearTimeout(deadline)
        }
        const description = titleRequest?.()
        if (description && child.exitCode === null && !child.signalCode && !signal?.aborted) {
          let deadline
          try {
            const title = control({ subtype: 'generate_session_title', description, persist: false }, '').catch(() => null)
            const result = await Promise.race([title, new Promise(resolve => { deadline = setTimeout(() => resolve(null), 6000) })])
            if (result?.title) await emit({ type: 'title', value: result.title })
          } finally { clearTimeout(deadline) }
        }
        if (agents.hasAgents()) {
          // Print mode can finish the parent turn before a known background
          // agent. Allow Claude's normal wait at EOF, then its usual flush grace.
          child.stdin.end()
          let waitingForBackground = agents.hasBackground()
          let reap = setTimeout(() => stop('SIGKILL'), waitingForBackground ? backgroundWaitMs : shutdownGraceMs)
          try {
            for await (const frame of messages) {
              await observeAgents(frame)
              if (waitingForBackground && !agents.hasBackground()) {
                waitingForBackground = false
                clearTimeout(reap)
                reap = setTimeout(() => stop('SIGKILL'), shutdownGraceMs)
              }
            }
            await onClose
            await agents.settle(child.signalCode === 'SIGKILL')
          } finally { clearTimeout(reap) }
        }
        return
      }
    }
    throw new Error(signal?.aborted ? '任务已取消。' : 'Claude 原生进程已退出，任务未完成。')
  } finally {
    clearTimeout(timer)
    child.stdin.end()
    input.close()
    // Give the native client time to flush its session before forcing exit.
    const reap = setTimeout(() => stop('SIGKILL'), shutdownGraceMs)
    await onClose
    clearTimeout(reap)
    signal?.removeEventListener('abort', abort)
  }
}
