import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../research-core-host.js'

const NOW = '2026-01-01T00:00:00.000Z'
const HEAD = 'b'.repeat(40)
const SPEC_HASH = 'a'.repeat(64)
const ENVIRONMENT_DIGEST = 'c'.repeat(64)

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
  const issues = new Map()
  const tickets = new Map()
  const ciRecords = []
  const audit = []
  const saveAggregate = async (rows, ticket) => {
    const current = rows.get(ticket.id)
    const version = current?.version ?? 0
    if (version !== ticket.expected) return { ok: false, error: { kind: 'version-conflict' } }
    rows.set(ticket.id, { version: version + 1, value: ticket.value })
    return ok(version + 1)
  }
  return {
    programs: {
      get: async (id) => programs.get(id),
      list: async () => [...programs.values()],
      async save(expected, next) {
        const current = programs.get(next.id)
        const version = current?.version ?? 0
        if (version !== expected) return { ok: false, error: { kind: 'version-conflict' } }
        programs.set(next.id, { version: version + 1, value: next })
        return ok(version + 1)
      },
    },
    issues: {
      get: async (id) => issues.get(id),
      async save(expected, next) {
        const current = issues.get(next.id)
        const version = current?.version ?? 0
        if (version !== expected) return { ok: false, error: { kind: 'version-conflict' } }
        issues.set(next.id, { version: version + 1, value: next })
        return ok(version + 1)
      },
    },
    experiments: {
      get: async (id) => experiments.get(id),
      async save(expected, next) {
        const current = experiments.get(next.id)
        const version = current?.version ?? 0
        if (version !== expected) return { ok: false, error: { kind: 'version-conflict' } }
        experiments.set(next.id, { version: version + 1, value: next })
        return ok(version + 1)
      },
    },
    audit: {
      async append(entries) {
        audit.push(...entries)
      },
      async list(programId, limit) {
        return audit.filter((entry) => entry.programId === programId).slice(-limit)
      },
    },
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
    state: { programs, issues, experiments, tickets, ciRecords, audit },
  }
}

function createHarness() {
  const store = createStore()
  const toolCalls = []
  const triggers = []
  const benchCalls = []
  const hostService = {
    host: {
      store,
      clock: { now: () => NOW },
      async snapshot(id) {
        const found = store.state.programs.get(id)
        return found === undefined
          ? { ok: false, status: 404, error: { code: 'not-found', message: 'missing' } }
          : { ok: true, value: { program: found.value, issues: [], audit: [] } }
      },
      async attention() {
        return []
      },
    },
    store,
    async executeTool(tool, input, context) {
      toolCalls.push({ tool, input, context })
      return { ok: true, value: { tool } }
    },
    async deliverDraft(draft) {
      triggers.push(draft)
    },
  }
  const sessions = {
    async ensureImplementer(ticketId) {
      return `aleph-implementer-${ticketId}`
    },
  }
  const benchmark = {
    async specHash() {
      return ok(SPEC_HASH)
    },
    async buildEnvironment() {
      return ok(ENVIRONMENT_DIGEST)
    },
    async run(request) {
      benchCalls.push(request)
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
  const routes = []
  const tools = []
  const provided = new Map()
  const disposers = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      if (name === 'alephResearchHost') return hostService
      if (name === 'alephResearchSessions') return sessions
      return undefined
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    provide(name, value) {
      provided.set(name, value)
    },
    effect(fn) {
      disposers.push(fn())
    },
  }
  return { ctx, store, hostService, benchmark, routes, tools, provided, toolCalls, triggers, benchCalls }
}

function request(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function response() {
  return {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(text) {
      this.body = JSON.parse(text)
    },
  }
}

test('the core host binds the surface into DSH and provides its service', async () => {
  const harness = createHarness()
  await apply(harness.ctx, { benchmark: harness.benchmark })

  const service = harness.provided.get('alephResearchCore')
  assert.ok(service)
  assert.equal(harness.routes.length, 1)
  assert.equal(harness.routes[0].kind, 'prefix')
  assert.equal(harness.routes[0].path, '/aleph/api/research')
  assert.equal(service.routes.length, 16)
  assert.equal(service.tools.length, 19)
  assert.equal(service.presets.length, 4)
  assert.equal(service.settings.length, 4)
  assert.equal(harness.tools.length, 19)
  assert.equal(typeof service.artifacts.list, 'function')
})

test('a POST route reaches the rust command bridge through the dispatcher', async () => {
  const harness = createHarness()
  await apply(harness.ctx, { benchmark: harness.benchmark })
  const route = harness.routes[0]
  const res = response()

  await route.handler(
    request('POST', '/aleph/api/research/programs', {
      programId: 'program-2',
      name: 'Program',
      goal: 'Goal',
      methodology: 'Method',
      contract: { ciEntry: 'bench.py', timeoutMs: 30_000, requiredMetrics: ['score'] },
      utility: { metrics: [{ name: 'score', direction: 'higher', weight: 1 }] },
      exploration: 'normal',
      budget: { maxExperiments: 4, maxComputeMinutes: 60, maxTokens: 10_000 },
    }),
    res,
  )

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.value.id, 'program-2')
  assert.equal(harness.toolCalls.length, 0)
  assert.equal(harness.store.state.programs.get('program-2')?.value.name, 'Program')
  assert.equal(harness.store.state.audit.length, 1)
})

test('benchmark.request runs the embedded core and reports its paused progress', async () => {
  const harness = createHarness()
  await apply(harness.ctx, { benchmark: harness.benchmark })
  const res = response()

  await harness.routes[0].handler(
    request('POST', '/aleph/api/research/programs/program-1/experiments/experiment-1/benchmarks', {}),
    res,
  )

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.value.progress.status, 'paused')
  assert.equal(res.body.value.progress.pending.effect, 'sessions.submitCommit')
  assert.equal(harness.toolCalls.length, 0)
  assert.equal(harness.triggers.length, 1)
  assert.equal(harness.store.state.tickets.size, 1)
})

