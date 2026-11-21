import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { open, readFile, cp, mkdir, lstat, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  hasStagedLogin,
  initSettings,
  invocation,
  markStagedLogin,
  paidTier,
  privateProfile,
  statusline,
  uuid,
} from './antigravity-profile.mjs'
import { authenticatePersonal, withAcp } from './antigravity-acp.mjs'
import { cliPreferences, externalSource, hasCliLogin, installCliLogin, withCliLogin } from './antigravity-import.mjs'
import { commandUpdates, sessionSkills, sessionSlashCommands } from './antigravity-actions.mjs'
import { slashPrompt } from './native-slash.mjs'
import { nativeEnv } from '../native.mjs'

import { contextUsage, inlineImages, quotaWindow } from './usage.mjs'

export { hasStagedLogin }
const permissions = { default: 'default', plan: 'plan', edits: 'accept-edits', 'workspace-auto': 'auto' }
export const permissionModes = Object.keys(permissions)
const execute = promisify(execFile)

const sharedLogin =
  '此来源使用系统共享登录。首次绑定需要在 Google 授权页确认要使用的账号。'
const nativeRoot = path.join(os.homedir(), '.gemini')
const desktopSource = path.join(nativeRoot, 'antigravity')
const cliSource = path.join(nativeRoot, 'antigravity-cli')

// This is the previous sign-in label used by the desktop onboarding screen.
// It can outlive a logout. It is never accepted for binding an executable bot.
async function desktopInfo(source) {
  const file = path.join(source, 'app_storage.json')
  let handle
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = await handle.stat()
    if (!info.isFile() || info.size > 4 * 1024 * 1024 || (process.getuid && info.uid !== process.getuid()))
      return {}
    const store = JSON.parse(await handle.readFile('utf8'))
    const recognizable = Object.keys(store || {}).some(key => key.startsWith('jetski.'))
    const label = store?.['jetski.onboarding.lastLoginUsername']
    if (
      typeof label === 'string' &&
      label.length <= 254 &&
      /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(label)
    )
      return { recognizable, email:label.toLowerCase() }
    return { recognizable }
  } catch {
    /* Newer builds may store no such label. */
    return {}
  } finally { await handle?.close() }
}

async function loginState(bin, source, signal) {
  // A single native /usage exposes the status of the standard CLI's shared login.
  // It cannot attest an arbitrary selected profile or the desktop's last account.
  if (!bin || source !== cliSource || process.platform !== 'darwin') return 'unknown'
  try {
    const { stdout } = await execute('/usr/bin/sandbox-exec', [
      '-p', '(version 1)(allow default)(deny file-write*)(deny process-exec (literal "/usr/bin/open"))',
      bin, '--log-file', '/dev/null', '--output-format', 'json', '-p', '/usage',
    ], { env: nativeEnv({ AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }), cwd: os.tmpdir(),
      timeout: 5500, maxBuffer: 128 * 1024, signal })
    const result = JSON.parse(stdout)
    if (result.status === 'SUCCESS' && result.num_turns === 0 && result.command?.name === 'usage' &&
        Array.isArray(result.command.data?.groups)) return 'signed-in'
  } catch (error) {
    signal?.throwIfAborted()
    if (/authentication required|not signed in|not authenticated|please (?:log|sign) in/i.test(
      String(error.stdout || '') + String(error.stderr || ''))) return 'signed-out'
  }
  return 'unknown'
}

