import { randomUUID } from 'node:crypto'
import { redact } from './native.mjs'
import { draftProjectCwd } from './projects.mjs'

function scheduleRule(input, now) {
  const frequency = input?.frequency
  if (frequency === 'once') {
    if (!Number.isSafeInteger(input.at) || !Number.isFinite(new Date(input.at).getTime()) || input.at <= now)
      throw new Error('请选择未来的运行时间。')
    return { frequency, at: input.at }
  }
  if (frequency === 'hourly') {
    if (!Number.isInteger(input.minute) || input.minute < 0 || input.minute > 59)
      throw new Error('每小时的运行分钟必须在 0 到 59 之间。')
    return { frequency, minute: input.minute }
  }
  if (!['daily', 'weekly', 'monthly', 'yearly'].includes(frequency)) throw new Error('请选择运行频率。')
  if (typeof input.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time))
    throw new Error('请选择有效的运行时间。')
  if (frequency === 'daily') return { frequency, time: input.time }
  if (frequency === 'monthly' || frequency === 'yearly') {
    if (!Number.isInteger(input.day) || input.day < 1 || input.day > 31) throw new Error('请选择有效的运行日期。')
    if (frequency === 'monthly') return { frequency, time: input.time, day: input.day }
    if (!Number.isInteger(input.month) || input.month < 1 || input.month > 12 ||
        input.day > new Date(2000, input.month, 0).getDate()) throw new Error('请选择有效的月份和日期。')
    return { frequency, time: input.time, month: input.month, day: input.day }
  }
  if (!Array.isArray(input.days) || !input.days.length || input.days.some(day => !Number.isInteger(day) || day < 0 || day > 6))
    throw new Error('请至少选择一个每周运行日期。')
  return { frequency, time: input.time, days: [...new Set(input.days)].sort((a, b) => a - b) }
}

// Calendar recurrences use local wall time, so daily and weekly rules survive
// daylight-saving transitions without drifting by an hour.
export function nextOccurrence(rule, after) {
  if (rule.frequency === 'once') return rule.at > after ? rule.at : null
  if (rule.frequency === 'hourly') {
    // Check wall minutes rather than adding an hour across a DST fold or gap.
    let next = after - (after % 60_000) + 60_000
    while (new Date(next).getMinutes() !== rule.minute) next += 60_000
    return next
  }
  const start = new Date(after)
  const [hour, minute] = rule.time.split(':').map(Number)
  if (rule.frequency === 'monthly' || rule.frequency === 'yearly') {
    const annual = rule.frequency === 'yearly'
    // Match the requested day exactly. A monthly 31st skips shorter months;
    // February 29 can be eight years apart across a non-leap century.
    for (let offset = 0; offset <= 8; offset++) {
      const year = start.getFullYear() + (annual ? offset : 0)
      const month = annual ? rule.month - 1 : start.getMonth() + offset
      const next = new Date(year, month, rule.day, hour, minute)
      if (next.getDate() === rule.day && +next > after) return +next
    }
    throw new Error('无法计算下一次运行日期。')
  }
  for (let offset = 0; offset <= 7; offset++) {
    const next = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset, hour, minute)
    if (+next > after && (rule.frequency === 'daily' || rule.days.includes(next.getDay()))) return +next
  }
  throw new Error('无法计算下一次运行时间。')
}

const activeRuns = "('queued','running','approval')"
const jobFromRow = row => ({ ...row, enabled: Boolean(row.enabled), rule: JSON.parse(row.rule) })

export class Schedules {
  constructor(workspace) {
    this.workspace = workspace
    this.db = workspace.db
    this.db.db.exec(`
      CREATE TABLE IF NOT EXISTS schedules(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, botId TEXT NOT NULL, projectId TEXT,
        rule TEXT NOT NULL, enabled INTEGER NOT NULL, nextRunAt INTEGER, revision INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS schedule_runs(
        id TEXT PRIMARY KEY, scheduleId TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        startedAt INTEGER NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, error TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS schedule_run_history ON schedule_runs(scheduleId,startedAt DESC);
      CREATE TRIGGER IF NOT EXISTS schedule_run_progress AFTER UPDATE OF status,error ON tasks
      WHEN NEW.messageId=NEW.chatId BEGIN
        UPDATE schedule_runs SET status=NEW.status,error=NEW.error WHERE id=NEW.messageId;
      END;
      UPDATE schedule_runs SET status='interrupted',error='上次运行因应用关闭而中断。'
        WHERE status IN ${activeRuns};
    `)
    this.syncTimezone(Date.now())
    this.arm()
  }

  syncTimezone(now) {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (this.localZone === zone) return
    const stored = this.db.get("SELECT value FROM settings WHERE key='scheduleLocalZone'")?.value
    if (stored !== zone) {
      this.db.transaction(() => {
        // Keep overdue runs eligible for catch-up. One-time jobs have an
        // absolute timestamp; only future calendar recurrences need rebasing.
        if (stored) for (const row of this.db.all('SELECT id,rule FROM schedules WHERE enabled=1 AND nextRunAt>?', now)) {
          const rule = JSON.parse(row.rule)
          if (rule.frequency !== 'once')
            this.db.run('UPDATE schedules SET nextRunAt=? WHERE id=?', nextOccurrence(rule, now), row.id)
        }
        this.db.run("INSERT OR REPLACE INTO settings VALUES('scheduleLocalZone',?)", zone)
      })
      if (stored) this.workspace.notify()
    }
    this.localZone = zone
  }

