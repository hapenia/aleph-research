/**
 * Tests for the DSH tool-registration adapter.
 *
 * No DSH runtime is composed: a fake `ctx.tools` collects the definitions (and their
 * `when` predicates) and a fake `ctx.effect` records cleanup, so these tests exercise
 * exactly the adapter contract a real registry sees. The tool registry itself is the
 * real compiled `research-core/dist/runtime/tools.js`, so the mapping, schema conversion
 * and runtime argument validation are the production ones.
 *
 * `JSON.parse` is allowed in tests; the adapter itself is linted against it.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { assertSupportedJsonSchema, projectToolSchema } from '@deepseek-ai/dsh-tools'
import { TOOL_REGISTRY } from '../../research-core/dist/runtime/tools.js'

import {
  DEFAULT_PREFIX,
  HOST_SERVICE_NAME,
  PRESET_ROLES,
  TOOL_ROLES,
  VERSION,
  apply,
  buildResearchToolCatalog,
  inject,
  name,
  registerResearchTools,
  roleFromPreset,
  toDshParameterSchema,
} from '../research-tools.js'

/** Every keyword the DSH tool-parameter subset supports. */
const DSH_SCHEMA_KEYS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples',
])

/** Yield every schema node in a converted parameter tree. */
function* schemaNodes(node) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return
  yield node
  if (node.properties !== undefined) {
    for (const value of Object.values(node.properties)) yield* schemaNodes(value)
  }
  if (node.items !== undefined) yield* schemaNodes(node.items)
  if (Array.isArray(node.oneOf)) {
    for (const value of node.oneOf) yield* schemaNodes(value)
  }
}

/** A fake Cordis context: registrations are collected and effects are tracked. */
function fakeContext({ failOn, services = new Map() } = {}) {
  const registrations = new Map()
  const effects = []
  const listeners = new Map()
  const ctx = {
    tools: {
      register(definition, options = {}) {
        if (definition.name === failOn) throw new Error(`injected failure for ${definition.name}`)
        if (registrations.has(definition.name)) {
          throw new Error(`tool "${definition.name}" is already registered in this scope`)
        }
        const registration = { definition, when: options.when }
        registrations.set(definition.name, registration)
        return () => {
          registrations.delete(definition.name)
        }
      },
    },
    get(serviceName) {
      return services.get(serviceName)
    },
    on(event, callback) {
      const set = listeners.get(event) ?? new Set()
      set.add(callback)
      listeners.set(event, set)
      return () => {
        set.delete(callback)
      }
    },
    effect(setup, label) {
      const cleanup = setup()
      effects.push({ cleanup, label })
      return () => {
        const index = effects.findIndex((entry) => entry.cleanup === cleanup)
        if (index < 0) return
        effects.splice(index, 1)
        if (typeof cleanup === 'function') cleanup()
      }
    },
  }
  return {
    ctx,
    registrations,
    effects,
    listeners,
    services,
    registration(toolName) {
      return registrations.get(toolName)
    },
    definition(toolName) {
      return registrations.get(toolName)?.definition
    },
    emit(event, ...args) {
      for (const callback of listeners.get(event) ?? []) callback(...args)
    },
    dispose() {
      while (effects.length > 0) {
        const entry = effects.pop()
        if (typeof entry.cleanup === 'function') entry.cleanup()
      }
    },
  }
}

/** An agent double with the session header the adapter reads. */
const agentFor = (preset) => ({ session: { header: { agentPreset: preset } } })

/** The 23 DSH names the default registration must produce, in role order. */
const EXPECTED_NAMES = [
  'aleph_research_create_program',
  'aleph_research_pause_program',
  'aleph_research_resume_program',
  'aleph_research_stop_program',
  'aleph_research_set_goal',
  'aleph_research_set_methodology',
  'aleph_research_set_exploration',
  'aleph_research_operator_create_issue',
  'aleph_research_read_program',
  'aleph_research_researcher_read_metrics',
  'aleph_research_researcher_create_issue',
  'aleph_research_claim_issue',
  'aleph_research_comment_on_issue',
  'aleph_research_propose_experiment',
  'aleph_research_review_experiment',
  'aleph_research_request_ci',
  'aleph_research_close_issue',
  'aleph_research_close_experiment',
  'aleph_research_submit_implementation',
  'aleph_research_read_experiment',
  'aleph_research_list_stalled',
  'aleph_research_raise_attention',
  'aleph_research_watchdog_read_metrics',
]

