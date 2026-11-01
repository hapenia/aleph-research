import assert from 'node:assert/strict'
import test from 'node:test'

import { TIERS, classifyRequest, decideAcceptance, parseBudget } from '../budget.js'

const HOUR_MS = 60 * 60 * 1000
const NOW = Date.parse('2026-06-01T12:00:00.000Z')
const DEFAULT_BUDGET = {
  autoTiers: ['explore', 'analysis'],
  attentionTiers: ['training', 'design'],
  maxAutoPerHour: null,
}

/** A ticket history entry `hoursAgo` hours before `NOW`. */
function ticket(tier, hoursAgo) {
  return { tier, at: new Date(NOW - hoursAgo * HOUR_MS).toISOString() }
}

test('TIERS lists the cost tiers from cheapest to most expensive', () => {
  assert.deepEqual(TIERS, ['explore', 'analysis', 'training', 'design'])
})

test('training keywords classify a request as training', () => {
  for (const keyword of ['training', 'sweep', 'hyperparameter', 'gpu', 'finetune', 'train']) {
    const result = classifyRequest({ text: `Please ${keyword} the model over the weekend.` })
    assert.equal(result.tier, 'training', keyword)
    assert.match(result.reason, /training/)
  }
})

test('design keywords classify a request as design', () => {
  for (const keyword of ['design', 'spec', 'architecture', 'api', 'proposal']) {
    const result = classifyRequest({ text: `Draft a ${keyword} for the next run.` })
    assert.equal(result.tier, 'design', keyword)
    assert.match(result.reason, /design/)
  }
})

test('analysis keywords classify a request as analysis', () => {
  for (const keyword of ['profile', 'measure', 'count', 'visualise', 'analyse', 'analysis']) {
    const result = classifyRequest({ text: `Please ${keyword} the results.` })
    assert.equal(result.tier, 'analysis', keyword)
    assert.match(result.reason, /analysis/)
  }
})

test('the most expensive matching tier wins', () => {
  assert.equal(classifyRequest({ text: 'Design a training sweep for the GPU.' }).tier, 'training')
  assert.equal(classifyRequest({ text: 'Analyse the API surface.' }).tier, 'design', 'design outranks analysis')
})

test('text without keywords falls back to explore', () => {
  const result = classifyRequest({ text: 'Write a short summary of the last meeting.' })
  assert.deepEqual(result, { tier: 'explore', reason: 'no tier keywords matched' })
})

test('keywords match whole words only', () => {
  // "rapid" contains "api", "special" contains "spec", "countertop" contains "count".
  const result = classifyRequest({ text: 'The rapid countertop inspection was special.' })
  assert.equal(result.tier, 'explore')
})

test('text is trimmed and lowercased before matching', () => {
  assert.equal(classifyRequest({ text: '  RUN A GPU SWEEP  ' }).tier, 'training')
  assert.equal(classifyRequest({ text: 'Draft the API SPEC' }).tier, 'design')
})

test('empty, undefined and non-string text are treated as explore', () => {
  for (const text of [undefined, '', '   ', 42, null, {}, []]) {
    assert.equal(classifyRequest({ text }).tier, 'explore', String(text))
  }
  assert.equal(classifyRequest().tier, 'explore')
  assert.equal(classifyRequest(null).tier, 'explore')
  assert.equal(classifyRequest('a bare string is not a request object').tier, 'explore')
})

test('two recent tickets of the same tier are mentioned in the reason', () => {
  const result = classifyRequest({
    text: 'Measure the clipping floors of POR.',
    history: [ticket('analysis', 2), ticket('analysis', 20)],
    now: NOW,
  })
  assert.equal(result.tier, 'analysis')
  assert.match(result.reason, /2 analysis tickets in the last 24h/)
})

test('a single recent ticket does not add a history note', () => {
  const result = classifyRequest({ text: 'Profile the layers.', history: [ticket('analysis', 1)], now: NOW })
  assert.doesNotMatch(result.reason, /last 24h/)
})

test('tickets older than 24 hours do not count', () => {
  const result = classifyRequest({
    text: 'Profile the layers.',
    history: [ticket('analysis', 25), ticket('analysis', 48)],
    now: NOW,
  })
  assert.equal(result.tier, 'analysis')
  assert.doesNotMatch(result.reason, /last 24h/)
})

test('history of another tier does not add a note', () => {
  const result = classifyRequest({
    text: 'Profile the layers.',
    history: [ticket('training', 1), ticket('training', 2)],
    now: NOW,
  })
  assert.equal(result.tier, 'analysis')
  assert.doesNotMatch(result.reason, /last 24h/)
})

