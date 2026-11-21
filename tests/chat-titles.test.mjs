import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Workspace } from '../desktop/workspace.mjs'

async function fixture(t, onRun = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'boteam-titles-'))
  const options = { root, adapters: { codex: { run: async input => {
    input.emit({ type: 'identity', key: 'fixture', value: 'Local fixture' })
    await onRun(input)
    input.emit({ type: 'text', value: 'fixture result' })
  } } } }
  let app = new Workspace(options)
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }) })
  app.db.run("INSERT INTO accounts(id,provider,identity,info) VALUES('a','codex','fixture',?)", JSON.stringify({ status: 'ready' }))
  const bots = await Promise.all(['Alpha Writer', '乙'].map(name => app.handle('createBot', { accountId: 'a', name })))
  return {
    get app() { return app }, bots,
    chat: (kind = 'direct', name) => app.handle('createChat', { members: kind === 'direct' ? [bots[0]] : bots, kind, name }),
    send: (chatId, text, recipients = [bots[0]], attachmentIds = []) => app.handle('send', { chatId, recipients, text, attachmentIds }),
    name: chatId => app.db.get('SELECT name FROM chats WHERE id=?', chatId).name,
    suggest: chatId => app.handle('suggestChatTitle', { chatId }),
    drain: () => Promise.all(app.lanes.values()),
    restart: async () => { await app.close(); app = new Workspace(options) },
  }
}

test('only the first ordinary request may name a chat, including parallel recipients and overlapping sends', async t => {
  const calls = [], gate = Promise.withResolvers()
  const f = await fixture(t, async ({ bot, titleRequest, emit }) => {
    calls.push({ bot: bot.id, description: titleRequest?.() || null })
    await gate.promise
    emit({ type: 'title', value: bot.id === f.bots[0] ? '原生任务标题' : '其他成员的标题' })
  })
  const chat = await f.chat('group')
  assert.equal(f.name(chat), '新群聊')
  assert.equal(await f.suggest(chat), null)
  await f.app.handle('editGroup', { id: chat, members: f.bots, name: '新群聊' })
  await f.send(chat, '/compact', f.bots)
  gate.resolve()
  await f.drain()
  assert.equal(f.name(chat), '新群聊')
  const text = '@Alpha Writer @乙 你好，请帮我修复聊天面板。\n对比两个工作目录中的旧实现。密码="two private words"。\n```js\nconst omitted = 123\n```'
  await Promise.all([f.send(chat, text, f.bots), f.send(chat, '第二个请求', [f.bots[1]])])
  assert.equal(f.name(chat), '修复聊天面板')
  await f.drain()
  assert.equal(f.name(chat), '原生任务标题')
  assert.equal(await f.suggest(chat), '修复聊天面板')
  assert.equal(calls.filter(call => call.description).length, 1)
  const owner = calls.find(call => call.description)
  assert.equal(owner.bot, f.bots[0])
  assert.match(owner.description, /对比两个工作目录/)
  assert.doesNotMatch(owner.description, /private|omitted|@Alpha/)
})

test('manual names and explicitly named groups retain control over delayed or subsequent titles', async t => {
  const started = Promise.withResolvers(), finish = Promise.withResolvers()
  const f = await fixture(t, async ({ titleRequest, emit }) => {
    if (titleRequest) {
      started.resolve()
      await finish.promise
      assert.ok(!titleRequest())
    }
    emit({ type: 'title', value: '过时的自动名称' })
  })
  const chat = await f.chat()
  await f.send(chat, 'Please help me debug the sidebar selection. More context follows.')
  await started.promise
  assert.equal(f.name(chat), 'debug the sidebar selection')
  await f.app.handle('renameChat', { chatId: chat, name: '调试记录' })
  finish.resolve()
  await f.drain()
  assert.equal(f.name(chat), '调试记录')
  assert.equal(await f.suggest(chat), 'debug the sidebar selection')
  const group = await f.chat('group', '手工命名的群')
  await f.send(group, 'Compare the two approaches', f.bots)
  await f.drain()
  assert.equal(f.name(group), '手工命名的群')
})

test('local fallback handles attachments, code and private literals without reading file contents', async t => {
  const descriptions = []
  const f = await fixture(t, ({ titleRequest, emit }) => {
    descriptions.push(titleRequest?.())
    emit({ type: 'title', value: 'New Chat' })
  })
  const chat = await f.chat()
  const files = await f.app.handle('addAttachments', { scope: chat, files: [{ name: '导航稿.md', text: 'private file content' }] })
  await f.send(chat, '', [f.bots[0]], files.map(file => file.id))
  await f.drain()
  assert.equal(f.name(chat), '查看 导航稿.md')
  assert.equal(await f.suggest(chat), f.name(chat))
  const code = await f.chat()
  await f.send(code, '```js\nconst value = 42\n```')
  await f.drain()
  assert.equal(f.name(code), '分析代码片段')
  const sensitive = await f.chat()
  await f.send(sensitive, '检查 api_key="Confidential Value" 及 member@example.test 的 https://example.org/path?auth=secret')
  await f.drain()
  for (const value of [...descriptions, f.name(sensitive)]) assert.doesNotMatch(value, /private file content|value =|Confidential|Value|member@|auth=secret/i)
})

test('migration preserves existing history and manual names and only opts untouched default direct chats in', async t => {
  const f = await fixture(t)
  const empty = await f.chat(), old = await f.chat(), manual = await f.chat(), group = await f.chat('group', '旧群')
  await f.send(old, 'Fix the loading spinner')
  await f.drain()
  await f.app.handle('renameChat', { chatId: old, name: 'Alpha Writer' })
  await f.app.handle('renameChat', { chatId: manual, name: '以前的手动命名' })
  f.app.db.db.exec('DROP TABLE chat_title_requests')
  await f.restart()
  assert.deepEqual(f.app.db.all('SELECT chatId FROM chat_title_requests').map(row => row.chatId), [empty])
  assert.equal(await f.suggest(old), 'Fix the loading spinner')
  assert.equal(await f.suggest(manual), null)
  await Promise.all([empty, old, manual, group].map(chat => f.send(chat, '整理旧任务')))
  await f.drain()
  assert.deepEqual([empty, old, manual, group].map(f.name), ['整理旧任务', 'Alpha Writer', '以前的手动命名', '旧群'])
})
