/**
 * Runtime evidence for the in-memory storage: optimistic concurrency, immutable copies,
 * failed-record persistence, the sampler's passed-record view, query-time aggregates,
 * audit listing, transaction rollback and the panel snapshot.
 *
 * `research-core` is still a declaration-only blueprint, so the nominal values the Host
 * mints (principals, state classes, branded ids) have no runtime constructors. The
 * fixtures below stand in for them; `forged` is the only assertion in this file, it is
 * confined to test fixtures and it is stripped together with every other type.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { ArtifactRef } from '../src/types/artifacts.js'
import type { Attention } from '../src/types/attention.js'
import type { AuditEntry } from '../src/types/audit.js'
import type { ResearcherPrincipal } from '../src/types/actors.js'
import type { Experiment, ExperimentReview } from '../src/types/experiment.js'
import type { Result } from '../src/types/errors.js'
import type {
  ArtifactId,
  AuditId,
  BranchName,
  CIRunId,
  CommentId,
  CommitSha,
  DurationMs,
  ExperimentId,
  IsoTimestamp,
  IssueId,
  MetricName,
  NonEmptyString,
  OperatorSessionId,
  PositiveInt,
  PositiveNumber,
  ProgramId,
  ResearcherSessionId,
  ReviewId,
  TicketId,
  Version,
} from '../src/types/ids.js'
import type { Issue, IssueComment } from '../src/types/issue.js'
import type { FailedCIRecord, MetricMap, PassedCIRecord } from '../src/types/metrics.js'
import type { Program } from '../src/types/program.js'
import type { Versioned } from '../src/types/storage.js'
import type { Ticket } from '../src/types/ticket.js'
import { createInMemoryStore } from '../src/runtime/storage.js'

/** Stand-in for a value the Host mints through its factory/hydration boundary. */
function forged<T>(value: unknown): T {
  return value as T
}

const AT = forged<IsoTimestamp>('2026-11-02T00:00:00.000Z')
const AT_LATER = forged<IsoTimestamp>('2026-11-02T00:05:00.000Z')
const SHA = forged<CommitSha>('a'.repeat(40))
const PROGRAM = forged<ProgramId>('program-1')
const OTHER_PROGRAM = forged<ProgramId>('program-2')
const ISSUE = forged<IssueId>('issue-1')
const EXPERIMENT = forged<ExperimentId>('experiment-1')
const SESSION = forged<ResearcherSessionId>('session-1')

function version(value: number): Version {
  return forged<Version>(value)
}

function metricName(name: string): MetricName {
  return forged<MetricName>(name)
}

function researcher(sessionId = 'session-1'): ResearcherPrincipal {
  return forged<ResearcherPrincipal>({ kind: 'researcher', sessionId: forged<ResearcherSessionId>(sessionId) })
}

/** A mutable program draft: the immutability test mutates it after `save`. */
function programDraft(options: { id?: string; goal?: string; requiredMetrics?: readonly string[] } = {}) {
  const required = (options.requiredMetrics ?? ['accuracy', 'loss']).map((name) => metricName(name))
  return {
    id: forged<ProgramId>(options.id ?? 'program-1'),
    name: forged<NonEmptyString>('program'),
    goal: options.goal ?? 'find a better model',
    methodology: forged<NonEmptyString>('run experiments'),
    contract: {
      ciEntry: forged<NonEmptyString>('main.py'),
      timeoutMs: forged<DurationMs>(60_000),
      requiredMetrics: required,
    },
    utility: {
      metrics: required.map((name) => ({ name, direction: 'higher' as const, weight: forged<PositiveNumber>(1) })),
    },
    exploration: 'normal' as const,
    budget: {
      maxExperiments: forged<PositiveInt>(10),
      maxComputeMinutes: forged<PositiveInt>(100),
      maxTokens: forged<PositiveInt>(1000),
    },
    usage: { experiments: 0, computeMinutes: 0, tokens: 0 },
    createdAt: AT,
    status: 'running' as const,
  }
}

function program(options: { id?: string; goal?: string; requiredMetrics?: readonly string[] } = {}): Program {
  return forged<Program>(programDraft(options))
}

function issue(options: { id?: string; programId?: string } = {}): Issue {
  return forged<Issue>({
    id: forged<IssueId>(options.id ?? 'issue-1'),
    programId: forged<ProgramId>(options.programId ?? 'program-1'),
    title: forged<NonEmptyString>('issue'),
    body: forged<NonEmptyString>('body'),
    labels: [],
    author: { kind: 'operator', sessionId: forged<OperatorSessionId>('operator-1') },
    createdAt: AT,
    status: 'open',
  })
}

