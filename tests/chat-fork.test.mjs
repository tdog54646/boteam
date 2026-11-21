import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Workspace } from '../desktop/workspace.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'boteam-chat-fork-'))
  const calls = []
  const run = async scope => {
    calls.push(scope)
    scope.emit({ type: 'identity', key: scope.account.identity, value: scope.bot.name })
    scope.emit({ type: 'session', value: scope.threadId || `${scope.chatId}/${scope.bot.id}` })
    if (scope.prompt.endsWith('fail this turn')) throw new Error('offline')
    scope.emit({ type: 'text', value: 'reply from ' + scope.bot.name })
  }
  const codex = { run, forkChat: async (scope, { destinationChatId }) => ({ threadId: `${destinationChatId}/${scope.bot.id}` }) }
  const options = { root, adapters: { codex, claude: { run } }, makeThumbnail: async () => 'preview' }
  let ws = new Workspace(options)
  t.after(async () => { await ws.close(); await rm(root, { recursive: true, force: true }) })
  const bots = {}
  for (const name of Object.keys(options.adapters)) {
    ws.db.run('INSERT INTO accounts(id,provider,identity,info) VALUES(?,?,?,?)', name, name, name, '{"status":"ready"}')
    bots[name] = await ws.handle('createBot', { accountId: name, name })
  }
  return { get ws() { return ws }, bots, calls, codex,
    async restart() { await ws.close(); ws = new Workspace(options) },
    async send(chatId, recipients, text, extra) {
      const id = await ws.handle('send', { chatId, recipients, text, ...extra })
      await Promise.all(ws.lanes.values())
      return id
    },
    fork(chatId) { return ws.handle('forkChat', { chatId }) },
    messages(chatId) { return ws.snapshot().messages.filter(m => m.chatId === chatId) },
  }
}

test('a direct fork copies a stable timeline, files and settings and continues independently across restarts', async t => {
  const f = await fixture(t)
  const bot = f.bots.claude
  const parent = await f.ws.handle('createChat', { kind: 'direct', members: [bot] })
  const [file] = await f.ws.handle('addAttachments', { scope: parent, files: [{ name: 'logo.png', bytes: Uint8Array.of(137,80,78,71,13,10,26,10) }] })
  await f.send(parent, [bot], 'history-marker', { attachmentIds: [file.id] })
  const originalCwd = f.calls[0].cwd
  f.ws.db.run("INSERT INTO composer_settings(chatId,botId,model) VALUES(?,?,'m')", parent, bot)
  const child = await f.fork(parent)
  await f.send(parent, [bot], 'parent only')
  await f.restart()
  const history = f.messages(child)
  assert.deepEqual(history.map(m => m.text), ['history-marker', 'reply from claude'])
  assert.notEqual(history[0].id, f.messages(parent)[0].id)
  assert.equal(history[0].attachments[0].id, file.id)
  assert.equal(await f.ws.handle('attachmentThumbnail', { scope: child, id: file.id }), 'preview')
  assert.equal(f.ws.db.get('SELECT messageId FROM tasks WHERE id=?', history[1].taskId).messageId, history[0].id)
  await f.send(child, [bot], 'fail this turn')
  await f.send(child, [bot], 'first success')
  assert.match(f.calls.at(-1).prompt, /history-marker/)
  assert.match(f.calls.at(-1).prompt, /reply from claude/)
  assert.match(f.calls.at(-1).prompt, /logo\.png/)
  assert.doesNotMatch(f.calls.at(-1).prompt, /parent only/)
  assert.equal(f.calls.at(-1).bot.model, 'm')
  assert.equal(f.calls.at(-1).cwd, originalCwd)
  assert.equal(f.calls.at(-1).threadId, `${child}/${bot}`)
  await f.send(child, [bot], 'continued')
  assert.equal(f.calls.at(-1).prompt, 'continued')
  const grandchild = await f.fork(child)
  assert.equal(f.messages(grandchild)[0].attachments[0].id, file.id)
  assert.equal(await f.ws.handle('attachmentThumbnail', { scope: grandchild, id: file.id }), 'preview')
  assert.ok(f.messages(parent).every(m => m.text !== 'continued'))
})

