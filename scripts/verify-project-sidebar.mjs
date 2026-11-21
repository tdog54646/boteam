// Exercise project import and editing in Electron. The native picker returns only fixture directories.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron, expect } from '@playwright/test'
import { Workspace } from '../desktop/workspace.mjs'

const root = await realpath(await mkdtemp(join(tmpdir(), 'boteam-project-sidebar-')))
const profile = join(root, 'profile')
const core = join(root, 'core')
const docs = join(root, 'docs')
const reports = join(root, 'reports')
const reportsName = '项目周报'
const handoff = join(root, 'handoff')
const handoffName = '交接资料'
const projectName = '发布工具'
const botName = '项目助手'
const reviewerName = '审稿助手'
const firstPrompt = '请帮我检查发布脚本的依赖版本。'
const executable = process.env.BOTEAM_TEST_EXECUTABLE
let app
let database
const rendererErrors = []
async function launch() {
  app = await electron.launch({
    ...(executable && { executablePath: resolve(executable) }),
    args: [...(executable ? [] : ['.']), '--user-data-dir=' + profile],
  })
  assert.equal(await realpath(await app.evaluate(({ app }) => app.getPath('userData'))), profile)
  const page = await app.firstWindow()
  page.on('pageerror', error => rendererErrors.push(error.message))
  // Drive only the isolated test window. Keep its hover timers running while it is hidden.
  const testWindow = await app.browserWindow(page)
  try {
    await testWindow.evaluate(window => {
      window.webContents.setBackgroundThrottling(false)
      window.hide()
    })
  }
  finally { await testWindow.dispose() }
  page.setDefaultTimeout(10_000)
  return page
}
async function seed() {
  await Promise.all([mkdir(core), mkdir(docs), mkdir(reports), mkdir(handoff)])
  await writeFile(join(docs, 'keep.md'), 'fixture on disk')
  const workspace = new Workspace({ root: profile, adapters: {} })
  try {
    workspace.db.run('INSERT INTO accounts(id,provider,identity,info) VALUES(?,?,?,?)',
      'fixture', 'claude', 'fixture', JSON.stringify({ status: 'blocked' }))
    const bot = await workspace.handle('createBot', { accountId: 'fixture', name: botName, cwd: core })
    await workspace.handle('createBot', { accountId: 'fixture', name: reviewerName, cwd: docs })
    await workspace.handle('createChat', { kind: 'direct', members: [bot] })
    await workspace.handle('createChatSection', { name: '协作' })
    await workspace.handle('finishOnboarding')
  } finally {
    await workspace.close()
  }
}
const snapshot = page => page.evaluate(() => window.boteam.invoke('snapshot'))

