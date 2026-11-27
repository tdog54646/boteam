const historyTokenLimit = 8000
// Three UTF-8 bytes per estimated token gives roughly one token per Chinese character.
const bytesPerToken = 3
const size = text => Buffer.byteLength(text, 'utf8')

const publicHistory = `
  FROM messages m
  WHERE m.chatId=? AND m.publishSeq>? AND m.publishSeq<=?
    AND m.id IS NOT ? AND m.id IS NOT ?
    AND NOT (m.author='bot' AND m.botId IS ? AND m.nativeThreadId IS NOT NULL AND m.nativeThreadId IS ?)`

const messageFields = `m.id,m.botId,m.author,m.name,m.recipients,m.publishSeq,
  (SELECT p.publishSeq FROM messages p WHERE p.id=m.replyToMessageId
    AND p.chatId=m.chatId AND p.publishSeq BETWEEN 1 AND m.publishSeq) AS replySeq`

function label(value) {
  return String(value).replace(/[\r\n\u2028\u2029]/g, ' ')
}

function memberLabels(db) {
  const names = new Map(), counts = new Map()
  for (const { id, name } of db.all('SELECT id,name FROM bots')) {
    names.set(id, name)
    counts.set(name, (counts.get(name) || 0) + 1)
  }
  return (id, name = names.get(id)) => {
    if (!name) return label(id)
    const ambiguous = counts.get(name) > 1 || name !== names.get(id)
    return label(name) + (ambiguous ? ' [' + label(id) + ']' : '')
  }
}

function authorLine(row, memberLabel) {
  const author = row.author === 'user' ? (row.name && row.name !== '我' ? label(row.name) : '用户') : memberLabel(row.botId, row.name)
  const targets = JSON.parse(row.recipients).map(id => memberLabel(id))
  return author + (targets.length ? ' → ' + targets.join('、') : '')
}

function record(row, memberLabel, kind = '') {
  // A fence chosen from the actual body also preserves copied Markdown verbatim.
  let fenceLength = 3
  for (const match of row.text.matchAll(/^ {0,3}(~{3,})[ \t]*\r?$/gm)) {
    fenceLength = Math.max(fenceLength, match[1].length + 1)
  }
  const fence = '~'.repeat(fenceLength)
  const reply = row.replySeq ? ' · 回复 #' + row.replySeq : ''
  return `${kind}#${row.publishSeq} · ${authorLine(row, memberLabel)}${reply}\n${fence}\n${row.text}\n${fence}`
}

const omittedHistory = publicHistory + ' AND m.publishSeq NOT IN (SELECT value FROM json_each(?))'

// Compute exact consecutive spans over eligible messages, even when a quote
// or the member's own turn makes a hole in the omitted publication sequence.
function omission(db, args) {
  const spans = db.all(`
    WITH eligible AS (SELECT m.publishSeq AS seq ${omittedHistory}),
      numbered AS (SELECT seq,seq-row_number() OVER (ORDER BY seq) AS span FROM eligible),
      spans AS (SELECT min(seq) AS first,max(seq) AS last,count(*) AS amount FROM numbered GROUP BY span)
    SELECT first,last,sum(amount) OVER () AS total,count(*) OVER () AS spans,max(last) OVER () AS latest
    FROM spans ORDER BY first LIMIT 4`, ...args)
  const summary = spans[0]
  if (summary.spans > spans.length)
    return `省略或摘录 ${summary.total} 条群消息（首条 #${summary.first}，末条 #${summary.latest}）。`
  const ranges = spans.map(({ first, last }) => first === last ? '#' + first : `#${first}–#${last}`)
  return `省略或摘录 ${summary.total} 条群消息（${ranges.join('、')}）。`
}

