const types = ['completed', 'failed', 'approval', 'schedule']

export function notificationSettings(db) {
  const values = new Map(db.all("SELECT key,value FROM settings WHERE key LIKE 'notification.%'").map(row => [row.key, row.value]))
  return Object.fromEntries(types.map(type => [type, values.get('notification.' + type) === 'on']))
}

export function setNotificationSetting(db, { type, enabled }) {
  if (!types.includes(type) || typeof enabled !== 'boolean') throw new Error('通知选项无效。')
  db.run('INSERT OR REPLACE INTO settings VALUES(?,?)', 'notification.' + type, enabled ? 'on' : 'off')
}

export function syncNotificationLanguage(db, language) {
  if (!['en', 'zh-CN'].includes(language)) throw new Error('界面语言无效。')
  db.run(`INSERT INTO settings VALUES('notification.language',?) ON CONFLICT(key)
    DO UPDATE SET value=excluded.value WHERE settings.value IS NOT excluded.value`, language)
}

export function deliverNotification(workspace, type, detail) {
  if (!workspace.showNotification || workspace.closed) return
  if (workspace.db.get('SELECT value FROM settings WHERE key=?', 'notification.' + type)?.value !== 'on') return
  const language = workspace.db.get("SELECT value FROM settings WHERE key='notification.language'")?.value
  // System notifications are best effort. A desktop service failure must never change a task's outcome.
  try { workspace.showNotification({ ...detail, type, language }) } catch {}
}

export function notifyTask(workspace, taskId, status) {
  if (!workspace.showNotification) return
  const row = workspace.db.get(`SELECT t.chatId,b.name AS bot,s.name AS scheduleName
    FROM tasks t JOIN bots b ON b.id=t.botId
    LEFT JOIN schedule_runs r ON r.id=t.messageId
    LEFT JOIN schedules s ON s.id=r.scheduleId WHERE t.id=?`, taskId)
  if (!row) return
  const scheduledResult = row.scheduleName && status !== 'approval'
  deliverNotification(workspace, scheduledResult ? 'schedule' : status,
    { status, chatId: row.chatId, name: scheduledResult ? row.scheduleName : row.bot })
}
