/**
 * Tests for the research runtime -> prototype `aleph` Source trigger bridge.
 *
 * No real superagent runtime is composed: `ctx.orchestrator.context('aleph')` returns a
 * fake Source context that records `receive()` calls, and the research host is a fake
 * service whose `onTrigger` registers sinks exactly like the real one. These tests
 * therefore cover the conversion contract and the bridge's failure policy; the real
 * `toPrototypeTrigger` output is also asserted against the shape `alephTrigger()` in
 * `research-extension.js` builds.
 *
 * `JSON.parse` is allowed in tests; the bridge itself is linted against it.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { format } from 'node:util'

import {
  ALEPH_KIND,
  ALEPH_SOURCE,
  HOST_SERVICE_NAME,
  apply,
  inject,
  name,
  toPrototypeTrigger,
} from '../research-trigger-bridge.js'

/** One representative runtime draft: an Implementer fact on the Program and Experiment threads. */
const DRAFT = Object.freeze({
  kind: 'experiment-ready',
  programId: 'program-1',
  threads: [
    { kind: 'program', id: 'research:program-1' },
    { kind: 'experiment', id: 'research:program-1:experiment:experiment-1' },
  ],
  actor: { kind: 'implementer', sessionId: 'impl-session-1' },
  human: false,
  at: '2026-01-01T00:00:00.000Z',
  text: 'experiment ready for review',
  ticketId: 'ticket-1',
  meta: {
    action: 'experiment.ready',
    subjectKind: 'experiment',
    subjectId: 'experiment-1',
    stale: false,
  },
})

/**
 * A fake Cordis context with the optional research host service and a recording Source.
 *
 * `receive` and `context` can be overridden to exercise the failure policy; the host
 * service records the sinks registered through `onTrigger` and exposes `emit()`.
 */
