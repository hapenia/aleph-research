/**
 * Tests for the AlephResearch Session pool.
 *
 * The DSH Agent runtime is not composed here. A fake `sessionController` records
 * resolve/create calls and hands back fake Agents; a fake `workspaceRegistry` supplies
 * the current workspace; a fake Cordis context provides `effect`, `provide`, `get` and
 * `logger`. That is enough to pin the contract the real adapter relies on: the preset
 * and workspace passed to `create`, the deterministic ids, the exact `followup` payload,
 * dedupe/bounds, per-Session failure tolerance, and cleanup.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { format } from 'node:util'

import {
  apply,
  createResearchSessionPool,
  HOST_SERVICE_NAME,
  inject,
  name,
  OPERATOR_PRESET,
  RESEARCHER_PRESET,
  SERVICE_NAME,
} from '../research-sessions.js'

const hashOf = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12)

/** A fake DSH Agent with the two members this pool touches. */
function makeAgent(sessionId, preset, { followup } = {}) {
  const agent = {
    id: sessionId,
    status: 'idle',
    session: { header: { agentPreset: preset } },
    followups: [],
    followup(message) {
      if (followup !== undefined) followup(message)
      agent.followups.push(message)
    },
  }
  return agent
}

/** Fake `sessionController`: resolve from a Map, create with the requested preset. */
function fakeSessionController({ onCreate, presetOverrides = {} } = {}) {
  const agents = new Map()
  const calls = { create: [], resolve: [] }
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
      if (onCreate !== undefined) await onCreate(request)
      const preset = presetOverrides[request.sessionId] ?? request.agentPreset
      const agent = makeAgent(request.sessionId, preset)
      agents.set(request.sessionId, agent)
      return { sessionId: request.sessionId }
    },
  }
}

/** Fake `workspaceRegistry` with the three methods the pool may call. */
function fakeWorkspaceRegistry({ workspaces = [{ id: 'ws-1', path: '/research' }], create } = {}) {
  const calls = { create: [], get: [], list: 0 }
  const registry = {
    list() {
      calls.list += 1
      return [...workspaces]
    },
    get(id) {
      calls.get.push(id)
      return workspaces.find((workspace) => workspace.id === id)
    },
    async create(path) {
      calls.create.push(path)
      if (create !== undefined) return create(path)
      const workspace = { id: `created-${calls.create.length}`, path }
      workspaces.unshift(workspace)
      return workspace
    },
  }
  return { registry, calls, workspaces }
}

/** Fake Cordis context: service storage, effects and a warning recorder. */
function fakeContext({ controller, registry, services, getError } = {}) {
  const provided = new Map()
  const effects = []
  const warnings = []
  const ctx = {
    sessionController: controller,
    workspaceRegistry: registry,
    get(serviceName) {
      if (getError !== undefined) throw getError
      return services?.get(serviceName)
    },
    provide(serviceName, value) {
      provided.set(serviceName, value)
      return () => provided.delete(serviceName)
    },
    effect(setup) {
      const cleanup = setup()
      effects.push(cleanup)
      return () => {
        const index = effects.indexOf(cleanup)
        if (index >= 0) effects.splice(index, 1)
      }
    },
    logger: {
      info() {},
      warn(message, ...args) {
        warnings.push(format(message, ...args))
      },
    },
  }
  return {
    ctx,
    provided,
    effects,
    warnings,
    async disposeAll() {
      while (effects.length > 0) {
        const cleanup = effects.pop()
        if (typeof cleanup === 'function') await cleanup()
      }
    },
  }
}

/** One pool with its fakes, configured for the test at hand. */
function setup({
  controller: controllerOptions,
  workspaces: workspaceOptions,
  config,
  services,
  getError,
  skipPool = false,
} = {}) {
  const controller = fakeSessionController(controllerOptions)
  const workspace = fakeWorkspaceRegistry(workspaceOptions)
  const context = fakeContext({ controller, registry: workspace.registry, services, getError })
  const pool = skipPool ? undefined : createResearchSessionPool(context.ctx, config)
  return { controller, workspace, pool, ...context }
}

