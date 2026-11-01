import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_STALE_MS,
  findStalledTickets,
  summarizeTickets,
  watchdogBrief,
} from '../watchdog.js'

const NOW = Date.parse('2026-11-01T20:00:00.000Z')
const MINUTE = 60_000

/** The ISO time `ms` milliseconds before NOW. */
const ago = (ms) => new Date(NOW - ms).toISOString()

/** An open ticket whose newest assignment is running. */
const runningTicket = ({
  id = 't-1',
  title = 'Train the model',
  directory = '/work/t-1',
  updatedAgo,
  startedAgo,
  ...overrides
} = {}) => ({
  id,
  title,
  updatedAt: ago(updatedAgo),
  assignments: [{ state: 'running', startedAt: ago(startedAgo) }],
  execution: { name: 'aleph-researcher', directory },
  ...overrides,
})

/** An open ticket with no assignments. */
const unassignedTicket = ({
  id = 't-2',
  title = 'Review the result',
  directory = '/work/t-2',
  updatedAgo = 120 * MINUTE,
  ...overrides
} = {}) => ({
  id,
  title,
  updatedAt: ago(updatedAgo),
  assignments: [],
  execution: { name: 'aleph-researcher', directory },
  ...overrides,
})

test('a running assignment with no activity beyond staleMs is stalled', () => {
  const ticket = runningTicket({ updatedAgo: 120 * MINUTE, startedAgo: 180 * MINUTE })

  const [entry] = findStalledTickets([ticket], { now: NOW })

  assert.deepEqual(entry, {
    ticketId: 't-1',
    title: 'Train the model',
    directory: '/work/t-1',
    reason: 'assignment-stalled',
    staleMs: DEFAULT_STALE_MS,
    lastUpdate: ago(120 * MINUTE),
    assignmentStartedAt: ago(180 * MINUTE),
    stuckForMs: 120 * MINUTE,
    attention: false,
  })
})

test('a running assignment that was updated or restarted recently is not stalled', () => {
  const updatedRecently = runningTicket({ updatedAgo: 10 * MINUTE, startedAgo: 180 * MINUTE })
  const restartedRecently = runningTicket({ id: 't-2', updatedAgo: 180 * MINUTE, startedAgo: 10 * MINUTE })

  assert.deepEqual(findStalledTickets([updatedRecently, restartedRecently], { now: NOW }), [])
})

test('work exactly at the stale threshold is not stalled yet', () => {
  const ticket = runningTicket({ updatedAgo: DEFAULT_STALE_MS, startedAgo: DEFAULT_STALE_MS })

  assert.deepEqual(findStalledTickets([ticket], { now: NOW }), [])
})

test('a ticket with no assignments stalls once its last update is older than staleMs', () => {
  const stale = unassignedTicket({ updatedAgo: 120 * MINUTE })
  const fresh = unassignedTicket({ id: 't-3', updatedAgo: 5 * MINUTE })

  const stalled = findStalledTickets([stale, fresh], { now: NOW })

  assert.equal(stalled.length, 1)
  assert.deepEqual(stalled[0], {
    ticketId: 't-2',
    title: 'Review the result',
    directory: '/work/t-2',
    reason: 'no-assignment',
    staleMs: DEFAULT_STALE_MS,
    lastUpdate: ago(120 * MINUTE),
    assignmentStartedAt: null,
    stuckForMs: 120 * MINUTE,
    attention: false,
  })
})

test('missing or malformed timestamps are ignored instead of throwing', () => {
  const tickets = [
    { id: 'bad-updated', updatedAt: 'not-a-date', assignments: [{ state: 'running', startedAt: ago(180 * MINUTE) }] },
    { id: 'bad-started', updatedAt: ago(120 * MINUTE), assignments: [{ state: 'running', startedAt: 'yesterday-ish' }] },
    { id: 'missing-updated', assignments: [] },
    { id: 'missing-started', updatedAt: ago(120 * MINUTE), assignments: [{ state: 'running' }] },
    { id: 'malformed-assignments', updatedAt: ago(120 * MINUTE), assignments: 'not-a-list' },
    null,
    {},
  ]

  assert.deepEqual(findStalledTickets(tickets, { now: NOW }), [])
  assert.deepEqual(findStalledTickets(null, { now: NOW }), [])
  assert.deepEqual(findStalledTickets(undefined, { now: NOW }), [])
})

