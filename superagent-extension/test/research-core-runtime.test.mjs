import assert from 'node:assert/strict'
import test from 'node:test'

import { createDshCoreRuntime } from '../research-core-runtime.js'

const HEAD = 'b'.repeat(40)
const SPEC_HASH = 'a'.repeat(64)
const ENVIRONMENT_DIGEST = 'c'.repeat(64)
const NOW = '2026-01-01T00:00:00.000Z'

const ok = (value) => ({ ok: true, value })

function createStore() {
  const programs = new Map()
  const experiments = new Map()
  const tickets = new Map()
  const ciRecords = []
  return {
    state: { programs, experiments, tickets, ciRecords },
    programs: {
      get: async (id) => programs.get(id),
    },
    experiments: {
      get: async (id) => experiments.get(id),
    },
    tickets: {
      get: async (id) => tickets.get(id),
      async save(expected, ticket) {
        const current = tickets.get(ticket.id)
        const version = current?.version ?? 0
        if (version !== expected) {
          return { ok: false, error: { kind: 'version-conflict', expected, actual: version } }
        }
        const next = { version: version + 1, value: ticket }
        tickets.set(ticket.id, next)
        return ok(next.version)
      },
    },
    ciRecords: {
      async append(record) {
        ciRecords.push(record)
        return ok(undefined)
      },
    },
  }
}

function seedProgram(store) {
  store.state.programs.set('program-1', {
    version: 1,
    value: {
      id: 'program-1',
      name: 'Program',
      goal: 'Improve the benchmark',
      methodology: 'Propose, run, review',
      contract: { ciEntry: 'bench.py', timeoutMs: 30_000, requiredMetrics: ['score'] },
      utility: { metrics: [{ name: 'score', direction: 'higher', weight: 1 }] },
      exploration: 'normal',
      budget: { maxExperiments: 4, maxComputeMinutes: 60, maxTokens: 10_000 },
      usage: { experiments: 0, computeMinutes: 0, tokens: 0 },
      status: 'running',
      createdAt: NOW,
    },
  })
}

function seedExperiment(store) {
  store.state.experiments.set('experiment-1', {
    version: 1,
    value: {
      id: 'experiment-1',
      programId: 'program-1',
      issueId: 'issue-1',
      branch: 'experiment/one',
      head: HEAD,
      environment: { kind: 'uv-lock', lockFile: 'uv.lock', pythonVersion: '3.12' },
      createdBy: { kind: 'researcher', sessionId: 'aleph-researcher-1' },
      createdAt: NOW,
      status: 'open',
    },
  })
}

function createHarness() {
  const store = createStore()
  seedProgram(store)
  seedExperiment(store)
  const calls = []
  const triggers = []
  const sessions = {
    async ensureImplementer(ticketId) {
      calls.push(`ensureImplementer:${ticketId}`)
      return 'session-1'
    },
    async wakeImplementer(sessionId, message) {
      calls.push(`wakeImplementer:${sessionId}`)
      assert.match(message, /aleph_research_submit_ticket/)
      return { ok: true, sessionId }
    },
  }
  const trigger = {
    async deliver(draft) {
      triggers.push(draft)
    },
  }
  const benchmark = {
    async specHash() {
      calls.push('specHash')
      return ok(SPEC_HASH)
    },
    async buildEnvironment(request) {
      calls.push(`buildEnvironment:${request.commit}`)
      return ok(ENVIRONMENT_DIGEST)
    },
    async run(request) {
      calls.push(`run:${request.attempt}`)
      return ok({
        id: `benchmark:${request.experimentId}:${request.attempt}`,
        experimentId: request.experimentId,
        ticketId: request.ticketId,
        commit: request.commit,
        specHash: SPEC_HASH,
        environmentDigest: request.environmentDigest,
        metrics: [{ name: 'score', value: 1 }],
        status: 'passed',
        attempt: request.attempt,
        maxAttempts: request.maxAttempts,
        stdout: '',
        stderr: '',
        artifacts: [],
        createdAt: NOW,
      })
    },
  }
  const clock = { now: () => NOW }
  return { store, calls, triggers, sessions, trigger, benchmark, clock }
}

