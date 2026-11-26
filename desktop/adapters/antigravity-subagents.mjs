import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { redact } from '../native.mjs'
import { uuid } from './antigravity-profile.mjs'
import { commandActivity, fileActivity, webActivity } from './chat-activity.mjs'

const maxArchive = 16 * 1024 * 1024
const registrationTimeout = 15_000
const idleGrace = 6_000
const progressTimeout = 10 * 60_000
const emptyLog = { steps: [], revision: '' }
const toolLabels = new Map([
  ['search_web', '搜索网页'], ['read_url_content', '读取网页'], ['view_file', '查看文件'],
  ['read_file', '读取文件'], ['list_dir', '列出目录'], ['grep_search', '搜索内容'],
  ['find_by_name', '查找文件'], ['write_file', '写入文件'], ['edit_file', '编辑文件'],
  ['run_command', '运行命令'], ['ask_question', '询问问题'], ['send_message', '发送消息'],
])
const normalize = text => redact(text).trim().replace(/\s+/gu, ' ')
const isRunning = row => row && (Boolean(row.busy) || row.status === 'CASCADE_RUN_STATUS_RUNNING')

async function ownedFile(path) {
  const info = await lstat(path)
  if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || await realpath(path) !== path)
    throw new Error('Unexpected native archive path')
  return info
}

async function readIndex(directory, parent) {
  const path = join(directory, 'conversation_summaries.db')
  await ownedFile(path)
  for (const suffix of ['-wal', '-shm', '-journal']) {
    await ownedFile(path + suffix).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const summary = 'SELECT conversation_id AS id,status,not_fully_idle AS busy,killed FROM conversation_summaries'
    return {
      children: db.prepare(summary + ' WHERE parent_conversation_id=? LIMIT 101').all(parent),
      parentRunning: Boolean(isRunning(db.prepare(summary + ' WHERE conversation_id=?').get(parent))),
    }
  } finally { db.close() }
}

async function readProfileIndex(home, parent) {
  const profile = await lstat(home)
  if (!profile.isDirectory() || profile.uid !== process.getuid?.() || profile.mode & 0o077)
    throw new Error('Unexpected native profile')
  const directory = join(await realpath(home), '.gemini', 'antigravity-cli')
  return { directory, ...await readIndex(directory, parent) }
}

export async function existingAntigravityChildren(home, parent) {
  if (uuid.test(parent)) {
    try {
      const { children } = await readProfileIndex(home, parent)
      return new Set(children.map(child => child.id))
    } catch { /* The native index can be created by the first prompt. */ }
  }
  return new Set()
}

async function readTranscriptFile(path, isFull) {
  let file
  try {
    const expected = await ownedFile(path)
    if (expected.size > maxArchive) return emptyLog
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const current = await file.stat()
    if (current.dev !== expected.dev || current.ino !== expected.ino || current.nlink !== 1 ||
        current.size > maxArchive || !current.isFile()) return emptyLog
    const buffer = Buffer.alloc(current.size)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    const steps = buffer.toString('utf8', 0, bytesRead).split('\n').flatMap(line => {
      try {
        const step = JSON.parse(line)
        if (!Number.isSafeInteger(step?.step_index) || step.step_index < 0) return []
        if (isFull) step._full = true
        return [step]
      } catch { return [] } // The native writer may still be finishing the last JSONL line.
    })
    return { steps, revision: `${current.mtimeMs}:${bytesRead}` }
  } catch { return emptyLog }
  finally { await file?.close().catch(() => {}) }
}

async function childLog(directory, id) {
  const logsDir = join(directory, 'brain', id, '.system_generated', 'logs')
  const [fullLog, compactLog] = await Promise.all([
    readTranscriptFile(join(logsDir, 'transcript_full.jsonl'), true),
    readTranscriptFile(join(logsDir, 'transcript.jsonl'), false),
  ])
  if (!fullLog.steps.length) return compactLog
  if (!compactLog.steps.length) return fullLog
  const merged = new Map(compactLog.steps.map(step => [step.step_index, step]))
  for (const step of fullLog.steps) merged.set(step.step_index, step)
  return {
    steps: [...merged.values()],
    revision: [fullLog.revision, compactLog.revision].filter(Boolean).join('|'),
  }
}

