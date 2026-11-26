import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { authExpiredError, isAuthExpiredError, shouldOfferAccountReauth } from '../desktop/auth-errors.mjs'
import { Workspace } from '../desktop/workspace.mjs'

test('shouldOfferAccountReauth only triggers on true account or token expiration, never on subagent timeouts, quota, or stop', () => {
  const readyAccount = { id: 'a1', provider: 'antigravity', status: 'ready', loginState: 'signed-in' }
  const loginAccount = { id: 'a2', provider: 'codex', status: 'login', loginState: 'signed-out' }

  // Non-auth failures must NOT show re-auth button
  assert.equal(
    shouldOfferAccountReauth(
      { status: 'failed', error: 'Antigravity 子智能体及主会话连续 10 分钟没有新进展（已收到 2/3 份报告）。' },
      readyAccount,
    ),
    false,
  )
  assert.equal(
    shouldOfferAccountReauth(
      { status: 'failed', error: 'Antigravity 订阅额度或速率已达上限。' },
      readyAccount,
    ),
    false,
  )
  assert.equal(
    shouldOfferAccountReauth(
      { status: 'failed', error: 'Antigravity 本轮达到 token 上限，请缩短输入或将任务分步执行。' },
      readyAccount,
    ),
    false,
  )
  assert.equal(
    shouldOfferAccountReauth(
      { status: 'failed', error: 'Codex 原生请求失败，请检查账号状态和 CLI 版本。' },
      readyAccount,
    ),
    false,
  )
  assert.equal(
    shouldOfferAccountReauth(
      { status: 'interrupted', error: '任务已停止。' },
      loginAccount,
    ),
    false,
  )

  // True auth / credential expiration across Codex, Claude Code, and Antigravity MUST show re-auth button
  assert.equal(
    shouldOfferAccountReauth(
      { status: 'failed', error: 'Antigravity 原生登录已失效，请重新授权。' },
      readyAccount,
    ),
    true,
  )
  assert.equal(
    shouldOfferAccountReauth(
      { status: 'failed', error: 'Codex 访问令牌已过期，请在原客户端刷新登录，或在此重新授权。' },
      readyAccount,
    ),
    true,
  )
  assert.equal(
    shouldOfferAccountReauth(
      { status: 'failed', error: 'Codex 请求刷新订阅凭据，请刷新原登录或重新授权后重试。' },
      readyAccount,
    ),
    true,
  )
  assert.equal(
    shouldOfferAccountReauth(
      { status: 'failed', error: 'Claude 订阅授权已失效，请重新授权。' },
      readyAccount,
    ),
    true,
  )
  assert.equal(
    shouldOfferAccountReauth(
      { status: 'failed', error: '一般错误', authExpired: true },
      readyAccount,
    ),
    true,
  )
  assert.equal(
    shouldOfferAccountReauth(
      { status: 'failed', error: '请求失败' },
      loginAccount,
    ),
    true,
  )
  assert.equal(isAuthExpiredError(authExpiredError('令牌已过期')), true)
})

test('Workspace persists tasks.authExpired accurately for expired vs runtime errors', async t => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'boteam-auth-expired-')))
  const cwd = join(temp, 'repo')
  await mkdir(cwd)
  let nextError = null
  const adapter = {
    async options() { return { models: [], defaultModel: '' } },
    async run() { throw nextError },
  }
  const workspace = new Workspace({ root: join(temp, 'app'), adapters: { antigravity: adapter } })
  t.after(async () => {
    await workspace.close()
    await rm(temp, { recursive: true, force: true })
  })

  workspace.db.run(
    'INSERT INTO accounts(id,provider,identity,info) VALUES(?,?,?,?)',
    'acc',
    'antigravity',
    'google:user@example.com',
    JSON.stringify({ status: 'ready', bin: '/usr/bin/agy' }),
  )
  const botId = await workspace.handle('createBot', { name: 'AGY', cwd, accountId: 'acc' })
  const chatId = await workspace.handle('createChat', { kind: 'direct', members: [botId] })

  nextError = new Error('Antigravity 子智能体及主会话连续 10 分钟没有新进展（已收到 2/3 份报告）。')
  await workspace.handle('send', { chatId, recipients: [botId], text: '第一次' })
  await Promise.all([...workspace.lanes.values()])

  nextError = Object.assign(new Error('Antigravity 原生登录已失效，请重新授权。'), { code: 'AGY_AUTH_REQUIRED', authExpired: true })
  await workspace.handle('send', { chatId, recipients: [botId], text: '第二次' })
  await Promise.all([...workspace.lanes.values()])

  const tasks = workspace.snapshot().tasks.filter(x => x.chatId === chatId)
  assert.equal(tasks.length, 2)
  assert.equal(tasks[0].status, 'failed')
  assert.equal(tasks[0].authExpired, false)
  assert.equal(tasks[1].status, 'failed')
  assert.equal(tasks[1].authExpired, true)
})