async function start(harness) {
  const created = await createDshCoreRuntime({
    store: harness.store,
    sessions: harness.sessions,
    trigger: harness.trigger,
    benchmark: harness.benchmark,
    clock: harness.clock,
  })
  assert.equal(created.ok, true)
  if (!created.ok) throw new Error('the core did not load')
  return created.value.runtime
}

const START = {
  programId: 'program-1',
  issueId: 'issue-1',
  experimentId: 'experiment-1',
  branch: 'experiment/one',
  baseCommit: HEAD,
  environment: { kind: 'uv-lock', file: 'uv.lock' },
}

test('the DSH core runtime drives the embedded wasm through every stage', async () => {
  const harness = createHarness()
  const runtime = await start(harness)

  const started = await runtime.start(START)
  assert.equal(started.status, 'paused')
  if (started.status !== 'paused') return
  assert.equal(started.pending.effect, 'sessions.submitCommit')
  assert.equal(started.pending.stage, 'WorkerStarted')

  const ticket = harness.store.state.tickets.get('ticket:experiment-1')
  assert.ok(ticket)
  assert.equal(ticket.value.status, 'running')
  assert.equal(ticket.value.sessionId, 'session-1')
  assert.deepEqual(harness.calls, [
    'ensureImplementer:ticket:experiment-1',
    'wakeImplementer:session-1',
  ])
  assert.equal(harness.triggers.length, 1)
  assert.equal(harness.triggers[0].kind, 'experiment-proposed')
  assert.equal(harness.triggers[0].programId, 'program-1')
  assert.deepEqual(
    harness.triggers[0].threads.map((thread) => thread.kind),
    ['experiment', 'program'],
  )

  await harness.store.tickets.save(ticket.version, {
    ...ticket.value,
    status: 'submitted',
    head: HEAD,
    submittedAt: NOW,
  })
  const committed = await runtime.resumeCommit(HEAD)
  assert.equal(committed.status, 'paused')
  if (committed.status !== 'paused') return
  assert.equal(committed.pending.effect, 'sessions.review')
  assert.equal(committed.pending.stage, 'ResultRecorded')
  assert.equal(harness.store.state.ciRecords.length, 1)
  assert.equal(harness.store.state.ciRecords[0].status, 'passed')
  assert.equal(harness.store.state.ciRecords[0].programId, 'program-1')
  assert.deepEqual(harness.store.state.ciRecords[0].metrics, { score: 1 })

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
})

test('a failed benchmark record is stored as a failed research record', async () => {
  const harness = createHarness()
  harness.benchmark.run = async (request) => ok({
    id: `benchmark:${request.experimentId}:${request.attempt}`,
    experimentId: request.experimentId,
    ticketId: request.ticketId,
    commit: request.commit,
    specHash: SPEC_HASH,
    environmentDigest: request.environmentDigest,
    metrics: [{ name: 'score', value: 0 }],
    status: 'failed',
    attempt: request.attempt,
    maxAttempts: request.maxAttempts,
    stdout: '',
    stderr: 'the benchmark failed',
    artifacts: [],
    createdAt: NOW,
  })
  const runtime = await start(harness)
  const started = await runtime.start(START)
  assert.equal(started.status, 'paused')
  if (started.status !== 'paused') return
  const ticket = harness.store.state.tickets.get('ticket:experiment-1')
  await harness.store.tickets.save(ticket.version, {
    ...ticket.value,
    status: 'submitted',
    head: HEAD,
    submittedAt: NOW,
  })
  const result = await runtime.resumeCommit(HEAD)
  assert.equal(result.status, 'completed')
  if (result.status !== 'completed') return
  assert.equal(result.outcome, 'failed')
  assert.equal(harness.store.state.ciRecords.length, 1)
  assert.equal(harness.store.state.ciRecords[0].status, 'failed')
  assert.equal(harness.store.state.ciRecords[0].detail, 'the benchmark failed')
})

test('a missing program is refused before any ticket is opened', async () => {
  const harness = createHarness()
  harness.store.state.programs.clear()
  const runtime = await start(harness)
  const started = await runtime.start(START)
  assert.equal(started.status, 'failed')
  assert.equal(harness.store.state.tickets.size, 0)
  assert.equal(harness.triggers.length, 0)
})
