import { randomUUID } from 'node:crypto'
import { redact } from './native.mjs'

function nameOf(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120 || /[\u0000-\u001f\u007f]/u.test(value.trim()))
    throw new Error('请输入 1 到 120 字的名称。')
  return redact(value.trim())
}

function exists(db, chatId) {
  if (typeof chatId !== 'string' || !db.get('SELECT 1 FROM chats WHERE id=?', chatId))
    throw new Error('聊天已不存在。')
}

export function requireIdleChats(workspace, chatIds) {
  const ids = new Set(chatIds)
  if (Array.from(workspace.threadEdits.values()).some(edit => ids.has(edit.chatId)) ||
      Array.from(workspace.lanes.keys()).some(lane => ids.has(lane.slice(0,lane.lastIndexOf('/')))) ||
      workspace.db.get(`SELECT 1 FROM tasks WHERE chatId IN (SELECT value FROM json_each(?))
        AND status IN ('queued','running','approval') LIMIT 1`, JSON.stringify(chatIds)))
    throw new Error('请等待聊天任务结束，或先停止任务。')
}

export function requireSection(db, sectionId) {
  if (sectionId !== null && (typeof sectionId !== 'string' || !db.get('SELECT 1 FROM chat_sections WHERE id=?', sectionId)))
    throw new Error('目标分区已不存在。')
}

// Callers include creation and placement in one transaction.
export function insertSection(db, value) {
  const name = nameOf(value)
  if (db.get('SELECT 1 FROM chat_sections WHERE name=? COLLATE NOCASE', name)) throw new Error('已有同名分区。')
  const sectionId = randomUUID()
  db.run('INSERT INTO chat_sections(id,name) VALUES(?,?)', sectionId, name)
  return sectionId
}

function move(db, chatId, sectionId) {
  requireSection(db, sectionId)
  db.run(`INSERT INTO chat_organization(chatId,sectionId) VALUES(?,?)
    ON CONFLICT(chatId) DO UPDATE SET sectionId=excluded.sectionId,pinned=0`, chatId, sectionId)
}

function deleteRecords(db, chatId) {
  const messages = 'SELECT id FROM messages WHERE chatId=?'
  db.run(`DELETE FROM fork_attachments WHERE messageId IN (${messages})`, chatId)
  db.run('DELETE FROM native_fork_attachments WHERE chatId=?', chatId)
  const assets = db.all(`SELECT a.id,(
    SELECT f.messageId FROM fork_attachments f WHERE f.attachmentId=a.id ORDER BY f.rowid LIMIT 1
  ) AS survivor,EXISTS(SELECT 1 FROM native_fork_attachments n WHERE n.attachmentId=a.id) AS nativeOwner
    FROM attachments a WHERE a.messageId IN (${messages}) OR (a.scope IN (?, '') AND a.messageId IS NULL)`, chatId, chatId)
  const unlinked = []
  for (const { id, survivor, nativeOwner } of assets) {
    if (survivor) {
      db.run('UPDATE attachments SET scope=(SELECT chatId FROM messages WHERE id=?),messageId=? WHERE id=?', survivor, survivor, id)
      db.run('DELETE FROM fork_attachments WHERE messageId=? AND attachmentId=?', survivor, id)
    } else if (nativeOwner) {
      // This immutable file is still addressed by path in a native-only /fork
      // history. Empty scope is never a composer draft.
      db.run("UPDATE attachments SET scope='',messageId=NULL WHERE id=?", id)
    } else {
      db.run('DELETE FROM attachments WHERE id=?', id)
      unlinked.push(id)
    }
  }
  db.run('DELETE FROM chat_forks WHERE sourceChatId=? OR chatId=?', chatId, chatId)
  for (const table of ['fork_member_context','tasks','messages','group_delivery','threads','members','composer_settings','context_usage'])
    db.run('DELETE FROM ' + table + ' WHERE chatId=?', chatId)
  db.run('DELETE FROM chats WHERE id=?', chatId)
  return unlinked
}

export async function manageChat(workspace, method, p) {
  const { db } = workspace
  const { chatId } = p
  if (method === 'createChatSection') {
    const sectionId = db.transaction(() => {
      if (chatId != null) exists(db, chatId)
      const id = insertSection(db, p.name)
      if (chatId != null) move(db, chatId, id)
      return id
    })
    workspace.notify()
    return sectionId
  }
  exists(db, chatId)
  switch (method) {
    case 'renameChat':
      db.transaction(() => {
        db.run('UPDATE chats SET name=? WHERE id=?', nameOf(p.name), chatId)
        db.run('DELETE FROM chat_title_requests WHERE chatId=?', chatId)
      })
      break
    case 'moveChatToSection':
      move(db, chatId, p.sectionId)
      break
    case 'setChatPinned':
    case 'setChatUnread':
    case 'setChatArchived': {
      const field = { setChatPinned: 'pinned', setChatUnread: 'unread', setChatArchived: 'archived' }[method]
      if (typeof p[field] !== 'boolean') throw new Error('聊天状态无效。')
      if (field === 'archived' && p.archived) requireIdleChats(workspace, [chatId])
      db.run(`INSERT INTO chat_organization(chatId,${field}) VALUES(?,?)
        ON CONFLICT(chatId) DO UPDATE SET ${field}=excluded.${field}`, chatId, Number(p[field]))
      break
    }
    case 'deleteChat': {
      requireIdleChats(workspace, [chatId])
      const removed = db.transaction(() => deleteRecords(db, chatId))
      workspace.notify()
      workspace.onChatDeleted?.(chatId)
      await workspace.attachments.discardSnapshots(removed)
      return
    }
    default: throw new Error('未知的聊天操作。')
  }
  workspace.notify()
}
