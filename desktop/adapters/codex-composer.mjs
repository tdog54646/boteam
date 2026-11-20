import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { redact } from '../native.mjs'

export async function nativeFeatures(rpc, threadId) {
  const enabled = new Set()
  const seen = new Set()
  let cursor
  do {
    const page = await rpc.request(
      'experimentalFeature/list',
      { threadId, limit: 256, ...(cursor && { cursor }) },
      8000,
    )
    for (const feature of page.data) {
      if (feature.enabled && !['removed', 'deprecated'].includes(feature.stage))
        enabled.add(feature.name)
    }
    cursor = page.nextCursor
    if (cursor && seen.has(cursor)) throw new Error('Codex 功能列表分页异常。')
    seen.add(cursor)
  } while (cursor)
  return enabled
}

export async function hasPlanMode(rpc) {
  const modes = await rpc.request('collaborationMode/list', {}, 5000)
  return modes.data.some((item) => item.mode === 'plan')
}

export async function allowsAutoReview(rpc) {
  const { requirements } = await rpc.request('configRequirements/read', {}, 5000)
  const reviewers = requirements?.allowedApprovalsReviewers
  const policies = requirements?.allowedApprovalPolicies
  return (
    (!reviewers || reviewers.some((x) => ['auto_review', 'guardian_subagent'].includes(x))) &&
    (!policies || policies.includes('on-request'))
  )
}

function extension(kind, name, path, title, summary) {
  if (typeof name !== 'string' || !name.trim() || typeof path !== 'string' || !path.trim()) return
  const id =
    kind +
    ':' +
    createHash('sha256')
      .update(JSON.stringify([name, path]))
      .digest('hex')
  const label = redact(typeof title === 'string' && title.trim() ? title : name).slice(0, 160)
  const description = typeof summary === 'string' ? redact(summary).slice(0, 320) : ''
  return {
    entry: { id, kind, label, ...(description && { description }) },
    input: { type: kind === 'skill' ? 'skill' : 'mention', name, path },
  }
}

export async function extensionCatalog(
  rpc,
  cwd,
  opened,
  features,
  kinds = ['skill', 'plugin', 'app'],
) {
  const disabled = new Set(opened.disabledPluginIds || [])
  const groups = {
    async skill() {
      const { data } = await rpc.request('skills/list', { cwds: [cwd], forceReload: true }, 8000)
      return data
        .filter((e) => resolve(e.cwd) === resolve(cwd))
        .flatMap((e) => e.skills)
        .filter(
          (s) =>
            s.enabled && (!s.pluginId || (features.has('plugins') && !disabled.has(s.pluginId))),
        )
        .map((s) =>
          extension(
            'skill',
            s.name,
            s.path,
            s.interface?.displayName,
            s.interface?.shortDescription || s.shortDescription || s.description,
          ),
        )
    },
    async plugin() {
      if (!features.has('plugins')) return []
      const { marketplaces } = await rpc.request('plugin/installed', { cwds: [cwd] }, 8000)
      return marketplaces
        .flatMap((m) => m.plugins)
        .filter(
          (p) =>
            p.installed &&
            p.enabled &&
            p.id &&
            !p.disabledReason &&
            !disabled.has(p.id) &&
            (!p.availability || p.availability === 'AVAILABLE'),
        )
        .map((p) =>
          extension(
            'plugin',
            p.name,
            'plugin://' + p.id,
            p.interface?.displayName,
            p.interface?.shortDescription,
          ),
        )
    },
    async app() {
      if (!features.has('apps')) return []
      const { apps } = await rpc.request(
        'app/installed',
        { threadId: opened.thread.id, forceRefresh: true },
        12000,
      )
      return apps
        .filter((a) => a.enabled && a.callable && a.id)
        .map((a) => extension('app', a.runtimeName || a.id, 'app://' + a.id, a.runtimeName))
    },
  }
  const found = new Map()
  const results = await Promise.allSettled(kinds.map((k) => groups[k]()))
  for (const result of results) {
    if (result.status === 'fulfilled')
      for (const item of result.value) if (item) found.set(item.entry.id, item)
  }
  return { found, partial: results.some((result) => result.status === 'rejected') }
}

