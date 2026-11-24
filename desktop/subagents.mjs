import { redact } from './native.mjs'

const entryLimit = 200
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

export function saveAgentEntries(db, taskId, { agent, entries }) {
  if (!validId(agent?.id, 160) || !Array.isArray(entries)) return
  const agentId = redact(agent.id)
  const known = db.get(`SELECT 1 FROM tasks t, json_each(t.events) event
    WHERE t.id=? AND json_extract(event.value,'$.agent.id')=? LIMIT 1`, taskId, agentId)
  if (!known) return
  const upsert = db.db.prepare(`INSERT INTO subagent_entries(taskId,agentId,entryId,role,text)
    VALUES(?,?,?,?,?) ON CONFLICT(taskId,agentId,entryId) DO UPDATE
    SET role=excluded.role,text=excluded.text
    WHERE subagent_entries.role IS NOT excluded.role OR subagent_entries.text IS NOT excluded.text`)
  return db.transaction(() => {
    let changed = false
    for (const entry of entries.slice(-entryLimit)) {
      if (!validId(entry?.id, 260) || !roles.has(entry.role) || typeof entry.text !== 'string' || !entry.text.trim()) continue
      changed = Boolean(upsert.run(taskId, agentId, redact(entry.id), entry.role,
        redact(entry.text).slice(0, 20000)).changes) || changed
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
  SELECT e.entryId AS id,e.role,e.text FROM recent JOIN subagent_entries e ON e.rowid=recent.entryRow
  ORDER BY recent.firstSeen`, chatId, botId, agentId, entryLimit).map(entry => ({ ...entry }))
}