try {
  await seed()
  database = new DatabaseSync(join(profile, 'workspace.sqlite3'), { readOnly: true })
  let page = await launch()
  await app.evaluate(({ dialog, shell }, paths) => {
    dialog.showOpenDialog = async () => {
      const folder = paths.shift()
      return { canceled: !folder, filePaths: folder ? [folder] : [] }
    }
    shell.openPath = async path => { globalThis.visitedProjectFolder = path; return '' }
    shell.showItemInFolder = path => { globalThis.revealedProjectFolder = path }
  }, [core, docs, reports, reports, null, handoff])
  const button = name => page.getByRole('button', { name, exact: true })
  const dialog = name => page.getByRole('dialog', { name, exact: true })
  const region = name => page.getByRole('region', { name, exact: true })
  const menu = name => page.getByRole('menu', { name, exact: true })
  const item = (parent, name) => parent.getByRole('menuitem', { name, exact: true })
  const projectRow = () => page.locator('[data-project-id]').filter({ has: page.getByRole('button', { name: projectName, exact: true }) })
  const projectTrigger = () => projectRow().getByRole('button', { name: projectName + ' 的项目操作', exact: true })
  const projectMenu = () => menu(projectName + ' 的项目操作')
  const detail = () => dialog(projectName + ' 项目详情')
  const editor = () => dialog('编辑项目')
  const creation = dialog('新建对话')
  const finder = process.platform === 'darwin' ? '在 Finder 中显示' : '在文件管理器中显示'
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  async function openProjectCreation() {
    await projectRow().locator('.sidebar-project-row').hover()
    await projectRow().getByRole('button', { name: '在 ' + projectName + ' 中新建聊天', exact: true }).click()
  }
  async function openProjectMenu() {
    await projectRow().locator('.sidebar-project-row').hover()
    await projectTrigger().click()
    await expect(projectMenu()).toBeVisible()
    await expect(detail()).toHaveCount(0)
  }
  async function editProject() {
    await openProjectMenu()
    await item(projectMenu(), '编辑').click()
    await expect(editor()).toBeVisible()
  }
  async function chooseProjectSection(name) {
    await openProjectMenu()
    await item(projectMenu(), '分区').hover()
    await item(menu('分区'), name).click()
  }
  async function assertCreationProject(value) {
    await expect(creation.getByRole('button', { name: '私聊', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(creation.getByRole('button', { name: '群聊', exact: true })).toBeVisible()
    await expect(creation.getByRole('combobox', { name: '项目', exact: true })).toHaveValue(value)
    await expect(creation.getByRole('combobox', { name: '工作目录' })).toHaveCount(0)
  }
  async function selectGroupCreation() {
    await creation.getByRole('button', { name: '群聊', exact: true }).click()
    await expect(creation.getByRole('textbox', { name: '群聊名称' })).toHaveCount(0)
    await expect(creation.getByRole('combobox', { name: '工作目录' })).toHaveCount(0)
  }
  async function cancelProjectCreation(projectId) {
    const before = (await snapshot(page)).chats.map(c => c.id).sort()
    await openProjectCreation()
    await assertCreationProject(projectId)
    await selectGroupCreation()
    await creation.getByRole('button', { name: '取消', exact: true }).click()
    await expect(creation).toHaveCount(0)
    assert.deepEqual((await snapshot(page)).chats.map(c => c.id).sort(), before)
  }
  const menuChoice = name => page.getByRole('menuitemcheckbox', { name, exact: true })
  const recently = () => page.getByRole('region', { name: '最近', exact: true })
  async function assertDraftOnly(before) {
    const ids = before.chats.map(chat => chat.id).sort()
    assert.deepEqual(database.prepare('SELECT id FROM chats ORDER BY id').all().map(row => row.id), ids)
    const after = await snapshot(page)
    assert.deepEqual(after.chats.map(chat => chat.id).sort(), ids)
    assert.equal(after.messages.length, before.messages.length)
    assert.equal(after.tasks.length, before.tasks.length)
    const sidebarIds = await page.locator('[data-chat-id]').evaluateAll(rows => rows.map(row => row.dataset.chatId))
    assert.ok(sidebarIds.every(id => ids.includes(id)), 'Only saved conversations belong in the sidebar')
  }
  async function sentChat(before, text) {
    const after = await snapshot(page)
    const added = after.chats.filter(chat => !before.chats.some(previous => previous.id === chat.id))
    assert.equal(added.length, 1, 'Sending the first message creates one chat')
    const [chat] = added
    assert.deepEqual(after.messages.filter(m => m.author === 'user' && m.chatId === chat.id).map(m => m.text), [text])
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM chats').get().count, before.chats.length + 1)
    return chat
  }

  const draft = page.getByRole('textbox', { name: /^(新对话消息|消息内容)$/ })
  const projectPicker = dialog('选择聊天项目')
  const projectChip = button('选择聊天项目')
  const candidates = projectPicker.getByRole('listbox', { name: '项目', exact: true })
  const searchProjects = projectPicker.getByRole('searchbox', { name: '搜索项目' })
  async function chooseFirstProject(name, term) {
    await projectChip.click()
    await searchProjects.fill('unmatched-project-51c495')
    await expect(candidates.getByRole('option')).toHaveCount(0)
    await searchProjects.fill(term)
    await candidates.getByRole('option', { name, exact: true }).click()
    await expect(projectPicker).toHaveCount(0)
  }
  async function clearFirstProject(current) {
    await projectChip.click()
    await expect(candidates.getByRole('option', { name: current, exact: true })).toHaveAttribute('aria-selected', 'true')
    await projectPicker.getByRole('button', { name: '不在项目中工作', exact: true }).click()
    await expect(projectPicker).toHaveCount(0)
  }
  async function createFirstProject(name) {
    await projectChip.click()
    await projectPicker.getByRole('button', { name: '新建项目', exact: true }).click()
    await importer.getByRole('textbox', { name: '项目名称' }).fill(name)
    await importer.getByRole('button', { name: '导入', exact: true }).click()
    await expect(importer).toHaveCount(0)
  }
  const foldersOf = chatId => page.evaluate(id => window.boteam.invoke('chatDirectories', { chatId: id }), chatId)
  async function checkBinding(chatId, projectId, paths) {
    const chat = (await snapshot(page)).chats.find(value => value.id === chatId)
    assert.equal(chat.projectId, projectId)
    assert.deepEqual((await foldersOf(chatId)).map(value => value.directory).sort(), [...paths].sort())
    const section = projectId ? page.locator(`[data-project-id="${projectId}"]`) : recently()
    await expect(section.locator(`[data-chat-id="${chatId}"] .thread-row`)).toHaveAttribute('aria-current', 'page')
  }
  async function assertFirstProjectLocked(chatId, projectId) {
    const chat = (await snapshot(page)).chats.find(value => value.id === chatId)
    assert.equal(chat.canSelectInitialProject, false)
    assert.equal(chat.projectId, projectId)
    await expect(page.getByRole('button', { name: '选择聊天项目', exact: true, disabled: false })).toHaveCount(0)
    await assert.rejects(page.evaluate(id => window.boteam.invoke('setInitialChatProject', { chatId: id, projectId: null }), chatId))
    assert.equal((await snapshot(page)).chats.find(value => value.id === chatId).projectId, projectId)
  }

  await button('导入本地项目').click()
  const importer = page.getByRole('dialog', { name: '导入本地项目' })
  await importer.getByRole('textbox', { name: '项目名称' }).fill(projectName)
  await importer.getByRole('button', { name: '添加文件夹' }).click()
  await expect(importer.getByText('docs', { exact: true })).toBeVisible()
  await importer.getByRole('button', { name: '导入', exact: true }).click()
  await expect(importer).toHaveCount(0)
  const project = (await snapshot(page)).projects.find(p => p.name === projectName)
  assert.deepEqual(project.folders, [core, docs])
  const [original] = (await snapshot(page)).chats
  assert.equal(original.projectId, project.id)
  await expect(page.getByRole('region', { name: '私聊', exact: true })).toHaveCount(0)
  await expect(page.getByRole('region', { name: '群聊', exact: true })).toHaveCount(0)
  await button('搜索对话').hover()
  await projectRow().locator('.sidebar-project-row').hover()
  await expect(detail()).toContainText('1 次聊天')
  await expect(projectMenu()).toHaveCount(0)
  await detail().getByRole('button', { name: docs }).click()
  await expect.poll(() => app.evaluate(() => globalThis.visitedProjectFolder)).toBe(docs)

  await projectRow().locator('.sidebar-project-row').hover()
  await expect(detail()).toBeVisible()
  await openProjectMenu()
  const menuItems = ['置顶', '编辑', '分区', finder, '归档聊天', '移除项目']
  await expect(projectMenu().getByRole('menuitem')).toHaveText(menuItems)
  await item(projectMenu(), finder).click()
  await expect.poll(() => app.evaluate(() => globalThis.revealedProjectFolder)).toBe(core)
  await openProjectMenu()
  await item(projectMenu(), '置顶').click()
  await expect(region('置顶')).toContainText(projectName)
  await openProjectMenu()
  await item(projectMenu(), '取消置顶').click()
  await expect(region('项目')).toContainText(projectName)
  await projectRow().getByRole('button', { name: projectName, exact: true }).focus()
  await page.keyboard.press('Shift+F10')
  await expect(projectMenu()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(projectMenu()).toHaveCount(0)
  await expect(detail()).toHaveCount(0)

  await projectRow().getByRole('button', { name: projectName, exact: true }).click({ button: 'right' })
  await expect(projectMenu()).toBeVisible()
  await item(projectMenu(), '分区').hover()
  await item(menu('分区'), '协作').click()
  await expect(region('协作').locator('[data-project-id]')).toHaveCount(1)
  await expect(region('项目').locator('[data-project-id]')).toHaveCount(0)
  await chooseProjectSection('新建分区…')
  const newSection = dialog('新建分区')
  await newSection.getByRole('textbox', { name: '分区名称' }).fill('发布准备')
  await newSection.getByRole('button', { name: '创建并移入' }).click()
  await expect(region('发布准备').locator('[data-project-id]')).toHaveCount(1)
  await expect(region('协作').locator('[data-project-id]')).toHaveCount(0)
  await chooseProjectSection('默认项目')
  await expect(region('项目').locator('[data-project-id]')).toHaveCount(1)
  await expect(region('发布准备').locator('[data-project-id]')).toHaveCount(0)
  await button('最近聊天选项').click()
  await menuChoice('项目中的聊天').click()
  await expect(recently().locator('.thread-row')).toHaveCount(1)
  await button('最近聊天选项').click()
  await menuChoice('项目中的聊天').click()
  await expect(recently().locator('.thread-row')).toHaveCount(0)
  await button('整理侧边栏').click()
  await menuChoice('合并显示').click()
  await expect(recently().locator('.thread-row')).toHaveCount(1)
  await button('整理侧边栏').click()
  await menuChoice('分项目显示').click()

  await cancelProjectCreation(project.id)
  const [primaryBot, reviewer] = (await snapshot(page)).bots
  assert.equal(primaryBot.name, botName)
  assert.equal(reviewer.name, reviewerName)
  const botSelector = button('选择默认 Bot')
  const botMenu = menu('选择默认 Bot')
  const originalChat = projectRow().locator(`[data-chat-id="${original.id}"] .thread-row`)
  await originalChat.click()
  await expect(page.locator('.window-title')).toHaveText(botName)
  await botSelector.click()
  const currentBot = name => botMenu.getByRole('menuitemradio', { name, exact: true })
  await expect(currentBot(botName)).toHaveAttribute('aria-checked', 'true')
  await expect(currentBot(reviewerName)).toHaveAttribute('aria-checked', 'false')
  await currentBot(reviewerName).click()
  await expect(botMenu).toHaveCount(0)
  await expect(botSelector).toContainText(reviewerName)
  await expect(originalChat).toHaveAttribute('aria-current', 'page')
  await botSelector.click()
  await expect(currentBot(reviewerName)).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  assert.equal((await snapshot(page)).chats.length, 1)

  const beforeHomeDraft = await snapshot(page)
  await button('切换工作台').click()
  await menuChoice('首页').click()
  const homeRequest = '请总结本周的发布记录。'
  await expect(draft).toBeVisible()
  await draft.fill(homeRequest)
  await button('添加文件或内容').click()
  await dialog('添加文件或内容').getByRole('menuitem', { name: /^添加文本/ }).click()
  await dialog('添加文本').getByRole('textbox', { name: '文本内容' }).fill('发布检查清单')
  await button('添加到消息').click()
  await expect(button('移除附件 添加的文本.txt')).toBeVisible()
  await chooseFirstProject(projectName, '发布')
  await expect(draft).toHaveValue(homeRequest)
  await clearFirstProject(projectName)
  await chooseFirstProject(projectName, '发布')
  await projectChip.click()
  await projectPicker.getByRole('button', { name: '新建项目', exact: true }).click()
  await importer.getByRole('button', { name: '取消', exact: true }).click()
  await expect(importer).toHaveCount(0)
  await expect(draft).toHaveValue(homeRequest)
  await projectChip.click()
  await expect(candidates.getByRole('option', { name: projectName, exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Escape')
  await createFirstProject(reportsName)
  await expect(draft).toHaveValue(homeRequest)
  await projectChip.click()
  await expect(candidates.getByRole('option', { name: reportsName, exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Escape')
  const beforeHomeSend = await snapshot(page)
  const reportsProject = beforeHomeSend.projects.find(p => p.name === reportsName)
  assert.deepEqual(reportsProject.folders, [reports])
  await assertDraftOnly(beforeHomeDraft)
  await expect(button('移除附件 添加的文本.txt')).toBeVisible()
  await button('发送消息').click()
  await expect(page.locator('.window-title')).toContainText('本周的发布记录')
  const homeState = await snapshot(page)
  const homeMessage = homeState.messages.find(m => m.author === 'user' && m.text === homeRequest)
  assert.ok(homeMessage)
  assert.deepEqual(homeMessage.attachments.map(file => file.name), ['添加的文本.txt'])
  const homeChat = await sentChat(beforeHomeDraft, homeRequest)
  assert.equal(homeChat.id, homeMessage.chatId)
  assert.deepEqual(homeChat.members, [reviewer.id])
  await checkBinding(homeChat.id, reportsProject.id, [reports])
  await assertFirstProjectLocked(homeChat.id, reportsProject.id)

  const globalChats = []
  const newChatActions = [
    () => button('新建对话').click(),
    () => page.keyboard.press(modifier + '+n'),
    () => button('开始新聊天').click(),
  ]
  for (const [index, activate] of newChatActions.entries()) {
    await originalChat.click()
    await expect(originalChat).toHaveAttribute('aria-current', 'page')
    await expect(botSelector).toContainText(reviewerName)
    const before = await snapshot(page)
    await activate()
    await expect(originalChat).not.toHaveAttribute('aria-current', 'page')
    await expect(creation).toHaveCount(0)
    await expect(draft).toHaveValue('')
    await expect(projectChip).toHaveAccessibleDescription('不在项目中工作')
    await draft.fill('请整理本地草稿。')
    await assertDraftOnly(before)
    if (index < newChatActions.length - 1) {
      await originalChat.click()
      await expect(originalChat).toHaveAttribute('aria-current', 'page')
      await assertDraftOnly(before)
      continue
    }
    // Two submissions in one tick exercise the interval before the send button disables.
    await button('发送消息').evaluate(control => { control.click(); control.click() })
    await expect(page.locator('.window-title')).toContainText('整理本地草稿')
    const chat = await sentChat(before, '请整理本地草稿。')
    assert.equal(chat.kind, 'direct')
    assert.deepEqual(chat.members, [reviewer.id])
    assert.equal(chat.projectId, null)
    await expect(recently().locator(`[data-chat-id="${chat.id}"] .thread-row`)).toHaveAttribute('aria-current', 'page')
    globalChats.push(chat.id)
  }

  const beforeDirectDraft = await snapshot(page)
  await openProjectCreation()
  await assertCreationProject(project.id)
  // This Bot's own working directory differs from the project's primary source.
  await creation.getByText(reviewerName, { exact: true }).click()
  await creation.getByRole('button', { name: '开始私聊' }).click()
  await expect(creation).toHaveCount(0)
  await expect(projectChip).toHaveAccessibleDescription(projectName)
  await assertDraftOnly(beforeDirectDraft)
  await draft.fill(firstPrompt)
  await chooseFirstProject(reportsName, '周报')
  await expect(projectChip).toHaveAccessibleDescription(reportsName)
  await projectChip.click()
  await projectPicker.getByRole('button', { name: '新建项目', exact: true }).click()
  await expect(projectChip).toBeEnabled()
  await expect(importer).toHaveCount(0)
  await expect(projectChip).toHaveAccessibleDescription(reportsName)
  await clearFirstProject(reportsName)
  await expect(projectChip).toHaveAccessibleDescription('不在项目中工作')
  await chooseFirstProject(projectName, '发布')
  await expect(projectChip).toHaveAccessibleDescription(projectName)
  await expect(draft).toHaveValue(firstPrompt)
  await assertDraftOnly(beforeDirectDraft)
  await button('发送消息').click()
  await expect(page.locator('.window-title')).toContainText('发布脚本')
  const created = await sentChat(beforeDirectDraft, firstPrompt)
  assert.ok(created?.name.includes('发布脚本'))
  await assertFirstProjectLocked(created.id, project.id)
  assert.deepEqual(created.members, [reviewer.id])
  await checkBinding(created.id, project.id, [core])
  await page.getByRole('button', { name: '更多聊天操作' }).click()
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click()
  const rename = page.getByRole('dialog', { name: '重命名聊天' })
  await rename.getByRole('textbox').fill('我的发布计划')
  await rename.getByRole('button', { name: '保存' }).click()
  await expect(page.locator('.window-title')).toHaveText('我的发布计划')
  await page.getByRole('button', { name: '更多聊天操作' }).click()
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click()
  await rename.getByRole('button', { name: '根据首条消息生成' }).click()
  await expect(rename.getByRole('textbox')).toHaveValue(created.name)
  await rename.getByRole('button', { name: '取消' }).click()
  await expect(page.locator('.window-title')).toHaveText('我的发布计划')

  const beforeGroupDraft = await snapshot(page)
  await openProjectCreation()
  await assertCreationProject(project.id)
  await selectGroupCreation()
  for (const name of [botName, reviewerName]) {
    const member = creation.getByRole('button', { name: new RegExp(name) })
    if (await member.getAttribute('aria-pressed') !== 'true') await member.click()
  }
  await creation.getByRole('button', { name: '创建群聊' }).click()
  await expect(projectChip).toHaveAccessibleDescription(projectName)
  await assertDraftOnly(beforeGroupDraft)
  const groupRequest = '@' + botName + ' 帮我整理部署记录。'
  await draft.fill(groupRequest)
  await chooseFirstProject(reportsName, '周报')
  await expect(projectChip).toHaveAccessibleDescription(reportsName)
  await clearFirstProject(reportsName)
  await expect(projectChip).toHaveAccessibleDescription('不在项目中工作')
  await createFirstProject(handoffName)
  const handoffProject = (await snapshot(page)).projects.find(p => p.name === handoffName)
  assert.deepEqual(handoffProject.folders, [handoff])
  await expect(projectChip).toHaveAccessibleDescription(handoffName)
  await chooseFirstProject(projectName, '发布')
  await expect(draft).toHaveValue(groupRequest)
  await assertDraftOnly(beforeGroupDraft)
  await button('发送消息').click()
  await expect(page.locator('.window-title')).toContainText('整理部署记录')
  const projectChats = (await snapshot(page)).chats.filter(c => c.projectId === project.id)
  const group = await sentChat(beforeGroupDraft, groupRequest)
  assert.equal(group.kind, 'group')
  assert.deepEqual([...group.members].sort(), [primaryBot.id, reviewer.id].sort())
  await assertFirstProjectLocked(group.id, project.id)
  await checkBinding(group.id, project.id, [core])
  assert.ok(projectChats.some(c => c.kind === 'direct' && c.name === '我的发布计划'))

  await button('搜索对话').click()
  const search = page.getByRole('dialog', { name: '搜索对话' })
  await search.getByRole('searchbox').fill(docs)
  await expect(search.getByRole('button', { name: /我的发布计划/ })).toBeVisible()
  await search.getByRole('searchbox').fill('依赖版本')
  await search.getByRole('button', { name: /我的发布计划/ }).click()
  await expect(page.locator('.window-title')).toHaveText('我的发布计划')

  await editProject()
  await editor().getByRole('textbox').fill('临时的修改')
  await editor().getByRole('button', { name: '取消', exact: true }).click()
  assert.equal((await snapshot(page)).projects[0].name, projectName)
  await editProject()
  await editor().getByRole('button', { name: '移除文件夹 core' }).click()
  await editor().getByRole('button', { name: '保存', exact: true }).click()
  await expect(editor()).toHaveCount(0)
  assert.deepEqual((await snapshot(page)).projects[0].folders, [docs])

  await app.close()
  page = await launch()
  await expect(page.locator('.window-title')).toHaveText('我的发布计划')
  assert.deepEqual((await snapshot(page)).projects[0].folders, [docs])
  await openProjectMenu()
  await item(projectMenu(), '归档聊天').click()
  const archive = dialog('归档聊天')
  await expect(archive).toBeVisible()
  await archive.getByRole('button', { name: '取消', exact: true }).click()
  assert.ok((await snapshot(page)).chats.every(c => !c.archived))
  await openProjectMenu()
  await item(projectMenu(), '归档聊天').click()
  await archive.getByRole('button', { name: '归档', exact: true }).click()
  await expect.poll(async () => (await snapshot(page)).chats.filter(c => c.archived).map(c => c.id).sort())
    .toEqual(projectChats.map(c => c.id).sort())
  await expect(projectRow()).toBeVisible()
  await expect(region('已归档')).toBeVisible()

  await openProjectMenu()
  await item(projectMenu(), '移除项目').click()
  const remove = dialog('移除本地项目')
  await remove.getByRole('button', { name: '取消', exact: true }).click()
  await expect(remove).toHaveCount(0)
  await expect(projectRow()).toBeVisible()
  await openProjectMenu()
  await item(projectMenu(), '移除项目').click()
  await remove.getByRole('button', { name: '移除', exact: true }).click()
  await expect(projectRow()).toHaveCount(0)
  const after = await snapshot(page)
  assert.deepEqual(after.projects.map(p => p.id).sort(), [reportsProject.id, handoffProject.id].sort())
  assert.ok(after.chats.filter(c => c.id !== homeChat.id).every(c => c.projectId == null))
  assert.equal(after.chats.find(c => c.id === homeChat.id).projectId, reportsProject.id)
  assert.equal(after.chats.length, projectChats.length + globalChats.length + 1)
  assert.deepEqual(after.chats.filter(c => !c.archived).map(c => c.id).sort(), [...globalChats, homeChat.id].sort())
  assert.ok(after.chats.some(c => c.id === created.id && c.name === '我的发布计划'))
  assert.equal(await readFile(join(docs, 'keep.md'), 'utf8'), 'fixture on disk')
  assert.deepEqual(rendererErrors, [])
  console.log('项目侧栏验收通过。已验证详情卡、项目菜单、主目录、置顶与分区、归档和移除、侧栏切换 Bot、全局新建、首页和私群聊天首轮的项目选择与创建、草稿、工作目录、发送锁定、命名与重启。')
} finally {
  try { await app?.close() } finally {
    database?.close()
    await rm(root, { recursive: true, force: true })
  }
}