test('plugin metadata names the Loader row, service and presets', () => {
  assert.equal(name, 'aleph-research-sessions')
  assert.deepEqual(inject, ['sessionController', 'workspaceRegistry'])
  assert.equal(SERVICE_NAME, 'alephResearchSessions')
  assert.equal(HOST_SERVICE_NAME, 'alephResearchHost')
  assert.equal(OPERATOR_PRESET, 'aleph-operator')
  assert.equal(RESEARCHER_PRESET, 'aleph-researcher')
})

test('the pool requires the two host services and validates its config', () => {
  assert.throws(() => createResearchSessionPool({}), /sessionController/)
  assert.throws(() => createResearchSessionPool({ sessionController: {} }), /sessionController/)
  assert.throws(
    () => createResearchSessionPool({ sessionController: fakeSessionController() }),
    /workspaceRegistry/,
  )

  const { ctx } = fakeContext({
    controller: fakeSessionController(),
    registry: fakeWorkspaceRegistry().registry,
  })
  assert.throws(() => createResearchSessionPool(ctx, { poolSize: -1 }), /poolSize/)
  assert.throws(() => createResearchSessionPool(ctx, { poolSize: 1.5 }), /poolSize/)
  assert.throws(() => createResearchSessionPool(ctx, { poolSize: 999 }), /poolSize/)
  assert.throws(() => createResearchSessionPool(ctx, { workspaceId: '' }), /workspaceId/)
  assert.throws(() => createResearchSessionPool(ctx, { workspaceId: 7 }), /workspaceId/)
  assert.throws(() => createResearchSessionPool(ctx, { wakeTtlMs: 0 }), /wakeTtlMs/)
  assert.throws(() => createResearchSessionPool(ctx, { maxPendingWakesPerSession: 0 }), /maxPendingWakesPerSession/)
  assert.throws(() => createResearchSessionPool(ctx, { maxTrackedWakeSessions: -2 }), /maxTrackedWakeSessions/)
})

test('ensureOperatorSession creates one deterministic operator in the current workspace', async () => {
  const { controller, workspace, pool } = setup()
  const agent = await pool.ensureOperatorSession()

  const expectedId = `aleph-operator-${hashOf('ws-1')}`
  assert.equal(agent.id, expectedId)
  assert.deepEqual(controller.calls.create, [
    { sessionId: expectedId, workspaceId: 'ws-1', agentPreset: 'aleph-operator' },
  ])
  assert.equal(workspace.calls.list, 1)

  const again = await pool.ensureOperatorSession()
  assert.equal(again, agent)
  assert.equal(controller.calls.create.length, 1, 'a second ensure resolves instead of creating')
  assert.equal(pool.status().operatorSessionId, expectedId)
})

test('ensureOperatorSession is idempotent under concurrent callers', async () => {
  const { controller, pool } = setup()
  const [first, second] = await Promise.all([pool.ensureOperatorSession(), pool.ensureOperatorSession()])
  assert.equal(first, second)
  assert.equal(controller.calls.create.length, 1)
})

test('the operator id follows the configured workspace, not the registry order', async () => {
  const { controller, workspace, pool } = setup({
    workspaces: { workspaces: [{ id: 'ws-new', path: '/new' }, { id: 'ws-old', path: '/old' }] },
    config: { workspaceId: 'ws-old' },
  })
  const agent = await pool.ensureOperatorSession()
  assert.equal(agent.id, `aleph-operator-${hashOf('ws-old')}`)
  assert.deepEqual(workspace.calls.get, ['ws-old'])
  assert.equal(workspace.calls.create.length, 0)
  assert.deepEqual(controller.calls.create[0], {
    sessionId: `aleph-operator-${hashOf('ws-old')}`,
    workspaceId: 'ws-old',
    agentPreset: 'aleph-operator',
  })
})

test('an unknown configured workspace fails instead of creating a Session elsewhere', async () => {
  const { pool } = setup({ config: { workspaceId: 'missing' } })
  await assert.rejects(pool.ensureOperatorSession(), /workspace 'missing' is not registered/)
})

