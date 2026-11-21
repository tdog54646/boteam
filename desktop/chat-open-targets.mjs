import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { nativeEnv } from './native.mjs'

const editors = [
  { id: 'vscode', label: 'Visual Studio Code', bin: 'code', mac: 'Visual Studio Code.app', windows: ['Microsoft VS Code', 'Code.exe'] },
  { id: 'cursor', label: 'Cursor', bin: 'cursor', mac: 'Cursor.app', windows: ['cursor', 'Cursor.exe'] },
]

async function firstAvailable(paths, directory = false) {
  for (const file of paths) {
    const info = await stat(file).catch(() => null)
    if (directory ? info?.isDirectory() : info?.isFile() && await access(file, constants.X_OK).then(() => true, () => false))
      return file
  }
}

async function targets() {
  const result = new Map()
  const mac = process.platform === 'darwin', win = process.platform === 'win32'
  result.set('finder', { label: mac ? '访达' : win ? '文件资源管理器' : '文件管理器' })
  const search = name => firstAvailable(nativeEnv().PATH.split(delimiter).map(dir => join(dir, name)))
  if (mac) {
    result.set('terminal', { label: '终端', bin: '/usr/bin/open', args: dir => ['-b', 'com.apple.Terminal', dir] })
  } else if (win) {
    const bin = await search('wt.exe')
    result.set('terminal', bin ? { label: 'Windows Terminal', bin, args: dir => ['-d', dir] } :
      { label: 'PowerShell', bin: 'powershell.exe', args: () => ['-NoLogo', '-NoExit'] })
  } else {
    for (const name of ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']) {
      const bin = await search(name)
      if (bin) { result.set('terminal', { label: '终端', bin, args: () => [] }); break }
    }
  }
  await Promise.all(editors.map(async editor => {
    let bin
    let args = dir => [dir]
    if (mac) {
      const bundle = await firstAvailable(['/Applications', join(homedir(), 'Applications')].map(dir => join(dir, editor.mac)), true)
      if (bundle) { bin = '/usr/bin/open'; args = dir => ['-a', bundle, dir] }
    } else if (win) {
      bin = await firstAvailable([process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'),
        process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean).map(base => join(base, ...editor.windows)))
    }
    bin ||= await search(editor.bin)
    if (bin) result.set(editor.id, { label: editor.label, bin, args })
  }))
  return result
}

export async function chatOpenTargets() {
  const available = await targets()
  return ['finder', 'terminal', ...editors.map(editor => editor.id)].filter(id => available.has(id))
    .map(id => ({ id, label: available.get(id).label }))
}

export async function openChatDirectory(id, directory, shell) {
  if (id === 'finder') {
    const error = await shell.openPath(directory)
    if (error) throw new Error(error)
    return
  }
  const app = (await targets()).get(id)
  if (!app?.bin) throw new Error('本机未找到所选应用。')
  const args = app.args(directory)
  if (process.platform === 'darwin' && app.bin === '/usr/bin/open') {
    await promisify(execFile)(app.bin, args, { cwd: directory })
    return
  }
  await new Promise((resolve, reject) => {
    const child = spawn(app.bin, args, { cwd: directory, stdio: 'ignore', detached: true })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}
