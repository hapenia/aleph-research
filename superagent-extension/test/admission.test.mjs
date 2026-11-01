import assert from 'node:assert/strict'
import test from 'node:test'

import { admitRequest, admissionText } from '../admission.js'

const budget = { autoTiers: ['explore', 'analysis'], attentionTiers: ['training', 'design'], maxAutoPerHour: 2 }

test('a cheap request is admitted automatically', () => {
  const result = admitRequest({ text: 'count the rows per well', budget })
  assert.equal(result.accepted, true)
  assert.equal(result.auto, true)
  assert.equal(result.tier, 'analysis')
  assert.equal(result.confirmationRequired, false)
  assert.match(admissionText(result), /automatically/)
})

test('a training request waits for a person unless confirmed', () => {
  const waiting = admitRequest({ text: 'run a new hyperparameter sweep on gpu', budget })
  assert.equal(waiting.accepted, false)
  assert.equal(waiting.tier, 'training')
  assert.equal(waiting.confirmationRequired, true)
  assert.match(admissionText(waiting), /waiting for a person/)

  const confirmed = admitRequest({ text: 'run a new hyperparameter sweep on gpu', confirmed: true, budget })
  assert.equal(confirmed.accepted, true)
  assert.equal(confirmed.auto, false)
  assert.match(admissionText(confirmed), /by confirmation/)
})

test('the hourly cap stops automatic admission even for cheap work', () => {
  const result = admitRequest({ text: 'count the rows per well', budget, usage: { autoAcceptedLastHour: 2 } })
  assert.equal(result.accepted, false)
  assert.equal(result.confirmationRequired, true)
  assert.match(result.reason, /hourly budget/)
})

test('malformed input never throws and lands on the conservative side', () => {
  const result = admitRequest({ budget: { autoTiers: [], attentionTiers: [] } })
  assert.equal(result.tier, 'explore')
  assert.equal(result.accepted, false)
  assert.equal(admissionText({ accepted: false, tier: 'explore', reason: 'x', auto: false }), 'waiting for a person (explore): x')
})
