// An isolated desktop acceptance run. Model turns require the explicit --live-codex switch.
import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Workspace } from '../desktop/workspace.mjs'

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
async function seedChannelHistory() {
  const workspace = new Workspace({ root: userData, adapters: {} })
  const chatId = 'fixture-telegram-chat'
  const title = 'Telegram 验收会话'
  const message = '这条历史消息来自隔离工作区。'
  try {
    workspace.db.transaction(() => {
      workspace.db.run('INSERT INTO accounts(id,provider,identity,info) VALUES(?,?,?,?)',
        'fixture-account', 'claude', 'fixture', JSON.stringify({ status: 'blocked' }))
      workspace.db.run('INSERT INTO bots(id,accountId,name,cwd) VALUES(?,?,?,?)',
        'fixture-bot', 'fixture-account', title, '')
      for (const provider of ['codex', 'antigravity']) {
        workspace.db.run('INSERT INTO accounts(id,provider,identity,info) VALUES(?,?,?,?)',
          provider, provider, 'fixture', JSON.stringify({ status: 'blocked' }))
        workspace.db.run('INSERT INTO bots(id,accountId,name,cwd) VALUES(?,?,?,?)',
          provider, provider, provider, '')
      }
      // Mimic an existing offline binding without starting an IM transport.
      workspace.db.run('INSERT INTO channels(id,botId,enabled,credentials,generation) VALUES(?,?,0,?,?)',
        'telegram', 'antigravity', Buffer.alloc(0), 'fixture-generation')
      workspace.db.run("UPDATE channel_permissions SET mode='workspace-auto' WHERE channel='telegram'")
      workspace.insertChat(chatId, { kind: 'direct', members: ['antigravity'] })
      workspace.db.run('UPDATE chats SET name=? WHERE id=?', title, chatId)
      workspace.db.run('INSERT INTO channel_chats(channel,identity,room,sender,botId,chatId) VALUES(?,?,?,?,?,?)',
        'telegram', 'fixture', 'room', 'sender', 'antigravity', chatId)
      const now = new Date().toISOString()
      workspace.db.run('INSERT INTO messages(id,chatId,author,name,text,createdAt,recipients) VALUES(?,?,?,?,?,?,?)',
        'fixture-message', chatId, 'user', '频道用户', message, now, JSON.stringify(['antigravity']))
      workspace.db.run('INSERT INTO tasks(id,chatId,botId,accountId,messageId,status,tool,createdAt) VALUES(?,?,?,?,?,?,?,?)',
        'old-agy-task', chatId, 'antigravity', 'antigravity', 'fixture-message', 'done', 'agy', now)
      const quote = '\n⚠ FAILED_PRECONDITION (code 400): User location is not supported for the API use.\n'
      workspace.db.run('INSERT INTO messages(id,chatId,botId,author,name,text,createdAt,recipients,taskId) VALUES(?,?,?,?,?,?,?,?,?)',
        'old-agy-reply', chatId, 'antigravity', 'bot', 'Antigravity', quote, now, '[]', 'old-agy-task')
      workspace.db.run('INSERT INTO messages(id,chatId,author,name,text,createdAt,recipients) VALUES(?,?,?,?,?,?,?)',
        'quote-request', chatId, 'user', '频道用户', '请原样引用这条报错。', now, JSON.stringify(['antigravity']))
      workspace.db.run('INSERT INTO tasks(id,chatId,botId,accountId,messageId,status,tool,createdAt) VALUES(?,?,?,?,?,?,?,?)',
        'quote-task', chatId, 'antigravity', 'antigravity', 'quote-request', 'done', 'agy', now)
      workspace.db.run('INSERT INTO messages(id,chatId,botId,author,name,text,createdAt,recipients,taskId,segments) VALUES(?,?,?,?,?,?,?,?,?,?)',
        'quote-reply', chatId, 'antigravity', 'bot', 'Antigravity', quote, now, '[]', 'quote-task',
        JSON.stringify([{ id: 'agy-seg-0', text: quote, phase: 'final_answer' }]))
    })
    return { title, message }
  } finally {
    await workspace.close()
  }
}

