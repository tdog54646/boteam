// An isolated desktop acceptance run. Model turns require the explicit --live-codex switch.
import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { randomBytes } from 'node:crypto'

const live = process.argv.includes('--live-codex')
const executable = process.env.BOTEAM_TEST_EXECUTABLE
const userData = await mkdtemp(join(tmpdir(), 'boteam-desktop-'))
let app
const botName = '验收工作号'
async function launch() {
  app = await electron.launch({
    ...(executable ? { executablePath: resolve(executable) } : {}),
    args: [...(executable ? [] : ['.']), '--user-data-dir=' + userData],
  })
  const isolated = await app.evaluate(({ app }) => app.getPath('userData'))
  if ((await realpath(isolated)) !== (await realpath(userData)))
    throw new Error('未使用独立的验收目录。')
  const page = await app.firstWindow()
  page.setDefaultTimeout(25_000)
  return page
}
async function selectNativeSettings(page) {
  const catalog = await page.evaluate(async () => {
    const { accounts } = await window.boteam.invoke('snapshot')
    const account = accounts.find(a => a.provider === 'codex' && a.status === 'ready')
    return window.boteam.invoke('botOptions', { accountId: account.id })
  })
  const requested = (name) => process.argv.find(arg => arg.startsWith('--' + name + '='))?.split('=')[1]
  const model = requested('model')
    ? catalog.models.find(m => m.id === requested('model'))
    : catalog.models.find(m => m.efforts?.length > 1)
  expect(model, '原生目录缺少要验收的模型').toBeTruthy()
  const efforts = model.efforts.map(e => e.id)
  const target = requested('effort') || (efforts.includes('low') ? 'low' : efforts[0])
  expect(efforts).toContain(target)
  const form = page.getByRole('group', {name: '模型与思考强度'})
  const trigger = form.getByRole('button', {name:'选择模型', exact:true})
  await expect(trigger).toBeEnabled({timeout:80_000})
  await trigger.click()
  const choices = form.getByRole('menu', {name:'模型'}).getByRole('menuitemradio')
  await expect(choices.first()).toBeVisible({timeout:80_000})
  const normal = value => value.toLowerCase().replace(/[-\s]+/g, '')
  const labels = await choices.allTextContents()
  const index = labels.findIndex(label => normal(label.trim()) === normal(model.label))
  expect(index).toBeGreaterThanOrEqual(0)
  await choices.nth(index).click()
  const slider = form.getByRole('slider', {name:'思考强度'})
  await expect(slider).toBeEnabled()
  await slider.press('End')
  await slider.press('Home')
  for (let i=0;i<efforts.indexOf(target);i++) await slider.press('ArrowRight')
  return {model:model.id, effort:target}
}
async function savedBot(page) {
  await expect(page.getByRole('textbox', { name: '消息内容' })).toBeVisible()
  return page.evaluate(async (name) => {
    const { bots } = await window.boteam.invoke('snapshot')
    const bot = bots.find((entry) => entry.name === name)
    return bot && { id: bot.id, model: bot.model, effort: bot.effort }
  }, botName)
}
async function send(page, text, settings) {
  const previous = await page.evaluate(
    async () => (await window.boteam.invoke('snapshot')).tasks.length,
  )
  const composer = page.getByRole('textbox', { name: '消息内容' })
  await composer.fill(text)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect
    .poll(
      () =>
        page.evaluate(async (previous) => {
          const { tasks } = await window.boteam.invoke('snapshot')
          return (
            tasks.length > previous &&
            ['done', 'failed', 'interrupted'].includes(tasks.at(-1).status)
          )
        }, previous),
      { timeout: 150_000, intervals: [150, 400, 750] },
    )
    .toBe(true)
  const outcome = await page.evaluate(async ({ model, effort }) => {
    const { tasks, messages, accounts } = await window.boteam.invoke('snapshot')
    const task = tasks.at(-1)
    return {
      ok: task.status === 'done',
      verified: accounts.some((a) => a.email === task.identity && a.id === task.accountId),
      native: task.tool.endsWith('/codex'),
      settingsConfirmed: task.events.some((event) =>
        event.text.includes(model) && event.text.includes(effort),
      ),
      answer: messages.find((m) => m.taskId === task.id)?.text,
      error: task.error,
    }
  }, settings)
  if (!outcome.ok) throw new Error('验收任务失败：' + outcome.error)
  expect(outcome.verified && outcome.native).toBe(true)
  expect(outcome.settingsConfirmed, '原生任务应确认所选的模型和强度').toBe(true)
  return outcome.answer
}
try {
  let page = await launch()
  await expect(page.getByRole('heading', { name: '导入本机账号' })).toBeVisible()
  if (live) {
    const ready = page
      .locator('.candidate')
      .filter({ hasText: 'Codex' })
      .filter({ hasText: '可运行' })
    await expect(ready.first()).toBeVisible({ timeout: 80_000 })
    const pro = ready.filter({ hasText: /\bpro\b/i })
    const target = (await pro.count()) ? pro.first() : ready.first()
    for (const candidate of await page.locator('.candidate.eligible').all()) {
      if (await candidate.locator('input').isChecked()) await candidate.click()
    }
    await target.click()
    await page.getByRole('button', { name: /导入并继续/ }).click()
    await page.getByPlaceholder('例如，代码助手').fill(botName)
    const settings = await selectNativeSettings(page)
    await page.getByRole('button', { name: '创建并开始聊天' }).click()
    const original = await savedBot(page)
    expect(original).toMatchObject(settings)
    const word = 'BOTEAM-' + randomBytes(4).toString('hex')
    expect(await send(page, '记住本次会话标记 ' + word + '。只回复该标记。', settings)).toContain(word)
    await app.close()
    page = await launch()
    expect(await savedBot(page)).toEqual(original)
    expect(await send(page, '上一条消息让我记住的标记是什么？只回复标记。', settings)).toContain(word)
    console.log(`通过桌面导入、原生选项选择（${settings.model} · ${settings.effort}）、真实 Codex 私聊、运行身份、重启后设置保留及原生续聊。`)
  } else {
    await page.getByRole('button', { name: '暂时跳过' }).click()
    await page.getByRole('button', { name: '账号管理', exact: true }).click()
    await expect(page.getByRole('heading', { name: '账号管理', exact: true })).toBeVisible()
    await app.close()
    page = await launch()
    await expect(page.getByRole('heading', { name: '账号管理', exact: true })).toBeVisible()
    console.log('通过：桌面应用首次启动、跳过向导、账号页和重启恢复。')
  }
} finally {
  await app?.close().catch(() => {})
  await rm(userData, { recursive: true, force: true })
}
