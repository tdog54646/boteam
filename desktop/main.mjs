import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, shell } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import * as codex from './adapters/codex.mjs'
import * as claude from './adapters/claude.mjs'
import * as antigravity from './adapters/antigravity.mjs'
import { discoverySources, locate, redact } from './native.mjs'
import { Workspace } from './workspace.mjs'
import { installAntigravityCli } from './antigravity-install.mjs'

const dir = dirname(fileURLToPath(import.meta.url))
const page = pathToFileURL(join(dir, '../dist/index.html')).href
app.setName('BoTeam')
if (!app.requestSingleInstanceLock()) app.quit()
else {
  let window, workspace, refresh
  function openWindow() {
    window = new BrowserWindow({
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
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event, url) => {
      if (url !== page) event.preventDefault()
    })
    // A reloaded or crashed renderer cannot dismiss its pending native login.
    const cancelWindowLogins = () => workspace.accounts.cancelAllLogins()
    window.webContents.on('did-navigate', cancelWindowLogins)
    window.webContents.on('render-process-gone', cancelWindowLogins)
    window.webContents.session.setPermissionRequestHandler((_wc, _permission, done) => done(false))
    window.webContents.session.webRequest.onBeforeSendHeaders(
      { urls: ['http://*/*', 'https://*/*'] },
      (_details, done) => done({ cancel: true }),
    )
    window.loadURL(page)
    window.on('closed', () => {
      cancelWindowLogins()
      window = null
    })
  }
  app.on('second-instance', () => {
    if (!window && workspace) openWindow()
    window?.restore()
    window?.focus()
  })
  app.whenReady().then(async () => {
    const notify = () => {
      if (!refresh)
        refresh = setTimeout(() => {
          refresh = null
          if (window && !window.isDestroyed()) window.webContents.send('workspace:changed')
        }, 35)
    }
    workspace = new Workspace({
      root: app.getPath('userData'),
      codexExecutable: (await locate('codex')).bin,
      adapters: { codex, claude, antigravity },
      notify,
      locate: (provider, source) => locate(provider, source, { userData: app.getPath('userData') }),
      discoverySources,
      installAntigravityCli: signal => installAntigravityCli({ signal }),
      async makeThumbnail(path) {
        const size = { width: 240, height: 240 }
        const image = await nativeImage.createThumbnailFromPath(path, size).catch(() => null)
        return image && !image.isEmpty() ? image.toDataURL() : null
      },
      openAntigravityInstall: () => shell.openExternal('https://antigravity.google/docs/getting-started/#download-and-install'),
      async pickFiles() {
        const result = await dialog.showOpenDialog(window, {
          properties: process.platform === 'darwin'
            ? ['openFile', 'openDirectory', 'multiSelections', 'noResolveAliases']
            : ['openFile', 'multiSelections'],
          buttonLabel: '添加',
          title: process.platform === 'darwin' ? '添加文件或文件夹' : '添加文件',
        })
        return result.canceled ? [] : result.filePaths
      },
      async pickDirectory() {
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
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        event.senderFrame.url !== page
      )
        throw new Error('只允许本地工作台发起请求。')
      try {
        if (workspace.closed) throw new Error('工作台正在关闭。')
        return await action(...args)
      } catch (error) {
        throw new Error(redact(error.message || '操作失败。').slice(0, 1400))
      }
    }
    ipcMain.handle('workspace:invoke', localHandler((method, payload) => workspace.handle(method, payload)))
    // Only preload can send this channel. Its paths come from Chromium-backed File objects.
    ipcMain.handle('workspace:dropAttachments', localHandler((scope, paths) =>
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
    openWindow()
    app.on('activate', () => {
      if (!window) openWindow()
    })
    app.on('window-all-closed', () => app.quit())
    let readyToQuit = false
    app.on('before-quit', (event) => {
      if (readyToQuit) return
      event.preventDefault()
      clearTimeout(refresh)
      if (!workspace.closed)
        workspace.close().finally(() => {
          readyToQuit = true
          app.quit()
        })
    })
  })
}
