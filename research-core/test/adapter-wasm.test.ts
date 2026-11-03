import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CORE_BOUNDARY_VERSION,
  loadBundledResearchCore,
  loadResearchCore,
} from '../src/adapter/wasm.js'
import type { CoreConcepts, CoreFactory, CoreHandle } from '../src/adapter/wasm.js'

function fakeCore(version: number): CoreHandle {
  return {
    boundary_version: () => version,
    start: () => {
      throw new Error('unused')
    },
    resume: () => {
      throw new Error('unused')
    },
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

function factoryFor(version: number): CoreFactory {
  return { create: () => fakeCore(version) }
}

test('the loader refuses a module with a different boundary version', async () => {
  const loaded = await loadResearchCore({
    concepts: unusedConcepts(),
    factory: factoryFor(CORE_BOUNDARY_VERSION - 1),
  })

  assert.deepEqual(loaded, {
    ok: false,
    error: {
      kind: 'boundary-version',
      expected: CORE_BOUNDARY_VERSION,
      actual: CORE_BOUNDARY_VERSION - 1,
    },
  })
})

test('the loader refuses a factory that cannot instantiate the core', async () => {
  const loaded = await loadResearchCore({
    concepts: unusedConcepts(),
    factory: {
      create: () => {
        throw new Error('instantiation failed')
      },
    },
  })

  assert.deepEqual(loaded, {
    ok: false,
    error: { kind: 'instantiate', message: 'instantiation failed' },
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
