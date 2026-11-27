import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Workspace } from '../desktop/workspace.mjs'
import { nextOccurrence } from '../desktop/schedules.mjs'

const at = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute).getTime()

test('the next local occurrence is strictly in the future, including week and month boundaries', () => {
  assert.equal(nextOccurrence({ frequency: 'hourly', minute: 15 }, at(30, 23, 16)), at(31, 0, 15))
  assert.equal(nextOccurrence({ frequency: 'daily', time: '09:30' }, at(27, 9, 30)), at(28, 9, 30))
  assert.equal(nextOccurrence({ frequency: 'weekly', time: '09:30', days: [1, 5] }, at(27, 9, 30)), at(30, 9, 30))
  assert.equal(nextOccurrence({ frequency: 'once', at: at(28, 9) }, at(27, 9)), at(28, 9))
  assert.equal(nextOccurrence({ frequency: 'once', at: at(28, 9) }, at(28, 9)), null)
  assert.equal(nextOccurrence({ frequency: 'monthly', day: 31, time: '12:00' }, at(1, 0)), new Date(2026, 11, 31, 12).getTime())
  assert.equal(nextOccurrence({ frequency: 'yearly', month: 2, day: 29, time: '12:00' }, new Date(2096, 2, 1).getTime()),
    new Date(2104, 1, 29, 12).getTime())
})

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'boteam-schedule-'))
  const calls = [], bots = {}
  const adapters = Object.fromEntries(['codex', 'claude', 'antigravity'].map(provider => [provider, {
    async run(task) {
      calls.push({ provider, task })
      task.emit({ type: 'identity', key: 'owner', value: 'owner' })
      task.emit({ type: 'session', value: task.chatId })
    },
  }]))
  let app, scheduler
  function setup() {
    app = new Workspace({root, adapters})
    scheduler = app.schedules
    // Exercise the same dispatch function the timer calls, at a deterministic instant.
    scheduler.close()
  }
  setup()
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }) })
  for (const provider of Object.keys(adapters)) {
    app.db.run("INSERT INTO accounts(id,provider,identity,info) VALUES(?,?,'owner','{\"status\":\"ready\"}')", provider, provider)
    bots[provider] = await app.handle('createBot', { name: provider, accountId: provider })
  }
  return { bots, calls, get app() { return app }, get scheduler() { return scheduler },
    restart: async () => { await app.close(); setup() },
    action: (method, payload) => app.handle('schedule:' + method, payload),
    save: (overrides = {}) => app.handle('schedule:save', { name: 'Run report', prompt: 'Summarize changes',
      rule: { frequency: 'daily', time: '10:15' }, botId: bots.codex, ...overrides }) }
}

test('manual runs use the selected provider and persist each result even after deleting its chat', async t => {
  const f = await fixture(t)
  for (const [provider, botId] of Object.entries(f.bots)) {
    const id = await f.save({ botId })
    await f.action('run', { id })
    await Promise.all(f.app.lanes.values())
    const job = f.scheduler.snapshot().find(j => j.id === id)
    assert.equal(job.runs[0].status, 'done')
    assert.equal(job.runs[0].source, 'manual')
    const chatId = job.runs[0].chatId
    assert.ok(chatId)
    assert.equal(f.calls.at(-1).provider, provider)
    assert.equal(f.calls.at(-1).task.prompt, 'Summarize changes')
    await f.app.handle('deleteChat', { chatId })
    const run = f.scheduler.snapshot().find(j => j.id === id).runs[0]
    assert.equal(run.status, 'done')
    assert.equal(run.chatId, null)
  }
  await f.restart()
  assert.equal(f.scheduler.snapshot().length, 3)
})

test('an overdue recurring schedule catches up once and ignores duplicate ticks while a run is active', async t => {
  const f = await fixture(t)
  const id = await f.save()
  const [job] = f.scheduler.snapshot()
  const due = job.nextRunAt + 3 * 24 * 60 * 60 * 1000
  await Promise.all([f.scheduler.tick(due), f.scheduler.tick(due)])
  await Promise.all(f.app.lanes.values())
  const updated = f.scheduler.snapshot()[0]
  assert.equal(updated.runs.length, 1)
  assert.equal(updated.runs[0].source, 'scheduled')
  assert.ok(updated.nextRunAt > due)
  await f.action('toggle', { id, enabled: false })
  await f.scheduler.tick(updated.nextRunAt)
  assert.equal(f.scheduler.snapshot()[0].runs.length, 1)
  const onceId = await f.save({ rule: { frequency: 'once', at: due } })
  await f.scheduler.tick(due)
  assert.equal(f.scheduler.snapshot().find(s => s.id === onceId).enabled, false)
})

test('invalid rules, missing targets, stale edits and failed dispatches are visible and do not enqueue extra work', async t => {
  const f = await fixture(t)
  await assert.rejects(f.save({ rule: { frequency: 'weekly', time: '24:00', days: [1] } }), /时间/)
  await assert.rejects(f.save({ rule: { frequency: 'weekly', time: '12:30', days: [] } }), /日期/)
  await assert.rejects(f.save({ projectId: 'missing' }), /项目/)
  const id = await f.save()
  const [initial] = f.scheduler.snapshot()
  await f.save({ id, revision: initial.revision, name: 'Updated' })
  await assert.rejects(f.save({ id, revision: initial.revision, name: 'Stale' }), /其他窗口/)
  await f.app.handle('removeBot', { id: f.bots.codex })
  await f.action('run', { id })
  const [job] = f.scheduler.snapshot()
  assert.equal(job.runs[0].status, 'failed')
  assert.match(job.runs[0].error, /Bot/)
  assert.equal(f.app.snapshot().chats.length, 0)
  await f.action('delete', { id })
  assert.deepEqual(f.scheduler.snapshot(), [])
})

test('a pending approval prevents overlapping manual and scheduled runs', async t => {
  const f = await fixture(t)
  let entered
  const waiting = new Promise(resolve => { entered = resolve })
  f.app.adapters.codex.run = async task => {
    task.emit({ type: 'identity', key: 'owner', value: 'owner' })
    const pending = task.approve({ kind: 'command', title: 'Confirm test action' })
    entered()
    await pending
  }
  const id = await f.save()
  await f.action('run', { id })
  await waiting
  assert.equal(f.scheduler.snapshot()[0].runs[0].status, 'approval')
  await assert.rejects(f.action('run', { id }), /正在运行/)
  await f.scheduler.tick(f.scheduler.snapshot()[0].nextRunAt)
  const [job] = f.scheduler.snapshot()
  assert.equal(job.runs[0].status, 'skipped')
  assert.equal(job.runs[1].status, 'approval')
  const [task] = f.app.snapshot().tasks
  f.app.cancel(task.id)
  await Promise.all(f.app.lanes.values())
  assert.equal(f.scheduler.snapshot()[0].runs[1].status, 'interrupted')
})
