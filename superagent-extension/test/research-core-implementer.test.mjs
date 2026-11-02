import assert from 'node:assert/strict'
import test from 'node:test'

import { createDshCoreRuntime } from '../research-core-runtime.js'
import { createResearchSessionPool } from '../research-sessions.js'

const HEAD = 'b'.repeat(40)
const SPEC_HASH = 'a'.repeat(64)
const ENVIRONMENT_DIGEST = 'c'.repeat(64)
const NOW = '2026-01-01T00:00:00.000Z'

const ok = (value) => ({ ok: true, value })

function createStore() {
  const programs = new Map([
    ['program-1', {
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
    }],
  ])
  const experiments = new Map([
    ['experiment-1', {
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
    }],
  ])
  const tickets = new Map()
  const ciRecords = []
  return {
    programs: { get: async (id) => programs.get(id) },
    experiments: { get: async (id) => experiments.get(id) },
    tickets: {
      get: async (id) => tickets.get(id),
      async save(expected, ticket) {
        const current = tickets.get(ticket.id)
        const version = current?.version ?? 0
        if (version !== expected) return { ok: false, error: { kind: 'version-conflict' } }
        tickets.set(ticket.id, { version: version + 1, value: ticket })
        return ok(version + 1)
      },
    },
    ciRecords: {
      async append(record) {
        ciRecords.push(record)
        return ok(undefined)
      },
    },
    state: { programs, experiments, tickets, ciRecords },
  }
}

function createController(options = {}) {
  const agents = new Map()
  const calls = { create: [], resolve: [], followup: [] }
  return {
    agents,
    calls,
    async resolveAgent(sessionId) {
      calls.resolve.push(sessionId)
      const agent = agents.get(sessionId)
      return agent === undefined
        ? { error: { code: 'session/not-found', message: `no session ${sessionId}` } }
        : { agent }
    },
    async create(request) {
      calls.create.push({ ...request })
      if (typeof options.onCreate === 'function') await options.onCreate(request)
      const agent = {
        id: request.sessionId,
        session: { header: { agentPreset: request.agentPreset } },
        async followup(message) {
          const text = Array.isArray(message?.content)
            ? message.content.map((part) => part?.text ?? '').join('')
            : String(message)
          calls.followup.push({ sessionId: request.sessionId, message: text })
          if (typeof options.onFollowup === 'function') await options.onFollowup(request.sessionId, text)
        },
      }
      agents.set(request.sessionId, agent)
      return { sessionId: request.sessionId }
    },
  }
}

function createPool(controller) {
  const workspace = { id: 'ws-1', path: '/research' }
  const registry = {
    list: () => [workspace],
    get: (id) => (id === workspace.id ? workspace : undefined),
    create: async () => workspace,
  }
  const ctx = {
    sessionController: controller,
    workspaceRegistry: registry,
    get: () => undefined,
    provide() {},
    effect() {},
    logger: { info() {}, warn() {} },
  }
  return createResearchSessionPool(ctx, { workspaceId: workspace.id })
}

function createBenchmark() {
  return {
    async specHash() {
      return ok(SPEC_HASH)
    },
    async buildEnvironment() {
      return ok(ENVIRONMENT_DIGEST)
    },
    async run(request) {
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
}

async function runtimeFor(store, pool) {
  const created = await createDshCoreRuntime({
    store,
    sessions: pool,
    trigger: { deliver: async () => undefined },
    benchmark: createBenchmark(),
    clock: { now: () => NOW },
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

test('the core wakes the deterministic implementer and runs to the submitted commit', async () => {
  const store = createStore()
  let controller
  controller = createController({
    async onFollowup() {
      const ticket = store.state.tickets.get('ticket:experiment-1')
      await store.tickets.save(ticket.version, {
        ...ticket.value,
        status: 'submitted',
        head: HEAD,
        submittedAt: NOW,
      })
    },
  })
  const pool = createPool(controller)
  const runtime = await runtimeFor(store, pool)

  const started = await runtime.start(START)
  assert.equal(started.status, 'paused')
  if (started.status !== 'paused') return
  assert.equal(started.pending.effect, 'sessions.review')
  assert.equal(controller.calls.create.length, 1)
  assert.equal(controller.calls.create[0].agentPreset, 'aleph-implementer')
  assert.equal(controller.calls.create[0].sessionId, 'aleph-implementer-ticket:experiment-1')
  assert.equal(controller.calls.followup.length, 1)
  assert.match(controller.calls.followup[0].message, /aleph_research_submit_ticket/)
  assert.match(controller.calls.followup[0].message, /ticket:experiment-1/)
  assert.equal(store.state.tickets.get('ticket:experiment-1').value.status, 'submitted')
  assert.equal(store.state.ciRecords.length, 1)

  const completed = await runtime.resumeReview({ kind: 'propose' })
  assert.equal(completed.status, 'completed')
  if (completed.status !== 'completed') return
  assert.equal(completed.outcome, 'concluded')
})

test('a failing implementer turn fails the core instead of stalling', async () => {
  const store = createStore()
  const controller = createController({
    async onFollowup() {
      throw new Error('the implementer session crashed')
    },
  })
  const runtime = await runtimeFor(store, createPool(controller))

  const started = await runtime.start(START)
  assert.equal(started.status, 'failed')
  if (started.status !== 'failed') return
  assert.equal(started.error.kind, 'domain')
  assert.match(started.error.message, /implementer session crashed/)
  assert.equal(runtime.pending(), undefined)
  assert.equal(controller.calls.followup.length, 1)
})

test('a missing implementer preset fails the core with the preset refusal', async () => {
  const store = createStore()
  const controller = createController({
    async onCreate() {
      const error = new Error('the aleph-implementer preset is not declared')
      error.code = 'preset/not-found'
      throw error
    },
  })
  const runtime = await runtimeFor(store, createPool(controller))

  const started = await runtime.start(START)
  assert.equal(started.status, 'failed')
  if (started.status !== 'failed') return
  assert.equal(started.error.kind, 'domain')
  assert.match(started.error.message, /preset is not declared/)
  assert.equal(runtime.pending(), undefined)
  assert.equal(controller.calls.create.length, 1)
  assert.equal(controller.calls.followup.length, 0)
})

test('a woken worker that exits without a commit can be failed explicitly', async () => {
  const store = createStore()
  const controller = createController()
  const runtime = await runtimeFor(store, createPool(controller))

  const started = await runtime.start(START)
  assert.equal(started.status, 'paused')
  if (started.status !== 'paused') return
  assert.equal(started.pending.effect, 'sessions.submitCommit')
  assert.equal(controller.calls.followup.length, 1)

  const failed = await runtime.failPending('the implementer exited without a commit')
  assert.equal(failed.status, 'failed')
  if (failed.status !== 'failed') return
  assert.equal(failed.error.kind, 'domain')
  assert.match(failed.error.message, /exited without a commit/)
  assert.equal(runtime.pending(), undefined)
})

test('a session pool without a wake channel fails the core typed', async () => {
  const store = createStore()
  const sessions = {
    async ensureImplementer() {
      return 'session-1'
    },
  }
  const created = await createDshCoreRuntime({
    store,
    sessions,
    trigger: { deliver: async () => undefined },
    benchmark: createBenchmark(),
    clock: { now: () => NOW },
  })
  assert.equal(created.ok, true)
  if (!created.ok) return

  const started = await created.value.runtime.start(START)
  assert.equal(started.status, 'failed')
  if (started.status !== 'failed') return
  assert.equal(started.error.kind, 'domain')
  assert.match(started.error.message, /no implementer wake channel/)
  assert.equal(created.value.runtime.pending(), undefined)
})