// CORTEX_STEP_STATUS in Antigravity CLI conversations/<id>.db:
// 0 = UNSPECIFIED, 1 = PENDING, 2 = RUNNING, 3 = DONE, 4 = INVALID, 5 = CLEARED,
// 6 = CANCELED, 7 = ERROR, 8 = GENERATING, 9 = WAITING, 10 = HALTED, 11 = QUEUED, 12 = INTERRUPTED
async function readChildStepState(directory, id) {
  const path = join(directory, 'conversations', id + '.db')
  try {
    await ownedFile(path)
    for (const suffix of ['-wal', '-shm', '-journal']) {
      await ownedFile(path + suffix).catch(error => { if (error.code !== 'ENOENT') throw error })
    }
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      const rows = db.prepare('SELECT idx, status FROM steps ORDER BY idx DESC LIMIT 8').all()
      if (!rows.length) return null
      const active = rows.find(row => row.status === 1 || row.status === 2 || row.status === 8 || row.status === 11)
      if (active) return { state: 'running', idx: active.idx }
      const waiting = rows.find(row => row.status === 9)
      if (waiting) return { state: 'waiting', idx: waiting.idx }
      const latest = rows[0]
      if (latest.status === 4 || latest.status === 7) return { state: 'errored', idx: latest.idx }
      if (latest.status === 6 || latest.status === 10 || latest.status === 12) return { state: 'canceled', idx: latest.idx }
      return { state: 'done', idx: latest.idx }
    } finally { db.close() }
  } catch { return null }
}

function sawPrompt(steps, prompt) {
  if (!prompt || prompt.length < 8) return false
  return steps.some(step => ['SYSTEM_MESSAGE', 'USER_INPUT'].includes(step.type) && step.step_index <= 1 &&
    typeof step.content === 'string' && normalize(step.content).includes(prompt))
}

