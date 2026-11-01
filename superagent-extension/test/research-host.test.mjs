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

import { apply, inject, name, VERSION } from '../research-host.js'

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
 * A fake Cordis context: routes are collected, effects are tracked and disposable, and
 * `get(name)` resolves the optional services a test provides. `getError` simulates a
 * context whose lookup throws instead of returning `undefined`.
 */
function fakeContext({ services = new Map(), getError } = {}) {
  const routes = []
  const cleanups = []
  const warnings = []
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
