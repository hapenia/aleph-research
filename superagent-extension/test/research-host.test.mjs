/**
 * Transport tests for the AlephResearch Host plugin.
 *
 * No DSH runtime is composed here: a fake `ctx.webServer` collects the registered
 * routes, and each handler is exercised with a Node Readable as the request and a small
 * response recorder. The research runtime itself is the real compiled `dist/` build, so
 * these tests also prove the file-URL import and the runtime's status mapping.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import { format } from 'node:util'

import {
  RESEARCH_HOST_SERVICE,
  apply,
  createResearchHostService,
  inject,
  name,
  VERSION,
} from '../research-host.js'

const HEALTH_PATH = '/aleph/api/research/health'
const REQUESTS_PATH = '/aleph/api/research/requests'
const PROGRAMS_PATH = '/aleph/api/research/programs'
const ATTENTION_PATH = '/aleph/api/research/attention'

const PROGRAM_BODY = {
  name: 'clifford research',
  goal: 'find a better probe',
  methodology: 'controlled experiments',
  contract: { ciEntry: 'run.sh', timeoutMs: 1000, requiredMetrics: ['score'] },
  utility: { metrics: [{ name: 'score', direction: 'higher', weight: 1 }] },
  exploration: 'normal',
  budget: { maxExperiments: 3, maxComputeMinutes: 30, maxTokens: 1000 },
}

/**
 * A fake Cordis context: routes are collected, effects are tracked and disposable,
 * `provide(name, value)` records the services the fiber publishes (with the same
 * disposable contract as Cordis), and `get(name)` resolves the optional services a test
 * provides. `getError` simulates a context whose lookup throws instead of returning
 * `undefined`.
 */