test('registers all 23 runtime tools with aleph_research_ names', () => {
  const harness = fakeContext()
  const adapter = registerResearchTools(harness.ctx)

  assert.equal(adapter.version, VERSION)
  assert.equal(harness.registrations.size, 23)
  assert.equal(adapter.tools.length, 23)
  assert.deepEqual([...harness.registrations.keys()], EXPECTED_NAMES)
  assert.equal(new Set(adapter.tools).size, 23)
  for (const toolName of adapter.tools) assert.ok(toolName.startsWith(DEFAULT_PREFIX), toolName)

  const runtimeNames = new Set()
  let runtimeCount = 0
  for (const role of TOOL_ROLES) {
    for (const tool of Object.values(TOOL_REGISTRY[role])) {
      runtimeNames.add(tool.name)
      runtimeCount += 1
    }
  }
  assert.equal(runtimeCount, 23)
  assert.equal(adapter.catalog.length, runtimeCount)
  assert.deepEqual(new Set(adapter.catalog.map((entry) => entry.runtimeName)), runtimeNames)
  const byName = new Map(adapter.catalog.map((entry) => [entry.name, entry]))
  for (const [toolName, registration] of harness.registrations) {
    assert.equal(registration.definition.parameters, byName.get(toolName).parameters)
    assert.doesNotThrow(() => assertSupportedJsonSchema(registration.definition.parameters))
    assert.deepEqual(registration.definition.output.schema, {})
    assert.equal(typeof registration.definition.output.render, 'function')
    assert.equal(typeof registration.definition.execute, 'function')

    // The model-facing projection DSH's native executor uses must preserve the schema.
    const projected = projectToolSchema(registration.definition, true)
    assert.equal(projected.name, toolName)
    assert.equal(projected.description, registration.definition.description)
    assert.deepEqual(projected.parameters, registration.definition.parameters)
  }
})

test('every converted parameter schema is accepted by the DSH subset', () => {
  const catalog = buildResearchToolCatalog()
  assert.equal(catalog.length, 23)

  for (const entry of catalog) {
    const schema = entry.parameters
    assert.equal(schema.type, 'object', entry.id)
    assert.ok(Object.keys(schema).length > 0, entry.id)
    assert.equal(schema.additionalProperties, false, entry.id)
    assert.ok(Array.isArray(schema.required), entry.id)
    assert.doesNotThrow(() => assertSupportedJsonSchema(schema), entry.id)

    const serialized = JSON.stringify(schema)
    for (const dropped of ['"pattern"', '"minLength"', '"maxLength"', '"minItems"', '"exclusiveMinimum"']) {
      assert.equal(serialized.includes(dropped), false, `${entry.id} should drop ${dropped}`)
    }

    for (const node of schemaNodes(schema)) {
      for (const key of Object.keys(node)) {
        assert.ok(DSH_SCHEMA_KEYS.has(key), `${entry.id} uses unsupported keyword ${key}`)
      }
      if (Object.hasOwn(node, 'const') || Object.hasOwn(node, 'enum')) {
        assert.equal(typeof node.type, 'string', `${entry.id} const/enum node needs a type`)
      }
    }
  }

  const submit = catalog.find((entry) => entry.id === 'implementer.submitImplementation')
  assert.deepEqual(submit.parameters.required, ['type', 'head', 'environment'])
  assert.equal(submit.parameters.properties.environment.oneOf.length, 2)
  assert.deepEqual(submit.parameters.properties.type, { type: 'string', const: 'ticket.submit' })

  const issue = catalog.find((entry) => entry.id === 'researcher.createIssue')
  assert.deepEqual(issue.parameters.properties.labels.items, {
    type: 'string',
    enum: ['research', 'experiment', 'analysis', 'bug', 'blocked'],
  })
})

