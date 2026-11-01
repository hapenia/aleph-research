/**
 * The sampler's runtime evidence: fixed presets, min-max utility normalization,
 * deterministic base choice and the validation refusals.
 *
 * The fixtures below are built from plain values and cast to the nominal ids; test
 * files are outside the linted `src` boundary (and outside the typecheck project), and
 * the parser boundary that would mint those ids is a parallel task.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { DomainError, Result } from '../src/types/errors.js'
import type { CIRunId, CommitSha, ExperimentId, MetricName, PositiveNumber } from '../src/types/ids.js'
import type { MetricDefinition, MetricDirection, MetricMap } from '../src/types/metrics.js'
import type { ExplorationLevel } from '../src/types/program.js'
import type { BaseChoice, SampleCandidate, SampleInput } from '../src/types/sampling.js'
import { EXPLORATION_PRESETS, computeUtilities, createSampler } from '../src/runtime/sampler.js'

/** A metric definition fixture. */
function definition(name: string, direction: MetricDirection, weight: number): MetricDefinition {
  return { name: name as MetricName, direction, weight: weight as PositiveNumber }
}

/** A sample candidate fixture. */
function candidate(
  experiment: string,
  ciRun: string,
  commit: string,
  metrics: Record<string, number>,
): SampleCandidate {
  return {
    experimentId: experiment as ExperimentId,
    ciRunId: ciRun as CIRunId,
    commit: commit as CommitSha,
    metrics: metrics as MetricMap,
  }
}

/** An RNG that returns the scripted values in order and fails when called too often. */
function scriptedRandom(...values: readonly number[]): () => number {
  let index = 0
  return () => {
    const value = values[index]
    index += 1
    if (value === undefined) throw new Error(`random was called more than ${values.length} time(s)`)
    return value
  }
}

/** An RNG that must not be called; validation failures return before sampling. */
function unusedRandom(): () => number {
  return () => {
    throw new Error('the random function must not run when the input is invalid')
  }
}

/** A sample input fixture. */
function input(options: {
  level?: ExplorationLevel
  definitions?: readonly MetricDefinition[]
  random?: () => number
  population?: readonly SampleCandidate[]
}): SampleInput {
  return {
    level: options.level ?? 'normal',
    definitions: options.definitions ?? [definition('accuracy', 'higher', 1)],
    random: options.random ?? scriptedRandom(0.5, 0.5),
    population: options.population ?? [],
  }
}

function expectChoice(result: Result<BaseChoice, DomainError>): BaseChoice {
  assert.equal(result.ok, true)
  if (!result.ok) throw new Error(`expected a choice, got ${result.error.code}: ${result.error.message}`)
  return result.value
}

function expectRefusal(result: Result<BaseChoice, DomainError>): DomainError {
  assert.equal(result.ok, false)
  if (result.ok) throw new Error('expected a refusal, got a choice')
  return result.error
}

test('the exploration presets are the mechanism fixed table', () => {
  assert.deepEqual(EXPLORATION_PRESETS, {
    low: { temperature: 0.2, freshStartProbability: 0.02 },
    normal: { temperature: 1.0, freshStartProbability: 0.1 },
    high: { temperature: 3.0, freshStartProbability: 0.25 },
  })

  const sampler = createSampler()
  assert.deepEqual(sampler.presets('low'), { temperature: 0.2, freshStartProbability: 0.02 })
  assert.deepEqual(sampler.presets('normal'), { temperature: 1.0, freshStartProbability: 0.1 })
  assert.deepEqual(sampler.presets('high'), { temperature: 3.0, freshStartProbability: 0.25 })
})

test('higher-is-better utilities min-max normalize over the population', () => {
  const population = [
    candidate('exp-a', 'run-a', 'sha-a', { accuracy: 0 }),
    candidate('exp-b', 'run-b', 'sha-b', { accuracy: 10 }),
    candidate('exp-c', 'run-c', 'sha-c', { accuracy: 5 }),
  ]

  assert.deepEqual(computeUtilities(population, [definition('accuracy', 'higher', 1)]), [0, 1, 0.5])
})

