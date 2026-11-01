/**
 * Hydration boundary (implementation): the only module allowed to turn storage rows or
 * JSON-shaped values into nominal domain states. Every function returns a `Result`; a
 * malformed row is rejected with a `StoreError` (`corrupt`), never thrown.
 *
 * Program, Issue, Experiment, Ticket and Artifact rows are validated by the factory
 * readers, so hydration and construction share one validation path; the returned state
 * carries the methods declared on the class. The structural records (CI records, comments,
 * audit entries, attention) are validated here field by field: status discriminants,
 * required fields, non-empty ids and finite metric values.
 */
import type { Attention, AttentionSeverity, AttentionSubject } from './types/attention.js'
import type { ArtifactRef } from './types/artifacts.js'
import type {
  AuditAction,
  AuditEntry,
  SubjectForAction,
} from './types/audit.js'
import type {
  HostPrincipal,
  ImplementerPrincipal,
  OperatorPrincipal,
  ResearcherPrincipal,
  WatchdogPrincipal,
} from './types/actors.js'
import type { CIFailureReason } from './types/ci.js'
import type { DomainError, Err, Ok, Result, StoreError } from './types/errors.js'
import type { Experiment } from './types/experiment.js'
import type {
  ArtifactId,
  AuditId,
  CIRunId,
  CommentId,
  CommitSha,
  DurationMs,
  ExperimentId,
  ImplementerSessionId,
  IsoTimestamp,
  IssueId,
  MetricName,
  NonEmptyString,
  OperatorSessionId,
  ProgramId,
  ResearcherSessionId,
  RouterSessionId,
  TicketId,
  WatchdogSessionId,
} from './types/ids.js'
import type { Issue, IssueComment } from './types/issue.js'
import type { CIRecord, FailedCIRecord, MetricMap, PassedCIRecord } from './types/metrics.js'
import type { Program } from './types/program.js'
import type { Ticket } from './types/ticket.js'
import {
  createAssignedIssue,
  createCancelledTicket,
  createCIPendingExperiment,
  createCIPassedExperiment,
  createCIRunningExperiment,
  createClosedExperiment,
  createClosedIssue,
  createCompletedProgram,
  createFailedTicket,
  createOpenExperiment,
  createOpenIssue,
  createOpenTicket,
  createPausedProgram,
  createReadyExperiment,
  createRunningProgram,
  createRunningTicket,
  createStoppedProgram,
  createSubmittedTicket,
  createArtifactRef,
  createCIFailedExperiment,
  createHostPrincipal,
  createImplementerPrincipal,
  createOperatorPrincipal,
  createResearcherPrincipal,
  createRouterPrincipal,
  createWatchdogPrincipal,
} from './factories.js'

type UnknownRecord = Readonly<Record<string, unknown>>

const PROGRAM_STATUSES: readonly string[] = ['running', 'paused', 'stopped', 'completed']
const ISSUE_STATUSES: readonly string[] = ['open', 'assigned', 'closed']
const EXPERIMENT_STATUSES: readonly string[] = [
  'open',
  'ready',
  'ci-pending',
  'ci-running',
  'ci-passed',
  'ci-failed',
  'closed',
]
const TICKET_STATUSES: readonly string[] = ['open', 'running', 'submitted', 'cancelled', 'failed']
const CI_STATUSES: readonly CIRecord['status'][] = ['requested', 'running', 'passed', 'failed']
const COMMENT_KINDS: readonly ('comment' | 'plan')[] = ['comment', 'plan']
const ATTENTION_SEVERITIES: readonly AttentionSeverity[] = ['info', 'warning', 'blocked']
const ATTENTION_SUBJECT_KINDS: readonly AttentionSubject['kind'][] = [
  'program',
  'issue',
  'experiment',
  'ci-run',
]
const CI_FAILURE_REASONS: readonly CIFailureReason[] = [
  'environment-build-failed',
  'entry-failed',
  'missing-required-metric',
  'invalid-metrics',
  'timeout',
  'infrastructure',
  'cancelled',
]

// ---------------------------------------------------------------------------
// Boundary helpers
// ---------------------------------------------------------------------------