export function validateExtensionIds(ids) {
  if (
    !Array.isArray(ids) ||
    ids.length > 32 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => typeof id !== 'string' || !/^(skill|plugin|app):[a-f0-9]{64}$/.test(id))
  )
    throw new Error('所选 Codex 扩展无效，请重新选择。')
}

export async function resolveExtensions(rpc, ids, cwd, opened) {
  if (!ids.length) return []
  const kinds = [...new Set(ids.map((id) => id.split(':')[0]))]
  const features = await nativeFeatures(rpc, opened.thread.id)
  const { found } = await extensionCatalog(rpc, cwd, opened, features, kinds)
  return ids.map((id) => {
    const match = found.get(id)
    if (!match) throw new Error('当前 Codex 账号或工作目录无法使用所选扩展，请重新选择。')
    return match.input
  })
}

const goalStates = new Set([
  'active',
  'paused',
  'blocked',
  'usageLimited',
  'budgetLimited',
  'complete',
])

export function checkedGoal(goal, threadId) {
  if (goal == null) return null
  if (
    goal.threadId !== threadId ||
    !goalStates.has(goal.status) ||
    typeof goal.objective !== 'string'
  )
    throw new Error('Codex 返回的目标与当前会话不匹配。')
  return {
    objective: redact(goal.objective),
    status: goal.status,
    tokenBudget: goal.tokenBudget ?? null,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
  }
}

export function goalFields(objective, tokenBudget) {
  if (
    objective !== undefined &&
    (typeof objective !== 'string' || !objective.trim() || objective.length > 12000)
  )
    throw new Error('请输入有效的 Codex 目标。')
  if (
    tokenBudget !== undefined &&
    tokenBudget !== null &&
    (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)
  )
    throw new Error('目标的令牌预算必须为正整数。')
  return {
    ...(objective !== undefined && { objective: objective.trim() }),
    ...(tokenBudget !== undefined && { tokenBudget }),
  }
}

export async function readGoal(rpc, threadId) {
  const result = await rpc.request('thread/goal/get', { threadId })
  if (!result || !('goal' in result)) throw new Error('Codex 未返回目标状态。')
  return checkedGoal(result.goal, threadId)
}

// Resuming an active native goal automatically starts a turn. Park an abandoned
// goal in durable storage before loading the thread for a normal user message.
export async function parkActiveGoal(rpc, threadId) {
  let goal
  try {
    goal = await readGoal(rpc, threadId)
  } catch (e) {
    if (e.rpcCode === -32601 || e.goalsDisabled) return
    throw e
  }
  if (goal?.status === 'active') {
    const result = await rpc.request('thread/goal/set', {
      threadId,
      origin: 'automatic',
      status: 'paused',
    })
    if (checkedGoal(result.goal, threadId)?.status !== 'paused')
      throw new Error('Codex 未确认暂停原生目标。')
  }
}

export async function respondToQuestions(rpc, msg, ask) {
  const text = (value, max) => (typeof value === 'string' ? redact(value).slice(0, max) : '')
  const questions = (Array.isArray(msg.params?.questions) ? msg.params.questions : [])
    .slice(0, 16)
    .filter(
      (q) =>
        q &&
        typeof q.id === 'string' &&
        q.id.length &&
        q.id.length <= 256 &&
        !['__proto__', 'constructor', 'prototype'].includes(q.id) &&
        typeof q.question === 'string',
    )
    .map((q) => ({
      id: q.id,
      header: text(q.header, 160),
      question: text(q.question, 3000),
      isSecret: q.isSecret === true,
      isOther: q.isOther === true,
      options: (Array.isArray(q.options) ? q.options : [])
        .slice(0, 40)
        .filter((o) => typeof o?.label === 'string')
        .map((o) => ({
          label: text(o.label, 320),
          description: text(o.description, 1200),
        })),
    }))
  const response = ask && questions.length ? await rpc.decision(ask, questions) : null
  const answers = Object.create(null)
  for (const q of questions) {
    const selected = response && Object.hasOwn(response, q.id) && response[q.id]?.answers
    if (
      Array.isArray(selected) &&
      selected.length > 0 &&
      selected.length <= 24 &&
      selected.every((value) => typeof value === 'string' && value.length <= 12000)
    )
      answers[q.id] = { answers: selected }
  }
  rpc.send({ id: msg.id, result: { answers } })
}
