const dayMs = 86_400_000

function streaks(dates, today) {
  // Convert calendar dates, not elapsed local time, to handle DST transitions.
  const todayIndex = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) / dayMs
  let previous = -Infinity, current = 0, longest = 0
  for (const date of [...dates].sort()) {
    const index = Date.parse(date + 'T00:00:00Z') / dayMs
    if (index > todayIndex) continue
    current = index === previous + 1 ? current + 1 : 1
    longest = Math.max(longest, current)
    previous = index
  }
  return { longestStreak: longest, currentStreak: previous >= todayIndex - 1 ? current : 0 }
}

export function profileStats(db, today = new Date()) {
  // Older workspaces retained an exact session total but only the last turn's
  // breakdown. Keep the undated remainder out of the calendar and daily peak.
  const { totalTokens } = db.get(`SELECT coalesce(sum(
    priorInputTokens + inputTokens + priorOutputTokens + outputTokens),0) AS totalTokens FROM token_metrics`)
  const tasks = db.db.prepare(`SELECT status,startedAt,completedAt,totalTokens,runSettings,
    date(coalesce(startedAt,createdAt),'localtime') AS date FROM tasks
    WHERE inherited=0 AND (startedAt IS NOT NULL OR status IN ('done','failed'))
    ORDER BY rowid`)
  const activeDays = new Set(), tokensByDay = new Map(), efforts = new Map()
  const plugins = new Map(), skills = new Set()
  let runCount = 0, longestTaskMs = 0, skillUses = 0, datedTokens = 0, peakTokens = 0
  for (const task of tasks.iterate()) {
    runCount += 1
    if (task.date) {
      activeDays.add(task.date)
      if (task.totalTokens > 0) {
        const tokens = (tokensByDay.get(task.date) || 0) + task.totalTokens
        tokensByDay.set(task.date, tokens)
        datedTokens += task.totalTokens
        peakTokens = Math.max(peakTokens, tokens)
      }
    }
    const duration = Date.parse(task.completedAt) - Date.parse(task.startedAt)
    if (duration > longestTaskMs) longestTaskMs = duration

    const settings = JSON.parse(task.runSettings) || {}
    if (typeof settings.effort === 'string' && settings.effort)
      efforts.set(settings.effort, (efforts.get(settings.effort) || 0) + 1)
    // The adapter validates the selected extensions during execution. A failed
    // run may have requested an extension that was no longer available.
    if (task.status !== 'done' || !Array.isArray(settings.extensionIds)) continue
    for (const [index, id] of settings.extensionIds.entries()) {
      if (typeof id !== 'string') continue
      if (id.startsWith('skill:') || id.startsWith('claude:/')) {
        skills.add(id)
        skillUses += 1
      } else if (id.startsWith('plugin:') || id.startsWith('app:')) {
        const label = settings.extensionLabels?.[index]
        if (typeof label === 'string' && label.trim())
          plugins.set(id, { id, label, count: (plugins.get(id)?.count || 0) + 1 })
      }
    }
  }
  const [top] = [...efforts].sort((a, b) => b[1] - a[1])
  return {
    totalTokens, peakTokens, longestTaskMs, ...streaks(activeDays, today), runCount,
    dailyTokens: [...tokensByDay].sort(([a], [b]) => a.localeCompare(b)).map(([date, tokens]) => ({ date, tokens })),
    undatedTokens: Math.max(0, totalTokens - datedTokens),
    topPlugins: [...plugins.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, 3),
    topEffort: top ? { id: top[0], count: top[1], percent: Math.round(100 * top[1] / runCount) } : null,
    uniqueSkills: skills.size, skillUses,
  }
}
