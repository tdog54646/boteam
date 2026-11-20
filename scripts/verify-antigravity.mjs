// Usage: node scripts/verify-antigravity.mjs --live [--account-id <BoTeam account ID>]
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import * as antigravity from '../desktop/adapters/antigravity.mjs'
import * as codex from '../desktop/adapters/codex.mjs'
import { Workspace } from '../desktop/workspace.mjs'
import { redact } from '../desktop/native.mjs'
import { resolveMentions } from '../src/mentions.js'

class CheckError extends Error {}
function check(condition, message) {
  if (!condition) throw new CheckError(message)
}
const fingerprint = (id) => createHash('sha256').update(id).digest('hex').slice(0, 12)
const marker = () => 'BT-' + randomBytes(5).toString('hex')
const repeat = (word) => '记住标记 ' + word + '。只回复这个标记，不调用工具。'

function bindings(accountId) {
  const file = join(homedir(), 'Library', 'Application Support', 'BoTeam', 'workspace.sqlite3')
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const rows = db
      .prepare(
        `
      SELECT id, provider, identity, info FROM accounts
      WHERE provider IN ('antigravity', 'codex') AND json_extract(info, '$.status')='ready'
      ORDER BY rowid`,
      )
      .all()
      .map((row) => ({ ...row, info: JSON.parse(row.info) }))
    const agy = rows.filter(
      (a) =>
        a.provider === 'antigravity' &&
        a.info.managed &&
        a.info.email &&
        a.identity === 'google:' + a.info.email.toLowerCase() &&
        (!accountId || a.id === accountId),
    )
    check(agy.length, '找不到符合条件的已核验 Antigravity 账号。')
    check(agy.length === 1, '有多个就绪 Antigravity 账号，请用 --account-id 指定要验收的账号。')
    return [agy[0], rows.find((a) => a.provider === 'codex')]
  } finally {
    db.close()
  }
}

function selectModel(catalog) {
  const priceHint = (m) =>
    /flash.?lite|nano/i.test(m.id + ' ' + m.label)
      ? 0
      : /flash|mini|haiku|lite/i.test(m.id + ' ' + m.label)
        ? 1
        : 2
  const models = [...catalog.models].sort((a, b) => priceHint(a) - priceHint(b))
  check(models.length, '原生 CLI 没有返回可选模型。')
  const model = models.find((m) => m.efforts?.length) || models[0]
  const levels = model.efforts || []
  const effort =
    ['minimal', 'low', 'none', 'off', '低', 'medium']
      .map((name) =>
        levels.find((e) => e.id.toLowerCase() === name || e.label.toLowerCase() === name),
      )
      .find(Boolean) || levels[0]
  return { model, effort }
}

let stage = '启动',
  ws,
  root,
  interrupted = false
function stop() {
  interrupted = true
  void ws?.close()
}
async function makeBot(account, name) {
  stage = '读取 ' + account.provider + ' 选项'
  const { model, effort } = selectModel(await ws.handle('botOptions', { accountId: account.id }))
  const id = await ws.handle('createBot', {
    accountId: account.id,
    name,
    model: model.id,
    effort: effort?.id || '',
  })
  return { id, name, account, model, effort }
}