  snapshot() {
    return this.db.all('SELECT * FROM schedules ORDER BY rowid DESC').map(row => ({
      ...jobFromRow(row),
      runs: this.db.all(`SELECT r.id,r.startedAt,r.source,r.status,r.error,c.id AS chatId
        FROM schedule_runs r LEFT JOIN chats c ON c.id=r.id WHERE r.scheduleId=?
        ORDER BY r.startedAt DESC,r.rowid DESC LIMIT 20`, row.id),
    }))
  }

  get(id, revision) {
    const row = typeof id === 'string' && this.db.get('SELECT * FROM schedules WHERE id=?', id)
    if (!row) throw new Error('定时任务已删除。')
    if (revision !== undefined && revision !== row.revision) throw new Error('任务已在其他窗口修改，请重新打开。')
    return jobFromRow(row)
  }

  async handle(method, input) {
    if (method === 'schedule:save') return this.save(input)
    const job = this.get(input.id, input.revision)
    switch (method) {
      case 'schedule:run':
        return this.launch(job, 'manual', Date.now())
      case 'schedule:toggle': {
        if (typeof input.enabled !== 'boolean') throw new Error('任务状态无效。')
        if (job.enabled === input.enabled) return
        const due = input.enabled ? nextOccurrence(job.rule, Date.now()) : null
        if (input.enabled && due === null) throw new Error('请编辑任务，选择未来的运行时间。')
        this.db.run('UPDATE schedules SET enabled=?,nextRunAt=?,revision=revision+1 WHERE id=?',
          Number(input.enabled), due, job.id)
        break
      }
      case 'schedule:delete':
        this.db.run('DELETE FROM schedules WHERE id=?', job.id)
        break
      default: throw new Error('未知的定时任务操作。')
    }
    this.changed()
  }

  save(input) {
    const existing = input.id != null ? this.get(input.id, input.revision) : null
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120)
      throw new Error('请输入 1 到 120 字的任务名称。')
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 200_000)
      throw new Error('请输入有效的任务指令。')
    const bot = this.workspace.bot(input.botId)
    const projectId = input.projectId ?? null
    draftProjectCwd(this.db, { projectId })
    const now = Date.now()
    const rule = scheduleRule(input.rule, now)
    const enabled = existing?.enabled ?? true
    const id = existing?.id || randomUUID()
    const next = enabled ? nextOccurrence(rule, now) : null
    this.db.run(`INSERT INTO schedules(id,name,prompt,botId,projectId,rule,enabled,nextRunAt)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,prompt=excluded.prompt,
      botId=excluded.botId,projectId=excluded.projectId,rule=excluded.rule,
      nextRunAt=excluded.nextRunAt,revision=schedules.revision+1`,
      id, redact(input.name.trim()), redact(input.prompt.trim()), bot.id, projectId,
      JSON.stringify(rule), Number(enabled), next)
    this.changed()
    return id
  }

  async launch(job, source, now) {
    const id = randomUUID()
    const claimed = this.db.transaction(() => {
      if (source === 'scheduled') {
        const next = nextOccurrence(job.rule, now)
        const update = this.db.run(`UPDATE schedules SET nextRunAt=?,enabled=?
          WHERE id=? AND enabled=1 AND nextRunAt<=?`, next, Number(next !== null), job.id, now)
        if (!update.changes) return false
      }
      const busy = this.db.get(`SELECT 1 FROM schedule_runs WHERE scheduleId=? AND status IN ${activeRuns} LIMIT 1`, job.id)
      if (busy && source === 'manual') throw new Error('此任务正在运行，可在运行记录中查看。')
      // Sleeping through multiple intervals produces one catch-up run. If the
      // previous run still needs approval, do not queue behind it indefinitely.
      this.db.run('INSERT INTO schedule_runs(id,scheduleId,startedAt,source,status,error) VALUES(?,?,?,?,?,?)',
        id, job.id, now, source, busy ? 'skipped' : 'queued', busy ? '上一次运行尚未结束。' : '')
      return !busy
    })
    if (!claimed) { this.workspace.notify(); return }
    await this.workspace.accountOperation((async () => {
      try {
        await this.workspace.sendDraft({
          draft: { id, kind: 'direct', members: [job.botId], projectId: job.projectId },
          recipients: [job.botId], text: job.prompt,
        })
      } catch (error) {
        this.db.run("UPDATE schedule_runs SET status='failed',error=? WHERE id=?", redact(error.message || '任务启动失败。'), id)
      }
      this.workspace.notify()
    })())
    return id
  }

  async tick(now = Date.now()) {
    if (this.workspace.closed) return
    this.syncTimezone(now)
    const due = this.db.all('SELECT * FROM schedules WHERE enabled=1 AND nextRunAt<=? ORDER BY nextRunAt', now)
    await Promise.all(due.map(row => this.launch(jobFromRow(row), 'scheduled', now)))
  }

  changed() {
    this.arm()
    this.workspace.notify()
  }

  arm(retryDelay = 1) {
    clearTimeout(this.timer)
    if (this.stopped || this.workspace.closed) return
    const due = this.db.get('SELECT min(nextRunAt) AS due FROM schedules WHERE enabled=1').due
    if (due === null) return
    // Recheck the wall clock after sleep or a system clock change.
    this.timer = setTimeout(async () => {
      try { await this.tick(); this.arm() }
      catch (error) {
        console.error('BoTeam scheduler:', redact(error.message || '无法调度任务。'))
        this.arm(5000)
      }
    }, Math.min(60_000, Math.max(retryDelay, due - Date.now())))
    this.timer.unref()
  }

  close() {
    this.stopped = true
    clearTimeout(this.timer)
  }
}