test('lower-is-better metrics are inverted, weights are applied per metric', () => {
  const population = [
    candidate('exp-a', 'run-a', 'sha-a', { loss: 1, accuracy: 0 }),
    candidate('exp-b', 'run-b', 'sha-b', { loss: 3, accuracy: 10 }),
  ]
  const definitions: readonly MetricDefinition[] = [
    definition('loss', 'lower', 2),
    definition('accuracy', 'higher', 1),
  ]

  // exp-a: 2 * 1 (loss inverted) + 1 * 0 (accuracy) = 2.
  // exp-b: 2 * 0 + 1 * 1 = 1.
  assert.deepEqual(computeUtilities(population, definitions), [2, 1])
})

test('a metric with a zero range contributes nothing', () => {
  const population = [
    candidate('exp-a', 'run-a', 'sha-a', { accuracy: 7, loss: 1 }),
    candidate('exp-b', 'run-b', 'sha-b', { accuracy: 7, loss: 3 }),
  ]
  const definitions: readonly MetricDefinition[] = [
    definition('accuracy', 'higher', 1),
    definition('loss', 'lower', 2),
  ]

  // The constant accuracy has no range; only the inverted loss is scored.
  assert.deepEqual(computeUtilities(population, definitions), [2, 0])
})

test('an empty population is a fresh start and never touches the RNG', () => {
  const sampler = createSampler()
  const choice = expectChoice(sampler.sample(input({
    level: 'high',
    definitions: [],
    random: unusedRandom(),
    population: [],
  })))

  assert.deepEqual(choice, { kind: 'fresh' })
})

test('the fresh-start draw below the preset probability starts fresh', () => {
  const sampler = createSampler()
  const population = [
    candidate('exp-a', 'run-a', 'sha-a', { accuracy: 0 }),
    candidate('exp-b', 'run-b', 'sha-b', { accuracy: 10 }),
  ]

  const low = expectChoice(sampler.sample(input({
    level: 'low',
    random: scriptedRandom(0.019),
    population,
  })))
  assert.deepEqual(low, { kind: 'fresh' })

  const high = expectChoice(sampler.sample(input({
    level: 'high',
    random: scriptedRandom(0.249),
    population,
  })))
  assert.deepEqual(high, { kind: 'fresh' })
})

test('a draw exactly at the fresh probability derives a base from the population', () => {
  const sampler = createSampler()
  const population = [
    candidate('exp-a', 'run-a', 'sha-a', { accuracy: 0 }),
    candidate('exp-b', 'run-b', 'sha-b', { accuracy: 10 }),
  ]

  // normal: freshStartProbability 0.1, so 0.1 is not fresh. Utility 0/1, T = 1:
  // weights [e^-1, 1], total 1.3679; draw 0.5 lands in exp-b's interval.
  const choice = expectChoice(sampler.sample(input({
    level: 'normal',
    random: scriptedRandom(0.1, 0.5),
    population,
  })))
  assert.deepEqual(choice, { kind: 'derived', experimentId: 'exp-b', commit: 'sha-b' })
})

test('a derived base carries the chosen experiment and commit', () => {
  const sampler = createSampler()
  const population = [
    candidate('exp-a', 'run-a', 'sha-a', { accuracy: 0 }),
    candidate('exp-b', 'run-b', 'sha-b', { accuracy: 10 }),
  ]

  // Draw 0 targets the first non-empty weight interval: the lower-utility exp-a.
  const choice = expectChoice(sampler.sample(input({
    level: 'normal',
    random: scriptedRandom(0.5, 0),
    population,
  })))
  assert.deepEqual(choice, { kind: 'derived', experimentId: 'exp-a', commit: 'sha-a' })
})

test('a low temperature concentrates on the high-utility candidate', () => {
  const sampler = createSampler()
  const population = [
    candidate('exp-a', 'run-a', 'sha-a', { accuracy: 0 }),
    candidate('exp-b', 'run-b', 'sha-b', { accuracy: 10 }),
  ]

  // low: T = 0.2, weights [e^-5, 1]; the same 0.3 selection draw lands on exp-b.
  const choice = expectChoice(sampler.sample(input({
    level: 'low',
    random: scriptedRandom(0.5, 0.3),
    population,
  })))
  assert.deepEqual(choice, { kind: 'derived', experimentId: 'exp-b', commit: 'sha-b' })
})

