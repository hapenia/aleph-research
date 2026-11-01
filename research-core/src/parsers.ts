/**
 * Parser boundary (implementation phase): the only module allowed to turn untrusted
 * input into branded ids, timestamps, versions, metric names, JSON schemas and tool
 * schemas. The adapter imports this module; it must not cast outside it.
 *
 * Every exported parser accepts `unknown` and returns a `Result`. Validation is
 * format/refinement only: parsers never reach a repository, so only the
 * `invalid-input` code is produced today; `not-found` stays part of the helper's
 * vocabulary for lookups added by later phases. This module is the allowlisted place
 * for the type predicates that turn plain strings/numbers into branded values.
 */
import type { DomainError, Result } from './types/errors.js'
import type { MetricDirection } from './types/metrics.js'
import type { ExplorationLevel } from './types/program.js'
import type { Schema } from './types/tools.js'
import type {
  ArtifactId,
  AuditId,
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
  NonEmptyString,
  NonNegativeNumber,
  OperatorSessionId,
  PositiveInt,
  PositiveNumber,
  ProgramId,
  RequestId,
  ResearcherSessionId,
  ReviewId,
  RouterSessionId,
  TicketId,
  Version,
  WatchdogSessionId,
} from './types/ids.js'

/** Codes a boundary parser can return; repositories own the remaining codes. */
type ParserErrorCode = 'invalid-input' | 'not-found'

const MAX_ID_LENGTH = 200
const MAX_BRANCH_NAME_LENGTH = 255
const MAX_METRIC_NAME_LENGTH = 64

/** Ids are printable, whitespace-free tokens such as `prg_01J...` or `program:42`. */
const ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const COMMIT_SHA_PATTERN = /^[0-9a-fA-F]{40,64}$/
const BRANCH_NAME_PATTERN = /^[A-Za-z0-9._/-]+$/
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/
const NUMERIC_OFFSET_PATTERN = /^[+-](\d{2}):(\d{2})$/
const DAYS_IN_MONTH: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

// ---------------------------------------------------------------------------
// Refinement predicates. These are the single place where an untrusted value is
// narrowed into a branded type; every exported parser below only re-checks and
// wraps them in a Result.
// ---------------------------------------------------------------------------

/** A JSON-object value; arrays and `null` are not records. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is NonEmptyString {
  return typeof value === 'string' && value.trim().length > 0
}

function isEntityId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > MAX_ID_LENGTH) return false
  return ENTITY_ID_PATTERN.test(value)
}

function isCommitSha(value: unknown): value is CommitSha {
  return typeof value === 'string' && COMMIT_SHA_PATTERN.test(value)
}

function isBranchName(value: unknown): value is BranchName {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > MAX_BRANCH_NAME_LENGTH) return false
  if (!BRANCH_NAME_PATTERN.test(value)) return false
  if (value.startsWith('.') || value.startsWith('/') || value.endsWith('/')) return false
  if (value.endsWith('.') || value.endsWith('.lock')) return false
  if (value.includes('..') || value.includes('//') || value.includes('@{')) return false
  for (const segment of value.split('/')) {
    if (segment.length === 0 || segment.startsWith('.')) return false
  }
  return true
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return DAYS_IN_MONTH[month - 1] ?? 0
}

function isIsoTimestamp(value: unknown): value is IsoTimestamp {
  if (typeof value !== 'string') return false
  const match = RFC3339_PATTERN.exec(value)
  if (match === null) return false
  const [, yearText = '', monthText = '', dayText = '', hourText = '', minuteText = '', secondText = '', , offset = ''] =
    match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  if (month < 1 || month > 12) return false
  if (day < 1 || day > daysInMonth(year, month)) return false
  if (hour > 23) return false
  if (minute > 59) return false
  if (second > 59) return false
  if (offset === 'Z' || offset === 'z') return true
  const offsetMatch = NUMERIC_OFFSET_PATTERN.exec(offset)
  if (offsetMatch === null) return false
  const [, offsetHourText = '', offsetMinuteText = ''] = offsetMatch
  return Number(offsetHourText) <= 23 && Number(offsetMinuteText) <= 59
}

function isVersion(value: unknown): value is Version {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isPositiveInt(value: unknown): value is PositiveInt {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isPositiveNumber(value: unknown): value is PositiveNumber {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isNonNegativeNumber(value: unknown): value is NonNegativeNumber {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isDurationMs(value: unknown): value is DurationMs {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Printable text without C0 control characters or DEL; no regex keeps ESLint happy. */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function isMetricName(value: unknown): value is MetricName {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > MAX_METRIC_NAME_LENGTH) return false
  if (value.trim().length === 0) return false
  return !hasControlCharacter(value)
}

