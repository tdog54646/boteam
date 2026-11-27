import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import {
  disjointTurnMetrics,
  inclusiveTurnMetrics,
  turnMetrics,
} from '../desktop/adapters/usage.mjs'
import {
  readAntigravityStepWatermark,
  readAntigravityTurnMetrics,
  usageUpdateMetrics,
} from '../desktop/adapters/antigravity-metrics.mjs'
import { Workspace } from '../desktop/workspace.mjs'
import { profileStats } from '../desktop/profile-stats.mjs'

function encodeVarint(num) {
  let n = BigInt(num)
  const out = []
  while (n >= 0x80n) {
    out.push(Number((n & 0x7fn) | 0x80n))
    n >>= 7n
  }
  out.push(Number(n))
  return Buffer.from(out)
}

function encodeVarintField(fieldNo, val) {
  return Buffer.concat([encodeVarint((fieldNo << 3) | 0), encodeVarint(val)])
}

function encodeBytesField(fieldNo, buf) {
  return Buffer.concat([encodeVarint((fieldNo << 3) | 2), encodeVarint(buf.length), buf])
}

function encodeTimestamp(ms) {
  const sec = Math.floor(ms / 1000)
  const nanos = (ms % 1000) * 1_000_000
  return Buffer.concat([encodeVarintField(1, sec), encodeVarintField(2, nanos)])
}

test('Codex inclusive and Claude/Antigravity disjoint token metrics compute exact speed and cache hit rate', () => {
  // Codex TokenUsageBreakdown: inputTokens (20,000) already includes cachedInputTokens (15,000)
  const codex = inclusiveTurnMetrics(
    {
      inputTokens: 20_000,
      cachedInputTokens: 15_000,
      cacheWriteInputTokens: 0,
      outputTokens: 480,
      reasoningOutputTokens: 120,
      totalTokens: 20_480,
    },
    6_000,
    'gpt-5.4',
  )
  assert.deepEqual(codex, {
    inputTokens: 20_000,
    cachedInputTokens: 15_000,
    cacheCreationTokens: 0,
    outputTokens: 480,
    reasoningTokens: 120,
    durationMs: 6_000,
    tokensPerSecond: 80,
    cacheHitPercent: 75,
    model: 'gpt-5.4',
  })

  // Legacy Codex partial mocks without inputTokens/outputTokens do not emit synthetic zero metrics
  assert.equal(inclusiveTurnMetrics({ totalTokens: 300 }, 1000, 'gpt-5.4'), undefined)

  // Claude stream-json / result usage: disjoint uncached + cache_creation + cache_read
  const claude = disjointTurnMetrics({
    uncachedInputTokens: 1_500,
    cacheCreationTokens: 2_500,
    cachedInputTokens: 16_000,
    outputTokens: 360,
    durationMs: 4_500,
    model: 'claude-sonnet-4-6',
  })
  assert.deepEqual(claude, {
    inputTokens: 20_000,
    cachedInputTokens: 16_000,
    cacheCreationTokens: 2_500,
    outputTokens: 360,
    reasoningTokens: 0,
    durationMs: 4_500,
    tokensPerSecond: 80,
    cacheHitPercent: 80,
    model: 'claude-sonnet-4-6',
  })

  assert.equal(turnMetrics({}), undefined)
})

