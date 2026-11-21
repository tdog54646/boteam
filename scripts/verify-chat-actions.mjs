// Run against a built renderer or set BOTEAM_TEST_EXECUTABLE to a packaged application binary.
import { _electron as electron, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Workspace } from '../desktop/workspace.mjs'

const root = await mkdtemp(join(tmpdir(), 'boteam-chat-actions-'))
const repo = join(root, 'fixture-repository')
const otherDirectory = join(root, 'second-directory')
const groupName = '两个工作目录'
const activeName = '当前对话'
const targetName = '待整理对话'
const renamed = '已重命名的对话'
let app

function git(directory, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
    '-c', 'commit.gpgSign=false', ...args], { cwd: directory, encoding: 'utf8' }).trim()
}

async function seed() {
  await mkdir(repo)
  await mkdir(otherDirectory)
  git(repo, 'init', '-q')
  await writeFile(join(repo, 'notes.txt'), 'committed\n')
  git(repo, 'add', 'notes.txt')
  git(repo, '-c', 'user.name=BoTeam fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture')
  await writeFile(join(repo, 'notes.txt'), 'uncommitted workspace edit\n')
  const workspace = new Workspace({ root, adapters: {} })
  try {
    workspace.db.run('INSERT INTO accounts(id,provider,identity,info) VALUES(?,?,?,?)',
      'fixture', 'claude', 'isolated', JSON.stringify({ status: 'blocked' }))
    for (const name of [activeName, targetName]) {
      workspace.db.run('INSERT INTO bots(id,accountId,name,cwd) VALUES(?,?,?,?)', name, 'fixture', name, name === targetName ? repo : otherDirectory)
      await workspace.handle('createChat', { kind: 'direct', members: [name] })
    }
    await workspace.handle('createChat', { kind: 'group', name: groupName, members: [activeName, targetName] })
    await workspace.handle('createChatSection', { name: '草稿' })
    await workspace.handle('finishOnboarding')
    const { chats } = workspace.snapshot()
    return { activeId: chats.find(chat => chat.name === activeName).id,
      targetId: chats.find(chat => chat.name === targetName).id }
  } finally {
    await workspace.close()
  }
}

