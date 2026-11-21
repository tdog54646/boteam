const { contextBridge, ipcRenderer, webUtils } = require('electron')

const argument = process.argv.find(value => value.startsWith('--boteam-chat='))
contextBridge.exposeInMainWorld('boteam', {
  initialChatId: argument?.slice('--boteam-chat='.length) || null,
  onOpenChat(callback) {
    const open = (_event, id) => callback(id)
    ipcRenderer.on('workspace:openChat', open)
    return () => ipcRenderer.removeListener('workspace:openChat', open)
  },
  invoke(method, payload = {}) {
    return ipcRenderer.invoke('workspace:invoke', method, payload)
  },
  dropAttachments(scope, files) {
    if (!Array.isArray(files) || files.length > 32) throw new Error('每条消息最多添加 32 个附件。')
    const paths = files.map(file => webUtils.getPathForFile(file))
    if (paths.some(path => !path)) return null
    return ipcRenderer.invoke('workspace:dropAttachments', scope, paths)
  },
  subscribe(callback) {
    const changed = () => callback()
    ipcRenderer.on('workspace:changed', changed)
    return () => ipcRenderer.removeListener('workspace:changed', changed)
  },
})
