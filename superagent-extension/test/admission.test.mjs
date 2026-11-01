import assert from 'node:assert/strict'
import test from 'node:test'

import { admitRequest, admissionText, tierForResources } from '../admission.js'

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


test('declared GPU or heavy CPU resources escalate to a person', () => {
  assert.equal(tierForResources({ gpu: true }), 'training')
  assert.equal(tierForResources({ cpu: 8 }), 'training')
  assert.equal(tierForResources({ memoryGb: 64 }), 'training')
  assert.equal(tierForResources({ cpu: 2, gpu: false }), null)

  const gpu = admitRequest({ text: 'count rows', budget, resources: { gpu: true } })
  assert.equal(gpu.tier, 'training')
  assert.equal(gpu.accepted, false)
  const confirmed = admitRequest({ text: 'count rows', budget, resources: { gpu: true }, confirmed: true })
  assert.equal(confirmed.accepted, true)
  assert.match(confirmed.reason, /confirmed by a person/)

  const small = admitRequest({ text: 'count rows', budget, resources: { cpu: 2 } })
  assert.equal(small.accepted, true)
})