async function verifyChannelPermissions(page) {
  const pending = await app.evaluateHandle(({ app, BrowserWindow }) => {
    const load = process.getBuiltinModule('node:module').createRequire(app.getAppPath() + '/package.json')
    const { Workspace } = load('./desktop/workspace.mjs')
    const original = { snapshot: Workspace.prototype.snapshot, composerActions: Workspace.prototype.composerActions }
    const requests = new Set()
    const providers = new Map(['codex', 'antigravity'].map(id => [id, Promise.withResolvers()]))
    // Only render these isolated fixtures as ready. Their stored accounts stay
    // blocked and their native catalogs are resolved entirely in memory.
    Workspace.prototype.snapshot = function () {
      const state = original.snapshot.call(this)
      for (const account of state.accounts) if (providers.has(account.id)) account.status = 'ready'
      return state
    }
    Workspace.prototype.composerActions = function (payload) {
      const gate = providers.get(payload.botId)
      if (!gate) return original.composerActions.call(this, payload)
      requests.add(payload.botId)
      return gate.promise
    }
    const refresh = () => BrowserWindow.getAllWindows().forEach(window => window.webContents.send('workspace:changed'))
    const release = id => providers.get(id).resolve({ workspaceAuto: id === 'antigravity', autoReview: id === 'codex' })
    refresh()
    return {
      requests, release,
      restore() {
        for (const id of providers.keys()) release(id)
        Object.assign(Workspace.prototype, original)
        refresh()
      },
    }
  })
  try { await verifyChannelPermissionChoices(page, pending) }
  finally {
    await pending.evaluate(fixture => fixture.restore())
    await pending.dispose()
  }
}

async function verifyChannelPermissionChoices(page, pending) {
  const manage = page.locator('[data-channel="telegram"]').getByRole('button')
  await manage.click()
  const dialog = page.getByRole('dialog')
  const bot = dialog.getByRole('combobox', { name: '接收消息的 Bot' })
  const permission = dialog.getByRole('combobox', { name: '操作权限' })
  const waitForCatalog = id => expect.poll(() => pending.evaluate((fixture, key) => fixture.requests.has(key), id)).toBe(true)
  await waitForCatalog('antigravity')
  await expect(permission).toHaveValue('workspace-auto')
  await expect(permission.locator('option[value="workspace-auto"]')).toBeEnabled()
  await expect(permission.locator('option[value="auto-review"]')).toHaveCount(0)
  await permission.selectOption('edits')
  const stored = () => page.evaluate(async () =>
    (await window.boteam.invoke('snapshot')).channels.find(c => c.id === 'telegram')?.permission)
  await expect.poll(stored).toBe('edits')
  await expect(dialog.locator('.setup-connection-row strong')).toHaveCSS('font-weight', '400')
  await expect(dialog.getByRole('heading', { name: '访问控制' })).toHaveCSS('font-weight', '400')
  await expect(dialog.locator('.setup-field').first()).toHaveCSS('font-weight', '400')
  for (const [id, mode, excluded] of [
    ['fixture-bot', 'edits', 'full'],
    ['codex', 'read-only', 'edits'],
    ['antigravity', 'edits', 'full'],
  ]) {
    await bot.selectOption(id)
    if (id === 'codex') {
      await waitForCatalog(id)
      await expect(permission.locator('option[value="auto-review"]')).toBeEnabled()
      await expect(permission.locator('option[value="workspace-auto"]')).toHaveCount(0)
      await pending.evaluate(fixture => fixture.release('antigravity'))
    }
    await expect(permission).toBeEnabled()
    await expect(permission.locator(`option[value="${mode}"]`)).toHaveCount(1)
    await expect(permission.locator(`option[value="${excluded}"]`)).toHaveCount(0)
    await permission.selectOption(mode)
    await expect.poll(stored).toBe(mode)
    if (id === 'codex') await pending.evaluate(fixture => fixture.release('codex'))
  }
  await page.keyboard.press('Escape')
  await manage.click()
  await expect(permission).toHaveValue('edits')
  await page.keyboard.press('Escape')
}