test('a high temperature keeps the low-utility candidate reachable', () => {
  const sampler = createSampler()
  const population = [
    candidate('exp-a', 'run-a', 'sha-a', { accuracy: 0 }),
    candidate('exp-b', 'run-b', 'sha-b', { accuracy: 10 }),
  ]

  // high: T = 3, weights [e^-1/3, 1]; the same 0.3 selection draw lands on exp-a.
  const choice = expectChoice(sampler.sample(input({
    level: 'high',
    random: scriptedRandom(0.5, 0.3),
    population,
  })))
  assert.deepEqual(choice, { kind: 'derived', experimentId: 'exp-a', commit: 'sha-a' })
})

test('duplicate CI runs and duplicate experiments are rejected', () => {
  const sampler = createSampler()

  const duplicateRun = expectRefusal(sampler.sample(input({
    random: unusedRandom(),
    population: [
      candidate('exp-a', 'run-1', 'sha-a', { accuracy: 0 }),
      candidate('exp-b', 'run-1', 'sha-b', { accuracy: 1 }),
    ],
  })))
  assert.equal(duplicateRun.code, 'invalid-input')
  assert.match(duplicateRun.message, /duplicate CI run/)

  const duplicateExperiment = expectRefusal(sampler.sample(input({
    random: unusedRandom(),
    population: [
      candidate('exp-a', 'run-1', 'sha-a', { accuracy: 0 }),
      candidate('exp-a', 'run-2', 'sha-b', { accuracy: 1 }),
    ],
  })))
  assert.equal(duplicateExperiment.code, 'invalid-input')
  assert.match(duplicateExperiment.message, /duplicate experiment/)
})

test('a missing required metric is rejected', () => {
  const sampler = createSampler()
  const definitions: readonly MetricDefinition[] = [
    definition('accuracy', 'higher', 1),
    definition('loss', 'lower', 1),
  ]

  const refusal = expectRefusal(sampler.sample(input({
    definitions,
    random: unusedRandom(),
    population: [candidate('exp-a', 'run-a', 'sha-a', { accuracy: 1 })],
  })))
  assert.equal(refusal.code, 'invalid-input')
  assert.match(refusal.message, /missing required metric loss/)
})

test('non-finite metric values are rejected', () => {
  const sampler = createSampler()

  const nanValue = expectRefusal(sampler.sample(input({
    random: unusedRandom(),
    population: [candidate('exp-a', 'run-a', 'sha-a', { accuracy: Number.NaN })],
  })))
  assert.equal(nanValue.code, 'invalid-input')
  assert.match(nanValue.message, /non-finite accuracy/)

  const infiniteValue = expectRefusal(sampler.sample(input({
    random: unusedRandom(),
    population: [candidate('exp-a', 'run-a', 'sha-a', { accuracy: Number.POSITIVE_INFINITY })],
  })))
  assert.equal(infiniteValue.code, 'invalid-input')
  assert.match(infiniteValue.message, /non-finite accuracy/)
})

test('invalid definitions, levels and random sources are rejected', () => {
  const sampler = createSampler()
  const population = [candidate('exp-a', 'run-a', 'sha-a', { accuracy: 1 })]

  const emptyDefinitions = expectRefusal(sampler.sample(input({
    definitions: [],
    random: unusedRandom(),
    population,
  })))
  assert.match(emptyDefinitions.message, /at least one metric definition/)

  const zeroWeight = expectRefusal(sampler.sample(input({
    definitions: [definition('accuracy', 'higher', 0)],
    random: unusedRandom(),
    population,
  })))
  assert.match(zeroWeight.message, /finite positive weight/)

  const badDirection = expectRefusal(sampler.sample(input({
    definitions: [definition('accuracy', 'sideways' as MetricDirection, 1)],
    random: unusedRandom(),
    population,
  })))
  assert.match(badDirection.message, /higher or lower/)

  const unknownLevel = expectRefusal(sampler.sample(input({
    level: 'extreme' as ExplorationLevel,
    random: unusedRandom(),
    population,
  })))
  assert.match(unknownLevel.message, /unknown exploration level/)

  const nanDraw = expectRefusal(sampler.sample(input({
    random: scriptedRandom(Number.NaN),
    population,
  })))
  assert.match(nanDraw.message, /number in \[0, 1\]/)

  const outOfRangeDraw = expectRefusal(sampler.sample(input({
    random: scriptedRandom(1.5),
    population,
  })))
  assert.match(outOfRangeDraw.message, /number in \[0, 1\]/)
})