/**
 * Normalize an untrusted object. The `typeof`/`Array.isArray` checks prove the shape; the
 * assertion only states it for the reader, which then validates every field as `unknown`.
 */
function asRecord(value: unknown): UnknownRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as UnknownRecord
}

function ok<T>(value: T): Ok<T> {
  return { ok: true, value }
}

/** Refusal messages are constants in this module; the fallback is unreachable. */
function toMessage(text: string): NonEmptyString
function toMessage(text: string): string {
  return text.length === 0 ? 'corrupt row' : text
}

function corrupt(message: string): Err<StoreError> {
  return { ok: false, error: { kind: 'corrupt', message: toMessage(message) } }
}

/** Branding only: the caller already validated the value. */
function castId<T extends string>(value: string): T {
  return value as T
}

function castNumber<T extends number>(value: number): T {
  return value as T
}

/**
 * The single boundary conversion per assembled structural record. `Pick<T, keyof T>`
 * checks the whole public surface; inside this generic helper it is assignable to `T`.
 */
function boundary<T>(candidate: Pick<T, keyof T>): T {
  return candidate
}

function fromFactory<T>(label: string, result: Result<T, DomainError>): Result<T, StoreError> {
  if (result.ok) return result
  return corrupt(`${label} row is corrupt: ${result.error.code}: ${result.error.message}`)
}

/**
 * Field reader over a stored row. Failures accumulate on the root so a hydrator can read
 * every field and reject the row with the first offending path. `unknown` values are
 * narrowed with `typeof` and literal loops, never with type predicates.
 */
class Row {
  private readonly record: UnknownRecord
  private readonly root: Row
  private firstFailure: string | undefined

  constructor(record: UnknownRecord, root?: Row) {
    this.record = record
    this.root = root ?? this
  }

  raw(key: string): unknown {
    return this.record[key]
  }

  has(key: string): boolean {
    return Object.hasOwn(this.record, key)
  }

  fail(path: string, expectation: string): void {
    if (this.root.firstFailure === undefined) {
      this.root.firstFailure = `${path} ${expectation}`
    }
  }

  error(): Err<StoreError> | undefined {
    if (this.root.firstFailure === undefined) return undefined
    return corrupt(this.root.firstFailure)
  }

  childValue(value: unknown, path: string): Row {
    const record = asRecord(value)
    if (record === undefined) {
      this.fail(path, 'must be an object')
      return new Row({}, this.root)
    }
    return new Row(record, this.root)
  }

  text(key: string, path: string): string {
    const value = this.record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
    this.fail(path, 'must be a non-empty string')
    return ''
  }

  stringValue(key: string, path: string): string {
    const value = this.record[key]
    if (typeof value === 'string') return value
    this.fail(path, 'must be a string')
    return ''
  }

  optionalText(key: string, path: string): string | undefined {
    const value = this.record[key]
    if (value === undefined) return undefined
    if (typeof value === 'string' && value.trim().length > 0) return value
    this.fail(path, 'must be a non-empty string when present')
    return undefined
  }

  nullableText(key: string, path: string): string | null {
    const value = this.record[key]
    if (value === null) return null
    if (typeof value === 'string' && value.trim().length > 0) return value
    this.fail(path, 'must be a non-empty string or null')
    return null
  }

  nonNegative(key: string, path: string): number {
    const value = this.record[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
    this.fail(path, 'must be a finite non-negative number')
    return 0
  }

  nonNegativeInteger(key: string, path: string): number {
    const value = this.record[key]
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
    this.fail(path, 'must be a non-negative integer')
    return 0
  }

  oneOf<T extends string>(key: string, path: string, allowed: readonly T[]): T {
    return this.oneOfValue(this.record[key], path, allowed)
  }

  oneOfValue<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
    for (const candidate of allowed) {
      if (value === candidate) return candidate
    }
    this.fail(path, `must be one of ${allowed.join(', ')}`)
    const fallback = allowed[0]
    if (fallback === undefined) throw new Error('hydration boundary: empty allowed-value table')
    return fallback
  }

