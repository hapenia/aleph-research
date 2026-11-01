/**
 * Best-result tracking for the AlephResearch extension.
 *
 * The Host appends one JSON line per evaluation to `<dir>/results.jsonl`, and the
 * research loop reads that history back to answer two questions: how good is the best
 * commit so far, and is there any sign of progress worth more exploration?
 *
 * Reading is deliberately tolerant. A torn, foreign or malformed line never fails a
 * read, and only records with a finite numeric `score` take part in the analytics.
 * Writing is append-only and idempotent by `evaluationId`; the writers of one log are
 * serialized so two concurrent submissions of the same evaluation cannot both append.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

/** Name of the append-only evaluation log inside a results directory. */
const RESULTS_FILE = 'results.jsonl'

/** Schema version written for every new record. */
const RECORD_VERSION = 1

/**
 * Pending write chain per log file. Appends from this process are serialized so the
 * idempotency check and the append cannot interleave with a second submission.
 * @type {Map<string, Promise<void>>}
 */
const writeQueues = new Map()

/**
 * Append one evaluation to `<dir>/results.jsonl` and return the stored record.
 *
 * The log is append-only and idempotent by `evaluationId`: when an id is already in
 * the file the record stored first is returned and nothing is written. The directory
 * is created recursively and a missing `at` becomes the current ISO time.
 *
 * @param {string} dir results directory
 * @param {{
 *   evaluationId: string,
 *   project?: string | null,
 *   ticketId?: string | null,
 *   thread?: string | null,
 *   score?: number | null,
 *   commit?: string | null,
 *   at?: string | Date | null,
 * }} fields
 * @returns {Promise<{
 *   version: number,
 *   evaluationId: string,
 *   project: string | null,
 *   ticketId: string | null,
 *   thread: string | null,
 *   score: number | null,
 *   commit: string | null,
 *   at: string,
 * }>}
 */
export async function recordResult(dir, fields = {}) {
  if (typeof dir !== 'string' || dir.length === 0) {
    throw new TypeError('recordResult requires a results directory')
  }
  const input = fields ?? {}
  const evaluationId = normaliseId(input.evaluationId)
  if (evaluationId === null) {
    throw new TypeError('recordResult requires a non-empty evaluationId')
  }

  const record = {
    version: RECORD_VERSION,
    evaluationId,
    project: input.project ?? null,
    ticketId: input.ticketId ?? null,
    thread: input.thread ?? null,
    score: normaliseScore(input.score),
    commit: input.commit ?? null,
    at: normaliseAt(input.at),
  }

  return await enqueueWrite(path.resolve(dir, RESULTS_FILE), async () => {
    await mkdir(dir, { recursive: true })
    const existing = await readResults(dir)
    const duplicate = existing.find((entry) => entry.evaluationId === evaluationId)
    if (duplicate) return duplicate
    await appendFile(resultsFile(dir), `${JSON.stringify(record)}\n`, 'utf8')
    return record
  })
}

/**
 * Read every valid record of `<dir>/results.jsonl` in file order.
 *
 * A missing (or unreadable) log reads as no evaluations; blank, malformed and
 * non-object lines are skipped. Records whose `score` is not a finite number are
 * still returned, so the history keeps its evidence even when a run produced no score.
 *
 * @param {string} dir results directory
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function readResults(dir) {
  if (typeof dir !== 'string' || dir.length === 0) return []
  let text
  try {
    text = await readFile(resultsFile(dir), 'utf8')
  } catch {
    // A missing log is normal before the first evaluation; a torn one is not fatal.
    return []
  }
  return parseResults(text)
}

/**
 * The record with the highest score; ties go to the earliest record.
 *
 * @param {Array<Record<string, unknown>>} records
 * @param {{ project?: string | null, thread?: string | null }} [filter]
 * @returns {Record<string, unknown> | null} null when no record carries a finite score
 */
export function bestResult(records, filter = {}) {
  let best = null
  let bestScore = null
  for (const record of scoredRecords(records, filter)) {
    const score = scoreOf(record)
    if (bestScore === null || score > bestScore) {
      best = record
      bestScore = score
    }
  }
  return best
}

