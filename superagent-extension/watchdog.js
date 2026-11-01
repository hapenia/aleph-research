/**
 * Watchdog stall detection over the open Tickets of the `aleph` Source.
 *
 * A future Watchdog Session polls the open Tickets of the research Source and needs to
 * know which work stopped making progress, so it can stop or retry that work through the
 * management API. Everything here is pure and synchronous: the Session supplies the
 * snapshot and the clock, so detection can be replayed and tested without a runtime.
 *
 * The ticket shape read here is the plain object of the prototype: `id`, `title`,
 * `updatedAt`, `assignments` (`{ state: 'pending' | 'running' | 'ended', startedAt? }`),
 * `execution` (`{ name, directory }`), and optionally `attention` and `ended`. Tickets
 * returned by the store append assignments, so the last assignment is the newest one.
 *
 * Times are ISO strings in the domain and in the entries below. A missing or malformed
 * time never makes a ticket look stalled: the Watchdog acts on work, so an unreadable
 * snapshot is a reason to leave the ticket alone, never to stop it.
 */

/** A running assignment with no newer activity for this long is stalled. */
export const DEFAULT_STALE_MS = 45 * 60 * 1000

/** Beyond this multiple of `staleMs` a stuck ticket is stopped rather than retried. */
const STOP_FACTOR = 3

/** The brief's marker for a stalled ticket that waits for a person, who must act first. */
const BLOCKED_ON_PERSON = 'blocked-on-person'

/**
 * One stalled open ticket. Besides the fields named by the stall detector contract, the
 * entry carries `attention`, because the brief must mark a stalled ticket that waits for a
 * person as `blocked-on-person` without re-reading the snapshot.
 * @typedef {object} StalledTicket
 * @property {string} ticketId
 * @property {string} title
 * @property {string | null} directory the execution directory a stop or retry would target
 * @property {'assignment-stalled' | 'no-assignment'} reason
 * @property {number} staleMs the threshold this detection used
 * @property {string} lastUpdate ISO time of the latest known activity
 * @property {string | null} assignmentStartedAt ISO start of the newest assignment
 * @property {number} stuckForMs how long the latest activity lies in the past
 * @property {boolean} attention the ticket waits for a person; do not suggest stop or retry
 */

/**
 * Counts over one ticket snapshot.
 * @typedef {{ total: number, running: number, pending: number, attention: number, stalled: number }} TicketSummary
 */

/** True for a plain object, the shape of every ticket and options bag read here. */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Normalize a ticket time to epoch milliseconds.
 * Accepts a Date, a finite number and a string `Date.parse` understands; anything else,
 * including an empty string, reads as `null` so the caller can treat the time as unknown.
 * @param {unknown} value
 * @returns {number | null}
 */
function toEpochMs(value) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.getTime() : null
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '') return null
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Validate the options of a detection run and resolve the clock.
 * A missing or unreadable `now` falls back to the wall clock; the detector is a poll, not
 * a replay tool, so the current time is always a better guess than a failed poll.
 * @param {unknown} options
 * @returns {{ nowMs: number, staleMs: number }}
 * @throws {TypeError} when `staleMs` is not a finite positive number of milliseconds
 */
function readOptions(options) {
  const settings = isRecord(options) ? options : {}
  const staleMs = settings.staleMs === undefined ? DEFAULT_STALE_MS : settings.staleMs
  if (!Number.isFinite(staleMs) || staleMs <= 0) {
    throw new TypeError(`staleMs must be a finite positive number of milliseconds, got ${String(staleMs)}`)
  }
  const nowMs = toEpochMs(settings.now) ?? Date.now()
  return { nowMs, staleMs }
}

/** The directory a Watchdog action would target, or `null` when the ticket does not say. */
function readDirectory(ticket) {
  const execution = ticket.execution
  if (!isRecord(execution) || typeof execution.directory !== 'string') return null
  return execution.directory.trim() === '' ? null : execution.directory
}

/**
 * The assignment list of a ticket: `[]` when the ticket has none, a list as stored, or
 * `null` when the field is present but not a list, a shape this module refuses to guess
 * about.
 */
function readAssignments(ticket) {
  const value = ticket.assignments
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : null
}

