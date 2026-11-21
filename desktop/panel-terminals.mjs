import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { createRequire } from 'node:module'
import { nativeEnv } from './native.mjs'

const require = createRequire(import.meta.url)
const historyLimit = 512 * 1024
function dimensions({ cols = 80, rows = 24 }) {
  if (![cols, rows].every(n => Number.isInteger(n) && n >= 1 && n <= 2048))
    throw new Error('终端尺寸无效。')
  return { cols, rows }
}

export class PanelTerminals {
  sessions = new Map()
  generation = 0

  start(scope, cwd, options) {
    if (this.sessions.size >= 32) throw new Error('请先关闭一个终端标签。')
    const env = nativeEnv({ TERM: 'xterm-256color', COLORTERM: 'truecolor' })
    const windows = process.platform === 'win32'
    const shell = windows ? 'powershell.exe' : isAbsolute(env.SHELL || '') ? env.SHELL : '/bin/sh'
    const child = require('node-pty').spawn(shell, windows ? ['-NoLogo'] : ['-l'], {
      cwd, env, name: env.TERM, ...dimensions(options),
    })
    const id = randomUUID()
    const session = { child, scope, history: '', offset: 0, exited: false, code: null }
    this.sessions.set(id, session)
    child.onData(data => {
      session.offset += data.length
      session.history = (session.history + data).slice(-historyLimit)
    })
    child.onExit(({ exitCode }) => { session.exited = true; session.code = exitCode })
    return { id, cwd }
  }

  handle(method, scope, p) {
    const session = this.sessions.get(p.id)
    if (!session || session.scope !== scope) throw new Error('终端会话已关闭。')
    if (method === 'panelTerminalRead') {
      const from = Math.max(0, Number(p.offset) || 0) - (session.offset - session.history.length)
      return { output: session.history.slice(Math.max(0, from)), offset: session.offset,
        exited: session.exited, code: session.code }
    }
    if (method === 'panelTerminalClose') {
      this.sessions.delete(p.id)
      if (!session.exited) session.child.kill()
      return
    }
    if (session.exited) throw new Error('终端会话已退出。')
    if (method === 'panelTerminalResize') {
      const { cols, rows } = dimensions(p)
      return session.child.resize(cols, rows)
    }
    if (method === 'panelTerminalInterrupt') return session.child.write('\x03')
    if (typeof p.input !== 'string' || p.input.length > 1024 * 1024) throw new Error('终端输入过长。')
    session.child.write(p.input)
  }

  close() {
    this.generation++
    for (const session of this.sessions.values()) if (!session.exited) session.child.kill()
    this.sessions.clear()
  }
  closeChat(chatId) {
    for (const [id, session] of this.sessions) {
      if (JSON.parse(session.scope)[0] !== chatId) continue
      this.sessions.delete(id)
      if (!session.exited) session.child.kill()
    }
  }
  hasLiveChat(chatId) {
    return Array.from(this.sessions.values()).some(session => !session.exited && JSON.parse(session.scope)[0] === chatId)
  }
}
