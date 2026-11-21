import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Database } from '../desktop/database.mjs'
import { groupPrompt } from '../desktop/group-context.mjs'

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'group-input-'))
  const db = new Database(root)
  t.after(() => { db.db.close(); rmSync(root, { recursive: true, force: true }) })
  db.db.exec(`
    INSERT INTO chats VALUES ('room','group','群',''), ('other','group','另一个群',''), ('direct','direct','私聊','');
    INSERT INTO bots(id,accountId,name,cwd) VALUES ('a','account','研究员',''), ('b','account','评审员','');
  `)
  function message(id, seq, text, { chat = 'room', bot, thread = null, replyTo = null } = {}) {
    db.run(`INSERT INTO messages(id,chatId,botId,author,name,text,createdAt,recipients,publishSeq,nativeThreadId,replyToMessageId)
      VALUES(?,?,?,?,?,?,'',?,?,?,?)`, id, chat, bot || null, bot ? 'bot' : 'user',
      bot ? (bot === 'a' ? '研究员' : '评审员') : '我', text, bot ? '[]' : '["a","b"]', seq, thread, replyTo)
  }
  const build = (args = {}) => groupPrompt(db, { chatId: 'room', bot: { id: 'b', name: '评审员', model: 'model-b' },
    threadId: 'thread-b', messageId: 'now', cutoff: 99, prompt: '当前要求和本轮附件', ...args })
  return { db, message, build }
}

