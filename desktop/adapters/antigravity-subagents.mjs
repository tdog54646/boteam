import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { redact } from '../native.mjs'
import { uuid } from './antigravity-profile.mjs'

const maxArchive = 8 * 1024 * 1024
const registrationTimeout = 15_000
const idleGrace = 6_000
const progressTimeout = 10 * 60_000
const emptyLog = { steps: [], revision: '' }
const toolLabels = new Map([
  ['search_web', '搜索网页'], ['read_url_content', '读取网页'], ['view_file', '查看文件'],
  ['list_dir', '列出目录'], ['grep_search', '搜索内容'], ['run_command', '运行命令'],
  ['send_message', '发送消息'],
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

async function childLog(directory, id) {
  const path = join(directory, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl')
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
        return Number.isSafeInteger(step?.step_index) && step.step_index >= 0 ? [step] : []
      } catch { return [] } // The native writer may still be finishing the last JSONL line.
    })
    return { steps, revision: `${current.mtimeMs}:${bytesRead}` }
  } catch { return emptyLog }
  finally { await file?.close().catch(() => {}) }
}

function sawPrompt(steps, prompt) {
  if (!prompt || prompt.length < 8) return false
  return steps.some(step => ['SYSTEM_MESSAGE', 'USER_INPUT'].includes(step.type) && step.step_index <= 1 &&
    typeof step.content === 'string' && normalize(step.content).includes(prompt))
}

function toolString(value) {
  if (typeof value !== 'string') return ''
  try {
    const decoded = JSON.parse(value)
    return typeof decoded === 'string' ? decoded : ''
  } catch { return value }
}

function visibleArchive(child, parent, steps, prompt) {
  const entries = []
  let lastReply = -1, lastTool = -1, model
  steps.sort((a, b) => a.step_index - b.step_index)
  for (const [position, step] of steps.entries()) {
    const id = 'agy-' + child.id + ':' + step.step_index
    if (step.type === 'USER_INPUT' && step.source === 'USER' && typeof step.content === 'string' &&
        normalize(step.content) !== prompt) {
      entries.push({ id, role: 'user', text: step.content })
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
      entries.push({ id: id + ':' + index, role: 'activity', text: toolLabels.get(call.name) || '调用工具' })
      // The native transcript places the tool result immediately after its planner batch.
      // A report is visible only when this child delivered it to this exact parent.
      const result = steps[position + 1 + index]
      if (call.name !== 'send_message' || step.status !== 'DONE' ||
          toolString(call.args?.Recipient) !== parent || result?.type !== 'GENERIC' ||
          result.status !== 'DONE' || result.step_index !== step.step_index + 1 + index ||
          typeof result.content !== 'string' ||
          result.content.trimEnd().split('\n').at(-1) !== `Message sent to "${parent}".`) continue
      const report = toolString(call.args?.Message).trim()
      if (report) {
        entries.push({ id: id + ':report:' + index, role: 'assistant', text: report })
        lastReply = Math.max(lastReply, result.step_index)
      }
    }
  }
  const status = child.killed ? 'interrupted' :
    isRunning(child) ? 'running' :
    child.status === 'CASCADE_RUN_STATUS_IDLE' && lastReply > lastTool ? 'completed' : 'unconfirmed'
  return { entries, nativeThreadId: child.id, status, model }
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
      const { steps, revision } = await childLog(directory, child.id)
      const known = dispatches.filter(item => item.nativeThreadId === child.id)
      const candidates = known.length ? known :
        dispatches.filter((item, index) => !item.nativeThreadId && sawPrompt(steps, prompts[index]))
      if (candidates.length !== 1) continue
      const { agentId, prompt, taskId } = candidates[0]
      matches.push({ taskId, agentId, revision, ...visibleArchive(child, parent, steps, normalize(prompt)) })
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
  signal, existingChildren, drainEvents, parentActivity, publish,
}) {
  const outstanding = () => dispatches.filter(dispatch => dispatch.status !== 'errored')
  let lastProgress = performance.now(), idleSince = lastProgress
  let missingSince, lastArchive, lastParentActivity
  for (;;) {
    signal?.throwIfAborted()
    await drainEvents()
    const expected = outstanding()
    if (!expected.length) return
    const { children, parentRunning } = await readAntigravityRun(home, parent, expected, existingChildren)
    await drainEvents()
    const now = performance.now()
    const current = outstanding()
    if (current.length !== expected.length || expected.some((item, index) => current[index] !== item)) {
      idleSince = lastProgress = now
      missingSince = undefined
      continue
    }
    // The summary row may stay IDLE throughout a background turn. Only a
    // native reply or interruption can settle a matched child before the deadline.
    const working = parentRunning ||
      children.some(child => child.status === 'running' || child.status === 'unconfirmed')
    // The native writer saves search results that do not create visible chat entries.
    const archive = JSON.stringify(children.map(child => [child.nativeThreadId, child.status, child.revision]).sort())
    const activity = parentActivity()
    const progressed = archive !== lastArchive || activity !== lastParentActivity
    if (progressed) lastProgress = now
    if (working || progressed) idleSince = now
    lastArchive = archive
    lastParentActivity = activity
    missingSince = children.length === expected.length ? undefined : missingSince ?? now
    // A new child can take time to appear on disk. After a child reports, the
    // native parent can briefly look idle before it starts its background reply.
    const waitingForRegistration = missingSince !== undefined && now - missingSince < registrationTimeout
    const idle = !working && now - idleSince >= idleGrace && !waitingForRegistration
    const timedOut = now - lastProgress >= progressTimeout
    await publish(children, idle || timedOut)
    if (idle || timedOut) {
      const completed = children.filter(child => child.status === 'completed').length
      if (timedOut) throw new Error(`Antigravity 子智能体及主会话连续 10 分钟没有新进展（已收到 ${completed}/${expected.length} 份报告）。`)
      if (completed !== expected.length)
        throw new Error(`Antigravity 已收到 ${completed}/${expected.length} 份报告，可在原会话继续处理缺失的任务。`)
      return
    }
    await delay(1200, undefined, { signal })
  }
}