test('toDshParameterSchema rejects schema shapes DSH cannot enforce', () => {
  assert.throws(() => toDshParameterSchema({ type: 'string' }), /object-rooted/)
  assert.throws(
    () => toDshParameterSchema({ type: 'object', properties: { id: { type: ['string', 'null'] } } }),
    /type arrays/,
  )
  assert.throws(
    () => toDshParameterSchema({ type: 'object', properties: { id: { type: 'string', allOf: [] } } }),
    /allOf is not supported/,
  )
  assert.throws(
    () => toDshParameterSchema({ type: 'object', properties: { id: { enum: ['a', 1] } } }),
    /share one scalar type/,
  )
})

test('execute validates with the runtime schema and calls the injected handler', async () => {
  const harness = fakeContext()
  const calls = []
  const agent = agentFor('aleph-researcher')
  const signal = new AbortController().signal
  const adapter = registerResearchTools(harness.ctx, {
    handlers: {
      'researcher.readProgram': async (input, context) => {
        calls.push({ input, context })
        return { ok: true, value: { id: input.programId } }
      },
    },
  })

  const definition = harness.definition('aleph_research_read_program')
  const result = await definition.execute({ programId: 'program-1' }, { agent, signal })

  assert.deepEqual(result, { ok: true, value: { id: 'program-1' } })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].input, { programId: 'program-1' })
  assert.equal(calls[0].context.tool.id, 'researcher.readProgram')
  assert.equal(calls[0].context.tool.name, 'aleph_research_read_program')
  assert.equal(calls[0].context.tool.role, 'researcher')
  assert.equal(calls[0].context.agent, agent)
  assert.equal(calls[0].context.signal, signal)
  assert.equal(calls[0].context.exec.signal, signal)

  // pattern/minLength are absent from the wire schema but still enforced by parse.
  await assert.rejects(definition.execute({ programId: '-not-an-id' }, { agent }), (error) => {
    assert.equal(error.name, 'ToolArgsError')
    assert.equal(error.code, 'INVALID_ARGS')
    assert.match(error.message, /programId must be an entity id string/)
    return true
  })
  assert.equal(calls.length, 1)
  adapter.dispose()
})

test('handler maps accept the runtime name and a single handler function', async () => {
  const byRuntimeName = fakeContext()
  const seen = []
  registerResearchTools(byRuntimeName.ctx, {
    handlers: {
      researcher_read_program: (input) => {
        seen.push(input)
        return { ok: true }
      },
    },
  })
  await byRuntimeName.definition('aleph_research_read_program').execute(
    { programId: 'program-1' },
    { agent: agentFor('aleph-researcher') },
  )
  assert.deepEqual(seen, [{ programId: 'program-1' }])

  const byFunction = fakeContext()
  const contexts = []
  registerResearchTools(byFunction.ctx, {
    handlers: (input, context) => {
      contexts.push({ input, context })
      return { ok: true }
    },
  })
  await byFunction.definition('aleph_research_claim_issue').execute(
    { type: 'issue.claim', programId: 'program-1', issueId: 'issue-1' },
    { agent: agentFor('aleph-researcher') },
  )
  assert.equal(contexts.length, 1)
  assert.equal(contexts[0].context.tool.id, 'researcher.claimIssue')
})

test('a host adapter exposes executeTool(tool, input, context)', async () => {
  const harness = fakeContext()
  const calls = []
  const host = {
    async executeTool(tool, input, context) {
      calls.push({ tool, input, context })
      return { tool: tool.id, value: input.programId }
    },
  }
  const adapter = registerResearchTools(harness.ctx, { host })
  const result = await harness.definition('aleph_research_read_program').execute(
    { programId: 'program-2' },
    { agent: agentFor('aleph-researcher') },
  )

  assert.deepEqual(result, { tool: 'researcher.readProgram', value: 'program-2' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].tool.name, 'aleph_research_read_program')
  assert.deepEqual(calls[0].input, { programId: 'program-2' })
  assert.equal(calls[0].context.tool.id, 'researcher.readProgram')
  adapter.dispose()
})

