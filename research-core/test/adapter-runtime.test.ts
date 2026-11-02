import assert from 'node:assert/strict'
import test from 'node:test'
import { createHostPrincipal } from '../src/factories.js'
import { createPlugin } from '../src/adapter/runtime.js'
import type { PluginParts } from '../src/adapter/runtime.js'
import { SURFACE } from '../src/adapter/surface.js'
import type { Surface } from '../src/adapter/surface.js'
import type { ResearchTriggerDraft } from '../src/types/triggers.js'
import { createInMemoryStore } from '../src/runtime/storage.js'
import {
  at,
  ciRunId,
  commitSha,
  createRuntimeFixture,
  createSurfaceFixture,
  durationMs,
  experimentId,
  issueId,
  message,
  metricName,
  ok,
  programId,
  researcherSessionId,
} from './adapter-fixture.js'

function createHarness() {
  const store = createInMemoryStore()
  const runtime = createRuntimeFixture()
  const surface = createSurfaceFixture()
  const parts: PluginParts = {
    store,
    clock: { now: () => at('2026-01-01T00:00:00.000Z') },
    trigger: runtime.triggers,
    tickets: runtime.ticket,
    sessions: runtime.sessions,
    presets: surface.sessions,
    benchmark: runtime.benchmark,
    artifacts: runtime.artifacts,
    tools: surface.tools,
    http: surface.routes,
    settings: surface.settings,
  }
  return { parts, store, runtime, surface }
}

function triggerDraft(): ResearchTriggerDraft {
  return {
    kind: 'experiment-proposed',
    programId: programId('program:1'),
    threads: [{ kind: 'program', id: 'program:1' }],
    actor: createHostPrincipal(),
    human: false,
    at: at('2026-01-01T00:00:00.000Z'),
    text: 'an experiment was proposed',
    meta: {},
  }
}

test('the composition keeps storage identity and defaults to the generated surface', () => {
  const harness = createHarness()
  const assembly = createPlugin(harness.parts)

  assert.equal(assembly.plugin.storage.programs, harness.store.programs)
  assert.equal(assembly.plugin.storage.issues, harness.store.issues)
  assert.equal(assembly.plugin.storage.experiments, harness.store.experiments)
  assert.equal(assembly.plugin.storage.tickets, harness.store.tickets)
  assert.equal(assembly.plugin.storage.ciRecords, harness.store.ciRecords)
  assert.equal(assembly.plugin.storage.artifacts, harness.store.artifacts)
  assert.equal(assembly.plugin.storage.attention, harness.store.attention)
  assert.equal(assembly.plugin.storage.audit, harness.store.audit)
  assert.equal(assembly.plugin.surface, SURFACE)
  assert.equal(assembly.surfacePorts.http, harness.parts.http)
  assert.equal(assembly.surfacePorts.tools, harness.parts.tools)
  assert.equal(assembly.surfacePorts.sessions, harness.parts.presets)
  assert.equal(assembly.surfacePorts.settings, harness.parts.settings)
})

test('the composition accepts a supplied surface', () => {
  const harness = createHarness()
  const surface: Surface = { ...SURFACE }
  const assembly = createPlugin({ ...harness.parts, surface })

  assert.equal(assembly.plugin.surface, surface)
  assert.notEqual(assembly.plugin.surface, SURFACE)
})

test('the trigger source delivers the draft it receives', async () => {
  const harness = createHarness()
  const assembly = createPlugin(harness.parts)
  const draft = triggerDraft()

  const delivered = await assembly.plugin.trigger.deliver(draft)

  assert.equal(delivered.ok, true)
  assert.deepEqual(harness.runtime.calls.triggers, [draft])
})

test('the ticket executor delegates open, start and submit', async () => {
  const harness = createHarness()
  const assembly = createPlugin(harness.parts)
  const baseCommit = commitSha('a'.repeat(40))

  const opened = await assembly.plugin.executor.open({
    programId: programId('program:1'),
    issueId: issueId('issue:1'),
    experimentId: experimentId('experiment:1'),
    baseCommit,
  })
  assert.equal(opened.ok, true)
  if (!opened.ok) return

  const started = await assembly.plugin.executor.start(opened.value)
  const submitted = await assembly.plugin.executor.submit(opened.value, baseCommit)

  assert.equal(started.ok, true)
  assert.equal(submitted.ok, true)
  assert.equal(harness.runtime.calls.ticketOpens.length, 1)
  assert.deepEqual(harness.runtime.calls.ticketStarts, [opened.value])
  assert.deepEqual(harness.runtime.calls.ticketSubmits, [[opened.value, baseCommit]])
})

test('sessions map a thrown host failure to a typed refusal', async () => {
  const harness = createHarness()
  const failing: PluginParts = {
    ...harness.parts,
    sessions: {
      ensureResearcher: async () => {
        throw new Error('the session pool is unavailable')
      },
      ensureImplementer: async () => {
        throw new Error('the session pool is unavailable')
      },
      wakeResearcher: async () => {
        throw new Error('the session pool is unavailable')
      },
    },
  }
  const assembly = createPlugin(failing)

  const result = await assembly.plugin.sessions.ensureResearcher(researcherSessionId('session:9'))

  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'invalid-state')
    assert.equal(result.error.message, 'the session pool is unavailable')
  }
})

test('artifacts map a thrown store failure to a typed refusal', async () => {
  const harness = createHarness()
  const assembly = createPlugin(harness.parts)

  const result = await assembly.plugin.artifacts.put({
    candidate: { kind: 'report', path: '/tmp/report.json', retention: 'keep' },
    programId: programId('program:1'),
    experimentId: experimentId('experiment:1'),
    commit: commitSha('b'.repeat(40)),
    ciRunId: ciRunId('benchmark:1'),
  })

  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'invalid-state')
    assert.equal(result.error.message, 'the fixture stores no artifacts')
  }
})

test('the benchmark runner and clock delegate without adding decisions', async () => {
  const harness = createHarness()
  const assembly = createPlugin(harness.parts)

  assert.equal(assembly.plugin.clock.now(), '2026-01-01T00:00:00.000Z')

  const result = await assembly.plugin.benchmark.run({
    experimentId: experimentId('experiment:1'),
    commit: commitSha('c'.repeat(40)),
    environment: {
      declaration: { kind: 'uv-lock', lockFile: 'uv.lock', pythonVersion: '3.12' },
      snapshot: {
        branch: 'research/experiment-1',
        commit: commitSha('c'.repeat(40)),
        root: '/tmp/experiment-1',
        declarationPath: '/tmp/experiment-1/uv.lock',
      },
      python: 'python3.12',
      digest: 'sha256:fixture',
      root: '/tmp/experiment-1',
    },
    ciEntry: message('bench'),
    timeoutMs: durationMs(1000),
    requiredMetrics: [metricName('score')],
  })

  assert.equal(result.ok, true)
  assert.equal(harness.runtime.calls.benchmarkRuns.length, 1)
})

test('the tools and http ports delegate to their registrars', async () => {
  const harness = createHarness()
  const assembly = createPlugin(harness.parts)

  const tool = await assembly.plugin.tools.register({
    name: 'aleph_research_read_program',
    description: 'read a program',
    role: 'operator',
    handle: async () => ok(null),
  })
  const route = await assembly.plugin.http.register({
    name: 'program.create',
    method: 'POST',
    path: '/aleph/api/research/programs',
    handle: async () => ({ status: 200, body: null }),
  })

  assert.equal(tool.ok, true)
  assert.equal(route.ok, true)
  assert.equal(harness.surface.calls.tools.length, 1)
  assert.equal(harness.surface.calls.routes.length, 1)
})