function fakeContext({ services = new Map(), getError } = {}) {
  const routes = []
  const cleanups = []
  const warnings = []
  const provided = new Map()
  const ctx = {
    webServer: {
      register(route, handler) {
        const registered = handler === undefined ? route : { ...route, handler }
        routes.push(registered)
        return () => {
          const index = routes.indexOf(registered)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    get(serviceName) {
      if (getError !== undefined) throw getError
      return services.get(serviceName)
    },
    provide(serviceName, value) {
      provided.set(serviceName, value)
      const dispose = () => {
        if (provided.get(serviceName) === value) provided.delete(serviceName)
      }
      // Cordis owns `provide` through the fiber effect; mirror that here so a harness
      // disposal releases the service exactly like the real loader does.
      cleanups.push(dispose)
      return dispose
    },
    logger: {
      info() {},
      warn(message, ...args) {
        warnings.push(format(message, ...args))
      },
    },
    effect(setup) {
      const cleanup = setup()
      cleanups.push(cleanup)
      return () => {
        const index = cleanups.indexOf(cleanup)
        if (index >= 0) cleanups.splice(index, 1)
      }
    },
  }
  return {
    ctx,
    routes,
    warnings,
    provided,
    find(kind, path) {
      return routes.find((route) => route.kind === kind && route.path === path)
    },
    async dispose() {
      while (cleanups.length > 0) {
        const cleanup = cleanups.pop()
        if (typeof cleanup === 'function') await cleanup()
      }
    },
  }
}

/** Invoke one collected route with a real async-iterable request and a recording response. */
async function invoke(route, { method = 'GET', url, body, rawBody } = {}) {
  const text = rawBody !== undefined ? rawBody : body === undefined ? '' : JSON.stringify(body)
  const req = Readable.from(text === '' ? [] : [Buffer.from(text)])
  req.method = method
  req.url = url ?? route.path
  const res = {
    statusCode: 0,
    headers: {},
    payload: '',
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value
    },
    end(chunk) {
      this.payload = typeof chunk === 'string' ? chunk : ''
    },
  }
  await route.handler(req, res)
  return {
    status: res.statusCode,
    headers: res.headers,
    body: res.payload === '' ? null : JSON.parse(res.payload),
  }
}

/** A host double for lifecycle/config tests; it never touches the compiled runtime. */
function fakeHost(overrides = {}) {
  const calls = { handleHttp: 0, snapshot: 0, attention: 0, dispose: 0 }
  const host = {
    async handleHttp() {
      calls.handleHttp += 1
      return { status: 204, body: null }
    },
    async snapshot() {
      calls.snapshot += 1
      return { ok: false, status: 404, error: { code: 'not-found', message: 'missing' }, audit: [] }
    },
    async attention() {
      calls.attention += 1
      return []
    },
    async dispose() {
      calls.dispose += 1
    },
    ...overrides,
  }
  return { host, calls }
}

/**
 * A minimal in-memory `DomainStore`: the exact port the compiled
 * `createStorageDomainUnitOfWork` expects (`list`, `get`, `put`, `delete`). Each row keeps
 * the version envelope the real DSH store persists, so the adapter's optimistic check and
 * hydration run unchanged. The maps live outside any host instance, so two hosts that
 * receive this store share one durable state.
 */
function fakeDomainStore() {
  const tables = new Map()

  const tableOf = (table) => {
    const existing = tables.get(table)
    if (existing !== undefined) return existing
    const created = new Map()
    tables.set(table, created)
    return created
  }

  const rowOf = (key, record) => ({
    key,
    value: structuredClone(record.value),
    version: record.version,
    etag: `etag-${record.version}`,
  })

  return {
    tables,
    async list(table) {
      return [...tableOf(table)].map(([key, record]) => rowOf(key, record))
    },
    async get(table, key) {
      const record = tableOf(table).get(key)
      return record === undefined ? undefined : rowOf(key, record)
    },
    async put(table, key, value, expected) {
      const rows = tableOf(table)
      const current = rows.get(key)
      const actual = current === undefined ? 0 : current.version
      if (actual !== expected) {
        return { ok: false, error: { kind: 'version-conflict', expected, actual } }
      }
      const version = actual + 1
      rows.set(key, { version, value: structuredClone(value) })
      return { ok: true, value: { version, etag: `etag-${version}` } }
    },
    async delete(table, key) {
      tableOf(table).delete(key)
      return { ok: true, value: undefined }
    },
  }
}

test('the plugin declares the host identity and registers five research routes', async () => {
  const harness = fakeContext()
  await apply(harness.ctx, {})

  assert.equal(name, 'aleph-research-host')
  assert.deepEqual(inject, ['webServer'])
  assert.equal(harness.routes.length, 5)
  assert.ok(harness.find('exact', HEALTH_PATH), 'health is an exact route')
  assert.ok(harness.find('exact', REQUESTS_PATH), 'requests is an exact route')
  assert.ok(harness.find('exact', PROGRAMS_PATH), 'program listing is an exact route')
  assert.ok(harness.find('prefix', PROGRAMS_PATH), 'one program is a prefix route')
  assert.ok(harness.find('prefix', ATTENTION_PATH), 'attention is a prefix route')

  await harness.dispose()
  assert.equal(harness.routes.length, 0, 'disposal releases every route')
})

test('health answers the version with a no-store JSON response', async () => {
  const harness = fakeContext()
  await apply(harness.ctx, {})

  const health = await invoke(harness.find('exact', HEALTH_PATH))
  assert.equal(health.status, 200)
  assert.deepEqual(health.body, { ok: true, version: VERSION, persistent: false })
  assert.equal(health.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(health.headers['cache-control'], 'no-store')

  const wrongMethod = await invoke(harness.find('exact', HEALTH_PATH), { method: 'POST' })
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.allow, 'GET')

  await harness.dispose()
})

test('POST requests creates a Program through the runtime and the reads see it', async () => {
  const harness = fakeContext()
  await apply(harness.ctx, {})

  const requests = harness.find('exact', REQUESTS_PATH)
  const created = await invoke(requests, {
    method: 'POST',
    body: { path: '/aleph/api/programs', body: PROGRAM_BODY },
  })
  assert.equal(created.status, 201)
  assert.equal(created.body.ok, true)
  assert.equal(created.headers['cache-control'], 'no-store')
  const programId = created.body.value.id
  assert.equal(typeof programId, 'string')

  const snapshotRoute = harness.find('prefix', PROGRAMS_PATH)
  const snapshot = await invoke(snapshotRoute, { url: `/aleph/api/research/programs/${programId}` })
  assert.equal(snapshot.status, 200)
  assert.equal(snapshot.body.ok, true)
  assert.equal(snapshot.body.value.program.id, programId)
  assert.equal(snapshot.body.value.program.status, 'running')
  assert.deepEqual(snapshot.body.value.audit.map((entry) => entry.action), ['program.created'])

  const listed = await invoke(harness.find('exact', PROGRAMS_PATH))
  assert.equal(listed.status, 200)
  assert.equal(listed.body.ok, true)
  assert.equal(listed.body.count, 1)
  assert.equal(listed.body.programs[0].id, programId)
  assert.equal(listed.body.programs[0].status, 'running')

  const attention = await invoke(harness.find('prefix', ATTENTION_PATH), {
    url: `/aleph/api/research/attention/${programId}`,
  })
  assert.equal(attention.status, 200)
  assert.equal(attention.body.ok, true)
  assert.equal(attention.body.programId, programId)
  assert.deepEqual(attention.body.attention, [])

  await harness.dispose()
})

test('the runtime response status is passed through for refused writes and reads', async () => {
  const harness = fakeContext()
  await apply(harness.ctx, {})
  const requests = harness.find('exact', REQUESTS_PATH)

  // A matched route for a missing Program: the runtime answers 404, not the transport.
  const missing = await invoke(requests, {
    method: 'POST',
    body: { path: '/aleph/api/programs/no-such-program/pause' },
  })
  assert.equal(missing.status, 404)
  assert.equal(missing.body.ok, false)

  // A parser refusal keeps its 400.
  const invalid = await invoke(requests, {
    method: 'POST',
    body: { path: '/aleph/api/programs', body: {} },
  })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.ok, false)

  // An unmatched runtime path is the boundary's own 404.
  const unknown = await invoke(requests, { method: 'POST', body: { path: '/aleph/api/unknown' } })
  assert.equal(unknown.status, 404)

  const missingSnapshot = await invoke(harness.find('prefix', PROGRAMS_PATH), {
    url: '/aleph/api/research/programs/no-such-program',
  })
  assert.equal(missingSnapshot.status, 404)
  assert.equal(missingSnapshot.body.ok, false)

  await harness.dispose()
})

test('the request route only admits the configured actor kinds', async () => {
  const harness = fakeContext()
  await apply(harness.ctx, {})
  const requests = harness.find('exact', REQUESTS_PATH)

  const denied = await invoke(requests, {
    method: 'POST',
    body: { path: '/aleph/api/programs', body: PROGRAM_BODY, actorKind: 'implementer' },
  })
  assert.equal(denied.status, 403)
  assert.equal(denied.body.ok, false)

  const malformed = await invoke(requests, { method: 'POST', rawBody: '{not json' })
  assert.equal(malformed.status, 400)

  const noPath = await invoke(requests, { method: 'POST', body: { body: PROGRAM_BODY } })
  assert.equal(noPath.status, 400)

  const wrongMethod = await invoke(requests, { method: 'GET' })
  assert.equal(wrongMethod.status, 405)

  await harness.dispose()
})

test('an injected host is used, its unsupported list route is 404, and cleanup disposes it', async () => {
  const { host, calls } = fakeHost()
  const harness = fakeContext()
  await apply(harness.ctx, { host })

  const listed = await invoke(harness.find('exact', PROGRAMS_PATH))
  assert.equal(listed.status, 404)
  assert.equal(listed.body.error.code, 'not-found')

  const created = await invoke(harness.find('exact', REQUESTS_PATH), {
    method: 'POST',
    body: { path: '/aleph/api/programs', body: PROGRAM_BODY },
  })
  assert.equal(created.status, 204)
  assert.equal(calls.handleHttp, 1)

  await harness.dispose()
  assert.equal(calls.dispose, 1)
  assert.equal(harness.routes.length, 0)
})

test('configured researcher actors can be selected explicitly', async () => {
  const { host, calls } = fakeHost()
  const harness = fakeContext()
  await apply(harness.ctx, { host, actorKinds: ['operator', 'researcher'] })

  const result = await invoke(harness.find('exact', REQUESTS_PATH), {
    method: 'POST',
    body: { path: '/aleph/api/programs', body: PROGRAM_BODY, actorKind: 'researcher' },
  })
  assert.equal(result.status, 204)
  assert.equal(calls.handleHttp, 1)

  await harness.dispose()
})

test('an unsupported configured actor kind fails startup instead of registering routes', async () => {
  const harness = fakeContext()
  await assert.rejects(apply(harness.ctx, { actorKinds: ['implementer'] }), /config\.actorKinds/)
  assert.equal(harness.routes.length, 0)
})

test('a missing alephResearchStore service falls back to memory with a warning', async () => {
  const harness = fakeContext()
  await apply(harness.ctx, {})

  const health = await invoke(harness.find('exact', HEALTH_PATH))
  assert.deepEqual(health.body, { ok: true, version: VERSION, persistent: false })
  assert.ok(
    harness.warnings.some((warning) => warning.includes('alephResearchStore')),
    `expected a persistence warning; got ${JSON.stringify(harness.warnings)}`,
  )

  const created = await invoke(harness.find('exact', REQUESTS_PATH), {
    method: 'POST',
    body: { path: '/aleph/api/programs', body: PROGRAM_BODY },
  })
  assert.equal(created.status, 201)
  const listed = await invoke(harness.find('exact', PROGRAMS_PATH))
  assert.equal(listed.body.count, 1)

  await harness.dispose()
})

test('a throwing service lookup falls back to memory without failing startup', async () => {
  const harness = fakeContext({ getError: new Error('service registry unavailable') })
  await apply(harness.ctx, {})

  assert.equal((await invoke(harness.find('exact', HEALTH_PATH))).body.persistent, false)
  assert.ok(
    harness.warnings.some((warning) => warning.includes('service registry unavailable')),
    `expected the lookup failure to be warned; got ${JSON.stringify(harness.warnings)}`,
  )
  assert.equal(harness.routes.length, 5)

  await harness.dispose()
})

test('an invalid alephResearchStore service falls back to memory with a warning', async () => {
  const services = new Map([['alephResearchStore', { list: async () => [] }]])
  const harness = fakeContext({ services })
  await apply(harness.ctx, {})

  const health = await invoke(harness.find('exact', HEALTH_PATH))
  assert.equal(health.body.persistent, false)
  assert.ok(
    harness.warnings.some((warning) => warning.includes('not a DomainStore')),
    `expected an invalid-store warning; got ${JSON.stringify(harness.warnings)}`,
  )

  const created = await invoke(harness.find('exact', REQUESTS_PATH), {
    method: 'POST',
    body: { path: '/aleph/api/programs', body: PROGRAM_BODY },
  })
  assert.equal(created.status, 201)
  assert.equal((await invoke(harness.find('exact', PROGRAMS_PATH))).body.count, 1)

  await harness.dispose()
})

test('a domain store service persists a Program across host instances', async () => {
  const store = fakeDomainStore()
  const services = new Map([['alephResearchStore', store]])

  const first = fakeContext({ services })
  await apply(first.ctx, {})
  assert.equal((await invoke(first.find('exact', HEALTH_PATH))).body.persistent, true)

  const created = await invoke(first.find('exact', REQUESTS_PATH), {
    method: 'POST',
    body: { path: '/aleph/api/programs', body: PROGRAM_BODY },
  })
  assert.equal(created.status, 201)
  const programId = created.body.value.id
  assert.equal(store.tables.get('programs')?.size, 1, 'the Program is written through the DomainStore')
  assert.equal(first.warnings.length, 0, 'a usable store needs no fallback warning')

  await first.dispose()

  // A second host over the same DomainStore represents a process restart: only the
  // persistent store can supply the Program created by the first instance.
  const second = fakeContext({ services })
  await apply(second.ctx, {})
  assert.equal((await invoke(second.find('exact', HEALTH_PATH))).body.persistent, true)

  const listed = await invoke(second.find('exact', PROGRAMS_PATH))
  assert.equal(listed.status, 200)
  assert.equal(listed.body.count, 1)
  assert.equal(listed.body.programs[0].id, programId)
  assert.equal(listed.body.programs[0].status, 'running')

  const snapshot = await invoke(second.find('prefix', PROGRAMS_PATH), {
    url: `/aleph/api/research/programs/${programId}`,
  })
  assert.equal(snapshot.status, 200)
  assert.equal(snapshot.body.value.program.id, programId)
  assert.deepEqual(snapshot.body.value.audit.map((entry) => entry.action), ['program.created'])

  const attention = await invoke(second.find('prefix', ATTENTION_PATH), {
    url: `/aleph/api/research/attention/${programId}`,
  })
  assert.equal(attention.status, 200)
  assert.deepEqual(attention.body.attention, [])

  await second.dispose()
})

test('config.domainStore composes the persistent store without the service', async () => {
  const store = fakeDomainStore()
  const harness = fakeContext()
  await apply(harness.ctx, { domainStore: store })

  assert.equal((await invoke(harness.find('exact', HEALTH_PATH))).body.persistent, true)

  const created = await invoke(harness.find('exact', REQUESTS_PATH), {
    method: 'POST',
    body: { path: '/aleph/api/programs', body: PROGRAM_BODY },
  })
  assert.equal(created.status, 201)
  assert.equal(store.tables.get('programs')?.size, 1)
  assert.equal((await invoke(harness.find('exact', PROGRAMS_PATH))).body.count, 1)

  await harness.dispose()
})

// ---------------------------------------------------------------------------
// The alephResearchHost service.
// ---------------------------------------------------------------------------

/** The runtime tool input for `operator_create_program`: the command literal plus body. */
const PROGRAM_TOOL_INPUT = { type: 'program.create', ...PROGRAM_BODY }

/** A valid ExperimentPlan for the researcher propose tool. */
const PLAN = {
  hypothesis: 'the probe helps',
  steps: ['measure the baseline', 'measure the probe'],
  expected: { direction: 'higher', rationale: 'the probe targets the gap' },
  environment: { kind: 'requirements', requirementsFile: 'requirements.txt', pythonVersion: '3.12' },
  inputs: [],
}

/** A host double that records every handleHttp call; reads answer conventions. */
function recordingHost() {
  const calls = []
  const host = {
    async handleHttp(request) {
      calls.push(request)
      return { status: 200, body: { ok: true, value: { path: request.path }, audit: [] } }
    },
    async snapshot(programId) {
      return { ok: false, status: 404, error: { code: 'not-found', message: `${programId} missing` }, audit: [] }
    },
    async attention() {
      return []
    },
  }
  return { host, calls }
}

/** Read the service `apply` provided. */
const serviceOf = (harness) => harness.provided.get(RESEARCH_HOST_SERVICE)

test('the plugin provides alephResearchHost with executeTool and a trigger port', async () => {
  const harness = fakeContext()
  await apply(harness.ctx, {})

  assert.ok(RESEARCH_HOST_SERVICE === 'alephResearchHost')
  const service = serviceOf(harness)
  assert.ok(service, `expected the ${RESEARCH_HOST_SERVICE} service`)
  assert.equal(typeof service.executeTool, 'function')
  assert.equal(typeof service.onTrigger, 'function')
  assert.equal(typeof service.setTriggerSink, 'function')
  assert.equal(typeof service.dispose, 'function')
  assert.equal(typeof service.triggerPort.receive, 'function')
  assert.deepEqual(service.triggerPort.recorded, [])

  await harness.dispose()
  assert.equal(harness.provided.size, 0, 'the provided service is released with the fiber')
  const disposed = await service.executeTool('researcher_read_program', { programId: 'program-1' })
  assert.equal(disposed.ok, false)
  assert.equal(disposed.error.code, 'conflict')
})

test('executeTool creates a Program through the compiled route table and records its trigger', async () => {
  const harness = fakeContext()
  await apply(harness.ctx, {})
  const service = serviceOf(harness)

  const created = await service.executeTool('operator_create_program', PROGRAM_TOOL_INPUT)
  assert.equal(created.ok, true)
  assert.equal(created.value.status, 'running')
  assert.equal(created.value.name, PROGRAM_BODY.name)
  assert.deepEqual(created.audit.map((entry) => entry.action), ['program.created'])
  assert.equal(created.audit[0].actor.kind, 'operator')

  // No sink registered: the port records the mapped report.
  const recorded = service.triggerPort.recorded
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].action, 'program.created')
  assert.equal(recorded[0].kind, 'program-created')
  assert.equal(recorded[0].draft.kind, 'program-created')
  assert.deepEqual(recorded[0].draft.threads[0], { kind: 'program', id: `research:${created.value.id}` })
  assert.equal(recorded[0].draft.actor.kind, 'operator')
  assert.equal(recorded[0].draft.meta.action, 'program.created')

  // The read tool returns the same read model the HTTP snapshot route serves.
  const snapshot = await service.executeTool('researcher_read_program', { programId: created.value.id })
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.value.program.id, created.value.id)
  assert.equal(snapshot.value.audit[0].action, 'program.created')

  // A descriptor from the DSH adapter (or a catalog id) resolves to the same runtime tool.
  const byDescriptor = await service.executeTool(
    { id: 'researcher.readProgram', runtimeName: 'researcher_read_program' },
    { programId: created.value.id },
  )
  assert.equal(byDescriptor.value.program.id, created.value.id)
  const byId = await service.executeTool('researcher.readProgram', { programId: created.value.id })
  assert.equal(byId.value.program.id, created.value.id)

  const missing = await service.executeTool('researcher_read_program', { programId: 'no-such-program' })
  assert.equal(missing.ok, false)
  assert.equal(missing.status, 404)
  assert.equal(missing.error.code, 'not-found')

  await harness.dispose()
})

