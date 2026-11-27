import electron, { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, nativeImage, nativeTheme, safeStorage, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import * as codex from './adapters/codex.mjs'
import * as claude from './adapters/claude.mjs'
import * as antigravity from './adapters/antigravity.mjs'
import { discoverySources, locate, redact } from './native.mjs'
import { platformById } from './channels/catalog.mjs'
import { Workspace } from './workspace.mjs'
import { applyWorkspaceRestore, exportWorkspaceBackup, readStorageUsage, stageWorkspaceRestore } from './settings-data.mjs'
import { configurePanelBrowser } from './panel-browser.mjs'
import { PanelTerminals } from './panel-terminals.mjs'
import { chatText, linkedChatId, requireChat } from './chat-transfer.mjs'
import { chatOpenTargets, openChatDirectory } from './chat-open-targets.mjs'
import { installAntigravityCli } from './antigravity-install.mjs'
import { clearHtmlPreviews, registerPreviewScheme, setupPreviewProtocol, stageHtmlPreview } from './preview-protocol.mjs'

const dir = dirname(fileURLToPath(import.meta.url))
const page = pathToFileURL(join(dir, '../dist/index.html')).href
app.setName('BoTeam')
if (!app.requestSingleInstanceLock()) app.quit()
else {
  registerPreviewScheme()
  let workspace, refresh
  const windows = new Map()
  const pendingLinks = []
  const currentWindow = () => BrowserWindow.getFocusedWindow() || windows.values().next().value?.window

  function focus(window) {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  function openWindow(initialChatId = null) {
    const window = new BrowserWindow({
      width: 1260,
      height: 840,
      minWidth: 800,
      minHeight: 560,
      title: 'BoTeam',
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#181818' : '#ffffff',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      trafficLightPosition: { x: 14, y: 15 },
      webPreferences: {
        preload: join(dir, 'preload.cjs'),
        additionalArguments: initialChatId ? ['--boteam-chat=' + initialChatId] : [],
        sandbox: true,
        contextIsolation: true,
        webviewTag: true,
        nodeIntegration: false,
      },
    })
    const contents = window.webContents
    const context = { window, initialChatId, terminals: new PanelTerminals() }
    windows.set(contents, context)
    configurePanelBrowser(contents)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event, url) => {
      if (url !== page) event.preventDefault()
    })
    // Release native sessions owned by a closed, reloaded or crashed renderer.
    const resetRenderer = () => {
      context.storageRead?.abort()
      workspace.accounts.cancelAllLogins(window)
      workspace.channels.cancelSetupsForWindow(window)
      context.terminals.close()
    }
    window.webContents.on('did-navigate', resetRenderer)
    window.webContents.on('render-process-gone', resetRenderer)
    window.webContents.session.setPermissionRequestHandler((_wc, _permission, done) => done(false))
    window.webContents.session.webRequest.onBeforeSendHeaders(
      { urls: ['http://*/*', 'https://*/*'] },
      (_details, done) => done({ cancel: true }),
    )
    window.loadURL(page)
    window.on('closed', () => {
      resetRenderer()
      windows.delete(contents)
    })
    return window
  }

  function openLink(url) {
    const id = linkedChatId(url)
    if (!id) throw new Error('这不是有效的 BoTeam 聊天链接。')
    requireChat(workspace.db, id)
    const target = [...windows.values()].find(entry => entry.initialChatId === id)
    if (target) {
      focus(target.window)
      target.window.webContents.send('workspace:openChat', id)
    } else openWindow(id)
  }

  function incomingLink(url) {
    if (!workspace) { pendingLinks.push(url); return }
    try { openLink(url) } catch (error) {
      const owner = currentWindow() || openWindow()
      void dialog.showMessageBox(owner, { type: 'info', message: error.message })
    }
  }
  const linkArgument = args => args.find(arg => /^boteam:/i.test(arg))
  const startupLink = linkArgument(process.argv)
  if (startupLink) pendingLinks.push(startupLink)
  app.on('open-url', (event, url) => { event.preventDefault(); incomingLink(url) })
  app.on('second-instance', (_event, argv) => {
    const url = linkArgument(argv)
    if (url) incomingLink(url)
    else if (workspace) focus(currentWindow() || openWindow())
  })
  app.whenReady().then(async () => {
    try {
      await applyWorkspaceRestore(app.getPath('userData'))
    } catch (error) {
      dialog.showErrorBox('BoTeam · 恢复备份', error.message)
      app.quit()
      return
    }
    setupPreviewProtocol()
    const notify = () => {
      if (!refresh)
        refresh = setTimeout(() => {
          refresh = null
          for (const contents of windows.keys()) if (!contents.isDestroyed()) contents.send('workspace:changed')
        }, 35)
    }
    workspace = new Workspace({
      root: app.getPath('userData'),
      safeStorage,
      showNotification: Notification.isSupported() ? ({ type, status, name, chatId, language }) => {
        const english = language === 'en'
        const titles = {
          completed: english ? 'Task completed' : '任务完成',
          failed: english ? 'Task failed' : '运行失败',
          approval: english ? 'Approval needed' : '等待审批',
          schedule: status === 'failed'
            ? (english ? 'Scheduled task failed' : '定时任务失败')
            : (english ? 'Scheduled task completed' : '定时任务完成'),
        }
        const alert = new Notification({ title: titles[type], body: name, silent: false })
        alert.on('click', () => {
          if (workspace.closed) return
          const target = currentWindow() || openWindow(chatId)
          focus(target)
          if (chatId && workspace.db.get('SELECT id FROM chats WHERE id=?', chatId))
            target.webContents.send('workspace:openChat', chatId)
        })
        alert.show()
      } : null,
      codexExecutable: (await locate('codex')).bin,
      adapters: { codex, claude, antigravity },
      notify,
      onChatDeleted(id) { for (const context of windows.values()) context.terminals.closeChat(id) },
      hasWindowChatTerminal: id => Array.from(windows.values()).some(context => context.terminals.hasLiveChat(id)),
      locate: (provider, source) => locate(provider, source, { userData: app.getPath('userData') }),
      discoverySources,
      installAntigravityCli: signal => installAntigravityCli({ signal }),
      async makeThumbnail(path, maxDimension = 240) {
        const dim = Number.isFinite(maxDimension) ? Math.max(32, Math.min(1600, Math.round(maxDimension))) : 240
        const size = { width: dim, height: dim }
        const image = await nativeImage.createThumbnailFromPath(path, size).catch(() => null)
        return image && !image.isEmpty() ? image.toDataURL() : null
      },
      openAntigravityInstall: () => shell.openExternal('https://antigravity.google/docs/getting-started/#download-and-install'),
      openProjectDirectory: directory => openChatDirectory('finder', directory, shell),
      revealProjectDirectory: directory => shell.showItemInFolder(directory),
      async pickFiles(window) {
        const result = await dialog.showOpenDialog(window, {
          properties: process.platform === 'darwin'
            ? ['openFile', 'openDirectory', 'multiSelections', 'noResolveAliases']
            : ['openFile', 'multiSelections'],
          buttonLabel: '添加',
          title: process.platform === 'darwin' ? '添加文件或文件夹' : '添加文件',
        })
        return result.canceled ? [] : result.filePaths
      },
      async pickDirectory(window) {
        const result = await dialog.showOpenDialog(window, {
          properties: ['openDirectory', 'showHiddenFiles'],
          buttonLabel: '选择文件夹',
        })
        return result.canceled ? null : result.filePaths[0]
      },
      async openUrl(raw) {
        const url = new URL(raw)
        if (
          url.protocol !== 'https:' ||
          ![
            'auth.openai.com',
            'chatgpt.com',
            'claude.ai',
            'platform.claude.com',
            'accounts.google.com',
          ].includes(url.hostname) ||
          url.username ||
          url.password
        )
          throw new Error('原生工具返回了未知的登录地址。')
        await shell.openExternal(url.href)
      },
    })
    let dataOperation = null
    let restoring = false
    const busyForRestore = () => workspace.closed || workspace.running.size > 0 || workspace.lanes.size > 0 ||
      workspace.threadEdits.size > 0 || workspace.accounts.logins.size > 0 || workspace.channels.setups.size > 0 ||
      [...windows.values()].some(({terminals}) => [...terminals.sessions.values()].some(session => !session.exited)) ||
      !!workspace.db.get("SELECT 1 FROM tasks WHERE status IN ('queued','running','approval') LIMIT 1")
    async function dataAction(context, method, payload) {
      const english = payload.language === 'en'
      const tr = (zh, en) => english ? en : zh
      const session = context.window.webContents.session
      if (method === 'data:cancel-storage') {
        context.storageRead?.abort()
        return
      }
      if (method === 'data:storage') {
        context.storageRead?.abort()
        const scan = new AbortController()
        context.storageRead = scan
        try { return { ...await readStorageUsage(workspace.root, scan.signal), cache: await session.getCacheSize() } }
        finally { if (context.storageRead === scan) context.storageRead = null }
      }
      if (method === 'data:cancel') {
        if (dataOperation?.owner === context) dataOperation.controller.abort(new Error(tr('操作已取消。','Operation canceled.')))
        return
      }
      if (method === 'data:clear-cache') { await session.clearCache(); return true }
      if (!['data:export','data:restore'].includes(method)) throw new Error('未知的数据操作。')
      if (dataOperation) throw new Error('另一项备份操作仍在进行。')
      const controller = new AbortController()
      dataOperation = { owner: context, controller }
      const filters = [{ name: 'BoTeam', extensions: ['boteam'] }]
      const run = async () => {
        if (method === 'data:export') {
          const result = await dialog.showSaveDialog(context.window, {
            title: tr('导出工作台备份','Export workspace backup'),
            defaultPath: 'BoTeam-' + new Date().toISOString().slice(0,10) + '.boteam', filters,
          })
          if (result.canceled || !result.filePath) return null
          controller.signal.throwIfAborted()
          await exportWorkspaceBackup(workspace.root, result.filePath, controller.signal)
          return { path: result.filePath }
        }
        const result = await dialog.showOpenDialog(context.window, {
          title: tr('选择 BoTeam 备份','Choose a BoTeam backup'), properties:['openFile'], filters,
        })
        if (result.canceled || !result.filePaths[0]) return null
        const answer = await dialog.showMessageBox(context.window,{
          type:'warning', title: tr('恢复工作台','Restore workspace'),
          message: tr('用此备份替换当前工作台并重新启动？','Replace this workspace with the backup and restart?'),
          detail: tr('当前聊天、Bot、项目、附件和内置工作目录将被替换。如需保留当前数据，请先导出备份。恢复后请重新连接频道并检查定时任务。',
            'Current chats, bots, projects, attachments and managed working folders will be replaced. Export a backup first to retain this workspace. Reconnect channels and review paused schedules after restoring.'),
          buttons:[tr('取消','Cancel'),tr('恢复并重启','Restore and restart')], defaultId:0, cancelId:0,
        })
        if (answer.response !== 1) return null
        const available = () => !busyForRestore() && workspace.pendingAccounts.size <= 1
        if (!available()) throw new Error('请先结束当前任务、登录、终端和文件操作，再恢复备份。')
        restoring = true
        try {
          controller.signal.throwIfAborted()
          await stageWorkspaceRestore(workspace.root, result.filePaths[0], available, controller.signal)
          app.relaunch()
          setImmediate(() => app.quit())
          return { restarting: true }
        } catch (error) { restoring = false; throw error }
      }
      try { return await workspace.accountOperation(run()) }
      finally { dataOperation = null }
    }
    const localHandler = (action) => async (event, ...args) => {
      const context = windows.get(event.sender)
      if (
        !context ||
        event.senderFrame !== event.sender.mainFrame ||
        event.senderFrame.url !== page
      )
        throw new Error('只允许本地工作台发起请求。')
      try {
        if (restoring && args[0] !== 'data:cancel' && args[0] !== 'data:cancel-storage') throw new Error('正在恢复工作台备份。')
        if (workspace.closed) throw new Error('工作台正在关闭。')
        return await action(context, ...args)
      } catch (error) {
        throw new Error(redact(error.message || '操作失败。').slice(0, 1400))
      }
    }
    ipcMain.handle('workspace:invoke', localHandler(async (context, method, payload = {}) => {
      if (typeof method === 'string' && method.startsWith('data:')) return dataAction(context, method, payload)
      if (method === 'channelOpenGuide') {
        const url = payload.id === 'feishu' && payload.region === 'lark' ? 'https://open.larksuite.com/app' : platformById(payload.id).guide
        if (!url) throw new Error('该平台没有设置指南。')
        return shell.openExternal(url)
      }
      if (method === 'stageHtmlPreview') return stageHtmlPreview(payload.html)
      if (method === 'copyProfileSummary') {
        if (typeof payload.text !== 'string' || payload.text.length > 2000) throw new Error('个人资料摘要无效。')
        clipboard.writeText(payload.text)
        return
      }
      if (method === 'chatOpenTargets') return chatOpenTargets()
      if (method === 'openChatLink') return openLink(payload.url)
      if (!['openChatWindow', 'showChatDirectory', 'openChatDirectory', 'copyChat', 'shareChat'].includes(method))
        return workspace.handle(method, payload, context)
      const chat = requireChat(workspace.db, payload.chatId)
      if (method === 'openChatWindow') { openWindow(chat.id); return }
      if (method === 'showChatDirectory' || method === 'openChatDirectory' || (method === 'copyChat' && payload.format === 'cwd')) {
        const directory = await workspace.panel.directory(payload)
        if (method === 'copyChat') clipboard.writeText(directory)
        else await openChatDirectory(method === 'showChatDirectory' ? 'finder' : payload.target, directory, shell)
        return
      }
      if (method === 'copyChat') { clipboard.writeText(chatText(workspace.db, chat, payload.format)); return }
      const text = chatText(workspace.db, chat, 'text')
      if (process.platform === 'darwin') {
        const options = { window: context.window }
        if (Number.isFinite(payload.x) && Number.isFinite(payload.y))
          Object.assign(options, { x: Math.round(payload.x), y: Math.round(payload.y) })
        new electron.ShareMenu({ texts: [text] }).popup(options)
        return 'menu'
      }
      const filename = chat.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 100) || 'BoTeam'
      const saved = await dialog.showSaveDialog(context.window, { title: '导出聊天', defaultPath: filename + '.md',
        filters: [{ name: 'Markdown', extensions: ['md'] }] })
      if (saved.canceled || !saved.filePath) return 'cancelled'
      await writeFile(saved.filePath, text, { mode: 0o600 })
      return 'saved'
    }))
    // Only preload can send this channel. Its paths come from Chromium-backed File objects.
    ipcMain.handle('workspace:dropAttachments', localHandler((_context, scope, paths) =>
      workspace.accountOperation(workspace.attachments.pick(scope, () => paths))))
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(process.platform === 'darwin'
          ? [
              {
                label: 'BoTeam',
                submenu: [
                  { role: 'about', label: '关于 BoTeam' },
                  { type: 'separator' },
                  { role: 'hide', label: '隐藏 BoTeam' },
                  { role: 'quit', label: '退出 BoTeam' },
                ],
              },
            ]
          : []),
        {
          label: '编辑',
          submenu: ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'].map((role) => ({ role })),
        },
        {
          label: '窗口',
          submenu: [
            { role: 'minimize', label: '最小化' },
            { role: 'togglefullscreen', label: '切换全屏' },
          ],
        },
      ]),
    )
    if (app.isPackaged && process.platform !== 'darwin') app.setAsDefaultProtocolClient('boteam')
    if (pendingLinks.length) for (const link of new Set(pendingLinks.splice(0))) incomingLink(link)
    else openWindow()
    void workspace.accountOperation(workspace.warmModelCatalogs())
    app.on('activate', () => {
      if (!windows.size) openWindow()
    })
    app.on('window-all-closed', () => app.quit())
    let readyToQuit = false
    app.on('before-quit', (event) => {
      if (readyToQuit) return
      event.preventDefault()
      clearTimeout(refresh)
      clearHtmlPreviews()
      for (const context of windows.values()) context.terminals.close()
      if (!workspace.closed)
        workspace.close().finally(() => {
          readyToQuit = true
          app.quit()
        })
    })
  })
}
