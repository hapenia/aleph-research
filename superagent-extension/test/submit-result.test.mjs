import assert from 'node:assert/strict'
import test from 'node:test'

import { findTicketForDirectory, resultTrigger, threadOfTicket } from '../submit-result.js'

const ticket = {
  id: 't-1',
  execution: { name: 'count-well-por', directory: '/tmp/run/state/work/count-well-por' },
  channels: [{ source: 'aleph', thread: 'aleph:research:fixture:ticket:fixture-smoke', address: { project: 'fixture', ticket: 'fixture-smoke' } }],
}

test('a ticket thread comes from its channel address', () => {
  assert.deepEqual(threadOfTicket(ticket), { source: 'aleph', id: 'research:fixture:ticket:fixture-smoke' })
  assert.equal(threadOfTicket({ channels: [] }), null)
})

test('a result trigger lands on the ticket thread with its score', () => {
  const trigger = resultTrigger({ project: 'fixture', ticket, score: 80.5, evaluationId: 'eval-1' })
  assert.equal(trigger.id, 'aleph:result:eval-1')
  assert.deepEqual(trigger.threads, [{ source: 'aleph', id: 'research:fixture:ticket:fixture-smoke' }])
  assert.equal(trigger.channel.thread, 'aleph:research:fixture:ticket:fixture-smoke')
  assert.deepEqual(trigger.channel.address, { project: 'fixture', ticket: 'fixture-smoke' })
  assert.equal(trigger.meta.score, 80.5)
  assert.equal(trigger.meta.kind, 'result')
  assert.equal(trigger.human, false)
  assert.match(trigger.text, /80\.5/)
})

test('a ticket is found by its execution directory and tolerates a trailing slash', () => {
  assert.equal(findTicketForDirectory([ticket], '/tmp/run/state/work/count-well-por/')?.id, 't-1')
  assert.equal(findTicketForDirectory([ticket], '/tmp/run/state/work/other'), null)
  assert.equal(findTicketForDirectory([], '/tmp'), null)
})