function isMetricDirection(value: unknown): value is MetricDirection {
  return value === 'higher' || value === 'lower'
}

function isExplorationLevel(value: unknown): value is ExplorationLevel {
  return value === 'low' || value === 'normal' || value === 'high'
}

// Element predicates for the individual nominal ids. Each one keeps the brand
// distinct even though the underlying format is shared.
function isProgramId(value: unknown): value is ProgramId {
  return isEntityId(value)
}
function isIssueId(value: unknown): value is IssueId {
  return isEntityId(value)
}
function isExperimentId(value: unknown): value is ExperimentId {
  return isEntityId(value)
}
function isCIRunId(value: unknown): value is CIRunId {
  return isEntityId(value)
}
function isCommentId(value: unknown): value is CommentId {
  return isEntityId(value)
}
function isReviewId(value: unknown): value is ReviewId {
  return isEntityId(value)
}
function isArtifactId(value: unknown): value is ArtifactId {
  return isEntityId(value)
}
function isAuditId(value: unknown): value is AuditId {
  return isEntityId(value)
}
function isRequestId(value: unknown): value is RequestId {
  return isEntityId(value)
}
function isTicketId(value: unknown): value is TicketId {
  return isEntityId(value)
}
function isResearcherSessionId(value: unknown): value is ResearcherSessionId {
  return isEntityId(value)
}
function isImplementerSessionId(value: unknown): value is ImplementerSessionId {
  return isEntityId(value)
}
function isOperatorSessionId(value: unknown): value is OperatorSessionId {
  return isEntityId(value)
}
function isWatchdogSessionId(value: unknown): value is WatchdogSessionId {
  return isEntityId(value)
}
function isRouterSessionId(value: unknown): value is RouterSessionId {
  return isEntityId(value)
}

// ---------------------------------------------------------------------------
// Result helpers.
// ---------------------------------------------------------------------------

function ok<T>(value: T): Result<T, DomainError> {
  return { ok: true, value }
}

/**
 * Internal invariant: every message passed to `fail` is a non-empty literal, so an
 * empty one is a programming error rather than untrusted input.
 */
function toMessage(text: string): NonEmptyString {
  if (isNonEmptyString(text)) return text
  throw new Error('aleph-research parser: an internal error message must be non-empty')
}

/** Build the correlated refusal union member for one of the two parser codes. */
function fail<T>(code: ParserErrorCode, text: string): Result<T, DomainError> {
  const message = toMessage(text)
  switch (code) {
    case 'invalid-input':
      return { ok: false, error: { code: 'invalid-input', message } }
    case 'not-found':
      return { ok: false, error: { code: 'not-found', message } }
  }
}

// ---------------------------------------------------------------------------
// Branded ids.
// ---------------------------------------------------------------------------

/** Parse an untrusted value into a `ProgramId`. */
export function programId(input: unknown): Result<ProgramId, DomainError> {
  return isProgramId(input) ? ok(input) : fail('invalid-input', 'programId must be an entity id string')
}

/** Parse an untrusted value into an `IssueId`. */
export function issueId(input: unknown): Result<IssueId, DomainError> {
  return isIssueId(input) ? ok(input) : fail('invalid-input', 'issueId must be an entity id string')
}

/** Parse an untrusted value into an `ExperimentId`. */
export function experimentId(input: unknown): Result<ExperimentId, DomainError> {
  return isExperimentId(input) ? ok(input) : fail('invalid-input', 'experimentId must be an entity id string')
}

/** Parse an untrusted value into a `CIRunId`. */
export function ciRunId(input: unknown): Result<CIRunId, DomainError> {
  return isCIRunId(input) ? ok(input) : fail('invalid-input', 'ciRunId must be an entity id string')
}

