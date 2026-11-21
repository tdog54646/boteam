import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Database } from '../desktop/database.mjs'

function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'boteam-group-db-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

const messageColumns = 'id,chatId,botId,author,name,text,createdAt,recipients,taskId'
function writeTurn(db, id, { chat = 'group', status = 'done', settings = {}, task = true,
  question = id, reply = id + ' reply' } = {}) {
  const insert = db.prepare('INSERT INTO messages(' + messageColumns + ') VALUES(?,?,?,?,?,?,?,?,?)')
  insert.run(id, chat, null, 'user', '我', question, '', '["bot"]', null)
  insert.run(id + '-reply', chat, 'bot', 'bot', '助手', reply, '', '[]', id + '-task')
  if (task) db.prepare(`INSERT INTO tasks(id,chatId,botId,accountId,messageId,status,tool,createdAt,runSettings)
    VALUES(?,?,'bot','account',?,?,'codex','',?)`).run(id + '-task', chat, id, status, JSON.stringify(settings))
}

function legacyDatabase(root) {
  const legacy = new DatabaseSync(join(root, 'workspace.sqlite3'))
  legacy.exec(`
    CREATE TABLE chats(id TEXT PRIMARY KEY,kind TEXT,name TEXT,updatedAt TEXT);
    CREATE TABLE accounts(id TEXT PRIMARY KEY,provider TEXT,identity TEXT,info TEXT,note TEXT);
    CREATE TABLE messages(id TEXT PRIMARY KEY,chatId TEXT,botId TEXT,author TEXT,name TEXT,text TEXT,
      createdAt TEXT,recipients TEXT,taskId TEXT);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,chatId TEXT,botId TEXT,accountId TEXT,messageId TEXT,status TEXT,
      tool TEXT,identity TEXT,error TEXT,events TEXT DEFAULT '[]',approval TEXT,createdAt TEXT,runSettings TEXT);
    INSERT INTO chats VALUES('group','group','项目群',''),('other','group','另一个群',''),('direct','direct','私聊','');
    INSERT INTO accounts VALUES('account','codex','test','{}','');
  `)
  return legacy
}

test('legacy groups publish only classified public text once, in the original display order', t => {
  const root = directory(t)
  const legacy = legacyDatabase(root)
  writeTurn(legacy, 'direct', { chat: 'direct' })
  writeTurn(legacy, 'first')
  writeTurn(legacy, 'other', { chat: 'other' })
  writeTurn(legacy, 'review', { settings: { slashCommand: 'review' }, question: '/review 私有审查参数' })
  writeTurn(legacy, 'compact', { settings: { slashCommand: 'compact' } })
  writeTurn(legacy, 'goal', { settings: { goalObjective: '单独目标' } })
  writeTurn(legacy, 'failed', { status: 'failed' })
  writeTurn(legacy, 'running', { status: 'running' })
  writeTurn(legacy, 'unknown', { task: false })
  writeTurn(legacy, 'attachment', { question: '', reply: '公开的附件结论' })
  writeTurn(legacy, 'empty', { reply: ' \n\t' })
  writeTurn(legacy, 'missing-command-settings', { question: '/compact' })
  writeTurn(legacy, 'missing-goal-settings', { question: '目标 · 个人目标参数' })
  // Metadata from the ordinary composer distinguishes literal slash text from a selected command.
  writeTurn(legacy, 'literal', { question: '/api/v1 这个接口应该怎么命名？', settings: { permission: 'default' } })
  legacy.close()

  let db = new Database(root)
  const published = () => db.snapshot().messages.filter(m => m.publishSeq != null)
    .map(m => [m.id, m.publishSeq])
  const expected = [
    ['first', 1], ['first-reply', 2], ['other', 1], ['other-reply', 2],
    ['failed', 3], ['running', 4], ['attachment-reply', 5], ['empty', 6], ['literal', 7], ['literal-reply', 8],
  ]
  try {
    assert.deepEqual(published(), expected)
    assert.equal(db.snapshot().tasks.find(t => t.id === 'running-task').status, 'interrupted')
    assert.ok(db.snapshot().messages.every(m => m.replyToMessageId === null && m.nativeThreadId === null))
    assert.ok(db.snapshot().tasks.every(t => t.groupCutoff === null))
    // A task with unpublished content created after upgrading is never retrospectively published on restart.
    writeTurn(db.db, 'after-upgrade')
    db.db.close()
    db = new Database(root)
    assert.deepEqual(published(), expected)
    assert.deepEqual(db.all('SELECT * FROM group_delivery'), [])
  } finally {
    db.db.close()
  }
})

test('archives older than runSettings retain ordinary text and keep ambiguous native commands private', t => {
  const root = directory(t)
  const legacy = legacyDatabase(root)
  writeTurn(legacy, 'ordinary', { question: '/api/v1 的响应是什么？' })
  writeTurn(legacy, 'unknown-control', { question: '/review /private/notes' })
  writeTurn(legacy, 'unknown-goal', { question: '目标 · 个人目标' })
  legacy.exec('ALTER TABLE tasks DROP COLUMN runSettings')
  legacy.close()

  const db = new Database(root)
  try {
    assert.deepEqual(db.snapshot().messages.filter(m => m.publishSeq !== null).map(m => m.id),
      ['ordinary', 'ordinary-reply'])
  } finally {
    db.db.close()
  }
})

test('publication is idempotent and a transaction rollback preserves the group boundary', t => {
  const db = new Database(directory(t))
  try {
    db.db.exec("INSERT INTO chats VALUES('group','group','群',''),('other','group','另一个群','')")
    writeTurn(db.db, 'first')
    writeTurn(db.db, 'second')
    assert.equal(db.groupBoundary('group'), 0)
    assert.equal(db.transaction(() => db.publishGroupMessage('group', 'first')), 1)
    assert.equal(db.transaction(() => db.publishGroupMessage('group', 'first')), 1)
    assert.throws(() => db.transaction(() => {
      assert.equal(db.publishGroupMessage('group', 'second'), 2)
      throw new Error('rollback')
    }), /rollback/)
    assert.equal(db.groupBoundary('group'), 1)
    assert.throws(() => db.transaction(() => db.publishGroupMessage('other', 'first')))
    assert.equal(db.groupBoundary('other'), 0)
    assert.equal(db.transaction(() => db.publishGroupMessage('group', 'second')), 2)
  } finally {
    db.db.close()
  }
})
