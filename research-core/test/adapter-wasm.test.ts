import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CORE_BOUNDARY_VERSION,
  loadBundledResearchCore,
  loadResearchCore,
} from '../src/adapter/wasm.js'
import type { CoreConcepts, CoreWasmExports, WasmRuntime } from '../src/adapter/wasm.js'

function exportsFor(version: number): CoreWasmExports {
  return {
    memory: { buffer: new ArrayBuffer(0) },
    aleph_bridge_version: () => version,
    aleph_alloc: () => 0,
    aleph_free: () => {},
    aleph_start: () => 0,
    aleph_resume: () => 0,
    aleph_response_len: () => 0,
    aleph_response_write: () => 0,
  }
}

function runtimeFor(exports: CoreWasmExports): WasmRuntime {
  return {
    instantiate: async () => ({ exports }),
  }
}

function unusedConcepts(): CoreConcepts {
  const unavailable = async () => ({
    ok: false as const,
    error: { kind: 'unavailable' as const, message: 'unused' },
  })
  return {
    storage: { loadProgram: unavailable, appendBenchmarkRecord: unavailable },
    trigger: { deliver: unavailable },
    executor: { open: unavailable },
    sessions: { startWorker: unavailable, submitCommit: unavailable, review: unavailable },
    benchmark: { specHash: unavailable, buildEnvironment: unavailable, run: unavailable },
    clock: { now: () => '2026-01-01T00:00:00.000Z' },
  }
}

test('the loader refuses a module with a different boundary version', async () => {
  const loaded = await loadResearchCore({
    source: { module: new Uint8Array([0, 97, 115, 109]) },
    concepts: unusedConcepts(),
    runtime: runtimeFor(exportsFor(CORE_BOUNDARY_VERSION + 1)),
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

test('the loader refuses a module without the bridge exports', async () => {
  const exports = exportsFor(CORE_BOUNDARY_VERSION)
  const missing = {
    ...exports,
    aleph_start: undefined,
  } as unknown as CoreWasmExports
  const loaded = await loadResearchCore({
    source: { module: new Uint8Array() },
    concepts: unusedConcepts(),
    runtime: runtimeFor(missing),
  })

  assert.deepEqual(loaded, {
    ok: false,
    error: { kind: 'missing-export', name: 'aleph_start' },
  })
})

test('the bundled loader instantiates the real wasm artifact', async () => {
  const loaded = await loadBundledResearchCore(unusedConcepts())
  assert.equal(loaded.ok, true)
  if (!loaded.ok) return
  assert.equal(loaded.value.boundaryVersion, CORE_BOUNDARY_VERSION)
  assert.equal(typeof loaded.value.start, 'function')
  assert.equal(typeof loaded.value.resume, 'function')
  assert.equal(typeof loaded.value.run, 'function')
})
