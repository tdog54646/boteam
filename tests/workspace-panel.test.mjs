import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Workspace } from '../desktop/workspace.mjs'

async function fixture(t) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'boteam-panel-')))
  const cwd = join(temp, 'project')
  await mkdir(cwd)
  const workspace = new Workspace({ root: join(temp, 'app'), adapters: {} })
  t.after(async () => { await workspace.close(); await rm(temp, { recursive: true, force: true }) })
  workspace.db.run('INSERT INTO accounts(id,provider,identity,info) VALUES(?,?,?,?)', 'account', 'codex', 'id', '{}')
  const botId = await workspace.handle('createBot', { name: 'Bot', cwd, accountId: 'account' })
  const chatId = await workspace.handle('createChat', { kind: 'direct', members: [botId] })
  return { temp, cwd, workspace, botId, call: (name, args) => workspace.handle(name, { chatId, botId, ...args }) }
}

test('files, project search and markdown saves share the conversation directory', async t => {
  const { call, cwd, temp } = await fixture(t)
  await mkdir(join(cwd, 'docs'))
  const file = { path: 'docs/notes.md' }
  await call('panelSave', { ...file, content: '笔记' })
  await assert.rejects(call('panelSave', { ...file, content: '覆盖' }))
  assert.deepEqual((await call('panelFiles', { path: 'docs' })).entries, [
    { ...file, name: 'notes.md', kind: 'file' },
  ])
  assert.equal((await call('panelSearch', { query: 'NOTES' })).entries[0].path, file.path)
  const loaded = await call('panelRead', file)
  assert.equal(loaded.content, '笔记')
  const saves = await Promise.allSettled(['版本一', '版本二'].map(content =>
    call('panelSave', { ...file, content, revision: loaded.revision })))
  assert.deepEqual(saves.map(s => s.status).sort(), ['fulfilled', 'rejected'])
  await writeFile(join(cwd, file.path), '外部已修改')
  await assert.rejects(call('panelSave', { ...file, content: '过期', revision: loaded.revision }))
  assert.equal(await readFile(join(cwd, file.path), 'utf8'), '外部已修改')
  await symlink(temp, join(cwd, 'outside'), 'dir')
  await assert.rejects(call('panelSave', { path: 'outside/escaped.md', content: 'x' }))
  await assert.rejects(call('panelRead', { path: '../app/workspace.sqlite3' }))
  await assert.rejects(call('panelFiles', { botId: 'stranger' }))
  assert.equal((await call('panelFiles', { chatId: null })).root, cwd)
})

test('a draft can use its project workspace before the first message creates the chat', async t => {
  const { temp, workspace, botId } = await fixture(t)
  const folder = join(temp, 'draft-project')
  await mkdir(folder)
  const projectId = await workspace.handle('createProject', { name: '草稿项目', folders: [folder] })
  const draft = { id: crypto.randomUUID(), kind: 'direct', members: [botId], projectId }
  const panel = { draft, botId, expectedProjectCwd: folder }
  await workspace.handle('panelSave', { ...panel, path: 'notes.md', content: '草稿内容' })
  assert.equal(workspace.db.get('SELECT id FROM chats WHERE id=?', draft.id), undefined)
  assert.equal(await readFile(join(folder, 'notes.md'), 'utf8'), '草稿内容')
  const { chatId } = await workspace.handle('sendDraft', { draft, recipients: [botId], text: '读取笔记' })
  const loaded = await workspace.handle('panelRead', { chatId, botId, path: 'notes.md' })
  assert.equal(loaded.content, '草稿内容')
})

test('Git changes include staged, unstaged and new text and use literal subdirectory paths', async t => {
  const { call, cwd, temp } = await fixture(t)
  assert.equal((await call('panelChanges')).repo, null)
  const git = (...args) => execFileSync('git', args, { cwd: temp })
  git('init', '-q')
  await writeFile(join(cwd, 'tracked[1].txt'), 'one\n')
  git('add', 'project')
  git('-c', 'user.name=Test', '-c', 'user.email=t@example.test', 'commit', '-qm', 'initial')
  await writeFile(join(cwd, 'tracked[1].txt'), 'two\n')
  git('add', 'project')
  await writeFile(join(cwd, 'tracked[1].txt'), 'two\nthree\n')
  await writeFile(join(cwd, 'new.txt'), 'new\nwithout newline')
  const result = await call('panelChanges')
  assert.ok(result.branch)
  assert.deepEqual(result.files.map(f => f.path).sort(), ['new.txt', 'tracked[1].txt'])
  assert.equal(result.files.find(f => f.path === 'new.txt').added, 2)
  assert.match((await call('panelDiff', { path: 'tracked[1].txt' })).diff, /\+three/)
  assert.match((await call('panelDiff', { path: 'tracked[1].txt' })).diff, /-one/)
  assert.match((await call('panelDiff', { path: 'new.txt' })).diff, /\+without newline/)
})

test('shell keeps cwd between commands, interrupts foreground work and closes by session id', { skip: process.platform === 'win32' }, async t => {
  const { call, cwd } = await fixture(t)
  const { id } = await call('panelTerminalStart', { cols: 90, rows: 33 })
  const readUntil = async regex => {
    for (let i = 0; i < 150; i++) {
      const result = await call('panelTerminalRead', { id, offset: 0 })
      if (regex.test(result.output)) return result
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.fail('未读取到终端输出 ' + regex)
  }
  await call('panelTerminalResize', { id, cols: 104, rows: 37 })
  await call('panelTerminalInput', { id, input: 'stty size\r' })
  await readUntil(/37 104/)
  await call('panelTerminalInput', { id, input: 'mkdir work && cd work\r' })
  await call('panelTerminalInput', { id, input: 'pwd; printf "waiting%s\\n" 123; sleep 20\r' })
  assert.ok((await readUntil(/waiting123/)).output.includes(join(cwd, 'work')))
  await call('panelTerminalInterrupt', { id })
  await call('panelTerminalInput', { id, input: 'printf "finished%s\\n" 456\r' })
  await readUntil(/finished456/)
  await call('panelTerminalClose', { id })
  await assert.rejects(call('panelTerminalRead', { id, offset: 0 }))
})

test('chat directory choices group members by resolved path and leave managed directories uncreated', async t => {
  const { workspace, botId, temp, cwd } = await fixture(t)
  const add = (name, directory = '') => workspace.handle('createBot', { accountId: 'account', name, cwd: directory })
  const same = await add('同一目录', cwd + '/.')
  const bound = await add('已有线程', cwd)
  const fresh = await add('默认目录')
  const chatId = await workspace.handle('createChat', { kind: 'group', name: '多工作区', members: [botId, same, bound, fresh] })
  const threadDir = join(temp, 'bound')
  await mkdir(threadDir)
  workspace.db.run('INSERT INTO threads VALUES(?,?,?,?,?)', chatId, bound, 'account', 'native-thread', threadDir)
  await workspace.handle('removeBot', { id: same })
  const managed = join(workspace.root, 'workspaces', chatId)
  const choices = await workspace.handle('chatDirectories', { chatId })
  assert.deepEqual(choices, [
    { botId, names: ['Bot', '同一目录'], directory: cwd },
    { botId: bound, names: ['已有线程'], directory: threadDir },
    { botId: fresh, names: ['默认目录'], directory: managed },
  ])
  assert.equal(await workspace.panel.directory({ chatId, botId: choices[1].botId }), threadDir)
  await assert.rejects(stat(managed), { code: 'ENOENT' })
  await assert.rejects(workspace.handle('chatDirectories', { chatId: 'gone' }), /会话/)
})
