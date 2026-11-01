import assert from 'node:assert/strict'
import test from 'node:test'

import { retryTicket, stopTicket, ticketAction } from '../watchdog-actions.js'

test('stop and retry post the documented management paths with the guard header', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, json: async () => ({ ok: true }) }
  }
  assert.deepEqual(await stopTicket('http://x/orchestrator/api/', 'abc123', { fetchImpl }), { ok: true })
  await retryTicket('http://x/orchestrator/api', 'abc123', { fetchImpl })
  assert.equal(calls[0].url, 'http://x/orchestrator/api/tickets/abc123/stop')
  assert.equal(calls[1].url, 'http://x/orchestrator/api/tickets/abc123/retry')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['x-orchestrator-request'], '1')
})

test('invalid inputs and refusals surface clear errors', async () => {
  await assert.rejects(ticketAction('', 't', 'stop'), /no management API/)
  await assert.rejects(ticketAction('http://x', '  ', 'stop'), /ticket id is required/)
  await assert.rejects(ticketAction('http://x', 't', 'explode'), /unknown ticket action/)
  const refused = async () => ({ ok: false, status: 409, json: async () => ({ error: 'ticket already ended' }) })
  await assert.rejects(stopTicket('http://x', 't', { fetchImpl: refused }), /ticket already ended/)
  const broken = async () => ({ ok: false, status: 500, json: async () => { throw new Error('not json') } })
  await assert.rejects(stopTicket('http://x', 't', { fetchImpl: broken }), /failed with 500/)
})
