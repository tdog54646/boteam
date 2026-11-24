// Run after building the renderer. The fixture sends no requests to an AI provider.
import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Workspace } from '../desktop/workspace.mjs'

const root = await realpath(await mkdtemp(join(tmpdir(), 'boteam-message-navigator-')))
const chatName = '导航验收对话'
const shortChatName = '单轮验收对话'
const prompts = ['检查构建步骤', '整理验收结果', '补写发布说明', '确认回退步骤']
const replies = ['构建依赖已核对', '验收数据已汇总', '发布说明已准备', '回退步骤已验证']
const executable = process.env.BOTEAM_TEST_EXECUTABLE
const screenshot = process.env.BOTEAM_NAV_SCREENSHOT
let app

async function seed() {
  const workspace = new Workspace({ root, adapters: {} })
  const now = new Date().toISOString()
  try {
    workspace.db.run('INSERT INTO accounts(id,provider,identity,info) VALUES(?,?,?,?)',
      'fixture', 'claude', 'isolated', JSON.stringify({ status: 'blocked' }))
    workspace.db.run('INSERT INTO bots(id,accountId,name,cwd) VALUES(?,?,?,?)',
      'fixture-bot', 'fixture', '验收助手', root)
    for (const [name, count] of [[chatName, prompts.length], [shortChatName, 1]]) {
      await workspace.handle('createChat', { kind: 'group', name, members: ['fixture-bot'] })
      const { id } = workspace.db.get('SELECT id FROM chats WHERE name=?', name)
      for (let index = 0; index < count; index++) {
        const promptId = `${id}-prompt-${index}`
        const taskId = `${id}-task-${index}`
        workspace.db.run(`INSERT INTO messages(id,chatId,author,name,text,createdAt,recipients,publishSeq)
          VALUES(?,?,'user','我',?,?,'["fixture-bot"]',?)`, promptId, id, prompts[index], now, index * 2 + 1)
        workspace.db.run(`INSERT INTO messages(id,chatId,botId,author,name,text,createdAt,recipients,publishSeq,taskId)
          VALUES(?,?,'fixture-bot','bot','验收助手',?,?,'[]',?,?)`, `${id}-reply-${index}`, id,
        [`**${replies[index]}**`, ...Array.from({ length: 22 }, (_, line) => `检查项 ${line + 1} 已记录。`)].join('\n\n'),
        now, index * 2 + 2, taskId)
        workspace.db.run(`INSERT INTO tasks(id,chatId,botId,accountId,messageId,status,tool,createdAt)
          VALUES(?,?,'fixture-bot','fixture',?,'done','fixture',?)`, taskId, id, promptId, now)
      }
    }
    await workspace.handle('finishOnboarding')
  } finally {
    await workspace.close()
  }
}