test('GET program routes keep working through the dispatcher fallback', async () => {
  const harness = createHarness()
  await apply(harness.ctx, { benchmark: harness.benchmark })

  const list = response()
  await harness.routes[0].handler(request('GET', '/aleph/api/research/programs'), list)
  assert.equal(list.statusCode, 200)
  assert.equal(list.body.count, 1)

  const snapshot = response()
  await harness.routes[0].handler(request('GET', '/aleph/api/research/programs/program-1'), snapshot)
  assert.equal(snapshot.statusCode, 200)
  assert.equal(snapshot.body.value.program.id, 'program-1')
})

test('the core host is inert without the legacy host service', async () => {
  const harness = createHarness()
  harness.ctx.get = () => undefined
  await apply(harness.ctx, {})
  assert.equal(harness.routes.length, 0)
  assert.equal(harness.provided.size, 0)
})

async function realHarness(options = {}) {
  const { createResearchHost } = await import('../../research-core/dist/adapter/composition.js')
  const { createResearchHostService, createTriggerPort } = await import('../research-host.js')
  const { TOOL_REGISTRY } = await import('../../research-core/dist/runtime/tools.js')
  const { ROUTE_TABLE } = await import('../../research-core/dist/runtime/api.js')
  const { createTriggerFactory } = await import('../../research-core/dist/runtime/triggers.js')

  const host = createResearchHost()
  const service = createResearchHostService({
    host,
    tools: { TOOL_REGISTRY },
    api: { ROUTE_TABLE },
    triggers: { createTriggerFactory },
    triggerPort: createTriggerPort(),
  })
  const routes = []
  const provided = new Map()
  const tools = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      if (name === 'alephResearchHost') return service
      return undefined
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    provide(name, value) {
      provided.set(name, value)
    },
    effect() {},
  }
  const config = typeof options.evalCommand === 'string'
    ? { evalCommand: options.evalCommand, cwd: process.cwd() }
    : { benchmark: createHarness().benchmark }
  await apply(ctx, config)
  return { host, service, routes, provided, tools, config }
}

