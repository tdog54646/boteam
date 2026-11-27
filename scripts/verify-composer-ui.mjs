// Run after npm run build: node scripts/verify-composer-ui.mjs [--screenshot path.png] [--picker-screenshots dir] [--menu-screenshots dir].
// The real desktop IPC and database run against an isolated directory. Adapters below are local fixtures.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const groupId = 'design-review'
const first = 'implementation'
const second = 'writing'
const third = 'research'
const project = '工作台设计评审'
const commandProject = '原生命令验收项目'
const commandDirectory = 'native-command-fixture'
const commandError = '测试 CLI 暂时无法读取命令目录'
const noteName = '评审清单.md'
const folderName = '设计备注'
const noteText = '# 评审清单\n检查输入框的键盘操作和窄窗口布局。'
const planPrompt = '请确认这次界面评审的计划。'
const firstDraftMessage = '请在只读模式下检查日志。'
const planQuestions = [
  { id: 'platform', question: '优先复核哪个平台？', options: [{label:'桌面端',description:'先检查桌面窗口'},{label:'移动端'}] },
  { id: 'scope', question: '希望怎样验收？', isOther:true, options:[{label:'使用默认清单'}] },
]
const stamp = () => new Date().toISOString()
const levels = ['low', 'medium', 'high'].map(id => ({ id, label: id[0].toUpperCase() + id.slice(1) }))
const codexCatalog = process.env.BOTEAM_TEST_CODEX_CATALOG
  ? JSON.parse(await readFile(process.env.BOTEAM_TEST_CODEX_CATALOG, 'utf8'))
  : {
      defaultModel: 'gpt-5.4', defaultEffort: 'high',
      models: [{ id: 'gpt-5.4', label: 'GPT-5.4', efforts: levels, defaultEffort: 'medium' }],
    }
const claudeCatalog = {
  defaultModel: 'sonnet', defaultEffort: 'medium',
  models: [
    { id: 'sonnet', label: 'Sonnet', efforts: levels, defaultEffort: 'medium' },
    { id: 'single', label: 'Single level', efforts: [{ id: 'fixed', label: 'Fixed' }] },
    { id: 'basic', label: 'Basic', efforts: [] },
  ],
}

async function launchFixtureMain() {
  const { app, dialog, nativeTheme } = await import('electron')
  const { Workspace } = await import('../desktop/workspace.mjs')
  const original = Workspace.prototype.handle
  const { codexCommands } = await import('../desktop/adapters/codex-slash.mjs')
  const { sessionSlashCommands } = await import('../desktop/adapters/antigravity-actions.mjs')
  const goals = new Map()
  const commandReads = []
  let failingChat = null, failingProject = false, failedReadGate
  let teamworkAvailable = true
  app.fixtureCommands = ({ errorChat, errorProject, teamwork, holdFailure }) => {
    if (errorChat !== undefined) failingChat = errorChat
    if (errorProject !== undefined) failingProject = errorProject
    if (teamwork !== undefined) teamworkAvailable = teamwork
    if (holdFailure === true) failedReadGate = Promise.withResolvers()
    if (holdFailure === false) { failedReadGate?.resolve(); failedReadGate = null }
    return commandReads
  }
  const modelReads = {}
  let liveCodexCatalog = codexCatalog
  let catalogError, catalogGate
  app.fixtureModelCatalog = ({ catalog, error, paused }) => {
    if (catalog) liveCodexCatalog = catalog
    if (error !== undefined) catalogError = error
    if (paused === true) catalogGate = Promise.withResolvers()
    if (paused === false) { catalogGate?.resolve(); catalogGate = null }
    return modelReads
  }
  let cancelledQuestions = 0
  function adapter(provider) {
    const codex = provider === 'codex'
    return {
      permissionModes: codex ? ['default','auto-review','read-only','full'] : ['default','plan'],
      async composerActions({ chatId, bot, cwd }) {
        const inProject = basename(cwd) === commandDirectory
        commandReads.push({ chatId, botId: bot.id, inProject })
        if (codex) await new Promise(resolve => setTimeout(resolve, 220))
        if ((chatId && chatId === failingChat) || (inProject && failingProject)) {
          if (failedReadGate) await failedReadGate.promise
          throw new Error(commandError)
        }
        const slashCommands = codex ? codexCommands(new Set([
          'mcpServerStatus/list', 'account/rateLimits/read', 'thread/compact/start', 'review/start',
          'model/list', 'thread/start', 'thread/read', 'thread/fork', 'collaborationMode/list', 'thread/goal/set', 'skills/list',
        ]), { plan:true, goal:true, extensions:[{kind:'skill'}] }) : provider === 'claude'
          ? [{name:'summarize',description:'Summarize the selected passage',action:'prompt',argumentHint:'文章'},
             {name:'context',description:'Inspect context usage',action:'context'}]
          : sessionSlashCommands([{name:'plan',description:'Plan carefully before executing a task.'},
              {name:'goal',description:'Run until the specified goal is completely finished.'},
              ...(teamworkAvailable ? [{name:'teamwork',description:'Invoke a team of agents to tackle large projects.',input:{hint:'任务'}}] : [])], true)
        if (codex && inProject) slashCommands.push({ name:'project-check', description:'检查此项目', action:'prompt' })
        return { slashCommands, plan: true, goal: codex, autoReview: codex, ...(codex ? {} : {note:'部分原生功能列表当前不可用。'}), extensions: codex ? [
          { id: 'app-mail', kind: 'app', label: 'Outlook Email', description: 'Triage Outlook inboxes' },
          { id: 'plugin-design', kind: 'plugin', label: 'Figma', description: 'Create designs, ship to code' },
          { id: 'plugin-work', kind: 'plugin', label: 'Superpowers', description: 'Planning, TDD, and debugging' },
          { id: 'skill-review', kind: 'skill', label: '代码审查', description: '检查实现与需求' },
        ] : [] }
      },
      async forkChat({ bot, account, threadId, chatId }, { destinationChatId }) {
        assert.deepEqual([bot.id,account.id,threadId,chatId],[first,'account-'+first,'fixture-engineering','engineering-chat'])
        return {threadId:'fixture-branch-'+destinationChatId}
      },
      async slashInfo(scope, {name}) {
        assert.equal(name, 'mcp')
        return {title:'MCP 服务器',lines:['设计工具 · 3 个工具']}
      },
      async threadGoal({ action, objective, status, onSession, threadId, chatId }) {
        threadId ||= 'fixture-' + chatId
        if (action !== 'get') onSession(threadId)
        if (action === 'set') goals.set(threadId,{ objective,status })
        if (action === 'clear') goals.delete(threadId)
        return { threadId, goal: goals.get(threadId) || null }
      },
      async options({ account }) {
        modelReads[account.id] = (modelReads[account.id] || 0) + 1
        if (!codex) return claudeCatalog
        if (catalogGate) await catalogGate.promise
        if (catalogError) throw new Error(catalogError)
        return liveCodexCatalog
      },
      async quota() {
        const windows = [{ minutes: 10080, remainingPercent: 67, resetsAt: Date.now() + 4 * 86400_000 }]
        if (codex) windows.push({ minutes: 300, remainingPercent: 82, resetsAt: Date.now() + 2 * 3600_000 })
        return { scope: 'account', windows }
      },
      async run({ account, bot, chatId, emit, attachments, extensionIds, permission, planMode, goalObjective, ask, prompt, slashCommand, signal }) {
        emit({ type: 'identity', value: account.identity, key: account.identity })
        if (prompt === firstDraftMessage) {
          assert.equal(permission, 'read-only')
          emit({ type: 'text', value: '首条任务已采用只读权限。' })
          return
        }
        if (prompt.endsWith('写出本周的验收阈值。') || prompt.endsWith('请检查这个阈值。')) {
          emit({ type: 'session', value: 'quote-' + chatId + '-' + bot.id })
          emit({ type: 'text', value: bot.id === first ? '连续五分钟超过 2% 时，请 @研究助手 复核。' : '阈值已复核。' })
          return
        }
        if (prompt.endsWith('验证模型切换后的上下文')) {
          assert.equal(bot.model, 'basic')
          emit({ type: 'context', value: { model: bot.model, used: 1234, limit: 16000 } })
          emit({ type: 'text', value: '已更新用量。' })
          return
        }
        if (slashCommand) {
          assert.deepEqual([slashCommand, prompt, account.id], ['teamwork', '检查术语 @工程助手', 'account-' + third])
          emit({ type:'text', value:'已由研究助手处理命令参数。' })
          return
        }
        if (prompt === '/tmp/notes.md' || prompt === '日志文件为 /tmp/notes.md') {
          emit({ type:'tool', value:'子智能体 · 已完成', agent:{ id:'reader', name:'资料核对', status:'completed' } })
          emit({ type:'tool', value:'搜索网页', source:{ title:'桌面端资料' } })
          emit({ type:'text', value:'普通文本已收到。' })
          return
        }
        if (prompt === planPrompt) {
          assert.equal(planMode, true)
          const reply = await ask(planQuestions)
          if (signal.aborted) {
            assert.equal(reply, false)
            cancelledQuestions++
            return
          }
          assert.equal(cancelledQuestions, 1)
          assert.deepEqual(reply.platform, {answers:['桌面端']})
          assert.deepEqual(reply.scope, {answers:['用键盘逐项验收']})
          emit({type:'text',value:'已按你的回答选择桌面端，并采用键盘逐项验收。'})
          return
        }
        if (goalObjective) {
          emit({ type: 'text', value: '已收到持续目标。' })
          return
        }
        if (!attachments.length && extensionIds?.[0] === 'plugin-design') {
          emit({ type: 'text', value: '已收到 Figma 扩展。' })
          return
        }
        assert.deepEqual(extensionIds, ['skill-review'])
        assert.equal(planMode, true)
        const drawing = attachments.find(a => a.name === '草图.png')
        assert.equal(drawing?.mimeType, 'image/png')
        assert.deepEqual([...(await readFile(drawing.path)).subarray(0,8)], [137,80,78,71,13,10,26,10])
        const folder = attachments.find(a => a.name === folderName)
        assert.equal(await readFile(join(folder.path, 'notes.md'),'utf8'), '快照中的文件夹')
        const doc = attachments.find(a => a.name === noteName)
        if (!doc || await readFile(doc.path, 'utf8') !== noteText) throw new Error('未收到原文件快照。')
        const snippet = attachments.find(a => a.name === '添加的文本.txt')
        if (!snippet || !(await readFile(snippet.path, 'utf8')).includes('键盘')) throw new Error('未收到文字片段。')
        emit({ type: 'text', value: '已收到评审清单和文字片段，可以开始检查。' })
      },
    }
  }
  const fixtures = Object.fromEntries(['codex', 'claude', 'antigravity'].map(provider => [provider, adapter(provider)]))
  const warm = Workspace.prototype.warmModelCatalogs
  Workspace.prototype.warmModelCatalogs = function() {
    Object.assign(this.adapters, fixtures)
    return warm.call(this)
  }
  Workspace.prototype.handle = function(...args) {
    Object.assign(this.adapters, fixtures)
    return original.apply(this, args)
  }
  dialog.showOpenDialog = async (_window, options) => {
    assert.ok(['openFile','openDirectory','multiSelections'].every(p => options.properties.includes(p)))
    return { canceled: false, filePaths: [join(app.getPath('userData'), noteName), join(app.getPath('userData'), folderName)] }
  }
  nativeTheme.themeSource = 'light'
  await import('../desktop/main.mjs')
}

