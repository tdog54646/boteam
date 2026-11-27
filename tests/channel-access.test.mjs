import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { ChannelAccess } from '../desktop/channels/access.mjs'
import { jsonRequest } from '../desktop/channels/transport.mjs'

function setup(t) {
  const native = new DatabaseSync(':memory:')
  t.after(() => native.close())
  native.exec("CREATE TABLE channels(id TEXT PRIMARY KEY); INSERT INTO channels VALUES('discord'),('telegram')")
  return new ChannelAccess({ db: native, run: (q,...args) => native.prepare(q).run(...args), get: (q,...args) => native.prepare(q).get(...args) })
}

test('edited channel policy rejects stale windows and invalid patterns, credentials cascade deletes grants', t => {
  const access = setup(t)
  const first = access.read('discord')
  const event = { sender:'alice', room:'community', group:true, paired:false, mentioned:false, text:'review @triage' }
  assert.equal(access.decision('discord',event),'deny')
  assert.equal(access.decision('discord',{ ...event, paired:true }),'allow')
  const policy = { ...first, groups:[{ room:'community', allowFrom:['alice'], requireMention:true }],
    delivery:{ ...first.delivery, mentionPatterns:['@triage\\b'] } }
  access.save('discord',policy,first)
  assert.equal(access.decision('discord',event),'allow')
  assert.equal(access.decision('discord',{ ...event,text:'review' }),'deny')
  assert.equal(access.decision('discord',{ ...event,sender:'bob' }),'deny')
  assert.throws(() => access.save('discord',first,first), /其他窗口/)
  assert.throws(() => access.save('discord',{ ...policy, delivery:{ ...policy.delivery, mentionPatterns:['['] } }), /规则无效/)
  assert.deepEqual(access.read('discord'),policy)
  access.db.run('DELETE FROM channels WHERE id=?','discord')
  assert.deepEqual(access.read('discord'),first)
})

test('Discord disabled applies to guilds, other platforms keep registered groups when DMs are disabled', t => {
  const access = setup(t)
  for (const id of ['discord','telegram']) {
    const policy = { ...access.read(id), dmPolicy:'disabled', groups:[{ room:'one', requireMention:false, allowFrom:[] }] }
    access.save(id,policy)
    assert.equal(access.decision(id,{ room:'one', group:true }), id === 'discord' ? 'deny' : 'allow')
    assert.equal(access.decision(id,{ room:'one', group:false, paired:true }), 'deny')
  }
})

test('a grant revoked during a platform rate-limit delay prevents a second submission', async t => {
  let requests = 0
  t.mock.method(globalThis,'fetch', async () => {
    requests++
    return Response.json({ retry_after: 0.01 },{ status:429 })
  })
  const request = jsonRequest('https://example.invalid', { retry429:true, beforeSend() {
    if (requests) throw new Error('revoked')
  } })
  await assert.rejects(request,/revoked/)
  assert.equal(requests,1)
})
