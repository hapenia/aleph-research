/**
 * Contract tests for the DSH storage-domain adapter.
 *
 * The fake `DomainStore` is deliberately small and independent of DSH: it records every
 * put attempt (including refused ones), keeps insertion order for append tables, and
 * implements the same expected-version check the real adapter must implement. The
 * fixtures are rows hydrated through `src/hydration.ts`, so the tests exercise the same
 * boundary a persisted row crosses on read instead of fabricating class instances.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createStorageDomainUnitOfWork, DomainStoreFailure } from '../src/adapter/storage-domain.js'
import type { DomainRow, DomainStore, DomainTable, DomainWrite } from '../src/adapter/storage-domain.js'
import { createResearcherPrincipal } from '../src/factories.js'
import {
  hydrateArtifact,
  hydrateAttention,
  hydrateAuditEntry,
  hydrateCIRecord,
  hydrateExperiment,
  hydrateIssue,
  hydrateIssueComment,
  hydrateProgram,
  hydrateTicket,
} from '../src/hydration.js'
import {
  ciRunId as parseCIRunId,
  experimentId as parseExperimentId,
  isoTimestamp as parseIsoTimestamp,
  issueId as parseIssueId,
  metricName as parseMetricName,
  nonEmptyString as parseNonEmptyString,
  positiveNumber as parsePositiveNumber,
  programId as parseProgramId,
  researcherSessionId as parseResearcherSessionId,
  reviewId as parseReviewId,
  ticketId as parseTicketId,
  version as parseVersion,
} from '../src/parsers.js'
import type { ArtifactRef } from '../src/types/artifacts.js'
import type { Attention } from '../src/types/attention.js'
import type { AuditEntry } from '../src/types/audit.js'
import type { DomainError, Result, StoreError } from '../src/types/errors.js'
import type { Experiment, ExperimentReview } from '../src/types/experiment.js'
import type { ExperimentId, IssueId, Version } from '../src/types/ids.js'
import type { Issue, IssueComment } from '../src/types/issue.js'
import type { CIRecord, PassedCIRecord } from '../src/types/metrics.js'
import type { Program } from '../src/types/program.js'
import type { Versioned } from '../src/types/storage.js'
import type { Ticket } from '../src/types/ticket.js'

const AT = '2026-11-02T00:00:00.000Z'
const AT_LATER = '2026-11-02T00:05:00.000Z'
const SHA = 'a'.repeat(40)
const PROGRAM = id(parseProgramId('program-1'), 'program id')
const OTHER_PROGRAM = id(parseProgramId('program-2'), 'other program id')
const ISSUE = id(parseIssueId('issue-1'), 'issue id')
const EXPERIMENT = id(parseExperimentId('experiment-1'), 'experiment id')
const TICKET = id(parseTicketId('ticket-1'), 'ticket id')
const RUN_1 = id(parseCIRunId('run-1'), 'CI run id')
const RUN_2 = id(parseCIRunId('run-2'), 'CI run id')

// ---------------------------------------------------------------------------
// Result assertions and test-only branding helpers
// ---------------------------------------------------------------------------

function expectOk<T, E>(result: Result<T, E>, context: string): T {
  assert.equal(result.ok, true, `${context}: expected Ok`)
  if (!result.ok) throw new Error(`${context}: expected Ok`)
  return result.value
}

function expectErr<T, E>(result: Result<T, E>, context: string): E {
  assert.equal(result.ok, false, `${context}: expected Err`)
  if (result.ok) throw new Error(`${context}: expected Err`)
  return result.error
}

function expectVersioned<T>(stored: Versioned<T> | undefined, context: string): Versioned<T> {
  assert.notEqual(stored, undefined, `${context}: expected a stored value`)
  if (stored === undefined) throw new Error(`${context}: expected a stored value`)
  return stored
}

function version(value: number): Version {
  return expectOk(parseVersion(value), `version ${value}`)
}

function id<T>(result: Result<T, DomainError>, context: string): T {
  return expectOk(result, context)
}

/** Test-only stand-in for a value the Host would validate; tests are outside the lint scope. */
function forged<T>(value: unknown): T {
  return value as T
}