function assignedIssue(options: { id?: string; programId?: string; assignee?: string } = {}): Issue {
  return forged<Issue>({
    ...forged<Record<string, unknown>>(issue(options)),
    status: 'assigned',
    assignee: researcher(options.assignee ?? 'researcher-1'),
    assignedAt: AT,
    experimentIds: [],
  })
}

function experiment(options: { id?: string; programId?: string; issueId?: string } = {}): Experiment {
  return forged<Experiment>({
    id: forged<ExperimentId>(options.id ?? 'experiment-1'),
    programId: forged<ProgramId>(options.programId ?? 'program-1'),
    issueId: forged<IssueId>(options.issueId ?? 'issue-1'),
    branch: forged<BranchName>('experiment/one'),
    head: SHA,
    environment: { kind: 'uv-lock', lockFile: 'uv.lock', pythonVersion: '3.12' },
    lineage: { strategy: 'fresh', baseCommit: SHA, freshStartProbability: 0 },
    planCommentId: forged<CommentId>('comment-1'),
    createdBy: researcher(),
    createdAt: AT,
    status: 'open',
  })
}

function ticket(options: { id?: string; experimentId?: string } = {}): Ticket {
  return forged<Ticket>({
    id: forged<TicketId>(options.id ?? 'ticket-1'),
    programId: PROGRAM,
    issueId: ISSUE,
    experimentId: forged<ExperimentId>(options.experimentId ?? 'experiment-1'),
    baseCommit: SHA,
    createdAt: AT,
    status: 'open',
  })
}

function comment(options: { id?: string; issueId?: string } = {}): IssueComment {
  return {
    id: forged<CommentId>(options.id ?? 'comment-1'),
    issueId: forged<IssueId>(options.issueId ?? 'issue-1'),
    authorSessionId: 'operator',
    body: forged<NonEmptyString>('a comment'),
    at: AT,
    kind: 'comment',
  }
}

function review(options: { id?: string; experimentId?: string } = {}): ExperimentReview {
  return {
    id: forged<ReviewId>(options.id ?? 'review-1'),
    experimentId: forged<ExperimentId>(options.experimentId ?? 'experiment-1'),
    author: researcher('reviewer-1'),
    body: forged<NonEmptyString>('a review'),
    at: AT,
    kind: 'review',
    verdict: 'comment',
  }
}

function artifact(options: { id?: string; programId?: string; experimentId?: string } = {}): ArtifactRef {
  return forged<ArtifactRef>({
    id: forged<ArtifactId>(options.id ?? 'artifact-1'),
    kind: 'report',
    digest: 'sha256:abc',
    bytes: 1024,
    programId: forged<ProgramId>(options.programId ?? 'program-1'),
    experimentId: forged<ExperimentId>(options.experimentId ?? 'experiment-1'),
    commit: SHA,
    ciRunId: forged<CIRunId>('run-1'),
    retention: 'keep',
    createdAt: AT,
  })
}

function attention(
  id: string,
  subject: { kind: 'program' | 'issue' | 'experiment' | 'ci-run'; id: string },
): Attention {
  return forged<Attention>({
    id,
    subject,
    severity: 'warning',
    reason: 'needs a person',
    detail: 'detail',
    at: AT,
  })
}

function passedRecord(options: {
  id?: string
  experimentId?: string
  metrics?: Record<string, unknown>
  finishedAt?: string
} = {}): PassedCIRecord {
  return forged<PassedCIRecord>({
    id: forged<CIRunId>(options.id ?? 'run-1'),
    programId: PROGRAM,
    experimentId: forged<ExperimentId>(options.experimentId ?? 'experiment-1'),
    commit: SHA,
    requestedBy: SESSION,
    requestedAt: AT,
    status: 'passed',
    startedAt: AT,
    finishedAt: forged<IsoTimestamp>(options.finishedAt ?? '2026-11-02T00:01:00.000Z'),
    environmentDigest: 'digest-1',
    metrics: forged<MetricMap>(options.metrics ?? { accuracy: 0.9, loss: 0.1 }),
    artifacts: [],
    durationMs: forged<DurationMs>(1000),
  })
}

