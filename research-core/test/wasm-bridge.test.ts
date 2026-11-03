import assert from 'node:assert/strict'
import test from 'node:test'
import {
  bundledResearchCoreModule,
  loadBundledResearchCore,
} from '../src/adapter/wasm.js'
import type {
  CoreBenchmarkRecord,
  CoreBenchmarkStatus,
  CoreConcepts,
  CoreProgram,
  CoreStartInput,
} from '../src/adapter/wasm.js'
import { branchName as parseBranchName } from '../src/parsers.js'
import {
  at,
  commitSha,
  experimentId,
  implementerSessionId,
  issueId,
  ok,
  programId,
  ticketId,
} from './adapter-fixture.js'

function branch(value: string) {
  const parsed = parseBranchName(value)
  if (!parsed.ok) throw new Error(`the fixture built an invalid branch: ${value}`)
  return parsed.value
}

const HEAD = 'b'.repeat(40)
const SPEC_HASH = 'a'.repeat(64)
const ENVIRONMENT_DIGEST = 'c'.repeat(64)
const NOW = at('2026-01-01T00:00:00.000Z')

const PROGRAM: CoreProgram = {
  id: programId('program-1'),
  owner: 'operator-1',
  name: 'Program',
  goal: 'Improve the benchmark',
  methodology: 'Propose, run, review',
  benchmark: {
    id: 'benchmark-1',
    entry: 'bench.py',
    timeoutMs: '30000',
    metrics: [{ name: 'score', direction: 'maximize', required: true }],
    maxRetries: 1,
    baseline: {},
  },
  utility: [{ name: 'score', direction: 'maximize', weight: 1 }],
  exploration: 'normal',
  policy: {
    maxExperiments: 4,
    maxComputeMinutes: '60',
    maxTokens: '10000',
    maxAttemptsPerExperiment: 2,
  },
  usage: { experiments: 0, computeMinutes: '0', tokens: '0' },
  status: 'running',
  createdAt: NOW,
}

const START: CoreStartInput = {
  programId: programId('program-1'),
  issueId: issueId('issue-1'),
  experimentId: experimentId('experiment-1'),
  branch: branch('experiment/one'),
  baseCommit: commitSha(HEAD),
  environment: { kind: 'requirements', file: 'requirements.txt' },
}

interface ConceptRecorder {
  readonly concepts: CoreConcepts
  readonly calls: string[]
  readonly records: CoreBenchmarkRecord[]
}

function createConcepts(
  statuses: readonly CoreBenchmarkStatus[] = ['passed'],
  tamperCommit = false,
): ConceptRecorder {
  const calls: string[] = []
  const records: CoreBenchmarkRecord[] = []
  let runs = 0
  const concepts: CoreConcepts = {
    storage: {
      loadProgram: async (id) => {
        calls.push(`storage.loadProgram:${id}`)
        return ok(PROGRAM)
      },
      appendBenchmarkRecord: async (record) => {
        calls.push('storage.appendBenchmarkRecord')
        records.push(record)
        return ok(undefined)
      },
    },
    trigger: {
      deliver: async (request) => {
        calls.push(`trigger.deliver:${request.branch}`)
        return ok('trigger-1')
      },
    },
    executor: {
      open: async (request) => {
        calls.push(`executor.open:${request.experimentId}`)
        return ok(ticketId('ticket-1'))
      },
    },
    sessions: {
      startWorker: async (request) => {
        calls.push(`sessions.startWorker:${request.ticketId}`)
        return ok(implementerSessionId('session-1'))
      },
      submitCommit: async () => {
        calls.push('sessions.submitCommit')
        return ok(commitSha(HEAD))
      },
      review: async (request) => {
        calls.push(`sessions.review:${request.benchmark.status}`)
        return ok({ kind: 'propose' })
      },
    },
    benchmark: {
      specHash: async (spec) => {
        calls.push(`benchmark.specHash:${spec.id}`)
        return ok(SPEC_HASH)
      },
      buildEnvironment: async (request) => {
        calls.push(`benchmark.buildEnvironment:${request.commit}`)
        return ok(ENVIRONMENT_DIGEST)
      },
      run: async (request) => {
        calls.push(`benchmark.run:${request.attempt}`)
        const status = statuses[runs] ?? 'passed'
        runs += 1
        const record: CoreBenchmarkRecord = {
          id: 'benchmark-1',
          experimentId: request.experimentId,
          ticketId: request.ticketId,
          commit: tamperCommit ? commitSha('d'.repeat(40)) : request.commit,
          specHash: SPEC_HASH,
          environmentDigest: request.environmentDigest,
          metrics: request.spec.metrics.map((metric) => ({
            name: metric.name,
            value: 1,
          })),
          status,
          attempt: request.attempt,
          maxAttempts: request.maxAttempts,
          stdout: '',
          stderr: '',
          artifacts: [],
          createdAt: NOW,
        }
        return ok(record)
      },
    },
    clock: {
      now: () => {
        calls.push('clock.now')
        return NOW
      },
    },
  }
  return { concepts, calls, records }
}

