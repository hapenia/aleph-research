import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createScenario,
  defaultSpecInput,
  outcome,
  proposed,
} from './fixtures/scenario.ts'
import { runExperiment, runProgram } from './fixtures/lab.ts'

test('fixture lab drives a passing experiment to ResearchCompleted', async () => {
  const lab = createScenario({
    spec: defaultSpecInput(),
    outcomes: [outcome('passed', { accuracy: 0.9, loss: 0.1 })],
  })
  const result = await runExperiment(lab, proposed(lab))

  assert.equal(result.status, 'completed')
  if (result.status !== 'completed') {
    return
  }
  assert.equal(result.completion.outcome, 'concluded')
  assert.equal(result.review.decision, 'stop')
  assert.equal(result.record.status, 'passed')
  assert.deepEqual(result.record.metrics, { accuracy: 0.9, loss: 0.1 })
  assert.equal(result.attempts, 1)
  assert.deepEqual(lab.trace, [
    'deliverTrigger',
    'openTicket',
    'startWorker',
    'submitCommit',
    'buildEnvironment',
    'runBenchmark',
    'recordResult',
    'reviewResult',
    'closePassed',
  ])
  assert.deepEqual(lab.storage.saves, ['benchmark-record-1'])
  assert.deepEqual(lab.artifacts.stored, ['artifact.log'])
  assert.equal(lab.trigger.deliveries.length, 1)
  assert.equal(lab.executor.tickets.length, 1)
  assert.equal(lab.sessions.workers.length, 1)
  assert.equal(lab.sessions.commits.length, 1)
  assert.equal(lab.environment.builds.length, 1)
})

test('benchmark failure is terminal for the experiment', async () => {
  const lab = createScenario({
    outcomes: [outcome('failed', { accuracy: 0.2 }, 'accuracy regressed')],
  })
  const result = await runExperiment(lab, proposed(lab))

  assert.equal(result.status, 'failed')
  if (result.status !== 'failed') {
    return
  }
  assert.equal(result.completion.outcome, 'failed')
  assert.equal(result.reason, 'accuracy regressed')
  assert.equal(result.record?.status, 'failed')
  assert.equal(result.attempts, 1)
  assert.equal(lab.storage.saves.length, 0)
  assert.equal(lab.benchmark.results.length, 1)
  assert.equal(lab.trace.includes('retryBenchmark'), false)
  assert.deepEqual(lab.trace, [
    'deliverTrigger',
    'openTicket',
    'startWorker',
    'submitCommit',
    'buildEnvironment',
    'runBenchmark',
    'closeFailed',
  ])
})

test('retryable benchmark returns to EnvironmentBuilt and can pass', async () => {
  const lab = createScenario({
    policy: { maxAttemptsPerExperiment: 2 },
    outcomes: [
      outcome('retryable', {}, 'transient worker failure'),
      outcome('passed', { accuracy: 0.7, loss: 0.3 }),
    ],
  })
  const result = await runExperiment(lab, proposed(lab))

  assert.equal(result.status, 'completed')
  if (result.status !== 'completed') {
    return
  }
  assert.equal(result.completion.outcome, 'concluded')
  assert.equal(result.attempts, 2)
  assert.equal(result.record.attempt, 2)
  assert.equal(lab.benchmark.results.length, 2)
  assert.equal(lab.benchmark.attempts.length, 2)
  assert.deepEqual(lab.trace, [
    'deliverTrigger',
    'openTicket',
    'startWorker',
    'submitCommit',
    'buildEnvironment',
    'runBenchmark',
    'retryBenchmark',
    'runBenchmark',
    'recordResult',
    'reviewResult',
    'closePassed',
  ])
})

test('retryable benchmark becomes terminal when attempts are exhausted', async () => {
  const lab = createScenario({
    policy: { maxAttemptsPerExperiment: 2 },
    outcomes: [
      outcome('retryable', {}, 'transient worker failure'),
      outcome('retryable', {}, 'transient worker failure'),
      outcome('passed', { accuracy: 1, loss: 0 }),
    ],
  })
  const result = await runExperiment(lab, proposed(lab))

  assert.equal(result.status, 'failed')
  if (result.status !== 'failed') {
    return
  }
  assert.equal(result.completion.outcome, 'failed')
  assert.equal(result.reason, 'attempt-limit')
  assert.equal(result.attempts, 2)
  assert.equal(lab.benchmark.results.length, 2)
  assert.equal(lab.benchmark.attempts.length, 2)
  assert.equal(lab.records.length, 2)
  assert.equal(lab.trace.filter((step) => step === 'retryBenchmark').length, 1)
  assert.equal(lab.trace.at(-1), 'closeFailed')
})

test('program loop proposes a second experiment after a propose decision', async () => {
  const lab = createScenario({
    decisions: ['propose', 'stop'],
    outcomes: [
      outcome('passed', { accuracy: 0.8, loss: 0.2 }),
      outcome('passed', { accuracy: 0.9, loss: 0.1 }),
    ],
    policy: { maxExperiments: 3 },
  })
  const result = await runProgram(lab)

  assert.equal(result.stop, 'review-stop')
  assert.equal(result.completion.outcome, 'concluded')
  assert.equal(result.experiments.length, 2)
  const first = result.experiments[0]
  const second = result.experiments[1]
  assert.equal(first?.status, 'completed')
  assert.equal(second?.status, 'completed')
  if (first?.status !== 'completed' || second?.status !== 'completed') {
    return
  }
  assert.equal(first.review.decision, 'propose')
  assert.equal(second.review.decision, 'stop')
  assert.equal(lab.trigger.deliveries.length, 2)
  assert.equal(lab.records.length, 2)
  assert.notEqual(lab.records[0]?.experimentId, lab.records[1]?.experimentId)
})

test('benchmark failure stops the program with a failed completion', async () => {
  const lab = createScenario({
    decisions: ['propose'],
    outcomes: [outcome('failed', { accuracy: 0.1 }, 'accuracy regressed')],
  })
  const result = await runProgram(lab)

  assert.equal(result.stop, 'failure')
  assert.equal(result.completion.outcome, 'failed')
  assert.equal(result.experiments.length, 1)
  assert.equal(lab.trigger.deliveries.length, 1)
})
