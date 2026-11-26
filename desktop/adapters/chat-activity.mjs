import path from 'node:path'
import { redact } from '../native.mjs'

const statuses = {
  pendingInit: '等待启动', running: '运行中', dispatched: '已派发', unconfirmed: '状态待确认', interrupted: '已中断',
  completed: '已完成', errored: '失败', shutdown: '已关闭', notFound: '未找到',
}

export function safeActivityPath(value) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\x00-\x1f]/.test(value)) return ''
  const cleaned = redact(value.trim()).slice(0, 480)
  if (/\[已隐藏/.test(cleaned)) return ''
  return cleaned
}

export function scrubCommandSecrets(raw) {
  if (typeof raw !== 'string') return ''
  return redact(raw)
    .replace(
      /\b([\w-]*(?:token|secret|password|passphrase|credential|api[_-]?key|auth[_-]?key)[\w-]*)\s*(?:=|:|\s+)\s*(?:"[^"\n]*"|'[^'\n]*'|[^;|&\s]+)/gi,
      '$1=[已隐藏]',
    )
    .replace(/(?:^|\s)(-H|--header)\s+(?:"[^"\n]*"|'[^'\n]*'|\S+)/gi, ' $1 [已隐藏]')
    .replace(/(?:^|\s)(-u|--user)\s+(?:"[^"\n]*"|'[^'\n]*'|\S+)/gi, ' $1 [已隐藏]')
    .replace(/\bBasic\s+[a-z0-9+/=]+/gi, 'Basic [已隐藏]')
    .replace(/(?:https?|ssh):\/\/[^/@\s]+:[^/@\s]+@/gi, '[已隐藏连接凭据]@')
    .replace(/([?&](?:key|api_key|apikey|signature|sig|token|access_token|password|secret)=)[^&#\s"']+/gi, '$1[已隐藏]')
    .replace(
      /\b(?:gh[pousr]_[a-zA-Z0-9_]+|AIza[\w-]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[\w-]+|glpat-[\w-]{16,})/g,
      '[已隐藏]',
    )
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ' ')
}

export function unwrapShellCommand(command) {
  if (typeof command !== 'string') return ''
  const trimmed = command.trim()
  const wrapper = trimmed.match(/^(?:\S*\/)?(?:ba|z|fi|da|k)?sh(?:\.exe)?\s+-(?:l?c|cl)\s+(['"])([\s\S]+)\1$/i)
  if (!wrapper) return trimmed
  const quote = wrapper[1]
  let body = wrapper[2]
  if (quote === "'") body = body.replace(/'\\''/g, "'")
  else body = body.replace(/\\(["\\$`])/g, '$1')
  return body.trim()
}

export function formatCommandPreview(command) {
  const unwrapped = unwrapShellCommand(command)
  if (!unwrapped) return ''
  const scrubbed = scrubCommandSecrets(unwrapped).replace(/\s+/g, ' ').trim()
  return scrubbed.length > 600 ? scrubbed.slice(0, 599).trimEnd() + '…' : scrubbed
}

export function formatCommandOutput(output) {
  if (typeof output !== 'string' || !output.trim()) return ''
  const scrubbed = scrubCommandSecrets(output).replace(/\r\n/g, '\n').trim()
  return scrubbed.length > 3200 ? scrubbed.slice(0, 3200) + '\n…' : scrubbed
}

const readVerbs = new Set(['cat', 'head', 'tail', 'nl', 'sed', 'less', 'more', 'bat', 'wc', 'stat', 'file'])
const searchVerbs = new Set(['rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'find', 'fd', 'mdfind'])
const listVerbs = new Set(['ls', 'tree', 'pwd', 'which', 'type', 'command'])

export function classifyShellCommand(command) {
  const unwrapped = unwrapShellCommand(command)
  if (!unwrapped) return 'exec'
  const segments = unwrapped.split(/\s*(?:&&|\|\||;|\|)\s*/).map(s => s.trim()).filter(Boolean)
  if (!segments.length) return 'exec'
  let hasRead = false
  let hasSearch = false
  let hasList = false
  for (const seg of segments) {
    if (/(?:^|\s)(?:>|>>|tee\b|rm\b|mv\b|cp\b|mkdir\b|touch\b|chmod\b|git\s+(?:add|commit|push|checkout|reset|merge|rebase|apply))/i.test(seg)) {
      return 'exec'
    }
    const first = seg.replace(/^(?:env\s+)?(?:\w+=\S+\s+)*/, '').split(/\s+/)[0] || ''
    const verb = path.basename(first)
    if (verb === 'sed' && /\s-i\b/.test(seg)) return 'exec'
    if (readVerbs.has(verb)) hasRead = true
    else if (searchVerbs.has(verb)) hasSearch = true
    else if (listVerbs.has(verb)) hasList = true
    else return 'exec'
  }
  if (hasRead) return 'read'
  if (hasSearch) return 'search'
  if (hasList) return 'list'
  return 'exec'
}

export function commandActivity({ callId, command, status = 'completed', exitCode, output }) {
  const preview = formatCommandPreview(command)
  const commandKind = classifyShellCommand(command)
  const safeOutput = formatCommandOutput(output)
  return {
    type: 'tool',
    kind: 'command',
    commandKind,
    ...(typeof callId === 'string' && callId && { callId: redact(callId).slice(0, 160) }),
    status,
    command: preview || '原生命令',
    ...(Number.isInteger(exitCode) && { exitCode }),
    ...(safeOutput && { output: safeOutput }),
    value: '执行命令 · ' + (preview || '原生命令'),
  }
}

function diffLineCounts(diff) {
  if (typeof diff !== 'string' || !diff) return {}
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  return added || removed ? { added, removed } : {}
}

export function fileActivity({ callId, action = 'edit', status = 'completed', path: targetPath, line, query, files }) {
  const safePath = safeActivityPath(targetPath)
  const normalizedFiles = Array.isArray(files)
    ? files.slice(0, 24).map(entry => {
        const p = safeActivityPath(typeof entry === 'string' ? entry : entry?.path)
        if (!p) return null
        const rawMode = typeof entry === 'object' ? (entry.mode || entry.kind?.type || entry.kind) : undefined
        const mode = rawMode === 'add' || rawMode === 'create' || rawMode === 'new'
          ? 'add'
          : rawMode === 'delete' || rawMode === 'remove'
            ? 'delete'
            : 'update'
        const counts = typeof entry === 'object'
          ? (Number.isInteger(entry.added) || Number.isInteger(entry.removed)
              ? { added: entry.added || 0, removed: entry.removed || 0 }
              : diffLineCounts(entry.diff || entry.patch))
          : {}
        return { path: p, mode, ...counts }
      }).filter(Boolean)
    : safePath && (action === 'edit' || action === 'create')
      ? [{ path: safePath, mode: action === 'create' ? 'add' : 'update' }]
      : []

  const kind = action === 'read'
    ? 'read'
    : action === 'search'
      ? 'search'
      : action === 'list'
        ? 'list'
        : 'fileChange'
  const safeQuery = typeof query === 'string' && query.trim() ? redact(query.trim()).slice(0, 240) : ''
  const primaryPath = safePath || normalizedFiles[0]?.path || ''
  const labelPrefix = kind === 'read'
    ? '读取文件'
    : kind === 'search'
      ? '搜索文件'
      : kind === 'list'
        ? '列出文件'
        : action === 'create' || (normalizedFiles.length === 1 && normalizedFiles[0].mode === 'add')
          ? '创建文件'
          : '修改文件'
  const suffix = normalizedFiles.length > 1
    ? normalizedFiles.map(f => f.path).join('、')
    : primaryPath || safeQuery
  return {
    type: 'tool',
    kind,
    ...(typeof callId === 'string' && callId && { callId: redact(callId).slice(0, 160) }),
    status,
    ...(primaryPath && { path: primaryPath }),
    ...(Number.isInteger(line) && line > 0 && { line }),
    ...(safeQuery && { query: safeQuery }),
    ...(normalizedFiles.length > 0 && { files: normalizedFiles }),
    value: suffix ? `${labelPrefix} · ${suffix}` : labelPrefix,
  }
}

export function toolCallActivity({ callId, kind = 'tool', status = 'completed', label, detail, path: targetPath, line }) {
  const safeLabel = typeof label === 'string' && label.trim() ? redact(label.trim()).slice(0, 200) : '调用工具'
  const safeDetail = typeof detail === 'string' && detail.trim() ? redact(detail.trim()).slice(0, 320) : ''
  const safePath = safeActivityPath(targetPath)
  return {
    type: 'tool',
    kind,
    ...(typeof callId === 'string' && callId && { callId: redact(callId).slice(0, 160) }),
    status,
    label: safeLabel,
    ...(safeDetail && { detail: safeDetail }),
    ...(safePath && { path: safePath }),
    ...(Number.isInteger(line) && line > 0 && { line }),
    value: safeDetail ? `${safeLabel} · ${safeDetail}` : safeLabel,
  }
}

export function agentActivity(id, status, name) {
  if (typeof id !== 'string' || !id || !Object.hasOwn(statuses, status)) return null
  const agent = { id: redact(id).slice(0, 160), status }
  if (typeof name === 'string' && name.trim()) agent.name = redact(name.trim()).slice(0, 160)
  return { type: 'tool', value: '子智能体 · ' + statuses[status], agent }
}

export function webActivity(rawUrl, query, { callId, status = 'completed' } = {}) {
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
  return {
    type: 'tool',
    value: '搜索网页',
    source: { url, title },
    ...(callId !== undefined && {
      kind: 'webSearch',
      callId: redact(String(callId)).slice(0, 160),
      status,
    }),
  }
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
