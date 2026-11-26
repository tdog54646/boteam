import electron, { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import * as codex from './adapters/codex.mjs'
import * as claude from './adapters/claude.mjs'
import * as antigravity from './adapters/antigravity.mjs'
import { discoverySources, locate, redact } from './native.mjs'
import { Workspace } from './workspace.mjs'
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
      workspace.accounts.cancelAllLogins(window)
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
    const localHandler = (action) => async (event, ...args) => {
      const context = windows.get(event.sender)
      if (
        !context ||
        event.senderFrame !== event.sender.mainFrame ||
        event.senderFrame.url !== page
      )
        throw new Error('只允许本地工作台发起请求。')
      try {
        if (workspace.closed) throw new Error('工作台正在关闭。')
        return await action(context, ...args)
      } catch (error) {
        throw new Error(redact(error.message || '操作失败。').slice(0, 1400))
      }
    }
    ipcMain.handle('workspace:invoke', localHandler(async (context, method, payload = {}) => {
      if (method === 'stageHtmlPreview') return stageHtmlPreview(payload.html)
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