// ---------------------------------------------------------------------------
// Fake DomainStore
// ---------------------------------------------------------------------------

interface PutAttempt {
  readonly table: DomainTable
  readonly key: string
  readonly expected: Version
  readonly actual: Version
  readonly accepted: boolean
}

class FakeDomainStore implements DomainStore {
  private readonly rowsByTable = new Map<DomainTable, Map<string, DomainRow>>()
  readonly attempts: PutAttempt[] = []
  readonly deletions: { readonly table: DomainTable; readonly key: string }[] = []

  seed(table: DomainTable, key: string, value: unknown, versionNumber = 1): void {
    this.table(table).set(key, {
      key,
      value,
      version: version(versionNumber),
      etag: `etag-${versionNumber}`,
    })
  }

  list(table: DomainTable): Promise<readonly DomainRow[]> {
    return Promise.resolve([...this.table(table).values()])
  }

  get(table: DomainTable, key: string): Promise<DomainRow | undefined> {
    return Promise.resolve(this.table(table).get(key))
  }

  put(
    table: DomainTable,
    key: string,
    value: unknown,
    expected: Version,
  ): Promise<Result<DomainWrite, StoreError>> {
    const current = this.table(table).get(key)
    const actual = current === undefined ? version(0) : current.version
    if (actual !== expected) {
      this.attempts.push({ table, key, expected, actual, accepted: false })
      return Promise.resolve({
        ok: false,
        error: { kind: 'version-conflict', expected, actual },
      })
    }
    const next = version(actual + 1)
    const row: DomainRow = { key, value, version: next, etag: `etag-${next}` }
    this.table(table).set(key, row)
    this.attempts.push({ table, key, expected, actual, accepted: true })
    return Promise.resolve({ ok: true, value: { version: next, etag: row.etag } })
  }

  delete(table: DomainTable, key: string): Promise<Result<void, StoreError>> {
    this.table(table).delete(key)
    this.deletions.push({ table, key })
    return Promise.resolve({ ok: true, value: undefined })
  }

  private table(table: DomainTable): Map<string, DomainRow> {
    const existing = this.rowsByTable.get(table)
    if (existing !== undefined) return existing
    const created = new Map<string, DomainRow>()
    this.rowsByTable.set(table, created)
    return created
  }
}

// ---------------------------------------------------------------------------
// Plain row fixtures
// ---------------------------------------------------------------------------

function programRow(
  options: { id?: string; goal?: string; requiredMetrics?: readonly string[] } = {},
): unknown {
  const required = options.requiredMetrics ?? ['accuracy', 'loss']
  return {
    id: options.id ?? 'program-1',
    name: 'program',
    goal: options.goal ?? 'find a better model',
    methodology: 'run experiments',
    contract: { ciEntry: 'main.py', timeoutMs: 60_000, requiredMetrics: required },
    utility: {
      metrics: required.map((name) => ({ name, direction: 'higher', weight: 1 })),
    },
    exploration: 'normal',
    budget: { maxExperiments: 10, maxComputeMinutes: 100, maxTokens: 1000 },
    usage: { experiments: 0, computeMinutes: 0, tokens: 0 },
    createdAt: AT,
    status: 'running',
  }
}

function program(
  options: { id?: string; goal?: string; requiredMetrics?: readonly string[] } = {},
): Program {
  return expectOk(hydrateProgram(programRow(options)), 'program row')
}

function issueRow(options: { id?: string; programId?: string; assigned?: boolean } = {}): unknown {
  const common = {
    id: options.id ?? 'issue-1',
    programId: options.programId ?? 'program-1',
    title: 'issue',
    body: 'body',
    labels: [],
    author: { kind: 'operator', sessionId: 'operator-1' },
    createdAt: AT,
  }
  if (options.assigned !== true) return { ...common, status: 'open' }
  return {
    ...common,
    status: 'assigned',
    assignee: { kind: 'researcher', sessionId: 'researcher-1' },
    assignedAt: AT,
    experimentIds: [],
  }
}