async function turn(label, chatId, bot, text, expected, members) {
  stage = label
  const recipients = members
    ? resolveMentions(text, members).flatMap((token) => token.ids)
    : [bot.id]
  check(recipients.length === 1 && recipients[0] === bot.id, '群聊点名未定位到指定 Bot。')
  const messageId = await ws.handle('send', { chatId, recipients, text })
  const until = Date.now() + 180_000
  let task
  for (;;) {
    const tasks = ws.db.all('SELECT * FROM tasks WHERE messageId=?', messageId)
    check(tasks.length === 1 && tasks[0].botId === bot.id, '消息被派发给了其他 Bot。')
    task = tasks[0]
    if (task.status === 'done') break
    if (!['running', 'queued'].includes(task.status)) {
      const reason = redact(task.error).replace(/[\w.+-]+@[\w.-]+/g, '[账号]').slice(0, 200)
      throw new CheckError('原生任务结束状态为 ' + task.status + '。' + reason)
    }
    check(Date.now() < until, '等待原生回复超时。')
    await delay(250)
  }
  const { account, model, effort } = bot
  check(
    task.accountId === account.id &&
      task.verifiedKey === account.identity &&
      task.identity.toLowerCase() === account.info.email.toLowerCase(),
    '原生任务未核实预期的绑定身份。',
  )
  check(task.tool === account.info.bin, '原生任务执行文件与绑定记录不一致。')
  const response = ws.db.get('SELECT text FROM messages WHERE taskId=?', task.id)
  check(response?.text.trim() === expected, '回复未准确返回测试标记。')
  const thread = ws.db.get(
    'SELECT threadId FROM threads WHERE chatId=? AND botId=? AND accountId=?',
    chatId,
    bot.id,
    account.id,
  )
  check(thread?.threadId, '原生工具未返回会话标识。')
  const agy = account.provider === 'antigravity'
  const modelText = agy ? 'Antigravity 已采用 ' + model.label : '模型 ' + model.id
  const effortText = effort ? ' · ' + (agy ? effort.label : '思考强度 ' + effort.id) : ''
  check(
    JSON.parse(task.events).some((e) =>
      effort
        ? e.text === modelText + effortText
        : e.text === modelText || e.text.startsWith(modelText + ' · '),
    ),
    '原生工具未确认 Bot 选项。',
  )
  console.log(
    JSON.stringify({
      case: label,
      provider: account.provider,
      tool: basename(task.tool),
      verifiedAccount: fingerprint(account.id),
      thread: fingerprint(thread.threadId),
      model: model.id,
      effort: effort?.id || null,
      replyMatched: true,
    }),
  )
  return thread.threadId
}

function openWorkspace() {
  check(!interrupted, '验收已停止。')
  return new Workspace({ root, adapters: { antigravity, codex } })
}

try {
  const { values } = parseArgs({
    options: { live: { type: 'boolean' }, 'account-id': { type: 'string' } },
  })
  check(values.live, '真实验收需要显式传入 --live。')
  check(process.platform === 'darwin', '当前 Antigravity 隔离账号仅支持 macOS。')
  stage = '只读加载 BoTeam 绑定'
  const [google, openai] = bindings(values['account-id'])
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  root = await mkdtemp(join(tmpdir(), 'boteam-agy-acceptance-'))
  ws = openWorkspace()
  for (const account of [google, openai].filter(Boolean)) {
    // Without a bound working directory Workspace creates a private directory per test chat.
    delete account.info.cwd
    // Codex supports a separate session home. The runtime adapter alone handles native authentication.
    if (account.provider === 'codex') {
      account.info.source = join(root, 'codex-sessions')
      await mkdir(account.info.source, { mode: 0o700 })
    }
    ws.db.run(
      'INSERT INTO accounts(id,provider,identity,info) VALUES(?,?,?,?)',
      account.id,
      account.provider,
      account.identity,
      JSON.stringify(account.info),
    )
  }
  const primary = await makeBot(google, 'Google一号')
  const secondary = await makeBot(openai || google, openai ? 'Codex二号' : 'Google二号')
  const members = [primary, secondary]
  const direct = await ws.handle('createChat', { kind: 'direct', members: [primary.id] })
  const group = await ws.handle('createChat', {
    kind: 'group',
    name: '原生点名验收',
    members: members.map((b) => b.id),
  })
  const secret = marker()
  const first = await turn('Antigravity 私聊', direct, primary, repeat(secret), secret)
  const sessions = new Set([first])
  for (const bot of members) {
    const word = marker()
    sessions.add(
      await turn(
        '群聊点名 ' + bot.name,
        group,
        bot,
        '@' + bot.name + ' ' + repeat(word),
        word,
        members,
      ),
    )
  }
  check(sessions.size === 3, '私聊和两个群聊成员没有得到三个独立原生会话。')
  await ws.close()
  ws = openWorkspace()
  const resumed = await turn(
    '重启后私聊续接',
    direct,
    primary,
    '上一轮私聊让你记住的标记是什么？只回复标记，不调用工具。',
    secret,
  )
  check(first === resumed, '重启后的原生会话标识已变化。')
  console.log('通过私聊、群聊分别点名、三个独立原生会话及重启后的上下文恢复。')
} catch (error) {
  // Native or SQLite exceptions may contain profile paths or account information.
  console.error(
    stage +
      '失败。' +
      (error instanceof CheckError ? error.message : '请检查本机账号、CLI 和工作台状态。'),
  )
  process.exitCode = 1
} finally {
  try {
    await ws?.close()
  } finally {
    if (root) await rm(root, { recursive: true, force: true })
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}
