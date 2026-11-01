import assert from 'node:assert/strict'
import test from 'node:test'

import { alephKind, alephTrigger } from '../index.js'

test('the aleph Source kind declares a configurable project and an operator allowlist', () => {
  assert.equal(alephKind.kind, 'aleph')
  assert.deepEqual(alephKind.health, ['aleph'])
  assert.equal(alephKind.schema.parse({ project: 'kunlungpt' }).project, 'kunlungpt')
  const policy = alephKind.policy.schema.parse({})
  assert.equal(policy.allowed[0].id, 'operator', 'the operator is allowed by default')
})

test('a local request becomes a trigger on its project ticket thread', () => {
  const trigger = alephTrigger({
    project: 'kunlungpt',
    ticket: 'floors',
    requestId: 'r-1',
    text: 'Measure the clipping floors of POR, PERM and SW.',
  })
  assert.equal(trigger.id, 'aleph:request:r-1')
  assert.equal(trigger.source, 'aleph')
  assert.equal(trigger.threads[0].id, 'research:kunlungpt:ticket:floors')
  assert.equal(trigger.channel.thread, 'aleph:research:kunlungpt:ticket:floors')
  assert.equal(trigger.channel.address.ticket, 'floors')
  assert.equal(trigger.actor.id, 'operator')
  assert.equal(trigger.human, true)
  assert.equal(trigger.addressed, 'mention')
  assert.ok(trigger.at)
})

test('a result trigger carries its score on the same thread', () => {
  const trigger = alephTrigger({ project: 'p', ticket: 'main', requestId: 'e-1', text: 'evaluation finished', kind: 'result', score: 80.5 })
  assert.equal(trigger.id, 'aleph:result:e-1')
  assert.equal(trigger.meta.score, 80.5)
  assert.equal(trigger.threads[0].id, 'research:p:ticket:main')
})