  array(key: string, path: string): readonly unknown[] {
    const value = this.record[key]
    if (Array.isArray(value)) return value
    this.fail(path, 'must be an array')
    return []
  }

  recordValue(key: string, path: string): UnknownRecord {
    const value = this.record[key]
    const record = asRecord(value)
    if (record === undefined) {
      this.fail(path, 'must be an object')
      return {}
    }
    return record
  }
}

// ---------------------------------------------------------------------------
// Program, Issue, Experiment, Ticket and Artifact rows (shared factory readers)
// ---------------------------------------------------------------------------

export function hydrateProgram(row: unknown): Result<Program, StoreError> {
  const record = asRecord(row)
  if (record === undefined) return corrupt('program row must be an object')
  switch (record['status']) {
    case 'running':
      return fromFactory('program', createRunningProgram(row))
    case 'paused':
      return fromFactory('program', createPausedProgram(row))
    case 'stopped':
      return fromFactory('program', createStoppedProgram(row))
    case 'completed':
      return fromFactory('program', createCompletedProgram(row))
    default:
      return corrupt(
        `program row has an unknown or missing status (expected ${PROGRAM_STATUSES.join(', ')})`,
      )
  }
}

export function hydrateIssue(row: unknown): Result<Issue, StoreError> {
  const record = asRecord(row)
  if (record === undefined) return corrupt('issue row must be an object')
  switch (record['status']) {
    case 'open':
      return fromFactory('issue', createOpenIssue(row))
    case 'assigned':
      return fromFactory('issue', createAssignedIssue(row))
    case 'closed':
      return fromFactory('issue', createClosedIssue(row))
    default:
      return corrupt(
        `issue row has an unknown or missing status (expected ${ISSUE_STATUSES.join(', ')})`,
      )
  }
}

export function hydrateExperiment(row: unknown): Result<Experiment, StoreError> {
  const record = asRecord(row)
  if (record === undefined) return corrupt('experiment row must be an object')
  switch (record['status']) {
    case 'open':
      return fromFactory('experiment', createOpenExperiment(row))
    case 'ready':
      return fromFactory('experiment', createReadyExperiment(row))
    case 'ci-pending':
      return fromFactory('experiment', createCIPendingExperiment(row))
    case 'ci-running':
      return fromFactory('experiment', createCIRunningExperiment(row))
    case 'ci-passed':
      return fromFactory('experiment', createCIPassedExperiment(row))
    case 'ci-failed':
      return fromFactory('experiment', createCIFailedExperiment(row))
    case 'closed':
      return fromFactory('experiment', createClosedExperiment(row))
    default:
      return corrupt(
        `experiment row has an unknown or missing status (expected ${EXPERIMENT_STATUSES.join(', ')})`,
      )
  }
}

export function hydrateTicket(row: unknown): Result<Ticket, StoreError> {
  const record = asRecord(row)
  if (record === undefined) return corrupt('ticket row must be an object')
  switch (record['status']) {
    case 'open':
      return fromFactory('ticket', createOpenTicket(row))
    case 'running':
      return fromFactory('ticket', createRunningTicket(row))
    case 'submitted':
      return fromFactory('ticket', createSubmittedTicket(row))
    case 'cancelled':
      return fromFactory('ticket', createCancelledTicket(row))
    case 'failed':
      return fromFactory('ticket', createFailedTicket(row))
    default:
      return corrupt(
        `ticket row has an unknown or missing status (expected ${TICKET_STATUSES.join(', ')})`,
      )
  }
}

export function hydrateArtifact(row: unknown): Result<ArtifactRef, StoreError> {
  return fromFactory('artifact', createArtifactRef(row))
}

// ---------------------------------------------------------------------------
// Issue comments
// ---------------------------------------------------------------------------