test('executeTool maps the researcher command family and rejects invalid input before HTTP', async () => {
  const harness = fakeContext()
  await apply(harness.ctx, {})
  const service = serviceOf(harness)
  const received = []
  service.onTrigger((draft) => received.push(draft))

  const program = await service.executeTool('operator_create_program', PROGRAM_TOOL_INPUT)
  const programId = program.value.id

  const issue = await service.executeTool('aleph_research_operator_create_issue', {
    type: 'issue.create',
    programId,
    title: 'a question',
    body: 'what is the best probe?',
    labels: ['research'],
  })
  assert.equal(issue.ok, true)
  const issueId = issue.value.id

  const claim = await service.executeTool('researcher_claim_issue', {
    type: 'issue.claim', programId, issueId,
  })
  assert.equal(claim.ok, true)
  assert.equal(claim.value.status, 'assigned')
  assert.equal(claim.audit[0].actor.kind, 'researcher')

  const comment = await service.executeTool('researcher_comment_on_issue', {
    type: 'issue.comment', programId, issueId, body: 'a finding', kind: 'comment',
  })
  assert.equal(comment.ok, true)

  const proposed = await service.executeTool('researcher_propose_experiment', {
    type: 'experiment.propose', programId, issueId, plan: PLAN,
  })
  assert.equal(proposed.ok, true)
  assert.equal(proposed.value.status, 'open')
  const experimentId = proposed.value.id

  const review = await service.executeTool('researcher_review_experiment', {
    type: 'experiment.review', programId, experimentId, body: 'looks sound', verdict: 'approve',
  })
  assert.equal(review.ok, true)

  // Every accepted command above produced one draft, in order.
  assert.deepEqual(received.map((draft) => draft.kind), [
    'program-created', 'issue-created', 'issue-claimed', 'issue-commented', 'experiment-proposed', 'experiment-reviewed',
  ])
  assert.equal(received.at(-1).programId, programId)
  assert.equal(received.at(-1).meta.subjectId, experimentId)

  // The runtime Schema rejects a malformed id before the host boundary is reached; the
  // accepted calls above already proved the transport works, so a bad command cannot
  // have appended another draft.
  const before = received.length
  const invalid = await service.executeTool('researcher_claim_issue', {
    type: 'issue.claim', programId, issueId: '-not-an-id',
  })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.code, 'invalid-input')
  assert.match(invalid.error.message, /issueId must be an entity id string/)

  const extra = await service.executeTool('researcher_read_program', {
    programId, extra: true,
  })
  assert.equal(extra.ok, false)
  assert.equal(extra.error.code, 'invalid-input')

  const unknown = await service.executeTool('no_such_tool', {})
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'not-found')
  assert.equal(received.length, before)

  await harness.dispose()
})