test('a group fork remaps quotes, transfers native delivery and starts independent sessions for remaining members', async t => {
  const f = await fixture(t)
  const { codex, claude } = f.bots, members = [codex, claude]
  const parent = await f.ws.handle('createChat', { kind: 'group', name: '评审', members })
  await f.send(parent, [codex], 'prior marker')
  const reply = f.messages(parent).at(-1)
  await f.send(parent, [claude], 'review', { replyToMessageId: reply.id })
  const child = await f.fork(parent)
  const chat = f.ws.snapshot().chats.find(c => c.id === child)
  assert.equal(chat.sourceChatId, parent)
  assert.equal(chat.kind, 'group')
  assert.deepEqual(chat.members, members)
  const copied = f.messages(child)
  assert.equal(copied[2].replyToMessageId, copied[1].id)
  assert.notEqual(copied[1].id, reply.id)
  await f.send(child, [codex], 'continue')
  assert.equal(f.calls.at(-1).threadId, `${child}/${codex}`)
  assert.match(f.calls.at(-1).prompt, /reply from claude/)
  assert.doesNotMatch(f.calls.at(-1).prompt, /prior marker|reply from codex/)
  await f.send(child, [claude], 'new review', { replyToMessageId: copied[1].id })
  assert.equal(f.calls.at(-1).threadId, null)
  assert.match(f.calls.at(-1).prompt, /prior marker/)
  assert.match(f.calls.at(-1).prompt, /引用 #2/)
})

test('forking an empty chat succeeds and a failed native fork leaves no partial chat or lock', async t => {
  const f = await fixture(t)
  const bot = f.bots.codex
  const parent = await f.ws.handle('createChat', { kind: 'direct', members: [bot] })
  const empty = await f.fork(parent)
  assert.equal(f.messages(empty).length, 0)
  await f.send(parent, [bot], 'hello')
  const entered = Promise.withResolvers(), resume = Promise.withResolvers()
  let discarded = false
  f.codex.forkChat = async () => {
    entered.resolve()
    await resume.promise
    return { threadId: `${parent}/${bot}`, discard: () => { discarded = true } }
  }
  const fork = f.fork(parent)
  await entered.promise
  try {
    await assert.rejects(f.fork(parent), /稍后|正在/)
    await assert.rejects(f.ws.handle('send', { chatId: parent, recipients: [bot], text: 'busy' }), /稍后|正在/)
  } finally { resume.resolve() }
  await assert.rejects(fork)
  assert.equal(discarded, true)
  assert.equal(f.ws.snapshot().chats.length, 2)
  await f.send(parent, [bot], 'after failure')
  assert.equal(f.calls.at(-1).threadId, `${parent}/${bot}`)
})

test('forking a legacy member branch with no local timeline preserves the native lineage after restart', async t => {
  const f = await fixture(t)
  const bot = f.bots.codex
  const parent = await f.ws.handle('createChat', { kind: 'group', members: [bot, f.bots.claude], name: '项目' })
  await f.send(parent, [bot], 'visible in the source group')
  const origins = []
  f.codex.forkChat = async (scope, { destinationChatId }) => {
    origins.push(scope.threadId)
    return { threadId: destinationChatId + '/' + scope.bot.id }
  }
  const legacy = await f.ws.handle('forkChat', { chatId: parent, botId: bot })
  assert.equal(f.messages(legacy).length, 0)
  await f.restart()
  const child = await f.fork(legacy)
  await f.send(child, [bot], 'continue from the branch')
  assert.deepEqual(origins, [parent + '/' + bot, legacy + '/' + bot])
  assert.equal(f.calls.at(-1).threadId, child + '/' + bot)
  assert.equal(f.ws.snapshot().chats.find(c => c.id === child).kind, 'direct')
  assert.equal(f.messages(legacy).length, 0)
  f.codex.forkChat = null
  await assert.rejects(f.fork(legacy), /原生分支/)
})

test('an unacknowledged replay survives another fork even if the adapter now supports native branching', async t => {
  const f = await fixture(t)
  const bot = f.bots.claude
  const parent = await f.ws.handle('createChat', { kind: 'direct', members: [bot] })
  await f.send(parent, [bot], 'inherited marker')
  const child = await f.fork(parent)
  await f.send(child, [bot], 'fail this turn')
  f.ws.adapters.claude.forkChat = f.codex.forkChat
  const nested = await f.fork(child)
  await f.send(nested, [bot], 'continue')
  assert.match(f.calls.at(-1).prompt, /inherited marker/)
  assert.doesNotMatch(f.calls.at(-1).prompt, /fail this turn/)
})

test('full-chat fork blocks live tasks, rolls back all members and attachment links, and can be retried', async t => {
  const f = await fixture(t)
  const other = await f.ws.handle('createBot', { accountId: 'codex', name: 'Second' })
  const bots = [f.bots.codex, other]
  const source = await f.ws.handle('createChat', { kind: 'group', name: '组', members: bots })
  const [file] = await f.ws.handle('addAttachments', { scope: source, files: [{ name: 'large.bin', bytes: new Uint8Array(3 * 1024 * 1024) }] })
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const run = f.codex.run
  f.codex.run = async scope => {
    await run(scope)
    entered.resolve()
    await release.promise
  }
  await f.ws.handle('send', { chatId: source, recipients: bots, text: 'with file', attachmentIds: [file.id] })
  await entered.promise
  try { await assert.rejects(f.fork(source), /处理任务/) } finally { release.resolve() }
  await Promise.all(f.ws.lanes.values())
  let discardCount = 0
  const fork = f.codex.forkChat
  f.codex.forkChat = async (...args) => ({ ...await fork(...args), discard: () => { discardCount++ } })
  f.ws.db.db.exec("CREATE TEMP TRIGGER fail_attachment BEFORE INSERT ON fork_attachments BEGIN SELECT RAISE(ABORT,'forced rollback'); END")
  await assert.rejects(f.fork(source), /forced rollback/)
  assert.equal(discardCount, 2)
  assert.equal(f.ws.snapshot().chats.length, 1)
  assert.equal(f.ws.db.get('SELECT count(*) AS count FROM fork_attachments').count, 0)
  assert.equal(f.ws.db.get('SELECT count(*) AS count FROM threads').count, 2)
  f.ws.db.db.exec('DROP TRIGGER fail_attachment')
  const child = await f.fork(source)
  assert.equal(f.messages(child)[0].attachments[0].id, file.id)
  assert.equal(f.ws.db.get('SELECT count(*) AS count FROM attachments').count, 1)
})

test('settings and the working directory have independent lifetimes across branches', async t => {
  const f = await fixture(t)
  f.codex.permissionModes = ['default', 'read-only', 'full']
  const bot = f.bots.codex
  const source = await f.ws.handle('createChat', { kind: 'direct', members: [bot] })
  await f.ws.handle('setComposerSettings', { chatId: source, botId: bot, permission: 'read-only' })
  await f.send(source, [bot], 'first')
  const cwd = f.calls.at(-1).cwd
  const child = await f.fork(source)
  await f.ws.handle('setComposerSettings', { chatId: source, botId: bot, permission: 'full' })
  await f.ws.handle('editBot', { id: bot, cwd: f.ws.root, name: 'renamed' })
  await f.send(child, [bot], 'next')
  assert.equal(f.calls.at(-1).permission, 'read-only')
  assert.equal(f.calls.at(-1).cwd, cwd)
  assert.equal((await f.ws.nativeScope({ chatId: source, botId: bot })).permission, 'full')
  assert.equal((await f.ws.nativeScope({ chatId: child, botId: bot })).cwd, cwd)
  await rm(cwd, { recursive: true })
  await assert.rejects(f.ws.ensureChatDirectory(child, f.ws.bot(bot)), /目录/)
})

test('new-worktree forks preserve the index, tracked edits, untracked files and per-member working directories', async t => {
  const f = await fixture(t)
  const repo = join(f.ws.root, 'project')
  const docs = join(repo, 'docs')
  await mkdir(docs,{recursive:true})
  const git = (cwd,...args) => execFileSync('git',args,{cwd,encoding:'utf8'})
  git(repo,'init','-q')
  await writeFile(join(repo,'.gitignore'),'ignored.txt\n')
  await writeFile(join(docs,'file'),'committed\n')
  git(repo,'add','.')
  git(repo,'-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','base')
  await writeFile(join(docs,'file'),'staged\n')
  git(repo,'add','docs/file')
  await writeFile(join(docs,'file'),'unstaged\n')
  await writeFile(join(repo,'ignored.txt'),'ignored')
  await mkdir(join(repo,'extra'))
  await writeFile(join(repo,'extra','new file'),'untracked')
  for (const [provider,cwd] of [['codex',repo],['claude',docs]])
    await f.ws.handle('editBot',{id:f.bots[provider],name:provider,cwd})
  const members = Object.values(f.bots)
  const parent = await f.ws.handle('createChat',{kind:'group',members,name:'group'})
  const projectId = await f.ws.handle('createProject',{folders:[repo]})
  await f.ws.handle('moveChatToProject',{chatId:parent,projectId})
  await f.send(parent,members,'previous marker')
  let newDirectory
  f.codex.forkChat = async (source,{destinationChatId,destinationCwd}) => {
    assert.equal(source.cwd,repo)
    newDirectory=destinationCwd
    return {threadId:destinationChatId+'/'+source.bot.id}
  }
  const child = await f.ws.handle('forkChatInWorktree',{chatId:parent})
  assert.equal(f.ws.snapshot().chats.find(chat => chat.id===child).projectId,projectId)
  const destination = f.ws.chatDirectory(child,f.ws.bot(f.bots.codex))
  assert.equal(destination,newDirectory)
  assert.notEqual(await realpath(repo),await realpath(destination))
  assert.equal(f.ws.chatDirectory(child,f.ws.bot(f.bots.claude)),join(destination,'docs'))
  assert.equal(git(destination,'rev-parse','HEAD'),git(repo,'rev-parse','HEAD'))
  assert.equal(git(destination,'show',':docs/file'),'staged\n')
  assert.equal(await readFile(join(destination,'docs/file'),'utf8'),'unstaged\n')
  assert.equal(await readFile(join(destination,'extra/new file'),'utf8'),'untracked')
  assert.equal((await readdir(destination)).includes('ignored.txt'),false)
  await f.send(child,members,'next')
  assert.ok(f.calls.slice(-2).every(c=>c.cwd===destination||c.cwd===join(destination,'docs')))
  await writeFile(join(destination,'docs/file'),'edited in branch')
  assert.equal(await readFile(join(docs,'file'),'utf8'),'unstaged\n')
  const before=git(repo,'worktree','list','--porcelain')
  f.codex.forkChat = async () => {throw Error('injected fork failure')}
  await assert.rejects(f.ws.handle('forkChatInWorktree',{chatId:parent}),/injected/)
  assert.equal(git(repo,'worktree','list','--porcelain'),before)
  assert.equal(f.ws.snapshot().chats.length,2)
  await f.restart()
  assert.equal((await f.ws.nativeScope({chatId:child,botId:f.bots.codex})).cwd,destination)
})

test('a group with a non-Git member cannot leave a partial worktree or chat', async t => {
  const f=await fixture(t)
  const group=await f.ws.handle('createChat',{kind:'group',members:Object.values(f.bots),name:'group'})
  await assert.rejects(f.ws.handle('forkChatInWorktree',{chatId:group}),/Git/)
  assert.equal(f.ws.snapshot().chats.length,1)
})