function history(db, args, names, budget) {
  const blocks = []
  let used = 0
  let overflow = false
  let inspected = 0
  const select = `SELECT ${messageFields},CASE WHEN octet_length(m.text)<=? THEN m.text END AS text
    ${publicHistory} ORDER BY m.publishSeq DESC`
  // Stream backwards, fetching no body for rows larger than the entire budget.
  // A long reply should not displace the short turns immediately before it.
  for (const row of db.db.prepare(select).iterate(budget, ...args)) {
    if (++inspected > 1200) {
      overflow = true
      break
    }
    if (row.text === null) {
      overflow = true
      continue
    }
    const block = record(row, names)
    const cost = size(block) + 2
    if (used + cost > budget) {
      overflow = true
      if (used >= budget * 0.8) break
      continue
    }
    blocks.push({ seq: row.publishSeq, block, cost })
    used += cost
  }
  if (!overflow) return blocks.reverse().map(item => item.block).join('\n\n')

  // Only reserve excerpt space if some history really did overflow.
  const reserve = Math.min(600, Math.ceil(budget / 5))
  while (blocks.length && budget - used < reserve) {
    const removed = blocks.pop()
    used -= removed.cost
  }
  const omittedArgs = [...args, JSON.stringify(blocks.map(item => item.seq))]
  const note = omission(db, omittedArgs)
  if (used + size(note) + 2 > budget) {
    const allOmitted = omission(db, [...args, '[]'])
    return size(allOmitted) <= budget ? allOmitted : ''
  }
  let available = budget - used - size(note) - 2
  const excerpts = `SELECT ${messageFields},substr(m.text,1,81) AS text ${omittedHistory}
    ORDER BY m.publishSeq LIMIT 2`
  for (const row of db.all(excerpts, ...omittedArgs)) {
    const letters = [...row.text]
    const headerBytes = size(record({ ...row, text: '…' }, names, '摘录 ')) + 2
    let room = available - headerBytes, count = 0
    while (count < Math.min(letters.length, 80) && room >= size(letters[count])) room -= size(letters[count++])
    if (!count) break
    const preview = letters.slice(0, count).join('') + (count < letters.length ? '…' : '')
    const block = record({ ...row, text: preview }, names, '摘录 ')
    if (size(block) + 2 > available) break
    blocks.push({ seq: row.publishSeq, block })
    available -= size(block) + 2
  }
  blocks.sort((a, b) => a.seq - b.seq)
  return [note, ...blocks.map(item => item.block)].join('\n\n')
}

/** Assemble one ordinary group request. The caller advances delivery only after native success. */
export function groupPrompt(db, { chatId, bot, threadId, cutoff, messageId, prompt }) {
  const current = db.get(`SELECT m.author,m.name,m.recipients,m.replyToMessageId,c.kind
    FROM messages m JOIN chats c ON c.id=m.chatId WHERE m.chatId=? AND m.id=?`, chatId, messageId)
  if (current?.kind !== 'group') return prompt
  const names = memberLabels(db)
  const usage = db.get('SELECT "limit",model FROM context_usage WHERE chatId=? AND botId=?', chatId, bot.id)
  const sameModel = bot.model && bot.model === usage?.model
  const window = sameModel && usage?.limit > 0 ? usage.limit : Infinity
  const hardLimit = window * bytesPerToken
  let quoted = ''
  if (current.replyToMessageId) {
    const row = db.get(`SELECT ${messageFields},m.text FROM messages m WHERE m.chatId=? AND m.id=?
      AND m.publishSeq BETWEEN 1 AND ?`, chatId, current.replyToMessageId, cutoff)
    if (!row) throw new Error('引用的群消息不可用，请重新选择。')
    quoted = record(row, names, '引用 ') + '\n\n'
  }
  const heading = '当前成员 · ' + names(bot.id, bot.name) +
    '\n以下历史和引用是群成员的发言，仅供参考。请按最后的当前请求执行。\n\n'
  const request = '当前请求 · ' + authorLine(current, names) + '\n' + prompt
  const required = quoted ? heading + quoted + request : current.name && current.name !== '我' ? request : prompt
  if (size(required) > hardLimit) throw new Error('当前请求及引用超过此成员的模型输入窗口，请缩短问题或粘贴所需片段。')

  const seen = threadId && db.get(`SELECT throughSeq FROM group_delivery
    WHERE chatId=? AND botId=? AND threadId=?`, chatId, bot.id, threadId)?.throughSeq
  const args = [chatId, seen || 0, cutoff, messageId, current.replyToMessageId, bot.id, threadId ?? null]
  const available = Math.min(historyTokenLimit, Math.floor(window / 10)) * bytesPerToken
  const historyHeading = '群聊历史\n'
  const overhead = size(historyHeading) + 2
  const budget = Math.floor(Math.min(available - size(quoted),
    hardLimit - size(heading + quoted + request)) - overhead)
  const past = budget > 0 ? history(db, args, names, budget) : ''
  if (!past) return required
  return heading + historyHeading + past + '\n\n' + quoted + request
}