const EXPECTED_CALLS = [
  'storage.loadProgram:program-1',
  'trigger.deliver:experiment/one',
  'executor.open:experiment-1',
  'sessions.startWorker:ticket-1',
  'sessions.submitCommit',
  'benchmark.buildEnvironment:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'benchmark.specHash:benchmark-1',
  'benchmark.run:1',
  'storage.appendBenchmarkRecord',
  'sessions.review:passed',
  'clock.now',
]

const EXPECTED_STAGES = [
  'ExperimentProposed',
  'TriggerAccepted',
  'TicketOpened',
  'WorkerStarted',
  'CommitSubmitted',
  'EnvironmentBuilt',
  'BenchmarkPassed',
  'ResultRecorded',
  'ReviewRecorded',
  'ResearchCompleted',
]

test('the bundled artifact is a real wasm module with the Core exports', () => {
  const module = bundledResearchCoreModule()
  assert.deepEqual([...module.subarray(0, 4)], [0x00, 0x61, 0x73, 0x6d])
  const compiled = new WebAssembly.Module(module)
  const names = WebAssembly.Module.exports(compiled).map((entry) => entry.name)
  for (const name of [
    'core_new',
    'core_boundary_version',
    'core_start',
    'core_resume',
    'core_command_start',
    'core_command_resume',
  ]) {
    assert.ok(names.includes(name), `the wasm module must export ${name}`)
  }
  assert.ok(WebAssembly.Module.imports(compiled).length > 0)
})

test('the real wasm core drives a passing experiment through every stage', async () => {
  const recorder = createConcepts()
  const loaded = await loadBundledResearchCore(recorder.concepts)
  assert.equal(loaded.ok, true)
  if (!loaded.ok) return

  const result = await loaded.value.run(START)
  assert.equal(result.ok, true)
  if (!result.ok) return

  assert.deepEqual(result.value, { outcome: 'concluded', stages: EXPECTED_STAGES })
  assert.deepEqual(recorder.calls, EXPECTED_CALLS)
  assert.equal(recorder.records.length, 1)
  const record = recorder.records[0]
  assert.ok(record)
  assert.equal(record.status, 'passed')
  assert.equal(record.attempt, 1)
  assert.equal(record.maxAttempts, 2)
  assert.equal(record.specHash, SPEC_HASH)
  assert.equal(record.environmentDigest, ENVIRONMENT_DIGEST)
})

test('the core refuses a resume for any effect but the pending one', async () => {
  const recorder = createConcepts()
  const loaded = await loadBundledResearchCore(recorder.concepts)
  assert.equal(loaded.ok, true)
  if (!loaded.ok) return
  const core = loaded.value

  const started = core.start(START)
  assert.equal(started.ok, true)
  if (!started.ok) return
  assert.equal(started.value.kind, 'effect')
  if (started.value.kind !== 'effect') return
  assert.equal(started.value.effect, 'storage.loadProgram')
  assert.equal(started.value.stage, 'ExperimentProposed')
  const sequence = started.value.sequence

  const laterEffect = core.resume({
    effect: 'benchmark.run',
    sequence,
    result: {
      ok: true,
      value: {
        id: 'benchmark-1',
        experimentId: START.experimentId,
        ticketId: ticketId('ticket-1'),
        commit: START.baseCommit,
        specHash: SPEC_HASH,
        environmentDigest: ENVIRONMENT_DIGEST,
        metrics: [],
        status: 'passed',
        attempt: 1,
        maxAttempts: 1,
        stdout: '',
        stderr: '',
        artifacts: [],
        createdAt: NOW,
      },
    },
  })
  assert.equal(laterEffect.ok, false)
  if (laterEffect.ok) return
  assert.equal(laterEffect.error.kind, 'protocol')
  assert.match(laterEffect.error.message, /benchmark\.run/)

  const laterSequence = core.resume({
    effect: 'storage.loadProgram',
    sequence: String(Number(sequence) + 1),
    result: { ok: true, value: PROGRAM },
  })
  assert.equal(laterSequence.ok, false)

  const accepted = core.resume({
    effect: 'storage.loadProgram',
    sequence,
    result: { ok: true, value: PROGRAM },
  })
  assert.equal(accepted.ok, true)
  if (!accepted.ok) return
  assert.equal(accepted.value.kind, 'effect')
  if (accepted.value.kind !== 'effect') return
  assert.equal(accepted.value.effect, 'trigger.deliver')
  assert.equal(accepted.value.stage, 'ExperimentProposed')
  assert.deepEqual(recorder.calls, [])
})