test('executeTool fills the compiled ROUTE_TABLE path for every command family', async () => {
  const { host, calls } = recordingHost()
  const harness = fakeContext()
  await apply(harness.ctx, { host, ticketBinding: () => 'ticket-1' })
  const service = serviceOf(harness)

  const cases = [
    ['operator_pause_program', { type: 'program.pause', programId: 'program-1' }, '/aleph/api/programs/program-1/pause', 'operator'],
    ['operator_create_issue', { type: 'issue.create', programId: 'program-1', title: 't', body: 'b', labels: ['research'] }, '/aleph/api/programs/program-1/issues', 'operator'],
    ['researcher_claim_issue', { type: 'issue.claim', programId: 'program-1', issueId: 'issue-1' }, '/aleph/api/programs/program-1/issues/issue-1/claim', 'researcher'],
    ['researcher_comment_on_issue', { type: 'issue.comment', programId: 'program-1', issueId: 'issue-1', body: 'b', kind: 'comment' }, '/aleph/api/programs/program-1/issues/issue-1/comments', 'researcher'],
    ['researcher_close_issue', { type: 'issue.close', programId: 'program-1', issueId: 'issue-1', resolution: 'accepted', summary: 's' }, '/aleph/api/programs/program-1/issues/issue-1/close', 'researcher'],
    ['researcher_propose_experiment', { type: 'experiment.propose', programId: 'program-1', issueId: 'issue-1', plan: PLAN }, '/aleph/api/programs/program-1/issues/issue-1/experiments', 'researcher'],
    ['researcher_review_experiment', { type: 'experiment.review', programId: 'program-1', experimentId: 'experiment-1', body: 'b', verdict: 'approve' }, '/aleph/api/programs/program-1/experiments/experiment-1/reviews', 'researcher'],
    ['researcher_close_experiment', { type: 'experiment.close', programId: 'program-1', experimentId: 'experiment-1', reason: 'done' }, '/aleph/api/programs/program-1/experiments/experiment-1/close', 'researcher'],
    ['researcher_request_ci', { type: 'ci.request', programId: 'program-1', experimentId: 'experiment-1' }, '/aleph/api/programs/program-1/experiments/experiment-1/ci', 'researcher'],
  ]

  for (const [toolName, input, path, actorKind] of cases) {
    const result = await service.executeTool(toolName, input)
    assert.equal(result.ok, true, toolName)
    const call = calls.at(-1)
    assert.equal(call.method, 'POST', toolName)
    assert.equal(call.path, path, toolName)
    assert.equal(call.actor.kind, actorKind, toolName)
    assert.equal(call.body.type, input.type, toolName)
  }
  assert.equal(calls.length, cases.length)
  assert.equal(calls[0].actor.sessionId, 'aleph-host:operator')
  assert.equal(calls[2].actor.sessionId, 'aleph-host:researcher')

  // context.actorKind overrides the role-derived actor (the runtime gate still decides).
  const overridden = await service.executeTool('operator_pause_program', cases[0][1], { actorKind: 'watchdog' })
  assert.equal(overridden.ok, true)
  assert.equal(calls.at(-1).actor.kind, 'watchdog')

  const invalidActor = await service.executeTool('operator_pause_program', cases[0][1], { actorKind: 'nobody' })
  assert.equal(invalidActor.ok, false)
  assert.equal(invalidActor.error.code, 'forbidden')
  assert.equal(calls.length, cases.length + 1)

  await harness.dispose()
})