test('only published public text in this snapshot reaches the addressed native thread', t => {
  const { db, message, build } = setup(t)
  message('past', 1, '已经送达')
  message('question', 2, '早先的问题')
  message('answer', 3, '带数字的答案 3%', { bot: 'a', replyTo: 'question' })
  message('mine', 4, '此原生线程已写出的答复', { bot: 'b', thread: 'thread-b' })
  message('my-other-thread', 5, '此成员旧线程的一句话', { bot: 'b', thread: 'old' })
  message('now', 6, '当前已存储正文')
  message('future', 7, '入队后才发布')
  message('draft', null, '未完成回复', { bot: 'a' })
  message('other', 1, '另一个群内容', { chat: 'other' })
  message('private', 1, '私聊内容', { chat: 'direct' })
  db.run('INSERT INTO group_delivery(chatId,botId,threadId,throughSeq) VALUES(?,?,?,?)', 'room','b','thread-b',1)
  db.run("INSERT INTO attachments VALUES('file','scope','秘密附件',35,'file','answer')")

  const result = build({ cutoff: 6 })
  assert.match(result, /用户.*研究员.*评审员/)
  assert.match(result, /研究员[^\n]*回复[^\n]*#2/)
  assert.ok(result.indexOf('早先的问题') < result.indexOf('带数字的答案 3%'))
  assert.ok(result.indexOf('带数字的答案 3%') < result.indexOf('此成员旧线程的一句话'))
  assert.ok(result.endsWith('当前要求和本轮附件'))
  assert.doesNotMatch(result, /当前已存储正文|已经送达|此原生线程已写出|入队后才发布|未完成回复|另一个群内容|私聊内容|秘密附件/)
  const replacement = build({ cutoff: 6, threadId: 'new-thread' })
  assert.match(replacement, /已经送达/)
  assert.match(replacement, /此原生线程已写出的答复/)
})

test('explicit quote restores even delivered text with line breaks and appears once', t => {
  const { db, message, build } = setup(t)
  const source = '原文第一行\n```\n不可丢失的第二行 2% / 5 分钟\n```'
  message('source', 1, source, { bot: 'b', thread: 'thread-b' })
  message('now', 2, '专门提问', { replyTo: 'source' })
  db.run("INSERT INTO group_delivery VALUES('room','b','thread-b',1)")
  for (const threadId of ['thread-b', 'another-thread']) {
    const text = build({ threadId })
    assert.equal(text.split(source).length, 2)
    assert.match(text, /引用[^\n]*评审员/)
    assert.ok(text.endsWith('当前要求和本轮附件'))
  }
})

test('first message passes through byte-for-byte; invalid references cannot expose other threads', t => {
  const { db, message, build } = setup(t)
  message('now', 1, '普通请求')
  assert.equal(build(), '当前要求和本轮附件')
  message('elsewhere', 1, '私有内容', { chat: 'other' })
  db.run("UPDATE messages SET replyToMessageId='elsewhere' WHERE id='now'")
  assert.throws(() => build(), /引用/)
})

test('bounded recent history keeps older attributed excerpts and identifies omitted messages', t => {
  const { db, message, build } = setup(t)
  db.run("INSERT INTO context_usage VALUES('room','b',0,16000,'model-b','')")
  for (let seq = 1; seq <= 45; seq++) {
    message('m' + seq, seq, '唯一开头' + seq + '「' + '甲'.repeat(160) + '」完整结尾' + seq, { bot: 'a' })
  }
  message('now', 46, '本轮')
  const text = build()
  assert.match(text, /摘录/)
  assert.match(text, /省略/)
  assert.match(text, /研究员/)
  assert.match(text, /唯一开头1「/)
  assert.doesNotMatch(text, /完整结尾1(?!\d)/)
  assert.match(text, /完整结尾45/)
  assert.ok(Buffer.byteLength(text) < 5200)
})

test('required quote is complete or the member fails for its known model limit', t => {
  const { db, message, build } = setup(t)
  const quote = '原文'.repeat(900)
  message('quote', 1, quote)
  message('now', 2, '追问', { replyTo: 'quote' })
  db.run("INSERT INTO context_usage VALUES('room','b',0,1200,'model-b','')")
  assert.throws(() => build(), /窗口|上限/)
  db.run("UPDATE context_usage SET \"limit\"=2400")
  assert.ok(build().includes(quote))
  db.run("UPDATE context_usage SET \"limit\"=100,model='old-model'")
  assert.ok(build().includes(quote))
  db.run("UPDATE context_usage SET model=''")
  assert.ok(build().includes(quote))
  db.run("UPDATE context_usage SET model='previous-explicit-model'")
  assert.ok(build({ bot: { id: 'b', name: '评审员', model: '' } }).includes(quote))
})

test('an oversized newest reply still leaves room for preceding complete messages', t => {
  const { db, message, build } = setup(t)
  db.run("INSERT INTO context_usage VALUES('room','b',0,12000,'model-b','')")
  for (let seq = 1; seq < 10; seq++) message('m' + seq, seq, '短发言' + seq + '！')
  message('huge', 10, '长'.repeat(20000))
  message('now', 11, '提问')
  const text = build()
  assert.match(text, /短发言9！/)
  assert.match(text, /长长长/)
  assert.ok(text.indexOf('短发言9！') < text.indexOf('长长长'))
  assert.match(text, /省略.*#10/)
})

test('omission spans exclude the explicitly quoted row and the member native reply', t => {
  const { db, message, build } = setup(t)
  db.run("INSERT INTO context_usage VALUES('room','b',0,3000,'model-b','')")
  for (const seq of [1,2,3,4,5,6]) {
    message('m' + seq, seq, seq === 3 ? '明确引用' : '很长'.repeat(700),
      seq === 5 ? { bot: 'b', thread: 'thread-b' } : { bot: 'a' })
  }
  message('now', 7, '提问', { replyTo: 'm3' })
  assert.match(build(), /省略[^\n]*#1–#2、#4、#6/)
})

test('two identically named bots have distinct authors, recipients and current member identity', t => {
  const { db, message, build } = setup(t)
  db.run("UPDATE bots SET name='同名'")
  message('m1', 1, '第一位的回答', { bot: 'a' })
  message('m2', 2, '第二位的回答', { bot: 'b' })
  db.run("UPDATE messages SET name='同名'")
  message('now', 3, '下一问')
  const text = build({ bot: { id: 'b', name: '同名' } })
  assert.match(text, /同名.*a.*\n[^\n]*\n第一位的回答/)
  assert.match(text, /同名.*b.*\n[^\n]*\n第二位的回答/)
  assert.match(text, /当前成员[^\n]*同名[^\n]*b/)
  assert.match(text, /当前请求.*同名.*a.*同名.*b/)
})
