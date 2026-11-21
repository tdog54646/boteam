import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Database } from '../desktop/database.mjs'
import { chatText, linkedChatId, requireChat } from '../desktop/chat-transfer.mjs'
import { Accounts } from '../desktop/accounts.mjs'
import { Workspace } from '../desktop/workspace.mjs'

test('BoTeam links address a single local chat; markdown shares only its transcript and attachment names', async t => {
  const root = await mkdtemp(join(tmpdir(), 'boteam-share-'))
  const db = new Database(root)
  t.after(async () => { db.db.close(); await rm(root, { recursive: true, force: true }) })
  const id = randomUUID(), other = randomUUID()
  for (const key of [id, other]) db.run('INSERT INTO chats(id,kind,name,updatedAt) VALUES(?,?,?,?)', key, 'direct', '项目笔记', 'now')
  const add = (msg, chat, author, name, text) => db.run(
    "INSERT INTO messages(id,chatId,author,name,text,createdAt,recipients) VALUES(?,?,?,?,?,'now','[]')",
    msg, chat, author, name, text)
  add('question', id, 'user', '我', '检查进度')
  add('answer', id, 'bot', '助手', '已完成')
  add('unrelated', other, 'bot', '助手', '另一场对话')
  db.run("INSERT INTO attachments(id,scope,name,size,kind,messageId) VALUES('file','scope','文档.md',10,'file','question')")
  const chat = requireChat(db, id)
  const url = chatText(db, chat, 'link')
  assert.equal(linkedChatId(url), id)
  for (const invalid of [url + '?action=delete', url + '/other', url.replace('chat/', 'user@chat/'), 'file:///a', null])
    assert.equal(linkedChatId(invalid), null)
  const markdown = chatText(db, chat, 'text')
  assert.ok(markdown.startsWith('# 项目笔记'))
  assert.match(markdown, /## 用户\n\n检查进度[\s\S]*附件[\s\S]*文档\.md[\s\S]*## Bot · 助手\n\n已完成/)
  assert.ok(!markdown.includes('另一场对话'))
  assert.throws(() => requireChat(db, randomUUID()))
})

test('closing one native window cancels only its own authorization', () => {
  const [a, b] = [{}, {}]
  const first = { owner: a, requestId: 'first', controller: new AbortController() }
  const second = { owner: b, requestId: 'second', controller: new AbortController() }
  const accounts = Object.create(Accounts.prototype)
  accounts.logins = new Map([['codex', first], ['claude', second]])
  assert.equal(accounts.cancelLogin({ requestId: 'second' }, a), false)
  accounts.cancelAllLogins(a)
  assert.equal(first.controller.signal.aborted, true)
  assert.equal(second.controller.signal.aborted, false)
  assert.equal(accounts.cancelLogin({ requestId: 'second' }, b), true)
})

test('group export keeps mentions, quoted replies and attachment-only messages from the send flow', async t => {
  const root = await mkdtemp(join(tmpdir(), 'boteam-group-export-'))
  const workspace = new Workspace({ root, adapters: { codex: { async run({ account, bot, emit }) {
    emit({ type: 'identity', value: bot.name, key: account.identity })
    emit({ type: 'text', value: '请核对附件' })
  } } } })
  t.after(async () => { await workspace.close(); await rm(root, { recursive: true, force: true }) })
  workspace.db.run(`INSERT INTO accounts(id,provider,identity,info) VALUES('a','codex','test','{"status":"ready"}')`)
  const members = []
  for (const name of ['排版', '审稿']) members.push(await workspace.handle('createBot', { name, accountId: 'a' }))
  const chatId = await workspace.handle('createChat', { name: '编辑室', kind: 'group', members })
  await workspace.handle('send', { chatId, recipients: [members[0]], text: '排版完成了吗？' })
  await Promise.all(workspace.lanes.values())
  const reply = workspace.snapshot().messages.find(message => message.botId === members[0])
  const [attachment] = await workspace.handle('addAttachments', { scope: chatId, files: [{ name: '样稿.md', text: '附件内容' }] })
  await workspace.handle('send', { chatId, recipients: members, attachmentIds: [attachment.id], replyToMessageId: reply.id })
  await Promise.all(workspace.lanes.values())
  const text = chatText(workspace.db, requireChat(workspace.db, chatId), 'text')
  assert.match(text, /发送给 @排版、@审稿[\s\S]*> Bot · 排版\n> 请核对附件[\s\S]*附件\n\n- 样稿\.md/)
  assert.ok(!text.includes('附件内容'))
})