test('implementer submit needs a trusted ticket binding resolver', async () => {
  const submit = {
    type: 'ticket.submit',
    head: 'a'.repeat(40),
    environment: { kind: 'requirements', requirementsFile: 'requirements.txt', pythonVersion: '3.12' },
  }

  const deniedHost = recordingHost()
  const deniedHarness = fakeContext()
  await apply(deniedHarness.ctx, { host: deniedHost.host })
  const denied = await serviceOf(deniedHarness).executeTool('aleph_research_submit_implementation', submit)
  assert.equal(denied.ok, false)
  assert.equal(denied.error.code, 'forbidden')
  assert.match(denied.error.message, /ticket binding/)
  assert.equal(deniedHost.calls.length, 0, 'no HTTP request is sent without a binding')
  await deniedHarness.dispose()

  const allowedHost = recordingHost()
  const allowedHarness = fakeContext()
  await apply(allowedHarness.ctx, { host: allowedHost.host, ticketBinding: () => 'ticket-1' })
  const allowed = await serviceOf(allowedHarness).executeTool('implementer_submit_implementation', submit)
  assert.equal(allowed.ok, true)
  assert.equal(allowedHost.calls.length, 1)
  assert.equal(allowedHost.calls[0].path, '/aleph/api/tickets/submit')
  assert.deepEqual(allowedHost.calls[0].actor, {
    kind: 'implementer', ticketId: 'ticket-1', sessionId: 'aleph-host:implementer',
  })

  // A trusted context ticketId resolves the same way without a configured resolver.
  const contextHost = recordingHost()
  const contextHarness = fakeContext()
  await apply(contextHarness.ctx, { host: contextHost.host })
  const fromContext = await serviceOf(contextHarness).executeTool('implementer_submit_implementation', submit, {
    ticketId: 'ticket-2', sessionId: 'session-impl-2',
  })
  assert.equal(fromContext.ok, true)
  assert.deepEqual(contextHost.calls[0].actor, {
    kind: 'implementer', ticketId: 'ticket-2', sessionId: 'session-impl-2',
  })
  await contextHarness.dispose()
  await allowedHarness.dispose()
})