async function verifyKeyboardShortcuts(page, nav, main) {
  const destination = nav.getByRole('button', { name: '键盘快捷键', exact: true })
  const activeBackground = await nav.locator('[aria-current="page"]').evaluate(el => getComputedStyle(el).backgroundColor)
  await expect(destination.locator('span')).toHaveCSS('font-weight', '400')
  await destination.click()
  await expect(destination).toHaveAttribute('aria-current', 'page')
  await expect(destination.locator('span')).toHaveCSS('font-weight', '400')
  await expect(destination).toHaveCSS('background-color', activeBackground)
  await expect(destination).toHaveCSS('outline-style', 'none')

  const search = main.getByRole('searchbox', { name: '搜索快捷键' })
  const rows = main.locator('.shortcuts-row')
  const row = rows.filter({ has: page.getByText('搜索聊天', { exact: true }) })
  await search.fill('搜索聊天')
  await expect(rows).toHaveCount(1)
  await expect(row).toBeVisible()
  await search.fill('无匹配的操作')
  await expect(rows).toHaveCount(0)
  await search.fill('')
  await main.getByRole('button', { name: '按组合键搜索' }).click()
  await page.keyboard.press('ControlOrMeta+k')
  await expect(rows).toHaveCount(1)
  await expect(row).toBeVisible()
  await search.fill('')
  await expect(rows).toHaveCount(3)

  const edit = row.getByRole('button', { name: '编辑快捷键 · 搜索聊天' })
  const dialog = page.getByRole('dialog', { name: '搜索对话' })
  const reset = main.getByRole('button', { name: '恢复默认', exact: true })
  await edit.click()
  await page.keyboard.press('ControlOrMeta+Shift+k')
  await expect(row.locator('kbd')).toHaveText(/⇧⌘K|Ctrl\+Shift\+K/)
  await page.reload()
  await expect(row.locator('kbd')).toHaveText(/⇧⌘K|Ctrl\+Shift\+K/)
  await page.keyboard.press('ControlOrMeta+k')
  await expect(dialog).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+Shift+k')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await row.getByRole('button', { name: '移除快捷键 · 搜索聊天' }).click()
  await expect(row.getByText('未分配', { exact: true })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+Shift+k')
  await expect(dialog).toHaveCount(0)
  await reset.click()
  await expect(reset).toBeDisabled()
  await page.keyboard.press('ControlOrMeta+k')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
}

async function verifyProfile(page, nav, main) {
  const link = nav.getByRole('group', { name: '个人资料' }).getByRole('button')
  await link.click()
  await expect(nav).toHaveCount(0)
  await expect(main.getByRole('heading', { name: '用户', level: 1 })).toBeVisible()
  await expect(main.getByText('累计 Token 数', { exact: true })).toBeVisible()
  await expect(main.getByText(/精选作品|个人作品|创建站点/)).toHaveCount(0)
  for (const name of ['每周', '累计总量', '每天']) {
    const mode = main.getByRole('button', { name, exact: true })
    await mode.click()
    await expect(mode).toHaveAttribute('aria-pressed', 'true')
  }
  await main.getByRole('button', { name: '后退' }).click()
  await expect(link).toBeVisible()
  await page.getByRole('button', { name: '前进' }).click()
  const openEdit = main.getByRole('button', { name: '编辑', exact: true })
  const edit = page.getByRole('dialog', { name: '编辑个人资料' })
  const avatarImage = 'img.local-user-avatar, .local-user-avatar img'
  const hero = main.locator('.profile-identity').locator(avatarImage)
  const rail = page.locator('.user-menu-trigger').locator(avatarImage)
  const preview = edit.locator(avatarImage)
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 32
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#107ac1'
    ctx.fillRect(0, 0, 32, 32)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  const file = { name: 'avatar.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') }

  await openEdit.click()
  const [picker] = await Promise.all([
    page.waitForEvent('filechooser'),
    edit.getByRole('button', { name: '更换头像' }).click(),
  ])
  await picker.setFiles(file)
  await expect(preview).toBeVisible()
  await expect.poll(() => preview.evaluate(img => img.naturalWidth)).toBeGreaterThan(0)
  await edit.getByRole('button', { name: '取消' }).click()
  await page.reload()
  await expect(openEdit).toBeVisible()
  await expect(hero).toHaveCount(0)
  await expect(rail).toHaveCount(0)

  await openEdit.click()
  const input = edit.locator('input[type=file]')
  await input.setInputFiles({ ...file, buffer: Buffer.from('invalid image') })
  await expect(edit.getByRole('alert')).toBeVisible()
  await expect(preview).toHaveCount(0)
  await input.setInputFiles(file)
  await expect(preview).toBeVisible()
  await expect(edit.getByRole('alert')).toHaveCount(0)
  await edit.getByLabel('显示名称').fill('验收用户')
  await edit.getByLabel('用户名').fill('@fixture')
  await edit.getByRole('button', { name: '保存' }).click()
  await expect(edit).toHaveCount(0)
  await page.reload()
  await expect(main.getByRole('heading', { name: '验收用户' })).toBeVisible()
  await expect(main.getByText('@fixture', { exact: true })).toBeVisible()
  await expect(hero).toBeVisible()
  await expect.poll(() => hero.evaluate(img => img.naturalWidth)).toBeGreaterThan(0)
  const savedAvatar = await hero.getAttribute('src')
  await expect(rail).toHaveAttribute('src', savedAvatar)
  await main.getByRole('button', { name: '分享' }).click()
  const share = page.getByRole('dialog', { name: '分享个人资料' })
  await expect(share).toContainText('验收用户\n@fixture')
  // Capture the copy action without changing the developer's system clipboard.
  const originalWrite = await app.evaluateHandle(({ clipboard }) => clipboard.writeText)
  await app.evaluate(({ clipboard }) => {
    clipboard.writeText = text => { globalThis.copiedProfile = text }
  })
  try {
    await share.getByRole('button', { name: '复制摘要' }).click()
    await expect(share.getByRole('button', { name: '已复制' })).toBeVisible()
    expect(await app.evaluate(() => globalThis.copiedProfile)).toContain('累计 Token 数')
  } finally {
    await app.evaluate(({ clipboard }, original) => { clipboard.writeText = original }, originalWrite)
    await originalWrite.dispose()
  }
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(link).toHaveAccessibleName('验收用户')
  await expect(link.locator(avatarImage)).toHaveAttribute('src', savedAvatar)
}