function toolString(value, isFull = false) {
  if (typeof value !== 'string') return ''
  const cleaned = value.replace(/\r?\n?<truncated \d+ bytes>"?$/u, '')
  if (isFull && !value.startsWith('"')) return cleaned
  if (!value.startsWith('"')) return cleaned
  try {
    const decoded = JSON.parse(value)
    if (typeof decoded === 'string') return decoded
  } catch {
    if (!isFull) {
      let body = cleaned.slice(1)
      let trailingSlashes = 0
      for (let i = body.length - 1; i >= 0 && body[i] === '\\'; i--) trailingSlashes++
      if (trailingSlashes % 2 === 1) body = body.slice(0, -1)
      try {
        const repaired = JSON.parse('"' + body + '"')
        if (typeof repaired === 'string') return repaired
      } catch {}
    }
  }
  return isFull ? value : cleaned
}

function toolInt(value) {
  if (Number.isInteger(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
  return undefined
}

function agySubagentToolMeta(call, stepStatus, isFull = false) {
  const status =
    stepStatus === 'RUNNING' || stepStatus === 'PENDING'
      ? 'running'
      : stepStatus === 'ERROR' || stepStatus === 'INVALID'
        ? 'failed'
        : 'completed'
  const args = call?.args && typeof call.args === 'object' ? call.args : {}
  const str = (val) => toolString(val, isFull)
  const name = call?.name
  if (name === 'search_web') {
    const q = str(args.query).trim()
    return {
      kind: 'webSearch',
      category: 'web',
      status,
      ...(q && { query: q, title: '已搜索网页：' + q }),
    }
  }
  if (name === 'read_url_content') {
    const w = webActivity(str(args.Url || args.url), '')
    const url = w.source?.url
    return {
      kind: 'webSearch',
      category: 'web',
      status,
      ...(url && { url, title: '读取网页：' + url }),
    }
  }
  if (['read_file', 'view_file', 'view_file_outline', 'view_code_item'].includes(name)) {
    const f = fileActivity({
      action: 'read',
      status,
      path: str(args.Path || args.TargetFile),
      line: toolInt(args.StartLine),
    })
    return {
      kind: 'read',
      category: 'read',
      status,
      ...(f.path && { path: f.path }),
      ...(f.line && { line: f.line }),
      title: f.value,
    }
  }
  if (name === 'list_dir') {
    const f = fileActivity({
      action: 'list',
      status,
      path: str(args.DirectoryPath || args.Path),
    })
    return { kind: 'list', category: 'read', status, ...(f.path && { path: f.path }), title: f.value }
  }
  if (['grep_search', 'find_by_name'].includes(name)) {
    const f = fileActivity({
      action: 'search',
      status,
      path: str(args.SearchPath || args.SearchDirectory || args.Path),
      query: str(args.Query || args.Pattern),
    })
    return {
      kind: 'search',
      category: 'search',
      status,
      ...(f.path && { path: f.path }),
      ...(f.query && { query: f.query }),
      title: f.value,
    }
  }
  if (['write_file', 'edit_file', 'create_file', 'replace_file_content', 'multi_replace_file_content'].includes(name)) {
    const f = fileActivity({
      action: ['write_file', 'create_file'].includes(name) ? 'create' : 'edit',
      status,
      path: str(args.Path || args.TargetFile),
    })
    return {
      kind: 'fileChange',
      category: 'edit',
      status,
      ...(f.path && { path: f.path }),
      ...(f.files && { files: f.files }),
      title: f.value,
    }
  }
  if (name === 'run_command') {
    const rawCmd = str(args.CommandLine)
    const c = commandActivity({ command: rawCmd, status })
    return {
      kind: 'command',
      category: 'command',
      status,
      ...(rawCmd && { command: c.command, commandKind: c.commandKind }),
      title: rawCmd ? c.command : '运行命令',
    }
  }
  return { kind: 'tool', category: 'mcp', status, title: toolLabels.get(name) || '调用工具' }
}

function extractParentMessage(step, parent) {
  if (step.type !== 'SYSTEM_MESSAGE' || step.step_index <= 0 || typeof step.content !== 'string') return ''
  const match = /\[Message\][^\n]*\bsender=([a-f\d-]+)\b[^\n]*\bcontent=([\s\S]*?)\s*<\/SYSTEM_MESSAGE>/i.exec(step.content)
  return match && match[1] === parent ? match[2].trim() : ''
}

function visibleArchive(child, parent, steps, prompt, stepState) {
  const entries = []
  let lastReply = -1, lastTool = -1, lastToolName = '', lastToolMeta = null, model
  steps.sort((a, b) => a.step_index - b.step_index)
  for (const [position, step] of steps.entries()) {
    const isFull = Boolean(step._full)
    const id = 'agy-' + child.id + ':' + step.step_index
    if (step.type === 'USER_INPUT' && step.source === 'USER' && typeof step.content === 'string' &&
        normalize(step.content) !== prompt) {
      entries.push({ id, role: 'user', text: step.content })
    }
    const parentFollowup = extractParentMessage(step, parent)
    if (parentFollowup && normalize(parentFollowup) !== prompt) {
      entries.push({ id, role: 'user', text: parentFollowup })
    }
    if (step.type !== 'PLANNER_RESPONSE' || step.source !== 'MODEL') continue
    if (typeof step.model === 'string' && /^[a-z\d][a-z\d_.-]{0,79}$/i.test(step.model)) model = step.model
    if (typeof step.content === 'string' && step.content.trim()) {
      entries.push({ id, role: 'assistant', text: step.content })
      if (step.status === 'DONE') lastReply = step.step_index
    }
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls.slice(0, 32) : []
    for (const [index, call] of calls.entries()) {
      if (typeof call?.name !== 'string') continue
      lastTool = step.step_index
      lastToolName = call.name
      lastToolMeta = agySubagentToolMeta(call, step.status, isFull)
      entries.push({
        id: id + ':' + index,
        role: 'activity',
        text: toolLabels.get(call.name) || '调用工具',
        meta: lastToolMeta,
      })
      // The native transcript places the tool result immediately after its planner batch.
      // A report is visible only when this child delivered it to this exact parent.
      const result = steps[position + 1 + index]
      if (call.name !== 'send_message' || step.status !== 'DONE' ||
          toolString(call.args?.Recipient, isFull) !== parent || result?.type !== 'GENERIC' ||
          result.status !== 'DONE' || result.step_index !== step.step_index + 1 + index ||
          typeof result.content !== 'string' ||
          result.content.trimEnd().split('\n').at(-1) !== `Message sent to "${parent}".`) continue
      const report = toolString(call.args?.Message, isFull).trim()
      if (report) {
        entries.push({ id: id + ':report:' + index, role: 'assistant', text: report })
        lastReply = Math.max(lastReply, result.step_index)
      }
    }
  }
  const blockedTool = toolLabels.get(lastToolName) || '工具调用'
  const blockedDetail = lastToolMeta?.command || lastToolMeta?.path || ''
  const blockedOnApproval = !child.killed && !isRunning(child) && stepState?.state === 'waiting'
  if (blockedOnApproval) {
    entries.push({
      id: `agy-${child.id}:waiting:${stepState.idx}`,
      role: 'activity',
      text: `等待权限确认 · ${blockedTool}（后台子智能体无法弹出交互授权）`,
      meta: {
        kind: lastToolMeta?.kind || 'toolCall',
        category: lastToolMeta?.category || 'command',
        status: 'failed',
        title: `等待权限确认 · ${blockedTool}`,
      },
    })
  }
  const status = child.killed ? 'interrupted' :
    (isRunning(child) || stepState?.state === 'running') ? 'running' :
    blockedOnApproval ? 'interrupted' :
    stepState?.state === 'errored' ? 'errored' :
    (stepState?.state === 'canceled' && lastReply <= lastTool) ? 'interrupted' :
    child.status === 'CASCADE_RUN_STATUS_IDLE' && lastReply > lastTool ? 'completed' : 'unconfirmed'
  return {
    entries,
    nativeThreadId: child.id,
    status,
    model,
    blockedOnApproval,
    ...(blockedOnApproval && {
      blockedTool,
      blockedKind: lastToolMeta?.kind || 'toolCall',
      ...(blockedDetail && { blockedDetail }),
    }),
  }
}

async function readAntigravityRun(home, parent, dispatches, existingChildren) {
  const unavailable = { children: [], parentRunning: false }
  if (!uuid.test(parent) || !dispatches.length || dispatches.length > 100) return unavailable
  try {
    const { directory, children, parentRunning } = await readProfileIndex(home, parent)
    if (children.length > 100) return unavailable
    const prompts = dispatches.map(item => normalize(item.prompt))
    const matches = []
    for (const child of children) {
      if (!uuid.test(child.id) || child.id === parent || existingChildren?.has(child.id)) continue
      const [{ steps, revision: logRevision }, stepState] = await Promise.all([
        childLog(directory, child.id),
        readChildStepState(directory, child.id),
      ])
      const known = dispatches.filter(item => item.nativeThreadId === child.id)
      const candidates = known.length ? known :
        dispatches.filter((item, index) => !item.nativeThreadId && sawPrompt(steps, prompts[index]))
      if (candidates.length !== 1) continue
      const { agentId, prompt, taskId, name } = candidates[0]
      const revision = [logRevision, stepState?.state, stepState?.idx].filter(v => v !== undefined && v !== '').join(':')
      matches.push({
        taskId,
        agentId,
        name,
        revision,
        ...visibleArchive(child, parent, steps, normalize(prompt), stepState),
      })
    }
    return {
      children: matches.filter(match => matches.filter(item => item.agentId === match.agentId).length === 1),
      parentRunning,
    }
  } catch { return unavailable } // Older CLI builds or disabled native logging can lack the archive.
}

export async function readAntigravityChildren(home, parent, dispatches) {
  return (await readAntigravityRun(home, parent, dispatches)).children
}

export async function waitForAntigravityChildren(home, parent, dispatches, {
  signal, existingChildren, drainEvents, parentActivity, publish, recoverBlocked,
}) {
  const recoveredIds = new Set()
  const nonErrored = () => dispatches.filter(dispatch => dispatch.status !== 'errored')
  const outstanding = () => nonErrored().filter(dispatch => !recoveredIds.has(dispatch.agentId))
  let lastProgress = performance.now(), idleSince = lastProgress
  let missingSince, lastArchive, lastParentActivity
  for (;;) {
    signal?.throwIfAborted()
    await drainEvents()
    const allDispatches = nonErrored()
    const expected = outstanding()
    if (!allDispatches.length) return
    const { children, parentRunning } = await readAntigravityRun(home, parent, allDispatches, existingChildren)
    await drainEvents()
    const now = performance.now()
    const current = outstanding()
    if (current.length !== expected.length || expected.some((item, index) => current[index] !== item)) {
      idleSince = lastProgress = now
      missingSince = undefined
      continue
    }
    if (!expected.length && !parentRunning) {
      await publish(children, true)
      return
    }
    const activeChildren = children.filter(child => !recoveredIds.has(child.agentId))
    // The summary row may stay IDLE throughout a background turn. Only a
    // native reply, terminal step status, or interruption settles a matched child.
    const working = parentRunning ||
      activeChildren.some(child => child.status === 'running' || child.status === 'unconfirmed')
    // The native writer saves search results that do not create visible chat entries.
    const archive = JSON.stringify(children.map(child => [child.nativeThreadId, child.status, child.revision]).sort())
    const activity = parentActivity()
    const progressed = archive !== lastArchive || activity !== lastParentActivity
    if (progressed) lastProgress = now
    if (working || progressed) idleSince = now
    lastArchive = archive
    lastParentActivity = activity
    missingSince = activeChildren.length === expected.length ? undefined : missingSince ?? now
    // A new child can take time to appear on disk. After a child reports, the
    // native parent can briefly look idle before it starts its background reply.
    const waitingForRegistration = missingSince !== undefined && now - missingSince < registrationTimeout
    const idle = !working && now - idleSince >= idleGrace && !waitingForRegistration
    const timedOut = now - lastProgress >= progressTimeout

    const unrecoveredBlocked = activeChildren.filter(child => child.blockedOnApproval)
    const blockedReady = !working && !waitingForRegistration && unrecoveredBlocked.length > 0 &&
      now - idleSince >= 1000
    if ((idle || blockedReady || timedOut) && unrecoveredBlocked.length && recoverBlocked) {
      await publish(children, false)
      for (const blocked of unrecoveredBlocked) recoveredIds.add(blocked.agentId)
      if (await recoverBlocked(unrecoveredBlocked)) {
        idleSince = lastProgress = performance.now()
        missingSince = undefined
        continue
      }
    }

    await publish(children, idle || timedOut)
    if (idle || timedOut) {
      const completed = activeChildren.filter(child => child.status === 'completed').length
      if (unrecoveredBlocked.length) {
        const names = unrecoveredBlocked.map(c => c.name || '子智能体').join('、')
        throw new Error(`Antigravity 子智能体（${names}）因等待交互工具权限而中断，已收到 ${completed}/${expected.length} 份报告；可切换为自动权限或在当前会话继续汇总。`)
      }
      if (timedOut) throw new Error(`Antigravity 子智能体及主会话连续 10 分钟没有新进展（已收到 ${completed}/${expected.length} 份报告）。`)
      if (completed !== expected.length)
        throw new Error(`Antigravity 已收到 ${completed}/${expected.length} 份报告，可在原会话继续处理缺失的任务。`)
      return
    }
    await delay(1200, undefined, { signal })
  }
}
