import { redact } from '../native.mjs'

const statuses = {
  pendingInit: '等待启动', running: '运行中', dispatched: '已派发', unconfirmed: '状态待确认', interrupted: '已中断',
  completed: '已完成', errored: '失败', shutdown: '已关闭', notFound: '未找到',
}

export function agentActivity(id, status, name) {
  if (typeof id !== 'string' || !id || !Object.hasOwn(statuses, status)) return null
  const agent = { id: redact(id).slice(0, 160), status }
  if (typeof name === 'string' && name.trim()) agent.name = redact(name.trim()).slice(0, 160)
  return { type: 'tool', value: '子智能体 · ' + statuses[status], agent }
}

export function webActivity(rawUrl, query) {
  let url
  try {
    const address = new URL(rawUrl)
    if (['https:', 'http:'].includes(address.protocol) && !address.username && !address.password) {
      address.hash = ''
      for (const key of [...address.searchParams.keys()]) {
        if (/token|secret|password|credential|signature|api.?key/i.test(key)) address.searchParams.delete(key)
      }
      url = redact(address.href).slice(0, 2048)
    }
  } catch { /* A search can report only its query. */ }
  const title = typeof query === 'string' && query.trim() ? redact(query.trim()).slice(0, 200) : ''
  return { type: 'tool', value: '搜索网页', source: { url, title } }
}

export function codexActivity(item, completed) {
  if (item?.type === 'subAgentActivity') {
    if (!['started', 'interrupted'].includes(item.kind)) return []
    const status = item.kind === 'interrupted' ? 'interrupted' : 'running'
    return [agentActivity(item.agentThreadId, status, item.agentPath)].filter(Boolean)
  }
  if (item?.type === 'collabAgentToolCall') {
    const states = item.agentsStates || {}
    const ids = new Set([...(item.receiverThreadIds || []), ...Object.keys(states)])
    return [...ids].slice(0, 100).map(id => agentActivity(id, states[id]?.status ||
      (item.tool === 'spawnAgent' ? 'pendingInit' : null))).filter(Boolean)
  }
  if (item?.type === 'webSearch' && completed) {
    const urls = [item.action?.url, ...(Array.isArray(item.results) ? item.results.slice(0, 30).map(r => r?.url) : [])]
    const links = [...new Set(urls.filter(Boolean))].map(url => webActivity(url, ''))
    return links.length ? links : [webActivity(null, item.query || item.action?.query)]
  }
  return []
}
