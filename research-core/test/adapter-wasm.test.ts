import assert from 'node:assert/strict'
import test from 'node:test'
import { UnimplementedError } from '../src/completion.js'
import { createHostPrincipal } from '../src/factories.js'
import {
  CORE_BOUNDARY_VERSION,
  loadBundledResearchCore,
  loadResearchCore,
} from '../src/adapter/wasm.js'
import type {
  CoreCommandInput,
  CoreExports,
  CoreImports,
  CoreStartInput,
  WasmRuntime,
} from '../src/adapter/wasm.js'
import {
  createPluginFixture,
  experimentId,
  issueId,
  ok,
  programId,
} from './adapter-fixture.js'

interface CoreCalls {
  readonly starts: CoreStartInput[]
  readonly executes: CoreCommandInput[]
}

function createCore(calls: CoreCalls, boundaryVersion = CORE_BOUNDARY_VERSION): CoreExports {
  return {
    boundaryVersion,
    start: async (input) => {
      calls.starts.push(input)
      return ok({
        experimentId: input.experimentId,
        outcome: 'concluded',
        audit: [],
      })
    },
    execute: async (input) => {
      calls.executes.push(input)
      return ok({ value: 'accepted', audit: [] })
    },
  }
}

test('the loader instantiates with the plugin and forwards both entry points', async () => {
  const fixture = createPluginFixture()
  const calls: CoreCalls = { starts: [], executes: [] }
  const received: { imports?: CoreImports; module?: Uint8Array } = {}
  const runtime: WasmRuntime = {
    instantiate: async (module, imports) => {
      received.module = module
      received.imports = imports
      return { exports: createCore(calls) }
    },
  }
  const source = { module: new Uint8Array([0, 97, 115, 109]) }

  const loaded = await loadResearchCore({
    source,
    plugin: fixture.plugin,
    runtime,
  })

  assert.equal(loaded.ok, true)
  assert.equal(received.module, source.module)
  assert.deepEqual(received.imports, {
    storage: fixture.plugin.storage,
    trigger: fixture.plugin.trigger,
    executor: fixture.plugin.executor,
    sessions: fixture.plugin.sessions,
    benchmark: fixture.plugin.benchmark,
    artifacts: fixture.plugin.artifacts,
    clock: fixture.plugin.clock,
    tools: fixture.plugin.tools,
    http: fixture.plugin.http,
    surface: fixture.plugin.surface,
  })
  if (!loaded.ok) return

  assert.equal(loaded.value.boundaryVersion, CORE_BOUNDARY_VERSION)
  const start: CoreStartInput = {
    programId: programId('program:1'),
    issueId: issueId('issue:1'),
    experimentId: experimentId('experiment:1'),
  }
  const started = await loaded.value.start(start)
  assert.deepEqual(started, ok({
    experimentId: start.experimentId,
    outcome: 'concluded',
    audit: [],
  }))

  const command: CoreCommandInput = {
    type: 'program.create',
    actor: createHostPrincipal(),
    body: { name: 'fixture' },
  }
  const executed = await loaded.value.execute(command)
  assert.deepEqual(executed, ok({ value: 'accepted', audit: [] }))

  assert.deepEqual(calls.starts, [start])
  assert.deepEqual(calls.executes, [command])
})

test('the loader refuses a module with a different boundary version', async () => {
  const fixture = createPluginFixture()
  const runtime: WasmRuntime = {
    instantiate: async () => ({
      exports: createCore({ starts: [], executes: [] }, CORE_BOUNDARY_VERSION + 1),
    }),
  }

  const loaded = await loadResearchCore({
    source: { module: new Uint8Array() },
    plugin: fixture.plugin,
    runtime,
  })

  assert.deepEqual(loaded, {
    ok: false,
    error: {
      kind: 'boundary-version',
      expected: CORE_BOUNDARY_VERSION,
      actual: CORE_BOUNDARY_VERSION + 1,
    },
  })
})

test('the bundled loader is a typed unimplemented seam', () => {
  assert.throws(
    () => loadBundledResearchCore(),
    (cause) => cause instanceof UnimplementedError && cause.feature === 'wasm-core-loading',
  )
})
