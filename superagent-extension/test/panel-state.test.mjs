import assert from 'node:assert/strict'
import test from 'node:test'

import { healthState } from '../panel-state.js'

test('the runtime state wins over an off optional source', () => {
  const health = {
    runtime: { state: 'ready', detail: 'Orchestrator is ready' },
    github: { state: 'paused', detail: 'Off', code: 'sourceOff' },
  }
  assert.deepEqual(healthState(health), { state: 'ready', errors: 0 })
})

test('a real error wins over the runtime state', () => {
  const health = { runtime: { state: 'ready' }, models: { state: 'error' }, launch: { state: 'error' } }
  assert.deepEqual(healthState(health), { state: 'error', errors: 2 })
})

test('without a runtime entry the aggregate falls back to starting, paused or ready', () => {
  assert.equal(healthState({ github: { state: 'paused' } }).state, 'paused')
  assert.equal(healthState({ evals: { state: 'starting' } }).state, 'starting')
  assert.equal(healthState({ github: { state: 'ready' } }).state, 'ready')
})

test('an empty or malformed health map reports none', () => {
  assert.deepEqual(healthState({}), { state: 'none', errors: 0 })
  assert.deepEqual(healthState(undefined), { state: 'none', errors: 0 })
  assert.deepEqual(healthState([1, 2]), { state: 'none', errors: 0 })
})