function fakeContext({ services = new Map(), receive, contextError, withHost = true } = {}) {
  const cleanups = []
  const warnings = []
  const listeners = new Map()
  const received = []
  const sinks = new Set()
  const kinds = []

  const source = {
    async receive(trigger) {
      received.push(trigger)
      if (receive !== undefined) return receive(trigger)
      return { ok: true, value: undefined }
    },
  }

  const host = {
    onTrigger(callback) {
      sinks.add(callback)
      return () => {
        sinks.delete(callback)
      }
    },
    async emit(draft) {
      const results = []
      for (const sink of [...sinks]) results.push(await sink(draft))
      return results
    },
    get sinkCount() {
      return sinks.size
    },
  }

  if (withHost) services.set(HOST_SERVICE_NAME, host)

  const ctx = {
    orchestrator: {
      context(kind) {
        kinds.push(kind)
        if (contextError !== undefined) throw contextError
        return source
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
    effect(setup) {
      const cleanup = setup()
      cleanups.push(cleanup)
      return () => {
        const index = cleanups.indexOf(cleanup)
        if (index >= 0) cleanups.splice(index, 1)
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
    host,
    source,
    received,
    warnings,
    kinds,
    listeners,
    services,
    emitService(serviceName) {
      for (const callback of [...(listeners.get('internal/service') ?? [])]) {
        callback(serviceName, services.get(serviceName))
      }
    },
    async dispose() {
      while (cleanups.length > 0) {
        const cleanup = cleanups.pop()
        if (typeof cleanup === 'function') await cleanup()
      }
    },
  }
}

test('toPrototypeTrigger converts a ResearchTriggerDraft to the prototype Trigger shape', () => {
  assert.equal(ALEPH_SOURCE, 'aleph')
  assert.deepEqual(ALEPH_KIND, { kind: 'aleph', health: ['aleph'] })

  const trigger = toPrototypeTrigger(DRAFT)
  assert.deepEqual(trigger, {
    id: 'aleph:experiment-ready:program-1:experiment-1:2026-01-01T00:00:00.000Z',
    source: 'aleph',
    threads: [
      { source: 'aleph', id: 'research:program-1' },
      { source: 'aleph', id: 'research:program-1:experiment:experiment-1' },
    ],
    actor: { source: 'aleph', id: 'impl-session-1' },
    human: false,
    addressed: 'mention',
    at: '2026-01-01T00:00:00.000Z',
    text: 'experiment ready for review',
    meta: {
      kind: 'experiment-ready',
      programId: 'program-1',
      action: 'experiment.ready',
      subjectKind: 'experiment',
      subjectId: 'experiment-1',
      stale: false,
      ticketId: 'ticket-1',
    },
  })

  // Pure and deterministic: a replay of the same fact yields the same trigger id.
  assert.deepEqual(toPrototypeTrigger(DRAFT), trigger)
  assert.notEqual(
    toPrototypeTrigger({ ...DRAFT, kind: 'issue-created', meta: { ...DRAFT.meta, subjectId: 'issue-1' } }).id,
    trigger.id,
  )
})

test('toPrototypeTrigger falls back to the actor kind and rejects drafts without threads', () => {
  const trigger = toPrototypeTrigger({
    ...DRAFT,
    actor: { kind: 'operator' },
    threads: [{ kind: 'program', id: 'research:program-1' }],
    meta: {},
  })
  assert.equal(trigger.actor.id, 'operator')
  assert.equal(trigger.addressed, 'mention')
  assert.equal(trigger.meta.kind, 'experiment-ready')
  assert.equal(trigger.meta.programId, 'program-1')

  assert.throws(() => toPrototypeTrigger(null), /ResearchTriggerDraft/)
  assert.throws(() => toPrototypeTrigger({ ...DRAFT, kind: '' }), /kind/)
  assert.throws(() => toPrototypeTrigger({ ...DRAFT, threads: [] }), /at least one thread/)
  assert.throws(() => toPrototypeTrigger({ ...DRAFT, threads: [{}] }), /thread reference/)
})

test('apply registers a sink and delivers the converted trigger to the aleph Source', async () => {
  const harness = fakeContext()
  const bridge = apply(harness.ctx)

  assert.equal(name, 'aleph-research-trigger-bridge')
  assert.deepEqual(inject, ['orchestrator'])
  assert.equal(bridge.attached, true)
  assert.equal(harness.host.sinkCount, 1)

  await harness.host.emit(DRAFT)
  assert.equal(harness.received.length, 1)
  assert.deepEqual(harness.received[0], toPrototypeTrigger(DRAFT))
  assert.deepEqual(harness.kinds, [ALEPH_KIND])

  await harness.dispose()
})

test('a throwing Source and a refusing Source are logged, never propagated', async () => {
  const throwing = fakeContext({
    receive() {
      throw new Error('Source exploded')
    },
  })
  const throwingBridge = apply(throwing.ctx)
  await throwing.host.emit(DRAFT)
  assert.ok(throwing.warnings.some((warning) => warning.includes('Source exploded')))
  assert.equal(throwingBridge.attached, true)
  await throwing.dispose()

  const refusing = fakeContext({
    receive: async () => ({ ok: false, error: { code: 'refused', message: 'not admissible' } }),
  })
  apply(refusing.ctx)
  await refusing.host.emit(DRAFT)
  assert.ok(refusing.warnings.some((warning) => warning.includes('refused')))
  assert.equal(refusing.received.length, 1)
  await refusing.dispose()

  const noSource = fakeContext({ contextError: new Error('orchestrator is not ready') })
  apply(noSource.ctx)
  await noSource.host.emit(DRAFT)
  assert.ok(noSource.warnings.some((warning) => warning.includes('orchestrator is not ready')))
  await noSource.dispose()

  // A malformed draft is converted inside the sink; the TypeError is logged too.
  const malformed = fakeContext()
  const malformedBridge = apply(malformed.ctx)
  await malformed.host.emit({ ...DRAFT, threads: [] })
  assert.ok(malformed.warnings.some((warning) => warning.includes('cannot convert')))
  assert.equal(malformed.received.length, 0)
  assert.equal(malformedBridge.attached, true)
  await malformed.dispose()
})

test('a missing research host service leaves the bridge inert until it is provided', async () => {
  const services = new Map()
  const harness = fakeContext({ services, withHost: false })
  const bridge = apply(harness.ctx)
  assert.equal(bridge.attached, false)
  assert.equal(harness.received.length, 0)

  // Cordis provides the host after this fiber started: the event binds the sink.
  services.set(HOST_SERVICE_NAME, harness.host)
  harness.emitService(HOST_SERVICE_NAME)
  assert.equal(bridge.attached, true)
  await harness.host.emit(DRAFT)
  assert.equal(harness.received.length, 1)

  // The service going away unbinds the sink (and a later provide binds it again).
  services.delete(HOST_SERVICE_NAME)
  harness.emitService(HOST_SERVICE_NAME)
  assert.equal(bridge.attached, false)
  assert.equal(harness.host.sinkCount, 0)

  services.set(HOST_SERVICE_NAME, harness.host)
  harness.emitService(HOST_SERVICE_NAME)
  assert.equal(harness.host.sinkCount, 1)
  await harness.dispose()
})

test('cleanup unsets the sink and the service listener', async () => {
  const harness = fakeContext()
  const bridge = apply(harness.ctx)
  assert.equal(harness.host.sinkCount, 1)
  assert.equal(harness.listeners.get('internal/service').size, 1)

  bridge.dispose()
  assert.equal(harness.host.sinkCount, 0)
  assert.equal(harness.listeners.get('internal/service').size, 0)
  assert.equal(bridge.attached, false)

  // A disposed bridge does not re-attach on a late service event.
  harness.emitService(HOST_SERVICE_NAME)
  assert.equal(harness.host.sinkCount, 0)
  await harness.dispose()
})

test('the fiber effect owns cleanup even when dispose is not called directly', async () => {
  const harness = fakeContext()
  const bridge = apply(harness.ctx)
  assert.equal(harness.host.sinkCount, 1)

  await harness.dispose()
  assert.equal(harness.host.sinkCount, 0)
  assert.equal(bridge.attached, false)
})