test('execute fails clearly when no handler was injected', async () => {
  const harness = fakeContext()
  registerResearchTools(harness.ctx)
  const definition = harness.definition('aleph_research_claim_issue')

  await assert.rejects(
    definition.execute(
      { type: 'issue.claim', programId: 'program-1', issueId: 'issue-1' },
      { agent: agentFor('aleph-researcher') },
    ),
    /has no injected handler/,
  )
})

test('implementer submit exposes and accepts no binding or ticketId', async () => {
  const harness = fakeContext()
  const calls = []
  const agent = agentFor('aleph-implementer')
  const adapter = registerResearchTools(harness.ctx, {
    handlers: {
      'implementer.submitImplementation': async (input) => {
        calls.push(input)
        return { ok: true, value: input.head }
      },
    },
  })

  const definition = harness.definition('aleph_research_submit_implementation')
  const schema = definition.parameters
  assert.equal(Object.hasOwn(schema.properties, 'binding'), false)
  assert.equal(Object.hasOwn(schema.properties, 'ticketId'), false)
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.required, ['type', 'head', 'environment'])

  const valid = {
    type: 'ticket.submit',
    head: 'a'.repeat(40),
    environment: { kind: 'requirements', requirementsFile: 'requirements.txt', pythonVersion: '3.12' },
  }
  assert.deepEqual(await definition.execute(valid, { agent }), { ok: true, value: valid.head })
  assert.equal(calls.length, 1)

  await assert.rejects(
    definition.execute({ ...valid, binding: { ticketId: 'ticket-1' } }, { agent }),
    /does not accept the field binding/,
  )
  await assert.rejects(
    definition.execute({ ...valid, ticketId: 'ticket-1' }, { agent }),
    /does not accept the field ticketId/,
  )
  assert.equal(calls.length, 1)
  adapter.dispose()
})

test('ctx.effect cleanup removes every registered tool', () => {
  const harness = fakeContext()
  const adapter = registerResearchTools(harness.ctx)
  assert.equal(harness.registrations.size, 23)
  assert.equal(harness.effects.length, 1)

  harness.dispose()
  assert.equal(harness.registrations.size, 0)
  assert.equal(harness.effects.length, 0)

  // Disposing the adapter directly, and again after the fiber, is idempotent.
  adapter.dispose()
  assert.equal(harness.registrations.size, 0)

  const direct = fakeContext()
  const directAdapter = registerResearchTools(direct.ctx)
  directAdapter.dispose()
  assert.equal(direct.registrations.size, 0)
  assert.equal(direct.effects.length, 0)
})

test('duplicate registration is rejected without disturbing the first adapter', () => {
  const harness = fakeContext()
  const first = registerResearchTools(harness.ctx)
  assert.equal(harness.registrations.size, 23)

  assert.throws(() => registerResearchTools(harness.ctx), /already registered/)
  assert.equal(harness.registrations.size, 23)

  first.dispose()
  assert.equal(harness.registrations.size, 0)
})

test('a failure part-way through registration releases the tools already registered', () => {
  const harness = fakeContext({ failOn: 'aleph_research_claim_issue' })

  assert.throws(() => registerResearchTools(harness.ctx), /injected failure/)
  assert.equal(harness.registrations.size, 0)
  assert.equal(harness.effects.length, 0)
})