test('the surface drives program.create through the embedded command bridge', async () => {
  const harness = await realHarness()
  const { host, service, routes } = harness

  const res = response()
  await routes[0].handler(
    request('POST', '/aleph/api/research/programs', {
      name: 'Program',
      goal: 'Improve the benchmark',
      methodology: 'Propose, run, review',
      contract: { ciEntry: 'bench.py', timeoutMs: 30_000, requiredMetrics: ['score'] },
      utility: { metrics: [{ name: 'score', direction: 'higher', weight: 1 }] },
      exploration: 'normal',
      budget: { maxExperiments: 4, maxComputeMinutes: 60, maxTokens: 10_000 },
    }),
    res,
  )

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.ok, true)
  const programs = await host.store.programs.list()
  assert.equal(programs.length, 1)
  assert.equal(programs[0].value.name, 'Program')
  service.dispose()
})

const PLAN_BODY = {
  hypothesis: 'a wider clipping window is better',
  steps: ['clip wider', 'measure'],
  expected: { direction: 'higher', rationale: 'more signal' },
  environment: { kind: 'uv-lock', lockFile: 'uv.lock', pythonVersion: '3.12' },
  inputs: [],
}

test('the surface runs an Experiment through the embedded core to completion', async () => {
  const harness = await realHarness({
    evalCommand: 'node -e "console.log(JSON.stringify({score:0.9}))"',
  })
  const { host, routes, service } = harness
  const route = routes[0]

  const programResponse = response()
  await route.handler(request('POST', '/aleph/api/research/programs', {
    name: 'Program',
    goal: 'Improve the benchmark',
    methodology: 'Propose, run, review',
    contract: { ciEntry: 'bench.py', timeoutMs: 30_000, requiredMetrics: ['score'] },
    utility: { metrics: [{ name: 'score', direction: 'higher', weight: 1 }] },
    exploration: 'normal',
    budget: { maxExperiments: 4, maxComputeMinutes: 60, maxTokens: 10_000 },
  }), programResponse)
  assert.equal(proposalStatus(programResponse), 200)
  const programId = programResponse.body.value.id

  const issueResponse = response()
  await route.handler(request('POST', `/aleph/api/research/programs/${programId}/issues`, {
    title: 'wider clipping window',
    body: 'test whether a wider window improves the score',
    labels: ['research'],
  }), issueResponse)
  assert.equal(proposalStatus(issueResponse), 200)
  const issueId = issueResponse.body.value.id

  const claimResponse = response()
  await route.handler(request('POST', `/aleph/api/research/programs/${programId}/issues/${issueId}/claim`, {}), claimResponse)
  assert.equal(proposalStatus(claimResponse), 200)

  const experimentResponse = response()
  await route.handler(request('POST', `/aleph/api/research/programs/${programId}/issues/${issueId}/experiments`, {
    plan: PLAN_BODY,
  }), experimentResponse)
  assert.equal(proposalStatus(experimentResponse), 200)
  const experimentId = experimentResponse.body.value.id

  const started = response()
  await route.handler(request('POST', `/aleph/api/research/programs/${programId}/experiments/${experimentId}/benchmarks`, {}), started)
  assert.equal(proposalStatus(started), 200)
  assert.equal(started.body.value.progress.status, 'paused')
  assert.equal(started.body.value.progress.pending.effect, 'sessions.submitCommit')

  const submitted = response()
  await route.handler(request('POST', '/aleph/api/research/tickets/submit', {
    experimentId,
    head: HEAD,
    environment: { kind: 'uv-lock', lockFile: 'uv.lock', pythonVersion: '3.12' },
  }), submitted)
  assert.equal(proposalStatus(submitted), 200)
  assert.equal(submitted.body.value.progress.status, 'paused')
  assert.equal(submitted.body.value.progress.pending.effect, 'sessions.review')

  const reviewed = response()
  await route.handler(request('POST', `/aleph/api/research/programs/${programId}/experiments/${experimentId}/reviews`, {
    verdict: 'approve',
    body: 'the benchmark improved',
  }), reviewed)
  assert.equal(proposalStatus(reviewed), 200)
  assert.equal(reviewed.body.value.progress.status, 'completed')
  assert.equal(reviewed.body.value.progress.outcome, 'concluded')

  const records = await host.store.ciRecords.listByExperiment(experimentId)
  assert.equal(records.length, 1)
  assert.equal(records[0].status, 'passed')
  assert.equal(records[0].metrics.score, 0.9)
  service.dispose()
})

const proposalStatus = (res) => (res.body?.ok === true ? 200 : res.statusCode)