async function verifySettings(page) {
  const nav = page.getByRole('navigation', { name: '设置分类' })
  const main = page.getByRole('main')
  const search = nav.getByRole('searchbox', { name: '搜索设置' })
  await expect(nav.getByRole('group')).toHaveCount(7)
  await expect(nav.locator('.settings-category > p').first()).toHaveCSS('font-weight', '400')
  await expect(nav.locator('.rail-row')).toHaveCount(18)
  await verifyProfile(page, nav, main)
  await search.fill('字号')
  await expect(nav.locator('.rail-row')).toHaveCount(1)
  await search.press('Enter')
  const fontSize = main.getByRole('combobox', { name: '字号' })
  await expect(fontSize).toBeFocused()
  await fontSize.selectOption('large')
  await expect(page.locator('html')).toHaveCSS('--font-scale', '1.15')
  await fontSize.selectOption('standard')
  const theme = main.getByRole('radiogroup', { name: '主题' })
  await theme.getByRole('radio', { name: '深色' }).check()
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'dark')
  await theme.getByRole('radio', { name: '跟随系统' }).check()
  await page.keyboard.press('ControlOrMeta+f')
  await expect(search).toBeFocused()
  await page.keyboard.insertText('工作目录')
  await expect(search).toHaveValue('工作目录')
  await search.press('Enter')
  await expect(main.getByRole('heading', { name: '工作目录', exact: true })).toBeVisible()
  await expect(main.getByRole('heading', { name: '工作目录', exact: true })).toHaveCSS('font-weight', '400')
  await expect(main.getByText('Bot 工作目录', { exact: true })).toHaveCSS('font-weight', '400')
  await expect(main.getByRole('button', { name: 'Bot 管理', exact: true })).toHaveCSS('font-weight', '400')
  await search.fill('unmatched fixture')
  await expect(nav.getByRole('status')).toHaveText('没有匹配的设置')
  await search.press('Escape')
  await expect(nav.locator('.rail-row')).toHaveCount(18)
  await verifyKeyboardShortcuts(page, nav, main)
  for (const name of ['本机配置','使用情况','常规','设备存储','备份与恢复','频道配置',
    '插件与技能','MCP 服务器','工具审批与文件访问','Git 工作树','通知']) {
    await nav.getByRole('button', { name, exact: true }).click()
    await expect(main.getByRole('heading', { name, level: 1 })).toBeVisible()
    if (name === '频道配置') {
      await expect(main.getByRole('heading', { name })).toHaveCSS('font-weight', '400')
      await expect(main.locator('[data-channel="telegram"] strong')).toHaveCSS('font-weight', '400')
      await expect(main.getByRole('button', { name: '配置 Telegram' })).toHaveCSS('font-weight', '400')
    }
  }
  const toggle = main.getByRole('switch', { name: '运行失败' })
  await toggle.click()
  await expect(toggle).toBeChecked()
  await page.reload()
  await expect(toggle).toBeChecked()
  await toggle.click()
  await expect(toggle).not.toBeChecked()
}