/**
 * The chronological score series a chart can draw, oldest first.
 *
 * @param {Array<Record<string, unknown>>} records
 * @param {{ project?: string | null, thread?: string | null }} [filter]
 * @returns {Array<{ at: unknown, score: number, commit: unknown, ticketId: unknown, evaluationId: unknown }>}
 */
export function scoreTrajectory(records, filter = {}) {
  const trajectory = []
  for (const record of scoredRecords(records, filter)) {
    trajectory.push({
      at: record.at ?? null,
      score: scoreOf(record),
      commit: record.commit ?? null,
      ticketId: record.ticketId ?? null,
      evaluationId: record.evaluationId ?? null,
    })
  }
  return trajectory
}

/**
 * Aggregate numbers over the filtered, scored records.
 *
 * `first` and `latest` are scores, and `improvement = latest - first`. The result is
 * null-filled when no record carries a finite score; `improved` is then `false`.
 *
 * @param {Array<Record<string, unknown>>} records
 * @param {{ project?: string | null, thread?: string | null }} [filter]
 * @returns {{
 *   count: number,
 *   best: number | null,
 *   bestAt: unknown,
 *   bestCommit: unknown,
 *   latest: number | null,
 *   latestAt: unknown,
 *   first: number | null,
 *   improved: boolean,
 *   improvement: number | null,
 *   median: number | null,
 *   mean: number | null,
 * }}
 */
export function summarizeResults(records, filter = {}) {
  const scored = scoredRecords(records, filter)
  if (scored.length === 0) {
    return {
      count: 0,
      best: null,
      bestAt: null,
      bestCommit: null,
      latest: null,
      latestAt: null,
      first: null,
      improved: false,
      improvement: null,
      median: null,
      mean: null,
    }
  }

  const scores = scored.map((record) => scoreOf(record))
  let best = scored[0]
  let bestScore = scores[0]
  for (let index = 1; index < scored.length; index += 1) {
    // Strictly greater keeps the earliest record on a tie.
    if (scores[index] > bestScore) {
      bestScore = scores[index]
      best = scored[index]
    }
  }

  const latestRecord = scored[scored.length - 1]
  const latest = scores[scores.length - 1]
  const first = scores[0]
  const improvement = latest - first
  const sortedScores = [...scores].sort((left, right) => left - right)
  const middle = Math.floor(sortedScores.length / 2)
  const median = sortedScores.length % 2 === 1
    ? sortedScores[middle]
    : (sortedScores[middle - 1] + sortedScores[middle]) / 2
  const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length

  return {
    count: scored.length,
    best: bestScore,
    bestAt: best.at ?? null,
    bestCommit: best.commit ?? null,
    latest,
    latestAt: latestRecord.at ?? null,
    first,
    improved: improvement > 0,
    improvement,
    median,
    mean,
  }
}

/**
 * One Markdown brief for the main Session: the best line, the latest line, the
 * improvement line, and the last five evaluations newest first.
 *
 * @param {Array<Record<string, unknown>>} records
 * @param {{ project?: string | null, thread?: string | null }} [filter]
 * @returns {string}
 */
export function resultsBrief(records, filter = {}) {
  const summary = summarizeResults(records, filter)
  if (summary.count === 0) return 'No evaluations yet.'

  const lines = [
    '## Research results',
    '',
    `- best: ${formatNumber(summary.best)}${describeCommit(summary.bestCommit)}${describeAt(summary.bestAt)}`,
    `- latest: ${formatNumber(summary.latest)}${describeAt(summary.latestAt)}`,
    `- improvement: ${describeImprovement(summary)}`,
    '- last 5 evaluations (newest first):',
  ]
  const newestFirst = scoredRecords(records, filter).slice(-5).reverse()
  for (const record of newestFirst) {
    lines.push(
      `  - ${formatNumber(scoreOf(record))}${describeAt(record.at)}${describeCommit(record.commit)}${describeTicket(record.ticketId)}`,
    )
  }
  return lines.join('\n')
}

/** Absolute path of the log inside `dir`. */
function resultsFile(dir) {
  return path.join(dir, RESULTS_FILE)
}

/**
 * Run `task` after every earlier write to the same log has settled, and return its
 * result. Failures of earlier writes do not block later ones; the caller still sees
 * only the failure of its own write.
 */