test('history entries accept createdAt or timestamp and skip malformed entries', () => {
  const history = [
    { tier: 'analysis', createdAt: new Date(NOW - HOUR_MS).toISOString() },
    { tier: 'analysis', timestamp: NOW - 2 * HOUR_MS },
    null,
    'nonsense',
    42,
    { tier: 'analysis' },
    { tier: 'analysis', at: 'not-a-date' },
    { tier: 42, at: NOW },
  ]
  const result = classifyRequest({ text: 'Profile the layers.', history, now: NOW })
  assert.match(result.reason, /2 analysis tickets in the last 24h/)
})

test('the history window follows the current clock when now is omitted', () => {
  const history = [
    { tier: 'analysis', at: new Date(Date.now() - HOUR_MS).toISOString() },
    { tier: 'analysis', at: Date.now() - 2 * HOUR_MS },
  ]
  assert.match(classifyRequest({ text: 'Profile the layers.', history }).reason, /last 24h/)
})

test('malformed history is tolerated', () => {
  for (const history of [undefined, null, 'nope', 7, {}]) {
    const result = classifyRequest({ text: 'Profile the layers.', history, now: NOW })
    assert.equal(result.tier, 'analysis')
  }
  const badClock = classifyRequest({ text: 'Profile the layers.', history: [ticket('analysis', 1)], now: 'not-a-date' })
  assert.equal(badClock.tier, 'analysis')
})

test('parseBudget fills in the defaults', () => {
  assert.deepEqual(parseBudget(), DEFAULT_BUDGET)
  assert.deepEqual(parseBudget(null), DEFAULT_BUDGET)
  assert.deepEqual(parseBudget('nonsense'), DEFAULT_BUDGET)
  assert.deepEqual(parseBudget([]), DEFAULT_BUDGET)
})

test('parseBudget applies overrides', () => {
  const parsed = parseBudget({ autoTiers: ['explore'], attentionTiers: ['design'], maxAutoPerHour: 3 })
  assert.deepEqual(parsed, { autoTiers: ['explore'], attentionTiers: ['design'], maxAutoPerHour: 3 })
})

test('parseBudget ignores unknown fields', () => {
  const parsed = parseBudget({ autoTiers: ['explore'], color: 'blue', maxAutoPerHour: 1 })
  assert.deepEqual(parsed, { autoTiers: ['explore'], attentionTiers: ['training', 'design'], maxAutoPerHour: 1 })
})

test('parseBudget sanitises tier names and drops unknown or duplicate tiers', () => {
  const parsed = parseBudget({
    autoTiers: [' EXPLORE ', 'analysis', 'gpu', 'explore', 42, null],
    attentionTiers: ['Training', 'training', 'DESIGN'],
  })
  assert.deepEqual(parsed.autoTiers, ['explore', 'analysis'])
  assert.deepEqual(parsed.attentionTiers, ['training', 'design'])
})

test('parseBudget treats malformed tier lists as defaults', () => {
  for (const autoTiers of [undefined, null, 'explore', 42, {}]) {
    assert.deepEqual(parseBudget({ autoTiers }).autoTiers, ['explore', 'analysis'], String(autoTiers))
  }
  assert.deepEqual(parseBudget({ attentionTiers: { design: true } }).attentionTiers, ['training', 'design'])
  assert.deepEqual(parseBudget({ autoTiers: [] }).autoTiers, [], 'an explicit empty list disables automatic acceptance')
})

test('parseBudget accepts only a non-negative finite hourly cap', () => {
  assert.equal(parseBudget({ maxAutoPerHour: 5 }).maxAutoPerHour, 5)
  assert.equal(parseBudget({ maxAutoPerHour: 0 }).maxAutoPerHour, 0)
  for (const value of ['5', -1, Number.NaN, Number.POSITIVE_INFINITY, {}, null, undefined]) {
    assert.equal(parseBudget({ maxAutoPerHour: value }).maxAutoPerHour, null, String(value))
  }
})

test('parseBudget does not alias the input or the shared defaults', () => {
  const raw = { autoTiers: ['explore'], attentionTiers: ['design'] }
  parseBudget(raw).autoTiers.push('training')
  assert.deepEqual(raw.autoTiers, ['explore'])
  parseBudget().attentionTiers.push('explore')
  assert.deepEqual(parseBudget().attentionTiers, ['training', 'design'])
})