function issue(options: { id?: string; programId?: string; assigned?: boolean } = {}): Issue {
  return expectOk(hydrateIssue(issueRow(options)), 'issue row')
}

function experimentRow(
  options: { id?: string; programId?: string; issueId?: string } = {},
): unknown {
  return {
    id: options.id ?? 'experiment-1',
    programId: options.programId ?? 'program-1',
    issueId: options.issueId ?? 'issue-1',
    branch: 'experiment/one',
    head: SHA,
    environment: { kind: 'uv-lock', lockFile: 'uv.lock', pythonVersion: '3.12' },
    lineage: { strategy: 'fresh', baseCommit: SHA, freshStartProbability: 0 },
    planCommentId: 'comment-1',
    createdBy: { kind: 'researcher', sessionId: 'researcher-1' },
    createdAt: AT,
    status: 'open',
  }
}

function experiment(
  options: { id?: string; programId?: string; issueId?: string } = {},
): Experiment {
  return expectOk(hydrateExperiment(experimentRow(options)), 'experiment row')
}

function ticketRow(options: { id?: string; experimentId?: string } = {}): unknown {
  return {
    id: options.id ?? 'ticket-1',
    programId: 'program-1',
    issueId: 'issue-1',
    experimentId: options.experimentId ?? 'experiment-1',
    baseCommit: SHA,
    createdAt: AT,
    status: 'open',
  }
}

function ticket(options: { id?: string; experimentId?: string } = {}): Ticket {
  return expectOk(hydrateTicket(ticketRow(options)), 'ticket row')
}

function commentRow(options: { id?: string; issueId?: string } = {}): unknown {
  return {
    id: options.id ?? 'comment-1',
    issueId: options.issueId ?? 'issue-1',
    authorSessionId: 'operator',
    body: 'a comment',
    at: AT,
    kind: 'comment',
  }
}

function comment(options: { id?: string; issueId?: string } = {}): IssueComment {
  return expectOk(hydrateIssueComment(commentRow(options)), 'comment row')
}

function review(
  options: { id?: string; experimentId?: ExperimentId; verdict?: ExperimentReview['verdict'] } = {},
): ExperimentReview {
  return {
    id: expectOk(parseReviewId(options.id ?? 'review-1'), 'review id'),
    experimentId: options.experimentId ?? EXPERIMENT,
    author: createResearcherPrincipal(
      expectOk(parseResearcherSessionId('reviewer-1'), 'reviewer session'),
    ),
    body: expectOk(parseNonEmptyString('a review'), 'review body'),
    at: expectOk(parseIsoTimestamp(AT), 'review at'),
    kind: 'review',
    verdict: options.verdict ?? 'comment',
  }
}

function passedRow(
  options: {
    id?: string
    programId?: string
    experimentId?: string
    metrics?: Readonly<Record<string, unknown>>
    finishedAt?: string
  } = {},
): unknown {
  return {
    id: options.id ?? 'run-1',
    programId: options.programId ?? 'program-1',
    experimentId: options.experimentId ?? 'experiment-1',
    commit: SHA,
    requestedBy: 'session-1',
    requestedAt: AT,
    status: 'passed',
    startedAt: AT,
    finishedAt: options.finishedAt ?? AT_LATER,
    environmentDigest: 'digest-1',
    metrics: options.metrics ?? { accuracy: 0.9, loss: 0.1 },
    artifacts: [],
    durationMs: 1000,
  }
}

function passedRecord(
  options: {
    id?: string
    programId?: string
    experimentId?: string
    metrics?: Readonly<Record<string, unknown>>
    finishedAt?: string
  } = {},
): PassedCIRecord {
  return expectOk(hydrateCIRecord(passedRow(options)), 'passed record row')
}