test('an ended ticket is not open and is never reported', () => {
  const ended = unassignedTicket({
    updatedAgo: 300 * MINUTE,
    ended: { at: ago(299 * MINUTE), by: 'executor', outcome: 'completed' },
  })

  assert.deepEqual(findStalledTickets([ended], { now: NOW }), [])
})

test('the newest assignment decides whether the ticket is running', () => {
  const retried = unassignedTicket({
    id: 'retried',
    assignments: [
      { state: 'ended', startedAt: ago(600 * MINUTE) },
      { state: 'running', startedAt: ago(180 * MINUTE) },
    ],
  })
  const finishedLatest = runningTicket({
    id: 'finished-latest',
    updatedAgo: 120 * MINUTE,
    startedAgo: 180 * MINUTE,
    assignments: [
      { state: 'running', startedAt: ago(180 * MINUTE) },
      { state: 'ended', startedAt: ago(180 * MINUTE), endedAt: ago(60 * MINUTE) },
    ],
  })

  const stalled = findStalledTickets([retried, finishedLatest], { now: NOW })

  assert.deepEqual(stalled.map((entry) => entry.ticketId), ['retried'])
})

test('a stalled ticket with attention is blocked-on-person in the brief', () => {
  const ticket = runningTicket({
    updatedAgo: 120 * MINUTE,
    startedAgo: 180 * MINUTE,
    attention: { id: 'q-1', question: 'Which GPU should the batch use?' },
  })

  const stalled = findStalledTickets([ticket], { now: NOW })
  const summary = summarizeTickets([ticket], { now: NOW })
  const brief = watchdogBrief({ stalled, summary, now: NOW })

  assert.equal(stalled.length, 1)
  assert.equal(stalled[0].attention, true)
  assert.equal(summary.attention, 1)
  assert.equal(summary.stalled, 1)

  assert.match(brief, /blocked-on-person/)
  assert.doesNotMatch(brief, /suggested action/)
  assert.doesNotMatch(brief, /\*\*stop\*\*/)
  assert.doesNotMatch(brief, /retry-or-check/)

  const bullet = brief.split('\n').find((line) => line.startsWith('- `t-1`'))
  assert.ok(bullet, 'the stalled ticket has its own bullet')
  assert.ok(bullet.includes('directory: `/work/t-1`'))
})

test('an invalid staleMs throws a TypeError', () => {
  for (const staleMs of [0, -1, NaN, Infinity, -Infinity, '60000', null, {}]) {
    assert.throws(() => findStalledTickets([], { now: NOW, staleMs }), TypeError)
  }
  assert.doesNotThrow(() => findStalledTickets([], { now: NOW, staleMs: 1 }))
  assert.doesNotThrow(() => findStalledTickets([]))
})

test('summarizeTickets counts totals, assignment states, attention and stalled work', () => {
  const tickets = [
    runningTicket({ id: 'stalled-running', updatedAgo: 120 * MINUTE, startedAgo: 180 * MINUTE }),
    runningTicket({ id: 'live-running', updatedAgo: 10 * MINUTE, startedAgo: 20 * MINUTE }),
    unassignedTicket({ id: 'pending', updatedAgo: 300 * MINUTE, assignments: [{ state: 'pending' }] }),
    unassignedTicket({ id: 'stalled-unassigned', updatedAgo: 200 * MINUTE }),
    runningTicket({
      id: 'attention',
      updatedAgo: 10 * MINUTE,
      startedAgo: 20 * MINUTE,
      attention: { id: 'q-1', question: 'Continue?' },
    }),
    unassignedTicket({
      id: 'ended',
      updatedAgo: 300 * MINUTE,
      ended: { at: ago(299 * MINUTE), by: 'human', outcome: 'stopped' },
    }),
  ]

  assert.deepEqual(summarizeTickets(tickets, { now: NOW }), {
    total: 6,
    running: 3,
    pending: 1,
    attention: 1,
    stalled: 2,
  })
})