/** State of the newest assignment, or `null` when the ticket has no readable assignment. */
function newestAssignmentState(ticket) {
  const assignments = readAssignments(ticket)
  if (assignments === null) return null
  const newest = assignments[assignments.length - 1]
  return isRecord(newest) && typeof newest.state === 'string' ? newest.state : null
}

/**
 * One entry for a ticket that is stalled, or `null` for an open ticket that is not.
 * A ticket with no assignments stalls on its own last update; a running assignment stalls
 * when neither the ticket nor the assignment has moved for `staleMs`, and the assignment
 * has been running for at least that long. Both rules stay silent when a needed time is
 * missing or malformed.
 * @param {unknown} ticket
 * @param {{ nowMs: number, staleMs: number }} context
 * @returns {StalledTicket | null}
 */
function stalledEntry(ticket, { nowMs, staleMs }) {
  if (!isRecord(ticket) || ticket.ended) return null
  const ticketId = typeof ticket.id === 'string' && ticket.id !== '' ? ticket.id : null
  if (ticketId === null) return null

  const base = {
    ticketId,
    title: typeof ticket.title === 'string' ? ticket.title : '',
    directory: readDirectory(ticket),
    staleMs,
    attention: Boolean(ticket.attention),
  }

  const assignments = readAssignments(ticket)
  if (assignments === null) return null
  if (assignments.length === 0) {
    const updatedAtMs = toEpochMs(ticket.updatedAt)
    if (updatedAtMs === null) return null
    const stuckForMs = nowMs - updatedAtMs
    if (stuckForMs <= staleMs) return null
    return {
      ...base,
      reason: 'no-assignment',
      lastUpdate: new Date(updatedAtMs).toISOString(),
      assignmentStartedAt: null,
      stuckForMs,
    }
  }

  const newest = assignments[assignments.length - 1]
  if (!isRecord(newest) || newest.state !== 'running') return null
  const updatedAtMs = toEpochMs(ticket.updatedAt)
  const startedAtMs = toEpochMs(newest.startedAt)
  if (updatedAtMs === null || startedAtMs === null) return null

  const lastActiveMs = Math.max(updatedAtMs, startedAtMs)
  const stuckForMs = nowMs - lastActiveMs
  // `stuckForMs <= staleMs` already implies an old start while the clocks agree; the
  // explicit start check keeps the "started at least staleMs ago" rule visible.
  if (stuckForMs <= staleMs || nowMs - startedAtMs < staleMs) return null

  return {
    ...base,
    reason: 'assignment-stalled',
    lastUpdate: new Date(lastActiveMs).toISOString(),
    assignmentStartedAt: new Date(startedAtMs).toISOString(),
    stuckForMs,
  }
}

/**
 * Find every stalled open ticket in the given snapshot, the most stuck update first.
 * @param {unknown} tickets the open Tickets of the Source
 * @param {{ now?: number | Date | string, staleMs?: number }} [options]
 * @returns {StalledTicket[]}
 * @throws {TypeError} when `staleMs` is not a finite positive number
 */
export function findStalledTickets(tickets, options = {}) {
  const { nowMs, staleMs } = readOptions(options)
  const list = Array.isArray(tickets) ? tickets : []
  const found = []
  for (const ticket of list) {
    const entry = stalledEntry(ticket, { nowMs, staleMs })
    if (entry !== null) found.push(entry)
  }
  return found.sort((left, right) => Date.parse(left.lastUpdate) - Date.parse(right.lastUpdate))
}

/**
 * Count the tickets of a snapshot for the brief: every well-formed ticket, by the state of
 * its newest assignment and by whether it waits for a person.
 *
 * This helper is total: malformed tickets and malformed options cannot make it throw. An
 * invalid `staleMs` counts as zero stalled instead of raising, so a broken configuration
 * still renders a brief; call `findStalledTickets` directly when the options must be
 * validated strictly.
 * @param {unknown} tickets
 * @param {{ now?: number | Date | string, staleMs?: number }} [options]
 * @returns {TicketSummary}
 */
export function summarizeTickets(tickets, options = {}) {
  const list = Array.isArray(tickets) ? tickets : []
  const summary = { total: 0, running: 0, pending: 0, attention: 0, stalled: 0 }
  for (const ticket of list) {
    if (!isRecord(ticket)) continue
    summary.total += 1
    const state = newestAssignmentState(ticket)
    if (state === 'running') summary.running += 1
    else if (state === 'pending') summary.pending += 1
    if (ticket.attention) summary.attention += 1
  }
  try {
    summary.stalled = findStalledTickets(list, options).length
  } catch {
    summary.stalled = 0
  }
  return summary
}

