import { redact } from './native.mjs'

const generic = /^(?:self|default|agent|subagent|worker)$/i
const placeholder = name => typeof name !== 'string' || !name.trim() || generic.test(name.trim())
const opening = text => (typeof text === 'string' ? text.trim().split(/[。！？\r\n]/u, 1)[0] : '') || ''

function label(text, limit) {
  const safe = redact(text.trim().replace(/\s+/gu, ' '))
  const chars = [...safe]
  return chars.length > limit ? chars.slice(0, limit - 1).join('').trimEnd() + '…' : safe
}

function promptTitle(prompt) {
  const firstLine = opening(prompt)
    .replace(/^(?:你的任务是|任务[:：]|请)\s*/u, '')
    .replace(/^(?:使用\s*[\w-]+\s*工具[，,、\s]*)?(?:深入|专门)?(?:检索|搜索|研究|分析|调研|核对|查看)?\s*/u, '')
  const subject = firstLine.replace(/^(?:「[^」]+」|“[^”]+”)(?:[（(][^）)]+[）)])?\s*(?:的)?\s*/u, '')
  if (firstLine) return label(subject || firstLine, 30)
}

export function dispatchAgentName({ Role, TypeName, Prompt }) {
  if (!placeholder(Role)) return label(Role, 40)
  if (!placeholder(TypeName)) return label(TypeName, 40)
  return promptTitle(Prompt)
}

function titleTerms(title) {
  const terms = new Set()
  for (const [word] of title.toLowerCase().matchAll(/[a-z\d]{2,}|\p{Script=Han}+/gu)) {
    if (/^[a-z\d]/.test(word)) terms.add(word)
    else {
      for (let i = 0; i + 1 < word.length; i++) terms.add(word.slice(i, i + 2))
    }
  }
  return [...terms]
}

function matchingRoster(parent, dispatches) {
  const titles = [...parent.slice(0, 20000).matchAll(/^\s*\d+[.)、]\s+\*\*([^\r\n*：:]{1,48})\*\*\s*[:：]/gmu)]
    .map(match => label(match[1], 48))
  if (titles.length !== dispatches.length || titles.length < 2 || new Set(titles).size !== titles.length) return []
  const firstLines = dispatches.map(entry => opening(entry.text).toLowerCase())
  const terms = titles.map(title => titleTerms(title).filter(term =>
    firstLines.filter(line => line.includes(term)).length === 1))
  const matched = firstLines.map(line => {
    const scores = terms.map((words, index) => ({
      title: titles[index], score: words.filter(word => line.includes(word)).length,
    })).sort((a, b) => b.score - a.score)
    if (scores[0].score > scores[1].score) return scores[0].title
  })
  // Only trust a complete one-to-one match. Model prose order can differ from dispatch order.
  return matched.every(Boolean) && new Set(matched).size === titles.length ? matched : []
}

export function labelLegacySubagents(db, tasks, messages) {
  const isLegacy = agent => typeof agent?.id === 'string' && agent.id.startsWith('agy:') && placeholder(agent.name)
  const legacyTasks = tasks.filter(task => task.events.some(event => isLegacy(event.agent)))
  if (!legacyTasks.length) return
  const taskIds = new Set(legacyTasks.map(task => task.id))
  const replies = new Map(messages.filter(message => message.author === 'bot' && taskIds.has(message.taskId))
    .map(message => [message.taskId, message.text]))
  for (const task of legacyTasks) {
    const recorded = new Map(task.events.filter(({ agent }) => agent && !placeholder(agent.name))
      .map(({ agent }) => [agent.id, agent.name]))
    const dispatches = db.all(`SELECT agentId,text FROM subagent_entries
      WHERE taskId=? AND entryId='dispatch-prompt' AND role='user' ORDER BY rowid`, task.id)
    const titles = matchingRoster(replies.get(task.id) || '', dispatches)
    const names = new Map(dispatches.map(({ agentId, text }, index) => [agentId, titles[index] || promptTitle(text)]))
    for (const { agent } of task.events) {
      if (!isLegacy(agent)) continue
      const name = recorded.get(agent.id) || names.get(agent.id)
      if (name) agent.name = name
      else delete agent.name
    }
  }
}
