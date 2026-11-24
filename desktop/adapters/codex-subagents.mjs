import { redact } from '../native.mjs'
import { agentActivity } from './chat-activity.mjs'

const activityLabels = {
  commandExecution: '运行命令',
  fileChange: '修改文件',
  mcpToolCall: '调用 MCP 工具',
  dynamicToolCall: '调用工具',
  webSearch: '搜索网页',
  imageView: '查看图片',
  imageGeneration: '生成图片',
}
const turnStates = { inProgress: 'running', completed: 'completed', interrupted: 'interrupted', failed: 'errored' }
const activityStates = { started: 'running', interrupted: 'interrupted', completed: 'completed' }
const terminalStates = new Set(['interrupted', 'completed', 'errored', 'shutdown'])
const restartTools = new Set(['followupTask', 'sendInput', 'resumeAgent'])
const nativeId = (id) => typeof id === 'string' && /^[a-z\d_.-]{1,128}$/i.test(id) && redact(id) === id
const modelLabel = (value) => typeof value === 'string' && /^[a-z\d][a-z\d._-]{0,79}$/i.test(value) && redact(value) === value
  ? value : undefined
const agentLimit = 100
const entryLimit = 200
const textLimit = 20_000
const turnLimit = 25
const readTimeout = 1200

function spawnedBy(thread, id, parent) {
  if (thread?.id !== id) return false
  const sourceParent = thread.source?.subAgent?.thread_spawn?.parent_thread_id
  const parents = [thread.parentThreadId, sourceParent].filter(Boolean)
  return parents.length > 0 && parents.every((id) => id === parent)
}

