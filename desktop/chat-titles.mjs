import { redact } from './native.mjs'

const slashCommand = /^\/[\w:-]+(?:\s|$)/
const requestStart = /^(?:实现|修复|解决|排查|分析|解释|设计|检查|查看|对比|比较|添加|删除|优化|更新|整理|生成|编写|创建|总结|翻译|审查|重构|支持|复刻|build\b|add\b|fix\b|implement\b|review\b|explain\b|debug\b|design\b|compare\b|create\b|update\b|refactor\b|summari[sz]e\b|write\b|remove\b)/i
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function safeText(raw) {
  return redact(raw)
    .replace(/https?:\/\/[^\s<>，。！？；]+/gi, value => {
      try { return new URL(value).hostname } catch { return '' }
    })
    .replace(/(?<![\w.+-])[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '邮箱')
    .replace(/["']?(?:password|passwd|secret|token|api[_ -]?key|密码|密钥|令牌)["']?\s*(?:[=:：]|是|为)\s*(?:"[^"\n]*(?:"|$)|'[^'\n]*(?:'|$)|[^\s"'，。；,;]+)/gi, '凭据')
    .replace(/[A-Za-z0-9_-]{28,}/g, token => /\d/.test(token) || token.length > 80 ? '标识' : token)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
}
function clip(text) {
  let used = 0, result = ''
  for (const { segment } of segmenter.segment(text)) {
    used += /[^\x00-\xff]/u.test(segment) ? 2 : 1
    if (used > 64) return (result.replace(/\s+\S{1,16}$/, '') || result).trimEnd() + '…'
    result += segment
  }
  return result
}
function cleanRequest(line) {
  return line.trim()
    .replace(/^(?:#{1,6}\s+|[-*+]\s+|\d+[.、)]\s*)/, '')
    .replace(/^(?:[@＠][^\s，。！？、：；,.!?:;@＠]+[\s，、,:：]+)+/u, '')
    .replace(/^(?:(?:你好|您好|hi|hey|hello)[，,！!：:\s]+)?(?:请问|麻烦|请|能否|能不能|可以)?(?:帮我|帮忙|你帮我)?\s*/iu, '')
    .replace(/^(?:(?:could|would|can) you\s+)?(?:please\s+)?(?:help me(?: to)?\s+)?/i, '')
    .replace(/\[([^\][\n]+)]\([^)]+\)/g, '$1')
    .replace(/[*_`]{2,}|\x60/g, '').trim()
}

function requestSummary(text, attachments = [], names = []) {
  let input = text.trim()
  const mentions = [...names, '所有人', '全体成员', '全体'].sort((a, b) => b.length - a.length)
  while (/^[@＠]/u.test(input)) {
    const rest = input.slice(1)
    const name = mentions.find(n => rest.startsWith(n) && (!rest[n.length] || /[\s，、,:：@＠]/u.test(rest[n.length])))
    if (!name) break
    input = rest.slice(name.length).replace(/^[\s，、,:：]+/u, '')
  }
  if (slashCommand.test(input)) return null
  const prose = input
    .replace(/(?:`{3}|~{3})[^\n]*\n?[\s\S]*?(?:`{3}|~{3}|$)/g, '\n')
    .split(/\r?\n/)
    .filter(line => !/^\s*(?:[{[}\]<>$]|(?:import|export|const|let|var|function|def|class)\s+|\/\/|#include |Traceback |at \S+\s*\(|(?:[\w$]+\.)*[\w$]+\([^)]*\)\s*[;{]?\s*$)/.test(line))
    .join('\n').trim()
  const description = safeText(prose.slice(0, 12_000))
  const candidates = description.split(/\r?\n|[。！？!?]|(?<=\.)\s+(?=[A-Z])/u).map(cleanRequest).filter(Boolean)
  const subject = candidates.find(line => requestStart.test(line)) || candidates[0]
  if (subject) {
    const title = clip(subject.replace(/[。.!！?？:：]+$/, '').trim() || subject)
    return { title, description: [...description].slice(0, 1200).join('') }
  }
  if (attachments.length) {
    const name = safeText(attachments[0].name).replace(/\s+/g, ' ').trim()
    const title = clip('查看' + (name ? ' ' + name : '附件') + (attachments.length > 1 ? ' 等 ' + attachments.length + ' 个附件' : ''))
    return { title, description: title }
  }
  return input ? { title: '分析代码片段', description: '分析代码片段' } : null
}

export function applyNativeTitle(db, chatId, messageId, botId, raw) {
  if (typeof raw !== 'string') return
  const title = clip(safeText(raw.slice(0, 2000)).replace(/\s+/g, ' ').trim())
  if (!title || /^(?:new (?:chat|session|conversation)|untitled(?: (?:chat|session|conversation))?|新对话|新群聊|未命名)$/i.test(title)) return
  db.transaction(() => {
    if (db.run('DELETE FROM chat_title_requests WHERE chatId=? AND messageId=? AND botId=?',
      chatId, messageId, botId).changes) db.run('UPDATE chats SET name=? WHERE id=?', title, chatId)
  })
}

export function beginChatTitle(db, chatId, messageId, bots, text, attachments) {
  if (!db.get('SELECT 1 FROM chat_title_requests WHERE chatId=? AND messageId IS NULL', chatId)) return
  const summary = requestSummary(text, attachments, bots.map(bot => bot.name))
  if (!summary) return
  db.run('UPDATE chat_title_requests SET messageId=?,botId=? WHERE chatId=?', messageId, bots[0].id, chatId)
  db.run('UPDATE chats SET name=? WHERE id=?', summary.title, chatId)
  return summary.description
}

export function suggestChatTitle(db, chatId) {
  if (typeof chatId !== 'string' || !db.get('SELECT 1 FROM chats WHERE id=?', chatId)) throw new Error('聊天已不存在。')
  const users = db.db.prepare(`SELECT m.id,m.text FROM messages m WHERE m.chatId=? AND author='user'
    AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.messageId=m.id AND
      CASE WHEN json_valid(t.runSettings) THEN json_extract(t.runSettings,'$.slashCommand') IS NOT NULL
        OR json_extract(t.runSettings,'$.goalObjective') IS NOT NULL ELSE 1 END)
    ORDER BY m.rowid`)
  const names = db.all('SELECT b.name FROM members m JOIN bots b ON b.id=m.botId WHERE m.chatId=?', chatId).map(b => b.name)
  for (const message of users.iterate(chatId)) {
    if (message.text.startsWith('目标 · ')) continue
    const files = db.all(`SELECT a.name FROM message_attachments ma JOIN attachments a ON a.id=ma.attachmentId
      WHERE ma.messageId=? ORDER BY a.rowid`, message.id)
    const title = requestSummary(message.text, files, names)?.title
    if (title) return title
  }
  return null
}
