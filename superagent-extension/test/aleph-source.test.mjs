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

test('the source carries the research project settings into the execution environment', () => {
  const parsed = alephKind.schema.parse({
    project: 'fixture',
    repository: '/tmp/research',
    templateBranch: 'main',
    dataDir: '/tmp/data',
    python: '/usr/bin/python3',
    conventions: 'Analyse data/.',
  })
  assert.equal(parsed.repository, '/tmp/research')
  const values = alephKind.environment.values({ deployment: {}, config: parsed })
  assert.equal(values.ALEPH_RESEARCH_REPO, '/tmp/research')
  assert.equal(values.ALEPH_TEMPLATE_BRANCH, 'main')
  assert.equal(values.ALEPH_DATA_DIR, '/tmp/data')
  assert.equal(values.ALEPH_PYTHON, '/usr/bin/python3')
  assert.match(values.ALEPH_CONVENTIONS, /Analyse data/)

  const defaults = alephKind.schema.parse({})
  assert.equal(defaults.templateBranch, 'main')
  assert.equal(defaults.repository, '')
  const fallback = alephKind.environment.values({ deployment: {}, config: defaults })
  assert.equal(fallback.ALEPH_TEMPLATE_BRANCH, 'main')
})
