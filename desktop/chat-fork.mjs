import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createChatWorktrees } from './chat-worktrees.mjs'
import { inheritProject } from './projects.mjs'

function copyTimeline(db, sourceId, chatId, nativeForks) {
  const messages = db.all('SELECT id,botId,taskId,replyToMessageId,nativeThreadId FROM messages WHERE chatId=? ORDER BY rowid', sourceId)
  const tasks = db.all('SELECT id,messageId FROM tasks WHERE chatId=? ORDER BY rowid', sourceId)
  const messageIds = new Map(messages.map(m => [m.id, randomUUID()]))
  const taskIds = new Map(tasks.map(t => [t.id, randomUUID()]))
  const copyMessage = db.db.prepare(`INSERT INTO messages
    (id,chatId,botId,author,name,text,createdAt,recipients,taskId,publishSeq,nativeThreadId)
    SELECT ?,?,botId,author,name,text,createdAt,recipients,?,publishSeq,? FROM messages WHERE id=?`)
  const linkAttachments = db.db.prepare(`INSERT INTO fork_attachments(messageId,attachmentId)
    SELECT ?,attachmentId FROM message_attachments WHERE messageId=?`)
  for (const m of messages) {
    const id = messageIds.get(m.id)
    const branch = nativeForks.get(m.botId)
    const nativeId = branch && m.nativeThreadId === branch.sourceId ? branch.threadId : null
    copyMessage.run(id, chatId, taskIds.get(m.taskId) ?? null, nativeId, m.id)
    linkAttachments.run(id, m.id)
  }
  const linkQuote = db.db.prepare('UPDATE messages SET replyToMessageId=? WHERE id=?')
  for (const m of messages) {
    if (messageIds.has(m.replyToMessageId)) linkQuote.run(messageIds.get(m.replyToMessageId), messageIds.get(m.id))
  }
  const copyTask = db.db.prepare(`INSERT INTO tasks
    (id,chatId,botId,accountId,messageId,status,tool,identity,error,events,approval,createdAt,verifiedKey,runSettings,groupCutoff)
    SELECT ?,?,botId,accountId,?,status,tool,identity,error,events,NULL,createdAt,verifiedKey,runSettings,groupCutoff
    FROM tasks WHERE id=?`)
  for (const t of tasks) copyTask.run(taskIds.get(t.id), chatId, messageIds.get(t.messageId), t.id)
  return { messageIds, lastMessage: messageIds.get(messages.at(-1)?.id) ?? null }
}

