import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createBenchmarkSpec,
  createReadOnlyBenchmarkFiles,
  hashBenchmarkSpec,
  validateMetrics,
} from './fixtures/benchmark.ts'
import {
  createScenario,
  defaultFiles,
  defaultSpecInput,
  outcome,
  proposed,
} from './fixtures/scenario.ts'
import { runExperiment } from './fixtures/lab.ts'

function unwrap(result) {
  if (!result.ok) {
    assert.fail(`expected Ok, got ${result.error.code}: ${result.error.message}`)
  }
  return result.value
}

test('benchmark spec is deeply immutable', () => {
  const spec = unwrap(
    createBenchmarkSpec({ ...defaultSpecInput(), baseline: { accuracy: 0.5 } }),
  )
  const metric = spec.metrics[0]
  assert.ok(metric)
  assert.equal(Object.isFrozen(spec), true)
  assert.equal(Object.isFrozen(spec.metrics), true)
  assert.equal(Object.isFrozen(metric), true)
  assert.ok(spec.baseline)
  assert.equal(Object.isFrozen(spec.baseline), true)
  assert.throws(() => {
    spec.timeoutMs = 1
  }, TypeError)
  assert.throws(() => {
    metric.required = false
  }, TypeError)
  assert.throws(() => {
    spec.baseline.accuracy = 0.9
  }, TypeError)
  assert.throws(() => {
    spec.metrics.push(metric)
  }, TypeError)
})

test('spec hash is stable across key order and sensitive to content', () => {
  const base = { ...defaultSpecInput(), baseline: { accuracy: 0.5, loss: 0.2 } }
  const first = unwrap(createBenchmarkSpec(base))
  const reordered = unwrap(
    createBenchmarkSpec({ ...base, baseline: { loss: 0.2, accuracy: 0.5 } }),
  )
  const changedTimeout = unwrap(createBenchmarkSpec({ ...base, timeoutMs: 61000 }))
  const changedRequired = unwrap(
    createBenchmarkSpec({
      ...base,
      metrics: [
        { name: 'accuracy', direction: 'higher', required: false },
        { name: 'loss', direction: 'lower', required: false },
      ],
    }),
  )
  assert.equal(hashBenchmarkSpec(first), hashBenchmarkSpec(reordered))
  assert.notEqual(hashBenchmarkSpec(first), hashBenchmarkSpec(changedTimeout))
  assert.notEqual(hashBenchmarkSpec(first), hashBenchmarkSpec(changedRequired))
})

test('spec hash mismatch rejects the benchmark run before a record', async () => {
  const lab = createScenario({
    contract: {
      specHash: 'fnv1a64:0000000000000000',
      environmentDigest: 'sha256:environment-1',
    },
    outcomes: [outcome('passed', { accuracy: 1, loss: 0 })],
  })
  const result = await runExperiment(lab, proposed(lab))

  assert.equal(result.status, 'refused')
  if (result.status !== 'refused') {
    return
  }
  assert.equal(result.stage, 'runBenchmark')
  assert.equal(result.error.code, 'invalid-input')
  assert.match(result.error.message, /spec hash mismatch/)
  assert.equal(lab.storage.saves.length, 0)
  assert.equal(lab.records.length, 0)
  assert.equal(lab.benchmark.results.length, 0)
  assert.equal(lab.benchmark.attempts.length, 1)
})

test('environment digest mismatch rejects the benchmark run before a record', async () => {
  const lab = createScenario({
    environmentDigest: 'sha256:different-environment',
    outcomes: [outcome('passed', { accuracy: 1, loss: 0 })],
  })
  const result = await runExperiment(lab, proposed(lab))

  assert.equal(result.status, 'refused')
  if (result.status !== 'refused') {
    return
  }
  assert.equal(result.stage, 'runBenchmark')
  assert.equal(result.error.code, 'environment-invalid')
  assert.match(result.error.message, /environment digest mismatch/)
  assert.equal(lab.storage.saves.length, 0)
  assert.equal(lab.records.length, 0)
  assert.equal(lab.benchmark.results.length, 0)
})

test('required metrics are validated before a run can pass', async () => {
  const specInput = defaultSpecInput()
  const spec = unwrap(createBenchmarkSpec(specInput))
  const missing = validateMetrics(spec, { loss: 0.1 })
  assert.equal(missing.ok, false)
  if (!missing.ok) {
    assert.equal(missing.error.code, 'invalid-input')
    assert.match(missing.error.message, /missing required metric: accuracy/)
  }
  const present = validateMetrics(spec, { accuracy: 0.9 })
  assert.equal(present.ok, true)

  const lab = createScenario({
    spec: specInput,
    outcomes: [outcome('passed', { loss: 0.1 })],
  })
  const result = await runExperiment(lab, proposed(lab))
  assert.equal(result.status, 'failed')
  if (result.status !== 'failed') {
    return
  }
  assert.equal(result.completion.outcome, 'failed')
  assert.equal(result.record?.status, 'failed')
  assert.equal(result.record?.passed, false)
  assert.equal(result.record?.reason, 'missing required metric: accuracy')
  assert.deepEqual(result.record?.metrics, { loss: 0.1 })
})

