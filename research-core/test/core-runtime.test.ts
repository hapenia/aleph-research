import assert from 'node:assert/strict'
import test from 'node:test'
import { createCoreRuntime } from '../src/adapter/core-runtime.js'
import type {
  CoreBenchmarkRecord,
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
    timeoutMs: 30_000,
    metrics: [{ name: 'score', direction: 'maximize', required: true }],
    maxRetries: 1,
    baseline: {},
  },
  utility: [{ name: 'score', direction: 'maximize', weight: 1 }],
  exploration: 'normal',
  policy: {
    maxExperiments: 4,
    maxComputeMinutes: 60,
    maxTokens: 10_000,
    maxAttemptsPerExperiment: 2,
  },
  usage: { experiments: 0, computeMinutes: 0, tokens: 0 },
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

interface Recorder {
  readonly concepts: CoreConcepts
  readonly calls: string[]
  readonly records: CoreBenchmarkRecord[]
}

function createConcepts(): Recorder {
  const calls: string[] = []
  const records: CoreBenchmarkRecord[] = []
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
      review: async () => {
        calls.push('sessions.review')
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
        return ok({
          id: 'benchmark-1',
          experimentId: request.experimentId,
          ticketId: request.ticketId,
          commit: request.commit,
          specHash: SPEC_HASH,
          environmentDigest: request.environmentDigest,
          metrics: request.spec.metrics.map((metric) => ({
            name: metric.name,
            value: 1,
          })),
          status: 'passed',
          attempt: request.attempt,
          maxAttempts: request.maxAttempts,
          stdout: '',
          stderr: '',
          artifacts: [],
          createdAt: NOW,
        })
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

test('the runtime pauses before a commit and before a review', async () => {
  const recorder = createConcepts()
  let ready = false
  const loaded = await createCoreRuntime({
    concepts: recorder.concepts,
    hooks: {
      canSubmitCommit: async () => ready,
    },
  })
  assert.equal(loaded.ok, true)
  if (!loaded.ok) return
  const runtime = loaded.value

  const started = await runtime.start(START)
  assert.equal(started.status, 'paused')
  if (started.status !== 'paused') return
  assert.equal(started.pending.effect, 'sessions.submitCommit')
  assert.equal(started.pending.stage, 'WorkerStarted')
  assert.equal(runtime.pending()?.effect, 'sessions.submitCommit')
  assert.ok(!recorder.calls.includes('sessions.submitCommit'))
  assert.equal(recorder.records.length, 0)

  ready = true
  const committed = await runtime.resumeCommit(commitSha(HEAD))
  assert.equal(committed.status, 'paused')
  if (committed.status !== 'paused') return
  assert.equal(committed.pending.effect, 'sessions.review')
  assert.equal(committed.pending.stage, 'ResultRecorded')
  assert.deepEqual(recorder.records.map((record) => record.status), ['passed'])

  const completed = await runtime.resumeReview({ kind: 'propose' })
  assert.equal(completed.status, 'completed')
  if (completed.status !== 'completed') return
  assert.equal(completed.outcome, 'concluded')
  assert.deepEqual(completed.stages, [
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
  ])
  assert.equal(runtime.pending(), undefined)
  assert.ok(!recorder.calls.includes('sessions.review'))
})

test('a resume without a pending effect is a protocol failure', async () => {
  const recorder = createConcepts()
  const loaded = await createCoreRuntime({ concepts: recorder.concepts })
  assert.equal(loaded.ok, true)
  if (!loaded.ok) return

  const review = await loaded.value.resumeReview({ kind: 'stop', reason: 'goal-met' })
  assert.equal(review.status, 'failed')
  if (review.status !== 'failed') return
  assert.equal(review.error.kind, 'protocol')

  const commit = await loaded.value.resumeCommit(commitSha(HEAD))
  assert.equal(commit.status, 'failed')
  if (commit.status !== 'failed') return
  assert.equal(commit.error.kind, 'protocol')
})