export function hydrateIssueComment(row: unknown): Result<IssueComment, StoreError> {
  const record = asRecord(row)
  if (record === undefined) return corrupt('issue comment row must be an object')
  const f = new Row(record)
  const id = f.text('id', 'issue comment.id')
  const issueId = f.text('issueId', 'issue comment.issueId')
  const authorValue = record['authorSessionId']
  const authorSessionId: ResearcherSessionId | 'operator' =
    authorValue === 'operator'
      ? 'operator'
      : castId<ResearcherSessionId>(f.text('authorSessionId', 'issue comment.authorSessionId'))
  const body = f.text('body', 'issue comment.body')
  const at = f.text('at', 'issue comment.at')
  const kind = f.oneOf('kind', 'issue comment.kind', COMMENT_KINDS)
  const failure = f.error()
  if (failure !== undefined) return failure
  return ok({
    id: castId<CommentId>(id),
    issueId: castId<IssueId>(issueId),
    authorSessionId,
    body: castId<NonEmptyString>(body),
    at: castId<IsoTimestamp>(at),
    kind,
  })
}

// ---------------------------------------------------------------------------
// CI records
// ---------------------------------------------------------------------------

function readRequestedBy(f: Row): string {
  if (f.has('requestedBy')) return f.text('requestedBy', 'ci record.requestedBy')
  return f.text('requestedBySessionId', 'ci record.requestedBySessionId')
}

function readMetrics(f: Row): MetricMap {
  const record = f.recordValue('metrics', 'ci record.metrics')
  const metrics: Record<MetricName, number> = {}
  for (const [name, value] of Object.entries(record)) {
    if (name.trim().length === 0) {
      f.fail('ci record.metrics', 'metric names must be non-empty')
      continue
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      f.fail(`ci record.metrics.${name}`, 'must be a finite number')
      continue
    }
    metrics[castId<MetricName>(name)] = value
  }
  return metrics
}

function readArtifacts(f: Row): readonly ArtifactRef[] {
  const values = f.array('artifacts', 'ci record.artifacts')
  const artifacts: ArtifactRef[] = []
  for (const value of values) {
    const artifact = createArtifactRef(value)
    if (!artifact.ok) {
      f.fail('ci record.artifacts', `contains an invalid artifact: ${artifact.error.message}`)
      continue
    }
    artifacts.push(artifact.value)
  }
  return artifacts
}

