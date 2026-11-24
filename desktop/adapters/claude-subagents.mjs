import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { redact } from '../native.mjs'
import { agentActivity } from './chat-activity.mjs'

const nativeId = /^[a-z\d_-]{1,128}$/i
const transcriptLimit = 4 * 1024 * 1024
const terminalStatus = new Map([['completed', 'completed'], ['failed', 'errored'], ['stopped', 'interrupted']])

function projectKey(cwd) {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  if (slug.length <= 200) return slug
  let hash = 0
  for (let i = 0; i < cwd.length; i++) hash = (Math.imul(hash, 31) + cwd.charCodeAt(i)) | 0
  return slug.slice(0, 200) + '-' + Math.abs(hash).toString(36)
}

async function readTranscript(directory, session, agent) {
  const file = path.join(directory, 'agent-' + agent + '.jsonl')
  let handle
  try {
    if (await realpath(file) !== file) return []
    const expected = await lstat(file)
    if (!expected.isFile() || expected.size > transcriptLimit) return []
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino ||
        opened.nlink !== 1 || opened.size > transcriptLimit) return []
    const data = Buffer.alloc(opened.size)
    const { bytesRead } = await handle.read(data, 0, data.length, 0)
    return data.toString('utf8', 0, bytesRead).split('\n').flatMap(line => {
      try {
        const row = JSON.parse(line)
        return row?.isSidechain === true && row.sessionId === session && row.agentId === agent ? [row] : []
      } catch { return [] }
    })
  } catch { return [] }
  finally { await handle?.close().catch(() => {}) }
}

function visibleText(content) {
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text).join('\n\n')
    : ''
  return redact(text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ''))
    .trim().slice(0, 20_000)
}

function visibleEntry(frame) {
  if (!['assistant', 'user'].includes(frame.type) || frame.message?.role !== frame.type ||
      frame.error || frame.isMeta || frame.isSynthetic || frame.isReplay || frame.origin ||
      typeof frame.uuid !== 'string' || !nativeId.test(frame.uuid)) return null
  const text = visibleText(frame.message.content)
  return text ? { id: frame.uuid, role: frame.type, text } : null
}

