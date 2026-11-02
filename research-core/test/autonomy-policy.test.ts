import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createScenario,
  defaultSpecInput,
  outcome,
  proposed,
} from './fixtures/scenario.ts'
import { runExperiment, runProgram } from './fixtures/lab.ts'

const passed = () => outcome('passed', { accuracy: 0.8, loss: 0.2 })
const retryable = () => outcome('retryable', {}, 'transient worker failure')

test('maxExperiments stops the program before another trigger', async () => {
  const lab = createScenario({
    decisions: ['propose', 'propose', 'propose'],
    outcomes: [passed(), passed(), passed()],
    policy: {
      maxExperiments: 2,
      maxComputeMinutes: 100,
      maxTokens: 1000,
      maxAttemptsPerExperiment: 1,
    },
  })
  const result = await runProgram(lab)

  assert.equal(result.stop, 'experiment-limit')
  assert.equal(result.completion.outcome, 'cancelled')
  assert.equal(result.experiments.length, 2)
  assert.equal(result.usage.experiments, 2)
  assert.equal(lab.trigger.deliveries.length, 2)
  assert.equal(lab.benchmark.results.length, 2)
})

test('maxComputeMinutes stops before the next experiment', async () => {
  const lab = createScenario({
    decisions: ['propose', 'propose'],
    outcomes: [passed(), passed()],
    usagePerAttempt: { computeMinutes: 3, tokens: 10 },
    policy: {
      maxExperiments: 5,
      maxComputeMinutes: 5,
      maxTokens: 1000,
      maxAttemptsPerExperiment: 2,
    },
  })
  const result = await runProgram(lab)

  assert.equal(result.stop, 'compute-limit')
  assert.equal(result.completion.outcome, 'cancelled')
  assert.equal(result.experiments.length, 1)
  assert.equal(result.usage.computeMinutes, 3)
  assert.equal(lab.trigger.deliveries.length, 1)
  assert.equal(lab.benchmark.results.length, 1)
})

test('maxTokens stops before the next experiment', async () => {
  const lab = createScenario({
    decisions: ['propose', 'propose'],
    outcomes: [passed(), passed()],
    usagePerAttempt: { computeMinutes: 1, tokens: 60 },
    policy: {
      maxExperiments: 5,
      maxComputeMinutes: 100,
      maxTokens: 100,
      maxAttemptsPerExperiment: 2,
    },
  })
  const result = await runProgram(lab)

  assert.equal(result.stop, 'token-limit')
  assert.equal(result.completion.outcome, 'cancelled')
  assert.equal(result.experiments.length, 1)
  assert.equal(result.usage.tokens, 60)
  assert.equal(lab.trigger.deliveries.length, 1)
  assert.equal(lab.benchmark.results.length, 1)
})

test('policy maxAttempts bounds retries before the spec maxRetries value', async () => {
  const lab = createScenario({
    spec: { ...defaultSpecInput(), maxRetries: 10 },
    outcomes: [retryable(), retryable(), passed()],
    policy: {
      maxExperiments: 1,
      maxComputeMinutes: 100,
      maxTokens: 1000,
      maxAttemptsPerExperiment: 2,
    },
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
  assert.equal(lab.trigger.deliveries.length, 1)
})

test('retryable benchmark within the attempt policy reaches ResearchCompleted', async () => {
  const lab = createScenario({
    outcomes: [retryable(), passed()],
    policy: {
      maxExperiments: 1,
      maxComputeMinutes: 100,
      maxTokens: 1000,
      maxAttemptsPerExperiment: 2,
    },
  })
  const result = await runExperiment(lab, proposed(lab))

  assert.equal(result.status, 'completed')
  if (result.status !== 'completed') {
    return
  }
  assert.equal(result.completion.outcome, 'concluded')
  assert.equal(result.attempts, 2)
  assert.equal(result.review.decision, 'stop')
})

test('compute exhaustion during a retry cancels the experiment', async () => {
  const lab = createScenario({
    outcomes: [retryable(), passed()],
    usagePerAttempt: { computeMinutes: 3, tokens: 10 },
    policy: {
      maxExperiments: 2,
      maxComputeMinutes: 5,
      maxTokens: 1000,
      maxAttemptsPerExperiment: 3,
    },
  })
  const result = await runExperiment(lab, proposed(lab))

  assert.equal(result.status, 'cancelled')
  if (result.status !== 'cancelled') {
    return
  }
  assert.equal(result.completion.outcome, 'cancelled')
  assert.equal(result.reason, 'budget-exhausted')
  assert.equal(result.attempts, 2)
  assert.equal(lab.benchmark.results.length, 1)
  assert.equal(lab.benchmark.attempts.length, 2)
  assert.equal(lab.usage.computeMinutes, 3)
  assert.equal(lab.trace.filter((step) => step === 'runBenchmark').length, 2)
  assert.equal(lab.trace.filter((step) => step === 'retryBenchmark').length, 1)
  assert.equal(lab.trace.includes('closeFailed'), false)
})

test('stop decision ends the program after the first passed experiment', async () => {
  const lab = createScenario({
    decisions: ['stop'],
    outcomes: [passed()],
  })
  const result = await runProgram(lab)

  assert.equal(result.stop, 'review-stop')
  assert.equal(result.completion.outcome, 'concluded')
  assert.equal(result.experiments.length, 1)
  assert.equal(lab.trigger.deliveries.length, 1)
})

test('revise decision starts another experiment', async () => {
  const lab = createScenario({
    decisions: ['revise', 'stop'],
    outcomes: [passed(), passed()],
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
  assert.equal(first.review.decision, 'revise')
  assert.equal(second.review.decision, 'stop')
  assert.notEqual(first.record.experimentId, second.record.experimentId)
  assert.equal(lab.trigger.deliveries.length, 2)
  assert.equal(lab.records.length, 2)
})

test('maxExperiments zero starts no experiment', async () => {
  const lab = createScenario({
    decisions: ['propose'],
    outcomes: [passed()],
    policy: { maxExperiments: 0 },
  })
  const result = await runProgram(lab)

  assert.equal(result.stop, 'experiment-limit')
  assert.equal(result.completion.outcome, 'cancelled')
  assert.equal(result.experiments.length, 0)
  assert.equal(lab.trigger.deliveries.length, 0)
  assert.equal(lab.benchmark.attempts.length, 0)
})

test('benchmark failure stops the program without a retry', async () => {
  const lab = createScenario({
    decisions: ['propose'],
    outcomes: [outcome('failed', { accuracy: 0.1 }, 'accuracy regressed')],
  })
  const result = await runProgram(lab)

  assert.equal(result.stop, 'failure')
  assert.equal(result.completion.outcome, 'failed')
  assert.equal(result.experiments.length, 1)
  assert.equal(lab.trace.includes('retryBenchmark'), false)
  assert.equal(lab.trace.includes('recordResult'), false)
})