test('non-2xx responses and thrown host errors map to { ok: false, error } without throwing', async () => {
  const refusedHost = {
    async handleHttp() {
      return {
        status: 403,
        body: {
          ok: false,
          status: 403,
          error: { code: 'forbidden', message: 'the actor is not allowed' },
          audit: [],
        },
      }
    },
    async snapshot() {
      return { ok: false, status: 404, error: { code: 'not-found', message: 'missing' }, audit: [] }
    },
    async attention() {
      return []
    },
  }
  const refusedHarness = fakeContext()
  await apply(refusedHarness.ctx, { host: refusedHost })
  const refused = await serviceOf(refusedHarness).executeTool('operator_pause_program', {
    type: 'program.pause', programId: 'program-1',
  })
  assert.deepEqual(refused, {
    ok: false,
    status: 403,
    error: { code: 'forbidden', message: 'the actor is not allowed' },
  })
  await refusedHarness.dispose()

  const throwingHost = {
    async handleHttp() {
      throw new Error('the transport exploded')
    },
    async snapshot() {
      return { ok: false, status: 404, error: { code: 'not-found', message: 'missing' }, audit: [] }
    },
    async attention() {
      return []
    },
  }
  const throwingHarness = fakeContext()
  await apply(throwingHarness.ctx, { host: throwingHost })
  const thrown = await serviceOf(throwingHarness).executeTool('operator_pause_program', {
    type: 'program.pause', programId: 'program-1',
  })
  assert.equal(thrown.ok, false)
  assert.equal(thrown.error.code, 'internal')
  assert.ok(throwingHarness.warnings.some((warning) => warning.includes('executeTool')))
  await throwingHarness.dispose()
})