function failedRecord(options: { id?: string; experimentId?: string } = {}): CIRecord {
  return expectOk(
    hydrateCIRecord({
      id: options.id ?? 'run-2',
      programId: 'program-1',
      experimentId: options.experimentId ?? 'experiment-1',
      commit: SHA,
      requestedBy: 'session-1',
      requestedAt: AT,
      status: 'failed',
      finishedAt: AT_LATER,
      reason: 'entry-failed',
      detail: 'exit code 1',
      durationMs: 500,
    }),
    'failed record row',
  )
}

function artifactRow(
  options: { id?: string; programId?: string; experimentId?: string } = {},
): unknown {
  return {
    id: options.id ?? 'artifact-1',
    kind: 'report',
    digest: 'sha256:abc',
    bytes: 1024,
    programId: options.programId ?? 'program-1',
    experimentId: options.experimentId ?? 'experiment-1',
    commit: SHA,
    ciRunId: 'run-1',
    retention: 'keep',
    createdAt: AT,
  }
}

function artifact(
  options: { id?: string; programId?: string; experimentId?: string } = {},
): ArtifactRef {
  return expectOk(hydrateArtifact(artifactRow(options)), 'artifact row')
}

function attention(
  id: string,
  subject: { readonly kind: 'program' | 'issue' | 'experiment' | 'ci-run'; readonly id: string },
): Attention {
  return expectOk(
    hydrateAttention({
      id,
      subject,
      severity: 'warning',
      reason: 'needs a person',
      detail: 'detail',
      at: AT,
    }),
    'attention row',
  )
}