function visibleItem(item) {
  if (!item) return
  if (item.type === 'userMessage' && Array.isArray(item.content)) {
    return ['user', item.content.flatMap((part) =>
      part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n')]
  }
  if (['agentMessage', 'plan'].includes(item.type) && typeof item.text === 'string') {
    return ['assistant', item.text]
  }
  if (Object.hasOwn(activityLabels, item.type)) return ['activity', activityLabels[item.type]]
}

async function childHistory(rpc, id, parentId) {
  const deadline = performance.now() + readTimeout
  const request = (method, params) => {
    const remaining = Math.floor(deadline - performance.now())
    if (remaining <= 0) throw new Error('Codex 子智能体历史读取超时。')
    return rpc.request(method, { threadId: id, ...params }, remaining)
  }
  const read = (includeTurns) => request('thread/read', { includeTurns })
  const { thread } = await read(false)
  if (!spawnedBy(thread, id, parentId)) return
  try {
    const { data } = await request('thread/turns/list', {
      itemsView: 'full', sortDirection: 'desc', limit: turnLimit,
    })
    if (Array.isArray(data)) return { thread, turns: data.slice(0, turnLimit).reverse() }
  } catch (error) {
    if (error.rpcCode !== -32601) throw error
    const history = (await read(true)).thread
    if (spawnedBy(history, id, parentId) && Array.isArray(history.turns))
      return { thread: history, turns: history.turns.slice(-turnLimit) }
  }
}

export function codexSubagents({ emit, parentId, rpc }) {
  const agents = new Map()
  const metadata = new Map()

  async function status(agent, next, name = agent.name) {
    const event = agentActivity(agent.id, next, name) ||
      agentActivity(agent.id, agent.status || 'pendingInit', name)
    if (!event) return
    next = event.agent.status
    if (agent.model) event.agent.model = agent.model
    if (agent.effort) event.agent.effort = agent.effort
    const description = JSON.stringify(event.agent)
    if (agent.description === description) return
    if (next === 'running' && agent.status !== 'running') {
      agent.recovered = false
      agent.recoveryAttempted = false
    }
    agent.status = next
    agent.name = event.agent.name
    agent.description = description
    await emit(event)
  }

  async function entry(agent, turnId, itemId, role, text, { delta = false, final = false, batch } = {}) {
    if (agent.blocked || !nativeId(turnId) || !nativeId(itemId) || !text) return
    const id = turnId + ':' + itemId
    const previous = agent.entries.get(id)
    if ((delta || batch) && previous?.final) return
    const raw = (delta ? (previous?.raw || '') + text : text).slice(0, textLimit)
    const safe = redact(raw).slice(0, textLimit)
    if (!safe.trim()) return
    if (!previous && agent.entries.size >= entryLimit) agent.entries.delete(agent.entries.keys().next().value)
    agent.entries.set(id, { raw, safe, final: final || previous?.final })
    if (previous?.safe !== safe) {
      const value = { id, role, text: safe }
      if (batch) batch.push(value)
      else await emit({ type: 'agentTranscript', agent: { id: agent.id }, entries: [value] })
    }
  }

  async function item(agent, turnId, data, options) {
    const visible = visibleItem(data)
    if (visible) await entry(agent, turnId, data.id, ...visible, options)
  }

  async function parentItem(data) {
    const spawn = data?.type === 'collabAgentToolCall' && data.tool === 'spawnAgent'
    const activity = data?.type === 'subAgentActivity'
    // Older peers omit senderThreadId. The enclosing item was already
    // checked against the verified parent thread and its active turn.
    if (!activity && (data?.type !== 'collabAgentToolCall' ||
      (data.senderThreadId != null && data.senderThreadId !== parentId))) return
    const receivers = Array.isArray(data.receiverThreadIds) ? data.receiverThreadIds : []
    const states = data.agentsStates && typeof data.agentsStates === 'object' ? data.agentsStates : {}
    const ids = (activity ? [data.agentThreadId] : [...new Set([...receivers, ...Object.keys(states)])])
      .filter((id) => id !== parentId && nativeId(id)).slice(0, agentLimit)
    if (!activity && !spawn && data.status !== 'failed') {
      // Follow-ups may reference a previously opened child without a state map.
      const referenced = ids.filter((id) => receivers.includes(id) && !agents.get(id)?.registered && !metadata.has(id))
      await Promise.all(referenced.map(async (id) => {
        const result = await rpc.request('thread/read', { threadId: id, includeTurns: false }, readTimeout).catch(() => null)
        const thread = result?.thread
        if (spawnedBy(thread, id, parentId) && metadata.size < agentLimit)
          metadata.set(id, thread.agentNickname || thread.agentRole)
      }))
    }
    const finished = []
    const activityStatus = activity && Object.hasOwn(activityStates, data.kind) ? activityStates[data.kind] : null
    for (const id of ids) {
      const registered = Boolean(activityStatus || spawn && receivers.includes(id) || metadata.has(id))
      let agent = agents.get(id)
      if (!agent) {
        if ((!registered && !states[id]?.status) || agents.size >= agentLimit) continue
        agent = { id, registered, entries: new Map() }
        agents.set(id, agent)
      }
      if (agent.blocked) continue
      agent.registered ||= registered
      if (spawn || activity && data.kind === 'started') {
        agent.model = modelLabel(data.model) || agent.model
        agent.effort = modelLabel(data.reasoningEffort) || agent.effort
      }
      if (agent.registered && restartTools.has(data.tool) && data.status !== 'failed' &&
        nativeId(data.id) && agent.followupItemId !== data.id) {
        agent.followupItemId = data.id
        agent.recovered = false
        agent.recoveryAttempted = false
      }
      const next = activity ? activityStatus :
        states[id]?.status || (spawn ? 'pendingInit' : null)
      await status(agent, next === 'pendingInit' && agent.status ? agent.status : next || agent.status || 'pendingInit',
        metadata.get(id) || (activity ? data.agentPath : undefined) || agent.name)
      if (terminalStates.has(agent.status) && !agent.recoveryAttempted) {
        agent.recoveryAttempted = true
        finished.push(agent)
      }
    }
    await recover(finished)
  }

  async function childEvent(method, params) {
    if (method === 'thread/started') {
      const { thread } = params
      const id = thread?.id
      if (id === parentId || !nativeId(id)) return
      const agent = agents.get(id)
      if (!spawnedBy(thread, id, parentId)) {
        if (agent && (thread.parentThreadId || thread.source?.subAgent?.thread_spawn?.parent_thread_id)) agent.blocked = true
        return
      }
      const name = thread.agentNickname || thread.agentRole
      if (metadata.size < agentLimit) metadata.set(id, name)
      if (agent) {
        agent.registered = true
        await status(agent, agent.status === 'pendingInit' ? 'running' : agent.status || 'running', name)
      }
      return
    }
    const agent = agents.get(params.threadId)
    if (!agent?.registered || agent.blocked) return
    if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      await entry(agent, params.turnId, params.itemId, 'assistant', params.delta, { delta: true })
    } else if (method === 'item/started' || method === 'item/completed') {
      await item(agent, params.turnId, params.item, { final: method === 'item/completed' })
    } else if (method === 'turn/started' || method === 'turn/completed') {
      const turn = params.turn
      if (Array.isArray(turn?.items)) {
        for (const value of turn.items) await item(agent, turn.id, value, { final: method === 'turn/completed' })
      }
      const next = method === 'turn/started' ? 'running' : turnStates[turn?.status]
      if (next) await status(agent, next)
    }
  }

  async function recover(children = [...agents.values()]) {
    await Promise.all(children.map(async (agent) => {
      if (agent.blocked || agent.recovered) return
      const result = await childHistory(rpc, agent.id, parentId).catch(() => null)
      if (!result) return
      const { thread, turns } = result
      agent.registered = true
      await status(agent, agent.status || 'pendingInit', agent.name || thread.agentNickname || thread.agentRole)
      const recent = turns.flatMap((turn) => Array.isArray(turn?.items)
        ? turn.items.slice(-entryLimit).map((value) => ({ turn, value })) : []).slice(-entryLimit)
      const batch = []
      for (const { turn, value } of recent) await item(agent, turn.id, value, { final: turn.status !== 'inProgress', batch })
      if (batch.length) await emit({ type: 'agentTranscript', agent: { id: agent.id }, entries: batch })
      const observed = turnStates[turns.at(-1)?.status]
      if (!terminalStates.has(agent.status) && terminalStates.has(observed)) await status(agent, observed)
      agent.recovered = turns.some((turn) => turn?.items?.length) && terminalStates.has(agent.status)
    }))
  }

  return { parentItem, childEvent, recover }
}