test('a failed benchmark closes the pipeline at ResearchCompleted', async () => {
  const recorder = createConcepts(['failed'])
  const loaded = await loadBundledResearchCore(recorder.concepts)
  assert.equal(loaded.ok, true)
  if (!loaded.ok) return

  const result = await loaded.value.run(START)
  assert.equal(result.ok, true)
  if (!result.ok) return

  assert.equal(result.value.outcome, 'failed')
  assert.deepEqual(result.value.stages, [
    'ExperimentProposed',
    'TriggerAccepted',
    'TicketOpened',
    'WorkerStarted',
    'CommitSubmitted',
    'EnvironmentBuilt',
    'BenchmarkFailed',
    'ResearchCompleted',
  ])
  assert.equal(recorder.records.length, 1)
  assert.equal(recorder.records[0]?.status, 'failed')
})

test('the core validates a host benchmark record before any stage advances', async () => {
  const recorder = createConcepts(['passed'], true)
  const loaded = await loadBundledResearchCore(recorder.concepts)
  assert.equal(loaded.ok, true)
  if (!loaded.ok) return

  const result = await loaded.value.run(START)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.kind, 'domain')
  assert.match(result.error.message, /commit/i)
  assert.equal(recorder.records.length, 0)
  assert.ok(!recorder.calls.includes('sessions.review'))
})

test('a retryable benchmark returns to EnvironmentBuilt before passing', async () => {
  const recorder = createConcepts(['retryable', 'passed'])
  const loaded = await loadBundledResearchCore(recorder.concepts)
  assert.equal(loaded.ok, true)
  if (!loaded.ok) return

  const result = await loaded.value.run(START)
  assert.equal(result.ok, true)
  if (!result.ok) return

  assert.equal(result.value.outcome, 'concluded')
  assert.deepEqual(result.value.stages, [
    'ExperimentProposed',
    'TriggerAccepted',
    'TicketOpened',
    'WorkerStarted',
    'CommitSubmitted',
    'EnvironmentBuilt',
    'BenchmarkRetryable',
    'EnvironmentBuilt',
    'BenchmarkPassed',
    'ResultRecorded',
    'ReviewRecorded',
    'ResearchCompleted',
  ])
  assert.deepEqual(
    recorder.calls.filter((call) => call.startsWith('benchmark.')),
    [
      `benchmark.buildEnvironment:${HEAD}`,
      'benchmark.specHash:benchmark-1',
      'benchmark.run:1',
      `benchmark.buildEnvironment:${HEAD}`,
      'benchmark.specHash:benchmark-1',
      'benchmark.run:2',
    ],
  )
  assert.deepEqual(
    recorder.records.map((record) => [record.status, record.attempt]),
    [
      ['retryable', 1],
      ['passed', 2],
    ],
  )
})

test('isolated Core instances keep independent effect state', async () => {
  const first = createConcepts()
  const second = createConcepts(['failed'])
  const firstCore = await loadBundledResearchCore(first.concepts)
  const secondCore = await loadBundledResearchCore(second.concepts)
  assert.equal(firstCore.ok, true)
  assert.equal(secondCore.ok, true)
  if (!firstCore.ok || !secondCore.ok) return

  const firstStart = firstCore.value.start(START)
  const secondStart = secondCore.value.start(START)
  assert.equal(firstStart.ok, true)
  assert.equal(secondStart.ok, true)
  if (!firstStart.ok || !secondStart.ok) return
  assert.equal(firstStart.value.kind, 'effect')
  assert.equal(secondStart.value.kind, 'effect')
  if (firstStart.value.kind !== 'effect' || secondStart.value.kind !== 'effect') return
  assert.equal(firstStart.value.sequence, secondStart.value.sequence)
  assert.equal(firstStart.value.effect, 'storage.loadProgram')

  const firstRun = firstCore.value.run(START)
  const secondRun = secondCore.value.run(START)
  const [firstResult, secondResult] = await Promise.all([firstRun, secondRun])
  assert.equal(firstResult.ok, true)
  assert.equal(secondResult.ok, true)
  if (!firstResult.ok || !secondResult.ok) return
  assert.equal(firstResult.value.outcome, 'concluded')
  assert.equal(secondResult.value.outcome, 'failed')
  assert.deepEqual(first.calls, EXPECTED_CALLS)
  assert.ok(second.calls.includes('benchmark.run:1'))
})

test('the core exposes no stage mutation entry point', async () => {
  const loaded = await loadBundledResearchCore(createConcepts().concepts)
  assert.equal(loaded.ok, true)
  if (!loaded.ok) return
  const members = Object.getOwnPropertyNames(Object.getPrototypeOf(loaded.value))
  for (const member of members) {
    assert.doesNotMatch(member, /stage|advance|transition|force/i)
  }
})