async function subscriptionProfile(bin, source) {
  const profile = await privateProfile(bin, source)
  const settingsFile = path.join(profile.home, '.gemini', 'antigravity-cli', 'settings.json')
  let settings
  try {
    const info = await lstat(settingsFile)
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error()
    settings = JSON.parse(await readFile(settingsFile, 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') return profile // Native defaults use personal OAuth and request review.
    throw new Error('无法核验 Antigravity 独立配置，请重新授权。')
  }
  if (settings?.modelProvider || (settings?.auth?.type && settings.auth.type !== 'oauth-personal'))
    throw new Error('当前 agy 配置未使用个人 Google 订阅 OAuth。')
  if (settings?.toolPermission && !['strict', 'request-review'].includes(settings.toolPermission))
    throw new Error('请在独立 agy 配置中启用工具审批，再重新检测。')
  return profile
}

async function subscriptionIdentity(profile, signal, model) {
  const found = await statusline(profile, signal)
  await withAcp(profile, signal, null, (request, capabilities) =>
    withFreshSession(request, capabilities, profile, found.plan, (_id, configs) => {
      const match = model && select(configs, 'model').items.find(item => item.id === model || item.label === model)
      if (match) found.model = match.id
    }))
  return found
}

export async function detect({ source = desktopSource, bin, appInstalled, cliInstalled, signal, managed = false, checkExternalSource }) {
  if (managed) {
    try {
      return await subscriptionIdentity(await subscriptionProfile(bin, source), signal)
    } catch (error) {
      signal?.throwIfAborted()
      return { status: 'login', loginState: 'unknown', reason: error.message }
    }
  }
  const { expected, checkStorage, ...location } = await externalSource(source)
  await checkExternalSource?.(location.source)
  const { source: dir, sourceKind } = location
  const desktop = sourceKind === 'desktop' && await desktopInfo(dir)
  if (checkStorage && !desktop.recognizable) location.configFound = false
  if (!appInstalled && (!bin || (cliInstalled === false && !location.configFound)))
    return { ...location, status: 'missing', loginState: 'unknown', requiresAuthorization: false,
      reason: (location.configFound ? '已找到原生配置。' : '') + '未找到 Antigravity 桌面端或独立安装的 agy 命令行工具。' }
  if (!location.configFound && !expected)
    return { ...location, status: 'blocked', requiresAuthorization: false, loginState: 'unknown',
      reason: '未识别 Antigravity 原生配置目录。请选择桌面配置目录或包含 agy 配置的 antigravity-cli 目录。' }

  let email, state = 'unknown', cliReason
  if (sourceKind === 'cli') {
    try {
      const { incompatible, model } = await cliPreferences(dir)
      if (incompatible) return { ...location, status: 'blocked', loginState: 'unknown',
        requiresAuthorization: false, reason: '此 agy 配置使用其他模型服务或认证方式，无法作为个人 Google 订阅导入。' }
      if (bin && await hasCliLogin(dir)) {
        const found = await withCliLogin(dir, bin, signal, profile => subscriptionIdentity(profile, signal, model))
        return { ...location, ...found, requiresAuthorization: false }
      }
      state = await loginState(bin, dir, signal)
    } catch {
      signal?.throwIfAborted()
      cliReason = '未能核验所选 agy 配置的当前订阅，请使用 Google 授权完成绑定。'
    }
  } else email = desktop.email
  const digest = createHash('sha256').update(dir).digest('hex')
  const details = {
    'signed-in': '原生额度接口已确认 CLI 共享登录有效。',
    'signed-out': '当前 CLI 显示未登录。',
    unknown: sourceKind === 'desktop' ? '已检测到 Antigravity 桌面端。' : '已检测到 Antigravity CLI。',
  }
  return {
    ...location, status: 'blocked', identity: 'source:' + digest, loginState: state,
    requiresAuthorization: Boolean(bin), ...(email && { email }),
    reason: (email ? '此邮箱来自桌面端上次登录记录。' : '') +
      (bin ? cliReason || details[state] + sharedLogin
        : '未找到可用于绑定订阅的 agy 命令行工具。'),
  }
}

// Only native conversation files belonging to BoTeam's known session IDs migrate.
// New OAuth grants stay in the newly authorized home, owned by agy.
async function keepThreads(previous, next, threadIds) {
  const cli = (home) => path.join(home, '.gemini', 'antigravity-cli')
  for (const id of new Set(threadIds)) {
    if (!uuid.test(id)) throw new Error('Antigravity 原生会话标识无效。')
    let history = false
    for (const item of [
      `conversations/${id}.db`,
      `conversations/${id}.db-wal`,
      `conversations/${id}.pb`,
      `brain/${id}`,
    ]) {
      const from = path.join(cli(previous), item),
        to = path.join(cli(next), item)
      let info
      try {
        info = await lstat(from)
      } catch (e) {
        if (e.code === 'ENOENT') continue
        throw e
      }
      if (!info.isDirectory() && !info.isFile()) throw new Error('无法迁移 Antigravity 原生会话。')
      await mkdir(path.dirname(to), { recursive: true, mode: 0o700 })
      await cp(from, to, {
        recursive: info.isDirectory(),
        force: false,
        errorOnExist: true,
      })
      if (/\.(db|pb)$/.test(item)) history = true
    }
    if (!history) throw new Error('旧 Antigravity 会话文件缺失，已保留原绑定。')
  }
}

export async function prepare({ candidate, profile, existing, threadIds = [] }) {
  if (!candidate.managed && candidate.sourceKind === 'cli' && candidate.status === 'ready') {
    const { source, bin, signal } = candidate
    if (!profile || await realpath(profile) === await realpath(source) ||
        (existing?.managed && path.resolve(profile) === path.resolve(existing.source)))
      throw new Error('导入需要新的独立 agy 账号目录。')
    const { incompatible, model } = await cliPreferences(source)
    if (incompatible) throw new Error('此 agy 配置已更换订阅认证方式，请重新检测。')
    const target = await subscriptionProfile(bin, profile)
    await installCliLogin(source, profile, bin, signal)
    const found = await subscriptionIdentity(target, signal, model)
    if (found.identity !== candidate.identity || found.plan !== candidate.plan ||
        (existing?.identity && existing.identity !== found.identity))
      throw new Error('所选 agy 原生登录身份或订阅已变化，请重新检测。')
    if (existing?.managed) await keepThreads(existing.source, profile, threadIds)
    return { ...found, origin: source, source: profile, managed: true }
  }
  const found = await detect(candidate)
  if (
    !found.identity ||
    found.identity !== candidate.identity ||
    (!candidate.managed && found.email?.toLowerCase() !== candidate.email?.toLowerCase()) ||
    !['ready', 'blocked'].includes(found.status)
  )
    throw new Error('Antigravity 来源或身份已变化，请重新检测。')
  if (found.status === 'ready' && existing?.managed && existing.source !== candidate.source)
    await keepThreads(existing.source, candidate.source, threadIds)
  return { ...found, source: candidate.source }
}

export async function login({ source, bin, signal, openUrl }) {
  if (!bin) throw new Error('未找到 Antigravity CLI（agy）。')
  const profile = await privateProfile(bin, source)
  await initSettings(profile)
  let needsGrant = !(await hasStagedLogin({ source }))
  if (!needsGrant) {
    // A marker only records that the native sign-in once exited successfully.
    // Recheck the actual cached grant and refresh it if Google has revoked it.
    try {
      await withAcp(profile, signal, null, async (request, capabilities) => {
        const session = await request('session/new', { cwd: profile.home, mcpServers: [] })
        if (!paidTier(session?._meta?.antigravity?.tier?.name))
          throw new Error('已授权的 Google 账号没有可用付费订阅。请重新选择账号。')
        if (capabilities?.sessionCapabilities?.close)
          await request('session/close', { sessionId: session.sessionId })
      })
    } catch (e) {
      if (e.code !== 'AGY_AUTH_REQUIRED') throw e
      needsGrant = true
    }
  }
  if (needsGrant) {
    await authenticatePersonal(profile, signal, openUrl)
    await markStagedLogin(profile.home)
  }
  try {
    await statusline(profile, signal)
  } catch (error) {
    if (error.code !== 'AGY_SETUP_REQUIRED') throw error
    await statusline(profile, signal, true)
  }
}

async function verify(account, signal) {
  if (!account?.managed) throw new Error('请先授权隔离的 Antigravity 账号身份。')
  const profile = await subscriptionProfile(account.bin, account.source)
  const found = await statusline(profile, signal)
  if (
    found.identity !== account.identity ||
    (account.plan && paidTier(account.plan) !== found.plan)
  )
    throw new Error('当前 Antigravity 身份或订阅与 Bot 绑定不符。')
  return { profile, found }
}

function select(options, category) {
  const config = options?.find?.((o) => o.category === category && o.type === 'select')
  const items = (config?.options || [])
    .flatMap((o) => (Array.isArray(o.options) ? o.options : [o]))
    .filter((o) => typeof o.value === 'string' && o.value && typeof o.name === 'string')
    .map((o) => ({ id: o.value, label: o.name }))
  return { key: config?.id, current: config?.currentValue, items }
}

async function configure(request, id, configs, category, value) {
  if (!value) return configs
  const picker = select(configs, category)
  const label = { model: '模型', thought_level: '推理档位', mode: '权限模式' }[category]
  if (!picker.key || !picker.items.some((x) => x.id === value))
    throw new Error(`此订阅当前不支持选择的 Antigravity ${label}。`)
  if (picker.current === value) return configs
  const reply = await request('session/set_config_option', {
    sessionId: id,
    configId: picker.key,
    value,
  })
  if (select(reply?.configOptions, category).current !== value)
    throw new Error(`Antigravity 未确认所选${label}。`)
  return reply.configOptions
}

function verifiedSession(reply, plan, id) {
  const sid = reply?.sessionId || id
  if (!uuid.test(sid) || (id && id !== sid))
    throw new Error('Antigravity 返回了不匹配的原生会话标识。')
  if (paidTier(reply?._meta?.antigravity?.tier?.name) !== plan)
    throw new Error('运行中的 Antigravity ACP 无法核验绑定的付费订阅。')
  return sid
}

async function withFreshSession(request, capabilities, profile, plan, read, cwd = profile.home) {
  const reply = await request('session/new', {
    cwd,
    mcpServers: [],
  })
  const id = verifiedSession(reply, plan)
  try {
    return await read(id, reply.configOptions)
  } finally {
    if (capabilities?.sessionCapabilities?.close) await request('session/close', { sessionId: id })
  }
}

export async function composerActions({ account, cwd, signal }) {
  const { profile, found } = await verify(account, signal)
  const updates = commandUpdates()
  return withAcp(profile, signal, updates.observe, (request, capabilities) =>
    withFreshSession(request, capabilities, profile, found.plan, async (id, configs) => {
      const modes = select(configs, 'mode').items
      const commands = await updates.read(id)
      const plan = modes.some(mode => mode.id === 'plan')
      return {
        plan, workspaceAuto: modes.some(mode => mode.id === 'auto'),
        goal: false, autoReview: false, maxExtensions: 1,
        extensions: await sessionSkills(commands, profile, cwd),
        slashCommands: sessionSlashCommands(commands, plan),
        ...(!commands && { note: '本次原生会话未返回可用命令列表。' }),
      }
    }, cwd))
}

export async function options({ account, signal }) {
  const { profile, found } = await verify(account, signal)
  return withAcp(profile, signal, null, (request, capabilities) =>
    withFreshSession(request, capabilities, profile, found.plan, async (id, initial) => {
      const picker = select(initial, 'model'),
        models = []
      const defaultModel = account.model || picker.current
      const available = picker.items.some(model => model.id === defaultModel)
      let configs = available ? await configure(request, id, initial, 'model', defaultModel) : initial
      const defaultLevels = available ? select(configs, 'thought_level') : null
      for (const model of picker.items) {
        configs = await configure(request, id, configs, 'model', model.id)
        models.push({
          ...model,
          efforts: select(configs, 'thought_level').items,
          defaultEffort: select(configs, 'thought_level').current,
        })
      }
      return {
        models,
        defaultModel,
        efforts: defaultLevels?.items || [],
        defaultEffort: defaultLevels?.current,
        reason: !models.length ? '此版本未返回可选模型。'
          : defaultModel && !available ? '原配置中的默认模型已不可用，请重新选择。' : '',
      }
    }),
  )
}

async function readQuota(profile, picker, model, signal) {
  const name = picker.items.find((item) => item.id === model)?.label
  if (!name) return
  const [cmd, ...args] = invocation(profile, [
    '--log-file',
    '/dev/null',
    '--output-format',
    'json',
    '-p',
    '/usage',
  ])
  let result
  try {
    const { stdout } = await execute(cmd, args, {
      env: profile.env,
      cwd: profile.home,
      timeout: 6500,
      maxBuffer: 256 * 1024,
      signal,
    })
    result = JSON.parse(stdout)
  } catch {
    signal?.throwIfAborted()
    return
  }
  if (result?.status !== 'SUCCESS' || result.num_turns !== 0 || result.command?.name !== 'usage')
    return
  const groups = result.command.data?.groups
  if (!Array.isArray(groups)) return
  const normalized = name.toLowerCase().replace(/\s+\((?:low|medium|high|xhigh|max)\)$/, '')
  const direct = groups.find((group) => typeof group?.name === 'string' && group.name.toLowerCase() === normalized)
  const matches = groups.filter((group) => {
    const list = /^Models within this group:\s*(.+)$/i.exec(group?.description || '')
    return list?.[1].split(',').some((member) => member.trim().toLowerCase() === normalized)
  })
  const group = direct || (matches.length === 1 && matches[0])
  if (!Array.isArray(group?.buckets)) return
  const windows = group.buckets
    .flatMap((bucket) => {
      const minutes = { '5h': 300, weekly: 10080 }[bucket?.window]
      return Number.isFinite(bucket?.remaining_fraction)
        ? quotaWindow(minutes, bucket.remaining_fraction * 100, Date.parse(bucket.reset_time)) || []
        : []
    })
    .sort((a, b) => a.minutes - b.minutes)
  if (windows.length) {
    const shared = matches.includes(group) && /Models within this group:[^\n]+,/i.test(group.description)
    return { windows: shared ? windows.map(w => ({ ...w, group: group.name })) : windows, model, scope: 'model' }
  }
}

export async function quota({ account, model, signal }) {
  const { profile, found } = await verify(account, signal)
  return withAcp(profile, signal, null, (request, capabilities) =>
    withFreshSession(request, capabilities, profile, found.plan, async (_id, configs) => {
      const picker = select(configs, 'model')
      return readQuota(profile, picker, model || account.model || picker.current, signal)
    }),
  )
}

export async function run({
  account,
  bot = {},
  threadId,
  prompt,
  attachments,
  titleRequest,
  permission = 'default',
  planMode = false,
  extensionIds = [],
  slashCommand,
  cwd,
  signal,
  emit,
  approve,
}) {
  if (!permissionModes.includes(permission)) throw new Error('所选 Antigravity 权限模式无效。')
  if (!Array.isArray(extensionIds) || extensionIds.length > 1)
    throw new Error('Antigravity 每条消息支持一个原生技能。')
  if (slashCommand && extensionIds.length) throw new Error('请选择一个 Antigravity 命令或技能。')
  const { profile, found } = await verify(account, signal)
  const updates = commandUpdates()
  if (threadId && !uuid.test(threadId)) throw new Error('Antigravity 原生会话标识无效。')
  let id,
    selectedModel,
    authorized = false
  const handle = async (msg) => {
    if (extensionIds.length || slashCommand) updates.observe(msg)
    const p = msg.params || {}
    if (msg.method === 'session/request_permission') {
      if (!authorized || p.sessionId !== id) return { outcome: { outcome: 'cancelled' } }
      const { kind, title, locations } = p.toolCall || {}
      const paths = Array.isArray(locations)
        ? locations.map(location => location?.path).filter(path => typeof path === 'string').slice(0, 3) : []
      const action = paths.length ? [kind, title].filter(Boolean).join(' · ') : title || kind
      const allow = p.options?.find((o) => o.kind === 'allow_once'),
        deny = p.options?.find((o) => o.kind === 'reject_once')
      const ok =
        allow &&
        (await approve({
          title: 'Antigravity 工具授权',
          detail: [action || '原生工具请求', ...paths].join('\n').slice(0, 900),
        }))
      const choice = ok ? allow : deny
      return {
        outcome: choice
          ? { outcome: 'selected', optionId: choice.optionId }
          : { outcome: 'cancelled' },
      }
    }
    if (msg.method !== 'session/update' || !authorized || p.sessionId !== id) return
    if (p.update?.sessionUpdate === 'session_info_update' && p.update.title && titleRequest?.())
      await emit({ type: 'title', value: p.update.title })
    if (p.update?.sessionUpdate === 'agent_message_chunk' && p.update.content?.type === 'text')
      await emit({ type: 'text', value: p.update.content.text })
    if (p.update?.sessionUpdate === 'usage_update') {
      const value = contextUsage(p.update.used, p.update.size, selectedModel)
      if (value) await emit({ type: 'context', value })
    }
    if (p.update?.sessionUpdate === 'tool_call')
      await emit({
        type: 'tool',
        value: p.update.title || p.update.kind || 'Antigravity 工具',
      })
  }
  return withAcp(profile, signal, handle, async (request, capabilities) => {
    let targetModel = bot.model || account.model,
      targetEffort = bot.effort
    // A resumed native session remembers the previous turn's selections. Read
    // fresh native defaults when the user cleared either Bot override.
    if (threadId && (!targetModel || !targetEffort)) {
      await withFreshSession(request, capabilities, profile, found.plan, async (fresh, initial) => {
        targetModel ||= select(initial, 'model').current
        const configs = await configure(request, fresh, initial, 'model', targetModel)
        targetEffort ||= select(configs, 'thought_level').current
      })
    }
    const args = { cwd, mcpServers: [] }
    let reply
    if (threadId) {
      args.sessionId = threadId
      if (capabilities?.sessionCapabilities?.resume) {
        try {
          reply = await request('session/resume', args)
        } catch (error) {
          if (error.code !== 'AGY_LOAD_REQUIRED' || !capabilities.loadSession) throw error
        }
      }
      if (!reply) {
        if (!capabilities?.loadSession) throw new Error('当前 Antigravity CLI 不支持恢复原生会话。')
        reply = await request('session/load', args)
      }
    } else reply = await request('session/new', args)
    id = verifiedSession(reply, found.plan, threadId)
    let configs = await configure(request, id, reply.configOptions, 'model', targetModel)
    configs = await configure(request, id, configs, 'thought_level', targetEffort)
    // Reapply the default too: a native resumed session can remember plan or accept-edits.
    if (planMode || permission !== 'default' || select(configs, 'mode').key)
      configs = await configure(request, id, configs, 'mode', planMode ? 'plan' : permissions[permission])
    if (slashCommand) {
      const plan = select(configs, 'mode').items.some(mode => mode.id === 'plan')
      prompt = slashPrompt(sessionSlashCommands(await updates.read(id), plan), slashCommand, prompt, 'Antigravity')
    } else if (extensionIds.length) {
      const skills = await sessionSkills(await updates.read(id), profile, cwd)
      const selected = skills.find(skill => skill.id === extensionIds[0])
      if (!selected) throw new Error('所选 Antigravity 技能在当前原生会话中不可用，请重新选择。')
      prompt = [selected.label, prompt].filter(Boolean).join(' ')
    }
    await emit({ type: 'identity', value: found.email, key: found.identity })
    if (slashCommand) await emit({ type: 'tool', value: 'Antigravity 原生命令 · /' + slashCommand })
    const model = select(configs, 'model'),
      effort = select(configs, 'thought_level')
    const display = [model, effort]
      .map((p) => p.items.find((x) => x.id === p.current)?.label)
      .filter(Boolean)
    if (display.length)
      await emit({
        type: 'tool',
        value: 'Antigravity 已采用 ' + display.join(' · '),
      })
    await emit({ type: 'session', value: id })
    selectedModel = model.current
    const images = capabilities?.promptCapabilities?.image ? await inlineImages(attachments) : []
    authorized = true
    const result = await request('session/prompt', {
      sessionId: id,
      prompt: [{ type: 'text', text: prompt }, ...images],
    })
    if (result?.stopReason === 'max_tokens')
      throw new Error('Antigravity 本轮达到 token 上限，请缩短输入或将任务分步执行。')
    if (result?.stopReason !== 'end_turn')
      throw new Error('Antigravity 在完成本轮前停止，请检查额度或重试。')
    const quota = await readQuota(profile, model, selectedModel, signal)
    if (quota) await emit({ type: 'quota', value: quota })
    if (titleRequest?.() && capabilities?.sessionCapabilities?.list) {
      const page = await request('session/list', { cwd }, 1200).catch(() => null)
      const title = page?.sessions?.find(session => session.sessionId === id)?.title
      if (title) await emit({ type: 'title', value: title })
    }
  })
}