function failedRecord(options: { id?: string; experimentId?: string } = {}): FailedCIRecord {
  return forged<FailedCIRecord>({
    id: forged<CIRunId>(options.id ?? 'run-2'),
    programId: PROGRAM,
    experimentId: forged<ExperimentId>(options.experimentId ?? 'experiment-1'),
    commit: SHA,
    requestedBy: SESSION,
    requestedAt: AT,
    status: 'failed',
    finishedAt: AT_LATER,
    reason: 'entry-failed',
    detail: 'exit code 1',
    durationMs: forged<DurationMs>(500),
  })
}

function auditEntry(options: { id?: string; programId?: string; at?: string } = {}): AuditEntry {
  const programId = forged<ProgramId>(options.programId ?? 'program-1')
  return forged<AuditEntry>({
    id: forged<AuditId>(options.id ?? 'audit-1'),
    at: forged<IsoTimestamp>(options.at ?? AT),
    programId,
    action: 'program.created',
    subject: { kind: 'program', id: programId },
    detail: {},
    actor: { kind: 'operator', sessionId: forged<OperatorSessionId>('operator-1') },
  })
}

function expectOk<T, E>(result: Result<T, E>, context: string): T {
  assert.equal(result.ok, true, `${context}: expected Ok`)
  if (!result.ok) throw new Error(`${context}: expected Ok, got Err`)
  return result.value
}

function expectErr<T, E>(result: Result<T, E>, context: string): E {
  assert.equal(result.ok, false, `${context}: expected Err`)
  if (result.ok) throw new Error(`${context}: expected Err, got Ok`)
  return result.error
}

function expectVersioned<T>(stored: Versioned<T> | undefined, context: string): Versioned<T> {
  assert.notEqual(stored, undefined, `${context}: expected a stored value`)
  if (stored === undefined) throw new Error(`${context}: expected a stored value`)
  return stored
}

test('save compares the expected version and refuses a lost update', async () => {
  const store = createInMemoryStore()
  assert.equal(await store.programs.get(PROGRAM), undefined)

  const first = expectOk(await store.programs.save(version(0), program()), 'initial save')
  assert.equal(first, 1)

  const stored = expectVersioned(await store.programs.get(PROGRAM), 'read after save')
  assert.equal(stored.version, 1)
  assert.equal(stored.value.goal, 'find a better model')

  const conflict = expectErr(
    await store.programs.save(version(0), program({ goal: 'lost update' })),
    'stale save',
  )
  assert.equal(conflict.kind, 'version-conflict')
  if (conflict.kind !== 'version-conflict') throw new Error('expected a version-conflict')
  assert.equal(conflict.expected, 0)
  assert.equal(conflict.actual, 1)

  const afterConflict = expectVersioned(await store.programs.get(PROGRAM), 'read after conflict')
  assert.equal(afterConflict.version, 1)
  assert.equal(afterConflict.value.goal, 'find a better model')

  const second = expectOk(
    await store.programs.save(first, program({ goal: 'updated goal' })),
    'save with current version',
  )
  assert.equal(second, 2)
  const updated = expectVersioned(await store.programs.get(PROGRAM), 'read updated')
  assert.equal(updated.version, 2)
  assert.equal(updated.value.goal, 'updated goal')
})

test('issues, experiments and tickets share the same version check', async () => {
  const store = createInMemoryStore()
  const issueVersion = expectOk(await store.issues.save(version(0), issue()), 'issue save')
  const experimentVersion = expectOk(
    await store.experiments.save(version(0), experiment()),
    'experiment save',
  )
  const ticketVersion = expectOk(await store.tickets.save(version(0), ticket()), 'ticket save')

  assert.equal(
    expectErr(await store.issues.save(version(0), issue()), 'stale issue').kind,
    'version-conflict',
  )
  assert.equal(
    expectErr(await store.experiments.save(version(0), experiment()), 'stale experiment').kind,
    'version-conflict',
  )
  assert.equal(
    expectErr(await store.tickets.save(version(0), ticket()), 'stale ticket').kind,
    'version-conflict',
  )

  assert.equal(expectOk(await store.issues.save(issueVersion, issue()), 'next issue'), 2)
  assert.equal(
    expectOk(await store.experiments.save(experimentVersion, experiment()), 'next experiment'),
    2,
  )
  assert.equal(expectOk(await store.tickets.save(ticketVersion, ticket()), 'next ticket'), 2)
})