export function hydrateCIRecord(row: unknown): Result<CIRecord, StoreError> {
  const record = asRecord(row)
  if (record === undefined) return corrupt('ci record row must be an object')
  const f = new Row(record)
  const status = f.oneOf('status', 'ci record.status', CI_STATUSES)
  const id = f.text('id', 'ci record.id')
  const programId = f.text('programId', 'ci record.programId')
  const experimentId = f.text('experimentId', 'ci record.experimentId')
  const commit = f.text('commit', 'ci record.commit')
  const requestedBy = readRequestedBy(f)
  const requestedAt = f.text('requestedAt', 'ci record.requestedAt')

  switch (status) {
    case 'requested': {
      const failure = f.error()
      if (failure !== undefined) return failure
      return ok({
        id: castId<CIRunId>(id),
        programId: castId<ProgramId>(programId),
        experimentId: castId<ExperimentId>(experimentId),
        commit: castId<CommitSha>(commit),
        requestedBy: castId<ResearcherSessionId>(requestedBy),
        requestedAt: castId<IsoTimestamp>(requestedAt),
        status: 'requested',
      })
    }
    case 'running': {
      const startedAt = f.text('startedAt', 'ci record.startedAt')
      const environmentDigest = f.text('environmentDigest', 'ci record.environmentDigest')
      const failure = f.error()
      if (failure !== undefined) return failure
      return ok({
        id: castId<CIRunId>(id),
        programId: castId<ProgramId>(programId),
        experimentId: castId<ExperimentId>(experimentId),
        commit: castId<CommitSha>(commit),
        requestedBy: castId<ResearcherSessionId>(requestedBy),
        requestedAt: castId<IsoTimestamp>(requestedAt),
        status: 'running',
        startedAt: castId<IsoTimestamp>(startedAt),
        environmentDigest,
      })
    }
    case 'passed': {
      const startedAt = f.text('startedAt', 'ci record.startedAt')
      const finishedAt = f.text('finishedAt', 'ci record.finishedAt')
      const environmentDigest = f.text('environmentDigest', 'ci record.environmentDigest')
      const durationMs = f.nonNegative('durationMs', 'ci record.durationMs')
      const metrics = readMetrics(f)
      const artifacts = readArtifacts(f)
      const failure = f.error()
      if (failure !== undefined) return failure
      const passed: PassedCIRecord = {
        id: castId<CIRunId>(id),
        programId: castId<ProgramId>(programId),
        experimentId: castId<ExperimentId>(experimentId),
        commit: castId<CommitSha>(commit),
        requestedBy: castId<ResearcherSessionId>(requestedBy),
        requestedAt: castId<IsoTimestamp>(requestedAt),
        status: 'passed',
        startedAt: castId<IsoTimestamp>(startedAt),
        finishedAt: castId<IsoTimestamp>(finishedAt),
        environmentDigest,
        metrics,
        artifacts,
        durationMs: castNumber<DurationMs>(durationMs),
      }
      return ok(passed)
    }
    case 'failed': {
      const finishedAt = f.text('finishedAt', 'ci record.finishedAt')
      const startedAt = f.optionalText('startedAt', 'ci record.startedAt')
      const environmentDigest = f.optionalText('environmentDigest', 'ci record.environmentDigest')
      const reason = f.oneOf('reason', 'ci record.reason', CI_FAILURE_REASONS)
      const detail = f.stringValue('detail', 'ci record.detail')
      const durationMs = f.nonNegative('durationMs', 'ci record.durationMs')
      const failure = f.error()
      if (failure !== undefined) return failure
      const failed: FailedCIRecord = {
        id: castId<CIRunId>(id),
        programId: castId<ProgramId>(programId),
        experimentId: castId<ExperimentId>(experimentId),
        commit: castId<CommitSha>(commit),
        requestedBy: castId<ResearcherSessionId>(requestedBy),
        requestedAt: castId<IsoTimestamp>(requestedAt),
        status: 'failed',
        ...(startedAt === undefined ? {} : { startedAt: castId<IsoTimestamp>(startedAt) }),
        ...(environmentDigest === undefined ? {} : { environmentDigest }),
        reason,
        detail,
        durationMs: castNumber<DurationMs>(durationMs),
        finishedAt: castId<IsoTimestamp>(finishedAt),
      }
      return ok(failed)
    }
  }
}

// ---------------------------------------------------------------------------
// Audit entries
// ---------------------------------------------------------------------------

type PrincipalKind =
  | 'operator'
  | 'researcher'
  | 'implementer'
  | 'watchdog'
  | 'host'
  | 'router'
type SubjectKind = 'program' | 'issue' | 'experiment' | 'ci-run' | 'artifact'
type AuditActor =
  | OperatorPrincipal
  | ResearcherPrincipal
  | ImplementerPrincipal
  | WatchdogPrincipal
  | HostPrincipal

const PRINCIPAL_KINDS: readonly PrincipalKind[] = [
  'operator',
  'researcher',
  'implementer',
  'watchdog',
  'host',
  'router',
]
const SUBJECT_KINDS: readonly SubjectKind[] = [
  'program',
  'issue',
  'experiment',
  'ci-run',
  'artifact',
]

/**
 * Runtime copy of `ActorKindForAction` and `SubjectForAction` (the type maps are erased).
 * Both records are total over `AuditAction`, so a new action fails to compile here.
 */
const AUDIT_ACTIONS: readonly AuditAction[] = [
  'program.created',
  'program.paused',
  'program.budget-paused',
  'program.resumed',
  'program.stopped',
  'program.goal-changed',
  'program.methodology-changed',
  'program.exploration-changed',
  'program.completed',
  'usage.recorded',
  'issue.created',
  'issue.claimed',
  'issue.commented',
  'issue.closed',
  'experiment.proposed',
  'experiment.opened',
  'experiment.revised',
  'experiment.reviewed',
  'experiment.ready',
  'experiment.cancelled',
  'experiment.closed',
  'ci.requested',
  'ci.started',
  'ci.passed',
  'ci.failed',
  'artifact.stored',
  'attention.raised',
  'command.refused',
]

