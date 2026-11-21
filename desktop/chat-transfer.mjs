const chatUrl = /^boteam:\/\/chat\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/?$/i

export function linkedChatId(url) {
  return typeof url === 'string' ? chatUrl.exec(url)?.[1].toLowerCase() || null : null
}

export function requireChat(db, id) {
  const chat = typeof id === 'string' && db.get('SELECT id,name,kind FROM chats WHERE id=?', id)
  if (!chat) throw new Error('此聊天已不存在，或属于另一台设备。')
  return chat
}

export function chatText(db, chat, format) {
  if (format === 'link') return 'boteam://chat/' + chat.id
  if (format === 'id') return chat.id
  if (format === 'name') return chat.name
  if (format !== 'text') throw new Error('请选择要复制的内容。')
  const files = new Map()
  for (const { messageId, name } of db.all(
    `SELECT ma.messageId,a.name FROM messages m JOIN message_attachments ma ON ma.messageId=m.id
     JOIN attachments a ON a.id=ma.attachmentId WHERE m.chatId=? ORDER BY a.rowid`, chat.id)) {
    if (!files.has(messageId)) files.set(messageId, [])
    files.get(messageId).push(name)
  }
  const parts = ['# ' + chat.name.replaceAll(/\s+/g, ' ')]
  const messages = db.all(
    'SELECT id,author,name,text,recipients,replyToMessageId FROM messages WHERE chatId=? ORDER BY rowid', chat.id)
  const byId = new Map(messages.map(m => [m.id, m]))
  const recipientNames = new Map(chat.kind === 'group' ? db.all(
    `SELECT DISTINCT b.id,b.name FROM messages m JOIN json_each(m.recipients) r JOIN bots b ON b.id=r.value
     WHERE m.chatId=?`, chat.id).map(b => [b.id, b.name]) : [])
  const role = m => m.author === 'user' ? '用户' : 'Bot · ' + m.name.replaceAll(/\s+/g, ' ')
  for (const m of messages) {
    const attachments = files.get(m.id)
    if (!m.text && !attachments) continue
    parts.push('## ' + role(m))
    if (chat.kind === 'group' && m.author === 'user') {
      const names = JSON.parse(m.recipients).map(id => '@' + (recipientNames.get(id) || '已移除成员'))
      if (names.length) parts.push('发送给 ' + names.join('、'))
    }
    const quote = byId.get(m.replyToMessageId)
    if (quote) {
      const quoted = [role(quote), quote.text, ...(files.get(quote.id) || [])].filter(Boolean).join('\n')
      parts.push(quoted.split('\n').map(line => '> ' + line).join('\n'))
    }
    if (m.text) parts.push(m.text)
    if (attachments) parts.push('附件\n\n' + attachments.map(name => '- ' + name).join('\n'))
  }
  return parts.join('\n\n') + '\n'
}