test('failed CI records are persisted next to passed ones', async () => {
  const store = createInMemoryStore()
  expectOk(await store.programs.save(version(0), program()), 'program save')

  const passed = passedRecord()
  const failed = failedRecord()
  expectOk(await store.ciRecords.append(passed), 'passed append')
  expectOk(await store.ciRecords.append(failed), 'failed append')

  const storedFailed = await store.ciRecords.get(failed.id)
  assert.notEqual(storedFailed, undefined)
  assert.equal(storedFailed?.status, 'failed')
  assert.equal(storedFailed?.reason, 'entry-failed')

  const byExperiment = await store.ciRecords.listByExperiment(EXPERIMENT)
  assert.deepEqual(byExperiment.map((record) => record.id).sort(), ['run-1', 'run-2'])
  assert.deepEqual(byExperiment.map((record) => record.status).sort(), ['failed', 'passed'])
})

test('corrupt metrics are refused and listPassed only returns usable passed records', async () => {
  const store = createInMemoryStore()
  expectOk(
    await store.programs.save(version(0), program({ requiredMetrics: ['accuracy', 'loss'] })),
    'program save',
  )

  expectOk(await store.ciRecords.append(passedRecord({ id: 'run-usable' })), 'usable append')
  expectOk(
    await store.ciRecords.append(passedRecord({ id: 'run-incomplete', metrics: { accuracy: 0.8 } })),
    'missing-required append',
  )
  expectOk(await store.ciRecords.append(failedRecord({ id: 'run-failed' })), 'failed append')

  const nanRecord = passedRecord({ id: 'run-nan', metrics: { accuracy: Number.NaN, loss: 0.1 } })
  const infinityRecord = passedRecord({
    id: 'run-infinity',
    metrics: { accuracy: Number.POSITIVE_INFINITY, loss: 0.1 },
  })
  const textRecord = passedRecord({ id: 'run-text', metrics: { accuracy: 'high', loss: 0.1 } })

  const nanError = expectErr(await store.ciRecords.append(nanRecord), 'NaN append')
  assert.equal(nanError.kind, 'corrupt')
  if (nanError.kind === 'corrupt') assert.match(nanError.message, /invalid metric accuracy/)
  assert.equal(
    expectErr(await store.ciRecords.append(infinityRecord), 'Infinity append').kind,
    'corrupt',
  )
  assert.equal(
    expectErr(await store.ciRecords.append(textRecord), 'non-numeric append').kind,
    'corrupt',
  )
  assert.equal(await store.ciRecords.get(forged<CIRunId>('run-nan')), undefined)
  assert.equal(await store.ciRecords.get(forged<CIRunId>('run-infinity')), undefined)
  assert.equal(await store.ciRecords.get(forged<CIRunId>('run-text')), undefined)

  const passed = await store.ciRecords.listPassed(PROGRAM)
  assert.deepEqual(passed.map((record) => record.id), ['run-usable'])
  assert.equal(
    passed.every((record) => Object.values(record.metrics).every((value) => Number.isFinite(value))),
    true,
  )

  // The failed and the missing-required records are still raw persisted rows for the panel.
  const raw = await store.ciRecords.listByExperiment(EXPERIMENT)
  assert.deepEqual(
    raw.map((record) => record.id).sort(),
    ['run-failed', 'run-incomplete', 'run-usable'],
  )
})

test('query sorts rows and computes every summary at query time', async () => {
  const store = createInMemoryStore()
  expectOk(await store.programs.save(version(0), program()), 'program save')

  expectOk(
    await store.ciRecords.append(passedRecord({
      id: 'run-slow',
      metrics: { accuracy: 0.5, loss: 0.4 },
      finishedAt: '2026-11-02T00:01:00.000Z',
    })),
    'slow append',
  )
  expectOk(
    await store.ciRecords.append(passedRecord({
      id: 'run-fast',
      metrics: { accuracy: 0.9, loss: 0.1 },
      finishedAt: '2026-11-02T00:02:00.000Z',
    })),
    'fast append',
  )
  expectOk(
    await store.ciRecords.append(passedRecord({
      id: 'run-incomplete',
      metrics: { accuracy: 0.95 },
      finishedAt: '2026-11-02T00:03:00.000Z',
    })),
    'incomplete append',
  )
  expectOk(await store.ciRecords.append(failedRecord({ id: 'run-failed' })), 'failed append')

  const unfiltered = await store.ciRecords.query({ programId: PROGRAM })
  assert.deepEqual(unfiltered.rows.map((record) => record.id).sort(), [
    'run-failed',
    'run-fast',
    'run-incomplete',
    'run-slow',
  ])
  assert.deepEqual(unfiltered.summaries, [])

  const ranked = await store.ciRecords.query({
    programId: PROGRAM,
    sort: [{ metric: metricName('accuracy'), direction: 'higher' }],
    aggregate: 'max',
    limit: forged<PositiveNumber>(1),
  })
  // Rows are raw records: the incomplete passed run sorts first, but it is not shown
  // in the summaries because it lacks a required metric.
  assert.deepEqual(ranked.rows.map((record) => record.id), ['run-incomplete'])
  assert.deepEqual(ranked.summaries, [
    { metric: metricName('accuracy'), value: 0.9 },
    { metric: metricName('loss'), value: 0.4 },
  ])

  const averages = await store.ciRecords.query({ programId: PROGRAM, aggregate: 'average' })
  assert.deepEqual(averages.summaries, [
    { metric: metricName('accuracy'), value: (0.5 + 0.9) / 2 },
    { metric: metricName('loss'), value: (0.4 + 0.1) / 2 },
  ])

  const latest = await store.ciRecords.query({ programId: PROGRAM, aggregate: 'latest' })
  assert.deepEqual(latest.summaries, [
    { metric: metricName('accuracy'), value: 0.9 },
    { metric: metricName('loss'), value: 0.1 },
  ])

  const rejected = await store.ciRecords.query({
    programId: PROGRAM,
    experimentId: forged<ExperimentId>('experiment-2'),
  })
  assert.deepEqual(rejected.rows, [])
  assert.deepEqual(rejected.summaries, [])
})

