import assert from 'node:assert/strict'
import test from 'node:test'
import { codexActivity } from '../desktop/adapters/chat-activity.mjs'

test('overview receives individual agent states without copying their private messages', () => {
  const item = { type: 'collabAgentToolCall', tool: 'wait', receiverThreadIds: ['one', 'two'],
    agentsStates: { one: { status: 'completed', message: 'private' }, two: { status: 'running' } } }
  const updates = codexActivity(item, true)
  assert.deepEqual(updates.map(update => update.agent), [
    { id: 'one', status: 'completed' }, { id: 'two', status: 'running' },
  ])
  assert.ok(!JSON.stringify(updates).includes('private'))
  assert.equal(codexActivity({ type: 'subAgentActivity', kind: 'started', agentThreadId: 'one',
    agentPath: 'reviewer' }, false)[0].agent.name, 'reviewer')
})

test('overview receives web result URLs and the query for searches without result links', () => {
  const item = { type: 'webSearch', query: '桌面工具', results: [
    { url: 'https://example.test/view?id=2&token=secret', snippet: 'unused' },
    { url: 'https://example.test/view?id=2&token=secret' },
  ] }
  assert.deepEqual(codexActivity(item, false), [])
  assert.deepEqual(codexActivity(item, true).map(e => e.source.url), ['https://example.test/view?id=2'])
  assert.equal(codexActivity({ ...item, results: null }, true)[0].source.title, '桌面工具')
})
