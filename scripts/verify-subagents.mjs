// Run after building. This fixture uses isolated local data and no model requests.
import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../desktop/workspace.mjs'
import { DatabaseSync } from 'node:sqlite'

const root = await realpath(await mkdtemp(join(tmpdir(), 'boteam-agents-ui-')))
const executablePath = process.env.BOTEAM_TEST_EXECUTABLE
const agentName = '核对内容'
const legacyNames = ['后端面经检索员', '前端与 MES 开发检索员']
let app
try {
  const workspace = new Workspace({ root, adapters: {} })
  try {
    workspace.db.run('INSERT INTO accounts(id,provider,identity,info) VALUES(?,?,?,?)',
      'fixture', 'claude', 'isolated', JSON.stringify({ status: 'blocked' }))
    workspace.db.run('INSERT INTO bots(id,accountId,name,cwd) VALUES(?,?,?,?)', 'bot', 'fixture', '多智能体验收', root)
    const chat = await workspace.handle('createChat', { kind: 'direct', members: ['bot'] })
    await workspace.handle('finishOnboarding')
    const now = new Date().toISOString()
    workspace.db.run(`INSERT INTO messages(id,chatId,author,name,text,createdAt,recipients)
      VALUES('prompt',?,'user','我','主聊天请求',?,'["bot"]')`, chat, now)
    workspace.db.run(`INSERT INTO tasks(id,chatId,botId,accountId,messageId,status,tool,createdAt)
      VALUES('task',?,'bot','fixture','prompt','done','fixture',?)`, chat, now)
    workspace.event('task', '子智能体 · 已完成', { agent: { id: 'reader', name: agentName, status: 'completed', model: 'claude-sonnet' } })
    workspace.event('task', '子智能体 · 运行中', { agent: { id: 'worker', name: '正在整理', status: 'running' } })
    workspace.db.run(`INSERT INTO subagent_entries(taskId,agentId,entryId,role,text)
      VALUES('task','reader','reply','assistant','**子任务已核对**。')`)
    workspace.db.run(`INSERT INTO messages(id,chatId,author,name,text,createdAt,recipients,taskId)
      VALUES('primary-reply',?,'bot','验收 Bot',?,?,'[]','task')`, chat,
      '1. **前端与 MES 开发检索员**：整理前端资料。\n2. **后端面经检索员**：整理后端资料。', now)
    for (const [id, prompt] of [['agy:fixture:server', '检索后端开发岗位笔试题。'], ['agy:fixture:web', '检索前端开发及 MES 面经。']]) {
      workspace.event('task', '子智能体 · 已派发', { agent: { id, name: 'self', status: 'dispatched' } })
      workspace.db.run(`INSERT INTO subagent_entries(taskId,agentId,entryId,role,text)
        VALUES('task',?,'dispatch-prompt','user',?)`, id, prompt)
    }
    const { events } = workspace.db.get("SELECT events FROM tasks WHERE id='task'")
    const fixedRecency = JSON.parse(events).map((event, index) => ({ ...event, observedAt: [10, 70, 40, 50][index] }))
    workspace.db.run("UPDATE tasks SET events=? WHERE id='task'", JSON.stringify(fixedRecency))
  } finally {
    await workspace.close()
  }
  app = await electron.launch({
    ...(executablePath && { executablePath }),
    args: [...(executablePath ? [] : ['.']), '--user-data-dir=' + root],
  })
  expect(await realpath(await app.evaluate(({ app }) => app.getPath('userData')))).toBe(root)
  const page = await app.firstWindow()
  const window = await app.browserWindow(page)
  await window.evaluate(win => {
    win.webContents.setBackgroundThrottling(false)
    win.setIgnoreMouseEvents(true)
    win.hide()
  })
  await window.dispose()
  page.setDefaultTimeout(6000)
  await page.getByTitle('多智能体验收', { exact: true }).click()
  const main = page.getByRole('log', { name: '消息记录' })
  await expect(main).toContainText('主聊天请求')
  await page.getByRole('button', { name: '聊天概览', exact: true }).click()
  const overview = page.getByRole('dialog', { name: '聊天概览' })
  const glyph = element => element.locator('.subagent-glyph')
  const summary = overview.getByRole('button', { name: /3 个子智能体.*1 个已完成/ })
  await summary.click()
  const variants = await glyph(summary).evaluateAll(elements => elements.map(element => element.dataset.variant))
  expect(variants).toEqual(['15', '4', '1'])
  const icon = glyph(summary).first().locator('img')
  const iconSource = () => icon.evaluate(element => element.complete && element.naturalWidth ? element.currentSrc : '')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect.poll(iconSource).not.toBe('')
  const lightSource = await iconSource()
  await expect(icon).toHaveAttribute('width', '16')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(iconSource).not.toBe(lightSource)
  await expect.poll(iconSource).not.toBe('')
  await page.emulateMedia({ colorScheme: 'light' })
  const legacyRows = legacyNames.map(name => overview.getByRole('button', { name: new RegExp(name) }))
  const legacyVariants = []
  for (const row of legacyRows) {
    await expect(row).toBeVisible()
    legacyVariants.push(await glyph(row).getAttribute('data-variant'))
  }
  await expect(overview.getByRole('button', { name: /\bself\b/i })).toHaveCount(0)
  if (process.env.BOTEAM_AGENT_SCREENSHOT) await page.screenshot({ path: process.env.BOTEAM_AGENT_SCREENSHOT })
  const previewRow = overview.getByRole('button', { name: new RegExp(agentName) })
  const previewVariant = await glyph(previewRow).getAttribute('data-variant')
  await previewRow.click()
  const panel = page.getByRole('tabpanel', { name: '子智能体', exact: true })
  await expect(panel).toContainText('子任务已核对')
  await expect(panel).toContainText('claude-sonnet')
  await expect(glyph(panel)).toHaveAttribute('data-variant', previewVariant)
  await expect(glyph(panel).locator('img')).toHaveAttribute('width', '24')
  await expect(main).not.toContainText('子任务已核对')
  const db = new DatabaseSync(join(root, 'workspace.sqlite3'))
  try {
    db.prepare("UPDATE subagent_entries SET text='子任务实时更新' WHERE taskId='task' AND agentId='reader'").run()
  } finally { db.close() }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('workspace:changed'))
  await expect(panel).toContainText('子任务实时更新')
  await panel.getByRole('button', { name: '返回子智能体列表' }).click()
  await expect(panel.getByRole('button', { name: /正在整理/ })).toBeVisible()
  await expect(panel.getByRole('button', { name: new RegExp(agentName) })).toBeVisible()
  for (const [index, name] of legacyNames.entries())
    await expect(glyph(panel.getByRole('button', { name: new RegExp(name) }))).toHaveAttribute('data-variant', legacyVariants[index])
  await panel.getByRole('button', { name: new RegExp(legacyNames[0]) }).click()
  await expect(glyph(panel)).toHaveAttribute('data-variant', legacyVariants[0])
  await expect(panel).toContainText('检索后端开发岗位笔试题。')
  await panel.getByRole('button', { name: '返回子智能体列表' }).click()
  await panel.getByRole('button', { name: /正在整理/ }).click()
  await expect(panel).toContainText('主任务已结束，暂未收到子智能体回复。')
  await expect(panel).toContainText('状态待确认')
  console.log('通过：聊天概览打开子智能体预览、实时更新、返回列表和无输出状态。')
} finally {
  await app?.close().catch(() => {})
  await rm(root, { recursive: true, force: true })
}
