/**
 * Factory boundary (implementation): the only module allowed to construct nominal domain
 * states. ESLint and ast-grep reject assertions and `any` outside this module, hydration.ts,
 * parsers.ts and the type tests.
 *
 * The inputs that carry untrusted data (`unknown`) are validated field by field with
 * `Fields`. Validation returns a `Result` with a `DomainError`; nothing throws except a
 * declared non-`Result` method whose transition is impossible by construction (the domain
 * transition itself refuses only on invalid input, which the method's typed parameters
 * already exclude).
 *
 * Each state is built in two steps:
 * 1. a reader validates the input and produces a plain `*Data` record, the representation
 *    the pure transitions in `runtime/domain.ts` consume;
 * 2. an assembler attaches the methods declared on the class and hands the candidate to
 *    `boundary`, the one documented assertion per object. `boundary` still requires every
 *    public field and method of the declared type, so a missing or mistyped member does not
 *    compile; only the private brand (which no code outside this module may mint) is
 *    attached by the assertion.
 */
import type {
  HostPrincipal,
  ImplementerPrincipal,
  IssueAssignment,
  IssueAuthor,
  OperatorPrincipal,
  ResearcherPrincipal,
  RouterPrincipal,
  TicketBinding,
  WatchdogPrincipal,
} from './types/actors.js'
import type { ArtifactKind, ArtifactRef, ArtifactRetention } from './types/artifacts.js'
import type {
  CIFailureReason,
  CIRequestToken,
  FailedCICompletion,
  PassedCICompletion,
} from './types/ci.js'
import type { EnvironmentDeclaration } from './types/environment.js'
import type { DomainError, Err, Ok, Result } from './types/errors.js'
import type {
  CIPassedExperiment,
  CIFailedExperiment,
  CIPendingExperiment,
  CIRunningExperiment,
  ClosedExperiment,
  DerivedLineage,
  Experiment,
  ExperimentLineage,
  FreshLineage,
  OpenExperiment,
  ReadyExperiment,
} from './types/experiment.js'
import type {
  ArtifactId,
  BranchName,
  CIRunId,
  CommentId,
  CommitSha,
  DurationMs,
  ExperimentId,
  ImplementerSessionId,
  IsoTimestamp,
  IssueId,
  MetricName,
  NonEmptyArray,
  NonEmptyString,
  OperatorSessionId,
  PositiveInt,
  PositiveNumber,
  ProgramId,
  ResearcherSessionId,
  RouterSessionId,
  TicketId,
  WatchdogSessionId,
  NonNegativeNumber,
} from './types/ids.js'
import type {
  AssignedIssue,
  ClosedIssue,
  Issue,
  IssueLabel,
  IssueResolution,
  OpenIssue,
} from './types/issue.js'
import type {
  FailedCIRecord,
  MetricDefinition,
  MetricMap,
  PassedCIRecord,
} from './types/metrics.js'
import type {
  Budget,
  BudgetUsage,
  CompletedProgram,
  EvaluationContract,
  ExplorationLevel,
  PausedProgram,
  Program,
  RunningProgram,
  StoppedProgram,
  UsageDelta,
  UtilityConfig,
} from './types/program.js'
import type { ExplorationPreset } from './types/sampling.js'
import type { Clock } from './types/services.js'
import type {
  CancelledTicket,
  FailedTicket,
  OpenTicket,
  RunningTicket,
  SubmittedTicket,
  Ticket,
} from './types/ticket.js'
import type {
  AssignedIssueData,
  CIFailedExperimentData,
  CIPassedExperimentData,
  CIPendingExperimentData,
  CIRunningExperimentData,
  CIRequestTokenData,
  ClosedExperimentData,
  ClosedIssueData,
  CompletedProgramData,
  ExperimentBaseData,
  FailedCICompletionData,
  FailedCIRecordData,
  IssueAssignmentData,
  IssueAuthorRefData,
  IssueCommonData,
  OpenExperimentData,
  OpenIssueData,
  PassedCICompletionData,
  PassedCIRecordData,
  PausedProgramData,
  ProgramCommonData,
  ReadyExperimentData,
  RunningProgramData,
  StoppedProgramData,
  TicketBindingData,
  TicketBindingExpectationData,
  TicketData,
} from './runtime/domain.js'
import {
  addExperiment as addExperimentTransition,
  authorizeIssue as authorizeIssueTransition,
  cancelExperiment as cancelExperimentTransition,
  claimIssue as claimIssueTransition,
  closeAssignedIssue as closeAssignedIssueTransition,
  closeExperiment as closeExperimentTransition,
  closeOpenIssue as closeOpenIssueTransition,
  completeProgram as completeProgramTransition,
  createTicketBinding as mintTicketBindingTransition,
  failExperimentCI as failExperimentCITransition,
  pauseProgram as pauseProgramTransition,
  passExperimentCI as passExperimentCITransition,
  recordUsage as recordUsageTransition,
  requestExperimentCI as requestExperimentCITransition,
  resumeProgram as resumeProgramTransition,
  reviseExperiment as reviseExperimentTransition,
  setExploration as setExplorationTransition,
  setGoal as setGoalTransition,
  setMethodology as setMethodologyTransition,
  startExperimentCI as startExperimentCITransition,
  stopProgram as stopProgramTransition,
  submitExperiment as submitExperimentTransition,
} from './runtime/domain.js'
import { EXPLORATION_PRESETS as PRESET_TABLE } from './runtime/sampler.js'

/** Fixed exploration presets live in the sampler; the factory boundary re-exports them. */
export const EXPLORATION_PRESETS: Readonly<Record<ExplorationLevel, ExplorationPreset>> =
  PRESET_TABLE

const PROGRAM_STATUSES: readonly Program['status'][] = [
  'running',
  'paused',
  'stopped',
  'completed',
]
const ISSUE_STATUSES: readonly Issue['status'][] = ['open', 'assigned', 'closed']
const EXPERIMENT_STATUSES: readonly Experiment['status'][] = [
  'open',
  'ready',
  'ci-pending',
  'ci-running',
  'ci-passed',
  'ci-failed',
  'closed',
]
const TICKET_STATUSES: readonly Ticket['status'][] = [
  'open',
  'running',
  'submitted',
  'cancelled',
  'failed',
]
const CI_STATUSES: readonly ('requested' | 'running' | 'passed' | 'failed')[] = [
  'requested',
  'running',
  'passed',
  'failed',
]
const EXPLORATION_LEVELS: readonly ExplorationLevel[] = ['low', 'normal', 'high']
const ISSUE_LABELS: readonly IssueLabel[] = ['research', 'experiment', 'analysis', 'bug', 'blocked']
const ISSUE_RESOLUTIONS: readonly IssueResolution[] = ['accepted', 'rejected', 'abandoned']
const LINEAGE_STRATEGIES: readonly ExperimentLineage['strategy'][] = ['derive', 'fresh']
const ENVIRONMENT_KINDS: readonly EnvironmentDeclaration['kind'][] = ['uv-lock', 'requirements']
const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  'model-weights',
  'report',
  'figure',
  'logs',
  'other',
]
const ARTIFACT_RETENTIONS: readonly ArtifactRetention[] = ['keep', 'temporary']
const CI_FAILURE_REASONS: readonly CIFailureReason[] = [
  'environment-build-failed',
  'entry-failed',
  'missing-required-metric',
  'invalid-metrics',
  'timeout',
  'infrastructure',
  'cancelled',
]
const HOST_CANCEL_REASON = 'the experiment was cancelled by the host'

// ---------------------------------------------------------------------------
// Boundary helpers
// ---------------------------------------------------------------------------

type UnknownRecord = Readonly<Record<string, unknown>>

/**
 * Normalize an untrusted object. `typeof`/`Array.isArray` already prove the shape; the
 * assertion states it for the reader, which then reads every field as `unknown` and
 * validates it. No field is trusted before `Fields` accepted it.
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
  return text.length === 0 ? 'invalid input' : text
}

function invalidInput(message: string): Err<DomainError> {
  return { ok: false, error: { code: 'invalid-input', message: toMessage(message) } }
}

function forbidden(message: string): Err<DomainError> {
  return { ok: false, error: { code: 'forbidden', message: toMessage(message) } }
}

/**
 * Branding only: the caller already validated the value (non-empty string, finite number).
 * The brand is erased at runtime and does not assert a shape.
 */
function castId<T extends string>(value: string): T {
  return value as T
}

function castNumber<T extends number>(value: number): T {
  return value as T
}

function castNonEmpty<T>(values: readonly T[]): NonEmptyArray<T> {
  return values as NonEmptyArray<T>
}

/**
 * The single boundary conversion per constructed object. `Pick<T, keyof T>` keeps the whole
 * public surface (including every declared method signature) checked, so a missing or
 * mistyped member does not compile. Inside this generic helper `Pick<T, keyof T>` is
 * assignable to `T`: the private brand is not part of the public surface and cannot be
 * minted by any other module, which is exactly what makes the return the boundary.
 */
function boundary<T>(candidate: Pick<T, keyof T>): T {
  return candidate
}

/** Turn a refused non-`Result` method transition into a programming-error throw. */
function unwrapTransition<T>(result: Result<T, DomainError>, operation: string): T {
  if (result.ok) return result.value
  throw new Error(
    `factory boundary: ${operation} refused with ${result.error.code}: ${result.error.message}`,
  )
}

/**
 * Field reader over untrusted records. Failures accumulate on the root reader, so a
 * factory can read all fields and then return a single `Result`; the first failure names
 * the offending path. `unknown` fields are narrowed with `typeof` and literal loops, not
 * type predicates.
 */
class Fields {
  private readonly record: UnknownRecord
  private readonly root: Fields
  private firstFailure: string | undefined