async function verifyScheduledTask(page) {
  const sidebar = page.locator('.schedule-sidebar')
  const main = page.getByRole('main')
  await expect(sidebar.getByText('暂无任何定时任务')).toBeVisible()
  await expect(main.getByRole('heading', { name: '安排任务' })).toBeVisible()
  const templateNames = ['寻找周末读物', '价格提醒', '查找音乐演出', '帮我安排周末', '每周饮食计划', '每周财务状况更新']
  for (const name of templateNames)
    await expect(main.getByRole('button', { name: new RegExp(name) })).toBeVisible()
  await main.getByRole('button', { name: /寻找周末读物/ }).click()
  const name = page.getByLabel('任务名称', { exact: true })
  await expect(name).toHaveValue('寻找周末读物')
  await expect(page.getByRole('combobox', { name: '频率', exact: true })).toHaveValue('weekly')
  const title = '周末读物验收'
  await name.fill(title)
  await page.getByRole('button', { name: '创建任务', exact: true }).click()
  await expect(sidebar.getByText(title, { exact: true })).toBeVisible()
  await expect(main.getByRole('heading', { name: title, exact: true })).toBeVisible()
  await page.reload()
  await expect(main.getByRole('heading', { name: title, exact: true })).toBeVisible()
  await main.getByRole('button', { name: '暂停', exact: true }).click()
  await expect(main.getByRole('button', { name: '启用', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '定时任务', exact: true }).click()
  await expect(main.getByRole('heading', { name: '安排任务' })).toBeVisible()
}

async function verifySidebarStyles(page, chatTitle) {
  const navigation = page.getByRole('navigation', { name: '主导航' })
  const sidebar = page.getByRole('complementary', { name: '侧栏' })
  const visit = name => navigation.getByRole('button', { name, exact: true }).click()
  const typography = ['fontSize', 'fontWeight', 'lineHeight']
  const rowStyle = [...typography, 'height', 'borderRadius', 'columnGap']
  const read = (locator, properties) => locator.evaluate((el, keys) => {
    const style = getComputedStyle(el)
    return Object.fromEntries(keys.map(key => [key, style[key]]))
  }, properties)

  async function sample(title, row) {
    const [primary, secondary, heading, item] = await Promise.all([
      read(navigation, ['backgroundColor', 'width']),
      read(sidebar, ['backgroundColor', 'width']),
      read(sidebar.locator(title), typography),
      read(row, rowStyle),
    ])
    expect(primary.width).toBe('52px')
    expect(primary.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
    expect(primary.backgroundColor).toBe(secondary.backgroundColor)
    return { primary, secondary, heading, item }
  }

  const initialTheme = await page.locator('html').getAttribute('data-appearance')
  const surfaces = []
  try {
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme })
      await expect(page.locator('html')).toHaveAttribute('data-appearance', theme)

      await visit('首页')
      const newChat = sidebar.getByRole('button', { name: '新建对话', exact: true })
      const home = await sample('.workbench-switch', newChat)
      const group = await read(sidebar.locator('.rail-section-heading > button').first(), [...typography, 'color'])
      surfaces.push(home.primary.backgroundColor)
      await sidebar.getByRole('button', { name: chatTitle, exact: true }).click()
      await expect(page.getByRole('main').getByRole('log')).toBeVisible()
      expect(await sample('.workbench-switch', newChat), theme + ' 聊天侧栏').toEqual(home)

      await visit('频道')
      const channel = sidebar.getByRole('button', { name: 'Telegram', exact: true })
      expect(await sample('.channel-overview', channel), theme + ' 频道侧栏').toEqual(home)
      await visit('定时任务')
      const task = sidebar.getByRole('button', { name: '新建任务', exact: true })
      expect(await sample('.schedule-nav h1', task), theme + ' 定时任务侧栏').toEqual(home)
      await visit('设置')
      const account = sidebar.getByRole('button', { name: '订阅账号', exact: true })
      expect(await sample('.settings-navigation h2', account), theme + ' 设置侧栏').toEqual(home)
      expect(await read(sidebar.locator('.settings-category > p').first(), [...typography, 'color']),
        theme + ' 设置分组标题').toEqual(group)
    }
    expect(surfaces[0]).not.toBe(surfaces[1])
  } finally {
    await page.emulateMedia({ colorScheme: null })
    await expect(page.locator('html')).toHaveAttribute('data-appearance', initialTheme)
  }
  await visit('定时任务')
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
  await expect(page.getByRole('textbox', { name: /^(新对话消息|消息内容)$/ })).toBeVisible()
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
  const composer = page.getByRole('textbox', { name: /^(新对话消息|消息内容)$/ })
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
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '订阅账号', exact: true }).click()
    await page.getByRole('button', { name: '首页', exact: true }).click()
    await page.getByRole('button', { name: '新建对话', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: '连接你的 AI 账号' })).toBeVisible()
    expect(await page.evaluate(async () => (await window.boteam.invoke('snapshot')).chats.length)).toBe(0)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '订阅账号', exact: true }).click()
    await expect(page.getByRole('heading', { name: '账号管理', exact: true })).toBeVisible()
    await app.close()
    page = await launch()
    await expect(page.getByRole('heading', { name: '账号管理', exact: true })).toBeVisible()
    const button = name => page.getByRole('button', { name, exact: true })
    await button('首页').click()
    const sidebar = page.locator('.sidebar')
    const sideButton = name => sidebar.getByRole('button', { name, exact: true })
    await expect(sideButton('新建对话')).toBeVisible()
    const homeWidth = (await sidebar.boundingBox()).width
    const titlebar = sidebar.locator('.sidebar-titlebar')
    const homeTitlebar = await titlebar.boundingBox()
    const configLink = sidebar.getByRole('button', { name: /频道配置/ })

    await button('频道').click()
    await expect(configLink).toBeVisible()
    await expect(sideButton('新建对话')).toHaveCount(0)
    expect((await sidebar.boundingBox()).width).toBe(homeWidth)
    expect(await titlebar.boundingBox()).toEqual(homeTitlebar)
    await sideButton('后退').click()
    await expect(button('首页')).toHaveAttribute('aria-current', 'page')
    await expect(sideButton('新建对话')).toBeVisible()
    await sideButton('前进').click()
    await expect(configLink).toBeVisible()

    const cards = page.locator('.channel-card')
    const platformNames = ['WeChat', 'WeCom', 'QQ', 'Feishu / Lark', 'DingTalk', 'Telegram', 'Discord', 'WhatsApp']
    await expect(cards).toHaveCount(platformNames.length)
    await expect(page.locator('.window-title')).toHaveCSS('font-weight', '400')
    await expect(page.getByRole('heading', { name: '平台配置' })).toHaveCSS('font-weight', '400')
    await expect(cards.first().getByRole('heading')).toHaveCSS('font-weight', '400')
    await expect(cards.first().getByRole('button')).toHaveCSS('font-weight', '400')
    for (const name of platformNames) {
      await expect(sideButton(name)).toBeVisible()
      await expect(cards.getByRole('button', { name: '配置 ' + name, exact: true })).toBeVisible()
    }
    const catalogSearch = page.getByRole('searchbox', { name: '搜索频道' })
    await catalogSearch.fill('WeCom')
    await expect(cards).toHaveCount(1)
    await expect(sideButton('Telegram')).toBeVisible()
    await cards.getByRole('button', { name: '配置 WeCom' }).click()
    const channelDialog = page.getByRole('dialog')
    await expect(channelDialog.getByRole('heading', { name: 'WeCom' })).toHaveCSS('font-weight', '400')
    await expect(channelDialog.getByRole('textbox', { name: /Bot ID/i })).toBeVisible()
    await expect(channelDialog.locator('input[type=password]')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(channelDialog).toHaveCount(0)
    await catalogSearch.fill('')
    await sideButton('搜索频道会话').click()
    const chatSearch = sidebar.getByRole('searchbox', { name: '搜索频道会话' })
    await chatSearch.fill('Telegram')
    await expect(sideButton('Telegram')).toBeVisible()
    await expect(sideButton('WeCom')).toHaveCount(0)
    await expect(cards).toHaveCount(platformNames.length)
    await sideButton('搜索频道会话').click()
    await expect(chatSearch).toHaveCount(0)
    await expect(sideButton('WeCom')).toBeVisible()

    await sideButton('有会话').click()
    await expect(sideButton('Telegram')).toHaveCount(0)
    await sideButton('已连接').click()
    await expect(sideButton('Telegram')).toHaveCount(0)
    await sideButton('全部').click()
    const telegramGroup = sideButton('Telegram')
    await telegramGroup.focus()
    await telegramGroup.press('Enter')
    await expect(telegramGroup).toHaveAttribute('aria-expanded', 'true')
    await expect(sidebar.getByText('暂无会话', { exact: true })).toBeVisible()
    await expect(cards).toHaveCount(platformNames.length)
    await telegramGroup.press('Space')
    await expect(telegramGroup).toHaveAttribute('aria-expanded', 'false')
    await sideButton('收起侧栏').click()
    await expect(sidebar).toHaveCount(0)
    await button('展开侧栏').click()
    await expect(configLink).toBeVisible()

    const initialSize = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize())
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 560))
    await expect(configLink).toBeInViewport()
    await button('配置 WeCom').click()
    await expect(channelDialog).toBeInViewport()
    await page.keyboard.press('Escape')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0].setSize(width, height), initialSize)
    await button('首页').click()
    await expect(sideButton('新建对话')).toBeVisible()
    await expect(configLink).toHaveCount(0)

    await button('频道').click()
    await app.close()
    const history = await seedChannelHistory()
    page = await launch()
    const channelSidebar = page.locator('.sidebar')
    const telegram = channelSidebar.getByRole('button', { name: 'Telegram', exact: true })
    await expect(telegram).toBeVisible()
    if (await telegram.getAttribute('aria-expanded') === 'false') await telegram.click()
    const channelChat = channelSidebar.getByRole('button', { name: history.title, exact: true })
    await channelChat.click()
    await expect(channelChat).toHaveAttribute('aria-current', 'page')
    await expect(button('频道')).toHaveAttribute('aria-current', 'page')
    const main = page.getByRole('main')
    await expect(main.getByRole('log').getByRole('article').filter({ hasText: history.message })).toBeVisible()
    await expect(page.locator('.window-title')).toHaveCSS('font-weight', '400')
    const legacyReply = main.locator('#message-old-agy-reply')
    await expect(legacyReply).toContainText('运行失败')
    await expect(legacyReply.locator('.task-error')).toContainText(/地区|区域/)
    await expect(legacyReply.locator('.turn-final-answer')).toHaveCount(0)
    const quotedReply = main.locator('#message-quote-reply')
    await expect(quotedReply.locator('.turn-final-answer')).toContainText('User location is not supported')
    await expect(quotedReply.locator('.task-error')).toHaveCount(0)
    await legacyReply.getByRole('button', { name: '更换频道 Bot' }).click()
    await expect(page.getByRole('dialog', { name: 'Telegram' }).getByRole('combobox', { name: '接收消息的 Bot' })).toHaveValue('antigravity')
    await page.keyboard.press('Escape')
    await channelSidebar.getByRole('button', { name: /频道配置/ }).click()
    await expect(main.locator('.channel-card')).toHaveCount(platformNames.length)
    await verifyChannelPermissions(page)
    await button('设置').click()
    await button('我的 Bot').click()
    await expect(page.getByRole('heading', { name: 'Bot 管理', exact: true })).toBeVisible()
    await verifySettings(page)
    await button('定时任务').click()
    await expect(page.getByRole('heading', { name: '定时任务', exact: true })).toBeVisible()
    await verifyScheduledTask(page)
    await verifySidebarStyles(page, history.title)
    await button('验收用户').click()
    await page.getByRole('menuitem', { name: '语言' }).hover()
    await page.getByRole('menuitemradio', { name: 'English' }).click()
    await page.reload()
    await expect(button('Schedules')).toHaveAttribute('aria-current', 'page')
    await button('Settings').click()
    await button('Archived chats').click()
    await expect(page.getByText('No archived chats', { exact: true })).toBeVisible()
    console.log('通过：首次启动、设置导航与搜索、字号与通知偏好、频道聊天与操作权限、定时任务模板与管理、语言偏好及重启恢复。')
  }
} finally {
  await app?.close().catch(() => {})
  await rm(userData, { recursive: true, force: true })
}
