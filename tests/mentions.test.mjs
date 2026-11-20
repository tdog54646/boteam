import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveMentions } from '../src/mentions.js'

const members = [
  { id: 'a', name: '小白' },
  { id: 'b', name: '小白' },
  { id: 'c', name: 'Code Review' },
  { id: 'd', name: 'Code' },
]

test('pasted group mentions use exact, longest member names and explicit duplicate-name choices', () => {
  const text = '@Code Review， @小白 帮忙检查。'
  const tokens = resolveMentions(text, members)
  assert.deepEqual(
    tokens.map((t) => t.ids),
    [['c'], []],
  )
  assert.equal(tokens[1].ambiguous, true)
  assert.deepEqual(
    resolveMentions(text, members, ['b']).map((t) => t.ids),
    [['c'], ['b']],
  )
  assert.deepEqual(resolveMentions('@CodeReview 不应匹配', members), [])
})

test('everyone resolves current membership, email addresses do not dispatch', () => {
  assert.deepEqual(resolveMentions('发给 @全体成员。', members)[0].ids, ['a', 'b', 'c', 'd'])
  assert.deepEqual(resolveMentions('＠全体 来看', members.slice(1))[0].ids, ['b', 'c', 'd'])
  assert.deepEqual(resolveMentions('联系 abc@Code.test', members), [])
})