  constructor(record: UnknownRecord, root?: Fields) {
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

  error(): Err<DomainError> | undefined {
    if (this.root.firstFailure === undefined) return undefined
    return invalidInput(this.root.firstFailure)
  }

  childValue(value: unknown, path: string): Fields {
    const record = asRecord(value)
    if (record === undefined) {
      this.fail(path, 'must be an object')
      return new Fields({}, this.root)
    }
    return new Fields(record, this.root)
  }

  child(key: string, path: string): Fields {
    return this.childValue(this.record[key], path)
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

  finite(key: string, path: string): number {
    return this.number(key, path, Number.isFinite, 'must be a finite number')
  }

  nonNegative(key: string, path: string): number {
    return this.number(
      key,
      path,
      (value) => Number.isFinite(value) && value >= 0,
      'must be a finite non-negative number',
    )
  }

  positive(key: string, path: string): number {
    return this.number(
      key,
      path,
      (value) => Number.isFinite(value) && value > 0,
      'must be a finite positive number',
    )
  }

  positiveInteger(key: string, path: string): number {
    return this.number(
      key,
      path,
      (value) => Number.isInteger(value) && value > 0,
      'must be a positive integer',
    )
  }

  nonNegativeInteger(key: string, path: string): number {
    return this.number(
      key,
      path,
      (value) => Number.isInteger(value) && value >= 0,
      'must be a non-negative integer',
    )
  }

  unitInterval(key: string, path: string): number {
    return this.number(
      key,
      path,
      (value) => Number.isFinite(value) && value >= 0 && value <= 1,
      'must be a finite number between 0 and 1',
    )
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
    if (fallback === undefined) {
      throw new Error('factory boundary: an allowed-value table must not be empty')
    }
    return fallback
  }

  array(key: string, path: string): readonly unknown[] {
    const value = this.record[key]
    if (Array.isArray(value)) return value
    this.fail(path, 'must be an array')
    return []
  }

  textArray(key: string, path: string, nonEmpty: boolean): string[] {
    const values = this.array(key, path)
    if (nonEmpty && values.length === 0) this.fail(path, 'must be a non-empty array')
    const texts: string[] = []
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index]
      if (typeof value === 'string' && value.trim().length > 0) texts.push(value)
      else this.fail(`${path}[${index}]`, 'must be a non-empty string')
    }
    return texts
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

  private number(
    key: string,
    path: string,
    valid: (value: number) => boolean,
    expectation: string,
  ): number {
    const value = this.record[key]
    if (typeof value === 'number' && valid(value)) return value
    this.fail(path, expectation)
    return 0
  }
}

function rootFields(input: unknown): Fields | undefined {
  const record = asRecord(input)
  return record === undefined ? undefined : new Fields(record)
}

/** Shared entry check: the input is an object and its status is the expected variant. */
function variantFields<T extends string>(
  input: unknown,
  label: string,
  allowed: readonly T[],
  expected: T,
): Result<Fields, DomainError> {
  const fields = rootFields(input)
  if (fields === undefined) return invalidInput(`${label} must be an object`)
  const status = fields.oneOf('status', `${label}.status`, allowed)
  if (status !== expected) return invalidInput(`${label}.status must be '${expected}'`)
  return ok(fields)
}

// ---------------------------------------------------------------------------
// Reader helpers for nested records
// ---------------------------------------------------------------------------

function readEvaluationContract(f: Fields): EvaluationContract {
  const ciEntry = f.text('ciEntry', 'contract.ciEntry')
  const timeoutMs = f.nonNegative('timeoutMs', 'contract.timeoutMs')
  const requiredMetrics = f.textArray('requiredMetrics', 'contract.requiredMetrics', true)
  return boundary<EvaluationContract>({
    ciEntry: castId<NonEmptyString>(ciEntry),
    timeoutMs: castNumber<DurationMs>(timeoutMs),
    requiredMetrics: castNonEmpty(
      requiredMetrics.map((name) => castId<MetricName>(name)),
    ),
  })
}

function readMetricDefinition(f: Fields, index: number): MetricDefinition {
  const path = `utility.metrics[${index}]`
  const name = f.text('name', `${path}.name`)
  const direction = f.oneOf('direction', `${path}.direction`, ['higher', 'lower'] as const)
  const weight = f.positive('weight', `${path}.weight`)
  return boundary<MetricDefinition>({
    name: castId<MetricName>(name),
    direction,
    weight: castNumber<PositiveNumber>(weight),
  })
}

function readUtilityConfig(f: Fields): UtilityConfig {
  const values = f.array('metrics', 'utility.metrics')
  if (values.length === 0) f.fail('utility.metrics', 'must be a non-empty array')
  const metrics = values.map((value, index) =>
    readMetricDefinition(f.childValue(value, `utility.metrics[${index}]`), index),
  )
  return boundary<UtilityConfig>({ metrics: castNonEmpty(metrics) })
}

function readBudget(f: Fields): Budget {
  return boundary<Budget>({
    maxExperiments: castNumber<PositiveInt>(
      f.positiveInteger('maxExperiments', 'program.budget.maxExperiments'),
    ),
    maxComputeMinutes: castNumber<PositiveInt>(
      f.positiveInteger('maxComputeMinutes', 'program.budget.maxComputeMinutes'),
    ),
    maxTokens: castNumber<PositiveInt>(f.positiveInteger('maxTokens', 'program.budget.maxTokens')),
  })
}

function readUsage(f: Fields): BudgetUsage {
  return boundary<BudgetUsage>({
    experiments: castNumber<NonNegativeNumber>(
      f.nonNegative('experiments', 'program.usage.experiments'),
    ),
    computeMinutes: castNumber<NonNegativeNumber>(
      f.nonNegative('computeMinutes', 'program.usage.computeMinutes'),
    ),
    tokens: castNumber<NonNegativeNumber>(f.nonNegative('tokens', 'program.usage.tokens')),
  })
}

function readProgramCommon(f: Fields): ProgramCommonData {
  return {
    id: f.text('id', 'program.id'),
    name: f.text('name', 'program.name'),
    goal: f.text('goal', 'program.goal'),
    methodology: f.text('methodology', 'program.methodology'),
    contract: readEvaluationContract(f.child('contract', 'program.contract')),
    utility: readUtilityConfig(f.child('utility', 'program.utility')),
    exploration: f.oneOf('exploration', 'program.exploration', EXPLORATION_LEVELS),
    budget: readBudget(f.child('budget', 'program.budget')),
    usage: readUsage(f.child('usage', 'program.usage')),
    createdAt: f.text('createdAt', 'program.createdAt'),
  }
}

function readIssueAuthor(f: Fields): IssueAuthorRefData {
  const kind = f.oneOf('kind', 'issue.author.kind', ['operator', 'researcher'] as const)
  const sessionId = f.text('sessionId', 'issue.author.sessionId')
  return { kind, sessionId }
}

function readIssueCommon(f: Fields): IssueCommonData {
  const labels = f
    .array('labels', 'issue.labels')
    .map((value, index) => f.oneOfValue(value, `issue.labels[${index}]`, ISSUE_LABELS))
  return {
    id: f.text('id', 'issue.id'),
    programId: f.text('programId', 'issue.programId'),
    title: f.text('title', 'issue.title'),
    body: f.text('body', 'issue.body'),
    labels,
    author: readIssueAuthor(f.child('author', 'issue.author')),
    createdAt: f.text('createdAt', 'issue.createdAt'),
  }
}

/** Accept the domain record (`assigneeSessionId`) and the principal-shaped row. */
function readAssigneeSession(f: Fields, path: string): string {
  if (f.has('assigneeSessionId')) return f.text('assigneeSessionId', `${path}.assigneeSessionId`)
  if (f.has('assignee')) {
    const assignee = f.child('assignee', `${path}.assignee`)
    assignee.oneOf('kind', `${path}.assignee.kind`, ['researcher'] as const)
    return assignee.text('sessionId', `${path}.assignee.sessionId`)
  }
  f.fail(path, 'must carry assigneeSessionId')
  return ''
}

function readNullableAssigneeSession(f: Fields, path: string): string | null {
  if (f.has('assigneeSessionId')) return f.nullableText('assigneeSessionId', path)
  if (f.has('assignee')) {
    const assignee = f.child('assignee', `${path}.assignee`)
    assignee.oneOf('kind', `${path}.assignee.kind`, ['researcher'] as const)
    return assignee.text('sessionId', `${path}.assignee.sessionId`)
  }
  return null
}

function readEnvironment(f: Fields): EnvironmentDeclaration {
  const kind = f.oneOf('kind', 'experiment.environment.kind', ENVIRONMENT_KINDS)
  const pythonVersion = f.text('pythonVersion', 'experiment.environment.pythonVersion')
  if (kind === 'uv-lock') {
    return {
      kind,
      lockFile: f.text('lockFile', 'experiment.environment.lockFile'),
      pythonVersion,
    }
  }
  return {
    kind,
    requirementsFile: f.text('requirementsFile', 'experiment.environment.requirementsFile'),
    pythonVersion,
  }
}

function readDerivedLineage(f: Fields): DerivedLineage {
  return boundary<DerivedLineage>({
    strategy: 'derive',
    baseExperimentId: castId<ExperimentId>(
      f.text('baseExperimentId', 'experiment.lineage.baseExperimentId'),
    ),
    baseCommit: castId<CommitSha>(f.text('baseCommit', 'experiment.lineage.baseCommit')),
    temperature: f.positive('temperature', 'experiment.lineage.temperature'),
    sampledWeight: f.nonNegative('sampledWeight', 'experiment.lineage.sampledWeight'),
  })
}

function readFreshLineage(f: Fields): FreshLineage {
  return boundary<FreshLineage>({
    strategy: 'fresh',
    baseCommit: castId<CommitSha>(f.text('baseCommit', 'experiment.lineage.baseCommit')),
    freshStartProbability: f.unitInterval(
      'freshStartProbability',
      'experiment.lineage.freshStartProbability',
    ),
  })
}

function readLineage(f: Fields): ExperimentLineage {
  const lineage = f.child('lineage', 'experiment.lineage')
  const strategy = lineage.oneOf('strategy', 'experiment.lineage.strategy', LINEAGE_STRATEGIES)
  return strategy === 'derive' ? readDerivedLineage(lineage) : readFreshLineage(lineage)
}

/** Experiments may carry the Ticket they are bound to, so submit/revise can check it. */
function readOptionalTicket(f: Fields): Ticket | undefined {
  if (!f.has('ticket')) return undefined
  const value = f.raw('ticket')
  const record = asRecord(value)
  if (record === undefined) {
    f.fail('experiment.ticket', 'must be an object')
    return undefined
  }
  const ticket = createTicketForStatus(value, record['status'])
  if (!ticket.ok) {
    f.fail('experiment.ticket', `is invalid: ${ticket.error.message}`)
    return undefined
  }
  return ticket.value
}

function readCreatedBySession(f: Fields): string {
  if (f.has('createdBySessionId')) return f.text('createdBySessionId', 'experiment.createdBySessionId')
  if (f.has('createdBy')) {
    const createdBy = f.child('createdBy', 'experiment.createdBy')
    createdBy.oneOf('kind', 'experiment.createdBy.kind', ['researcher'] as const)
    return createdBy.text('sessionId', 'experiment.createdBy.sessionId')
  }
  f.fail('experiment', 'must carry createdBySessionId')
  return ''
}

function readExperimentBase(f: Fields): ExperimentBaseData {
  return {
    id: f.text('id', 'experiment.id'),
    programId: f.text('programId', 'experiment.programId'),
    issueId: f.text('issueId', 'experiment.issueId'),
    branch: f.text('branch', 'experiment.branch'),
    head: f.text('head', 'experiment.head'),
    environment: readEnvironment(f.child('environment', 'experiment.environment')),
    lineage: readLineage(f),
    planCommentId: f.text('planCommentId', 'experiment.planCommentId'),
    createdBySessionId: readCreatedBySession(f),
    createdAt: f.text('createdAt', 'experiment.createdAt'),
  }
}

function readOpenExperimentData(f: Fields): OpenExperimentData {
  return { ...readExperimentBase(f), status: 'open' }
}

function readReadyExperimentData(f: Fields): ReadyExperimentData {
  return {
    ...readExperimentBase(f),
    status: 'ready',
    readyAt: f.text('readyAt', 'experiment.readyAt'),
  }
}

function readCIPendingExperimentData(f: Fields): CIPendingExperimentData {
  return {
    ...readExperimentBase(f),
    status: 'ci-pending',
    ciRunId: f.text('ciRunId', 'experiment.ciRunId'),
    requestedAt: f.text('requestedAt', 'experiment.requestedAt'),
  }
}

function readCIRunningExperimentData(f: Fields): CIRunningExperimentData {
  return {
    ...readCIPendingExperimentData(f),
    status: 'ci-running',
    startedAt: f.text('startedAt', 'experiment.startedAt'),
    environmentDigest: f.text('environmentDigest', 'experiment.environmentDigest'),
  }
}

function readCIPassedExperimentData(f: Fields): CIPassedExperimentData {
  return {
    ...readCIRunningExperimentData(f),
    status: 'ci-passed',
    finishedAt: f.text('finishedAt', 'experiment.finishedAt'),
  }
}

function readCIFailedExperimentData(f: Fields): CIFailedExperimentData {
  const pending = readCIPendingExperimentData(f)
  return {
    ...pending,
    status: 'ci-failed',
    startedAt: f.optionalText('startedAt', 'experiment.startedAt'),
    environmentDigest: f.optionalText('environmentDigest', 'experiment.environmentDigest'),
    failureReason: f.oneOf('failureReason', 'experiment.failureReason', CI_FAILURE_REASONS),
    failureDetail: f.stringValue('failureDetail', 'experiment.failureDetail'),
    failedAt: f.text('failedAt', 'experiment.failedAt'),
  }
}

function readClosedExperimentData(f: Fields): ClosedExperimentData {
  return {
    ...readExperimentBase(f),
    status: 'closed',
    closedAt: f.text('closedAt', 'experiment.closedAt'),
    closeReason: f.text('closeReason', 'experiment.closeReason'),
    outcome: f.oneOf('outcome', 'experiment.outcome', ['concluded', 'failed', 'cancelled'] as const),
  }
}

function readTicketBase(f: Fields): Omit<TicketData, 'status'> {
  return {
    id: f.text('id', 'ticket.id'),
    programId: f.text('programId', 'ticket.programId'),
    issueId: f.text('issueId', 'ticket.issueId'),
    experimentId: f.text('experimentId', 'ticket.experimentId'),
    baseCommit: f.text('baseCommit', 'ticket.baseCommit'),
    createdAt: f.text('createdAt', 'ticket.createdAt'),
  }
}

function readOpenTicket(f: Fields): OpenTicket {
  const base = readTicketBase(f)
  return {
    id: castId<TicketId>(base.id),
    programId: castId<ProgramId>(base.programId),
    issueId: castId<IssueId>(base.issueId),
    experimentId: castId<ExperimentId>(base.experimentId),
    baseCommit: castId<CommitSha>(base.baseCommit),
    createdAt: castId<IsoTimestamp>(base.createdAt),
    status: 'open',
  }
}

function readRunningTicket(f: Fields): RunningTicket {
  return {
    ...readOpenTicket(f),
    status: 'running',
    sessionId: castId<ImplementerSessionId>(f.text('sessionId', 'ticket.sessionId')),
    startedAt: castId<IsoTimestamp>(f.text('startedAt', 'ticket.startedAt')),
  }
}

function readSubmittedTicket(f: Fields): SubmittedTicket {
  return {
    ...readOpenTicket(f),
    status: 'submitted',
    sessionId: castId<ImplementerSessionId>(f.text('sessionId', 'ticket.sessionId')),
    head: castId<CommitSha>(f.text('head', 'ticket.head')),
    submittedAt: castId<IsoTimestamp>(f.text('submittedAt', 'ticket.submittedAt')),
  }
}

function readCancelledTicket(f: Fields): CancelledTicket {
  return {
    ...readOpenTicket(f),
    status: 'cancelled',
    reason: f.stringValue('reason', 'ticket.reason'),
    cancelledAt: castId<IsoTimestamp>(f.text('cancelledAt', 'ticket.cancelledAt')),
  }
}

function readFailedTicket(f: Fields): FailedTicket {
  return {
    ...readOpenTicket(f),
    status: 'failed',
    reason: f.stringValue('reason', 'ticket.reason'),
    failedAt: castId<IsoTimestamp>(f.text('failedAt', 'ticket.failedAt')),
  }
}

function ticketToData(ticket: Ticket): TicketData {
  switch (ticket.status) {
    case 'open':
      return {
        id: ticket.id,
        programId: ticket.programId,
        issueId: ticket.issueId,
        experimentId: ticket.experimentId,
        baseCommit: ticket.baseCommit,
        createdAt: ticket.createdAt,
        status: 'open',
      }
    case 'running':
      return {
        id: ticket.id,
        programId: ticket.programId,
        issueId: ticket.issueId,
        experimentId: ticket.experimentId,
        baseCommit: ticket.baseCommit,
        createdAt: ticket.createdAt,
        status: 'running',
        sessionId: ticket.sessionId,
        startedAt: ticket.startedAt,
      }
    case 'submitted':
      return {
        id: ticket.id,
        programId: ticket.programId,
        issueId: ticket.issueId,
        experimentId: ticket.experimentId,
        baseCommit: ticket.baseCommit,
        createdAt: ticket.createdAt,
        status: 'submitted',
        sessionId: ticket.sessionId,
        head: ticket.head,
        submittedAt: ticket.submittedAt,
      }
    case 'cancelled':
      return {
        id: ticket.id,
        programId: ticket.programId,
        issueId: ticket.issueId,
        experimentId: ticket.experimentId,
        baseCommit: ticket.baseCommit,
        createdAt: ticket.createdAt,
        status: 'cancelled',
        reason: ticket.reason,
        cancelledAt: ticket.cancelledAt,
      }
    case 'failed':
      return {
        id: ticket.id,
        programId: ticket.programId,
        issueId: ticket.issueId,
        experimentId: ticket.experimentId,
        baseCommit: ticket.baseCommit,
        createdAt: ticket.createdAt,
        status: 'failed',
        reason: ticket.reason,
        failedAt: ticket.failedAt,
      }
  }
}

function readRequestedBySession(f: Fields, path: string): string {
  if (f.has('requestedBy')) return f.text('requestedBy', `${path}.requestedBy`)
  return f.text('requestedBySessionId', `${path}.requestedBySessionId`)
}

function readMetrics(f: Fields, path: string): MetricMap {
  const record = f.recordValue('metrics', path)
  const metrics: Record<MetricName, number> = {}
  for (const [name, value] of Object.entries(record)) {
    if (name.trim().length === 0) {
      f.fail(path, 'metric names must be non-empty')
      continue
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      f.fail(`${path}.${name}`, 'must be a finite number')
      continue
    }
    metrics[castId<MetricName>(name)] = value
  }
  return metrics
}

function readArtifacts(f: Fields, path: string): readonly ArtifactRef[] {
  const values = f.array('artifacts', path)
  const artifacts: ArtifactRef[] = []
  for (const value of values) {
    const artifact = createArtifactRef(value)
    if (!artifact.ok) {
      f.fail(path, `contains an invalid artifact: ${artifact.error.message}`)
      continue
    }
    artifacts.push(artifact.value)
  }
  return artifacts
}

function readPassedCIRecord(f: Fields): PassedCIRecord {
  return {
    id: castId<CIRunId>(f.text('id', 'ci record.id')),
    programId: castId<ProgramId>(f.text('programId', 'ci record.programId')),
    experimentId: castId<ExperimentId>(f.text('experimentId', 'ci record.experimentId')),
    commit: castId<CommitSha>(f.text('commit', 'ci record.commit')),
    requestedBy: castId<ResearcherSessionId>(
      readRequestedBySession(f, 'ci record'),
    ),
    requestedAt: castId<IsoTimestamp>(f.text('requestedAt', 'ci record.requestedAt')),
    status: 'passed',
    startedAt: castId<IsoTimestamp>(f.text('startedAt', 'ci record.startedAt')),
    finishedAt: castId<IsoTimestamp>(f.text('finishedAt', 'ci record.finishedAt')),
    environmentDigest: f.text('environmentDigest', 'ci record.environmentDigest'),
    metrics: readMetrics(f, 'ci record.metrics'),
    artifacts: readArtifacts(f, 'ci record.artifacts'),
    durationMs: castNumber<DurationMs>(f.nonNegative('durationMs', 'ci record.durationMs')),
  }
}

function readFailedCIRecord(f: Fields): FailedCIRecord {
  const startedAt = f.optionalText('startedAt', 'ci record.startedAt')
  const environmentDigest = f.optionalText('environmentDigest', 'ci record.environmentDigest')
  return {
    id: castId<CIRunId>(f.text('id', 'ci record.id')),
    programId: castId<ProgramId>(f.text('programId', 'ci record.programId')),
    experimentId: castId<ExperimentId>(f.text('experimentId', 'ci record.experimentId')),
    commit: castId<CommitSha>(f.text('commit', 'ci record.commit')),
    requestedBy: castId<ResearcherSessionId>(readRequestedBySession(f, 'ci record')),
    requestedAt: castId<IsoTimestamp>(f.text('requestedAt', 'ci record.requestedAt')),
    status: 'failed',
    ...(startedAt === undefined
      ? {}
      : { startedAt: castId<IsoTimestamp>(startedAt) }),
    ...(environmentDigest === undefined ? {} : { environmentDigest }),
    reason: f.oneOf('reason', 'ci record.reason', CI_FAILURE_REASONS),
    detail: f.stringValue('detail', 'ci record.detail'),
    durationMs: castNumber<DurationMs>(f.nonNegative('durationMs', 'ci record.durationMs')),
    finishedAt: castId<IsoTimestamp>(f.text('finishedAt', 'ci record.finishedAt')),
  }
}

function passedCIRecordData(record: PassedCIRecord): PassedCIRecordData {
  return {
    id: record.id,
    programId: record.programId,
    experimentId: record.experimentId,
    commit: record.commit,
    requestedBySessionId: record.requestedBy,
    requestedAt: record.requestedAt,
    status: 'passed',
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    environmentDigest: record.environmentDigest,
    metrics: record.metrics,
    artifacts: record.artifacts,
    durationMs: record.durationMs,
  }
}

function failedCIRecordData(record: FailedCIRecord): FailedCIRecordData {
  return {
    id: record.id,
    programId: record.programId,
    experimentId: record.experimentId,
    commit: record.commit,
    requestedBySessionId: record.requestedBy,
    requestedAt: record.requestedAt,
    status: 'failed',
    startedAt: record.startedAt,
    environmentDigest: record.environmentDigest,
    reason: record.reason,
    detail: record.detail,
    durationMs: record.durationMs,
    finishedAt: record.finishedAt,
  }
}

// ---------------------------------------------------------------------------
// Principals and ownership tokens
// ---------------------------------------------------------------------------

function operatorPrincipal(sessionId: string): OperatorPrincipal {
  return boundary<OperatorPrincipal>({
    kind: 'operator',
    sessionId: castId<OperatorSessionId>(sessionId),
  })
}

function researcherPrincipal(sessionId: string): ResearcherPrincipal {
  return boundary<ResearcherPrincipal>({
    kind: 'researcher',
    sessionId: castId<ResearcherSessionId>(sessionId),
  })
}

function implementerPrincipal(sessionId: string, ticketId: string): ImplementerPrincipal {
  return boundary<ImplementerPrincipal>({
    kind: 'implementer',
    sessionId: castId<ImplementerSessionId>(sessionId),
    ticketId: castId<TicketId>(ticketId),
  })
}

function watchdogPrincipal(sessionId: string): WatchdogPrincipal {
  return boundary<WatchdogPrincipal>({
    kind: 'watchdog',
    sessionId: castId<WatchdogSessionId>(sessionId),
  })
}

function routerPrincipal(sessionId: string): RouterPrincipal {
  return boundary<RouterPrincipal>({
    kind: 'router',
    sessionId: castId<RouterSessionId>(sessionId),
  })
}

function issueAuthorPrincipal(author: IssueAuthorRefData): IssueAuthor {
  return author.kind === 'operator'
    ? operatorPrincipal(author.sessionId)
    : researcherPrincipal(author.sessionId)
}

function assembleIssueAssignment(data: IssueAssignmentData): IssueAssignment {
  return boundary<IssueAssignment>({
    issueId: castId<IssueId>(data.issueId),
    assignee: researcherPrincipal(data.assigneeSessionId),
  })
}

function assembleTicketBinding(data: TicketBindingData): TicketBinding {
  return boundary<TicketBinding>({
    ticketId: castId<TicketId>(data.ticketId),
    experimentId: castId<ExperimentId>(data.experimentId),
    sessionId: castId<ImplementerSessionId>(data.sessionId),
  })
}

/** The one root authority; the composition root creates it at startup. */
export function createHostPrincipal(): HostPrincipal {
  return boundary<HostPrincipal>({ kind: 'host' })
}

/** The Host clock's only implementation; callers inject it instead of reading `Date`. */
export function createClock(): Clock {
  return {
    now(): IsoTimestamp {
      return castId<IsoTimestamp>(new Date().toISOString())
    },
  }
}

export function createOperatorPrincipal(sessionId: OperatorSessionId): OperatorPrincipal {
  return operatorPrincipal(sessionId)
}

export function createResearcherPrincipal(sessionId: ResearcherSessionId): ResearcherPrincipal {
  return researcherPrincipal(sessionId)
}

export function createImplementerPrincipal(
  sessionId: ImplementerSessionId,
  ticketId: TicketId,
): ImplementerPrincipal {
  return implementerPrincipal(sessionId, ticketId)
}

export function createWatchdogPrincipal(sessionId: WatchdogSessionId): WatchdogPrincipal {
  return watchdogPrincipal(sessionId)
}

export function createRouterPrincipal(sessionId: RouterSessionId): RouterPrincipal {
  return routerPrincipal(sessionId)
}

export function createIssueAssignment(
  issueId: IssueId,
  assignee: ResearcherPrincipal,
): Result<IssueAssignment, DomainError> {
  if (issueId.length === 0) return invalidInput('issue id must be non-empty')
  if (assignee.kind !== 'researcher') {
    return invalidInput('an issue assignment requires a researcher principal')
  }
  return ok(
    assembleIssueAssignment({ issueId, assigneeSessionId: assignee.sessionId }),
  )
}

/**
 * Mint the Implementer binding only from a Ticket, after the Program, Issue, Experiment and
 * Session expectation was checked. Accepted shapes:
 * - `{ ticket, expected: { programId, issueId, experimentId, sessionId } }`
 * - `{ ticket, programId, issueId, experimentId, sessionId }`
 *
 * A bare `{ ticketId, experimentId, sessionId }` is rejected: it would let a caller skip
 * the Ticket comparison the runtime contract requires.
 */
export function createTicketBinding(input: unknown): Result<TicketBinding, DomainError> {
  const f = rootFields(input)
  if (f === undefined) return invalidInput('ticket binding input must be an object')

  const ticketValue = f.raw('ticket')
  if (ticketValue === undefined) {
    return invalidInput('ticket binding input must carry the ticket it was minted from')
  }
  const ticketRecord = asRecord(ticketValue)
  if (ticketRecord === undefined) return invalidInput('ticket binding.ticket must be an object')
  const ticket = createTicketForStatus(ticketValue, ticketRecord['status'])
  if (!ticket.ok) return ticket

  const expectedFields = f.has('expected') ? f.child('expected', 'ticket binding.expected') : f
  const expected: TicketBindingExpectationData = {
    programId: expectedFields.text('programId', 'ticket binding.programId'),
    issueId: expectedFields.text('issueId', 'ticket binding.issueId'),
    experimentId: expectedFields.text('experimentId', 'ticket binding.experimentId'),
    sessionId: expectedFields.text('sessionId', 'ticket binding.sessionId'),
  }
  const failure = f.error()
  if (failure !== undefined) return failure

  const bound = mintTicketBindingTransition(ticketToData(ticket.value), expected)
  if (!bound.ok) return bound
  return ok(assembleTicketBinding(bound.value))
}

// ---------------------------------------------------------------------------
// Program states
// ---------------------------------------------------------------------------

function readRunningProgramData(f: Fields): RunningProgramData {
  return { ...readProgramCommon(f), status: 'running' }
}

function readPausedProgramData(f: Fields): PausedProgramData {
  return {
    ...readProgramCommon(f),
    status: 'paused',
    pausedAt: f.text('pausedAt', 'program.pausedAt'),
  }
}

function readStoppedProgramData(f: Fields): StoppedProgramData {
  return {
    ...readProgramCommon(f),
    status: 'stopped',
    stoppedAt: f.text('stoppedAt', 'program.stoppedAt'),
    stopReason: f.text('stopReason', 'program.stopReason'),
  }
}

function readCompletedProgramData(f: Fields): CompletedProgramData {
  return {
    ...readProgramCommon(f),
    status: 'completed',
    completedAt: f.text('completedAt', 'program.completedAt'),
    completionReason: f.text('completionReason', 'program.completionReason'),
  }
}

function programFields(data: ProgramCommonData) {
  return {
    id: castId<ProgramId>(data.id),
    name: castId<NonEmptyString>(data.name),
    goal: castId<NonEmptyString>(data.goal),
    methodology: castId<NonEmptyString>(data.methodology),
    contract: data.contract,
    utility: data.utility,
    exploration: data.exploration,
    budget: {
      maxExperiments: castNumber<PositiveInt>(data.budget.maxExperiments),
      maxComputeMinutes: castNumber<PositiveInt>(data.budget.maxComputeMinutes),
      maxTokens: castNumber<PositiveInt>(data.budget.maxTokens),
    },
    usage: {
      experiments: castNumber<NonNegativeNumber>(data.usage.experiments),
      computeMinutes: castNumber<NonNegativeNumber>(data.usage.computeMinutes),
      tokens: castNumber<NonNegativeNumber>(data.usage.tokens),
    },
    createdAt: castId<IsoTimestamp>(data.createdAt),
  }
}

function assembleRunningProgram(data: RunningProgramData): RunningProgram {
  return boundary<RunningProgram>({
    ...programFields(data),
    status: 'running',
    pause(_actor: OperatorPrincipal, at: IsoTimestamp): PausedProgram {
      return assemblePausedProgram(unwrapTransition(pauseProgramTransition(data, at), 'pause'))
    },
    pauseForBudget(_actor: HostPrincipal, at: IsoTimestamp): PausedProgram {
      return assemblePausedProgram(unwrapTransition(pauseProgramTransition(data, at), 'pauseForBudget'))
    },
    resume(_actor: OperatorPrincipal, _at: IsoTimestamp): RunningProgram {
      // The state machine only resumes a paused Program; the declared method is kept and
      // a call on a running Program is a programming error.
      return assembleRunningProgram(unwrapTransition(resumeProgramTransition(data), 'resume'))
    },
    stop(_actor: OperatorPrincipal, reason: NonEmptyString, at: IsoTimestamp): StoppedProgram {
      return assembleStoppedProgram(unwrapTransition(stopProgramTransition(data, reason, at), 'stop'))
    },
    complete(_actor: HostPrincipal, reason: NonEmptyString, at: IsoTimestamp): CompletedProgram {
      return assembleCompletedProgram(
        unwrapTransition(completeProgramTransition(data, reason, at), 'complete'),
      )
    },
    setGoal(_actor: OperatorPrincipal, goal: NonEmptyString, _at: IsoTimestamp): RunningProgram {
      const next = unwrapTransition(setGoalTransition(data, goal), 'setGoal')
      if (next.status !== 'running') {
        throw new Error('factory boundary: setGoal on a running program must stay running')
      }
      return assembleRunningProgram(next)
    },
    setMethodology(
      _actor: OperatorPrincipal,
      methodology: NonEmptyString,
      _at: IsoTimestamp,
    ): RunningProgram {
      const next = unwrapTransition(setMethodologyTransition(data, methodology), 'setMethodology')
      if (next.status !== 'running') {
        throw new Error('factory boundary: setMethodology on a running program must stay running')
      }
      return assembleRunningProgram(next)
    },
    setExploration(
      _actor: OperatorPrincipal,
      level: ExplorationLevel,
      _at: IsoTimestamp,
    ): RunningProgram {
      const next = unwrapTransition(setExplorationTransition(data, level), 'setExploration')
      if (next.status !== 'running') {
        throw new Error('factory boundary: setExploration on a running program must stay running')
      }
      return assembleRunningProgram(next)
    },
    recordUsage(_actor: HostPrincipal, delta: UsageDelta): RunningProgram {
      const next = unwrapTransition(recordUsageTransition(data, delta), 'recordUsage')
      if (next.status !== 'running') {
        throw new Error('factory boundary: recordUsage on a running program must stay running')
      }
      return assembleRunningProgram(next)
    },
  })
}

function assemblePausedProgram(data: PausedProgramData): PausedProgram {
  return boundary<PausedProgram>({
    ...programFields(data),
    status: 'paused',
    pausedAt: castId<IsoTimestamp>(data.pausedAt),
    resume(_actor: OperatorPrincipal, _at: IsoTimestamp): RunningProgram {
      return assembleRunningProgram(unwrapTransition(resumeProgramTransition(data), 'resume'))
    },
    stop(_actor: OperatorPrincipal, reason: NonEmptyString, at: IsoTimestamp): StoppedProgram {
      return assembleStoppedProgram(unwrapTransition(stopProgramTransition(data, reason, at), 'stop'))
    },
    complete(_actor: HostPrincipal, reason: NonEmptyString, at: IsoTimestamp): CompletedProgram {
      return assembleCompletedProgram(
        unwrapTransition(completeProgramTransition(data, reason, at), 'complete'),
      )
    },
    setGoal(_actor: OperatorPrincipal, goal: NonEmptyString, _at: IsoTimestamp): PausedProgram {
      const next = unwrapTransition(setGoalTransition(data, goal), 'setGoal')
      if (next.status !== 'paused') {
        throw new Error('factory boundary: setGoal on a paused program must stay paused')
      }
      return assemblePausedProgram(next)
    },
    setMethodology(
      _actor: OperatorPrincipal,
      methodology: NonEmptyString,
      _at: IsoTimestamp,
    ): PausedProgram {
      const next = unwrapTransition(setMethodologyTransition(data, methodology), 'setMethodology')
      if (next.status !== 'paused') {
        throw new Error('factory boundary: setMethodology on a paused program must stay paused')
      }
      return assemblePausedProgram(next)
    },
    setExploration(
      _actor: OperatorPrincipal,
      level: ExplorationLevel,
      _at: IsoTimestamp,
    ): PausedProgram {
      const next = unwrapTransition(setExplorationTransition(data, level), 'setExploration')
      if (next.status !== 'paused') {
        throw new Error('factory boundary: setExploration on a paused program must stay paused')
      }
      return assemblePausedProgram(next)
    },
    recordUsage(_actor: HostPrincipal, delta: UsageDelta): PausedProgram {
      const next = unwrapTransition(recordUsageTransition(data, delta), 'recordUsage')
      if (next.status !== 'paused') {
        throw new Error('factory boundary: recordUsage on a paused program must stay paused')
      }
      return assemblePausedProgram(next)
    },
  })
}

function assembleStoppedProgram(data: StoppedProgramData): StoppedProgram {
  return boundary<StoppedProgram>({
    ...programFields(data),
    status: 'stopped',
    stoppedAt: castId<IsoTimestamp>(data.stoppedAt),
    stopReason: castId<NonEmptyString>(data.stopReason),
  })
}

function assembleCompletedProgram(data: CompletedProgramData): CompletedProgram {
  return boundary<CompletedProgram>({
    ...programFields(data),
    status: 'completed',
    completedAt: castId<IsoTimestamp>(data.completedAt),
    completionReason: castId<NonEmptyString>(data.completionReason),
  })
}

export function createRunningProgram(input: unknown): Result<RunningProgram, DomainError> {
  const fields = variantFields(input, 'program', PROGRAM_STATUSES, 'running')
  if (!fields.ok) return fields
  const data = readRunningProgramData(fields.value)
  const failure = fields.value.error()
  if (failure !== undefined) return failure
  return ok(assembleRunningProgram(data))
}

export function createPausedProgram(input: unknown): Result<PausedProgram, DomainError> {
  const fields = variantFields(input, 'program', PROGRAM_STATUSES, 'paused')
  if (!fields.ok) return fields
  const data = readPausedProgramData(fields.value)
  const failure = fields.value.error()
  if (failure !== undefined) return failure
  return ok(assemblePausedProgram(data))
}

export function createStoppedProgram(input: unknown): Result<StoppedProgram, DomainError> {
  const fields = variantFields(input, 'program', PROGRAM_STATUSES, 'stopped')
  if (!fields.ok) return fields
  const data = readStoppedProgramData(fields.value)
  const failure = fields.value.error()
  if (failure !== undefined) return failure
  return ok(assembleStoppedProgram(data))
}

export function createCompletedProgram(input: unknown): Result<CompletedProgram, DomainError> {
  const fields = variantFields(input, 'program', PROGRAM_STATUSES, 'completed')
  if (!fields.ok) return fields
  const data = readCompletedProgramData(fields.value)
  const failure = fields.value.error()
  if (failure !== undefined) return failure
  return ok(assembleCompletedProgram(data))
}

// ---------------------------------------------------------------------------
// Issue states
// ---------------------------------------------------------------------------

function issueFields(data: IssueCommonData) {
  return {
    id: castId<IssueId>(data.id),
    programId: castId<ProgramId>(data.programId),
    title: castId<NonEmptyString>(data.title),
    body: castId<NonEmptyString>(data.body),
    labels: data.labels,
    author: issueAuthorPrincipal(data.author),
    createdAt: castId<IsoTimestamp>(data.createdAt),
  }
}

function readOpenIssueData(f: Fields): OpenIssueData {
  return { ...readIssueCommon(f), status: 'open' }
}

function readAssignedIssueData(f: Fields): AssignedIssueData {
  return {
    ...readIssueCommon(f),
    status: 'assigned',
    assigneeSessionId: readAssigneeSession(f, 'issue'),
    assignedAt: f.text('assignedAt', 'issue.assignedAt'),
    experimentIds: f
      .array('experimentIds', 'issue.experimentIds')
      .map((value, index) => {
        if (typeof value === 'string' && value.trim().length > 0) return value
        f.fail(`issue.experimentIds[${index}]`, 'must be a non-empty string')
        return ''
      }),
  }
}

function readClosedIssueData(f: Fields): ClosedIssueData {
  return {
    ...readIssueCommon(f),
    status: 'closed',
    assigneeSessionId: readNullableAssigneeSession(f, 'issue'),
    closedAt: f.text('closedAt', 'issue.closedAt'),
    resolution: f.oneOf('resolution', 'issue.resolution', ISSUE_RESOLUTIONS),
    summary: f.text('summary', 'issue.summary'),
  }
}

function issueResolutionOrThrow(value: IssueResolution): IssueResolution {
  for (const resolution of ISSUE_RESOLUTIONS) {
    if (value === resolution) return resolution
  }
  throw new Error('factory boundary: the issue resolution is not part of the contract')
}

function assembleOpenIssue(data: OpenIssueData): OpenIssue {
  return boundary<OpenIssue>({
    ...issueFields(data),
    status: 'open',
    claim(actor: ResearcherPrincipal, at: IsoTimestamp): AssignedIssue {
      return assembleAssignedIssue(
        unwrapTransition(claimIssueTransition(data, actor.sessionId, at), 'claim'),
      )
    },
    close(
      _actor: OperatorPrincipal,
      resolution: IssueResolution,
      summary: NonEmptyString,
      at: IsoTimestamp,
    ): ClosedIssue {
      const validResolution = issueResolutionOrThrow(resolution)
      return assembleClosedIssue(
        unwrapTransition(
          closeOpenIssueTransition(data, validResolution, summary, at),
          'close',
        ),
      )
    },
  })
}

function issueAssignmentData(assignment: IssueAssignment): IssueAssignmentData {
  return {
    issueId: assignment.issueId,
    assigneeSessionId: assignment.assignee.sessionId,
  }
}

function assembleAssignedIssue(data: AssignedIssueData): AssignedIssue {
  return boundary<AssignedIssue>({
    ...issueFields(data),
    status: 'assigned',
    assignee: researcherPrincipal(data.assigneeSessionId),
    assignedAt: castId<IsoTimestamp>(data.assignedAt),
    experimentIds: data.experimentIds.map((id) => castId<ExperimentId>(id)),
    authorize(actor: ResearcherPrincipal): Result<IssueAssignment, DomainError> {
      const authorized = authorizeIssueTransition(data, actor.sessionId)
      if (!authorized.ok) return authorized
      return ok(assembleIssueAssignment(authorized.value))
    },
    addExperiment(
      assignment: IssueAssignment,
      experimentId: ExperimentId,
      _at: IsoTimestamp,
    ): Result<AssignedIssue, DomainError> {
      const next = addExperimentTransition(data, issueAssignmentData(assignment), experimentId)
      if (!next.ok) return next
      return ok(assembleAssignedIssue(next.value))
    },
    close(
      assignment: IssueAssignment,
      resolution: IssueResolution,
      summary: NonEmptyString,
      at: IsoTimestamp,
    ): Result<ClosedIssue, DomainError> {
      const validResolution = issueResolutionOrThrow(resolution)
      const next = closeAssignedIssueTransition(
        data,
        issueAssignmentData(assignment),
        validResolution,
        summary,
        at,
      )
      if (!next.ok) return next
      return ok(assembleClosedIssue(next.value))
    },
  })
}

function assembleClosedIssue(data: ClosedIssueData): ClosedIssue {
  return boundary<ClosedIssue>({
    ...issueFields(data),
    status: 'closed',
    assigneeSessionId:
      data.assigneeSessionId === null
        ? null
        : castId<ResearcherSessionId>(data.assigneeSessionId),
    closedAt: castId<IsoTimestamp>(data.closedAt),
    resolution: data.resolution,
    summary: castId<NonEmptyString>(data.summary),
  })
}

export function createOpenIssue(input: unknown): Result<OpenIssue, DomainError> {
  const fields = variantFields(input, 'issue', ISSUE_STATUSES, 'open')
  if (!fields.ok) return fields
  const data = readOpenIssueData(fields.value)
  const failure = fields.value.error()
  if (failure !== undefined) return failure
  return ok(assembleOpenIssue(data))
}

export function createAssignedIssue(input: unknown): Result<AssignedIssue, DomainError> {
  const fields = variantFields(input, 'issue', ISSUE_STATUSES, 'assigned')
  if (!fields.ok) return fields
  const data = readAssignedIssueData(fields.value)
  const failure = fields.value.error()
  if (failure !== undefined) return failure
  return ok(assembleAssignedIssue(data))
}

export function createClosedIssue(input: unknown): Result<ClosedIssue, DomainError> {
  const fields = variantFields(input, 'issue', ISSUE_STATUSES, 'closed')
  if (!fields.ok) return fields
  const data = readClosedIssueData(fields.value)
  const failure = fields.value.error()
  if (failure !== undefined) return failure
  return ok(assembleClosedIssue(data))
}

// ---------------------------------------------------------------------------
// Ticket states
// ---------------------------------------------------------------------------

export function createOpenTicket(input: unknown): Result<OpenTicket, DomainError> {
  const fields = variantFields(input, 'ticket', TICKET_STATUSES, 'open')
  if (!fields.ok) return fields
  const ticket = readOpenTicket(fields.value)
  const failure = fields.value.error()
  if (failure !== undefined) return failure
  return ok(ticket)
}

export function createRunningTicket(input: unknown): Result<RunningTicket, DomainError> {
  const fields = variantFields(input, 'ticket', TICKET_STATUSES, 'running')
  if (!fields.ok) return fields
  const ticket = readRunningTicket(fields.value)
  const failure = fields.value.error()
  if (failure !== undefined) return failure
  return ok(ticket)
}

export function createSubmittedTicket(input: unknown): Result<SubmittedTicket, DomainError> {
  const fields = variantFields(input, 'ticket', TICKET_STATUSES, 'submitted')
  if (!fields.ok) return fields
  const ticket = readSubmittedTicket(fields.value)
  const failure = fields.value.error()
  if (failure !== undefined) return failure
  return ok(ticket)
}

export function createCancelledTicket(input: unknown): Result<CancelledTicket, DomainError> {
  const fields = variantFields(input, 'ticket', TICKET_STATUSES, 'cancelled')
  if (!fields.ok) return fields
  const ticket = readCancelledTicket(fields.value)
  const failure = fields.value.error()
  if (failure !== undefined) return failure
  return ok(ticket)
}

export function createFailedTicket(input: unknown): Result<FailedTicket, DomainError> {
  const fields = variantFields(input, 'ticket', TICKET_STATUSES, 'failed')
  if (!fields.ok) return fields
  const ticket = readFailedTicket(fields.value)
  const failure = fields.value.error()
  if (failure !== undefined) return failure
  return ok(ticket)
}

function createTicketForStatus(input: unknown, status: unknown): Result<Ticket, DomainError> {
  switch (status) {
    case 'open':
      return createOpenTicket(input)
    case 'running':
      return createRunningTicket(input)
    case 'submitted':
      return createSubmittedTicket(input)
    case 'cancelled':
      return createCancelledTicket(input)
    case 'failed':
      return createFailedTicket(input)
    default:
      return invalidInput(`ticket.status must be one of ${TICKET_STATUSES.join(', ')}`)
  }
}

// ---------------------------------------------------------------------------
// Lineages and artifacts
// ---------------------------------------------------------------------------

export function createDerivedLineage(input: unknown): Result<DerivedLineage, DomainError> {
  const f = rootFields(input)
  if (f === undefined) return invalidInput('a derived lineage must be an object')
  if (f.has('strategy')) f.oneOf('strategy', 'lineage.strategy', LINEAGE_STRATEGIES)
  const lineage = readDerivedLineage(f)
  const failure = f.error()
  if (failure !== undefined) return failure
  return ok(lineage)
}

export function createFreshLineage(input: unknown): Result<FreshLineage, DomainError> {
  const f = rootFields(input)
  if (f === undefined) return invalidInput('a fresh lineage must be an object')
  if (f.has('strategy')) f.oneOf('strategy', 'lineage.strategy', LINEAGE_STRATEGIES)
  const lineage = readFreshLineage(f)
  const failure = f.error()
  if (failure !== undefined) return failure
  return ok(lineage)
}

export function createArtifactRef(input: unknown): Result<ArtifactRef, DomainError> {
  const f = rootFields(input)
  if (f === undefined) return invalidInput('an artifact ref must be an object')
  const artifact = boundary<ArtifactRef>({
    id: castId<ArtifactId>(f.text('id', 'artifact.id')),
    kind: f.oneOf('kind', 'artifact.kind', ARTIFACT_KINDS),
    digest: f.text('digest', 'artifact.digest'),
    bytes: f.nonNegativeInteger('bytes', 'artifact.bytes'),
    programId: castId<ProgramId>(f.text('programId', 'artifact.programId')),
    experimentId: castId<ExperimentId>(f.text('experimentId', 'artifact.experimentId')),
    commit: castId<CommitSha>(f.text('commit', 'artifact.commit')),
    ciRunId: castId<CIRunId>(f.text('ciRunId', 'artifact.ciRunId')),
    retention: f.oneOf('retention', 'artifact.retention', ARTIFACT_RETENTIONS),
    createdAt: castId<IsoTimestamp>(f.text('createdAt', 'artifact.createdAt')),
  })
  const failure = f.error()
  if (failure !== undefined) return failure
  return ok(artifact)
}

// ---------------------------------------------------------------------------
// Experiment states
// ---------------------------------------------------------------------------

function experimentFields(data: ExperimentBaseData) {
  return {
    id: castId<ExperimentId>(data.id),
    programId: castId<ProgramId>(data.programId),
    issueId: castId<IssueId>(data.issueId),
    branch: castId<BranchName>(data.branch),
    head: castId<CommitSha>(data.head),
    environment: data.environment,
    lineage: data.lineage,
    planCommentId: castId<CommentId>(data.planCommentId),
    createdBy: researcherPrincipal(data.createdBySessionId),
    createdAt: castId<IsoTimestamp>(data.createdAt),
  }
}

function bindingData(binding: TicketBinding): TicketBindingData {
  return {
    ticketId: binding.ticketId,
    experimentId: binding.experimentId,
    sessionId: binding.sessionId,
  }
}

function experimentBaseData(data: ExperimentBaseData): ExperimentBaseData {
  return {
    id: data.id,
    programId: data.programId,
    issueId: data.issueId,
    branch: data.branch,
    head: data.head,
    environment: data.environment,
    lineage: data.lineage,
    planCommentId: data.planCommentId,
    createdBySessionId: data.createdBySessionId,
    createdAt: data.createdAt,
  }
}

/**
 * The checks a `TicketBinding` can prove against the Experiment and acting Session alone.
 * The declared `submit`/`revise` signatures carry no Ticket, so an Experiment row that
 * does not embed its Ticket still supports the methods; the ticket id itself was already
 * minted by `createTicketBinding` from the Ticket record.
 */
function bindingExperimentMismatch(
  experiment: ExperimentBaseData,
  actor: ImplementerPrincipal,
  binding: TicketBinding,
): Err<DomainError> | undefined {
  if (binding.ticketId.length === 0) return invalidInput('the ticket binding has no ticket id')
  if (binding.experimentId !== experiment.id) {
    return forbidden('binding experiment does not match the experiment')
  }
  if (binding.sessionId !== actor.sessionId) {
    return forbidden('binding session does not match the acting implementer session')
  }
  return undefined
}

function submitWithoutTicket(
  data: OpenExperimentData,
  actor: ImplementerPrincipal,
  binding: TicketBinding,
  head: CommitSha,
  environment: EnvironmentDeclaration,
  at: IsoTimestamp,
): Result<ReadyExperiment, DomainError> {
  const mismatch = bindingExperimentMismatch(data, actor, binding)
  if (mismatch !== undefined) return mismatch
  if (head.length === 0) return invalidInput('experiment head commit must be non-empty')
  if (at.length === 0) return invalidInput('ready timestamp must be non-empty')
  const next: ReadyExperimentData = {
    ...experimentBaseData(data),
    status: 'ready',
    head,
    environment,
    readyAt: at,
  }
  return ok(assembleReadyExperiment(next, undefined))
}

function reviseWithoutTicket(
  data: ReadyExperimentData | CIFailedExperimentData,
  actor: ImplementerPrincipal,
  binding: TicketBinding,
  head: CommitSha,
  environment: EnvironmentDeclaration,
): Result<OpenExperiment, DomainError> {
  const mismatch = bindingExperimentMismatch(data, actor, binding)
  if (mismatch !== undefined) return mismatch
  if (head.length === 0) return invalidInput('revised head commit must be non-empty')
  const next: OpenExperimentData = {
    ...experimentBaseData(data),
    status: 'open',
    head,
    environment,
  }
  return ok(assembleOpenExperiment(next, undefined))
}

function assembleOpenExperiment(data: OpenExperimentData, ticket: Ticket | undefined): OpenExperiment {
  return boundary<OpenExperiment>({
    ...experimentFields(data),
    status: 'open',
    submit(
      actor: ImplementerPrincipal,
      binding: TicketBinding,
      head: CommitSha,
      environment: EnvironmentDeclaration,
      at: IsoTimestamp,
    ): Result<ReadyExperiment, DomainError> {
      if (ticket === undefined) {
        return submitWithoutTicket(data, actor, binding, head, environment, at)
      }
      const next = submitExperimentTransition(
        data,
        ticketToData(ticket),
        actor.sessionId,
        bindingData(binding),
        head,
        environment,
        at,
      )
      if (!next.ok) return next
      return ok(assembleReadyExperiment(next.value, ticket))
    },
    cancel(_actor: HostPrincipal, at: IsoTimestamp): Result<ClosedExperiment, DomainError> {
      const next = cancelExperimentTransition(data, HOST_CANCEL_REASON, at)
      if (!next.ok) return next
      return ok(assembleClosedExperiment(next.value))
    },
  })
}

function assembleReadyExperiment(data: ReadyExperimentData, ticket: Ticket | undefined): ReadyExperiment {
  return boundary<ReadyExperiment>({
    ...experimentFields(data),
    status: 'ready',
    readyAt: castId<IsoTimestamp>(data.readyAt),
    requestCI(
      assignment: IssueAssignment,
      token: CIRequestToken,
      _at: IsoTimestamp,
    ): Result<CIPendingExperiment, DomainError> {
      const tokenData: CIRequestTokenData = {
        ciRunId: token.ciRunId,
        experimentId: token.experimentId,
        commit: token.commit,
        requestedAt: token.requestedAt,
      }
      const next = requestExperimentCITransition(
        data,
        issueAssignmentData(assignment),
        tokenData,
      )
      if (!next.ok) return next
      return ok(assembleCIPendingExperiment(next.value, ticket))
    },
    revise(
      actor: ImplementerPrincipal,
      binding: TicketBinding,
      head: CommitSha,
      environment: EnvironmentDeclaration,
      _at: IsoTimestamp,
    ): Result<OpenExperiment, DomainError> {
      if (ticket === undefined) {
        return reviseWithoutTicket(data, actor, binding, head, environment)
      }
      const next = reviseExperimentTransition(
        data,
        ticketToData(ticket),
        actor.sessionId,
        bindingData(binding),
        head,
        environment,
      )
      if (!next.ok) return next
      return ok(assembleOpenExperiment(next.value, ticket))
    },
    cancel(_actor: HostPrincipal, at: IsoTimestamp): Result<ClosedExperiment, DomainError> {
      const next = cancelExperimentTransition(data, HOST_CANCEL_REASON, at)
      if (!next.ok) return next
      return ok(assembleClosedExperiment(next.value))
    },
  })
}

function assembleCIPendingExperiment(
  data: CIPendingExperimentData,
  ticket: Ticket | undefined,
): CIPendingExperiment {
  return boundary<CIPendingExperiment>({
    ...experimentFields(data),
    status: 'ci-pending',
    ciRunId: castId<CIRunId>(data.ciRunId),
    requestedAt: castId<IsoTimestamp>(data.requestedAt),
    startCI(_actor: HostPrincipal, digest: string, at: IsoTimestamp): CIRunningExperiment {
      return assembleCIRunningExperiment(
        unwrapTransition(startExperimentCITransition(data, digest, at), 'startCI'),
        ticket,
      )
    },
    cancel(_actor: HostPrincipal, at: IsoTimestamp): Result<ClosedExperiment, DomainError> {
      const next = cancelExperimentTransition(data, HOST_CANCEL_REASON, at)
      if (!next.ok) return next
      return ok(assembleClosedExperiment(next.value))
    },
  })
}

function assembleCIRunningExperiment(
  data: CIRunningExperimentData,
  ticket: Ticket | undefined,
): CIRunningExperiment {
  return boundary<CIRunningExperiment>({
    ...experimentFields(data),
    status: 'ci-running',
    ciRunId: castId<CIRunId>(data.ciRunId),
    requestedAt: castId<IsoTimestamp>(data.requestedAt),
    startedAt: castId<IsoTimestamp>(data.startedAt),
    environmentDigest: data.environmentDigest,
    passCI(
      _actor: HostPrincipal,
      completion: PassedCICompletion,
      _at: IsoTimestamp,
    ): Result<CIPassedExperiment, DomainError> {
      const completionData: PassedCICompletionData = {
        ciRunId: completion.ciRunId,
        record: passedCIRecordData(completion.record),
      }
      const next = passExperimentCITransition(data, completionData)
      if (!next.ok) return next
      return ok(assembleCIPassedExperiment(next.value, ticket))
    },
    failCI(
      _actor: HostPrincipal,
      completion: FailedCICompletion,
      _at: IsoTimestamp,
    ): Result<CIFailedExperiment, DomainError> {
      const completionData: FailedCICompletionData = {
        ciRunId: completion.ciRunId,
        record: failedCIRecordData(completion.record),
      }
      const next = failExperimentCITransition(data, completionData)
      if (!next.ok) return next
      return ok(assembleCIFailedExperiment(next.value, ticket))
    },
    cancel(_actor: HostPrincipal, at: IsoTimestamp): Result<ClosedExperiment, DomainError> {
      const next = cancelExperimentTransition(data, HOST_CANCEL_REASON, at)
      if (!next.ok) return next
      return ok(assembleClosedExperiment(next.value))
    },
  })
}

function assembleCIPassedExperiment(
  data: CIPassedExperimentData,
  _ticket: Ticket | undefined,
): CIPassedExperiment {
  return boundary<CIPassedExperiment>({
    ...experimentFields(data),
    status: 'ci-passed',
    ciRunId: castId<CIRunId>(data.ciRunId),
    requestedAt: castId<IsoTimestamp>(data.requestedAt),
    startedAt: castId<IsoTimestamp>(data.startedAt),
    environmentDigest: data.environmentDigest,
    finishedAt: castId<IsoTimestamp>(data.finishedAt),
    close(
      assignment: IssueAssignment,
      reason: NonEmptyString,
      at: IsoTimestamp,
    ): Result<ClosedExperiment, DomainError> {
      const next = closeExperimentTransition(
        data,
        issueAssignmentData(assignment),
        reason,
        at,
      )
      if (!next.ok) return next
      return ok(assembleClosedExperiment(next.value))
    },
  })
}

function assembleCIFailedExperiment(
  data: CIFailedExperimentData,
  ticket: Ticket | undefined,
): CIFailedExperiment {
  return boundary<CIFailedExperiment>({
    ...experimentFields(data),
    status: 'ci-failed',
    ciRunId: castId<CIRunId>(data.ciRunId),
    requestedAt: castId<IsoTimestamp>(data.requestedAt),
    ...(data.startedAt === undefined
      ? {}
      : { startedAt: castId<IsoTimestamp>(data.startedAt) }),
    ...(data.environmentDigest === undefined
      ? {}
      : { environmentDigest: data.environmentDigest }),
    failureReason: data.failureReason,
    failureDetail: data.failureDetail,
    failedAt: castId<IsoTimestamp>(data.failedAt),
    revise(
      actor: ImplementerPrincipal,
      binding: TicketBinding,
      head: CommitSha,
      environment: EnvironmentDeclaration,
      _at: IsoTimestamp,
    ): Result<OpenExperiment, DomainError> {
      if (ticket === undefined) {
        return reviseWithoutTicket(data, actor, binding, head, environment)
      }
      const next = reviseExperimentTransition(
        data,
        ticketToData(ticket),
        actor.sessionId,
        bindingData(binding),
        head,
        environment,
      )
      if (!next.ok) return next
      return ok(assembleOpenExperiment(next.value, ticket))
    },
    close(
      assignment: IssueAssignment,
      reason: NonEmptyString,
      at: IsoTimestamp,
    ): Result<ClosedExperiment, DomainError> {
      const next = closeExperimentTransition(
        data,
        issueAssignmentData(assignment),
        reason,
        at,
      )
      if (!next.ok) return next
      return ok(assembleClosedExperiment(next.value))
    },
  })
}

function assembleClosedExperiment(data: ClosedExperimentData): ClosedExperiment {
  return boundary<ClosedExperiment>({
    ...experimentFields(data),
    status: 'closed',
    closedAt: castId<IsoTimestamp>(data.closedAt),
    closeReason: castId<NonEmptyString>(data.closeReason),
    outcome: data.outcome,
  })
}

export function createOpenExperiment(input: unknown): Result<OpenExperiment, DomainError> {
  const fields = variantFields(input, 'experiment', EXPERIMENT_STATUSES, 'open')
  if (!fields.ok) return fields
  const ticket = readOptionalTicket(fields.value)
  const data = readOpenExperimentData(fields.value)
  const failure = fields.value.error()
  if (failure !== undefined) return failure
  return ok(assembleOpenExperiment(data, ticket))
}

export function createReadyExperiment(input: unknown): Result<ReadyExperiment, DomainError> {
  const fields = variantFields(input, 'experiment', EXPERIMENT_STATUSES, 'ready')
  if (!fields.ok) return fields
  const ticket = readOptionalTicket(fields.value)
  const data = readReadyExperimentData(fields.value)
  const failure = fields.value.error()
  if (failure !== undefined) return failure
  return ok(assembleReadyExperiment(data, ticket))
}

export function createCIPendingExperiment(
  input: unknown,
): Result<CIPendingExperiment, DomainError> {
  const fields = variantFields(input, 'experiment', EXPERIMENT_STATUSES, 'ci-pending')
  if (!fields.ok) return fields
  const ticket = readOptionalTicket(fields.value)
  const data = readCIPendingExperimentData(fields.value)
  const failure = fields.value.error()
  if (failure !== undefined) return failure
  return ok(assembleCIPendingExperiment(data, ticket))
}

export function createCIRunningExperiment(
  input: unknown,
): Result<CIRunningExperiment, DomainError> {
  const fields = variantFields(input, 'experiment', EXPERIMENT_STATUSES, 'ci-running')
  if (!fields.ok) return fields
  const ticket = readOptionalTicket(fields.value)
  const data = readCIRunningExperimentData(fields.value)
  const failure = fields.value.error()
  if (failure !== undefined) return failure
  return ok(assembleCIRunningExperiment(data, ticket))
}

export function createCIPassedExperiment(
  input: unknown,
): Result<CIPassedExperiment, DomainError> {
  const fields = variantFields(input, 'experiment', EXPERIMENT_STATUSES, 'ci-passed')
  if (!fields.ok) return fields
  const ticket = readOptionalTicket(fields.value)
  const data = readCIPassedExperimentData(fields.value)
  const failure = fields.value.error()
  if (failure !== undefined) return failure
  return ok(assembleCIPassedExperiment(data, ticket))
}

export function createCIFailedExperiment(
  input: unknown,
): Result<CIFailedExperiment, DomainError> {
  const fields = variantFields(input, 'experiment', EXPERIMENT_STATUSES, 'ci-failed')
  if (!fields.ok) return fields
  const ticket = readOptionalTicket(fields.value)
  const data = readCIFailedExperimentData(fields.value)
  const failure = fields.value.error()
  if (failure !== undefined) return failure
  return ok(assembleCIFailedExperiment(data, ticket))
}

export function createClosedExperiment(
  input: unknown,
): Result<ClosedExperiment, DomainError> {
  const fields = variantFields(input, 'experiment', EXPERIMENT_STATUSES, 'closed')
  if (!fields.ok) return fields
  const ticket = readOptionalTicket(fields.value)
  const data = readClosedExperimentData(fields.value)
  const failure = fields.value.error()
  if (failure !== undefined) return failure
  return ok(assembleClosedExperiment(data))
}

// ---------------------------------------------------------------------------
// CI tokens
// ---------------------------------------------------------------------------

/**
 * Mint the Host's CI request token for one Experiment/commit. When the input carries the
 * Experiment, the token's experiment id and commit are compared with it before the token
 * exists; a token for another Experiment or commit is refused.
 */
export function createCIRequestToken(input: unknown): Result<CIRequestToken, DomainError> {
  const f = rootFields(input)
  if (f === undefined) return invalidInput('a CI request token must be an object')
  const ciRunId = f.text('ciRunId', 'ci request token.ciRunId')
  const experimentId = f.text('experimentId', 'ci request token.experimentId')
  const commit = f.text('commit', 'ci request token.commit')
  const requestedAt = f.text('requestedAt', 'ci request token.requestedAt')

  if (f.has('experiment')) {
    const experiment = f.recordValue('experiment', 'ci request token.experiment')
    const expectedId = experiment['id']
    const expectedHead = experiment['head']
    if (typeof expectedId !== 'string' || expectedId !== experimentId) {
      return forbidden('the CI request token belongs to another experiment')
    }
    if (typeof expectedHead !== 'string' || expectedHead !== commit) {
      return forbidden('the CI request token does not match the experiment head')
    }
  }

  const failure = f.error()
  if (failure !== undefined) return failure
  return ok(
    boundary<CIRequestToken>({
      ciRunId: castId<CIRunId>(ciRunId),
      experimentId: castId<ExperimentId>(experimentId),
      commit: castId<CommitSha>(commit),
      requestedAt: castId<IsoTimestamp>(requestedAt),
    }),
  )
}

/**
 * Mint the Host CI runner's proof that a run passed; the record is the evidence. Accepted
 * shapes: `{ ciRunId, record }` and the bare passed record (the run id is its id).
 */
export function createPassedCICompletion(
  input: unknown,
): Result<PassedCICompletion, DomainError> {
  const f = rootFields(input)
  if (f === undefined) return invalidInput('a passed CI completion must be an object')
  const nested = f.has('record')
  const recordFields = nested ? f.child('record', 'ci completion.record') : f
  const status = recordFields.oneOf('status', 'ci completion.status', CI_STATUSES)
  if (status !== 'passed') {
    return invalidInput("ci completion.record.status must be 'passed'")
  }
  const record = readPassedCIRecord(recordFields)
  const ciRunId = nested
    ? (f.optionalText('ciRunId', 'ci completion.ciRunId') ?? record.id)
    : record.id
  const failure = f.error()
  if (failure !== undefined) return failure
  if (ciRunId !== record.id) {
    return invalidInput('ci completion.ciRunId must equal the record run id')
  }
  return ok(
    boundary<PassedCICompletion>({
      ciRunId: castId<CIRunId>(ciRunId),
      record,
    }),
  )
}

/**
 * Mint the Host CI runner's proof that a run failed for a stated reason. Accepted shapes:
 * `{ ciRunId, record }` and the bare failed record (the run id is its id).
 */
export function createFailedCICompletion(
  input: unknown,
): Result<FailedCICompletion, DomainError> {
  const f = rootFields(input)
  if (f === undefined) return invalidInput('a failed CI completion must be an object')
  const nested = f.has('record')
  const recordFields = nested ? f.child('record', 'ci completion.record') : f
  const status = recordFields.oneOf('status', 'ci completion.status', CI_STATUSES)
  if (status !== 'failed') {
    return invalidInput("ci completion.record.status must be 'failed'")
  }
  const record = readFailedCIRecord(recordFields)
  const ciRunId = nested
    ? (f.optionalText('ciRunId', 'ci completion.ciRunId') ?? record.id)
    : record.id
  const failure = f.error()
  if (failure !== undefined) return failure
  if (ciRunId !== record.id) {
    return invalidInput('ci completion.ciRunId must equal the record run id')
  }
  return ok(
    boundary<FailedCICompletion>({
      ciRunId: castId<CIRunId>(ciRunId),
      record,
    }),
  )
}