test('read tools serve metrics, experiments, stalled issues and attention from the host', async () => {
  const harness = fakeContext()
  await apply(harness.ctx, {})
  const service = serviceOf(harness)

  const program = await service.executeTool('operator_create_program', PROGRAM_TOOL_INPUT)
  const programId = program.value.id
  const issue = await service.executeTool('operator_create_issue', {
    type: 'issue.create', programId, title: 't', body: 'b', labels: ['blocked'],
  })
  const issueId = issue.value.id

  const metrics = await service.executeTool('researcher_read_metrics', { programId })
  assert.equal(metrics.ok, true)
  assert.deepEqual(metrics.value, { rows: [], summaries: [] })

  const watchdogMetrics = await service.executeTool('watchdog_read_metrics', { programId })
  assert.equal(watchdogMetrics.ok, true)
  assert.deepEqual(watchdogMetrics.value.rows, [])

  const missingExperiment = await service.executeTool('implementer_read_experiment', {
    experimentId: 'experiment-missing',
  })
  assert.equal(missingExperiment.ok, false)
  assert.equal(missingExperiment.status, 404)

  const noProgram = await service.executeTool('watchdog_list_stalled', {})
  assert.equal(noProgram.ok, false)
  assert.equal(noProgram.error.code, 'invalid-input')
  const stalled = await service.executeTool('watchdog_list_stalled', {}, { programId })
  assert.equal(stalled.ok, true)
  assert.deepEqual(stalled.value.map((entry) => entry.id), [issueId])

  const attention = await service.executeTool('watchdog_raise_attention', {
    reason: 'needs a look', subject: { kind: 'issue', id: issueId },
  })
  assert.equal(attention.ok, true)
  assert.equal(attention.value.subject.id, issueId)
  assert.equal(attention.value.severity, 'warning')
  const snapshot = await service.executeTool('researcher_read_program', { programId })
  assert.deepEqual(snapshot.value.attention.map((entry) => entry.id), [attention.value.id])

  const unknownSubject = await service.executeTool('watchdog_raise_attention', {
    reason: 'nowhere', subject: { kind: 'issue', id: 'issue-missing' },
  })
  assert.equal(unknownSubject.ok, false)
  assert.equal(unknownSubject.status, 404)

  await harness.dispose()
})