test('an empty workspace registry gets one created for the pool cwd', async () => {
  const { controller, workspace, pool } = setup({
    workspaces: { workspaces: [] },
    config: { cwd: '/tmp/aleph-pool-root' },
  })
  const agent = await pool.ensureOperatorSession()
  assert.deepEqual(workspace.calls.create, ['/tmp/aleph-pool-root'])
  assert.equal(agent.id, `aleph-operator-${hashOf('created-1')}`)
  assert.equal(pool.status().workspaceId, 'created-1')
  assert.deepEqual(controller.calls.create[0], {
    sessionId: `aleph-operator-${hashOf('created-1')}`,
    workspaceId: 'created-1',
    agentPreset: 'aleph-operator',
  })
})

test('ensureResearcherSession validates ids and creates with the researcher preset', async () => {
  const { controller, pool } = setup()
  const agent = await pool.ensureResearcherSession('aleph-researcher-1')
  assert.equal(agent.id, 'aleph-researcher-1')
  assert.deepEqual(controller.calls.create[0], {
    sessionId: 'aleph-researcher-1',
    workspaceId: 'ws-1',
    agentPreset: 'aleph-researcher',
  })

  const again = await pool.ensureResearcherSession('aleph-researcher-1')
  assert.equal(again, agent)
  assert.equal(controller.calls.create.length, 1)

  for (const invalid of ['', 'has space', '../escape', 'sla/sh', 42, null, undefined]) {
    await assert.rejects(
      pool.ensureResearcherSession(invalid),
      /sessionId must be 1-128 characters/,
      `expected ${String(invalid)} to be refused`,
    )
  }
})

test('an existing Session with another preset is refused, not silently reused', async () => {
  const { controller, pool } = setup()
  controller.agents.set('aleph-researcher-9', makeAgent('aleph-researcher-9', 'standard'))
  await assert.rejects(pool.ensureResearcherSession('aleph-researcher-9'), /runs preset 'standard'/)
  assert.equal(controller.calls.create.length, 0)
})

test('an existing researcher Session resolves even when the workspace registry fails', async () => {
  const { controller, workspace, pool } = setup()
  controller.agents.set('aleph-researcher-1', makeAgent('aleph-researcher-1', 'aleph-researcher'))
  workspace.registry.list = () => {
    throw new Error('registry offline')
  }
  const agent = await pool.ensureResearcherSession('aleph-researcher-1')
  assert.equal(agent.id, 'aleph-researcher-1')
  assert.equal(controller.calls.create.length, 0)
})

test('a non-not-found resolve failure and a create failure both surface', async () => {
  const { controller, pool } = setup()
  const original = controller.resolveAgent
  controller.resolveAgent = async () => ({ error: { code: 'session/boom', message: 'boom' } })
  await assert.rejects(pool.ensureResearcherSession('aleph-researcher-1'), /boom/)
  controller.resolveAgent = original

  const failing = setup({
    controller: {
      onCreate: async (request) => {
        throw new Error(`cannot create ${request.sessionId}`)
      },
    },
  })
  await assert.rejects(failing.pool.ensureResearcherSession('aleph-researcher-2'), /cannot create/)
})

test('wakeResearcher ensures the Session and sends the documented followup payload', async () => {
  const { controller, pool } = setup()
  const result = await pool.wakeResearcher('aleph-researcher-1', 'triage issue 3')
  assert.deepEqual(result, { ok: true, sessionId: 'aleph-researcher-1', deduped: false })

  const agent = controller.agents.get('aleph-researcher-1')
  assert.equal(agent.followups.length, 1)
  const [message] = agent.followups
  assert.match(message.id, /^aleph-research:[0-9a-f-]{36}$/)
  assert.deepEqual({ ...message, id: undefined }, {
    id: undefined,
    role: 'user',
    content: [{ type: 'text', text: 'triage issue 3' }],
    source: { kind: 'aleph-research' },
  })
  assert.equal(pool.status().pendingWakes, 1)
})