/** A count from a summary object, or `fallback` when the value is not a finite count. */
function finiteCount(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback
}

/** One line of text, so a title or directory can never break a bullet in two. */
function oneLine(value) {
  return String(value).replace(/\s+/g, ' ').trim()
}

/** `45m`, `1h 30m`, `2d 3h`: the wait a person reads in the brief. */
function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`
}

/** `stop` for work stuck beyond three thresholds, `retry-or-check` otherwise. */
function suggestedAction(stuckForMs, staleMs) {
  if (stuckForMs !== null && stuckForMs > STOP_FACTOR * staleMs) return 'stop'
  return 'retry-or-check'
}

/**
 * One Markdown bullet for a stalled ticket: what it is, the directory to act in, the
 * evidence of the stall, and the suggested action. A ticket with an attention question is
 * marked `blocked-on-person` and gets no stop or retry suggestion: a person answers first.
 * @param {StalledTicket} entry
 * @returns {string}
 */
function briefBullet(entry) {
  const ticketId = typeof entry.ticketId === 'string' && entry.ticketId !== '' ? entry.ticketId : '(unknown ticket)'
  const title = typeof entry.title === 'string' && entry.title.trim() !== '' ? ` "${oneLine(entry.title)}"` : ''
  const directory = typeof entry.directory === 'string' && entry.directory !== '' ? entry.directory : '(unknown)'
  const staleMs = Number.isFinite(entry.staleMs) && entry.staleMs > 0 ? entry.staleMs : DEFAULT_STALE_MS
  const stuckForMs = Number.isFinite(entry.stuckForMs) && entry.stuckForMs > 0 ? entry.stuckForMs : null

  const facts = [
    entry.reason === 'no-assignment' ? 'no assignment' : 'newest assignment is running',
  ]
  if (typeof entry.assignmentStartedAt === 'string' && entry.assignmentStartedAt !== '') {
    facts.push(`started ${oneLine(entry.assignmentStartedAt)}`)
  }
  if (typeof entry.lastUpdate === 'string' && entry.lastUpdate !== '') {
    facts.push(`last update ${oneLine(entry.lastUpdate)}`)
  }
  if (stuckForMs !== null) facts.push(`stuck for ${formatDuration(stuckForMs)}`)

  const head = `- \`${oneLine(ticketId)}\`${title} — directory: \`${oneLine(directory)}\``
  if (entry.attention) {
    return `${head} — ${facts.join('; ')} — **${BLOCKED_ON_PERSON}**: a person must answer before the Watchdog acts`
  }
  return `${head} — ${facts.join('; ')} — suggested action: **${suggestedAction(stuckForMs, staleMs)}**`
}

/**
 * Render the short Markdown brief a Watchdog Session reads: the header with the snapshot
 * time, the counts, and one bullet per stalled ticket with its directory and suggested
 * action. The helper tolerates missing parts, so a brief is always produced.
 * @param {{ stalled?: StalledTicket[], summary?: TicketSummary, now?: number | Date | string }} [input]
 * @returns {string}
 */
export function watchdogBrief({ stalled, summary, now = Date.now() } = {}) {
  const entries = Array.isArray(stalled) ? stalled.filter(isRecord) : []
  const counts = isRecord(summary) ? summary : {}
  const generatedAt = new Date(toEpochMs(now) ?? Date.now()).toISOString()

  const lines = [
    `## Watchdog brief — ${generatedAt}`,
    '',
    `Tickets: ${finiteCount(counts.total, entries.length)} total · ` +
      `${finiteCount(counts.running)} running · ${finiteCount(counts.pending)} pending · ` +
      `${finiteCount(counts.attention)} with attention · ${finiteCount(counts.stalled, entries.length)} stalled`,
  ]

  if (entries.length === 0) {
    lines.push('', 'No stalled open tickets.')
    return lines.join('\n')
  }

  lines.push('')
  for (const entry of entries) lines.push(briefBullet(entry))
  return lines.join('\n')
}
