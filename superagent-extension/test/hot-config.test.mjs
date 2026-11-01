import assert from 'node:assert/strict'
import test from 'node:test'

import { applySourceSettings, sourceSettingsValue } from '../hot-config.js'

test('a settings merge keeps the enable flag and unrelated config keys', () => {
  const value = sourceSettingsValue(
    { enabled: false, config: { project: 'fixture', repository: '/r', conventions: 'old' } },
    { conventions: 'new', evalCommand: 'score' },
  )
  assert.equal(value.enabled, false)
  assert.deepEqual(value.config, {
    project: 'fixture',
    repository: '/r',
    conventions: 'new',
    evalCommand: 'score',
  })
})

test('a settings merge defaults to enabled with an empty config', () => {
  assert.deepEqual(sourceSettingsValue(undefined, undefined), { enabled: true, config: {} })
  assert.deepEqual(sourceSettingsValue({}, { project: 'p' }), { enabled: true, config: { project: 'p' } })
})

test('applying a configuration reads the revision and PUTs the merged value', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    if (url.endsWith('/settings')) {
      return { ok: true, json: async () => ({ sources: [
        { id: 'aleph', revision: 7, value: { enabled: true, config: { project: 'old' } } },
        { id: 'github', revision: 3, value: { enabled: false, config: {} } },
      ] }) }
    }
    return { ok: true, json: async () => ({ saved: true, revision: 8 }) }
  }
  const answer = await applySourceSettings('http://x/orchestrator/api', 'aleph', { project: 'new' }, { fetchImpl })
  assert.deepEqual(answer, { saved: true, revision: 8 })
  assert.equal(calls.length, 2)
  const put = calls[1]
  assert.match(put.url, /\/settings\/source:aleph$/)
  assert.deepEqual(JSON.parse(put.init.body), {
    value: { enabled: true, config: { project: 'new' } },
    revision: 7,
  })
})

test('an unknown Source and a refused update surface their errors', async () => {
  const missing = async () => ({ ok: true, json: async () => ({ sources: [] }) })
  await assert.rejects(applySourceSettings('http://x', 'aleph', {}, { fetchImpl: missing }), /no aleph Source/)

  const refused = async (url) => url.endsWith('/settings')
    ? { ok: true, json: async () => ({ sources: [{ id: 'aleph', revision: 1, value: { config: {} } }] }) }
    : { ok: false, status: 400, json: async () => ({ error: 'invalid settings' }) }
  await assert.rejects(applySourceSettings('http://x', 'aleph', {}, { fetchImpl: refused }), /invalid settings/)
})