const AUDIT_ACTOR_KINDS: Readonly<Record<AuditAction, readonly PrincipalKind[]>> = {
  'program.created': ['operator'],
  'program.paused': ['operator'],
  'program.budget-paused': ['host'],
  'program.resumed': ['operator'],
  'program.stopped': ['operator'],
  'program.goal-changed': ['operator'],
  'program.methodology-changed': ['operator'],
  'program.exploration-changed': ['operator'],
  'program.completed': ['host'],
  'usage.recorded': ['host'],
  'issue.created': ['operator', 'researcher'],
  'issue.claimed': ['researcher'],
  'issue.commented': ['researcher', 'operator'],
  'issue.closed': ['researcher', 'operator'],
  'experiment.proposed': ['researcher'],
  'experiment.opened': ['host'],
  'experiment.revised': ['implementer'],
  'experiment.reviewed': ['researcher'],
  'experiment.ready': ['implementer'],
  'experiment.cancelled': ['host'],
  'experiment.closed': ['researcher'],
  'ci.requested': ['researcher'],
  'ci.started': ['host'],
  'ci.passed': ['host'],
  'ci.failed': ['host'],
  'artifact.stored': ['host'],
  'attention.raised': ['watchdog', 'host'],
  'command.refused': ['operator', 'researcher', 'implementer', 'watchdog', 'host'],
}

const AUDIT_SUBJECT_KINDS: Readonly<Record<AuditAction, SubjectKind>> = {
  'program.created': 'program',
  'program.paused': 'program',
  'program.budget-paused': 'program',
  'program.resumed': 'program',
  'program.stopped': 'program',
  'program.goal-changed': 'program',
  'program.methodology-changed': 'program',
  'program.exploration-changed': 'program',
  'program.completed': 'program',
  'usage.recorded': 'program',
  'issue.created': 'issue',
  'issue.claimed': 'issue',
  'issue.commented': 'issue',
  'issue.closed': 'issue',
  'experiment.proposed': 'issue',
  'experiment.opened': 'experiment',
  'experiment.revised': 'experiment',
  'experiment.reviewed': 'experiment',
  'experiment.ready': 'experiment',
  'experiment.cancelled': 'experiment',
  'experiment.closed': 'experiment',
  'ci.requested': 'ci-run',
  'ci.started': 'ci-run',
  'ci.passed': 'ci-run',
  'ci.failed': 'ci-run',
  'artifact.stored': 'artifact',
  'attention.raised': 'program',
  'command.refused': 'program',
}

function readAuditAction(value: string): AuditAction | undefined {
  for (const action of AUDIT_ACTIONS) {
    if (value === action) return action
  }
  return undefined
}

function readAuditActor(f: Row, value: unknown, allowed: readonly PrincipalKind[]): AuditActor {
  const actor = f.childValue(value, 'audit.actor')
  const kind = actor.oneOf('kind', 'audit.actor.kind', PRINCIPAL_KINDS)
  if (!allowed.includes(kind)) {
    actor.fail('audit.actor.kind', `is not allowed for this audit action (${allowed.join(', ')})`)
  }
  if (kind === 'host') return createHostPrincipal()
  const sessionId = actor.text('sessionId', 'audit.actor.sessionId')
  switch (kind) {
    case 'operator':
      return createOperatorPrincipal(castId<OperatorSessionId>(sessionId))
    case 'researcher':
      return createResearcherPrincipal(castId<ResearcherSessionId>(sessionId))
    case 'implementer':
      return createImplementerPrincipal(
        castId<ImplementerSessionId>(sessionId),
        castId<TicketId>(actor.text('ticketId', 'audit.actor.ticketId')),
      )
    case 'watchdog':
      return createWatchdogPrincipal(castId<WatchdogSessionId>(sessionId))
    case 'router':
      actor.fail('audit.actor.kind', 'is not a valid audit actor kind')
      return createHostPrincipal()
  }
}