/** Parse an untrusted value into a `CommentId`. */
export function commentId(input: unknown): Result<CommentId, DomainError> {
  return isCommentId(input) ? ok(input) : fail('invalid-input', 'commentId must be an entity id string')
}

/** Parse an untrusted value into a `ReviewId`. */
export function reviewId(input: unknown): Result<ReviewId, DomainError> {
  return isReviewId(input) ? ok(input) : fail('invalid-input', 'reviewId must be an entity id string')
}

/** Parse an untrusted value into an `ArtifactId`. */
export function artifactId(input: unknown): Result<ArtifactId, DomainError> {
  return isArtifactId(input) ? ok(input) : fail('invalid-input', 'artifactId must be an entity id string')
}

/** Parse an untrusted value into an `AuditId`. */
export function auditId(input: unknown): Result<AuditId, DomainError> {
  return isAuditId(input) ? ok(input) : fail('invalid-input', 'auditId must be an entity id string')
}

/** Parse an untrusted value into a `TicketId`. */
export function ticketId(input: unknown): Result<TicketId, DomainError> {
  return isTicketId(input) ? ok(input) : fail('invalid-input', 'ticketId must be an entity id string')
}

/** Parse an untrusted value into a `RequestId`. */
export function requestId(input: unknown): Result<RequestId, DomainError> {
  return isRequestId(input) ? ok(input) : fail('invalid-input', 'requestId must be an entity id string')
}

/** Parse an untrusted value into a `ResearcherSessionId`. */
export function researcherSessionId(input: unknown): Result<ResearcherSessionId, DomainError> {
  return isResearcherSessionId(input)
    ? ok(input)
    : fail('invalid-input', 'researcherSessionId must be an entity id string')
}

/** Parse an untrusted value into an `ImplementerSessionId`. */
export function implementerSessionId(input: unknown): Result<ImplementerSessionId, DomainError> {
  return isImplementerSessionId(input)
    ? ok(input)
    : fail('invalid-input', 'implementerSessionId must be an entity id string')
}

/** Parse an untrusted value into an `OperatorSessionId`. */
export function operatorSessionId(input: unknown): Result<OperatorSessionId, DomainError> {
  return isOperatorSessionId(input) ? ok(input) : fail('invalid-input', 'operatorSessionId must be an entity id string')
}

/** Parse an untrusted value into a `WatchdogSessionId`. */
export function watchdogSessionId(input: unknown): Result<WatchdogSessionId, DomainError> {
  return isWatchdogSessionId(input) ? ok(input) : fail('invalid-input', 'watchdogSessionId must be an entity id string')
}

/** Parse an untrusted value into a `RouterSessionId`. */
export function routerSessionId(input: unknown): Result<RouterSessionId, DomainError> {
  return isRouterSessionId(input) ? ok(input) : fail('invalid-input', 'routerSessionId must be an entity id string')
}

// ---------------------------------------------------------------------------
// Refined boundary values.
// ---------------------------------------------------------------------------

/** Parse an untrusted value into a `CommitSha` (40 or 64 hexadecimal characters). */
export function commitSha(input: unknown): Result<CommitSha, DomainError> {
  return isCommitSha(input) ? ok(input) : fail('invalid-input', 'commitSha must be 40-64 hexadecimal characters')
}

/** Parse an untrusted value into a safe git `BranchName`. */
export function branchName(input: unknown): Result<BranchName, DomainError> {
  return isBranchName(input) ? ok(input) : fail('invalid-input', 'branchName must be a safe git reference name')
}

/** Parse an untrusted value into an RFC 3339 `IsoTimestamp`. */
export function isoTimestamp(input: unknown): Result<IsoTimestamp, DomainError> {
  return isIsoTimestamp(input) ? ok(input) : fail('invalid-input', 'isoTimestamp must be an RFC 3339 timestamp')
}

/** Parse an untrusted value into a non-negative integer `Version`. */
export function version(input: unknown): Result<Version, DomainError> {
  return isVersion(input) ? ok(input) : fail('invalid-input', 'version must be a non-negative integer')
}

/** Parse an untrusted value into a `MetricName` of 1-64 printable characters. */
export function metricName(input: unknown): Result<MetricName, DomainError> {
  return isMetricName(input) ? ok(input) : fail('invalid-input', 'metricName must be 1-64 printable characters')
}