// The title-bar action snapshots the entire chat. The composer's member-scoped
// /fork command continues to branch just that member's native session.
export async function forkConversation(workspace, sourceId, newWorktree = false) {
  const { db, threadEdits, lanes } = workspace
  const source = typeof sourceId === 'string' && db.get('SELECT * FROM chats WHERE id=?', sourceId)
  if (!source) throw new Error('原会话不存在。')
  const members = db.all('SELECT b.* FROM members m JOIN bots b ON b.id=m.botId WHERE m.chatId=? ORDER BY m.rowid', sourceId)
  const keys = members.map(bot => sourceId + '/' + bot.id)
  if (keys.some(key => threadEdits.has(key) || lanes.has(key)))
    throw new Error('此会话正在处理任务，请稍后创建分支。')
  if (members.some(bot => workspace.accounts.updating.has(bot.accountId))) throw new Error('账号正在更新，请稍后创建分支。')

  const chatId = randomUUID()
  const nativeForks = new Map()
  let worktrees
  const nativeHistoryOnly = source.kind === 'direct' &&
    !db.get('SELECT 1 FROM messages WHERE chatId=? LIMIT 1', sourceId)
  for (const [index, bot] of members.entries()) threadEdits.set(keys[index], { chatId: sourceId, botId: bot.id, accountId: bot.accountId })
  try {
    if (newWorktree) worktrees = await createChatWorktrees(workspace, sourceId, members)
    for (const bot of members) {
      const thread = db.get('SELECT threadId FROM threads WHERE chatId=? AND botId=?', sourceId, bot.id)
      if (!thread) continue
      const adapter = !bot.archived && workspace.adapters[db.account(bot.accountId).provider]
      if (!adapter?.forkChat) {
        if (nativeHistoryOnly) throw new Error('此会话的历史只保存在原生线程中，请恢复该成员的原生分支功能。')
        continue
      }
      const scope = await workspace.nativeScope({ chatId: sourceId, botId: bot.id })
      const branch = await adapter.forkChat(scope, { destinationChatId: chatId,
        ...(worktrees && { destinationCwd: worktrees.directories.get(bot.id) }) })
      nativeForks.set(bot.id, { ...branch, sourceId: thread.threadId })
      if (!branch?.threadId || branch.threadId === thread.threadId) throw new Error('原生工具未返回独立的分支线程。')
    }
    workspace.lifetime.signal.throwIfAborted()
    db.transaction(() => {
      db.run('INSERT INTO chats VALUES(?,?,?,?)', chatId, source.kind, source.name + ' · 分支', new Date().toISOString())
      workspace.addMembers(chatId, members)
      db.run('INSERT INTO chat_forks VALUES(?,?)', chatId, sourceId)
      inheritProject(db, sourceId, chatId, worktrees?.directories.get(members[0]?.id))
      db.run(`INSERT INTO composer_settings(chatId,botId,model,effort,permission,planMode)
        SELECT ?,botId,model,effort,permission,planMode FROM composer_settings WHERE chatId=?`, chatId, sourceId)
      const { messageIds, lastMessage } = copyTimeline(db, sourceId, chatId, nativeForks)
      for (const bot of members) {
        const cwd = worktrees?.directories.get(bot.id) || workspace.chatDirectory(sourceId, bot)
        const branch = nativeForks.get(bot.id)
        const inheritedSeed = db.get('SELECT seedMessageId FROM fork_member_context WHERE chatId=? AND botId=?',
          sourceId, bot.id)?.seedMessageId
        const seed = branch ? messageIds.get(inheritedSeed) ?? null : lastMessage
        db.run('INSERT INTO fork_member_context(chatId,botId,cwd,seedMessageId) VALUES(?,?,?,?)',
          chatId, bot.id, cwd, source.kind === 'direct' ? seed : null)
        if (!branch) continue
        db.retainNativeAttachments(sourceId, chatId, bot.id)
        workspace.associateThread(chatId, bot.id, bot.accountId, branch.threadId, cwd)
        db.run(`INSERT INTO group_delivery(chatId,botId,threadId,throughSeq)
          SELECT ?,botId,?,throughSeq FROM group_delivery WHERE chatId=? AND botId=? AND threadId=?`,
          chatId, branch.threadId, sourceId, bot.id, branch.sourceId)
      }
    })
  } catch (error) {
    await Promise.allSettled([...nativeForks.values()].map(async branch => branch.discard?.()))
    await worktrees?.discard()
    throw error
  } finally {
    for (const key of keys) threadEdits.delete(key)
  }
  workspace.notify()
  return chatId
}

// Providers without a native fork start a fresh session. Supply the frozen
// direct-chat transcript on its first ordinary turn, bounded like group history.
// Group members already receive their own budgeted public history via groupPrompt.
export function directForkPrompt(db, attachmentsDirectory, chatId, throughId, prompt) {
  const budget = 24_000
  const rows = db.db.prepare(`WITH completed AS MATERIALIZED (
    SELECT id,messageId FROM tasks WHERE chatId=? AND status='done')
    SELECT m.id,m.name,substr(m.text,-?) AS text,length(m.text)>? AS clipped
    FROM messages m WHERE m.chatId=? AND m.rowid<=(SELECT rowid FROM messages WHERE id=? AND chatId=?)
    AND (m.id IN (SELECT messageId FROM completed) OR m.taskId IN (SELECT id FROM completed))
    ORDER BY m.rowid DESC`)
  const files = db.db.prepare(`SELECT a.id,a.name FROM message_attachments ma JOIN attachments a ON a.id=ma.attachmentId
    WHERE ma.messageId=? ORDER BY a.rowid`)
  const blocks = []
  let remaining = budget, omitted = false
  for (const m of rows.iterate(chatId, budget, budget, chatId, throughId, chatId)) {
    const paths = files.all(m.id).map(file => join(attachmentsDirectory, file.id, file.name))
    if (!m.text && !paths.length) continue
    const header = m.name + (paths.length ? '（附件：' + paths.join('、') + '）' : '') + '\n'
    const available = remaining - Buffer.byteLength(header) - 2
    if (available < 8) { omitted = true; break }
    const bytes = Buffer.from(m.text)
    if (m.clipped || bytes.length > available) {
      let start = Math.max(0, bytes.length - available + 3)
      while ((bytes[start] & 0xc0) === 0x80) start++
      blocks.push(header + '…' + bytes.toString('utf8', start))
      omitted = true
      break
    }
    blocks.push(header + m.text)
    remaining = available - bytes.length
  }
  if (!blocks.length && !omitted) return prompt
  return '分支建立前的聊天记录（从旧到新）\n' + (omitted ? '部分早期内容已省略。\n' : '') +
    blocks.reverse().join('\n\n') + '\n\n当前请求\n' + prompt
}
