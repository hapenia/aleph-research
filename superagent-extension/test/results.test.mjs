import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  bestResult,
  readResults,
  recordResult,
  resultsBrief,
  scoreTrajectory,
  summarizeResults,
} from '../results.js'

/** Make a record that looks like the tracker's own output. */
function makeRecord({
  evaluationId,
  score = null,
  project = null,
  ticketId = null,
  thread = null,
  commit = null,
  at = null,
}) {
  return { version: 1, evaluationId, project, ticketId, thread, score, commit, at }
}

/** Run `fn` with a throwaway results directory and remove the temp tree afterwards. */
async function withResultsDir(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'aleph-results-'))
  try {
    return await fn(path.join(root, 'results'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** The non-empty lines of the JSONL log, exactly as stored. */
async function readLogLines(dir) {
  const text = await readFile(path.join(dir, 'results.jsonl'), 'utf8')
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
}

const emptySummary = {
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

test('recordResult appends a record and readResults reads it back', async () => {
  await withResultsDir(async (dir) => {
    const stored = await recordResult(dir, {
      evaluationId: 'eval-1',
      project: 'fixture',
      ticketId: 'ticket-a',
      thread: 'research:fixture',
      score: 72.5,
      commit: 'abc123',
      at: '2026-01-01T00:00:00.000Z',
    })

    assert.deepEqual(stored, {
      version: 1,
      evaluationId: 'eval-1',
      project: 'fixture',
      ticketId: 'ticket-a',
      thread: 'research:fixture',
      score: 72.5,
      commit: 'abc123',
      at: '2026-01-01T00:00:00.000Z',
    })
    assert.deepEqual(await readResults(dir), [stored])

    const lines = await readLogLines(dir)
    assert.equal(lines.length, 1)
    assert.deepEqual(JSON.parse(lines[0]), stored)
  })
})

test('recordResult creates the directory and defaults a missing at to now', async () => {
  await withResultsDir(async (dir) => {
    const nested = path.join(dir, 'nested', 'results')
    const before = Date.now()
    const stored = await recordResult(nested, { evaluationId: 'eval-time' })
    const after = Date.now()

    assert.equal(stored.project, null)
    assert.equal(stored.ticketId, null)
    assert.equal(stored.thread, null)
    assert.equal(stored.score, null)
    assert.equal(stored.commit, null)
    const at = Date.parse(stored.at)
    assert.ok(at >= before && at <= after, `at ${stored.at} should be the current time`)
    assert.equal((await readResults(nested)).length, 1)
  })
})

test('recordResult is idempotent by evaluationId', async () => {
  await withResultsDir(async (dir) => {
    const first = await recordResult(dir, {
      evaluationId: 'eval-1',
      score: 60,
      commit: 'aaa',
      at: '2026-01-01T00:00:00.000Z',
    })
    const duplicate = await recordResult(dir, {
      evaluationId: 'eval-1',
      score: 99,
      commit: 'bbb',
      at: '2026-01-02T00:00:00.000Z',
    })

    assert.deepEqual(duplicate, first)
    assert.equal((await readLogLines(dir)).length, 1)
    assert.equal((await readResults(dir)).length, 1)

    await recordResult(dir, { evaluationId: 'eval-2', score: 70 })
    assert.deepEqual(
      (await readResults(dir)).map((record) => record.evaluationId),
      ['eval-1', 'eval-2'],
    )
  })
})

test('concurrent recordResult calls for one evaluationId append a single line', async () => {
  await withResultsDir(async (dir) => {
    const writes = Array.from({ length: 6 }, () => recordResult(dir, { evaluationId: 'eval-race', score: 50 }))
    const results = await Promise.all(writes)

    assert.equal(results.every((record) => record.evaluationId === 'eval-race'), true)
    assert.equal((await readLogLines(dir)).length, 1)
    assert.equal((await readResults(dir)).length, 1)
  })
})

test('recordResult rejects a missing evaluationId and leaves the log untouched', async () => {
  await withResultsDir(async (dir) => {
    await assert.rejects(() => recordResult(dir, { score: 1 }), /evaluationId/)
    await assert.rejects(() => recordResult(dir, { evaluationId: '   ' }), /evaluationId/)
    assert.deepEqual(await readResults(dir), [])
    await assert.rejects(() => recordResult('', { evaluationId: 'x' }), /results directory/)
  })
})

test('readResults treats a missing log as empty', async () => {
  await withResultsDir(async (dir) => {
    assert.deepEqual(await readResults(dir), [])
    assert.deepEqual(await readResults(path.join(dir, 'does-not-exist')), [])
  })
})

test('readResults skips malformed lines and non-object values', async () => {
  await withResultsDir(async (dir) => {
    await mkdir(dir, { recursive: true })
    const good = JSON.stringify({
      version: 1,
      evaluationId: 'ok-1',
      project: 'p',
      ticketId: null,
      thread: null,
      score: 12,
      commit: 'c1',
      at: '2026-01-01T00:00:00.000Z',
    })
    const goodWithoutScore = JSON.stringify({
      version: 1,
      evaluationId: 'ok-2',
      score: null,
      at: '2026-01-02T00:00:00.000Z',
    })
    await writeFile(
      path.join(dir, 'results.jsonl'),
      [
        '',
        'not json at all',
        good,
        '[1,2,3]',
        '"just a string"',
        'null',
        '{"project":"p"}',
        '   ',
        goodWithoutScore,
        '{"evaluationId":"torn"',
      ].join('\n'),
      'utf8',
    )

    const records = await readResults(dir)
    assert.deepEqual(records.map((record) => record.evaluationId), ['ok-1', 'ok-2'])
    assert.equal(records[0].score, 12)
    assert.equal(records[1].score, null)
    assert.equal(records[1].project, null)
  })
})

test('analytics ignore records without a finite score but readResults keeps them', async () => {
  await withResultsDir(async (dir) => {
    await recordResult(dir, { evaluationId: 'scored', score: 10, at: '2026-01-02T00:00:00.000Z' })
    await recordResult(dir, { evaluationId: 'unscored', score: null, at: '2026-01-03T00:00:00.000Z' })
    await recordResult(dir, { evaluationId: 'string-score', score: 'not a score', at: '2026-01-01T00:00:00.000Z' })

    const records = await readResults(dir)
    assert.equal(records.length, 3)
    assert.equal(bestResult(records).evaluationId, 'scored')
    assert.deepEqual(scoreTrajectory(records).map((entry) => entry.evaluationId), ['scored'])
    assert.equal(summarizeResults(records).count, 1)
  })
})

test('bestResult picks the highest score and ties go to the earliest record', () => {
  const records = [
    makeRecord({ evaluationId: 'later-best', score: 90, commit: 'later', at: '2026-02-01T00:00:00.000Z' }),
    makeRecord({ evaluationId: 'earlier-best', score: 90, commit: 'earlier', at: '2026-01-01T00:00:00.000Z' }),
    makeRecord({ evaluationId: 'low', score: 40, commit: 'low', at: '2026-03-01T00:00:00.000Z' }),
  ]
  const best = bestResult(records)
  assert.equal(best.evaluationId, 'earlier-best')
  assert.equal(best.score, 90)
  assert.equal(best.commit, 'earlier')

  // Equal times are a tie too: the earlier record in file order wins.
  const sameTime = [
    makeRecord({ evaluationId: 'second-in-file', score: 90, at: '2026-01-01T00:00:00.000Z' }),
    makeRecord({ evaluationId: 'first-in-file', score: 90, at: '2026-01-01T00:00:00.000Z' }),
  ]
  assert.equal(bestResult(sameTime).evaluationId, 'second-in-file')
})

test('bestResult is null and the other aggregations are empty-safe', () => {
  assert.equal(bestResult([]), null)
  assert.equal(
    bestResult([null, 42, 'record', { score: null }, { score: Number.NaN }, { score: Number.POSITIVE_INFINITY }]),
    null,
  )
  assert.deepEqual(scoreTrajectory([null, { score: 'x' }]), [])
  assert.deepEqual(summarizeResults([null, { score: null }]), emptySummary)
  assert.equal(resultsBrief([null, { score: null }]), 'No evaluations yet.')
})

test('filters narrow best, trajectory, summary and brief by project or thread', () => {
  const records = [
    makeRecord({ evaluationId: 'a', project: 'p1', thread: 'thread-1', score: 10, at: '2026-01-01T00:00:00.000Z' }),
    makeRecord({ evaluationId: 'b', project: 'p1', thread: 'thread-2', score: 30, at: '2026-01-02T00:00:00.000Z' }),
    makeRecord({ evaluationId: 'c', project: 'p2', thread: 'thread-1', score: 20, at: '2026-01-03T00:00:00.000Z' }),
  ]

  assert.equal(bestResult(records, { project: 'p1' }).evaluationId, 'b')
  assert.equal(bestResult(records, { thread: 'thread-1' }).evaluationId, 'c')
  assert.equal(bestResult(records, { project: 'p1', thread: 'thread-1' }).evaluationId, 'a')
  assert.equal(bestResult(records, { project: 'missing' }), null)
  assert.deepEqual(scoreTrajectory(records, { project: 'p2' }).map((entry) => entry.evaluationId), ['c'])
  assert.equal(summarizeResults(records, { thread: 'thread-2' }).count, 1)
  assert.match(resultsBrief(records, { project: 'p1' }), /best: 30/)
  assert.match(resultsBrief(records, { project: 'missing' }), /no evaluations yet/i)
})

test('scoreTrajectory is chronological and projects the chart fields', () => {
  const records = [
    makeRecord({ evaluationId: 'third', score: 30, commit: 'c3', ticketId: 't3', at: '2026-01-03T00:00:00.000Z' }),
    makeRecord({ evaluationId: 'first', score: 10, commit: 'c1', ticketId: 't1', at: '2026-01-01T00:00:00.000Z' }),
    makeRecord({ evaluationId: 'no-score', score: null, at: '2026-01-02T00:00:00.000Z' }),
    makeRecord({ evaluationId: 'second', score: 20, commit: 'c2', ticketId: 't2', at: '2026-01-02T00:00:00.000Z' }),
    makeRecord({ evaluationId: 'second-tie', score: 25, at: '2026-01-02T00:00:00.000Z' }),
  ]

  assert.deepEqual(scoreTrajectory(records), [
    { at: '2026-01-01T00:00:00.000Z', score: 10, commit: 'c1', ticketId: 't1', evaluationId: 'first' },
    { at: '2026-01-02T00:00:00.000Z', score: 20, commit: 'c2', ticketId: 't2', evaluationId: 'second' },
    { at: '2026-01-02T00:00:00.000Z', score: 25, commit: null, ticketId: null, evaluationId: 'second-tie' },
    { at: '2026-01-03T00:00:00.000Z', score: 30, commit: 'c3', ticketId: 't3', evaluationId: 'third' },
  ])
})

test('summarizeResults reports count, best, latest, first, median, mean and improvement', () => {
  const records = [
    makeRecord({ evaluationId: 'a', score: 10, commit: 'c1', at: '2026-01-01T00:00:00.000Z' }),
    makeRecord({ evaluationId: 'b', score: 60, commit: 'c2', at: '2026-01-02T00:00:00.000Z' }),
    makeRecord({ evaluationId: 'c', score: 20, commit: 'c3', at: '2026-01-03T00:00:00.000Z' }),
    makeRecord({ evaluationId: 'd', score: 30, commit: 'c4', at: '2026-01-04T00:00:00.000Z' }),
  ]

  assert.deepEqual(summarizeResults(records), {
    count: 4,
    best: 60,
    bestAt: '2026-01-02T00:00:00.000Z',
    bestCommit: 'c2',
    latest: 30,
    latestAt: '2026-01-04T00:00:00.000Z',
    first: 10,
    improved: true,
    improvement: 20,
    median: 25,
    mean: 30,
  })
})

test('summarizeResults handles an odd count, a plateau and a falling score', () => {
  const falling = summarizeResults([
    makeRecord({ evaluationId: 'a', score: 50, at: '2026-01-01T00:00:00.000Z' }),
    makeRecord({ evaluationId: 'b', score: 20, at: '2026-01-02T00:00:00.000Z' }),
    makeRecord({ evaluationId: 'c', score: 10, at: '2026-01-03T00:00:00.000Z' }),
  ])
  assert.equal(falling.count, 3)
  assert.equal(falling.best, 50)
  assert.equal(falling.bestAt, '2026-01-01T00:00:00.000Z')
  assert.equal(falling.latest, 10)
  assert.equal(falling.first, 50)
  assert.equal(falling.improvement, -40)
  assert.equal(falling.improved, false)
  assert.equal(falling.median, 20)
  assert.equal(falling.mean, 80 / 3)

  const plateau = summarizeResults([
    makeRecord({ evaluationId: 'p1', score: 25, at: '2026-01-01T00:00:00.000Z' }),
    makeRecord({ evaluationId: 'p2', score: 25, at: '2026-01-02T00:00:00.000Z' }),
  ])
  assert.equal(plateau.improvement, 0)
  assert.equal(plateau.improved, false)
  assert.equal(plateau.median, 25)
})

test('resultsBrief is a single line when nothing was evaluated', () => {
  const brief = resultsBrief([])
  assert.equal(brief.split('\n').length, 1)
  assert.match(brief, /no evaluations yet/i)
})

test('resultsBrief reports best, latest, improvement and the five newest evaluations', () => {
  const records = Array.from({ length: 7 }, (_, index) => makeRecord({
    evaluationId: `eval-${index + 1}`,
    score: (index + 1) * 10,
    commit: `commit-${index + 1}`,
    ticketId: `ticket-${index + 1}`,
    at: `2026-01-0${index + 1}T00:00:00.000Z`,
  }))

  const brief = resultsBrief(records)
  assert.match(brief, /- best: 70, commit `commit-7`/)
  assert.match(brief, /- latest: 70/)
  assert.match(brief, /- improvement: \+60 since first/)

  const recordLines = brief.split('\n').filter((line) => line.startsWith('  - '))
  assert.equal(recordLines.length, 5)
  assert.match(recordLines[0], /70/)
  assert.match(recordLines[0], /commit-7/)
  assert.match(recordLines[4], /30/)
  assert.equal(recordLines.some((line) => /ticket-(1|2)\b/.test(line)), false)
})

test('resultsBrief says first evaluation for one record and tolerates sparse records', () => {
  const single = resultsBrief([makeRecord({ evaluationId: 'only', score: 5 })])
  assert.match(single, /- best: 5/)
  assert.match(single, /- latest: 5/)
  assert.match(single, /- improvement: first evaluation/)

  const sparse = resultsBrief([
    makeRecord({ evaluationId: 'a', score: 5 }),
    makeRecord({ evaluationId: 'b', score: 9 }),
  ])
  assert.match(sparse, /- improvement: \+4 since first/)
  assert.match(sparse, /  - 5/)
})