async function seed(root) {
  const { Database } = await import('../desktop/database.mjs')
  const db = new Database(root)
  try {
    db.run("INSERT INTO settings VALUES('onboarded','yes')")
    await mkdir(join(root, commandDirectory))
    db.run('INSERT INTO projects(id,name) VALUES(?,?)', 'command-project', commandProject)
    db.run('INSERT INTO project_folders VALUES(?,?,?)', 'command-project', await realpath(join(root, commandDirectory)), 0)
    const people = [
      [first, 'codex', '工程助手', '项目账号', codexCatalog.defaultModel, codexCatalog.defaultEffort],
      [second, 'claude', '文案助手', '编辑账号', 'sonnet', 'medium'],
      [third, 'antigravity', '研究助手', '分析账号', 'sonnet', 'medium'],
    ]
    db.run('INSERT INTO chats VALUES(?,?,?,?)', groupId, 'group', project, stamp())
    for (const [id, provider, name, note, model, effort] of people) {
      const accountId = 'account-' + id
      db.run('INSERT INTO accounts VALUES(?,?,?,?,?)', accountId, provider, id + '@example.test',
        JSON.stringify({ status: 'ready', cwd: root }), note)
      db.run('INSERT INTO bots(id,accountId,name,cwd,model,effort) VALUES(?,?,?,?,?,?)',
        id, accountId, name, root, model, effort)
      db.run('INSERT INTO members VALUES(?,?)', groupId, id)
      db.run('INSERT INTO context_usage VALUES(?,?,?,?,?,?)',
        groupId, id, id === first ? 36000 : 8000, 200000, id === third ? '' : model, stamp())
      db.run(
        `INSERT INTO token_metrics(
          chatId,botId,lastTaskId,inputTokens,cachedInputTokens,cacheCreationTokens,
          outputTokens,reasoningTokens,durationMs,tokensPerSecond,cacheHitPercent,
          priorInputTokens,priorCachedTokens,priorOutputTokens,priorDurationMs,
          turnCount,model,updatedAt
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        groupId,
        id,
        'seed-task-' + id,
        id === first ? 20000 : 12000,
        id === first ? 15700 : 8400,
        id === second ? 1200 : 0,
        id === first ? 432 : 310,
        id === first ? 64 : 0,
        5000,
        id === first ? 86.4 : 62,
        id === first ? 78.5 : 70,
        10000,
        7100,
        360,
        5000,
        2,
        id === third ? '' : model,
        stamp(),
      )
    }
    db.run('INSERT INTO chats VALUES(?,?,?,?)', 'engineering-chat', 'direct', '工程助手', stamp())
    db.run('INSERT INTO members VALUES(?,?)', 'engineering-chat', first)
    db.run('INSERT INTO threads VALUES(?,?,?,?,?)','engineering-chat',first,'account-'+first,'fixture-engineering',root)
    db.run('INSERT INTO chats VALUES(?,?,?,?)', 'writing-chat', 'direct', '文案助手', stamp())
    db.run('INSERT INTO members VALUES(?,?)', 'writing-chat', second)
    db.run('INSERT INTO messages(id,chatId,botId,author,name,text,createdAt,recipients,taskId) VALUES(?,?,?,?,?,?,?,?,?)', 'question', groupId, null, 'user', '我',
      '我们先看聊天输入框，窄窗口和键盘操作分别需要关注什么？', stamp(), JSON.stringify([first,second]), null)
    db.run('INSERT INTO messages(id,chatId,botId,author,name,text,createdAt,recipients,taskId) VALUES(?,?,?,?,?,?,?,?,?)', 'implementation-reply', groupId, first, 'bot', '工程助手',
      '窄窗口下要把发送按钮留在视口内。模型名称可以缩短，附件仍需显示完整名称的悬停提示。', stamp(), '[]', null)
    db.run('INSERT INTO messages(id,chatId,botId,author,name,text,createdAt,recipients,taskId) VALUES(?,?,?,?,?,?,?,?,?)', 'writing-reply', groupId, second, 'bot', '文案助手',
      '我会检查键盘顺序，以及额度圆环在聚焦时能否读到剩余比例和重置时间。', stamp(), '[]', null)
    db.run('INSERT INTO messages(id,chatId,botId,author,name,text,createdAt,recipients,taskId) VALUES(?,?,?,?,?,?,?,?,?)', 'direct-question', 'engineering-chat', null, 'user', '我',
      '我们开始检查桌面输入框的权限、附件和键盘操作。', stamp(), JSON.stringify([first]), null)
    db.run('INSERT INTO messages(id,chatId,botId,author,name,text,createdAt,recipients,taskId) VALUES(?,?,?,?,?,?,?,?,?)', 'direct-answer', 'engineering-chat', first, 'bot', '工程助手',
      '可以先选择批准方式，再用输入框左下角的加号添加文件和草图。', stamp(), '[]', null)
    await mkdir(join(root,folderName))
    await writeFile(join(root,folderName,'notes.md'), '快照中的文件夹')
    await writeFile(join(root, noteName), noteText)
  } finally { db.db.close() }
}

function picker(page) {
  const name = '更换模型和思考强度'
  const card = page.getByRole('dialog', { name, exact: true })
  return {
    trigger: page.getByRole('button', { name, exact: true }),
    card,
    model: card.getByRole('button', { name: '选择模型', exact: true }),
    members: card.getByRole('combobox', { name: '查看群成员设置与用量' }),
    slider: card.getByRole('slider', { name: '思考强度' }),
    reset: card.getByRole('button', { name: '恢复 Bot 默认设置' }),
    menu: card.getByRole('menu', { name: '模型', exact: true }),
  }
}

function modelLabelPattern(model) {
  // The desktop picker displays spaced GPT variant names while preserving the catalog ID.
  return new RegExp(model.label.split(/[- ]/).map(RegExp.escape).join('[- ]'), 'i')
}

async function capturePicker(page, ui, path) {
  // Include the popup and its toolbar anchor at device resolution.
  const popup = await ui.card.boundingBox()
  const trigger = await ui.trigger.boundingBox()
  const { width, height } = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  const x = Math.max(0, Math.floor(Math.min(trigger.x, popup.x) - 24))
  const y = Math.max(0, Math.floor(popup.y - 22))
  const right = Math.min(width, Math.ceil(Math.max(trigger.x + trigger.width, popup.x + popup.width) + 42))
  const bottom = Math.min(height, Math.ceil(trigger.y + trigger.height + 36))
  await page.screenshot({ path, clip: { x, y, width: right - x, height: bottom - y }, animations: 'disabled' })
}

async function verifyDirectPicker(page, expect, screenshotDir, catalogFixture) {
  const readCount = async () => (await catalogFixture())['account-' + first]
  const beforeEntry = await readCount()
  await page.getByTitle('工程助手', { exact: true }).click()
  await expect.poll(readCount).toBe(beforeEntry + 1)
  const ui = picker(page)
  await ui.trigger.click()
  await expect(ui.card).toBeInViewport({ ratio: 1 })
  await expect(ui.members).toHaveCount(0)
  await expect(ui.card.getByRole('button', { name: '应用' })).toHaveCount(0)
  await expect(ui.slider).toBeEnabled()
  const selected = codexCatalog.models.find(model => model.id === codexCatalog.defaultModel)
  const stops = await ui.slider.evaluate(input => ({
    count: Number(input.max) - Number(input.min) + 1,
    index: Number(input.value) - Number(input.min),
  }))
  assert.equal(stops.count, selected.efforts.length)
  assert.equal(selected.efforts[stops.index].id, codexCatalog.defaultEffort)
  const fill = () => ui.slider.evaluate(el => getComputedStyle(el.parentElement, '::after').backgroundImage)
  await ui.slider.press('Home')
  for (let index = 0; index < stops.count; index++) {
    if (index) await ui.slider.press('ArrowRight')
    await expect(ui.slider).toHaveValue(String(index))
    if (index === stops.count - 1) await expect.poll(fill).toContain('linear-gradient')
    else await expect.poll(fill).toBe('none')
    if (screenshotDir && index >= stops.count - 2) {
      await mkdir(screenshotDir, { recursive: true })
      await capturePicker(page, ui, join(screenshotDir, index === stops.count - 1 ? 'effort-maximum.png' : 'effort-below-maximum.png'))
    }
    await expect(ui.slider).toBeEnabled()
  }
  await ui.reset.click()
  await expect(ui.slider).toHaveValue(String(stops.index))
  if (screenshotDir) {
    await mkdir(screenshotDir, { recursive: true })
    await capturePicker(page, ui, join(screenshotDir, 'picker-effort.png'))
  }
  await ui.model.click()
  await page.mouse.move(5, 5)
  await expect(ui.menu).toBeInViewport({ ratio: 1 })
  const current = ui.menu.getByRole('menuitemradio', { name: modelLabelPattern(selected) })
  await expect(current).toBeChecked()
  await expect(current).toBeFocused()
  for (const model of codexCatalog.models) {
    await expect(ui.menu.getByRole('menuitemradio', { name: modelLabelPattern(model) })).toHaveCount(1)
  }
  if (screenshotDir) {
    const preview = codexCatalog.models.find(model => model.id === 'gpt-6-astra') || selected
    await ui.menu.getByRole('menuitemradio', { name: modelLabelPattern(preview) }).hover()
    await capturePicker(page, ui, join(screenshotDir, 'picker-models.png'))
  }
  await page.keyboard.press('Escape')
  await expect(ui.menu).toHaveCount(0)
  await expect(ui.model).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(ui.card).toHaveCount(0)
  await expect(ui.trigger).toBeFocused()
  const afterSelection = await readCount()
  assert.equal(afterSelection, beforeEntry + 1, 'Model and effort selection must reuse the displayed catalog')
  for (let repeat = 0; repeat < 2; repeat++) {
    await ui.trigger.click()
    await ui.model.click()
    await expect(current).toBeEnabled()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await expect(ui.card).toHaveCount(0)
  }
  assert.equal(await readCount(), afterSelection, 'Opening either picker level must reuse the conversation catalog')

  async function returnToChat(change) {
    await page.getByTitle('文案助手', { exact: true }).click()
    await expect(ui.trigger).toContainText('Sonnet')
    const previousReads = await readCount()
    await catalogFixture(change)
    await page.getByTitle('工程助手', { exact: true }).click()
    await expect.poll(readCount).toBe(previousReads + 1)
  }
  const next = { id: 'native-new', label: 'New native model', efforts: [] }
  await returnToChat({ catalog: { defaultModel: next.id, models: [next] }, paused: true })
  await ui.trigger.click()
  await ui.model.click()
  await expect(current).toBeEnabled()
  await catalogFixture({ paused: false })
  const latest = ui.menu.getByRole('menuitemradio', { name: next.label, exact: true })
  await expect(latest).toBeEnabled()
  await expect(ui.menu.getByText('已保存，当前未列出')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')

  const failure = '测试目录暂时不可用'
  await returnToChat({ error: failure })
  await ui.trigger.click()
  await ui.model.click()
  const retry = ui.menu.getByRole('button', { name: '重新读取' })
  await expect(ui.menu).toContainText(failure)
  await expect(latest).toBeEnabled()
  const beforeRetry = await readCount()
  await catalogFixture({ catalog: { models: [] }, error: null })
  await retry.click()
  await expect.poll(readCount).toBe(beforeRetry + 1)
  await expect(ui.menu.getByText('原生工具未返回可选模型。')).toBeVisible()
  await expect(latest).toHaveCount(0)
  await catalogFixture({ catalog: codexCatalog })
  await retry.click()
  await expect(current).toBeEnabled()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(ui.card).toHaveCount(0)
}

async function verifyActionMenus(page, expect, screenshotDir, resize) {
  const button = name => page.getByRole('button', { name, exact: true })
  const dialog = name => page.getByRole('dialog', { name, exact: true })
  const approvals = dialog('更改权限')
  const permission = button('更改权限')
  const plus = button('添加文件或内容')
  const add = dialog('添加文件或内容')
  const cmd = name => add.getByRole('menuitem', { name })
  const full = approvals.getByRole('menuitemradio', {name:'完全访问权限'})
  async function capture(panel, name, withComposer = false) {
    if (!screenshotDir) return
    await mkdir(screenshotDir, { recursive:true })
    const card = await panel.boundingBox()
    const anchor = await (withComposer ? page.locator('.composer') : permission).boundingBox()
    const x = Math.floor(Math.min(card.x,anchor.x) - 14)
    const y = Math.floor(card.y - (withComposer ? 4 : 14))
    const clip = { x, y, width: Math.ceil(Math.max(card.x + card.width, anchor.x + anchor.width) - x + 14),
      height: Math.ceil(anchor.y + anchor.height - y + 13) }
    await page.screenshot({path:join(screenshotDir,name),clip,animations:'disabled',scale:'device'})
  }
  await permission.click()
  await expect(approvals.getByRole('menuitemradio',{name:'帮我批准'})).toBeVisible()
  await approvals.getByRole('menuitemradio',{name:'帮我批准'}).click()
  await expect(permission).toHaveText('帮我批准')
  await permission.click()
  await full.click()
  await expect(permission).toHaveText('完全访问')
  await permission.click()
  await expect(full).toBeChecked()
  const request = approvals.getByRole('menuitemradio',{name:'请求批准'})
  await expect(request).toBeFocused()
  await page.mouse.move(0, 0)
  const pos = await approvals.boundingBox()
  const trigger = await permission.boundingBox()
  assert.ok(Math.abs(pos.x - trigger.x) < 2 && pos.y + pos.height <= trigger.y)
  await capture(approvals, 'composer-approvals.png')
  await page.keyboard.press('Escape')
  await expect(permission).toBeFocused()
  const field = page.getByRole('textbox',{name:'消息内容'})
  if (screenshotDir) {
    const image = await readFile(join(screenshotDir,'composer-approvals.png'))
    await field.evaluate((el, bytes) => {
      const clipboardData = new DataTransfer()
      clipboardData.items.add(new File([new Uint8Array(bytes)], '权限菜单.png', {type:'image/png'}))
      el.dispatchEvent(new ClipboardEvent('paste', {bubbles:true,cancelable:true,clipboardData}))
    }, [...image])
    await expect(button('移除附件 权限菜单.png')).toBeVisible()
    await expect(page.locator('.attachment-chips img')).toBeVisible()
    await field.fill('请检查输入框的添加菜单和操作批准。')
  }
  await plus.click()
  await expect(cmd(/^文件和文件夹/)).toBeFocused()
  await expect(cmd(/^Figma/)).toBeVisible()
  const composer = await page.locator('.composer').boundingBox()
  const popup = await add.boundingBox()
  assert.ok(Math.abs(popup.width - composer.width) < 2 && popup.y + popup.height < composer.y)
  await capture(add, 'composer-add-menu.png', true)
  await page.keyboard.press('End')
  await expect(cmd(/^代码审查/)).toBeFocused()
  assert.ok(await add.evaluate(el => el.scrollTop > 0))
  await page.keyboard.press('Home')
  await expect(cmd(/^文件和文件夹/)).toBeFocused()
  await resize(800,600)
  await expect(add).toBeInViewport({ratio:1})
  await page.emulateMedia({colorScheme:'dark'})
  await expect.poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true)
  await expect(cmd(/^绘图/)).toBeVisible()
  await page.emulateMedia({colorScheme:'light'})
  await resize(1120,760)
  await cmd(/^目标/).click()
  const goal = dialog('目标')
  await goal.getByRole('textbox').fill('复核键盘导航')
  await goal.getByRole('button',{name:'保存为暂停'}).click()
  await expect(goal).toHaveCount(0)
  await plus.click()
  await cmd(/^目标/).click()
  await expect(goal.getByRole('textbox')).toHaveValue('复核键盘导航')
  await expect(goal).toContainText('已暂停')
  await goal.getByRole('button',{name:'清除目标'}).click()
  await expect(goal).toHaveCount(0)
  await plus.click()
  await cmd(/^目标/).click()
  await expect(goal.getByRole('textbox')).toHaveValue('')
  await goal.getByRole('textbox').fill('验证原生目标派活')
  await goal.getByRole('button',{name:'开始目标'}).click()
  await expect(page.getByRole('log')).toContainText('已收到持续目标')
  if (screenshotDir) {
    await button('移除附件 权限菜单.png').click()
    await field.fill('')
  }
  await plus.click()
  await cmd(/^Figma/).click()
  await expect(button('移除 Figma')).toBeVisible()
  await button('发送消息').click()
  await expect(page.getByRole('log')).toContainText('已收到 Figma 扩展。')
}

async function verifyNativeQuestions(page, expect) {
  const field = page.getByRole('textbox', {name:'消息内容'})
  const button = name => page.getByRole('button', {name,exact:true})
  const submit = button('提交回答')
  const platform = page.getByRole('group', {name:planQuestions[0].question})
  const scope = page.getByRole('group', {name:planQuestions[1].question})
  const current = () => page.evaluate(async () => {
    const {tasks} = await window.boteam.invoke('snapshot')
    const task = tasks.find(t => t.approval?.kind === 'questions')
    return {taskId:task.id, requestId:task.approval.id}
  })
  const answer = payload => page.evaluate(p => window.boteam.invoke('answerQuestions',p),payload)
  await button('添加文件或内容').click()
  await page.getByRole('menuitem',{name:/^计划模式/}).click()
  await field.fill(planPrompt)
  await field.press('Enter')
  await expect(submit).toBeDisabled()
  const firstRequest = await current()
  const answers = {platform:'桌面端',scope:'用键盘逐项验收'}
  await assert.rejects(answer({...firstRequest,requestId:'stale',answers}), /已结束/)
  await assert.rejects(answer({...firstRequest,answers:{...answers,platform:'陌生选项'}}), /请回答/)
  await button('停止当前对话任务').click()
  await expect(submit).toHaveCount(0)
  await assert.rejects(answer({...firstRequest,answers}), /已结束/)

  await field.fill(planPrompt)
  await field.press('Enter')
  await expect(submit).toBeDisabled()
  assert.notDeepEqual(await current(), firstRequest)
  await platform.getByRole('radio', {name:/桌面端/}).check()
  await expect(submit).toBeDisabled()
  await scope.getByRole('radio',{name:'使用默认清单'}).check()
  await expect(submit).toBeEnabled()
  await scope.getByRole('radio',{name:'其他'}).check()
  await expect(submit).toBeDisabled()
  await scope.getByRole('textbox').fill(answers.scope)
  await submit.click()
  await expect(page.getByRole('log')).toContainText('已按你的回答选择桌面端，并采用键盘逐项验收。')
  await expect(submit).toHaveCount(0)
}

async function verifyCommandCache(page, expect, fixture) {
  const engineering = page.getByTitle('工程助手', { exact: true })
  const field = page.getByRole('textbox', { name: '消息内容' })
  const menu = page.locator('.slash-menu')
  const mcp = menu.getByRole('option', { name: /MCP/ })
  const count = async () => (await fixture()).filter(read => read.chatId === 'engineering-chat' && read.botId === first).length
  const chatCount = () => page.evaluate(async () => (await window.boteam.invoke('snapshot')).chats.length)

  const chats = await chatCount()
  const beforeEntry = await count()
  await engineering.click()
  await expect.poll(count).toBe(beforeEntry + 1)
  await field.fill('/')
  await expect(mcp).toBeVisible()
  for (const value of ['/mc', '', '/', '', '/']) {
    await field.fill(value)
    if (value) await expect(mcp).toBeVisible()
    else await expect(menu).toHaveCount(0)
  }
  await field.fill('')
  const permission = page.getByRole('button', { name: '更改权限', exact: true })
  await permission.click()
  await expect(page.getByRole('menuitemradio', { name: '帮我批准' })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '添加文件或内容', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: /^Figma/ })).toBeVisible()
  await page.keyboard.press('Escape')
  assert.equal(await count(), beforeEntry + 1, 'Slash, permissions and extensions must share one native read')

  await page.getByTitle('文案助手', { exact: true }).click()
  await fixture({ errorChat: 'engineering-chat', holdFailure: true })
  try {
    await engineering.click()
    await field.fill('/')
    await expect(mcp).toBeEnabled()
  } finally { await fixture({ holdFailure: false }) }
  await expect(menu).toContainText(commandError)
  await expect(mcp).toBeEnabled()
  const failed = await count()
  await fixture({ errorChat: null })
  await menu.getByRole('button', { name: '重试', exact: true }).click()
  await expect(menu).not.toContainText(commandError)
  await expect(mcp).toBeVisible()
  await expect.poll(count).toBe(failed + 1)
  await field.fill('')
  assert.equal(await chatCount(), chats)
}

async function verifySlash(page, expect, screenshots, commandFixture) {
  const field = page.getByRole('textbox', {name:'消息内容'})
  const menu = page.locator('.slash-menu')
  const list = menu.getByRole('listbox')
  const chooseMember = menu.getByRole('combobox',{name:'命令接收人'})
  const read = () => page.evaluate(() => window.boteam.invoke('snapshot'))
  const send = page.getByRole('button',{name:'发送消息',exact:true})
  async function capture(name) {
    if (!screenshots) return
    await mkdir(screenshots,{recursive:true})
    const top = await menu.boundingBox(), bottom = await page.locator('.composer').boundingBox()
    const x = Math.floor(top.x - 8), y = Math.floor(top.y - 8)
    await page.screenshot({path: join(screenshots,name), animations:'disabled', scale:'device',
      clip:{x,y,width:Math.ceil(bottom.x+bottom.width-x+8),height:Math.ceil(bottom.y+bottom.height-y+8)}})
  }

  await page.getByTitle('工程助手',{exact:true}).click()
  await field.fill('/')
  await expect(list.getByRole('option',{name:/MCP/})).toBeVisible()
  await expect(chooseMember).toHaveCount(0)
  await capture('slash-codex.png')
  await field.press('ArrowDown')
  await expect(list.getByRole('option',{selected:true})).toContainText('使用情况')
  await field.press('ArrowUp')
  await expect(list.getByRole('option',{selected:true})).toContainText('MCP')
  await field.fill('/mc')
  await expect(list.getByRole('option')).toHaveCount(1)
  await field.dispatchEvent('keydown', {key:'Enter', isComposing:true})
  await expect(list).toBeVisible()
  await field.press('Enter')
  const info = page.getByRole('dialog',{name:'MCP 服务器'})
  await expect(info).toContainText('设计工具 · 3 个工具')
  await info.getByRole('button').press('Escape')
  await field.fill('/goal 追踪兼容性')
  await expect.poll(() => send.isEnabled()).toBe(true)
  await field.press('Enter')
  await expect(page.getByRole('textbox',{name:'目标内容'})).toHaveValue('追踪兼容性')
  await page.getByRole('textbox',{name:'目标内容'}).press('Escape')
  await field.fill('/tmp/notes.md')
  await expect(menu).toHaveCount(0)
  await field.press('Enter')
  await expect(page.getByRole('log')).toContainText('普通文本已收到。')
  await field.fill('/fork')
  await field.press('Enter')
  const origin = page.getByRole('button',{name:'查看原会话'})
  await expect(origin).toBeVisible()
  const branch = (await read()).chats.find(c => c.sourceChatId === 'engineering-chat')
  assert.equal(branch.kind, 'direct')
  assert.deepEqual(branch.members, [first])
  await origin.click()
  await expect(page.getByRole('log')).toContainText('普通文本已收到。')
  await expect(field).toHaveValue('')

  const overview = page.getByRole('dialog', { name: '聊天概览' })
  const overviewButton = page.getByRole('button', { name: '聊天概览', exact:true })
  await overviewButton.click()
  await overview.getByRole('button', { name: '1 个已完成' }).click()
  await expect(overview.getByRole('button', { name: /资料核对/ })).toBeVisible()
  await overview.getByRole('button', { name: '查看全部', exact: true }).click()
  await overview.getByRole('searchbox').fill('桌面端')
  await overview.getByRole('button', { name: '桌面端资料' }).click()
  await expect(overview).toHaveCount(0)
  await expect(page.locator('article:focus')).toContainText('/tmp/notes.md')
  await overviewButton.click()
  await expect(overview).toContainText('当前目录未使用 Git')
  await overview.getByRole('button', { name: '当前目录未使用 Git' }).click()
  const workspace = page.getByRole('complementary', { name:'右侧工作区' })
  await expect(workspace.getByRole('tab', { name:'变更' })).toBeVisible()
  await workspace.getByRole('button', { name:'关闭右侧工作区' }).click()
  await page.getByRole('button', { name:'更多聊天操作' }).click()
  await page.getByRole('menuitem', { name:'Fork chat' }).click()
  await expect(origin).toBeVisible()
  await expect(page.getByRole('log')).toContainText('普通文本已收到。')
  await page.reload()
  await expect(origin).toBeVisible()
  await origin.click()
  await expect(origin).toHaveCount(0)

  await page.getByTitle(project,{exact:true}).click()
  await page.getByRole('button',{name:'选择接收人',exact:true}).click()
  await page.getByRole('button',{name:/全体成员/}).click()
  await field.fill('/')
  await expect(list.getByRole('option')).toHaveCount(3)
  await field.press('Enter')
  await expect(chooseMember).toHaveValue(first)
  await chooseMember.selectOption(second)
  await expect(list.getByRole('option',{name:/summarize/})).toBeVisible()
  // The slower Codex response must never replace this member's catalog.
  await page.waitForTimeout(280)
  await expect(list.getByRole('option',{name:/MCP/})).toHaveCount(0)
  await field.fill('/teamwork 不得群发')
  await field.press('Enter')
  await expect(page.getByText('当前成员的原生工具未提供 /teamwork。')).toBeVisible()
  assert.ok(!(await read()).messages.some(m => m.text === '/teamwork 不得群发'))
  await field.fill('/')
  await chooseMember.selectOption(third)
  await expect(list.getByRole('option',{name:/teamwork/})).toBeVisible()
  await expect(list.getByRole('option',{name:/summarize/})).toHaveCount(0)
  const memberReads = async id => (await commandFixture()).filter(read => read.chatId === groupId && read.botId === id).length
  const secondReads = await memberReads(second), thirdReads = await memberReads(third)
  assert.ok(secondReads > 0 && thirdReads > 0)
  await chooseMember.selectOption(second)
  await expect(list.getByRole('option',{name:/summarize/})).toBeVisible()
  await chooseMember.selectOption(third)
  await expect(list.getByRole('option',{name:/teamwork/})).toBeVisible()
  assert.deepEqual([await memberReads(second), await memberReads(third)], [secondReads, thirdReads])
  await page.emulateMedia({colorScheme:'dark'})
  await expect(page.getByRole('button',{name:'更换模型和思考强度'})).toContainText('研究助手')
  await capture('slash-antigravity-group.png')
  await page.emulateMedia({colorScheme:'light'})
  await page.locator('.window-title').click()
  await expect(menu).toHaveCount(0)
  await field.click()
  await commandFixture({ teamwork: false })
  const retired = '/teamwork 此命令已撤回'
  const beforeRetired = await read()
  await field.fill(retired)
  await field.press('Enter')
  await expect(page.getByRole('alert')).toContainText(/未提供可发送的此项命令/)
  const rejected = await read()
  assert.equal(rejected.messages.length, beforeRetired.messages.length)
  assert.equal(rejected.tasks.length, beforeRetired.tasks.length)
  assert.equal(await memberReads(third), thirdReads + 1, 'Sending must consult the current native command catalog')
  await commandFixture({ teamwork: true })
  await field.fill('/tea')
  await expect(list.getByRole('option')).toHaveCount(1)
  await field.press('Tab')
  await expect(field).toHaveValue('/teamwork ')
  await expect(menu).toHaveCount(0)
  await field.press('End')
  await page.keyboard.insertText('检查术语 @工程助手')
  await field.press('Enter')
  await expect(page.getByRole('log')).toContainText('已由研究助手处理命令参数。')
  const state = await read()
  const sent = state.messages.find(m => m.text === '/teamwork 检查术语 @工程助手')
  assert.deepEqual(sent.recipients,[third])
  assert.deepEqual(state.tasks.filter(t => t.messageId === sent.id).map(t => [t.botId,t.accountId,t.status]),[[third,'account-'+third,'done']])
  const beforeHome = (await read()).chats.length
  await page.getByRole('button',{name:'切换工作台'}).click()
  await page.getByRole('menuitemcheckbox',{name:'首页',exact:true}).click()
  const home = page.getByRole('textbox',{name:'新对话消息'})
  const homeMember = page.getByRole('combobox',{name:'选择接收 Bot'})
  await homeMember.selectOption(first)
  await home.fill('/')
  await expect(menu).toBeInViewport({ratio:1})
  await expect(list.getByRole('option',{name:/MCP/})).toBeVisible()
  assert.equal((await read()).chats.length,beforeHome)
  const projectCommand = list.getByRole('option', { name: /project-check/ })
  await expect(projectCommand).toHaveCount(0)
  await home.fill('')
  const projectSelector = page.getByRole('button', { name:'选择聊天项目', exact:true })
  await commandFixture({ errorProject: true })
  await projectSelector.click()
  await page.getByRole('option', { name:commandProject, exact:true }).click()
  await home.fill('/')
  await expect(menu).toContainText(commandError)
  await expect(list.getByRole('option')).toHaveCount(0)
  await commandFixture({ errorProject: false })
  await menu.getByRole('button', { name:'重试', exact:true }).click()
  await expect(projectCommand).toBeVisible()
  assert.ok((await commandFixture()).some(read => read.botId === first && read.inProject))
  await home.fill('')
  await projectSelector.click()
  await page.getByRole('button', { name:'不在项目中工作', exact:true }).click()
  await home.fill('/')
  await expect(list.getByRole('option',{name:/MCP/})).toBeVisible()
  await expect(projectCommand).toHaveCount(0)
  assert.equal((await read()).chats.length, beforeHome)
  await home.fill('/fork')
  await home.press('Enter')
  await expect(page.getByText('请先在此聊天中完成一次原生对话，再创建分支。')).toBeVisible()
  await expect(home).toHaveValue('/fork')
  assert.equal((await read()).chats.length,beforeHome)
  await home.fill('/new')
  await home.press('Enter')
  const newDraft = page.getByRole('textbox', { name: /^(新对话消息|消息内容)$/ })
  await expect(newDraft).toHaveValue('')
  const permission = page.getByRole('button', { name: '更改权限', exact: true })
  await permission.click()
  await page.getByRole('button', { name: '了解更多', exact: true }).click()
  await page.getByRole('button', { name: '使用只读模式', exact: true }).click()
  await expect(permission).toHaveText('只读')
  assert.equal((await read()).chats.length, beforeHome)
  await newDraft.fill(firstDraftMessage)
  await newDraft.press('Enter')
  await expect(page.getByRole('log')).toContainText('首条任务已采用只读权限。')
  const afterHome = await read()
  assert.equal(afterHome.chats.length, beforeHome + 1)
  const newChat = afterHome.chats.find(c => !state.chats.some(previous => previous.id === c.id))
  assert.deepEqual(newChat.members, [first])
  assert.equal(newChat.kind, 'direct')
  assert.deepEqual(afterHome.messages.filter(m => m.chatId === newChat.id && m.author === 'user').map(m => m.text), [firstDraftMessage])
  assert.equal(afterHome.composerSettings.find(s => s.chatId === newChat.id && s.botId === first)?.permission, 'read-only')
  console.log('Slash palette passed for per-tool catalogs, stale responses, IME, outside click, native argument routing and ordinary paths.')
}

async function verifyGroupQuotes(page, expect) {
  const create = name => page.evaluate(payload => window.boteam.invoke('createChat', payload), {
    kind: 'group', name, members: [first, second, third],
  })
  const chatId = await create('消息引用验收')
  await create('另一讨论组')
  const open = async title => {
    await page.getByTitle(title, { exact: true }).click()
    await expect(page.getByRole('region', { name: title, exact: true })).toBeVisible()
  }
  const button = name => page.getByRole('button', { name, exact: true })
  const field = page.getByRole('textbox', { name: '消息内容' })
  const log = page.getByRole('log')
  const draft = page.getByRole('group', { name: '待发送引用' })
  const read = () => page.evaluate(() => window.boteam.invoke('snapshot'))
  await open('消息引用验收')
  await button('选择接收人').click()
  await page.getByRole('button', { name: /工程助手.*项目账号/ }).click()
  await field.fill('写出本周的验收阈值。')
  await field.press('Enter')
  const original = log.getByRole('article').filter({ has: page.locator('.markdown').filter({ hasText: '连续五分钟超过 2%' }) })
  const quote = original.getByRole('button', { name: '引用', exact: true })
  await expect(original).toContainText('@研究助手')
  await original.hover()
  await expect(quote).toHaveCSS('opacity', '1')
  await quote.click()
  await expect(draft).toContainText('工程助手')
  await expect(draft).toContainText('连续五分钟超过 2%')
  await expect(button('发送消息')).toBeDisabled()
  await open('另一讨论组')
  await expect(draft).toHaveCount(0)
  await open('消息引用验收')
  await expect(draft).toContainText('连续五分钟超过 2%')
  const user = log.getByRole('article').filter({ hasText: '写出本周的验收阈值。' })
  await user.getByRole('button', { name: '引用', exact: true }).press('Enter')
  await expect(draft).toContainText('写出本周的验收阈值。')
  await button('移除引用').press('Enter')
  await expect(draft).toHaveCount(0)
  await quote.focus()
  await expect(quote).toHaveCSS('opacity', '1')
  await quote.press('Enter')
  await expect(field).toBeFocused()
  await expect(field).toHaveAccessibleDescription(/工程助手.*连续五分钟超过 2%/)
  await button('添加文件或内容').click()
  await page.getByRole('menuitem', { name: /^目标/ }).click()
  const goal = page.getByRole('dialog', { name: '目标', exact: true })
  await goal.getByRole('textbox').fill('单独验证原生目标')
  await goal.getByRole('button', { name: '开始目标' }).click()
  const goalReply = log.getByRole('article').filter({ hasText: '已收到持续目标。' })
  await expect(goalReply).toBeVisible()
  await expect(goalReply.getByRole('button', { name: '引用' })).toHaveCount(0)
  await expect(draft).toContainText('连续五分钟超过 2%')
  await button('选择接收人').click()
  await page.getByRole('button', { name: /文案助手.*编辑账号/ }).click()
  await field.fill('/summarize 复核')
  await field.press('Enter')
  await expect(page.getByText('请先移除引用，再执行快捷命令。')).toBeVisible()
  await expect(draft).toContainText('工程助手')
  await field.fill('请检查这个阈值。')
  // Remove an attachment through IPC while its original composer is still open.
  await button('添加文件或内容').click()
  await page.getByRole('menuitem', { name: /^添加文本/ }).click()
  await page.getByRole('textbox', { name: '文本内容' }).fill('用于验证失败后保留草稿')
  await button('添加到消息').click()
  await expect(button('移除附件 添加的文本.txt')).toBeVisible()
  await page.evaluate(async scope => {
    const [file] = await window.boteam.invoke('listAttachments', { scope })
    await window.boteam.invoke('removeAttachment', { scope, id: file.id })
  }, chatId)
  await button('发送消息').click()
  await expect(page.getByRole('alert')).toContainText('附件不在当前草稿中')
  await expect(field).toHaveValue('请检查这个阈值。')
  await expect(draft).toContainText('工程助手')
  await open('另一讨论组')
  await open('消息引用验收')
  await expect(field).toHaveValue('请检查这个阈值。')
  await expect(draft).toContainText('工程助手')
  await button('发送消息').click()
  await expect(draft).toHaveCount(0)
  await expect(log).toContainText('阈值已复核。')
  const state = await read()
  const source = state.messages.find(m => m.chatId === chatId && m.text.startsWith('连续五分钟'))
  const sent = state.messages.find(m => m.chatId === chatId && m.text === '请检查这个阈值。')
  assert.equal(sent.replyToMessageId, source.id)
  assert.deepEqual(sent.recipients, [second])
  assert.deepEqual(state.tasks.filter(t => t.messageId === sent.id).map(t => t.botId), [second])
  const link = page.getByRole('button', { name: /查看引用原文/ })
  await expect(link).toContainText('工程助手')
  await expect(link).toHaveAccessibleDescription(/工程助手.*连续五分钟超过 2%/)
  await link.press('Enter')
  await expect(original).toBeFocused()
  console.log('Group quote checks passed for mouse and keyboard, drafts, slash controls, independent recipients and original-message navigation.')
}

async function verifyGroupPicker(page, expect, resize) {
  const ui = picker(page)
  const setting = (id) => page.evaluate(async ({ id, chatId }) => {
    const state = await window.boteam.invoke('snapshot')
    return state.composerSettings.find(row => row.chatId === chatId && row.botId === id) || {}
  }, { id, chatId: groupId })
  await ui.trigger.click()
  await expect(ui.card).toBeInViewport({ ratio: 1 })
  await ui.members.selectOption(second)
  await expect(ui.model).toContainText('Sonnet')
  await resize(800, 600)
  await expect(ui.card).toBeInViewport({ ratio: 1 })
  await ui.model.click()
  const single = ui.menu.getByRole('menuitemradio', { name: 'Single level', exact: true })
  await expect(ui.menu).toBeInViewport({ ratio: 1 })
  await single.click()
  await expect.poll(() => setting(second)).toMatchObject({ model: 'single' })
  await expect(ui.menu).toHaveCount(0)
  await expect(ui.model).toBeFocused()
  await ui.card.getByRole('button', { name: 'Fixed', exact: true }).click()
  await expect.poll(() => setting(second)).toMatchObject({ model: 'single', effort: 'fixed' })
  await expect(ui.card.getByRole('slider', { disabled: false })).toHaveCount(0)
  await expect(ui.model).toBeEnabled()
  await ui.model.press('Enter')
  await expect(single).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(ui.menu.getByRole('menuitemradio', { name: 'Basic', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(() => setting(second)).toMatchObject({ model: 'basic', effort: '' })
  await expect(ui.card.getByRole('slider', { disabled: false })).toHaveCount(0)

  await ui.model.press('Escape')
  const ring = page.getByRole('button', { name: '上下文使用情况', exact: true })
  await ring.click()
  const context = page.getByRole('dialog', { name: '上下文使用情况', exact: true })
  await expect(ui.trigger).toContainText('Basic')
  await expect(context).toContainText('当前模型 · Basic')
  await expect(ring.locator('.ring-track.unknown')).toHaveCount(1)
  await expect(context.getByText('8,000 / 200,000 tokens')).toBeHidden()
  await context.getByText('上次原生读数').click()
  await expect(context.locator('details')).toContainText('Sonnet')
  await expect(context.getByText('8,000 / 200,000 tokens')).toBeVisible()
  await page.evaluate(({chatId, botId}) => window.boteam.invoke('send', {
    chatId, recipients: [botId], text: '验证模型切换后的上下文',
  }), {chatId: groupId, botId: second})
  await expect(context).toContainText('1,234 / 16,000 tokens')
  await expect(ring.locator('.ring-track.unknown')).toHaveCount(0)
  await expect(context.locator('details')).toHaveCount(0)
  await context.getByRole('combobox').selectOption(first)
  await expect(context).toContainText('36,000 / 200,000 tokens')
  await context.getByRole('combobox').selectOption(third)
  await expect(ring.locator('.ring-track.unknown')).toHaveCount(1)
  await context.getByText('上次原生读数').click()
  await expect(context.getByText('原生工具未报告模型')).toBeVisible()
  await context.getByRole('combobox').selectOption(second)
  await context.getByRole('combobox').press('Escape')
  await ui.trigger.click()
  await ui.reset.click()
  await expect.poll(() => setting(second)).toMatchObject({ model: null, effort: null })
  await expect(ui.model).toContainText('Sonnet')
  await expect(ui.slider).toBeEnabled()
  const track = await ui.slider.boundingBox()
  const fill = () => ui.slider.evaluate(el => getComputedStyle(el.parentElement, '::after').backgroundImage)
  await ui.slider.click({ position: { x: 1, y: track.height / 2 } })
  await expect.poll(() => setting(second)).toMatchObject({ effort: 'low' })
  await expect(ui.slider).toBeEnabled()
  await ui.slider.press('ArrowRight')
  await expect.poll(() => setting(second)).toMatchObject({ effort: 'medium' })
  await expect.poll(fill).toBe('none')
  await expect(ui.slider).toBeEnabled()
  await ui.slider.press('End')
  await expect.poll(() => setting(second)).toMatchObject({ effort: 'high' })
  await expect.poll(fill).toContain('linear-gradient')
  await expect(ui.slider).toBeFocused()
  await expect(ui.slider).toBeEnabled()
  const y = track.y + track.height / 2
  await page.mouse.move(track.x + track.width - track.height / 2, y)
  await page.mouse.down()
  await page.mouse.move(track.x + track.height / 2, y, { steps: 10 })
  await expect.poll(fill).toBe('none')
  await page.mouse.up()
  await expect.poll(() => setting(second)).toMatchObject({ effort: 'low' })
  await expect(ui.slider).toBeEnabled()
  await ui.slider.press('End')
  await expect.poll(() => setting(second)).toMatchObject({ effort: 'high' })
  await expect(ui.trigger).toContainText('Sonnet')
  await expect.poll(() => setting(first)).toMatchObject({ model: null, effort: null, permission: 'read-only' })
  await ui.members.selectOption(first)
  await expect(ui.model).toContainText(modelLabelPattern(codexCatalog.models.find(m => m.id === codexCatalog.defaultModel)))
  await ui.members.selectOption(second)
  await expect(ui.slider).toBeEnabled()
  await ui.slider.press('Escape')
  await expect(ui.trigger).toBeFocused()
  await expect(ui.card).toHaveCount(0)
  await resize(1120, 760)
}

async function verify() {
  const { _electron, expect } = await import('@playwright/test')
  const root = await mkdtemp(join(tmpdir(), 'boteam-composer-ui-'))
  const { values: { screenshot, 'picker-screenshots': pickerScreenshots, 'menu-screenshots': menuScreenshots, 'slash-screenshots': slashScreenshots } } = parseArgs({
    options: { screenshot: { type: 'string' }, 'picker-screenshots': { type: 'string' }, 'menu-screenshots': {type:'string'}, 'slash-screenshots': {type:'string'} },
  })
  let app
  try {
    await seed(root)
    app = await _electron.launch({ args: [fileURLToPath(import.meta.url), '--user-data-dir=' + root] })
    assert.equal(await realpath(await app.evaluate(({ app }) => app.getPath('userData'))), await realpath(root))
    const page = await app.firstWindow()
    page.setDefaultTimeout(9_000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    async function resize(width, height) {
      await app.evaluate(({ BrowserWindow }, [w,h]) => BrowserWindow.getAllWindows()[0].setContentSize(w,h), [width,height])
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
    }
    await resize(1120, 760)
    const button = name => page.getByRole('button', { name, exact: true })
    const panel = name => page.getByRole('dialog', { name, exact: true })
    const catalogFixture = (change = {}) => app.evaluate(({ app }, change) => app.fixtureModelCatalog(change), change)
    const commandFixture = (change = {}) => app.evaluate(({ app }, change) => app.fixtureCommands(change), change)
    await expect.poll(async () => Object.keys(await catalogFixture()).sort())
      .toEqual([first, second, third].map(id => 'account-' + id).sort())
    await verifyCommandCache(page, expect, commandFixture)
    await verifyGroupQuotes(page, expect)
    await verifyDirectPicker(page, expect, pickerScreenshots, catalogFixture)
    await verifyActionMenus(page, expect, menuScreenshots, resize)
    await verifyNativeQuestions(page, expect)
    await page.getByTitle(project, { exact: true }).click()
    const composer = page.getByRole('textbox', { name: '消息内容' })
    async function pick(menu) {
      await button('添加文件或内容').click()
      await panel('添加文件或内容').getByRole('menuitem', { name: menu }).click()
    }
    await button('聊天概览').click()
    await button('添加来源').click()
    await expect(button('移除附件 ' + noteName)).toBeVisible()
    await button('聊天概览').click()
    await panel('聊天概览').getByRole('button', { name: folderName, exact:true }).click()
    const workspace = page.getByRole('complementary', { name:'右侧工作区' })
    await workspace.getByRole('button', { name:'notes.md', exact:true }).click()
    await expect(workspace).toContainText('快照中的文件夹')
    await workspace.getByRole('button', { name:'关闭右侧工作区' }).click()
    await pick(/^添加文本/)
    await panel('添加文本').getByRole('textbox', { name: '文本内容' }).fill('请检查键盘的 Tab 顺序。')
    await button('添加到消息').click()
    await expect(button('移除附件 添加的文本.txt')).toBeVisible()
    await pick(/^附加编辑器选区/)
    await panel('附加编辑器选区').getByRole('textbox').fill('const selection = 42;')
    await button('添加到消息').click()
    await expect(button('移除附件 编辑器选区.txt')).toBeVisible()
    await pick(/^绘图/)
    await expect(button('添加到消息')).toBeDisabled()
    const canvas = await page.locator('canvas[aria-label="草图画布"]').boundingBox()
    await page.mouse.move(canvas.x + 50,canvas.y + 30)
    await page.mouse.down()
    await page.mouse.move(canvas.x + 100,canvas.y + 70,{ steps: 12 })
    await page.mouse.up()
    await button('添加到消息').click()
    await expect(button('移除附件 草图.png')).toBeVisible()
    // Simulate DOM file transfer without changing the user's system clipboard.
    for (const action of ['drop', 'paste']) {
      const filename = action + '.bin'
      await composer.evaluate((field, {action,filename}) => {
        const data = new DataTransfer()
        data.items.add(new File([new Uint8Array([42,0,255])], filename))
        const event = action === 'drop'
          ? new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data })
          : new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })
        field.dispatchEvent(event)
      }, {action,filename})
      await button('移除附件 ' + filename).click()
      await expect(button('移除附件 ' + filename)).toHaveCount(0)
    }
    await page.reload()
    await expect(button('移除附件 ' + noteName)).toBeVisible()
    await expect(button('移除附件 添加的文本.txt')).toBeVisible()
    await button('选择接收人').click()
    await page.getByRole('button', { name: /工程助手.*项目账号/ }).click()
    await expect(button('移除接收人 工程助手')).toBeVisible()
    await button('更改权限').click()
    await button('了解更多').click()
    await button('使用只读模式').click()
    await expect(button('更改权限')).toHaveText('只读')
    await verifyGroupPicker(page, expect, resize)
    await expect(button('更改权限')).toHaveText('默认权限')
    await button('添加文件或内容').click()
    await expect(panel('添加文件或内容')).toContainText('部分原生功能列表当前不可用。')
    await expect(panel('添加文件或内容')).not.toContainText('没有可添加的插件或技能')
    await expect(panel('添加文件或内容').getByRole('menuitem',{name:/^文件和文件夹/})).toBeEnabled()
    await page.keyboard.press('Escape')
    const quota = button('模型剩余额度')
    await quota.hover()
    const quotaPanel = panel('模型剩余额度')
    await expect(quotaPanel).toContainText('67%')
    await expect(quota.locator('svg g')).toHaveCount(1)
    await quota.click()
    await quotaPanel.getByRole('combobox').selectOption(first)
    await expect(quotaPanel).toContainText('82%')
    await expect(quotaPanel).toContainText('5 小时')
    await expect(quotaPanel).toContainText('每周')
    await expect(quotaPanel).not.toContainText(/内圈|外圈/)
    await expect(quota.locator('svg g')).toHaveCount(2)
    await quotaPanel.getByRole('combobox').press('Escape')
    await button('Token 输出速度').hover()
    await expect(panel('Token 输出速度')).toContainText('86.4 tok/s')
    await expect(panel('Token 输出速度')).toContainText('会话均速（2 轮）')
    await page.keyboard.press('Escape')
    await button('缓存命中率').hover()
    await expect(panel('缓存命中率')).toContainText('78.5%')
    await expect(panel('缓存命中率')).toContainText('会话累计（2 轮）')
    await page.keyboard.press('Escape')
    await button('上下文使用情况').focus()
    await expect(panel('上下文使用情况')).toContainText('36,000 / 200,000')
    await page.keyboard.press('Escape')
    const [speedBox, cacheBox, contextBox, quotaBox] = await Promise.all([
      button('Token 输出速度').boundingBox(),
      button('缓存命中率').boundingBox(),
      button('上下文使用情况').boundingBox(),
      button('模型剩余额度').boundingBox(),
    ])
    assert.ok(
      speedBox.x < cacheBox.x && cacheBox.x < contextBox.x && contextBox.x < quotaBox.x,
      'Token speed and cache hit icons must sit immediately to the left of context and quota rings',
    )
    await resize(800, 600)
    const controls = ['添加文件或内容','更改权限','选择接收人','Token 输出速度','缓存命中率','上下文使用情况','模型剩余额度','更换模型和思考强度','发送消息']
    for (const name of controls) {
      const control = button(name)
      await expect(control).toBeInViewport({ratio:1})
      const box = await control.boundingBox()
      assert.ok(box.width > 0, name + ' was collapsed')
    }
    await quota.focus()
    await expect(quotaPanel).toBeInViewport({ratio:1})
    await page.keyboard.press('Escape')
    await resize(1120, 760)
    await pick(/^计划模式/)
    await pick(/^代码审查/)
    await expect(button('移除 代码审查')).toBeVisible()
    await composer.fill('请按清单复核键盘操作，并记录需要调整的地方。')
    if (screenshot) {
      await quota.click()
      await expect(quotaPanel).toContainText('82%')
      await page.screenshot({path: screenshot, animations:'disabled', scale:'device'})
    }
    // File-only messages remain sendable to a single selected group member.
    await composer.fill('')
    await expect(button('移除接收人 工程助手')).toBeVisible()
    await rm(join(root,noteName))
    await rm(join(root,folderName), {recursive:true})
    await button('发送消息').click()
    await expect(page.getByRole('log')).toContainText('已收到评审清单和文字片段')
    const state = await page.evaluate(() => window.boteam.invoke('snapshot'))
    const sent = state.messages.find(m => m.attachments.length)
    assert.equal(sent.text, '')
    assert.deepEqual(sent.recipients, [first])
    assert.deepEqual(sent.attachments.map(a => a.name), [noteName, folderName, '添加的文本.txt', '编辑器选区.txt', '草图.png'])
    assert.deepEqual(state.tasks.filter(t => t.messageId === sent.id).map(t => [t.botId,t.status]), [[first,'done']])
    assert.equal(state.composerSettings.find(s => s.botId === second).effort, 'high')
    await button('设置').click()
    await button('订阅账号').click()
    await expect(page.getByRole('heading', {name:'账号管理',exact:true})).toBeVisible()
    await page.reload()
    await expect(button('更换模型和思考强度')).toBeVisible()
    await expect(composer).toBeFocused()
    const restored = picker(page)
    await restored.trigger.click()
    await restored.members.selectOption(second)
    await expect(restored.model).toContainText('Sonnet')
    await expect(restored.slider).toHaveValue(await restored.slider.getAttribute('max'))
    await verifySlash(page, expect, slashScreenshots, commandFixture)
    assert.deepEqual(errors, [])
    console.log('Electron composer checks passed with isolated local fixtures.')
  } finally {
    await app?.close()
    await rm(root, { recursive: true, force: true })
  }
}

if (process.versions.electron) await launchFixtureMain()
else await verify()
