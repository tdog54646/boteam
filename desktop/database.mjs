import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export class Database {
  constructor(root) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const path = join(root, 'workspace.sqlite3')
    this.db = new DatabaseSync(path)
    chmodSync(path, 0o600)
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE IF NOT EXISTS accounts(
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, identity TEXT NOT NULL, info TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '', UNIQUE(provider,identity)
      );
      CREATE TABLE IF NOT EXISTS bots(
        id TEXT PRIMARY KEY,accountId TEXT NOT NULL,name TEXT NOT NULL,cwd TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0,
        model TEXT NOT NULL DEFAULT '',effort TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS chats(
        id TEXT PRIMARY KEY, kind TEXT NOT NULL,name TEXT NOT NULL,updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_forks(
        chatId TEXT PRIMARY KEY REFERENCES chats(id),sourceChatId TEXT NOT NULL REFERENCES chats(id)
      );
      CREATE TABLE IF NOT EXISTS members(
        chatId TEXT NOT NULL REFERENCES chats(id),botId TEXT NOT NULL REFERENCES bots(id),PRIMARY KEY(chatId,botId)
      );
      CREATE TABLE IF NOT EXISTS messages(
        id TEXT PRIMARY KEY,chatId TEXT NOT NULL REFERENCES chats(id),botId TEXT,author TEXT NOT NULL,
        name TEXT NOT NULL,text TEXT NOT NULL,createdAt TEXT NOT NULL,recipients TEXT NOT NULL,taskId TEXT
      );
      CREATE TABLE IF NOT EXISTS tasks(
        id TEXT PRIMARY KEY,chatId TEXT NOT NULL REFERENCES chats(id),botId TEXT NOT NULL,accountId TEXT NOT NULL,
        messageId TEXT NOT NULL REFERENCES messages(id),status TEXT NOT NULL,tool TEXT NOT NULL,
        identity TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '',events TEXT NOT NULL DEFAULT '[]',
        approval TEXT,createdAt TEXT NOT NULL,verifiedKey TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS tasks_by_context ON tasks(chatId,botId,status);
      CREATE TABLE IF NOT EXISTS threads(
        chatId TEXT NOT NULL,botId TEXT NOT NULL,accountId TEXT NOT NULL,threadId TEXT NOT NULL,cwd TEXT NOT NULL,
        PRIMARY KEY(chatId,botId), UNIQUE(accountId,threadId)
      );
      CREATE TABLE IF NOT EXISTS composer_settings(
        chatId TEXT NOT NULL REFERENCES chats(id),botId TEXT NOT NULL REFERENCES bots(id),
        model TEXT,effort TEXT,permission TEXT NOT NULL DEFAULT 'default',PRIMARY KEY(chatId,botId)
      );
      CREATE TABLE IF NOT EXISTS context_usage(
        chatId TEXT NOT NULL,botId TEXT NOT NULL,used INTEGER NOT NULL,
        "limit" INTEGER NOT NULL,model TEXT NOT NULL,updatedAt TEXT NOT NULL,PRIMARY KEY(chatId,botId)
      );
      CREATE TABLE IF NOT EXISTS quota_usage(
        accountId TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,model TEXT NOT NULL,
        windows TEXT NOT NULL,updatedAt TEXT NOT NULL,PRIMARY KEY(accountId,model)
      );
      CREATE TABLE IF NOT EXISTS attachments(
        id TEXT PRIMARY KEY,scope TEXT NOT NULL,name TEXT NOT NULL,size INTEGER NOT NULL,
        kind TEXT NOT NULL,messageId TEXT REFERENCES messages(id)
      );
      CREATE INDEX IF NOT EXISTS attachments_by_scope ON attachments(scope,messageId);
      CREATE INDEX IF NOT EXISTS attachments_by_message ON attachments(messageId);
      CREATE TABLE IF NOT EXISTS attachment_folders(
        id TEXT PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
        fileCount INTEGER NOT NULL,skippedCount INTEGER NOT NULL,entries TEXT NOT NULL
      );
      UPDATE tasks SET status='interrupted',approval=NULL,error='上次运行因应用关闭而中断，可继续发送消息。'
        WHERE status IN ('running','queued','approval');
    `)
    const taskColumns = this.all('PRAGMA table_info(tasks)').map(column => column.name)
    if (!taskColumns.includes('verifiedKey')) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN verifiedKey TEXT NOT NULL DEFAULT ''")
    }
    if (!taskColumns.includes('runSettings'))
      this.db.exec("ALTER TABLE tasks ADD COLUMN runSettings TEXT NOT NULL DEFAULT '{}'")
    if (!this.all('PRAGMA table_info(composer_settings)').some(c => c.name === 'planMode'))
      this.db.exec('ALTER TABLE composer_settings ADD COLUMN planMode INTEGER NOT NULL DEFAULT 0')
    const columns = this.all('PRAGMA table_info(bots)').map((column) => column.name)
    this.transaction(() => {
      if (!columns.includes('model')) this.db.exec("ALTER TABLE bots ADD COLUMN model TEXT NOT NULL DEFAULT ''")
      if (!columns.includes('effort')) this.db.exec("ALTER TABLE bots ADD COLUMN effort TEXT NOT NULL DEFAULT ''")
    })
  }
  get(sql, ...args) {
    return this.db.prepare(sql).get(...args)
  }
  all(sql, ...args) {
    return this.db.prepare(sql).all(...args)
  }
  run(sql, ...args) {
    return this.db.prepare(sql).run(...args)
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  account(id) {
    const row = this.get('SELECT * FROM accounts WHERE id=?', id)
    if (!row) throw new Error('账号已移除。')
    const { info, ...data } = row
    return { ...JSON.parse(info), ...data }
  }
  snapshot() {
    const accounts = this.all('SELECT id FROM accounts').map(({ id }) => {
      const { credentialSource, managed, ...account } = this.account(id)
      return account
    })
    const byChat = new Map()
    for (const { chatId, botId } of this.all('SELECT * FROM members ORDER BY rowid')) {
      if (!byChat.has(chatId)) byChat.set(chatId, [])
      byChat.get(chatId).push(botId)
    }
    const byMessage = new Map()
    for (const {messageId, fileCount, skippedCount, ...file} of this.all(
      'SELECT messageId,a.id,name,size,kind,fileCount,skippedCount FROM attachments a LEFT JOIN attachment_folders USING(id) WHERE messageId IS NOT NULL ORDER BY a.rowid',
    )) {
      if (!byMessage.has(messageId)) byMessage.set(messageId, [])
      byMessage.get(messageId).push(file.kind === 'folder' ? { ...file, fileCount, skippedCount } : file)
    }
    return {
      composerSettings: this.all('SELECT * FROM composer_settings').map(row => ({
        ...row, planMode: Boolean(row.planMode) || row.permission === 'plan',
      })),
      contextUsage: this.all('SELECT * FROM context_usage'),
      quotas: this.all('SELECT * FROM quota_usage').map(q => ({
        ...q, scope: q.model ? 'model' : 'account',
        windows: JSON.parse(q.windows).filter(w => w.resetsAt == null || w.resetsAt > Date.now()),
      })).filter(q => q.windows.length),
      onboarded: this.get("SELECT value FROM settings WHERE key='onboarded'")?.value === 'yes',
      accounts,
      bots: this.all('SELECT * FROM bots ORDER BY rowid').map((b) => ({
        ...b,
        archived: Boolean(b.archived),
      })),
      chats: this.all(`SELECT c.*,f.sourceChatId FROM chats c LEFT JOIN chat_forks f ON c.id=f.chatId
        ORDER BY c.updatedAt DESC,c.rowid DESC`).map((c) => ({
        ...c,
        members: byChat.get(c.id) || [],
      })),
      messages: this.all('SELECT * FROM messages ORDER BY rowid').map((m) => ({
        ...m,
        attachments: byMessage.get(m.id) || [],
        recipients: JSON.parse(m.recipients),
      })),
      tasks: this.all('SELECT * FROM tasks ORDER BY rowid').map((t) => ({
        ...t,
        runSettings: JSON.parse(t.runSettings),
        events: JSON.parse(t.events),
        approval: JSON.parse(t.approval),
      })),
    }
  }
}