test('the trigger port records without a sink, forwards drafts to a sink, and skips refused reports', async () => {
  const harness = fakeContext()
  await apply(harness.ctx, {})
  const service = serviceOf(harness)

  const draft = {
    kind: 'issue-created',
    programId: 'program-1',
    threads: [{ kind: 'program', id: 'research:program-1' }],
    actor: { kind: 'operator', sessionId: 'aleph-host:operator' },
    human: true,
    at: '2026-01-01T00:00:00.000Z',
    text: 'issue created',
    meta: { action: 'issue.created', subjectKind: 'issue', subjectId: 'issue-1' },
  }
  const report = { action: 'issue.created', kind: 'issue-created', draft }

  const first = await service.triggerPort.receive(report)
  assert.deepEqual(first, { ok: true, value: undefined })
  assert.equal(service.triggerPort.recorded.length, 1)
  assert.equal(service.triggerPort.recorded[0], report)

  const seen = []
  const detach = service.onTrigger(async (receivedDraft, receivedReport) => {
    seen.push({ draft: receivedDraft, report: receivedReport })
  })
  assert.equal(typeof detach, 'function')
  await service.triggerPort.receive(report)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].draft, draft)
  assert.equal(seen[0].report, report)

  // A `command.refused` report carries no draft: it must not wake the bridge.
  await service.triggerPort.receive({ action: 'command.refused', kind: null, draft: null })
  assert.equal(seen.length, 1)

  // A throwing sink is a failed Result, not a thrown exception.
  service.setTriggerSink(() => {
    throw new Error('sink exploded')
  })
  const failed = await service.triggerPort.receive(report)
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'internal')
  assert.ok(harness.warnings.some((warning) => warning.includes('trigger sink')))

  detach()
  service.setTriggerSink(null)
  await service.triggerPort.receive(report)
  assert.equal(seen.length, 1)
  assert.equal(service.triggerPort.recorded.length, 2)

  await harness.dispose()
})

test('a refused command produces no wake-up even after a successful request', async () => {
  const harness = fakeContext()
  await apply(harness.ctx, {})
  const service = serviceOf(harness)
  const received = []
  service.onTrigger((draft) => received.push(draft))

  const program = await service.executeTool('operator_create_program', PROGRAM_TOOL_INPUT)
  const programId = program.value.id
  const issue = await service.executeTool('operator_create_issue', {
    type: 'issue.create', programId, title: 't', body: 'b', labels: ['research'],
  })
  received.length = 0

  // The Issue is unassigned, so the composition refuses the proposal as forbidden and
  // audits it as `command.refused`; the mapper returns `kind: null` and no draft.
  const refused = await service.executeTool('researcher_propose_experiment', {
    type: 'experiment.propose', programId, issueId: issue.value.id, plan: PLAN,
  })
  assert.equal(refused.ok, false)
  assert.equal(refused.status, 403)
  assert.equal(refused.error.code, 'forbidden')
  assert.equal(received.length, 0, 'a refusal must not wake the bridge')

  await harness.dispose()
})

test('dispose clears the trigger sink and stops tool execution', async () => {
  const harness = fakeContext()
  await apply(harness.ctx, {})
  const service = serviceOf(harness)
  const seen = []
  service.onTrigger((draft) => seen.push(draft))

  await service.executeTool('operator_create_program', PROGRAM_TOOL_INPUT)
  assert.equal(seen.length, 1)

  service.dispose()
  await service.triggerPort.receive({
    action: 'program.created',
    kind: 'program-created',
    draft: {
      kind: 'program-created',
      programId: 'program-1',
      threads: [{ kind: 'program', id: 'research:program-1' }],
      actor: { kind: 'operator', sessionId: 's' },
      human: true,
      at: '2026-01-01T00:00:00.000Z',
      text: 'program created',
      meta: {},
    },
  })
  assert.equal(seen.length, 1, 'a disposed service has no sink')

  const after = await service.executeTool('researcher_read_program', { programId: 'program-1' })
  assert.equal(after.ok, false)
  assert.equal(after.error.code, 'conflict')

  await harness.dispose()
})

test('createResearchHostService rejects a registry or route table it cannot read', () => {
  const { host } = recordingHost()
  assert.throws(
    () => createResearchHostService({ host, tools: {}, triggers: {}, api: {} }),
    /TOOL_REGISTRY/,
  )
  assert.throws(
    () => createResearchHostService({
      host,
      tools: { TOOL_REGISTRY: { operator: {}, researcher: {}, implementer: {}, watchdog: {} } },
      triggers: {},
      api: {},
    }),
    /ROUTE_TABLE/,
  )
})
