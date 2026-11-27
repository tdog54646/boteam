import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../desktop/workspace.mjs'

test('desktop alerts observe each stored preference and scheduled runs emit one result', async t => {
  const root = await mkdtemp(join(tmpdir(), 'boteam-alerts-'))
  const delivered = []
  let requestApproval
  const options = {
    root, showNotification: event => delivered.push(event),
    adapters: { codex: { async run({ emit, approve, prompt }) {
      emit({ type: 'identity', key: 'owner', value: 'owner' })
      if (prompt === 'approval') {
        const answer = approve({ kind: 'command', title: 'Test approval' })
        requestApproval()
        await answer
      }
      if (prompt === 'fail') throw new Error('Test failure')
    } } },
  }
  let ws = new Workspace(options)
  t.after(async () => { await ws.close(); await rm(root, { recursive: true, force: true }) })
  ws.db.run('INSERT INTO accounts(id,provider,identity,info) VALUES(?,?,?,?)', 'account', 'codex', 'owner', JSON.stringify({ status:'ready' }))
  const bot = await ws.handle('createBot', { name:'Test Bot', accountId:'account' })
  const chatId = await ws.handle('createChat', { kind:'direct', members:[bot] })
  const send = async text => {
    await ws.handle('send', { chatId, recipients:[bot], text })
    await Promise.all(ws.lanes.values())
  }
  const preference = (type, enabled) => ws.handle('setNotificationSetting', { type, enabled })
  await ws.handle('syncNotificationLanguage', { language:'en' })
  await send('quiet')
  assert.equal(delivered.length, 0)
  await assert.rejects(preference('unknown', true))
  for (const key of ['completed','failed','approval','schedule']) await preference(key,true)
  await ws.close()
  ws = new Workspace(options)
  assert.equal(ws.snapshot().notifications.schedule, true)
  const awaiting = new Promise(resolve => { requestApproval = resolve })
  const sent = send('approval')
  await awaiting
  const task = ws.snapshot().tasks.find(row => row.status === 'approval')
  ws.decide({ taskId:task.id, approvalId:task.approval.id, allow:false })
  await sent
  await send('fail')
  const id = await ws.handle('schedule:save', { name:'Job', prompt:'scheduled', botId:bot, rule:{ frequency:'daily', time:'13:21' } })
  await ws.handle('schedule:run', { id })
  await Promise.all(ws.lanes.values())
  assert.deepEqual(delivered.map(event => event.type), ['approval','completed','failed','schedule'])
  assert.equal(delivered.at(-1).name, 'Job')
  assert.equal(delivered[0].chatId, chatId)
  assert.equal(delivered[0].language, 'en')
  await preference('completed',false)
  await send('quiet again')
  assert.equal(delivered.length, 4)
})