test('summarizeTickets never throws on malformed tickets or options', () => {
  const zeros = { total: 0, running: 0, pending: 0, attention: 0, stalled: 0 }
  assert.deepEqual(summarizeTickets(undefined, { now: NOW }), zeros)
  assert.deepEqual(summarizeTickets(null), zeros)
  assert.deepEqual(summarizeTickets('not-a-list', { now: NOW }), zeros)

  assert.doesNotThrow(() => summarizeTickets([null, 42, 'x', {}, { assignments: 'nope' }], { now: NOW }))
  const summary = summarizeTickets([null, 42, {}, { assignments: 'nope' }], { now: NOW, staleMs: 0 })
  assert.equal(summary.stalled, 0)
  assert.ok(Number.isFinite(summary.total))
})

test('the brief suggests stop vs retry-or-check by how far the ticket is stuck', () => {
  const staleMs = MINUTE
  const farStuck = runningTicket({ id: 'far-stuck', updatedAgo: 5 * MINUTE, startedAgo: 10 * MINUTE })
  const justStuck = runningTicket({ id: 'just-stuck', updatedAgo: 100_000, startedAgo: 200_000 })
  const options = { now: NOW, staleMs }

  const stalled = findStalledTickets([farStuck, justStuck], options)
  const brief = watchdogBrief({ stalled, summary: summarizeTickets([farStuck, justStuck], options), now: NOW })

  const stopLine = brief.split('\n').find((line) => line.includes('`far-stuck`'))
  const retryLine = brief.split('\n').find((line) => line.includes('`just-stuck`'))
  assert.ok(stopLine)
  assert.ok(retryLine)
  assert.match(stopLine, /suggested action: \*\*stop\*\*/)
  assert.match(retryLine, /suggested action: \*\*retry-or-check\*\*/)
})

test('the stop suggestion starts only beyond three times staleMs', () => {
  const staleMs = MINUTE
  const atBoundary = runningTicket({ updatedAgo: 3 * MINUTE, startedAgo: 10 * MINUTE })

  const stalled = findStalledTickets([atBoundary], { now: NOW, staleMs })
  const brief = watchdogBrief({ stalled, summary: summarizeTickets([atBoundary], { now: NOW, staleMs }), now: NOW })

  assert.match(brief, /retry-or-check/)
  assert.doesNotMatch(brief, /\*\*stop\*\*/)
})

test('stalled tickets are ordered oldest update first', () => {
  const tickets = [
    unassignedTicket({ id: 'newer', updatedAgo: 60 * MINUTE }),
    unassignedTicket({ id: 'oldest', updatedAgo: 300 * MINUTE }),
    unassignedTicket({ id: 'middle', updatedAgo: 120 * MINUTE }),
  ]

  assert.deepEqual(
    findStalledTickets(tickets, { now: NOW }).map((entry) => entry.ticketId),
    ['oldest', 'middle', 'newer'],
  )
})

test('the brief lists every stalled ticket with its directory and evidence', () => {
  const tickets = [
    runningTicket({ updatedAgo: 120 * MINUTE, startedAgo: 180 * MINUTE }),
    unassignedTicket({ id: 't-2', updatedAgo: 200 * MINUTE }),
  ]
  const options = { now: NOW }

  const brief = watchdogBrief({
    stalled: findStalledTickets(tickets, options),
    summary: summarizeTickets(tickets, options),
    now: NOW,
  })

  const lines = brief.split('\n')
  assert.equal(lines[0], `## Watchdog brief — ${ago(0)}`)
  assert.ok(lines.includes('Tickets: 2 total · 1 running · 0 pending · 0 with attention · 2 stalled'))
  assert.equal(lines.filter((line) => line.startsWith('- `')).length, 2)
  assert.ok(brief.includes('directory: `/work/t-1`'))
  assert.ok(brief.includes('directory: `/work/t-2`'))
  assert.ok(brief.includes('newest assignment is running'))
  assert.ok(brief.includes('no assignment'))
  assert.ok(brief.includes('stuck for 2h'))
})

test('an empty snapshot yields no stalled tickets and a brief that says so', () => {
  assert.deepEqual(findStalledTickets([], { now: NOW }), [])

  const brief = watchdogBrief({ stalled: [], summary: summarizeTickets([]), now: NOW })

  assert.match(brief, /^## Watchdog brief — /)
  assert.ok(brief.includes(ago(0)))
  assert.match(brief, /No stalled open tickets\./)
  assert.doesNotMatch(brief, /^- `/m)
})