try {
  await seed()
  app = await electron.launch({
    ...(executable && { executablePath: resolve(executable) }),
    args: [...(executable ? [] : ['.']), '--user-data-dir=' + root],
  })
  expect(await realpath(await app.evaluate(({ app }) => app.getPath('userData')))).toBe(root)
  const page = await app.firstWindow()
  const testWindow = await app.browserWindow(page)
  try {
    await testWindow.evaluate(window => {
      window.webContents.setBackgroundThrottling(false)
      window.setIgnoreMouseEvents(true)
      window.hide()
    })
  } finally {
    await testWindow.dispose()
  }
  await page.emulateMedia({ colorScheme: 'light' })
  const rendererErrors = []
  page.on('pageerror', error => rendererErrors.push(error.message))
  page.setDefaultTimeout(8_000)
  const resize = width => app.evaluate(({ BrowserWindow }, width) =>
    BrowserWindow.getAllWindows()[0].setContentSize(width, 740), width)
  await resize(1400)
  const openChat = name => page.getByTitle(name, { exact: true }).click()
  const navigation = page.getByRole('navigation', { name: '消息导航', exact: true })
  const marker = index => navigation.getByRole('button', { name: prompts[index] })
  const preview = page.getByRole('tooltip')
  const bubble = index => page.getByLabel('你的消息', { exact: true }).nth(index)
  const article = index => page.getByRole('log', { name: '消息记录' }).locator('.user-message').nth(index)
  const scrollArea = page.locator('.message-scroll')
  const offset = () => scrollArea.evaluate(element => element.scrollTop)
  const readingOffset = index => bubble(index).evaluate(element =>
    element.getBoundingClientRect().top - element.closest('.message-scroll').getBoundingClientRect().top)
  const flashDurations = index => article(index).evaluate(element =>
    element.getAnimations().map(animation => animation.effect.getTiming().duration))
  const scaleTransitionDuration = index => marker(index).locator('.message-nav-tick').evaluate(element =>
    getComputedStyle(element).transitionDuration.split(',')[0])
  const strokes = () => navigation.locator('.message-nav-tick').evaluateAll(elements =>
    elements.map(element => Math.round(element.getBoundingClientRect().width)))

  await openChat(chatName)
  await expect(page.getByRole('log', { name: '消息记录' })).toContainText(replies.at(-1))
  await expect(navigation).toBeVisible()
  await expect(navigation.getByRole('button')).toHaveCount(prompts.length)
  await expect(marker(3)).toHaveAttribute('aria-current', 'location')
  expect(await scaleTransitionDuration(1)).toBe('0.16s')
  expect(await strokes()).toEqual([6, 6, 6, 6])
  const rail = await navigation.evaluate(element => {
    const rect = element.getBoundingClientRect()
    const main = element.closest('.main').getBoundingClientRect()
    const buttons = [...element.querySelectorAll('button')].map(button => button.getBoundingClientRect())
    const tick = element.querySelector('.message-nav-tick').getBoundingClientRect()
    return { left: rect.left - main.left, center: rect.top + rect.height / 2 - main.top - main.height / 2,
      width: rect.width, markerWidth: buttons[0].width, markerHeight: buttons[0].height,
      pitch: buttons[1].top - buttons[0].top, tickLeft: tick.left - buttons[0].left, tickHeight: tick.height }
  })
  expect(rail).toEqual({ left: 8, center: 0, width: 36, markerWidth: 36, markerHeight: 10, pitch: 10, tickLeft: 8, tickHeight: 2 })

  await marker(1).evaluate((button, prompt) => {
    button.addEventListener('pointerenter', () => {
      const start = performance.now()
      const observer = new MutationObserver(() => {
        const tooltip = document.querySelector('[role="tooltip"]')
        if (!tooltip?.checkVisibility() || !tooltip.textContent.includes(prompt)) return
        window.navigatorPreviewDelay = performance.now() - start
        observer.disconnect()
      })
      observer.observe(document.body, { childList: true, subtree: true, attributes: true })
    }, { once: true })
  }, prompts[1])
  await marker(1).hover()
  await expect(preview).toContainText(prompts[1])
  await expect(preview).toContainText(replies[1])
  await expect(preview).not.toContainText(`**${replies[1]}**`)
  expect(await page.evaluate(() => window.navigatorPreviewDelay)).toBeGreaterThanOrEqual(140)
  await expect.poll(strokes).toEqual([20, 26, 20, 14])
  const selectedStroke = marker(1).locator('.message-nav-tick')
  await expect(selectedStroke).toHaveCSS('background-color', 'rgb(26, 28, 31)')
  await expect(selectedStroke).toHaveCSS('opacity', '1')
  const card = await preview.evaluate((element, label) => {
    const rect = element.getBoundingClientRect()
    const main = element.closest('.main').getBoundingClientRect()
    const marker = [...element.closest('nav').querySelectorAll('button')].find(button => button.ariaLabel === label)
    const markerRect = marker.getBoundingClientRect()
    const style = getComputedStyle(element)
    return { left: rect.left - main.left, width: rect.width, height: rect.height,
      centerDelta: rect.top + rect.height / 2 - markerRect.top - markerRect.height / 2,
      background: style.backgroundColor, border: style.borderLeftWidth, radius: style.borderRadius,
      fontSize: style.fontSize, lineHeight: style.lineHeight }
  }, prompts[1])
  expect(card).toMatchObject({ left: 50, width: 320, height: 121.5, background: 'rgb(248, 248, 248)',
    border: '1px', radius: '8px', fontSize: '13px', lineHeight: '19.5px' })
  expect(Math.abs(card.centerDelta)).toBeLessThanOrEqual(1)
  if (screenshot) await page.screenshot({ path: resolve(screenshot) })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(preview).toHaveCSS('background-color', 'rgb(37, 37, 37)')
  await page.emulateMedia({ colorScheme: 'light' })
  await marker(2).hover()
  await expect(preview).toContainText(replies[2])
  await page.mouse.move(700, 120)
  await expect(preview).toBeHidden()

  const bottom = await offset()
  await marker(0).click()
  expect(await flashDurations(0)).toContain(900)
  await expect.poll(offset).toBeLessThan(90)
  await expect(marker(0)).toHaveAttribute('aria-current', 'location')
  expect(bottom).toBeGreaterThan(500)

  await marker(0).focus()
  await page.keyboard.press('ArrowDown')
  await expect(marker(1)).toBeFocused()
  await expect(preview).toContainText(replies[1])
  await page.keyboard.press('End')
  await expect(marker(3)).toBeFocused()
  await page.keyboard.press('Home')
  await expect(marker(0)).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect.poll(() => readingOffset(1)).toBeGreaterThanOrEqual(0)
  await expect.poll(() => readingOffset(1)).toBeLessThan(200)
  await expect(marker(1)).toHaveAttribute('aria-current', 'location')
  await page.keyboard.press('Escape')
  await expect(preview).toBeHidden()

  const from = await marker(1).boundingBox()
  const to = await marker(3).boundingBox()
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 5 })
  await expect(marker(3)).toHaveAttribute('aria-current', 'location')
  await expect(preview).toContainText(replies[3])
  await page.mouse.up()

  const touch = await page.context().newCDPSession(page)
  const finger = async index => {
    const { x, y, width, height } = await marker(index).boundingBox()
    return [{ x: x + width / 2, y: y + height / 2 }]
  }
  try {
    await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: await finger(3) })
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: await finger(1) })
    await expect(marker(1)).toHaveAttribute('aria-current', 'location')
    await expect(preview).toContainText(replies[1])
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect(preview).toBeHidden()
  } finally {
    await touch.send('Emulation.setTouchEmulationEnabled', { enabled: false })
    await touch.detach()
  }

  await scrollArea.evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }))
  await expect(marker(0)).toHaveAttribute('aria-current', 'location')
  await scrollArea.evaluate(element => element.scrollTo({ top: element.scrollHeight, behavior: 'instant' }))
  await expect(marker(3)).toHaveAttribute('aria-current', 'location')

  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await scaleTransitionDuration(1)).toBe('0s')
  await marker(1).click()
  expect(await flashDurations(1)).toEqual([])
  await expect(article(1)).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)', { timeout: 400 })
  await expect(marker(1)).toHaveAttribute('aria-current', 'location')
  await expect.poll(() => readingOffset(1)).toBeLessThan(200)
  await expect(article(1)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')

  await resize(800)
  await expect(navigation).toBeHidden()
  await resize(1400)
  await expect(navigation).toBeVisible()
  await openChat(shortChatName)
  await expect(page.getByRole('log', { name: '消息记录' })).toContainText(replies[0])
  await expect(navigation).toBeHidden()
  expect(rendererErrors).toEqual([])
  console.log('通过：消息导航布局和深浅色、悬停延迟、点击和键盘跳转、鼠标和触摸拖动、滚动同步、减少动态效果和窄窗口显示。')
} finally {
  await app?.close().catch(() => {})
  await rm(root, { recursive: true, force: true })
}