function readAuditSubject(
  f: Row,
  value: unknown,
  expected: SubjectKind,
): SubjectForAction[AuditAction] {
  const subject = f.childValue(value, 'audit.subject')
  const kind = subject.oneOf('kind', 'audit.subject.kind', SUBJECT_KINDS)
  if (kind !== expected) {
    subject.fail('audit.subject.kind', `must be '${expected}' for this audit action`)
  }
  const id = subject.text('id', 'audit.subject.id')
  switch (kind) {
    case 'program':
      return { kind, id: castId<ProgramId>(id) }
    case 'issue':
      return { kind, id: castId<IssueId>(id) }
    case 'experiment':
      return { kind, id: castId<ExperimentId>(id) }
    case 'ci-run':
      return { kind, id: castId<CIRunId>(id) }
    case 'artifact':
      return { kind, id: castId<ArtifactId>(id) }
  }
}

function readAuditDetail(f: Row, value: unknown): Readonly<Record<string, string | number | boolean | null>> {
  const record = asRecord(value)
  if (record === undefined) {
    f.fail('audit.detail', 'must be an object')
    return {}
  }
  const detail: Record<string, string | number | boolean | null> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (
      typeof entry === 'string' ||
      typeof entry === 'boolean' ||
      entry === null ||
      (typeof entry === 'number' && Number.isFinite(entry))
    ) {
      detail[key] = entry
      continue
    }
    f.fail(`audit.detail.${key}`, 'must be a string, finite number, boolean or null')
  }
  return detail
}

export function hydrateAuditEntry(row: unknown): Result<AuditEntry, StoreError> {
  const record = asRecord(row)
  if (record === undefined) return corrupt('audit entry row must be an object')
  const f = new Row(record)
  const id = f.text('id', 'audit.id')
  const at = f.text('at', 'audit.at')
  const programId = f.text('programId', 'audit.programId')
  const actionText = f.text('action', 'audit.action')
  const action = readAuditAction(actionText)
  if (action === undefined) {
    return corrupt(`audit entry row has an unknown action: ${actionText}`)
  }
  const actor = readAuditActor(f, record['actor'], AUDIT_ACTOR_KINDS[action])
  const subject = readAuditSubject(f, record['subject'], AUDIT_SUBJECT_KINDS[action])
  const detail = readAuditDetail(f, record['detail'])
  const failure = f.error()
  if (failure !== undefined) return failure
  return ok(
    boundary<AuditEntry>({
      id: castId<AuditId>(id),
      at: castId<IsoTimestamp>(at),
      programId: castId<ProgramId>(programId),
      action,
      subject,
      detail,
      actor,
    }),
  )
}

// ---------------------------------------------------------------------------
// Attention
// ---------------------------------------------------------------------------

export function hydrateAttention(row: unknown): Result<Attention, StoreError> {
  const record = asRecord(row)
  if (record === undefined) return corrupt('attention row must be an object')
  const f = new Row(record)
  const id = f.text('id', 'attention.id')
  const subject = f.childValue(record['subject'], 'attention.subject')
  const subjectKind = subject.oneOf('kind', 'attention.subject.kind', ATTENTION_SUBJECT_KINDS)
  const subjectId = subject.text('id', 'attention.subject.id')
  const severity = f.oneOf('severity', 'attention.severity', ATTENTION_SEVERITIES)
  const reason = f.stringValue('reason', 'attention.reason')
  const detail = f.stringValue('detail', 'attention.detail')
  const at = f.text('at', 'attention.at')
  const acknowledgedAt = f.optionalText('acknowledgedAt', 'attention.acknowledgedAt')
  const failure = f.error()
  if (failure !== undefined) return failure

  const typedSubject: AttentionSubject =
    subjectKind === 'program'
      ? { kind: subjectKind, id: castId<ProgramId>(subjectId) }
      : subjectKind === 'issue'
        ? { kind: subjectKind, id: castId<IssueId>(subjectId) }
        : subjectKind === 'experiment'
          ? { kind: subjectKind, id: castId<ExperimentId>(subjectId) }
          : { kind: subjectKind, id: castId<CIRunId>(subjectId) }

  const attention: Attention = {
    id,
    subject: typedSubject,
    severity,
    reason,
    detail,
    at: castId<IsoTimestamp>(at),
    ...(acknowledgedAt === undefined
      ? {}
      : { acknowledgedAt: castId<IsoTimestamp>(acknowledgedAt) }),
  }
  return ok(attention)
}
