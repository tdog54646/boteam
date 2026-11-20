// Opt-in. Sends one short task to each available, already-bound Codex / Antigravity subscription.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { Workspace } from '../desktop/workspace.mjs'
import * as codex from '../desktop/adapters/codex.mjs'
import * as antigravity from '../desktop/adapters/antigravity.mjs'

if (!process.argv.includes('--live') || process.platform !== 'darwin')
  throw new Error('在 macOS 显式传入 --live 以使用已绑定的订阅。')
const db = new DatabaseSync(
  join(homedir(), 'Library/Application Support/BoTeam/workspace.sqlite3'),
  { readOnly: true },
)
const accounts = db
  .prepare(
    "SELECT * FROM accounts WHERE provider IN ('codex','antigravity') AND json_extract(info,'$.status')='ready' ORDER BY rowid",
  )
  .all()
db.close()
const root = await mkdtemp(join(tmpdir(), 'boteam-composer-live-'))
const outside = await mkdtemp(join(tmpdir(), 'boteam-composer-outside-'))
const ws = new Workspace({ root, adapters: { codex, antigravity } })
try {
  assert.ok(accounts.length, '未找到可用的绑定账号')
  const checked = new Set()
  for (const { id, identity, provider, info } of accounts) {
    const filter = process.argv
      .find((arg) => arg.startsWith('--provider='))
      ?.slice('--provider='.length)
    if (filter && filter !== provider) continue
    if (checked.has(provider)) continue
    checked.add(provider)
    const data = JSON.parse(info)
    delete data.cwd
    if (provider === 'codex') {
      data.source = join(root, 'profiles', 'codex')
      await mkdir(data.source, { recursive: true, mode: 0o700 })
    }
    ws.db.run(
      'INSERT INTO accounts(id,provider,identity,info) VALUES(?,?,?,?)',
      id,
      provider,
      identity,
      JSON.stringify(data),
    )
    const botId = await ws.handle('createBot', { accountId: id, name: '验收' })
    const chatId = await ws.handle('createChat', { kind: 'direct', members: [botId] })
    const catalog = await ws.handle('botOptions', { accountId: id })
    const preferred = provider === 'codex' ? 'gpt-5.6-sol' : 'gemini-4-neon'
    const model =
      catalog.models.find((m) => m.id === preferred) ||
      catalog.models.find((m) => m.efforts?.some((e) => e.id === 'low')) ||
      catalog.models[0]
    assert.ok(model, '原生客户端没有提供模型')
    const effort = model.efforts?.find((e) => e.id === 'low')?.id || ''
    const permission = provider === 'codex' ? 'full' : 'plan'
    await ws.handle('setComposerSettings', { chatId, botId, model: model.id, effort, permission })
    const quota = await ws.handle('refreshQuota', { chatId, botId })
    assert.ok(quota?.windows.length, '未读取到订阅额度')
    const marker = 'COMPOSER-' + randomBytes(4).toString('hex')
    const [file] = await ws.handle('addAttachments', {
      scope: chatId,
      files: [{ name: '标记.txt', text: marker }],
    })
    const target = join(outside, 'marked.txt')
    const text =
      provider === 'codex'
        ? '读取附件中的标记，用命令把它原样写到此临时验收文件 ' + target + '，再只回复标记。'
        : '请直接读出附件所含标记。只回复标记，不使用工具。'
    const messageId = await ws.handle('send', {
      chatId,
      recipients: [botId],
      text,
      attachmentIds: [file.id],
    })
    let task
    const until = Date.now() + 150000
    while (Date.now() < until) {
      task = ws.db.get('SELECT * FROM tasks WHERE messageId=?', messageId)
      if (!['running', 'queued'].includes(task.status)) break
      await delay(200)
    }
    assert.equal(task.status, 'done', provider + ' 原生任务失败或超时。' + (task.error || ''))
    assert.equal(task.verifiedKey, identity)
    const reply = ws.db.get('SELECT text FROM messages WHERE taskId=?', task.id)
    assert.ok(reply.text.includes(marker), provider + ' 未返回附件标记')
    if (provider === 'codex') assert.equal((await readFile(target, 'utf8')).trim(), marker)
    const usage = ws.snapshot().contextUsage.find((c) => c.chatId === chatId && c.botId === botId)
    if (provider === 'codex') assert.ok(usage?.limit && usage.used > 0, '未收到 Codex 线程上下文')
    console.log(
      JSON.stringify({
        provider,
        model: model.id,
        effort,
        permission,
        quotaWindows: quota.windows.map((w) => w.minutes),
        context: usage ? { used: usage.used, limit: usage.limit } : null,
        attachmentRead: true,
        identityVerified: true,
        ...(provider === 'codex' ? { outsideWorkspaceWrite: true } : {}),
      }),
    )
  }
  assert.ok(checked.size, '指定工具没有可用的绑定账号。')
} catch (error) {
  // Tests never print account records, raw credentials, or native protocol frames.
  console.error(error.message)
  process.exitCode = 1
} finally {
  await ws.close()
  await Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ])
}