test('role gating hides each role from the other sessions', () => {
  const harness = fakeContext()
  const adapter = registerResearchTools(harness.ctx)
  const when = (toolName) => harness.registration(toolName).when

  const researcher = agentFor('aleph-researcher')
  const operator = agentFor('aleph-operator')
  const implementer = agentFor('aleph-implementer')
  const watchdog = agentFor('aleph-watchdog')

  assert.equal(when('aleph_research_claim_issue')({ agent: researcher }), true)
  assert.equal(when('aleph_research_claim_issue')({ agent: operator }), false)

  assert.equal(when('aleph_research_create_program')({ agent: operator }), true)
  assert.equal(when('aleph_research_create_program')({ agent: researcher }), false)
  assert.equal(when('aleph_research_operator_create_issue')({ agent: operator }), true)
  assert.equal(when('aleph_research_operator_create_issue')({ agent: researcher }), false)

  assert.equal(when('aleph_research_submit_implementation')({ agent: implementer }), true)
  assert.equal(when('aleph_research_submit_implementation')({ agent: researcher }), false)

  assert.equal(when('aleph_research_watchdog_read_metrics')({ agent: watchdog }), true)
  assert.equal(when('aleph_research_watchdog_read_metrics')({ agent: researcher }), false)
  assert.equal(when('aleph_research_researcher_read_metrics')({ agent: researcher }), true)

  // Fail closed for an unclassified session.
  assert.equal(when('aleph_research_claim_issue')({ agent: agentFor('standard') }), false)
  assert.equal(when('aleph_research_claim_issue')({ agent: undefined }), false)

  // Every predicate admits only the role its catalog entry names.
  for (const entry of adapter.catalog) {
    assert.equal(when(entry.name)({ agent: agentFor(`aleph-${entry.role}`) }), true, entry.id)
    const otherRole = TOOL_ROLES.find((role) => role !== entry.role)
    assert.equal(when(entry.name)({ agent: agentFor(`aleph-${otherRole}`) }), false, entry.id)
  }
})

test('roleOf and roleGating override the default preset mapping', () => {
  assert.equal(roleFromPreset(agentFor('aleph-researcher')), 'researcher')
  assert.equal(roleFromPreset({ session: { header: { agentPreset: 'aleph-watchdog' } } }), 'watchdog')
  assert.equal(roleFromPreset('aleph-implementer'), 'implementer')
  assert.equal(roleFromPreset({}), undefined)
  assert.equal(roleFromPreset(undefined), undefined)
  assert.deepEqual(Object.keys(PRESET_ROLES).sort(), TOOL_ROLES.map((role) => `aleph-${role}`).sort())

  const custom = fakeContext()
  const customAgent = { id: 'custom-session', presetId: 'custom' }
  const customAdapter = registerResearchTools(custom.ctx, {
    roleOf: (agent) => (agent?.presetId === 'custom' ? 'operator' : undefined),
  })
  const when = custom.registration('aleph_research_create_program').when
  assert.equal(when({ agent: customAgent }), true)
  assert.equal(when({ agent: agentFor('aleph-operator') }), false)
  customAdapter.dispose()

  const ungated = fakeContext()
  const ungatedAdapter = registerResearchTools(ungated.ctx, { roleGating: false })
  for (const entry of ungatedAdapter.catalog) {
    assert.equal(ungated.registration(entry.name).when, undefined, entry.id)
  }
  ungatedAdapter.dispose()
})

test('collision names stay role-qualified when only one role is registered', () => {
  const researcher = buildResearchToolCatalog(DEFAULT_PREFIX, ['researcher'])
  assert.ok(researcher.some((entry) => entry.name === 'aleph_research_researcher_create_issue'))
  assert.ok(researcher.some((entry) => entry.name === 'aleph_research_researcher_read_metrics'))
  assert.ok(researcher.some((entry) => entry.name === 'aleph_research_claim_issue'))

  const operator = buildResearchToolCatalog(DEFAULT_PREFIX, ['operator'])
  assert.ok(operator.some((entry) => entry.name === 'aleph_research_operator_create_issue'))

  const watchdog = buildResearchToolCatalog(DEFAULT_PREFIX, ['watchdog'])
  assert.ok(watchdog.some((entry) => entry.name === 'aleph_research_watchdog_read_metrics'))
})

test('a custom prefix is normalized and applied to every name', () => {
  const catalog = buildResearchToolCatalog('custom', ['watchdog'])
  assert.deepEqual(catalog.map((entry) => entry.name), [
    'custom_list_stalled',
    'custom_raise_attention',
    'custom_watchdog_read_metrics',
  ])
  assert.throws(() => buildResearchToolCatalog('9bad'), /prefix/)
  assert.throws(() => registerResearchTools(fakeContext().ctx, { roles: ['nobody'] }), /roles/)
})