try {
  const { activeId, targetId } = await seed()
  const executable = process.env.BOTEAM_TEST_EXECUTABLE
  app = await electron.launch({
    ...(executable && { executablePath: resolve(executable) }),
    args: [...(executable ? [] : ['.']), '--user-data-dir=' + root],
  })
  const profile = await app.evaluate(({ app }) => app.getPath('userData'))
  expect(await realpath(profile)).toBe(await realpath(root))

  // Exercise the real IPC actions while keeping the machine's clipboard and native share sheet untouched.
  await app.evaluate(({ clipboard, dialog, ShareMenu }) => {
    globalThis.chatActionProbe = { clipboard: '', shares: 0 }
    clipboard.writeText = text => { globalThis.chatActionProbe.clipboard = text }
    if (process.platform === 'darwin') {
      ShareMenu.prototype.popup = () => { globalThis.chatActionProbe.shares++ }
    } else {
      dialog.showSaveDialog = async () => {
        globalThis.chatActionProbe.shares++
        return { canceled: true }
      }
    }
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(12_000)
  await page.getByTitle(activeName, { exact: true }).click()
  const rowSelector = `[data-chat-id="${targetId}"]`
  const row = page.locator(rowSelector)
  const chatButton = row.locator('.thread-row')
  const menu = page.getByRole('menu', { name: '聊天快捷菜单', exact: true })
  const headerMenu = page.getByRole('menu', { name: '更多聊天操作', exact: true })
  const item = (parent, name) => parent.getByRole('menuitem', { name, exact: true })
  const headerButton = page.getByRole('button', { name: '更多聊天操作' })
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  const shareCount = () => app.evaluate(() => globalThis.chatActionProbe.shares)

  await page.getByTitle(groupName, { exact: true }).click()
  await headerButton.click()
  await item(headerMenu, '复制').hover()
  await item(page.getByRole('menu', { name: '复制', exact: true }), '复制工作目录').click()
  const directories = page.getByRole('dialog', { name: '选择工作目录' })
  const members = directories.locator('.member-row')
  await expect(members).toHaveCount(2)
  await expect(members.nth(1)).toContainText(targetName)
  await members.nth(1).click()
  await expect.poll(() => app.evaluate(() => globalThis.chatActionProbe.clipboard)).toBe(await realpath(repo))
  await page.getByTitle(activeName, { exact: true }).click()

  await chatButton.click({ button: 'right' })
  await expect(page.locator('.window-title')).toHaveText(activeName)
  await item(menu, '分叉').hover()
  const forks = page.getByRole('menu', { name: '分叉', exact: true })
  await expect(item(forks, '在同一工作树中创建聊天分支')).toBeVisible()
  await expect(item(forks, '在新工作树中创建聊天分支')).toBeVisible()
  await item(menu, '分享').click()
  await expect.poll(shareCount).toBe(1)

  await chatButton.focus()
  await page.keyboard.press('Shift+F10')
  await item(menu, '分区').focus()
  await page.keyboard.press('ArrowRight')
  const sections = page.getByRole('menu', { name: '分区', exact: true })
  await expect(sections.getByRole('menuitem').first()).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(item(menu, '分区')).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await item(sections, '草稿').click()
  const custom = page.getByRole('region', { name: '草稿', exact: true })
  await expect(custom.locator('.thread-row')).toContainText(targetName)

  await chatButton.click({ button: 'right' })
  await item(menu, '分区').hover()
  await item(sections, '新建分区…').click()
  const newSection = page.getByRole('dialog', { name: '新建分区' })
  await newSection.getByRole('textbox', { name: '分区名称' }).fill('研究')
  await newSection.getByRole('button', { name: '创建并移入' }).click()
  await expect(page.getByRole('region', { name: '研究', exact: true }).locator('.thread-row')).toContainText(targetName)
  await expect(custom.locator('.thread-row')).toHaveCount(0)

  await chatButton.hover()
  await row.getByRole('button', { name: '置顶聊天', exact: true }).click()
  const pinned = page.getByRole('region', { name: '置顶', exact: true })
  await expect(pinned.locator('.thread-row')).toContainText(targetName)
  await chatButton.focus()
  await page.keyboard.press('Shift+F10')
  await item(menu, '标记为未读').click()
  await expect(row.getByRole('img', { name: '未读' })).toBeVisible()

  await chatButton.focus()
  await page.keyboard.press('Tab')
  await expect(row.getByRole('button', { name: '取消置顶聊天' })).toBeFocused()
  await row.getByRole('button', { name: '归档聊天', exact: true }).click()
  const archived = page.getByRole('region', { name: '已归档' })
  await archived.getByRole('button', { name: '已归档', exact: true }).click()
  await expect(archived.locator('.thread-row')).toContainText(targetName)
  await chatButton.hover()
  await row.getByRole('button', { name: '取消归档聊天' }).click()
  await expect(pinned.locator('.thread-row')).toContainText(targetName)

  await chatButton.click()
  await expect(row.getByRole('img', { name: '未读' })).toHaveCount(0)
  await page.getByRole('button', { name: '分享聊天' }).click()
  await expect.poll(shareCount).toBe(2)
  await headerButton.click()
  await expect(headerMenu.getByRole('menuitem')).toHaveCount(7)
  await item(headerMenu, '复制').hover()
  await item(page.getByRole('menu', { name: '复制', exact: true }), '复制会话 ID').click()
  await expect.poll(() => app.evaluate(() => globalThis.chatActionProbe.clipboard)).toBe(targetId)
  await headerButton.click()
  await item(headerMenu, '复制').hover()
  await item(page.getByRole('menu', { name: '复制', exact: true }), '复制深度链接').click()
  const deepLink = 'boteam://chat/' + targetId
  await expect.poll(() => app.evaluate(() => globalThis.chatActionProbe.clipboard)).toBe(deepLink)
  const copiedLink = await app.evaluate(() => globalThis.chatActionProbe.clipboard)

  await chatButton.focus()
  await page.keyboard.press(modifier + '+Shift+u')
  await expect(row.getByRole('img', { name: '未读' })).toBeVisible()
  await headerButton.click()
  await item(headerMenu, '打开方式').hover()
  const [second] = await Promise.all([
    app.waitForEvent('window', { timeout: 12_000 }),
    item(page.getByRole('menu', { name: '打开方式', exact: true }), '在新窗口中打开').click(),
  ])
  second.setDefaultTimeout(12_000)
  await expect(second.locator('.window-title')).toHaveText(targetName)

  await expect(row.getByRole('img', { name: '未读' })).toHaveCount(0)
  await second.locator(rowSelector + ' .thread-row').focus()
  await second.keyboard.press(modifier + '+Alt+r')
  const rename = second.getByRole('dialog', { name: '重命名聊天' })
  await rename.getByRole('textbox', { name: '聊天名称' }).fill(renamed)
  await rename.getByRole('button', { name: '保存', exact: true }).click()
  await expect(second.locator('.window-title')).toHaveText(renamed)
  await expect(page.locator('.window-title')).toHaveText(renamed)
  await expect(chatButton).toContainText(renamed)

  // A copied link inside a real message should return the second window to its original chat.
  await second.getByTitle(activeName, { exact: true }).click()
  await page.bringToFront()
  await page.getByTitle(activeName, { exact: true }).click()
  await page.getByRole('textbox', { name: '消息内容' }).fill('打开 ' + copiedLink)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  const link = page.getByRole('link', { name: copiedLink, exact: true })
  await expect(link).toHaveAttribute('href', copiedLink)
  await link.click()
  await expect(second.locator('.window-title')).toHaveText(renamed)
  await expect(page.locator(`[data-chat-id="${activeId}"] .thread-row`)).toHaveAttribute('aria-current', 'page')
  expect(app.windows()).toHaveLength(2)

  await page.bringToFront()
  await chatButton.click({ button: 'right' })
  await item(menu, '分叉').hover()
  await item(forks, '在新工作树中创建聊天分支').click()
  await expect(page.locator('.window-title')).toHaveText(renamed + ' · 分支', { timeout: 30_000 })
  const fork = await page.evaluate(async sourceId => {
    const { chats } = await window.boteam.invoke('snapshot')
    const branch = chats.find(chat => chat.sourceChatId === sourceId)
    if (!branch) throw new Error('未找到新工作树的聊天分支')
    const { root } = await window.boteam.invoke('panelFiles', { chatId: branch.id })
    return { id: branch.id, directory: root }
  }, targetId)
  expect(fork.id).not.toBe(targetId)
  const forkDirectory = await realpath(fork.directory)
  expect(forkDirectory).not.toBe(await realpath(repo))
  expect(await realpath(git(forkDirectory, 'rev-parse', '--show-toplevel'))).toBe(forkDirectory)
  expect(git(repo, 'worktree', 'list', '--porcelain')).toContain('worktree ' + forkDirectory.split('\\').join('/'))
  expect(git(forkDirectory, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'HEAD'))
  expect(await readFile(join(forkDirectory, 'notes.txt'), 'utf8')).toBe('uncommitted workspace edit\n')

  await chatButton.click()
  await headerButton.click()
  await item(headerMenu, 'Delete').click()
  const confirmation = page.getByRole('dialog', { name: '永久删除聊天？' })
  await expect(confirmation).toContainText(renamed)
  await confirmation.getByRole('button', { name: '取消', exact: true }).click()
  await expect(chatButton).toBeVisible()
  await chatButton.click({ button: 'right' })
  await item(menu, '永久删除').click()
  await confirmation.getByRole('button', { name: '永久删除', exact: true }).click()
  await expect(chatButton).toHaveCount(0)
  await expect(page.locator(`[data-chat-id="${activeId}"] .thread-row`)).toBeVisible()
  await expect(second.locator(rowSelector)).toHaveCount(0)
  await expect(second.locator('.window-title')).not.toHaveText(renamed)
  await expect(page.locator(`[data-chat-id="${fork.id}"]`)).toBeVisible()
  console.log('通过：聊天菜单、组织和快捷键、跨窗口同步、消息深度链接、Git 工作树分叉与删除确认。')
} finally {
  try { await app?.close() } finally { await rm(root, { recursive: true, force: true }) }
}