test('auto tiers are accepted without escalation', () => {
  for (const tier of ['explore', 'analysis', ' EXPLORE ']) {
    const result = decideAcceptance({ tier })
    assert.equal(result.decision, 'auto', tier)
    assert.equal(result.tier, tier.trim().toLowerCase())
    assert.equal(result.escalate, false)
    assert.match(result.reason, /auto-accepted/)
  }
})

test('attention tiers become issues for a person', () => {
  for (const tier of ['training', 'design']) {
    const result = decideAcceptance({ tier })
    assert.equal(result.decision, 'attention', tier)
    assert.equal(result.tier, tier)
    assert.equal(result.escalate, true)
    assert.match(result.reason, /requires attention/)
  }
})

test('a configured budget can move tiers between the two decisions', () => {
  const budget = parseBudget({ autoTiers: ['training'], attentionTiers: ['explore'] })
  assert.equal(decideAcceptance({ tier: 'training', budget }).decision, 'auto')
  assert.equal(decideAcceptance({ tier: 'explore', budget }).decision, 'attention')
})

test('a known tier in neither list still needs attention', () => {
  const budget = parseBudget({ autoTiers: ['explore'], attentionTiers: ['design'] })
  assert.deepEqual(decideAcceptance({ tier: 'training', budget }), {
    decision: 'attention',
    tier: 'training',
    reason: 'tier "training" is not auto-accepted',
    escalate: true,
  })
})

test('an exhausted hourly budget forces attention with a budget reason', () => {
  const budget = parseBudget({ maxAutoPerHour: 2 })
  for (const autoAcceptedLastHour of [2, 3]) {
    const result = decideAcceptance({ tier: 'analysis', usage: { autoAcceptedLastHour }, budget })
    assert.equal(result.decision, 'attention', String(autoAcceptedLastHour))
    assert.equal(result.tier, 'analysis')
    assert.equal(result.reason, 'hourly budget exhausted')
    assert.equal(result.escalate, true)
  }
})

test('the hourly cap does not trigger while budget remains', () => {
  const budget = parseBudget({ maxAutoPerHour: 2 })
  assert.equal(decideAcceptance({ tier: 'analysis', usage: { autoAcceptedLastHour: 1 }, budget }).decision, 'auto')
  assert.equal(decideAcceptance({ tier: 'explore', usage: {}, budget }).decision, 'auto')
})

test('without a configured cap the usage counters are ignored', () => {
  assert.equal(decideAcceptance({ tier: 'explore', usage: { autoAcceptedLastHour: 9999 } }).decision, 'auto')
})

test('a cap of zero accepts nothing automatically', () => {
  const budget = parseBudget({ maxAutoPerHour: 0 })
  const result = decideAcceptance({ tier: 'explore', budget })
  assert.equal(result.decision, 'attention')
  assert.equal(result.reason, 'hourly budget exhausted')
})

test('an unknown tier is escalated to attention', () => {
  for (const tier of ['gpu', 'TRAINING-PROD', 42, null, undefined, '']) {
    const result = decideAcceptance({ tier })
    assert.equal(result.decision, 'attention', String(tier))
    assert.equal(result.escalate, true)
    assert.equal(result.reason, 'unknown tier')
  }
  assert.equal(decideAcceptance().decision, 'attention')
  assert.equal(decideAcceptance(null).decision, 'attention')
  assert.equal(decideAcceptance('analysis').tier, null, 'a bare string is not a request object')
})

test('malformed usage is treated as zero accepted requests', () => {
  const budget = parseBudget({ maxAutoPerHour: 1 })
  for (const usage of [
    undefined,
    null,
    'nope',
    42,
    [],
    { autoAcceptedLastHour: 'many' },
    { autoAcceptedLastHour: -3 },
    { autoAcceptedLastHour: Number.NaN },
  ]) {
    assert.equal(decideAcceptance({ tier: 'analysis', usage, budget }).decision, 'auto', JSON.stringify(usage))
  }
})

test('malformed budgets fall back to the defaults', () => {
  for (const budget of [undefined, null, 'nope', 42, []]) {
    assert.equal(decideAcceptance({ tier: 'analysis', budget }).decision, 'auto', String(budget))
    assert.equal(decideAcceptance({ tier: 'training', budget }).decision, 'attention', String(budget))
  }
})

test('decisions are deterministic values', () => {
  const input = {
    tier: 'design',
    usage: { autoAcceptedLastHour: 1 },
    budget: parseBudget({ maxAutoPerHour: 5 }),
  }
  assert.deepEqual(decideAcceptance(input), decideAcceptance(input))
  const first = decideAcceptance(input)
  first.reason = 'mutated'
  assert.notEqual(decideAcceptance(input).reason, 'mutated')
})