function auditEntry(options: { id?: string; programId?: string; at?: string } = {}): AuditEntry {
  const programId = options.programId ?? 'program-1'
  return expectOk(
    hydrateAuditEntry({
      id: options.id ?? 'audit-1',
      at: options.at ?? AT,
      programId,
      action: 'program.created',
      subject: { kind: 'program', id: programId },
      detail: {},
      actor: { kind: 'operator', sessionId: 'operator-1' },
    }),
    'audit row',
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('round-trips programs, issues, experiments and tickets through versioned rows', async () => {
  const store = new FakeDomainStore()
  const uow = createStorageDomainUnitOfWork(store)

  const programVersion = expectOk(await uow.programs.save(version(0), program()), 'program save')
  const issueVersion = expectOk(
    await uow.issues.save(version(0), issue({ assigned: true })),
    'issue save',
  )
  const experimentVersion = expectOk(
    await uow.experiments.save(version(0), experiment()),
    'experiment save',
  )
  const ticketVersion = expectOk(await uow.tickets.save(version(0), ticket()), 'ticket save')
  assert.deepEqual(
    [programVersion, issueVersion, experimentVersion, ticketVersion],
    [version(1), version(1), version(1), version(1)],
  )
  assert.deepEqual(
    store.attempts.map((attempt) => [
      attempt.table,
      attempt.expected,
      attempt.actual,
      attempt.accepted,
    ]),
    [
      ['programs', version(0), version(0), true],
      ['issues', version(0), version(0), true],
      ['experiments', version(0), version(0), true],
      ['tickets', version(0), version(0), true],
    ],
  )

  const storedProgram = expectVersioned(await uow.programs.get(PROGRAM), 'program read')
  assert.equal(storedProgram.version, version(1))
  assert.equal(storedProgram.value.goal, 'find a better model')
  assert.equal(storedProgram.value.status, 'running')
  if (storedProgram.value.status === 'running') {
    assert.equal(typeof storedProgram.value.pause, 'function')
  }

  const storedIssue = expectVersioned(await uow.issues.get(ISSUE), 'issue read')
  assert.equal(storedIssue.value.status, 'assigned')
  if (storedIssue.value.status === 'assigned') {
    assert.equal(typeof storedIssue.value.authorize, 'function')
  }

  const storedExperiment = expectVersioned(
    await uow.experiments.get(EXPERIMENT),
    'experiment read',
  )
  assert.equal(storedExperiment.value.status, 'open')
  assert.equal(typeof storedExperiment.value.submit, 'function')

  const storedTicket = expectVersioned(await uow.tickets.get(TICKET), 'ticket read')
  assert.equal(storedTicket.value.status, 'open')

  const nextVersion = expectOk(
    await uow.programs.save(programVersion, program({ goal: 'updated goal' })),
    'program update',
  )
  assert.equal(nextVersion, version(2))
  assert.equal(
    expectVersioned(await uow.programs.get(PROGRAM), 'program after update').value.goal,
    'updated goal',
  )
})

test('optimistic saves refuse a stale version and keep the stored value', async () => {
  const store = new FakeDomainStore()
  const uow = createStorageDomainUnitOfWork(store)
  const first = expectOk(await uow.programs.save(version(0), program()), 'initial save')

  const conflict = expectErr(
    await uow.programs.save(version(0), program({ goal: 'lost update' })),
    'stale save',
  )
  assert.equal(conflict.kind, 'version-conflict')
  if (conflict.kind !== 'version-conflict') throw new Error('expected a version-conflict')
  assert.equal(conflict.expected, version(0))
  assert.equal(conflict.actual, version(1))
  assert.equal(
    expectVersioned(await uow.programs.get(PROGRAM), 'program after conflict').value.goal,
    'find a better model',
  )

  const staleAttempt = store.attempts.find((attempt) => !attempt.accepted)
  assert.notEqual(staleAttempt, undefined)
  assert.equal(staleAttempt?.expected, version(0))
  assert.equal(staleAttempt?.actual, version(1))

  assert.equal(
    expectOk(await uow.programs.save(first, program({ goal: 'won update' })), 'current save'),
    version(2),
  )
})

test('a corrupt stored row is refused as StoreError instead of being returned', async () => {
  const store = new FakeDomainStore()
  store.seed('programs', 'program-1', { id: 'program-1', status: 'running' }, 1)
  const uow = createStorageDomainUnitOfWork(store)

  await assert.rejects(uow.programs.get(PROGRAM), (error: unknown) => {
    assert.equal(error instanceof DomainStoreFailure, true)
    if (!(error instanceof DomainStoreFailure)) return false
    assert.equal(error.storeError.kind, 'corrupt')
    if (error.storeError.kind === 'corrupt') {
      assert.match(error.storeError.message, /programs\/program-1/)
      assert.match(error.storeError.message, /program\./)
    }
    return true
  })

  await assert.rejects(uow.programs.list(), (error: unknown) => {
    assert.equal(error instanceof DomainStoreFailure, true)
    return error instanceof DomainStoreFailure && error.storeError.kind === 'corrupt'
  })
})

test('append tables round-trip comments, reviews, CI records, artifacts and attention', async () => {
  const store = new FakeDomainStore()
  const uow = createStorageDomainUnitOfWork(store)

  expectOk(await uow.issues.appendComment(comment()), 'comment append')
  expectOk(await uow.experiments.save(version(0), experiment()), 'experiment seed')
  expectOk(await uow.experiments.appendReview(review()), 'review append')
  expectOk(await uow.ciRecords.append(passedRecord()), 'CI append')
  expectOk(await uow.ciRecords.append(failedRecord()), 'failed CI append')
  expectOk(await uow.artifacts.append(artifact()), 'artifact append')
  expectOk(
    await uow.attention.append(
      attention('attention-1', { kind: 'experiment', id: 'experiment-1' }),
    ),
    'attention append',
  )

  const comments = await uow.issues.comments(ISSUE)
  assert.deepEqual(comments.map((entry) => String(entry.id)), ['comment-1'])
  assert.equal(comments[0]?.body, 'a comment')

  const reviews = await uow.experiments.reviews(EXPERIMENT)
  assert.deepEqual(reviews.map((entry) => String(entry.id)), ['review-1'])
  assert.equal(reviews[0]?.verdict, 'comment')

  assert.equal((await uow.ciRecords.get(RUN_1))?.status, 'passed')
  assert.equal((await uow.ciRecords.get(RUN_2))?.status, 'failed')
  assert.deepEqual(
    (await uow.ciRecords.listByExperiment(EXPERIMENT)).map((record) => String(record.id)).sort(),
    ['run-1', 'run-2'],
  )

  assert.equal((await uow.artifacts.get(artifact().id))?.digest, 'sha256:abc')
  assert.deepEqual(
    (await uow.artifacts.listByExperiment(EXPERIMENT)).map((entry) => String(entry.id)),
    ['artifact-1'],
  )
  assert.deepEqual(
    (await uow.attention.listByProgram(PROGRAM)).map((entry) => entry.id),
    ['attention-1'],
  )
  assert.deepEqual(await uow.attention.listByProgram(OTHER_PROGRAM), [])
})

test('listPassed keeps only passed records with every required metric and finite values', async () => {
  const store = new FakeDomainStore()
  const uow = createStorageDomainUnitOfWork(store)
  expectOk(
    await uow.programs.save(version(0), program({ requiredMetrics: ['accuracy', 'loss'] })),
    'program save',
  )

  expectOk(await uow.ciRecords.append(passedRecord({ id: 'run-usable' })), 'usable append')
  expectOk(
    await uow.ciRecords.append(passedRecord({ id: 'run-incomplete', metrics: { accuracy: 0.8 } })),
    'incomplete append',
  )
  expectOk(await uow.ciRecords.append(failedRecord({ id: 'run-failed' })), 'failed append')
  expectOk(
    await uow.ciRecords.append(
      passedRecord({ id: 'run-other', programId: 'program-2', experimentId: 'experiment-2' }),
    ),
    'other program append',
  )

  const corrupt = forged<PassedCIRecord>({
    ...passedRecord({ id: 'run-nan' }),
    metrics: { accuracy: Number.NaN, loss: 0.1 },
  })
  const refused = expectErr(await uow.ciRecords.append(corrupt), 'NaN append')
  assert.equal(refused.kind, 'corrupt')
  assert.equal(await store.get('ci_records', 'run-nan'), undefined)

  const passed = await uow.ciRecords.listPassed(PROGRAM)
  assert.deepEqual(passed.map((record) => String(record.id)), ['run-usable'])
  assert.equal(
    passed.every((record) =>
      Object.values(record.metrics).every((value) => Number.isFinite(value)),
    ),
    true,
  )

  const raw = await uow.ciRecords.listByExperiment(EXPERIMENT)
  assert.deepEqual(raw.map((record) => String(record.id)).sort(), [
    'run-failed',
    'run-incomplete',
    'run-usable',
  ])
})

test('query sorts CI rows and computes summaries at query time', async () => {
  const store = new FakeDomainStore()
  const uow = createStorageDomainUnitOfWork(store)
  expectOk(await uow.programs.save(version(0), program()), 'program save')
  expectOk(
    await uow.ciRecords.append(
      passedRecord({
        id: 'run-slow',
        metrics: { accuracy: 0.5, loss: 0.4 },
        finishedAt: '2026-11-02T00:01:00.000Z',
      }),
    ),
    'slow append',
  )
  expectOk(
    await uow.ciRecords.append(
      passedRecord({
        id: 'run-fast',
        metrics: { accuracy: 0.9, loss: 0.1 },
        finishedAt: '2026-11-02T00:02:00.000Z',
      }),
    ),
    'fast append',
  )
  expectOk(
    await uow.ciRecords.append(
      passedRecord({
        id: 'run-incomplete',
        metrics: { accuracy: 0.95 },
        finishedAt: '2026-11-02T00:03:00.000Z',
      }),
    ),
    'incomplete append',
  )

  const accuracy = expectOk(parseMetricName('accuracy'), 'metric')
  const loss = expectOk(parseMetricName('loss'), 'metric')
  const ranked = await uow.ciRecords.query({
    programId: PROGRAM,
    sort: [{ metric: accuracy, direction: 'higher' }],
    aggregate: 'max',
    limit: expectOk(parsePositiveNumber(1), 'limit'),
  })
  assert.deepEqual(ranked.rows.map((record) => String(record.id)), ['run-incomplete'])
  assert.deepEqual(ranked.summaries, [
    { metric: accuracy, value: 0.9 },
    { metric: loss, value: 0.4 },
  ])

  const averages = await uow.ciRecords.query({ programId: PROGRAM, aggregate: 'average' })
  assert.deepEqual(averages.summaries, [
    { metric: accuracy, value: (0.5 + 0.9) / 2 },
    { metric: loss, value: (0.4 + 0.1) / 2 },
  ])
})

test('audit append lists a program in append order and keeps the most recent limit', async () => {
  const store = new FakeDomainStore()
  const uow = createStorageDomainUnitOfWork(store)

  await uow.audit.append([
    auditEntry({ id: 'audit-1', at: '2026-11-02T00:01:00.000Z' }),
    auditEntry({ id: 'audit-2', at: '2026-11-02T00:02:00.000Z' }),
  ])
  await uow.audit.append([auditEntry({ id: 'audit-other', programId: 'program-2' })])

  assert.deepEqual((await uow.audit.list(PROGRAM, 10)).map((entry) => entry.id), [
    'audit-1',
    'audit-2',
  ])
  assert.deepEqual((await uow.audit.list(PROGRAM, 1)).map((entry) => entry.id), ['audit-2'])
  assert.deepEqual(await uow.audit.list(PROGRAM, 0), [])
  assert.deepEqual(
    (await uow.audit.list(OTHER_PROGRAM, 10)).map((entry) => entry.id),
    ['audit-other'],
  )
})

test('snapshot assembles only the requested program state', async () => {
  const store = new FakeDomainStore()
  const uow = createStorageDomainUnitOfWork(store)

  expectOk(await uow.programs.save(version(0), program()), 'program save')
  expectOk(await uow.issues.save(version(0), issue({ assigned: true })), 'issue save')
  expectOk(await uow.issues.appendComment(comment()), 'comment append')
  expectOk(await uow.experiments.save(version(0), experiment()), 'experiment save')
  expectOk(await uow.experiments.appendReview(review()), 'review append')
  expectOk(await uow.tickets.save(version(0), ticket()), 'ticket save')
  expectOk(await uow.ciRecords.append(passedRecord()), 'passed append')
  expectOk(await uow.ciRecords.append(failedRecord()), 'failed append')
  expectOk(await uow.artifacts.append(artifact()), 'artifact append')
  expectOk(
    await uow.attention.append(
      attention('attention-1', { kind: 'experiment', id: 'experiment-1' }),
    ),
    'attention append',
  )
  await uow.audit.append([auditEntry()])

  // Another program's rows must not leak into this snapshot.
  expectOk(
    await uow.issues.save(version(0), issue({ id: 'issue-other', programId: 'program-2' })),
    'other issue',
  )
  expectOk(
    await uow.experiments.save(
      version(0),
      experiment({ id: 'experiment-other', programId: 'program-2', issueId: 'issue-other' }),
    ),
    'other experiment',
  )
  expectOk(
    await uow.artifacts.append(
      artifact({ id: 'artifact-other', programId: 'program-2', experimentId: 'experiment-other' }),
    ),
    'other artifact append',
  )
  expectOk(
    await uow.attention.append(
      attention('attention-other', { kind: 'program', id: 'program-2' }),
    ),
    'other attention',
  )
  await uow.audit.append([auditEntry({ id: 'audit-other', programId: 'program-2' })])

  const snapshot = expectOk(await uow.snapshot(PROGRAM), 'snapshot')
  assert.equal(snapshot.program.id, PROGRAM)
  assert.deepEqual(snapshot.issues.map((entry) => String(entry.id)), ['issue-1'])
  assert.deepEqual(snapshot.comments.map((entry) => String(entry.id)), ['comment-1'])
  assert.deepEqual(snapshot.experiments.map((entry) => String(entry.id)), ['experiment-1'])
  assert.deepEqual(snapshot.ciRecords.map((record) => String(record.id)).sort(), ['run-1', 'run-2'])
  assert.deepEqual(snapshot.artifacts.map((entry) => String(entry.id)), ['artifact-1'])
  assert.deepEqual(snapshot.attention.map((entry) => entry.id), ['attention-1'])
  assert.deepEqual(snapshot.audit.map((entry) => entry.id), ['audit-1'])

  // Tickets and reviews are exposed by their repositories, not by ProgramSnapshot.
  assert.deepEqual(
    (await uow.tickets.listByExperiment(EXPERIMENT)).map((entry) => String(entry.id)),
    ['ticket-1'],
  )
  assert.deepEqual(
    (await uow.experiments.reviews(EXPERIMENT)).map((entry) => String(entry.id)),
    ['review-1'],
  )
})

test('snapshot refuses an unknown program', async () => {
  const store = new FakeDomainStore()
  const uow = createStorageDomainUnitOfWork(store)
  const error = expectErr(await uow.snapshot(PROGRAM), 'snapshot')
  assert.equal(error.code, 'not-found')
  assert.ok(error.message.length > 0)
})

test('transaction snapshots every table and restores it when the work throws', async () => {
  const store = new FakeDomainStore()
  const uow = createStorageDomainUnitOfWork(store)
  expectOk(await uow.programs.save(version(0), program()), 'seed program')
  expectOk(await uow.issues.save(version(0), issue({ assigned: true })), 'seed issue')
  await uow.audit.append([auditEntry()])

  await assert.rejects(
    uow.transaction(async (tx) => {
      expectOk(await tx.programs.save(version(1), program({ goal: 'rolled back' })), 'tx program')
      expectOk(await tx.issues.save(version(0), issue({ id: 'issue-2' })), 'tx issue')
      await tx.audit.append([auditEntry({ id: 'audit-2' })])
      await tx.attention.append(attention('attention-2', { kind: 'program', id: 'program-1' }))
      throw new Error('boom')
    }),
    /boom/,
  )

  const programAfter = expectVersioned(await uow.programs.get(PROGRAM), 'program after rollback')
  assert.equal(programAfter.value.goal, 'find a better model')
  // Versions never decrease: the compensation writes the old value as a new version.
  assert.equal(programAfter.version, version(3))
  assert.equal(await uow.issues.get(forged<IssueId>('issue-2')), undefined)
  assert.deepEqual((await uow.audit.list(PROGRAM, 10)).map((entry) => entry.id), ['audit-1'])
  assert.deepEqual(await uow.attention.listByProgram(PROGRAM), [])

  const committed = await uow.transaction(async (tx) => {
    expectOk(await tx.programs.save(version(3), program({ goal: 'committed' })), 'commit program')
    return 'committed-result'
  })
  assert.equal(committed, 'committed-result')
  assert.equal(
    expectVersioned(await uow.programs.get(PROGRAM), 'program after commit').value.goal,
    'committed',
  )
})

test('a native store transaction is used when the store exposes one', async () => {
  class NativeTransactionStore extends FakeDomainStore {
    nativeRuns = 0

    readonly transaction = async <T>(work: () => Promise<T>): Promise<T> => {
      this.nativeRuns += 1
      return work()
    }
  }

  const store = new NativeTransactionStore()
  const uow = createStorageDomainUnitOfWork(store)
  expectOk(await uow.programs.save(version(0), program()), 'seed program')
  await uow.transaction(async (tx) => {
    expectOk(await tx.programs.save(version(1), program({ goal: 'native' })), 'native save')
  })
  assert.equal(store.nativeRuns, 1)
  assert.equal(
    expectVersioned(await uow.programs.get(PROGRAM), 'program after native transaction').value
      .goal,
    'native',
  )
})