test('wakeResearcher deduplicates identical pending messages and honours the TTL', async () => {
  let now = 1_000
  const { controller, pool } = setup({ config: { now: () => now, wakeTtlMs: 500 } })
  const first = await pool.wakeResearcher('aleph-researcher-1', 'same message')
  assert.equal(first.deduped, false)
  const duplicate = await pool.wakeResearcher('aleph-researcher-1', 'same message')
  assert.deepEqual(duplicate, { ok: true, sessionId: 'aleph-researcher-1', deduped: true })
  assert.equal(controller.agents.get('aleph-researcher-1').followups.length, 1)

  const different = await pool.wakeResearcher('aleph-researcher-1', 'another message')
  assert.equal(different.deduped, false)

  now += 501
  const afterExpiry = await pool.wakeResearcher('aleph-researcher-1', 'same message')
  assert.equal(afterExpiry.deduped, false, 'an expired dedupe entry must not suppress a real wake')
  assert.equal(controller.agents.get('aleph-researcher-1').followups.length, 3)
})

test('wakeResearcher bounds pending messages per Session and tracked Sessions', async () => {
  const { controller, pool } = setup({
    config: { wakeTtlMs: 60_000, maxPendingWakesPerSession: 2, maxTrackedWakeSessions: 1 },
  })
  assert.equal((await pool.wakeResearcher('aleph-researcher-1', 'one')).ok, true)
  assert.equal((await pool.wakeResearcher('aleph-researcher-1', 'two')).ok, true)
  const refused = await pool.wakeResearcher('aleph-researcher-1', 'three')
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'wake-limit')

  // A second Session's bookkeeping evicts the first Session's dedupe map, so a repeat
  // of its old message is a real wake again rather than a false duplicate.
  assert.equal((await pool.wakeResearcher('aleph-researcher-2', 'one')).ok, true)
  const repeated = await pool.wakeResearcher('aleph-researcher-1', 'one')
  assert.equal(repeated.ok, true)
  assert.equal(repeated.deduped, false)
  assert.equal(controller.agents.get('aleph-researcher-1').followups.length, 3)
})

test('wakeResearcher reports failures instead of throwing', async () => {
  const failing = setup({
    controller: {
      onCreate: async () => {
        throw new Error('session unavailable')
      },
    },
  })
  const failed = await failing.pool.wakeResearcher('aleph-researcher-1', 'wake')
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'session-failed')
  assert.match(failed.error, /session unavailable/)
  assert.match(failing.pool.status().lastError, /session unavailable/)

  const followupFails = setup()
  followupFails.controller.agents.set('aleph-researcher-1', makeAgent('aleph-researcher-1', 'aleph-researcher', {
    followup: () => {
      throw new Error('inbox closed')
    },
  }))
  const refused = await followupFails.pool.wakeResearcher('aleph-researcher-1', 'wake')
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'followup-failed')
  assert.match(refused.error, /inbox closed/)

  const invalid = await followupFails.pool.wakeResearcher('bad id', 'wake')
  assert.equal(invalid.code, 'invalid-session-id')
  const empty = await followupFails.pool.wakeResearcher('aleph-researcher-1', '   ')
  assert.equal(empty.code, 'invalid-message')
})

test('ensurePool creates the deterministic slots, is idempotent and never throws per Session', async () => {
  const { controller, pool } = setup()
  assert.deepEqual(await pool.ensurePool(3), [
    'aleph-researcher-1',
    'aleph-researcher-2',
    'aleph-researcher-3',
  ])
  assert.deepEqual(
    controller.calls.create.map((request) => request.sessionId),
    ['aleph-researcher-1', 'aleph-researcher-2', 'aleph-researcher-3'],
  )
  assert.ok(controller.calls.create.every((request) => request.agentPreset === 'aleph-researcher'))
  assert.ok(controller.calls.create.every((request) => request.workspaceId === 'ws-1'))

  await pool.ensurePool(3)
  assert.equal(controller.calls.create.length, 3, 'a repeated ensurePool resolves the existing Sessions')

  assert.deepEqual(await pool.ensurePool(0), [])
  await assert.rejects(pool.ensurePool(-1), /ensurePool\(size\)/)
  await assert.rejects(pool.ensurePool(1.5), /ensurePool\(size\)/)
  await assert.rejects(pool.ensurePool('3'), /ensurePool\(size\)/)
})