function enqueueWrite(key, task) {
  const previous = writeQueues.get(key) ?? Promise.resolve()
  const current = previous.then(() => task())
  const settled = current.then(() => {}, () => {})
  writeQueues.set(key, settled)
  settled.then(() => {
    if (writeQueues.get(key) === settled) writeQueues.delete(key)
  })
  return current
}

/** Parse log text into records, skipping everything that is not a valid record. */
function parseResults(text) {
  const records = []
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    const record = asRecord(parsed)
    if (record) records.push(record)
  }
  return records
}

/**
 * Normalize one parsed JSON value to a record, or null when it cannot be one.
 * The required identity is `evaluationId`, because every other operation is
 * anchored on it; all other fields are optional and default to null.
 */
function asRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const evaluationId = normaliseId(value.evaluationId)
  if (evaluationId === null) return null
  return {
    ...value,
    version: value.version ?? RECORD_VERSION,
    evaluationId,
    project: value.project ?? null,
    ticketId: value.ticketId ?? null,
    thread: value.thread ?? null,
    score: value.score ?? null,
    commit: value.commit ?? null,
    at: value.at ?? null,
  }
}

/** A non-empty id (a string is trimmed), or null when the value cannot serve as one. */
function normaliseId(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? null : trimmed
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

/**
 * Keep a score verbatim unless it is a non-finite number, which JSON cannot store;
 * such a score is stored as null and later ignored by the analytics.
 */
function normaliseScore(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (value === undefined || value === null) return null
  return value
}

/** An ISO timestamp for a missing or unusable `at`. */
function normaliseAt(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? new Date().toISOString() : value.toISOString()
  }
  if (typeof value === 'string' && value.length > 0) return value
  return new Date().toISOString()
}

/** Filtered records in chronological order; ties keep their insertion order. */
function filteredRecords(records, filter) {
  const list = Array.isArray(records) ? records : []
  const scope = typeof filter === 'object' && filter !== null ? filter : {}
  const project = scope.project
  const thread = scope.thread
  const kept = []
  for (let index = 0; index < list.length; index += 1) {
    const record = list[index]
    if (typeof record !== 'object' || record === null || Array.isArray(record)) continue
    if (project != null && record.project !== project) continue
    if (thread != null && record.thread !== thread) continue
    kept.push({ record, index })
  }
  kept.sort((left, right) => {
    const leftTime = timeOf(left.record)
    const rightTime = timeOf(right.record)
    if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1
    return left.index - right.index
  })
  return kept.map((entry) => entry.record)
}

/** Records that can be charted: plain objects carrying a finite numeric score. */
function scoredRecords(records, filter) {
  return filteredRecords(records, filter).filter((record) => scoreOf(record) !== null)
}

/** The finite numeric score of a record, or null. */
function scoreOf(record) {
  const score = record?.score
  return typeof score === 'number' && Number.isFinite(score) ? score : null
}

/** A comparable timestamp; missing or unparseable times sort before real ones. */
function timeOf(record) {
  const at = record.at
  if (typeof at !== 'string' || at === '') return Number.NEGATIVE_INFINITY
  const time = Date.parse(at)
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY
}

/** Render a score without trailing float noise, e.g. 80.5 instead of 80.5000001. */
function formatNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a'
  if (Number.isInteger(value)) return String(value)
  return String(Number(value.toFixed(4)))
}

/**
 * The improvement line: with one record there is no earlier score to compare with;
 * a gain reads as `+10 since first`, a loss or a plateau as the signed number alone.
 */
function describeImprovement(summary) {
  if (summary.count === 1) return 'first evaluation'
  if (summary.improved) return `+${formatNumber(summary.improvement)} since first`
  return formatNumber(summary.improvement)
}

function describeCommit(commit) {
  return typeof commit === 'string' && commit !== '' ? `, commit \`${commit}\`` : ''
}

function describeAt(at) {
  return typeof at === 'string' && at !== '' ? ` at ${at}` : ''
}

function describeTicket(ticketId) {
  return typeof ticketId === 'string' && ticketId !== '' ? `, ticket ${ticketId}` : ''
}