export function claudeSubagents({ source, cwd, session, emit }) {
  const calls = new Map(), tasks = new Map()
  let directory

  async function noteCall(block) {
    if (block?.type !== 'tool_use' || !['Agent', 'Task'].includes(block.name) ||
        typeof block.id !== 'string' || !nativeId.test(block.id)) return false
    if (!calls.has(block.id)) {
      const agent = {
        callId: block.id, name: block.input?.description || block.input?.subagent_type,
        background: block.input?.run_in_background === true,
        prompt: visibleText(block.input?.prompt),
        model: block.input?.model, effort: block.input?.effort, rows: new Map(),
      }
      calls.set(block.id, agent)
      await status(agent, 'running')
    }
    return true
  }

  async function status(agent, next) {
    const value = agentActivity(agent.id || agent.callId || agent.taskId, next, agent.name)
    if (!value) return
    agent.id = value.agent.id
    for (const key of ['model', 'effort']) {
      if (typeof agent[key] === 'string' && /^[\w.\[\]-]{1,80}$/.test(agent[key]))
        value.agent[key] = agent[key]
    }
    const previous = agent.status
    agent.status = JSON.stringify(value.agent)
    if (previous !== agent.status) await emit(value)
  }

  function bind(taskId, callId, name) {
    if (typeof taskId !== 'string' || !nativeId.test(taskId)) return
    const call = calls.get(callId)
    const agent = call || tasks.get(taskId) || { rows: new Map() }
    if (agent.taskId && agent.taskId !== taskId) return
    agent.taskId = taskId
    agent.name ||= name
    tasks.set(taskId, agent)
    if (typeof callId === 'string' && nativeId.test(callId)) {
      agent.callId ||= callId
      calls.set(callId, agent)
    }
    return agent
  }

  async function publish(agent, entries) {
    const changed = []
    for (let entry of entries) {
      if (!entry) continue
      if (agent.dispatchId && entry.role === 'user' && entry.id !== agent.dispatchId) {
        if (!agent.nativePromptId && entry.text === agent.prompt) agent.nativePromptId = entry.id
        if (entry.id === agent.nativePromptId) entry = { ...entry, id: agent.dispatchId }
      }
      if (agent.rows.get(entry.id) === entry.text) continue
      agent.rows.set(entry.id, entry.text)
      if (entry.role === 'assistant') agent.hasReply = true
      changed.push(entry)
    }
    if (!changed.length) return
    if (!agent.id) await status(agent, 'running')
    if (agent.id) await emit({ type: 'agentTranscript', agent: { id: agent.id }, entries: changed })
  }

  async function dispatchPrompt(agent, prompt) {
    // Some CLIs forward background replies without the initial user frame.
    // Use the prompt only when the native launch confirms this exact call's input.
    if (agent.dispatchId || !agent.callId || !agent.prompt || visibleText(prompt) !== agent.prompt) return
    agent.dispatchId = 'dispatch:' + agent.callId
    await publish(agent, [{ id: agent.dispatchId, role: 'user', text: agent.prompt }])
  }

  async function saved(agent) {
    if (!agent.taskId || agent.forwardedReply) return
    directory ||= Promise.all([realpath(source), realpath(cwd)])
      .then(([profile, project]) => path.join(profile, 'projects', projectKey(project), session, 'subagents'))
      .catch(() => null)
    const folder = await directory
    if (folder) {
      const entries = (await readTranscript(folder, session, agent.taskId)).map(visibleEntry).filter(Boolean)
      await publish(agent, entries.slice(-200))
    }
  }

  async function finish(agent, next) {
    if (!agent.id) await status(agent, 'running')
    await saved(agent)
    agent.terminal = next
    await status(agent, next)
  }

  async function handle(frame) {
    if (frame.session_id !== session) return
    if (frame.type === 'system' && !frame.ambient) {
      if (frame.subtype === 'task_started' && frame.task_type === 'local_agent') {
        const agent = bind(frame.task_id, frame.tool_use_id, frame.description || frame.subagent_type)
        if (agent) {
          if (agent.terminal) {
            agent.hasReply = agent.forwardedReply = false
            agent.finalResult = null
          }
          agent.terminal = undefined
          if (frame.is_backgrounded === true) agent.background = true
          await status(agent, 'running')
          if (agent.background) await dispatchPrompt(agent, frame.prompt)
        }
      } else if (frame.subtype === 'task_updated' && frame.patch?.is_backgrounded === true) {
        const agent = tasks.get(frame.task_id)
        if (agent) agent.background = true
      } else if (frame.subtype === 'task_notification' && terminalStatus.has(frame.status)) {
        const agent = tasks.get(frame.task_id) || calls.get(frame.tool_use_id)
        if (agent) await finish(agent, terminalStatus.get(frame.status))
      }
    }

    const parent = frame.parent_tool_use_id
    const agent = parent && (calls.get(parent) || tasks.get(frame.agent_id))
    if (agent && ['assistant', 'user'].includes(frame.type)) {
      const entry = visibleEntry(frame)
      if (entry?.role === 'assistant') agent.forwardedReply = true
      await publish(agent, [entry])
      if (frame.type === 'assistant' && !frame.error && Array.isArray(frame.message?.content)) {
        for (const block of frame.message.content) await noteCall(block)
      }
    }

    if (frame.type === 'user' && Array.isArray(frame.message?.content)) {
      const results = frame.message.content.filter(block => block?.type === 'tool_result')
      for (const block of results) {
        const call = calls.get(block.tool_use_id)
        if (!call) continue
        const result = frame.tool_use_result
        const matches = typeof result?.agentId === 'string' && nativeId.test(result.agentId) &&
          (call.taskId ? result.agentId === call.taskId : results.length === 1)
        if (matches && !call.taskId) bind(result.agentId, block.tool_use_id)
        if (matches && result.status === 'async_launched') {
          call.background = true
          await dispatchPrompt(call, result.prompt)
          continue
        }
        const typedResult = matches && result.status === 'completed'
        if (typedResult && typeof result.resolvedModel === 'string') call.model = result.resolvedModel
        if (call.background && !block.is_error && !typedResult) continue
        await finish(call, call.terminal || (block.is_error ? 'errored' : 'completed'))
        if (typedResult) {
          const text = visibleText(result.content)
          if (text) call.finalResult = { id: 'result:' + block.tool_use_id, role: 'assistant', text }
        }
      }
    }
  }

  async function settle(interrupted) {
    for (const agent of new Set([...calls.values(), ...tasks.values()])) {
      await saved(agent)
      if (!agent.hasReply && agent.finalResult) await publish(agent, [agent.finalResult])
      if (interrupted && !agent.terminal) await status(agent, 'interrupted')
    }
  }

  return {
    handle, noteCall, settle,
    hasAgents: () => calls.size > 0 || tasks.size > 0,
    hasBackground: () => [...tasks.values()].some(agent => agent.background && !agent.terminal),
  }
}