test('ensurePool keeps going when one Session cannot be created', async () => {
  const { controller, pool } = setup({
    controller: {
      onCreate: async (request) => {
        if (request.sessionId === 'aleph-researcher-2') throw new Error('slot two is broken')
      },
    },
  })
  const ids = await pool.ensurePool(3)
  assert.deepEqual(ids, ['aleph-researcher-1', 'aleph-researcher-3'])
  assert.equal(controller.calls.create.length, 3)
  assert.match(pool.status().lastError, /slot two is broken/)
  assert.equal(pool.status().failures.length, 1)
})

test('concurrent ensurePool calls create each slot once', async () => {
  const { controller, pool } = setup()
  const [first, second] = await Promise.all([pool.ensurePool(2), pool.ensurePool(2)])
  assert.deepEqual(first, ['aleph-researcher-1', 'aleph-researcher-2'])
  assert.deepEqual(second, first)
  assert.equal(controller.calls.create.length, 2)
})

test('dispose clears state, is idempotent and makes the pool inert', async () => {
  const { controller, pool } = setup()
  await pool.wakeResearcher('aleph-researcher-1', 'pending')
  assert.equal(pool.status().pendingWakes, 1)

  pool.dispose()
  pool.dispose()
  assert.equal(pool.disposed, true)
  assert.equal(pool.status().disposed, true)
  assert.equal(pool.status().pendingWakes, 0)
  assert.deepEqual(pool.status().researcherSessionIds, [])
  assert.equal(pool.status().failures.length, 0)

  assert.deepEqual(await pool.ensurePool(2), [])
  assert.deepEqual(await pool.wakeResearcher('aleph-researcher-1', 'after'), {
    ok: false,
    sessionId: 'aleph-researcher-1',
    code: 'disposed',
    error: 'the pool was disposed',
  })
  await assert.rejects(pool.ensureOperatorSession(), /dispose/)
  assert.equal(controller.calls.create.length, 1, 'dispose itself creates nothing')
})

test('apply publishes the service, applies poolSize and tolerates an absent host', async () => {
  const context = setup({ skipPool: true })
  await apply(context.ctx, { poolSize: 2 })
  const service = context.provided.get(SERVICE_NAME)
  assert.equal(service.name, name)
  assert.equal(service.status().hostAttached, false)
  assert.deepEqual(service.status().researcherSessionIds, ['aleph-researcher-1', 'aleph-researcher-2'])
  assert.equal(context.controller.calls.create.length, 2)

  // The fiber effect owns disposal.
  await context.disposeAll()
  assert.equal(service.disposed, true)
})

test('apply reads the optional research host when present and survives a throwing lookup', async () => {
  const host = { version: 'research-host/1' }
  const present = setup({ skipPool: true, services: new Map([[HOST_SERVICE_NAME, host]]) })
  await apply(present.ctx, {})
  assert.equal(present.provided.get(SERVICE_NAME).status().hostAttached, true)

  const throwing = setup({ skipPool: true, getError: new Error('service registry unavailable') })
  await apply(throwing.ctx, {})
  assert.equal(throwing.provided.get(SERVICE_NAME).status().hostAttached, false)
})

test('apply rejects malformed config but does not create the default pool', async () => {
  const context = setup({ skipPool: true })
  await assert.rejects(apply(context.ctx, { poolSize: -1 }), /poolSize/)
  await assert.rejects(apply(context.ctx, { workspaceId: '' }), /workspaceId/)

  const empty = setup({ skipPool: true })
  await apply(empty.ctx, {})
  assert.equal(empty.controller.calls.create.length, 0)
  assert.equal(empty.provided.get(SERVICE_NAME).status().configuredPoolSize, 0)
})
