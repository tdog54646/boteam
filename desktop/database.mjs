import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { projectSnapshot } from './projects.mjs'

function publishLegacyGroupHistory(db) {
  // Old replies have a slot in the transcript, but no completion timestamp.
  // Reconstruct the baseline in display order. Only classify rows whose
  // originating task survives, regardless of current group membership.
  const candidates = db.prepare(`
    WITH classified AS MATERIALIZED (
      SELECT t.id,t.chatId,t.botId,t.messageId,t.status,
        CASE
          WHEN t.runSettings IS NULL OR NOT json_valid(t.runSettings) THEN 'unknown'
          WHEN json_type(t.runSettings) != 'object' THEN 'unknown'
          -- Pre-composer archives default to {}. A slash command (first token)
          -- or the native goal display cannot be distinguished from typed text.
          WHEN json(t.runSettings)='{}' AND (u.text GLOB '目标 · *' OR (u.text GLOB '/*' AND
            substr(u.text,1,instr(u.text || ' ',' ')-1) NOT GLOB '/*/*')) THEN 'unknown'
          WHEN json_type(t.runSettings,'$.goalObjective') IS NOT NULL THEN 'control'
          WHEN json_type(t.runSettings,'$.slashCommand') IS NULL THEN 'ordinary'
          -- Old /review bubbles did not store the native final findings separately from progress.
          ELSE 'control'
        END AS kind
      FROM tasks t JOIN chats c ON c.id=t.chatId AND c.kind='group'
      JOIN messages u ON u.id=t.messageId AND u.chatId=t.chatId AND u.author='user'
    ), ordinaryRequests AS (
      SELECT messageId,count(*) AS taskCount FROM classified GROUP BY messageId
      HAVING min(kind='ordinary')
    )
    SELECT m.id,m.chatId,m.text FROM messages m
    LEFT JOIN ordinaryRequests u ON m.id=u.messageId
    LEFT JOIN classified r ON r.id=m.taskId AND r.chatId=m.chatId AND r.botId=m.botId
    WHERE (m.author='user' AND u.taskCount=json_array_length(m.recipients))
       OR (m.author='bot' AND r.status='done' AND r.kind='ordinary')
    ORDER BY m.rowid`)
  const publish = db.prepare('UPDATE messages SET publishSeq=? WHERE id=?')
  const boundaries = new Map()
  for (const { id, chatId, text } of candidates.iterate()) {
    if (!text.trim()) continue
    const next = (boundaries.get(chatId) ?? 0) + 1
    publish.run(next, id)
    boundaries.set(chatId, next)
  }
}

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
      CREATE TABLE IF NOT EXISTS projects(
        id TEXT PRIMARY KEY,name TEXT NOT NULL,pinned INTEGER NOT NULL DEFAULT 0,
        sectionId TEXT REFERENCES chat_sections(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS project_folders(
        projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,path TEXT NOT NULL,position INTEGER NOT NULL,
        PRIMARY KEY(projectId,path),UNIQUE(projectId,position)
      );
      CREATE TABLE IF NOT EXISTS chat_projects(
        chatId TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
        projectId TEXT REFERENCES projects(id) ON DELETE SET NULL,cwd TEXT
      );
      CREATE TABLE IF NOT EXISTS chat_sections(
        id TEXT PRIMARY KEY,name TEXT NOT NULL COLLATE NOCASE UNIQUE
      );
      CREATE TABLE IF NOT EXISTS chat_organization(
        chatId TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
        pinned INTEGER NOT NULL DEFAULT 0,unread INTEGER NOT NULL DEFAULT 0,archived INTEGER NOT NULL DEFAULT 0,
        sectionId TEXT REFERENCES chat_sections(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS chat_forks(
        chatId TEXT PRIMARY KEY REFERENCES chats(id),sourceChatId TEXT NOT NULL REFERENCES chats(id)
      );
      CREATE TABLE IF NOT EXISTS members(
        chatId TEXT NOT NULL REFERENCES chats(id),botId TEXT NOT NULL REFERENCES bots(id),PRIMARY KEY(chatId,botId)
      );
      CREATE TABLE IF NOT EXISTS messages(
        id TEXT PRIMARY KEY,chatId TEXT NOT NULL REFERENCES chats(id),botId TEXT,author TEXT NOT NULL,
        name TEXT NOT NULL,text TEXT NOT NULL,createdAt TEXT NOT NULL,recipients TEXT NOT NULL,taskId TEXT,
        publishSeq INTEGER,replyToMessageId TEXT REFERENCES messages(id),nativeThreadId TEXT
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
      CREATE TABLE IF NOT EXISTS group_delivery(
        chatId TEXT NOT NULL REFERENCES chats(id),botId TEXT NOT NULL REFERENCES bots(id),
        threadId TEXT NOT NULL,throughSeq INTEGER NOT NULL,PRIMARY KEY(chatId,botId,threadId)
      );
      CREATE TABLE IF NOT EXISTS composer_settings(
        chatId TEXT NOT NULL REFERENCES chats(id),botId TEXT NOT NULL REFERENCES bots(id),
        model TEXT,effort TEXT,permission TEXT NOT NULL DEFAULT 'default',PRIMARY KEY(chatId,botId)
      );
      CREATE TABLE IF NOT EXISTS context_usage(
        chatId TEXT NOT NULL,botId TEXT NOT NULL,used INTEGER NOT NULL,
        "limit" INTEGER NOT NULL,model TEXT NOT NULL,updatedAt TEXT NOT NULL,PRIMARY KEY(chatId,botId)
      );
      CREATE TABLE IF NOT EXISTS pending_chat_goals(
        chatId TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,botId TEXT NOT NULL REFERENCES bots(id),
        objective TEXT NOT NULL,PRIMARY KEY(chatId,botId)
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
      CREATE TABLE IF NOT EXISTS fork_attachments(
        messageId TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        attachmentId TEXT NOT NULL REFERENCES attachments(id),PRIMARY KEY(messageId,attachmentId)
      );
      CREATE VIEW IF NOT EXISTS message_attachments AS
        SELECT messageId,id AS attachmentId FROM attachments WHERE messageId IS NOT NULL
        UNION ALL SELECT messageId,attachmentId FROM fork_attachments;
      CREATE TABLE IF NOT EXISTS fork_member_context(
        chatId TEXT NOT NULL REFERENCES chats(id),botId TEXT NOT NULL REFERENCES bots(id),
        cwd TEXT NOT NULL,seedMessageId TEXT REFERENCES messages(id),PRIMARY KEY(chatId,botId)
      );
      CREATE INDEX IF NOT EXISTS messages_by_chat ON messages(chatId);
      CREATE VIEW IF NOT EXISTS initial_project_chats AS
        SELECT c.id AS chatId FROM chats c
        WHERE NOT EXISTS(SELECT 1 FROM chat_organization o WHERE o.chatId=c.id AND o.archived=1)
        AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.chatId=c.id)
        AND NOT EXISTS(SELECT 1 FROM tasks t WHERE t.chatId=c.id)
        AND NOT EXISTS(SELECT 1 FROM threads t WHERE t.chatId=c.id)
        AND NOT EXISTS(SELECT 1 FROM chat_forks f WHERE f.chatId=c.id)
        AND NOT EXISTS(SELECT 1 FROM fork_member_context f WHERE f.chatId=c.id);
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
      if (!this.all('PRAGMA table_info(projects)').some(c => c.name === 'sectionId'))
        this.db.exec('ALTER TABLE projects ADD COLUMN sectionId TEXT REFERENCES chat_sections(id) ON DELETE SET NULL')
      if (!this.get("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='chat_title_requests'")) {
        this.db.exec(`CREATE TABLE chat_title_requests(chatId TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
          messageId TEXT,botId TEXT);
          INSERT INTO chat_title_requests(chatId)
          SELECT c.id FROM chats c JOIN members m ON c.id=m.chatId JOIN bots b ON b.id=m.botId
          WHERE c.kind='direct' AND c.name=b.name
            AND NOT EXISTS (SELECT 1 FROM messages WHERE chatId=c.id)
            AND NOT EXISTS (SELECT 1 FROM chat_forks WHERE chatId=c.id);`)
      }
      if (!this.get("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='native_fork_attachments'")) {
        this.db.exec(`CREATE TABLE native_fork_attachments(
          chatId TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,botId TEXT NOT NULL,
          attachmentId TEXT NOT NULL REFERENCES attachments(id),PRIMARY KEY(chatId,botId,attachmentId))`)
        // Older /fork branches have native prompts with attachment paths but no
        // copied local bubbles. Their first local turn bounds the inherited files.
        for (const f of this.all(`SELECT f.*,m.botId,coalesce((SELECT min(createdAt) FROM messages WHERE chatId=c.id),c.updatedAt) AS cutoff
          FROM chat_forks f JOIN chats c ON c.id=f.chatId JOIN members m ON m.chatId=c.id ORDER BY c.rowid`)) {
          this.retainNativeAttachments(f.sourceChatId, f.chatId, f.botId, f.cutoff)
        }
      }
      if (!columns.includes('model')) this.db.exec("ALTER TABLE bots ADD COLUMN model TEXT NOT NULL DEFAULT ''")
      if (!columns.includes('effort')) this.db.exec("ALTER TABLE bots ADD COLUMN effort TEXT NOT NULL DEFAULT ''")
      if (!taskColumns.includes('groupCutoff')) this.db.exec('ALTER TABLE tasks ADD COLUMN groupCutoff INTEGER')
      if (!this.all('PRAGMA table_info(messages)').some(c => c.name === 'publishSeq')) {
        this.db.exec(`
          ALTER TABLE messages ADD COLUMN publishSeq INTEGER;
          ALTER TABLE messages ADD COLUMN replyToMessageId TEXT REFERENCES messages(id);
          ALTER TABLE messages ADD COLUMN nativeThreadId TEXT;
        `)
        publishLegacyGroupHistory(this.db)
      }
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS messages_by_publication
        ON messages(chatId,publishSeq) WHERE publishSeq IS NOT NULL`)
    })
  }
  retainNativeAttachments(sourceId, chatId, botId, cutoff = null) {
    this.run(`INSERT OR IGNORE INTO native_fork_attachments(chatId,botId,attachmentId)
      SELECT ?,?,a.attachmentId FROM message_attachments a JOIN messages m ON m.id=a.messageId
      WHERE m.chatId=? AND (? IS NULL OR m.createdAt<=?) AND EXISTS (
        SELECT 1 FROM json_each(m.recipients) WHERE value=?)
      UNION ALL SELECT ?,?,attachmentId FROM native_fork_attachments WHERE chatId=? AND botId=?`,
      chatId, botId, sourceId, cutoff, cutoff, botId, chatId, botId, sourceId, botId)
  }
  groupBoundary(chatId) {
    return this.get(`SELECT coalesce(max(publishSeq),0) AS seq FROM messages
      WHERE chatId=? AND publishSeq IS NOT NULL`, chatId).seq
  }
  publishGroupMessage(chatId, messageId) {
    const row = this.get(`UPDATE messages SET publishSeq=coalesce(publishSeq,
        (SELECT coalesce(max(publishSeq),0)+1 FROM messages WHERE chatId=? AND publishSeq IS NOT NULL))
      WHERE id=? AND chatId=? AND EXISTS (SELECT 1 FROM chats WHERE id=? AND kind='group')
      RETURNING publishSeq`, chatId, messageId, chatId, chatId)
    if (!row) throw new Error('无法在当前群发布这条消息。')
    return row.publishSeq
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
      `SELECT ma.messageId,a.id,name,size,kind,fileCount,skippedCount FROM message_attachments ma
       JOIN attachments a ON a.id=ma.attachmentId LEFT JOIN attachment_folders f ON f.id=a.id ORDER BY a.rowid`,
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
      chatSections: this.all('SELECT id,name FROM chat_sections ORDER BY rowid'),
      projects: projectSnapshot(this),
      chats: this.all(`SELECT c.*,c.rowid AS creationOrder,p.projectId,p.cwd AS initialProjectCwd,
        EXISTS(SELECT 1 FROM initial_project_chats i WHERE i.chatId=c.id) AS canSelectInitialProject,
        f.sourceChatId,o.sectionId,o.pinned,o.unread,o.archived FROM chats c
        LEFT JOIN chat_forks f ON c.id=f.chatId LEFT JOIN chat_organization o ON c.id=o.chatId
        LEFT JOIN chat_projects p ON p.chatId=c.id
        ORDER BY c.updatedAt DESC,c.rowid DESC`).map((c) => ({
        ...c,
        pinned: Boolean(c.pinned), unread: Boolean(c.unread), archived: Boolean(c.archived),
        canSelectInitialProject: Boolean(c.canSelectInitialProject),
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