test('Antigravity native SQLite step metadata and transcript fallback decode turn speed and cache hit rate', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'boteam-agy-metrics-'))
  await chmod(home, 0o700)
  t.after(() => rm(home, { recursive: true, force: true }))

  const cliDir = join(home, '.gemini', 'antigravity-cli')
  const convDir = join(cliDir, 'conversations')
  await mkdir(convDir, { recursive: true, mode: 0o700 })

  const sessionId = '30801200-e8d2-4709-9372-98fba2880d2a'
  const dbPath = join(convDir, sessionId + '.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE steps (
      idx integer PRIMARY KEY,
      step_type integer NOT NULL DEFAULT 0,
      status integer NOT NULL DEFAULT 0,
      metadata blob
    );
  `)
  const insertStep = db.prepare('INSERT INTO steps(idx, step_type, status, metadata) VALUES (?, ?, ?, ?)')

  // Previous turn step (idx = 1)
  const prevUsage = Buffer.concat([
    encodeVarintField(2, 5000),
    encodeVarintField(3, 200),
    encodeVarintField(5, 0),
  ])
  const prevMeta = Buffer.concat([
    encodeBytesField(1, encodeTimestamp(1_700_000_000_000)),
    encodeBytesField(7, encodeTimestamp(1_700_000_002_000)),
    encodeBytesField(9, prevUsage),
  ])
  insertStep.run(1, 15, 3, prevMeta)

  const watermark = await readAntigravityStepWatermark(home, sessionId)
  assert.equal(watermark, 1)

  // Current turn has two planner steps (idx = 3 and idx = 5)
  const step3Meta = Buffer.concat([
    encodeBytesField(1, encodeTimestamp(1_700_000_010_000)),
    encodeBytesField(7, encodeTimestamp(1_700_000_012_500)), // 2500ms
    encodeBytesField(
      9,
      Buffer.concat([
        encodeVarintField(2, 2_000), // uncached
        encodeVarintField(3, 300), // output
        encodeVarintField(5, 8_000), // cached
        encodeVarintField(10, 60), // thinking
      ]),
    ),
  ])
  const step5Meta = Buffer.concat([
    encodeBytesField(1, encodeTimestamp(1_700_000_015_000)),
    encodeBytesField(7, encodeTimestamp(1_700_000_017_500)), // 2500ms
    encodeBytesField(
      9,
      Buffer.concat([
        encodeVarintField(2, 1_000), // uncached
        encodeVarintField(3, 200), // output
        encodeVarintField(5, 9_000), // cached
        encodeVarintField(10, 40), // thinking
      ]),
    ),
  ])
  insertStep.run(3, 15, 3, step3Meta)
  insertStep.run(5, 15, 3, step5Meta)
  db.close()
  await chmod(dbPath, 0o600)

  const metrics = await readAntigravityTurnMetrics(
    home,
    sessionId,
    watermark,
    9_999,
    'gemini-4-carbon-high',
  )
  // Total input = (2000 + 1000) + (8000 + 9000) = 20,000; cached = 17,000 -> 85%
  // Total output = 500 over (2500 + 2500) = 5000ms -> 100 tok/s; thinking = 100
  assert.deepEqual(metrics, {
    inputTokens: 20_000,
    cachedInputTokens: 17_000,
    cacheCreationTokens: 0,
    outputTokens: 500,
    reasoningTokens: 100,
    durationMs: 5_000,
    tokensPerSecond: 100,
    cacheHitPercent: 85,
    model: 'gemini-4-carbon-high',
  })

  // Transcript fallback when SQLite DB is absent
  const transcriptId = '9906147e-0015-4bae-b4e1-bea696d34de5'
  const logDir = join(cliDir, 'brain', transcriptId, '.system_generated', 'logs')
  await mkdir(logDir, { recursive: true, mode: 0o700 })
  const trPath = join(logDir, 'transcript.jsonl')
  await writeFile(
    trPath,
    [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT' }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        model: 'gemini-4-neon-high',
        input_tokens: 4_000,
        cache_read_tokens: 12_000,
        output_tokens: 400,
      }),
    ].join('\n') + '\n',
    { mode: 0o600 },
  )
  const fallback = await readAntigravityTurnMetrics(home, transcriptId, -1, 4_000, '')
  assert.deepEqual(fallback, {
    inputTokens: 16_000,
    cachedInputTokens: 12_000,
    cacheCreationTokens: 0,
    outputTokens: 400,
    reasoningTokens: 0,
    durationMs: 4_000,
    tokensPerSecond: 100,
    cacheHitPercent: 75,
    model: 'gemini-4-neon-high',
  })

  // ACP usage_update fallback
  const acpFallback = usageUpdateMetrics(
    { used: 10000, size: 200000, _meta: { inputTokens: 2500, cachedInputTokens: 7500, outputTokens: 250 } },
    2_500,
    'gemini-4-carbon-high',
  )
  assert.equal(acpFallback.tokensPerSecond, 100)
  assert.equal(acpFallback.cacheHitPercent, 75)
})

test('Workspace persists live in-turn metrics without double-counting and accumulates multi-turn session stats', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'boteam-ws-metrics-'))
  let turnNumber = 0
  const adapter = {
    permissionModes: ['default'],
    options: async () => ({ models: [{ id: 'gpt-5.4', efforts: [] }], defaultModel: 'gpt-5.4' }),
    async run({ chatId, bot, threadId, emit }) {
      turnNumber += 1
      emit({ type: 'identity', key: 'owner', value: 'owner@example.com' })
      emit({ type: 'session', value: threadId || `${chatId}-${bot.id}` })
      if (turnNumber === 1) {
        // Live streaming mid-turn update #1
        emit({
          type: 'metrics',
          value: {
            inputTokens: 10_000,
            cachedInputTokens: 6_000,
            outputTokens: 150,
            durationMs: 2_000,
            model: 'gpt-5.4',
          },
        })
        // Final turn #1 update (replaces turn #1 stats without incrementing turnCount!)
        emit({
          type: 'metrics',
          value: {
            inputTokens: 20_000,
            cachedInputTokens: 15_000,
            outputTokens: 400,
            reasoningTokens: 80,
            durationMs: 4_000,
            model: 'gpt-5.4',
          },
        })
      } else {
        // Turn #2 update (accumulates session totals!)
        emit({
          type: 'metrics',
          value: {
            inputTokens: 30_000,
            cachedInputTokens: 25_000,
            outputTokens: 600,
            reasoningTokens: 100,
            durationMs: 6_000,
            model: 'gpt-5.4',
          },
        })
      }
      emit({ type: 'text', value: `reply-${turnNumber}` })
    },
  }

  let app = new Workspace({ root, adapters: { codex: adapter } })
  t.after(async () => {
    await app?.close()
    await rm(root, { recursive: true, force: true })
  })
  app.db.run(
    'INSERT INTO accounts(id,provider,identity,info) VALUES(?,?,?,?)',
    'acc-1',
    'codex',
    'owner',
    JSON.stringify({ status: 'ready' }),
  )
  const botId = await app.handle('createBot', { accountId: 'acc-1', name: '助手' })
  const chatId = await app.handle('createChat', { kind: 'direct', members: [botId] })

  await app.handle('send', { chatId, recipients: [botId], text: '第一轮' })
  for (let i = 0; i < 60 && app.snapshot().tasks.some((x) => x.status !== 'done'); i++) await delay(15)

  let m = app.snapshot().tokenMetrics.find((r) => r.chatId === chatId && r.botId === botId)
  assert.ok(m)
  assert.equal(m.turnCount, 1)
  assert.equal(m.tokensPerSecond, 100) // 400 / 4s
  assert.equal(m.cacheHitPercent, 75) // 15000 / 20000
  assert.equal(m.sessionInputTokens, 20_000)
  assert.equal(m.sessionOutputTokens, 400)

  await app.handle('send', { chatId, recipients: [botId], text: '第二轮' })
  for (let i = 0; i < 60 && app.snapshot().tasks.some((x) => x.status !== 'done'); i++) await delay(15)

  // Restart Workspace to verify SQLite durability
  await app.close()
  app = new Workspace({ root, adapters: { codex: adapter } })
  m = app.snapshot().tokenMetrics.find((r) => r.chatId === chatId && r.botId === botId)
  assert.ok(m)
  assert.equal(m.turnCount, 2)
  assert.equal(m.tokensPerSecond, 100) // 600 / 6s
  assert.equal(m.cacheHitPercent, 83.3) // 25000 / 30000
  assert.equal(m.sessionInputTokens, 50_000) // 20000 + 30000
  assert.equal(m.sessionCachedTokens, 40_000) // 15000 + 25000
  assert.equal(m.sessionCacheHitPercent, 80) // 40000 / 50000
  assert.equal(m.sessionOutputTokens, 1_000) // 400 + 600
  assert.equal(m.sessionTokensPerSecond, 100) // 1000 / 10s

  const dates = [new Date(2026, 2, 7, 12), new Date(2026, 2, 8, 12)]
  for (const [index, task] of app.snapshot().tasks.entries()) {
    const settings = { effort: 'high', extensionIds: ['skill:review','plugin:design'],
      extensionLabels: ['Review','Design'] }
    app.db.run('UPDATE tasks SET startedAt=?,completedAt=?,runSettings=? WHERE id=?',
      dates[index].toISOString(), new Date(+dates[index] + 5_000 * (index + 1)).toISOString(),
      JSON.stringify(settings), task.id)
  }
  const branch = await app.handle('forkChat', { chatId })
  const stats = await app.handle('profileStats')
  assert.deepEqual(stats.dailyTokens, [{ date:'2026-03-07', tokens:20_400 }, { date:'2026-03-08', tokens:30_600 }])
  assert.equal(stats.totalTokens, 51_000)
  assert.equal(stats.undatedTokens, 0)
  assert.equal(stats.peakTokens, 30_600)
  assert.equal(stats.longestTaskMs, 10_000)
  assert.equal(stats.longestStreak, 2)
  assert.equal(profileStats(app.db, new Date(2026, 2, 9)).currentStreak, 2)
  assert.equal(profileStats(app.db, new Date(2026, 2, 10)).currentStreak, 0)
  assert.equal(stats.runCount, 2)
  assert.deepEqual(stats.topEffort, { id:'high', count:2, percent:100 })
  assert.deepEqual(stats.topPlugins, [{ id:'plugin:design', label:'Design', count:2 }])
  assert.equal(stats.uniqueSkills, 1)
  assert.equal(stats.skillUses, 2)

  // Before per-task metrics were stored, only the latest turn was dated.
  // An old workspace also had no marker distinguishing a fork's copied tasks.
  app.db.db.exec('ALTER TABLE tasks DROP COLUMN totalTokens; ALTER TABLE tasks DROP COLUMN inherited;')
  await app.close()
  app = new Workspace({ root, adapters: { codex: adapter } })
  const legacy = await app.handle('profileStats')
  assert.equal(legacy.totalTokens, 51_000)
  assert.equal(legacy.undatedTokens, 20_400)
  assert.deepEqual(legacy.dailyTokens, [{ date:'2026-03-08', tokens:30_600 }])
  assert.equal(legacy.runCount, 2)
  assert.equal(legacy.skillUses, 2)

  await app.handle('deleteChat', { chatId })
  assert.equal(app.snapshot().tokenMetrics.length, 0)
  assert.equal((await app.handle('profileStats')).runCount, 0)
  assert.equal(app.snapshot().tasks.filter(task => task.chatId === branch).length, 2)
})