test('audit append keeps order and list keeps the most recent entries', async () => {
  const store = createInMemoryStore()
  await store.audit.append([
    auditEntry({ id: 'audit-1', at: '2026-11-02T00:01:00.000Z' }),
    auditEntry({ id: 'audit-2', at: '2026-11-02T00:02:00.000Z' }),
  ])
  await store.audit.append([auditEntry({ id: 'audit-other', programId: 'program-2' })])

  assert.deepEqual((await store.audit.list(PROGRAM, 10)).map((entry) => entry.id), [
    'audit-1',
    'audit-2',
  ])
  assert.deepEqual((await store.audit.list(PROGRAM, 1)).map((entry) => entry.id), ['audit-2'])
  assert.deepEqual(await store.audit.list(PROGRAM, 0), [])
  assert.deepEqual(
    (await store.audit.list(OTHER_PROGRAM, 10)).map((entry) => entry.id),
    ['audit-other'],
  )
})

test('transaction restores every map and array when the work throws', async () => {
  const store = createInMemoryStore()
  expectOk(await store.programs.save(version(0), program()), 'seed program')
  expectOk(await store.issues.save(version(0), assignedIssue()), 'seed issue')
  await store.audit.append([auditEntry()])

  await assert.rejects(
    store.transaction(async (uow) => {
      expectOk(await uow.programs.save(version(1), program({ goal: 'rolled back' })), 'tx program')
      expectOk(await uow.issues.save(version(0), issue({ id: 'issue-2' })), 'tx issue')
      await uow.audit.append([auditEntry({ id: 'audit-2' })])
      await uow.attention.append(attention('attention-2', { kind: 'program', id: 'program-1' }))
      throw new Error('boom')
    }),
    /boom/,
  )

  const programAfter = expectVersioned(await store.programs.get(PROGRAM), 'program after rollback')
  assert.equal(programAfter.version, 1)
  assert.equal(programAfter.value.goal, 'find a better model')
  assert.equal((await store.issues.listByProgram(PROGRAM)).length, 1)
  assert.equal(await store.issues.get(forged<IssueId>('issue-2')), undefined)
  assert.deepEqual((await store.audit.list(PROGRAM, 10)).map((entry) => entry.id), ['audit-1'])
  assert.deepEqual(await store.attention.listByProgram(PROGRAM), [])

  const committed = await store.transaction(async (uow) => {
    expectOk(await uow.programs.save(version(1), program({ goal: 'committed' })), 'commit program')
    return 'committed-result'
  })
  assert.equal(committed, 'committed-result')
  assert.equal(
    expectVersioned(await store.programs.get(PROGRAM), 'program after commit').value.goal,
    'committed',
  )
})