test('non-finite metrics are rejected before a run can pass', async () => {
  const lab = createScenario({
    outcomes: [outcome('passed', { accuracy: Number.NaN, loss: 0.1 })],
  })
  const result = await runExperiment(lab, proposed(lab))

  assert.equal(result.status, 'failed')
  if (result.status !== 'failed') {
    return
  }
  assert.equal(result.record?.status, 'failed')
  assert.equal(result.record?.reason, 'non-finite metric: accuracy')
  assert.equal(Number.isNaN(result.record?.metrics.accuracy), true)
})

test('missing optional metrics are allowed and extra raw metrics are preserved', async () => {
  const lab = createScenario({
    outcomes: [outcome('passed', { accuracy: 0.8, latency: 12 })],
  })
  const result = await runExperiment(lab, proposed(lab))

  assert.equal(result.status, 'completed')
  if (result.status !== 'completed') {
    return
  }
  assert.equal(result.record.status, 'passed')
  assert.deepEqual(result.record.metrics, { accuracy: 0.8, latency: 12 })
})

test('benchmark record keeps raw metrics without an aggregate score', async () => {
  const lab = createScenario({
    outcomes: [outcome('passed', { accuracy: 0.8, loss: 0.2 })],
  })
  const result = await runExperiment(lab, proposed(lab))

  assert.equal(result.status, 'completed')
  if (result.status !== 'completed') {
    return
  }
  assert.deepEqual(result.record.metrics, { accuracy: 0.8, loss: 0.2 })
  assert.equal('score' in result.record, false)
  assert.equal('aggregate' in result.record, false)
  assert.equal('utility' in result.record, false)
  assert.equal(Object.isFrozen(result.record.metrics), true)
  assert.equal(result.record.status, 'passed')
  assert.equal(result.record.attempt, 1)
  assert.equal(result.record.maxAttempts, 3)
  assert.equal(result.record.specHash, lab.contract.specHash)
  assert.equal(result.record.environmentDigest, lab.contract.environmentDigest)
})

test('benchmark files are read-only', () => {
  const files = defaultFiles()
  assert.equal(Object.isFrozen(files), true)
  assert.deepEqual(files.list(), ['entry.py', 'spec.json'])
  const original = files.read('entry.py')
  assert.equal(original.ok, true)
  if (!original.ok) {
    return
  }
  assert.equal(original.value, 'print("benchmark")')

  const deniedEntry = files.write('entry.py', 'tampered')
  assert.equal(deniedEntry.ok, false)
  if (!deniedEntry.ok) {
    assert.equal(deniedEntry.error.code, 'forbidden')
  }
  const deniedSpec = files.write('spec.json', '{"id":"tampered"}')
  assert.equal(deniedSpec.ok, false)
  if (!deniedSpec.ok) {
    assert.equal(deniedSpec.error.code, 'forbidden')
  }
  const after = files.read('entry.py')
  assert.equal(after.ok, true)
  if (after.ok) {
    assert.equal(after.value, 'print("benchmark")')
  }
})

test('benchmark run refuses a missing declared entry file', async () => {
  const lab = createScenario({
    files: createReadOnlyBenchmarkFiles('/benchmark', {}),
    outcomes: [outcome('passed', { accuracy: 1, loss: 0 })],
  })
  const result = await runExperiment(lab, proposed(lab))

  assert.equal(result.status, 'refused')
  if (result.status !== 'refused') {
    return
  }
  assert.equal(result.stage, 'runBenchmark')
  assert.equal(result.error.code, 'not-found')
  assert.match(result.error.message, /benchmark file not found: entry.py/)
  assert.equal(lab.storage.saves.length, 0)
})

test('invalid benchmark specs are rejected', () => {
  const cases = [
    { ...defaultSpecInput(), entry: '' },
    { ...defaultSpecInput(), timeoutMs: -1 },
    { ...defaultSpecInput(), maxRetries: -1 },
    {
      ...defaultSpecInput(),
      metrics: [
        { name: 'accuracy', direction: 'higher', required: true },
        { name: 'accuracy', direction: 'lower', required: false },
      ],
    },
    { ...defaultSpecInput(), metrics: [] },
    { ...defaultSpecInput(), baseline: { unknown: 1 } },
    {
      ...defaultSpecInput(),
      metrics: [{ name: 'accuracy', direction: 'higher', required: true, tolerance: -1 }],
    },
  ]
  for (const input of cases) {
    const result = createBenchmarkSpec(input)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.error.code, 'invalid-input')
    }
  }
})
