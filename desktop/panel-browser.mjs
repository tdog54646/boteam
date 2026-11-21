import { session } from 'electron'

const partition = 'boteam-panel-web'
function webAddress(raw) {
  try {
    const url = new URL(raw)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
  } catch { return false }
}

export function configurePanelBrowser(host) {
  const guestSession = session.fromPartition(partition)
  guestSession.setPermissionRequestHandler((_wc, _perm, done) => done(false))
  guestSession.setPermissionCheckHandler(() => false)
  guestSession.webRequest.onBeforeRequest((details, done) => {
    const mainPage = details.resourceType === 'mainFrame'
    done({ cancel: mainPage ? !webAddress(details.url) :
      !/^(?:https?|wss?|data|blob|about):/i.test(details.url) })
  })
  const preventDownload = event => event.preventDefault()
  guestSession.on('will-download', preventDownload)
  host.once('destroyed', () => guestSession.off('will-download', preventDownload))
  host.on('will-attach-webview', (event, preferences, params) => {
    if (params.partition !== partition || !webAddress(params.src)) { event.preventDefault(); return }
    delete preferences.preload
    Object.assign(preferences, {
      partition, nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
      contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
      webviewTag: false, navigateOnDragDrop: false,
    })
  })
  host.on('did-attach-webview', (_event, guest) => {
    guest.setWindowOpenHandler(() => ({ action: 'deny' }))
    const checkNavigation = event => { if (!webAddress(event.url)) event.preventDefault() }
    guest.on('will-navigate', checkNavigation)
    guest.on('will-redirect', checkNavigation)
  })
}