test('save stores an immutable copy, not the caller object', async () => {
  const store = createInMemoryStore()
  const draft = programDraft()
  expectOk(await store.programs.save(version(0), forged<Program>(draft)), 'program save')

  const firstRead = expectVersioned(await store.programs.get(PROGRAM), 'first read')
  assert.equal(firstRead.value.goal, 'find a better model')
  assert.equal(firstRead.value.contract.requiredMetrics.length, 2)

  draft.goal = 'mutated after save'
  draft.contract.requiredMetrics.push(metricName('tampered'))

  const secondRead = expectVersioned(await store.programs.get(PROGRAM), 'second read')
  assert.equal(secondRead.value.goal, 'find a better model')
  assert.deepEqual(secondRead.value.contract.requiredMetrics, [
    metricName('accuracy'),
    metricName('loss'),
  ])
  assert.equal(Object.isFrozen(secondRead.value), true)
  assert.equal(Object.isFrozen(secondRead.value.contract), true)
  assert.equal(Object.isFrozen(secondRead.value.contract.requiredMetrics), true)
  assert.throws(() => {
    forged<{ goal: string }>(secondRead.value).goal = 'write through a read'
  }, TypeError)
})

test('snapshot refuses an unknown program', async () => {
  const store = createInMemoryStore()
  const result = await store.snapshot(PROGRAM)
  assert.equal(result.ok, false)
  const error = expectErr(result, 'snapshot')
  assert.equal(error.code, 'not-found')
  assert.ok(error.message.length > 0)
})

test('snapshot assembles only the requested program state', async () => {
  const store = createInMemoryStore()
  expectOk(await store.programs.save(version(0), program()), 'program save')
  expectOk(await store.issues.save(version(0), assignedIssue()), 'issue save')
  expectOk(await store.issues.appendComment(comment()), 'comment append')
  expectOk(await store.experiments.save(version(0), experiment()), 'experiment save')
  expectOk(await store.experiments.appendReview(review()), 'review append')
  expectOk(await store.tickets.save(version(0), ticket()), 'ticket save')
  expectOk(await store.ciRecords.append(passedRecord()), 'passed append')
  expectOk(await store.ciRecords.append(failedRecord()), 'failed append')
  expectOk(await store.artifacts.append(artifact()), 'artifact append')
  expectOk(
    await store.attention.append(attention('attention-1', { kind: 'experiment', id: 'experiment-1' })),
    'attention append',
  )
  await store.audit.append([auditEntry()])

  // Another program's rows must not leak into this snapshot.
  expectOk(
    await store.issues.save(version(0), issue({ id: 'issue-other', programId: 'program-2' })),
    'other issue',
  )
  expectOk(
    await store.experiments.save(version(0), experiment({
      id: 'experiment-other',
      programId: 'program-2',
      issueId: 'issue-other',
    })),
    'other experiment',
  )
  expectOk(
    await store.artifacts.append(artifact({
      id: 'artifact-other',
      programId: 'program-2',
      experimentId: 'experiment-other',
    })),
    'other artifact',
  )
  await store.audit.append([auditEntry({ id: 'audit-other', programId: 'program-2' })])

  const snapshot = expectOk(await store.snapshot(PROGRAM), 'snapshot')
  assert.equal(snapshot.program.id, PROGRAM)
  assert.deepEqual(snapshot.issues.map((entry) => entry.id), [ISSUE])
  assert.deepEqual(snapshot.comments.map((entry) => entry.id), [forged<CommentId>('comment-1')])
  assert.deepEqual(snapshot.experiments.map((entry) => entry.id), [EXPERIMENT])
  assert.deepEqual(
    snapshot.ciRecords.map((record) => record.id).sort(),
    [forged<CIRunId>('run-1'), forged<CIRunId>('run-2')],
  )
  assert.deepEqual(snapshot.artifacts.map((entry) => entry.id), [forged<ArtifactId>('artifact-1')])
  assert.deepEqual(snapshot.attention.map((entry) => entry.id), ['attention-1'])
  assert.deepEqual(snapshot.audit.map((entry) => entry.id), [forged<AuditId>('audit-1')])

  assert.deepEqual((await store.experiments.reviews(EXPERIMENT)).map((entry) => entry.id), [
    forged<ReviewId>('review-1'),
  ])
  assert.deepEqual((await store.tickets.listByExperiment(EXPERIMENT)).map((entry) => entry.id), [
    forged<TicketId>('ticket-1'),
  ])
  assert.deepEqual(
    (await store.issues.listAssignedTo(forged<ResearcherSessionId>('researcher-1'))).map(
      (entry) => entry.id,
    ),
    [ISSUE],
  )
  assert.deepEqual(
    await store.issues.listAssignedTo(forged<ResearcherSessionId>('nobody')),
    [],
  )
  assert.deepEqual((await store.artifacts.listByExperiment(EXPERIMENT)).map((entry) => entry.id), [
    forged<ArtifactId>('artifact-1'),
  ])
})