test('the Cordis wrapper registers the same catalog', () => {
  assert.equal(name, 'aleph-research-tools')
  assert.deepEqual(inject, ['tools'])

  const harness = fakeContext()
  const adapter = apply(harness.ctx)
  assert.equal(adapter.tools.length, 23)
  assert.equal(harness.registrations.size, 23)
  for (const toolName of EXPECTED_NAMES) assert.ok(harness.registration(toolName), toolName)
})

// ---------------------------------------------------------------------------
// Host service binding in the Cordis wrapper.
// ---------------------------------------------------------------------------

/** A service double exposing the one method the wrapper uses. */
function hostServiceDouble(calls) {
  return {
    async executeTool(toolName, input, context) {
      calls.push({ toolName, input, context })
      return { ok: true, value: { tool: toolName, input } }
    },
  }
}

test('the wrapper binds alephResearchHost to every registered tool after registration', async () => {
  assert.equal(HOST_SERVICE_NAME, 'alephResearchHost')
  const calls = []
  const harness = fakeContext({ services: new Map([[HOST_SERVICE_NAME, hostServiceDouble(calls)]]) })
  const adapter = apply(harness.ctx)

  assert.equal(adapter.hostBound, true)
  assert.equal(harness.registrations.size, 23)

  const result = await harness.definition('aleph_research_read_program').execute(
    { programId: 'program-1' },
    { agent: agentFor('aleph-researcher') },
  )
  assert.deepEqual(result, {
    ok: true,
    value: { tool: 'researcher_read_program', input: { programId: 'program-1' } },
  })
  assert.equal(calls.length, 1)
  // The runtime name, not the DSH-facing name, reaches the host service.
  assert.equal(calls[0].toolName, 'researcher_read_program')
  assert.deepEqual(calls[0].input, { programId: 'program-1' })
  assert.equal(calls[0].context.tool.id, 'researcher.readProgram')
  adapter.dispose()
})

test('a missing host service keeps the no-handler error until the service is provided', async () => {
  const harness = fakeContext()
  const adapter = apply(harness.ctx)
  assert.equal(adapter.hostBound, false)
  const definition = harness.definition('aleph_research_read_program')

  await assert.rejects(
    definition.execute(
      { programId: 'program-1' },
      { agent: agentFor('aleph-researcher') },
    ),
    /has no injected handler/,
  )

  // Cordis provides the host after this fiber started: the wrapper binds on the event.
  const calls = []
  const service = hostServiceDouble(calls)
  harness.services.set(HOST_SERVICE_NAME, service)
  harness.emit('internal/service', HOST_SERVICE_NAME, service)
  assert.equal(adapter.hostBound, true)

  const result = await definition.execute(
    { programId: 'program-1' },
    { agent: agentFor('aleph-researcher') },
  )
  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  harness.dispose()
})

test('explicit handlers keep precedence over the host service', async () => {
  const calls = []
  const harness = fakeContext({ services: new Map([[HOST_SERVICE_NAME, hostServiceDouble(calls)]]) })
  const adapter = apply(harness.ctx, {
    handlers: { 'researcher.readProgram': () => ({ ok: true, value: 'explicit' }) },
  })

  assert.equal(adapter.hostBound, false)
  const result = await harness.definition('aleph_research_read_program').execute(
    { programId: 'program-1' },
    { agent: agentFor('aleph-researcher') },
  )
  assert.deepEqual(result, { ok: true, value: 'explicit' })
  assert.equal(calls.length, 0)
  adapter.dispose()
})

test('a throwing service lookup does not fail activation', () => {
  const harness = fakeContext()
  harness.ctx.get = () => {
    throw new Error('the service registry is unavailable')
  }
  const adapter = apply(harness.ctx)
  assert.equal(adapter.hostBound, false)
  assert.equal(harness.registrations.size, 23)
})

test('cleanup releases the host service listener', () => {
  const harness = fakeContext()
  const adapter = apply(harness.ctx)
  assert.equal(harness.listeners.get('internal/service').size, 1)

  adapter.dispose()
  assert.equal(harness.listeners.get('internal/service').size, 0)
  assert.equal(harness.registrations.size, 0)
})