/** Parse an untrusted value into a `NonEmptyString`. */
export function nonEmptyString(input: unknown): Result<NonEmptyString, DomainError> {
  return isNonEmptyString(input) ? ok(input) : fail('invalid-input', 'value must be a non-empty string')
}

/** Parse an untrusted value into a `PositiveInt`. */
export function positiveInt(input: unknown): Result<PositiveInt, DomainError> {
  return isPositiveInt(input) ? ok(input) : fail('invalid-input', 'value must be a positive integer')
}

/** Parse an untrusted value into a `PositiveNumber`. */
export function positiveNumber(input: unknown): Result<PositiveNumber, DomainError> {
  return isPositiveNumber(input) ? ok(input) : fail('invalid-input', 'value must be a positive finite number')
}

/** Parse an untrusted value into a `NonNegativeNumber`. */
export function nonNegativeNumber(input: unknown): Result<NonNegativeNumber, DomainError> {
  return isNonNegativeNumber(input)
    ? ok(input)
    : fail('invalid-input', 'value must be a non-negative finite number')
}

/** Parse an untrusted value into a non-negative `DurationMs`. */
export function durationMs(input: unknown): Result<DurationMs, DomainError> {
  return isDurationMs(input) ? ok(input) : fail('invalid-input', 'durationMs must be a non-negative finite number')
}

/** Parse an untrusted value into a `MetricDirection`. */
export function metricDirection(input: unknown): Result<MetricDirection, DomainError> {
  return isMetricDirection(input) ? ok(input) : fail('invalid-input', "metricDirection must be 'higher' or 'lower'")
}

/** Parse an untrusted value into an `ExplorationLevel`. */
export function explorationLevel(input: unknown): Result<ExplorationLevel, DomainError> {
  return isExplorationLevel(input)
    ? ok(input)
    : fail('invalid-input', "explorationLevel must be 'low', 'normal' or 'high'")
}

// ---------------------------------------------------------------------------
// Boundary schemas.
// ---------------------------------------------------------------------------

/** A constructor input: a type-guard validator plus the JSON Schema it mirrors. */
export interface SchemaSource<T> {
  readonly validator: (input: unknown) => input is T
  readonly jsonSchema: Readonly<Record<string, unknown>>
}

/** A callable validator; used as the shorthand constructor form. */
type ValueValidator<T> = (input: unknown) => input is T

function isSchema<T>(value: unknown): value is Schema<T> {
  if (!isRecord(value)) return false
  return typeof value['parse'] === 'function' && typeof value['toJsonSchema'] === 'function'
}

function isSchemaSource<T>(value: unknown): value is SchemaSource<T> {
  if (!isRecord(value)) return false
  if (typeof value['validator'] !== 'function') return false
  return isRecord(value['jsonSchema'])
}

function isValueValidator<T>(value: unknown): value is ValueValidator<T> {
  return typeof value === 'function'
}

/**
 * Build a boundary `Schema<T>` for a DSH tool: it parses untrusted input and emits
 * the JSON Schema document the tool advertises.
 *
 * Accepted shapes:
 * - `{ validator, jsonSchema }` — the documented constructor form.
 * - a type-guard function — shorthand; the emitted schema is the empty object.
 * - `{ parse, toJsonSchema }` — an already-built schema, validated and returned.
 */
export function schema<T>(input: unknown): Result<Schema<T>, DomainError> {
  if (isSchema<T>(input)) return ok(input)

  if (isSchemaSource<T>(input)) {
    const validator = input.validator
    const jsonSchema = input.jsonSchema
    return ok<Schema<T>>({
      parse: (value: unknown) => (validator(value) ? ok(value) : fail<T>('invalid-input', 'value does not match the schema validator')),
      toJsonSchema: () => jsonSchema,
    })
  }

  if (isValueValidator<T>(input)) {
    const validator = input
    return ok<Schema<T>>({
      parse: (value: unknown) => (validator(value) ? ok(value) : fail<T>('invalid-input', 'value does not match the schema validator')),
      toJsonSchema: () => ({}),
    })
  }

  return fail(
    'invalid-input',
    'schema must be a validator function, a { validator, jsonSchema } source, or a { parse, toJsonSchema } schema',
  )
}
