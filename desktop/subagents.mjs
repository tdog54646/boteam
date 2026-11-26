import { redact } from './native.mjs'

const entryLimit = 200
const entryTextLimit = 120_000
const roles = new Set(['user', 'assistant', 'activity'])
const states = new Set(['pendingInit', 'running', 'dispatched', 'unconfirmed', 'interrupted', 'completed', 'errored', 'shutdown', 'notFound'])
const validId = (id, max) => typeof id === 'string' && id.length > 0 && id.length <= max && !id.includes('\0')

export function agentSummary(agent) {
  if (!validId(agent?.id, 160) || !states.has(agent.status)) return undefined
  const summary = { id: redact(agent.id), status: agent.status }
  for (const key of ['name', 'model', 'effort', 'nativeThreadId']) {
    if (typeof agent[key] === 'string' && agent[key].trim())
      summary[key] = redact(agent[key].trim()).slice(0, 160)
  }
  return summary
}

function sanitizeEntryMeta(meta) {
  if (!meta || typeof meta !== 'object') return null
  const out = {}
  for (const [key, max] of [
    ['kind', 40],
    ['category', 32],
    ['status', 32],
    ['command', 800],
    ['commandKind', 24],
    ['output', 2400],
    ['path', 480],
    ['query', 240],
    ['url', 2048],
    ['title', 400],
    ['detail', 320],
  ]) {
    if (typeof meta[key] === 'string' && meta[key].trim()) {
      out[key] = redact(meta[key].trim()).slice(0, max)
    }
  }
  if (Number.isInteger(meta.line) && meta.line > 0) out.line = meta.line
  if (Number.isInteger(meta.exitCode)) out.exitCode = meta.exitCode
  if (Array.isArray(meta.files) && meta.files.length > 0) {
    const files = meta.files
      .slice(0, 24)
      .map((f) => {
        if (!f || typeof f.path !== 'string' || !f.path.trim()) return null
        return {
          path: redact(f.path.trim()).slice(0, 480),
          ...(typeof f.mode === 'string' && { mode: f.mode.slice(0, 16) }),
          ...(Number.isInteger(f.added) && { added: f.added }),
          ...(Number.isInteger(f.removed) && { removed: f.removed }),
        }
      })
      .filter(Boolean)
    if (files.length) out.files = files
  }
  return Object.keys(out).length ? JSON.stringify(out) : null
}

export function saveAgentEntries(db, taskId, { agent, entries }) {
  if (!validId(agent?.id, 160) || !Array.isArray(entries)) return
  const agentId = redact(agent.id)
  const known = db.get(`SELECT 1 FROM tasks t, json_each(t.events) event
    WHERE t.id=? AND json_extract(event.value,'$.agent.id')=? LIMIT 1`, taskId, agentId)
  if (!known) return
  const upsert = db.db.prepare(`INSERT INTO subagent_entries(taskId,agentId,entryId,role,text,meta)
    VALUES(?,?,?,?,?,?) ON CONFLICT(taskId,agentId,entryId) DO UPDATE
    SET role=excluded.role,text=excluded.text,meta=coalesce(excluded.meta,subagent_entries.meta)
    WHERE subagent_entries.role IS NOT excluded.role
       OR subagent_entries.text IS NOT excluded.text
       OR (excluded.meta IS NOT NULL AND subagent_entries.meta IS NOT excluded.meta)`)
  return db.transaction(() => {
    let changed = false
    for (const entry of entries.slice(-entryLimit)) {
      if (!validId(entry?.id, 260) || !roles.has(entry.role) || typeof entry.text !== 'string' || !entry.text.trim()) continue
      const metaJson = entry.role === 'activity' ? sanitizeEntryMeta(entry.meta) : null
      changed = Boolean(upsert.run(taskId, agentId, redact(entry.id), entry.role,
        redact(entry.text).slice(0, entryTextLimit), metaJson).changes) || changed
    }
    db.run(`DELETE FROM subagent_entries WHERE rowid IN (
      SELECT rowid FROM subagent_entries WHERE taskId=? AND agentId=? ORDER BY rowid DESC LIMIT -1 OFFSET ?
    )`, taskId, agentId, entryLimit)
    return changed
  })
}

export function agentEntries(db, { chatId, botId, agentId }) {
  if (!validId(chatId, 160) || !validId(botId, 160) || !validId(agentId, 160))
    throw new Error('子智能体会话标识无效。')
  return db.all(`WITH ranked AS (
    SELECT e.rowid AS entryRow,
      min(e.rowid) OVER(PARTITION BY e.entryId) AS firstSeen,
      row_number() OVER(PARTITION BY e.entryId ORDER BY t.rowid DESC,e.rowid DESC) AS version
    FROM tasks t JOIN subagent_entries e ON e.taskId=t.id
    WHERE t.chatId=? AND t.botId=? AND e.agentId=?
  ), recent AS (
    SELECT entryRow,firstSeen FROM ranked WHERE version=1 ORDER BY firstSeen DESC LIMIT ?
  )
  SELECT e.entryId AS id,e.role,e.text,e.meta FROM recent JOIN subagent_entries e ON e.rowid=recent.entryRow
  ORDER BY recent.firstSeen`, chatId, botId, agentId, entryLimit).map(({ id, role, text, meta }) => {
    let parsedMeta = null
    if (typeof meta === 'string' && meta) {
      try {
        parsedMeta = JSON.parse(meta)
      } catch {}
    }
    return parsedMeta ? { id, role, text, meta: parsedMeta } : { id, role, text }
  })
}
