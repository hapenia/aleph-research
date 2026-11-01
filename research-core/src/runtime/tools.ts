/**
 * Model-facing tool definitions for the four Session roles.
 *
 * Each tool is a plain `ToolDefinition`/`CommandTool`: a name, a model-facing
 * description and two boundary schemas (parameters and output). The schemas are plain
 * `{ parse, toJsonSchema }` objects, not classes and not branded wrappers.
 *
 * The runtime modules do not import the parser boundary (see `runtime/executor.ts` and
 * `eslint.config.js`): untrusted values are parsed by the refinements below, which mirror
 * the parser module's formats. Command tools carry their command literal and omit the
 * fields the Host injects (`assignment`, `binding`); strict object validation rejects
 * those fields when a model sends them.
 */
import type { ArtifactRef } from '../types/artifacts.js'
import type { Attention, AttentionSubject } from '../types/attention.js'
import type { ProgramSnapshot } from '../types/api.js'
import type { CommandOf, CommandResult, CommandType } from '../types/commands.js'
import type { EnvironmentDeclaration } from '../types/environment.js'
import type {
  CIPendingExperiment,
  ClosedExperiment,
  Experiment,
  ExperimentPlan,
  ExperimentReview,
  OpenExperiment,
  ReadyExperiment,
} from '../types/experiment.js'
import type { DomainError, Ok, Result } from '../types/errors.js'
import type {
  ArtifactId,
  CIRunId,
  CommitSha,
  DurationMs,
  ExperimentId,
  IsoTimestamp,
  IssueId,
  MetricName,
  NonEmptyString,
  PositiveInt,
  PositiveNumber,
  ProgramId,
} from '../types/ids.js'
import type { AssignedIssue, ClosedIssue, Issue, IssueComment, IssueLabel, OpenIssue } from '../types/issue.js'
import type { MetricQuery, MetricQueryResult, MetricSort } from '../types/metrics.js'
import type { PausedProgram, RunningProgram, StoppedProgram } from '../types/program.js'
import type {
  CommandTool,
  ImplementerTools,
  OperatorTools,
  ResearcherTools,
  Schema,
  WatchdogTools,
} from '../types/tools.js'

type Check<T> = (input: unknown) => Result<T, DomainError>

// ---------------------------------------------------------------------------
// Result, narrowing and branding helpers.
// ---------------------------------------------------------------------------

function ok<T>(value: T): Ok<T> {
  return { ok: true, value }
}

function nonEmpty(value: string): NonEmptyString
function nonEmpty(value: string): string {
  return value.length === 0 ? 'invalid value' : value
}

function invalid<T>(message: string): Result<T, DomainError> {
  return { ok: false, error: { code: 'invalid-input', message: nonEmpty(message) } }
}

/**
 * Narrow an object without a type predicate. The lint boundary bans user-defined
 * predicates because they can forge nominal types; this overload only states the runtime
 * check above it and is the same shape as `copy` in `runtime/storage.ts`.
 */
function asRecord(input: unknown): Readonly<Record<string, unknown>> | null
function asRecord(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  return input
}

function asArray(input: unknown): readonly unknown[] | null
function asArray(input: unknown): unknown {
  if (!Array.isArray(input)) return null
  const items: unknown[] = []
  for (const item of input) items.push(item)
  return items
}

/**
 * Return a value that has just been validated. TypeScript cannot carry a structural
 * validation out of `unknown` without a predicate, and the lint boundary forbids one; the
 * overload keeps the schema generic without an assertion.
 */
function validated<T>(value: unknown): T
function validated(value: unknown): unknown {
  return value
}

/** Turn a checked string into one of the nominal string types. */
function branded<T extends string>(value: string): T
function branded(value: string): string {
  return value
}

/** Turn a checked number into one of the nominal numeric types. */
function brandedNumber<T extends number>(value: number): T
function brandedNumber(value: number): number {
  return value
}

// ---------------------------------------------------------------------------
// Primitive refinements, mirroring `src/parsers.ts`.
// ---------------------------------------------------------------------------

const MAX_ID_LENGTH = 200
const MAX_METRIC_NAME_LENGTH = 64
const ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const COMMIT_SHA_PATTERN = /^[0-9a-fA-F]{40,64}$/
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/
const NUMERIC_OFFSET_PATTERN = /^[+-](\d{2}):(\d{2})$/
const DAYS_IN_MONTH: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function labelled<T>(label: string, check: Check<T>): Check<T> {
  return (input) => {
    const parsed = check(input)
    if (parsed.ok) return parsed
    return invalid(`${label} is invalid: ${parsed.error.message}`)
  }
}

function oneOf<T extends string>(label: string, values: readonly T[]): Check<T> {
  return (input) => {
    for (const value of values) {
      if (input === value) return ok(value)
    }
    return invalid(`${label} must be one of: ${values.join(', ')}`)
  }
}

function identifierCheck(label: string): Check<string> {
  return (input) => {
    if (typeof input !== 'string') return invalid(`${label} must be an entity id string`)
    if (input.length === 0 || input.length > MAX_ID_LENGTH) return invalid(`${label} must be an entity id string`)
    return ENTITY_ID_PATTERN.test(input) ? ok(input) : invalid(`${label} must be an entity id string`)
  }
}

function entityIdCheck<T extends string>(label: string): Check<T> {
  return (input) => {
    const parsed = identifierCheck(label)(input)
    return parsed.ok ? ok(branded<T>(parsed.value)) : parsed
  }
}

const textCheck: Check<NonEmptyString> = (input) =>
  typeof input === 'string' && input.trim().length > 0
    ? ok(branded<NonEmptyString>(input))
    : invalid('value must be a non-empty string')

const stringCheck: Check<string> = (input) =>
  typeof input === 'string' ? ok(input) : invalid('value must be a string')

const commitShaCheck: Check<CommitSha> = (input) =>
  typeof input === 'string' && COMMIT_SHA_PATTERN.test(input)
    ? ok(branded<CommitSha>(input))
    : invalid('value must be a 40-64 character hexadecimal commit sha')

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

const metricNameCheck: Check<MetricName> = (input) => {
  if (typeof input !== 'string') return invalid('value must be a metric name')
  if (input.length === 0 || input.length > MAX_METRIC_NAME_LENGTH) return invalid('value must be a metric name')
  if (input.trim().length === 0 || hasControlCharacter(input)) return invalid('value must be a metric name')
  return ok(branded<MetricName>(input))
}

const positiveIntCheck: Check<PositiveInt> = (input) =>
  typeof input === 'number' && Number.isInteger(input) && input > 0
    ? ok(brandedNumber<PositiveInt>(input))
    : invalid('value must be a positive integer')

const positiveNumberCheck: Check<PositiveNumber> = (input) =>
  typeof input === 'number' && Number.isFinite(input) && input > 0
    ? ok(brandedNumber<PositiveNumber>(input))
    : invalid('value must be a positive finite number')

const durationCheck: Check<DurationMs> = (input) =>
  typeof input === 'number' && Number.isFinite(input) && input >= 0
    ? ok(brandedNumber<DurationMs>(input))
    : invalid('value must be a non-negative finite number of milliseconds')

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return DAYS_IN_MONTH[month - 1] ?? 0
}

const isoTimestampCheck: Check<IsoTimestamp> = (input) => {
  if (typeof input !== 'string') return invalid('value must be an RFC 3339 timestamp')
  const match = RFC3339_PATTERN.exec(input)
  if (match === null) return invalid('value must be an RFC 3339 timestamp')
  const [, yearText = '', monthText = '', dayText = '', hourText = '', minuteText = '', secondText = '', , offset = ''] =
    match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  if (month < 1 || month > 12) return invalid('value must be an RFC 3339 timestamp')
  if (day < 1 || day > daysInMonth(year, month)) return invalid('value must be an RFC 3339 timestamp')
  if (hour > 23 || minute > 59 || second > 59) return invalid('value must be an RFC 3339 timestamp')
  if (offset === 'Z' || offset === 'z') return ok(branded<IsoTimestamp>(input))
  const offsetMatch = NUMERIC_OFFSET_PATTERN.exec(offset)
  if (offsetMatch === null) return invalid('value must be an RFC 3339 timestamp')
  const [, offsetHourText = '', offsetMinuteText = ''] = offsetMatch
  if (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59) {
    return invalid('value must be an RFC 3339 timestamp')
  }
  return ok(branded<IsoTimestamp>(input))
}

// ---------------------------------------------------------------------------
// Structured input refinements.
// ---------------------------------------------------------------------------

function firstExtraKey(record: Readonly<Record<string, unknown>>, allowed: readonly string[]): string | null {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) return key
  }
  return null
}

function checkOptional(
  record: Readonly<Record<string, unknown>>,
  key: string,
  check: Check<unknown>,
): Result<null, DomainError> {
  const value = record[key]
  if (value === undefined) return ok(null)
  const parsed = check(value)
  return parsed.ok ? ok(null) : parsed
}

const environmentCheck: Check<EnvironmentDeclaration> = (input) => {
  const record = asRecord(input)
  if (record === null) return invalid('environment must be an object')
  const kind = record['kind']
  if (kind === 'uv-lock') {
    const extra = firstExtraKey(record, ['kind', 'lockFile', 'pythonVersion'])
    if (extra !== null) return invalid(`environment does not accept the field ${extra}`)
    const lockFile = labelled('lockFile', stringCheck)(record['lockFile'])
    if (!lockFile.ok) return lockFile
    const pythonVersion = labelled('pythonVersion', stringCheck)(record['pythonVersion'])
    if (!pythonVersion.ok) return pythonVersion
    return ok({ kind: 'uv-lock', lockFile: lockFile.value, pythonVersion: pythonVersion.value })
  }
  if (kind === 'requirements') {
    const extra = firstExtraKey(record, ['kind', 'requirementsFile', 'pythonVersion'])
    if (extra !== null) return invalid(`environment does not accept the field ${extra}`)
    const requirementsFile = labelled('requirementsFile', stringCheck)(record['requirementsFile'])
    if (!requirementsFile.ok) return requirementsFile
    const pythonVersion = labelled('pythonVersion', stringCheck)(record['pythonVersion'])
    if (!pythonVersion.ok) return pythonVersion
    return ok({ kind: 'requirements', requirementsFile: requirementsFile.value, pythonVersion: pythonVersion.value })
  }
  return invalid("environment kind must be 'uv-lock' or 'requirements'")
}

const artifactKinds: readonly string[] = ['model-weights', 'report', 'figure', 'logs', 'other']
const artifactRetentions: readonly string[] = ['keep', 'temporary']

const artifactRefCheck: Check<ArtifactRef> = (input) => {
  const record = asRecord(input)
  if (record === null) return invalid('artifact reference must be an object')
  const extra = firstExtraKey(record, [
    'id',
    'kind',
    'digest',
    'bytes',
    'programId',
    'experimentId',
    'commit',
    'ciRunId',
    'retention',
    'createdAt',
  ])
  if (extra !== null) return invalid(`artifact reference does not accept the field ${extra}`)
  const id = entityIdCheck<ArtifactId>('artifactId')(record['id'])
  if (!id.ok) return id
  const kind = oneOf('artifact kind', artifactKinds)(record['kind'])
  if (!kind.ok) return kind
  const digest = labelled('digest', textCheck)(record['digest'])
  if (!digest.ok) return digest
  const bytes = record['bytes']
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    return invalid('artifact bytes must be a non-negative finite number')
  }
  const programId = entityIdCheck<ProgramId>('programId')(record['programId'])
  if (!programId.ok) return programId
  const experimentId = entityIdCheck<ExperimentId>('experimentId')(record['experimentId'])
  if (!experimentId.ok) return experimentId
  const commit = commitShaCheck(record['commit'])
  if (!commit.ok) return commit
  const ciRunId = entityIdCheck<CIRunId>('ciRunId')(record['ciRunId'])
  if (!ciRunId.ok) return ciRunId
  const retention = oneOf('artifact retention', artifactRetentions)(record['retention'])
  if (!retention.ok) return retention
  const createdAt = isoTimestampCheck(record['createdAt'])
  if (!createdAt.ok) return createdAt
  return ok(validated<ArtifactRef>(input))
}

const experimentPlanCheck: Check<ExperimentPlan> = (input) => {
  const record = asRecord(input)
  if (record === null) return invalid('experiment plan must be an object')
  const extra = firstExtraKey(record, ['hypothesis', 'steps', 'expected', 'environment', 'inputs'])
  if (extra !== null) return invalid(`experiment plan does not accept the field ${extra}`)
  const hypothesis = labelled('hypothesis', textCheck)(record['hypothesis'])
  if (!hypothesis.ok) return hypothesis
  const steps = asArray(record['steps'])
  if (steps === null || steps.length === 0) return invalid('plan steps must be a non-empty array')
  for (const step of steps) {
    const parsed = labelled('plan step', textCheck)(step)
    if (!parsed.ok) return parsed
  }
  const expected = asRecord(record['expected'])
  if (expected === null) return invalid('plan expected must be an object')
  const expectedExtra = firstExtraKey(expected, ['direction', 'rationale'])
  if (expectedExtra !== null) return invalid(`plan expected does not accept the field ${expectedExtra}`)
  const direction = oneOf('expected direction', ['higher', 'lower'])(expected['direction'])
  if (!direction.ok) return direction
  const rationale = labelled('expected rationale', textCheck)(expected['rationale'])
  if (!rationale.ok) return rationale
  const environment = environmentCheck(record['environment'])
  if (!environment.ok) return environment
  const inputs = asArray(record['inputs'])
  if (inputs === null) return invalid('plan inputs must be an array')
  for (const artifact of inputs) {
    const parsed = artifactRefCheck(artifact)
    if (!parsed.ok) return parsed
  }
  return ok(validated<ExperimentPlan>(input))
}

const metricSortCheck: Check<readonly MetricSort[]> = (input) => {
  const items = asArray(input)
  if (items === null) return invalid('sort must be an array')
  for (const item of items) {
    const record = asRecord(item)
    if (record === null) return invalid('every sort entry must be an object')
    const extra = firstExtraKey(record, ['metric', 'direction'])
    if (extra !== null) return invalid(`sort entry does not accept the field ${extra}`)
    const metric = metricNameCheck(record['metric'])
    if (!metric.ok) return metric
    const direction = oneOf('sort direction', ['higher', 'lower'])(record['direction'])
    if (!direction.ok) return direction
  }
  return ok(validated<readonly MetricSort[]>(input))
}

const metricQueryCheck: Check<MetricQuery> = (input) => {
  const record = asRecord(input)
  if (record === null) return invalid('metric query must be an object')
  const extra = firstExtraKey(record, ['programId', 'experimentId', 'sort', 'aggregate', 'limit'])
  if (extra !== null) return invalid(`metric query does not accept the field ${extra}`)
  const programId = entityIdCheck<ProgramId>('programId')(record['programId'])
  if (!programId.ok) return programId
  const experiment = checkOptional(record, 'experimentId', entityIdCheck<ExperimentId>('experimentId'))
  if (!experiment.ok) return experiment
  const sort = checkOptional(record, 'sort', metricSortCheck)
  if (!sort.ok) return sort
  const aggregate = checkOptional(record, 'aggregate', oneOf('aggregate', ['latest', 'average', 'min', 'max']))
  if (!aggregate.ok) return aggregate
  const limit = checkOptional(record, 'limit', positiveNumberCheck)
  if (!limit.ok) return limit
  return ok(validated<MetricQuery>(input))
}

const attentionSubjectCheck: Check<AttentionSubject> = (input) => {
  const record = asRecord(input)
  if (record === null) return invalid('attention subject must be an object')
  const kind = record['kind']
  if (kind === 'program') {
    const extra = firstExtraKey(record, ['kind', 'id'])
    if (extra !== null) return invalid(`attention subject does not accept the field ${extra}`)
    const id = entityIdCheck<ProgramId>('id')(record['id'])
    if (!id.ok) return id
    return ok({ kind: 'program', id: id.value })
  }
  if (kind === 'issue') {
    const extra = firstExtraKey(record, ['kind', 'id'])
    if (extra !== null) return invalid(`attention subject does not accept the field ${extra}`)
    const id = entityIdCheck<IssueId>('id')(record['id'])
    if (!id.ok) return id
    return ok({ kind: 'issue', id: id.value })
  }
  if (kind === 'experiment') {
    const extra = firstExtraKey(record, ['kind', 'id'])
    if (extra !== null) return invalid(`attention subject does not accept the field ${extra}`)
    const id = entityIdCheck<ExperimentId>('id')(record['id'])
    if (!id.ok) return id
    return ok({ kind: 'experiment', id: id.value })
  }
  if (kind === 'ci-run') {
    const extra = firstExtraKey(record, ['kind', 'id'])
    if (extra !== null) return invalid(`attention subject does not accept the field ${extra}`)
    const id = entityIdCheck<CIRunId>('id')(record['id'])
    if (!id.ok) return id
    return ok({ kind: 'ci-run', id: id.value })
  }
  return invalid("attention subject kind must be 'program', 'issue', 'experiment' or 'ci-run'")
}

const issueLabelsCheck: Check<readonly IssueLabel[]> = (input) => {
  const items = asArray(input)
  if (items === null || items.length === 0) return invalid('labels must be a non-empty array')
  const labels: readonly string[] = ['research', 'experiment', 'analysis', 'bug', 'blocked']
  for (const item of items) {
    const parsed = oneOf('issue label', labels)(item)
    if (!parsed.ok) return parsed
  }
  return ok(validated<readonly IssueLabel[]>(input))
}

const issueResolutionCheck: Check<'accepted' | 'rejected' | 'abandoned'> = oneOf('issue resolution', [
  'accepted',
  'rejected',
  'abandoned',
])

const explorationCheck: Check<'low' | 'normal' | 'high'> = oneOf('exploration level', ['low', 'normal', 'high'])
const metricDirectionCheck: Check<'higher' | 'lower'> = oneOf('metric direction', ['higher', 'lower'])

const evaluationContractCheck: Check<CommandOf<'program.create'>['contract']> = (input) => {
  const record = asRecord(input)
  if (record === null) return invalid('evaluation contract must be an object')
  const extra = firstExtraKey(record, ['ciEntry', 'timeoutMs', 'requiredMetrics'])
  if (extra !== null) return invalid(`evaluation contract does not accept the field ${extra}`)
  const ciEntry = labelled('ciEntry', textCheck)(record['ciEntry'])
  if (!ciEntry.ok) return ciEntry
  const timeoutMs = durationCheck(record['timeoutMs'])
  if (!timeoutMs.ok) return timeoutMs
  const metrics = asArray(record['requiredMetrics'])
  if (metrics === null || metrics.length === 0) return invalid('requiredMetrics must be a non-empty array')
  for (const metric of metrics) {
    const parsed = metricNameCheck(metric)
    if (!parsed.ok) return parsed
  }
  return ok(validated<CommandOf<'program.create'>['contract']>(input))
}

const utilityConfigCheck: Check<CommandOf<'program.create'>['utility']> = (input) => {
  const record = asRecord(input)
  if (record === null) return invalid('utility config must be an object')
  const extra = firstExtraKey(record, ['metrics'])
  if (extra !== null) return invalid(`utility config does not accept the field ${extra}`)
  const metrics = asArray(record['metrics'])
  if (metrics === null || metrics.length === 0) return invalid('utility metrics must be a non-empty array')
  for (const metric of metrics) {
    const definition = asRecord(metric)
    if (definition === null) return invalid('every utility metric must be an object')
    const definitionExtra = firstExtraKey(definition, ['name', 'direction', 'weight'])
    if (definitionExtra !== null) return invalid(`utility metric does not accept the field ${definitionExtra}`)
    const name = metricNameCheck(definition['name'])
    if (!name.ok) return name
    const direction = metricDirectionCheck(definition['direction'])
    if (!direction.ok) return direction
    const weight = positiveNumberCheck(definition['weight'])
    if (!weight.ok) return weight
  }
  return ok(validated<CommandOf<'program.create'>['utility']>(input))
}

const budgetCheck: Check<CommandOf<'program.create'>['budget']> = (input) => {
  const record = asRecord(input)
  if (record === null) return invalid('budget must be an object')
  const extra = firstExtraKey(record, ['maxExperiments', 'maxComputeMinutes', 'maxTokens'])
  if (extra !== null) return invalid(`budget does not accept the field ${extra}`)
  for (const key of ['maxExperiments', 'maxComputeMinutes', 'maxTokens']) {
    const parsed = positiveIntCheck(record[key])
    if (!parsed.ok) return parsed
  }
  return ok(validated<CommandOf<'program.create'>['budget']>(input))
}

// ---------------------------------------------------------------------------
// Object and command parsers.
// ---------------------------------------------------------------------------

function parseObject<Input>(
  input: unknown,
  label: string,
  allowed: readonly string[],
  requiredChecks: Readonly<Record<string, Check<unknown>>>,
  optionalChecks: Readonly<Record<string, Check<unknown>>> = {},
): Result<Input, DomainError> {
  const record = asRecord(input)
  if (record === null) return invalid(`${label} must be an object`)
  const extra = firstExtraKey(record, allowed)
  if (extra !== null) return invalid(`${label} does not accept the field ${extra}`)
  for (const [key, check] of Object.entries(requiredChecks)) {
    const parsed = check(record[key])
    if (!parsed.ok) return parsed
  }
  for (const [key, check] of Object.entries(optionalChecks)) {
    const parsed = checkOptional(record, key, check)
    if (!parsed.ok) return parsed
  }
  return ok(validated<Input>(input))
}

function parseCommand<Input>(
  input: unknown,
  command: CommandType,
  label: string,
  allowed: readonly string[],
  requiredChecks: Readonly<Record<string, Check<unknown>>>,
): Result<Input, DomainError> {
  const record = asRecord(input)
  if (record === null) return invalid(`${label} must be an object`)
  if (record['type'] !== command) return invalid(`${label} must carry type ${command}`)
  return parseObject<Input>(input, label, allowed, requiredChecks)
}

function inputSchema<T>(
  jsonSchema: Readonly<Record<string, unknown>>,
  parse: (input: unknown) => Result<T, DomainError>,
): Schema<T> {
  return { parse, toJsonSchema: () => jsonSchema }
}

function outputSchema<T>(
  label: string,
  jsonSchema: Readonly<Record<string, unknown>>,
  accepts: (value: unknown) => boolean,
): Schema<T> {
  return {
    parse: (input) => (accepts(input) ? ok(validated<T>(input)) : invalid(`the ${label} output does not match its contract`)),
    toJsonSchema: () => jsonSchema,
  }
}

// ---------------------------------------------------------------------------
// JSON Schema fragments. Kept next to the parsers they advertise.
// ---------------------------------------------------------------------------

const ID_JSON: Readonly<Record<string, unknown>> = {
  type: 'string',
  minLength: 1,
  maxLength: MAX_ID_LENGTH,
  pattern: ENTITY_ID_PATTERN.source,
}
const TEXT_JSON: Readonly<Record<string, unknown>> = { type: 'string', minLength: 1 }
const STRING_JSON: Readonly<Record<string, unknown>> = { type: 'string' }
const METRIC_NAME_JSON: Readonly<Record<string, unknown>> = {
  type: 'string',
  minLength: 1,
  maxLength: MAX_METRIC_NAME_LENGTH,
}
const COMMIT_JSON: Readonly<Record<string, unknown>> = { type: 'string', pattern: COMMIT_SHA_PATTERN.source }
const POSITIVE_INT_JSON: Readonly<Record<string, unknown>> = { type: 'integer', minimum: 1 }
const POSITIVE_NUMBER_JSON: Readonly<Record<string, unknown>> = { type: 'number', exclusiveMinimum: 0 }
const DURATION_JSON: Readonly<Record<string, unknown>> = { type: 'number', minimum: 0 }

const ENVIRONMENT_JSON: Readonly<Record<string, unknown>> = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'lockFile', 'pythonVersion'],
      properties: {
        kind: { const: 'uv-lock' },
        lockFile: STRING_JSON,
        pythonVersion: STRING_JSON,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'requirementsFile', 'pythonVersion'],
      properties: {
        kind: { const: 'requirements' },
        requirementsFile: STRING_JSON,
        pythonVersion: STRING_JSON,
      },
    },
  ],
}

const ARTIFACT_JSON: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'kind', 'digest', 'bytes', 'programId', 'experimentId', 'commit', 'ciRunId', 'retention', 'createdAt'],
  properties: {
    id: ID_JSON,
    kind: { enum: ['model-weights', 'report', 'figure', 'logs', 'other'] },
    digest: TEXT_JSON,
    bytes: { type: 'number', minimum: 0 },
    programId: ID_JSON,
    experimentId: ID_JSON,
    commit: COMMIT_JSON,
    ciRunId: ID_JSON,
    retention: { enum: ['keep', 'temporary'] },
    createdAt: STRING_JSON,
  },
}

const EXPERIMENT_PLAN_JSON: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  required: ['hypothesis', 'steps', 'expected', 'environment', 'inputs'],
  properties: {
    hypothesis: TEXT_JSON,
    steps: { type: 'array', minItems: 1, items: TEXT_JSON },
    expected: {
      type: 'object',
      additionalProperties: false,
      required: ['direction', 'rationale'],
      properties: { direction: { enum: ['higher', 'lower'] }, rationale: TEXT_JSON },
    },
    environment: ENVIRONMENT_JSON,
    inputs: { type: 'array', items: ARTIFACT_JSON },
  },
}

const METRIC_QUERY_JSON: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  required: ['programId'],
  properties: {
    programId: ID_JSON,
    experimentId: ID_JSON,
    sort: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['metric', 'direction'],
        properties: { metric: METRIC_NAME_JSON, direction: { enum: ['higher', 'lower'] } },
      },
    },
    aggregate: { enum: ['latest', 'average', 'min', 'max'] },
    limit: POSITIVE_NUMBER_JSON,
  },
}

const ATTENTION_SUBJECT_JSON: Readonly<Record<string, unknown>> = {
  oneOf: [
    { type: 'object', additionalProperties: false, required: ['kind', 'id'], properties: { kind: { const: 'program' }, id: ID_JSON } },
    { type: 'object', additionalProperties: false, required: ['kind', 'id'], properties: { kind: { const: 'issue' }, id: ID_JSON } },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'id'],
      properties: { kind: { const: 'experiment' }, id: ID_JSON },
    },
    { type: 'object', additionalProperties: false, required: ['kind', 'id'], properties: { kind: { const: 'ci-run' }, id: ID_JSON } },
  ],
}

function commandJson(
  command: CommandType,
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[],
): Readonly<Record<string, unknown>> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['type', ...required],
    properties: { type: { const: command }, ...properties },
  }
}

const READ_PROGRAM_JSON: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  required: ['programId'],
  properties: { programId: ID_JSON },
}

const READ_EXPERIMENT_JSON: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  required: ['experimentId'],
  properties: { experimentId: ID_JSON },
}

const CREATE_ISSUE_JSON = commandJson(
  'issue.create',
  {
    programId: ID_JSON,
    title: TEXT_JSON,
    body: TEXT_JSON,
    labels: {
      type: 'array',
      minItems: 1,
      items: { enum: ['research', 'experiment', 'analysis', 'bug', 'blocked'] },
    },
  },
  ['programId', 'title', 'body', 'labels'],
)

const CLAIM_ISSUE_JSON = commandJson('issue.claim', { programId: ID_JSON, issueId: ID_JSON }, ['programId', 'issueId'])

const COMMENT_ON_ISSUE_JSON = commandJson(
  'issue.comment',
  {
    programId: ID_JSON,
    issueId: ID_JSON,
    body: TEXT_JSON,
    kind: { enum: ['comment', 'plan'] },
  },
  ['programId', 'issueId', 'body', 'kind'],
)

const PROPOSE_EXPERIMENT_JSON = commandJson(
  'experiment.propose',
  { programId: ID_JSON, issueId: ID_JSON, plan: EXPERIMENT_PLAN_JSON },
  ['programId', 'issueId', 'plan'],
)

const REVIEW_EXPERIMENT_JSON = commandJson(
  'experiment.review',
  {
    programId: ID_JSON,
    experimentId: ID_JSON,
    body: TEXT_JSON,
    verdict: { enum: ['approve', 'request-changes', 'comment'] },
  },
  ['programId', 'experimentId', 'body', 'verdict'],
)

const REQUEST_CI_JSON = commandJson(
  'ci.request',
  { programId: ID_JSON, experimentId: ID_JSON },
  ['programId', 'experimentId'],
)

const CLOSE_ISSUE_JSON = commandJson(
  'issue.close',
  {
    programId: ID_JSON,
    issueId: ID_JSON,
    resolution: { enum: ['accepted', 'rejected', 'abandoned'] },
    summary: TEXT_JSON,
  },
  ['programId', 'issueId', 'resolution', 'summary'],
)

const CLOSE_EXPERIMENT_JSON = commandJson(
  'experiment.close',
  { programId: ID_JSON, experimentId: ID_JSON, reason: TEXT_JSON },
  ['programId', 'experimentId', 'reason'],
)

const SUBMIT_IMPLEMENTATION_JSON = commandJson(
  'ticket.submit',
  { head: COMMIT_JSON, environment: ENVIRONMENT_JSON },
  ['head', 'environment'],
)

const CREATE_PROGRAM_JSON = commandJson(
  'program.create',
  {
    name: TEXT_JSON,
    goal: TEXT_JSON,
    methodology: TEXT_JSON,
    contract: {
      type: 'object',
      additionalProperties: false,
      required: ['ciEntry', 'timeoutMs', 'requiredMetrics'],
      properties: {
        ciEntry: TEXT_JSON,
        timeoutMs: DURATION_JSON,
        requiredMetrics: { type: 'array', minItems: 1, items: METRIC_NAME_JSON },
      },
    },
    utility: {
      type: 'object',
      additionalProperties: false,
      required: ['metrics'],
      properties: {
        metrics: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'direction', 'weight'],
            properties: {
              name: METRIC_NAME_JSON,
              direction: { enum: ['higher', 'lower'] },
              weight: POSITIVE_NUMBER_JSON,
            },
          },
        },
      },
    },
    exploration: { enum: ['low', 'normal', 'high'] },
    budget: {
      type: 'object',
      additionalProperties: false,
      required: ['maxExperiments', 'maxComputeMinutes', 'maxTokens'],
      properties: {
        maxExperiments: POSITIVE_INT_JSON,
        maxComputeMinutes: POSITIVE_INT_JSON,
        maxTokens: POSITIVE_INT_JSON,
      },
    },
  },
  ['name', 'goal', 'methodology', 'contract', 'utility', 'exploration', 'budget'],
)

const PAUSE_PROGRAM_JSON = commandJson('program.pause', { programId: ID_JSON }, ['programId'])
const RESUME_PROGRAM_JSON = commandJson('program.resume', { programId: ID_JSON }, ['programId'])
const STOP_PROGRAM_JSON = commandJson(
  'program.stop',
  { programId: ID_JSON, reason: TEXT_JSON },
  ['programId', 'reason'],
)
const SET_GOAL_JSON = commandJson(
  'program.set-goal',
  { programId: ID_JSON, goal: TEXT_JSON },
  ['programId', 'goal'],
)
const SET_METHODOLOGY_JSON = commandJson(
  'program.set-methodology',
  { programId: ID_JSON, methodology: TEXT_JSON },
  ['programId', 'methodology'],
)
const SET_EXPLORATION_JSON = commandJson(
  'program.set-exploration',
  { programId: ID_JSON, level: { enum: ['low', 'normal', 'high'] } },
  ['programId', 'level'],
)

const LIST_STALLED_JSON: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  required: [],
  properties: {},
}

const RAISE_ATTENTION_JSON: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  required: ['reason', 'subject'],
  properties: { reason: STRING_JSON, subject: ATTENTION_SUBJECT_JSON },
}

// ---------------------------------------------------------------------------
// Parameter schemas.
// ---------------------------------------------------------------------------

const programIdCheck = entityIdCheck<ProgramId>('programId')
const issueIdCheck = entityIdCheck<IssueId>('issueId')
const experimentIdCheck = entityIdCheck<ExperimentId>('experimentId')

const readProgramParameters = inputSchema<{ readonly programId: ProgramId }>(READ_PROGRAM_JSON, (input) =>
  parseObject<{ readonly programId: ProgramId }>(input, 'readProgram input', ['programId'], {
    programId: programIdCheck,
  }),
)

const readExperimentParameters = inputSchema<{ readonly experimentId: ExperimentId }>(READ_EXPERIMENT_JSON, (input) =>
  parseObject<{ readonly experimentId: ExperimentId }>(input, 'readExperiment input', ['experimentId'], {
    experimentId: experimentIdCheck,
  }),
)

const readMetricsParameters = inputSchema<MetricQuery>(METRIC_QUERY_JSON, (input) => metricQueryCheck(input))

const createIssueParameters = inputSchema<CommandOf<'issue.create'>>(CREATE_ISSUE_JSON, (input) =>
  parseCommand<CommandOf<'issue.create'>>(input, 'issue.create', 'createIssue input', ['type', 'programId', 'title', 'body', 'labels'], {
    programId: programIdCheck,
    title: labelled('title', textCheck),
    body: labelled('body', textCheck),
    labels: issueLabelsCheck,
  }),
)

const claimIssueParameters = inputSchema<CommandOf<'issue.claim'>>(CLAIM_ISSUE_JSON, (input) =>
  parseCommand<CommandOf<'issue.claim'>>(input, 'issue.claim', 'claimIssue input', ['type', 'programId', 'issueId'], {
    programId: programIdCheck,
    issueId: issueIdCheck,
  }),
)

const commentOnIssueParameters = inputSchema<CommandOf<'issue.comment'>>(COMMENT_ON_ISSUE_JSON, (input) =>
  parseCommand<CommandOf<'issue.comment'>>(input, 'issue.comment', 'commentOnIssue input', ['type', 'programId', 'issueId', 'body', 'kind'], {
    programId: programIdCheck,
    issueId: issueIdCheck,
    body: labelled('body', textCheck),
    kind: oneOf('comment kind', ['comment', 'plan']),
  }),
)

type ProposeExperimentInput = Omit<CommandOf<'experiment.propose'>, 'assignment'>

const proposeExperimentParameters = inputSchema<ProposeExperimentInput>(PROPOSE_EXPERIMENT_JSON, (input) =>
  parseCommand<ProposeExperimentInput>(input, 'experiment.propose', 'proposeExperiment input', ['type', 'programId', 'issueId', 'plan'], {
    programId: programIdCheck,
    issueId: issueIdCheck,
    plan: experimentPlanCheck,
  }),
)

type ReviewExperimentInput = Omit<CommandOf<'experiment.review'>, 'assignment'>

const reviewExperimentParameters = inputSchema<ReviewExperimentInput>(REVIEW_EXPERIMENT_JSON, (input) =>
  parseCommand<ReviewExperimentInput>(
    input,
    'experiment.review',
    'reviewExperiment input',
    ['type', 'programId', 'experimentId', 'body', 'verdict'],
    {
      programId: programIdCheck,
      experimentId: experimentIdCheck,
      body: labelled('body', textCheck),
      verdict: oneOf('review verdict', ['approve', 'request-changes', 'comment']),
    },
  ),
)

const requestCIParameters = inputSchema<CommandOf<'ci.request'>>(REQUEST_CI_JSON, (input) =>
  parseCommand<CommandOf<'ci.request'>>(input, 'ci.request', 'requestCI input', ['type', 'programId', 'experimentId'], {
    programId: programIdCheck,
    experimentId: experimentIdCheck,
  }),
)

const closeIssueParameters = inputSchema<CommandOf<'issue.close'>>(CLOSE_ISSUE_JSON, (input) =>
  parseCommand<CommandOf<'issue.close'>>(input, 'issue.close', 'closeIssue input', ['type', 'programId', 'issueId', 'resolution', 'summary'], {
    programId: programIdCheck,
    issueId: issueIdCheck,
    resolution: issueResolutionCheck,
    summary: labelled('summary', textCheck),
  }),
)

type CloseExperimentInput = Omit<CommandOf<'experiment.close'>, 'assignment'>

const closeExperimentParameters = inputSchema<CloseExperimentInput>(CLOSE_EXPERIMENT_JSON, (input) =>
  parseCommand<CloseExperimentInput>(input, 'experiment.close', 'closeExperiment input', ['type', 'programId', 'experimentId', 'reason'], {
    programId: programIdCheck,
    experimentId: experimentIdCheck,
    reason: labelled('reason', textCheck),
  }),
)

type SubmitImplementationInput = Omit<CommandOf<'ticket.submit'>, 'binding'>

const submitImplementationParameters = inputSchema<SubmitImplementationInput>(SUBMIT_IMPLEMENTATION_JSON, (input) =>
  parseCommand<SubmitImplementationInput>(input, 'ticket.submit', 'submitImplementation input', ['type', 'head', 'environment'], {
    head: commitShaCheck,
    environment: environmentCheck,
  }),
)

const createProgramParameters = inputSchema<CommandOf<'program.create'>>(CREATE_PROGRAM_JSON, (input) =>
  parseCommand<CommandOf<'program.create'>>(
    input,
    'program.create',
    'createProgram input',
    ['type', 'name', 'goal', 'methodology', 'contract', 'utility', 'exploration', 'budget'],
    {
      name: labelled('name', textCheck),
      goal: labelled('goal', textCheck),
      methodology: labelled('methodology', textCheck),
      contract: evaluationContractCheck,
      utility: utilityConfigCheck,
      exploration: explorationCheck,
      budget: budgetCheck,
    },
  ),
)

const pauseProgramParameters = inputSchema<CommandOf<'program.pause'>>(PAUSE_PROGRAM_JSON, (input) =>
  parseCommand<CommandOf<'program.pause'>>(input, 'program.pause', 'pauseProgram input', ['type', 'programId'], {
    programId: programIdCheck,
  }),
)

const resumeProgramParameters = inputSchema<CommandOf<'program.resume'>>(RESUME_PROGRAM_JSON, (input) =>
  parseCommand<CommandOf<'program.resume'>>(input, 'program.resume', 'resumeProgram input', ['type', 'programId'], {
    programId: programIdCheck,
  }),
)

const stopProgramParameters = inputSchema<CommandOf<'program.stop'>>(STOP_PROGRAM_JSON, (input) =>
  parseCommand<CommandOf<'program.stop'>>(input, 'program.stop', 'stopProgram input', ['type', 'programId', 'reason'], {
    programId: programIdCheck,
    reason: labelled('reason', textCheck),
  }),
)

const setGoalParameters = inputSchema<CommandOf<'program.set-goal'>>(SET_GOAL_JSON, (input) =>
  parseCommand<CommandOf<'program.set-goal'>>(input, 'program.set-goal', 'setGoal input', ['type', 'programId', 'goal'], {
    programId: programIdCheck,
    goal: labelled('goal', textCheck),
  }),
)

const setMethodologyParameters = inputSchema<CommandOf<'program.set-methodology'>>(SET_METHODOLOGY_JSON, (input) =>
  parseCommand<CommandOf<'program.set-methodology'>>(
    input,
    'program.set-methodology',
    'setMethodology input',
    ['type', 'programId', 'methodology'],
    {
      programId: programIdCheck,
      methodology: labelled('methodology', textCheck),
    },
  ),
)

const setExplorationParameters = inputSchema<CommandOf<'program.set-exploration'>>(SET_EXPLORATION_JSON, (input) =>
  parseCommand<CommandOf<'program.set-exploration'>>(
    input,
    'program.set-exploration',
    'setExploration input',
    ['type', 'programId', 'level'],
    {
      programId: programIdCheck,
      level: explorationCheck,
    },
  ),
)

const listStalledParameters = inputSchema<Record<string, never>>(LIST_STALLED_JSON, (input) => {
  const record = asRecord(input)
  if (record === null) return invalid('listStalled input must be an object')
  const extra = firstExtraKey(record, [])
  if (extra !== null) return invalid(`listStalled input does not accept the field ${extra}`)
  return ok(validated<Record<string, never>>(input))
})

const raiseAttentionParameters = inputSchema<{ readonly reason: string; readonly subject: AttentionSubject }>(
  RAISE_ATTENTION_JSON,
  (input) =>
    parseObject<{ readonly reason: string; readonly subject: AttentionSubject }>(
      input,
      'raiseAttention input',
      ['reason', 'subject'],
      {
        reason: labelled('reason', stringCheck),
        subject: attentionSubjectCheck,
      },
    ),
)

// ---------------------------------------------------------------------------
// Output validators.
// ---------------------------------------------------------------------------

function passes<T>(check: Check<T>, value: unknown): boolean {
  return check(value).ok
}

function isArrayOf(value: unknown, predicate: (item: unknown) => boolean): boolean {
  const items = asArray(value)
  if (items === null) return false
  for (const item of items) {
    if (!predicate(item)) return false
  }
  return true
}

function isNonEmptyArrayOf(value: unknown, predicate: (item: unknown) => boolean): boolean {
  const items = asArray(value)
  if (items === null || items.length === 0) return false
  for (const item of items) {
    if (!predicate(item)) return false
  }
  return true
}

function isText(value: unknown): boolean {
  return passes(textCheck, value)
}

function isIdentifier(value: unknown): boolean {
  return passes(identifierCheck('id'), value)
}

function isCommit(value: unknown): boolean {
  return passes(commitShaCheck, value)
}

function isMetricName(value: unknown): boolean {
  return passes(metricNameCheck, value)
}

function isFiniteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonNegativeNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isEnumValue(value: unknown, values: readonly string[]): boolean {
  return typeof value === 'string' && values.includes(value)
}

const issueLabelValues: readonly string[] = ['research', 'experiment', 'analysis', 'bug', 'blocked']
const severityValues: readonly string[] = ['info', 'warning', 'blocked']
const programStatusValues: readonly string[] = ['running', 'paused', 'stopped', 'completed']
const issueStatusValues: readonly string[] = ['open', 'assigned', 'closed']
const experimentStatusValues: readonly string[] = [
  'open',
  'ready',
  'ci-pending',
  'ci-running',
  'ci-passed',
  'ci-failed',
  'closed',
]
const ciStatusValues: readonly string[] = ['requested', 'running', 'passed', 'failed']
const attentionSubjectKinds: readonly string[] = ['program', 'issue', 'experiment', 'ci-run']
const auditSubjectKinds: readonly string[] = ['program', 'issue', 'experiment', 'ci-run', 'artifact']

function isPrincipalOfKind(value: unknown, kinds: readonly string[]): boolean {
  const record = asRecord(value)
  if (record === null) return false
  const kind = record['kind']
  if (typeof kind !== 'string' || !kinds.includes(kind)) return false
  return isIdentifier(record['sessionId'])
}

function isAuditActor(value: unknown): boolean {
  const record = asRecord(value)
  if (record === null) return false
  const kind = record['kind']
  if (kind === 'host') return true
  return isPrincipalOfKind(value, ['operator', 'researcher', 'implementer', 'watchdog', 'router'])
}

function isEvaluationContract(value: unknown): boolean {
  const record = asRecord(value)
  if (record === null) return false
  return (
    isText(record['ciEntry']) &&
    passes(durationCheck, record['timeoutMs']) &&
    isNonEmptyArrayOf(record['requiredMetrics'], isMetricName)
  )
}

function isMetricDefinition(value: unknown): boolean {
  const record = asRecord(value)
  if (record === null) return false
  return (
    isMetricName(record['name']) &&
    isEnumValue(record['direction'], ['higher', 'lower']) &&
    passes(positiveNumberCheck, record['weight'])
  )
}

function isUtilityConfig(value: unknown): boolean {
  const record = asRecord(value)
  if (record === null) return false
  return isNonEmptyArrayOf(record['metrics'], isMetricDefinition)
}

function isBudget(value: unknown): boolean {
  const record = asRecord(value)
  if (record === null) return false
  return (
    passes(positiveIntCheck, record['maxExperiments']) &&
    passes(positiveIntCheck, record['maxComputeMinutes']) &&
    passes(positiveIntCheck, record['maxTokens'])
  )
}

function isBudgetUsage(value: unknown): boolean {
  const record = asRecord(value)
  if (record === null) return false
  return (
    isNonNegativeNumber(record['experiments']) &&
    isNonNegativeNumber(record['computeMinutes']) &&
    isNonNegativeNumber(record['tokens'])
  )
}

function isProgramBase(value: unknown): boolean {
  const record = asRecord(value)
  if (record === null) return false
  return (
    isIdentifier(record['id']) &&
    isText(record['name']) &&
    isText(record['goal']) &&
    isText(record['methodology']) &&
    isEvaluationContract(record['contract']) &&
    isUtilityConfig(record['utility']) &&
    passes(explorationCheck, record['exploration']) &&
    isBudget(record['budget']) &&
    isBudgetUsage(record['usage']) &&
    passes(isoTimestampCheck, record['createdAt'])
  )
}

function isProgramWithStatus(value: unknown, status: string): boolean {
  const record = asRecord(value)
  if (record === null) return false
  return record['status'] === status && isProgramBase(value)
}

function isIssueBase(value: unknown): boolean {
  const record = asRecord(value)
  if (record === null) return false
  return (
    isIdentifier(record['id']) &&
    isIdentifier(record['programId']) &&
    isText(record['title']) &&
    isText(record['body']) &&
    isArrayOf(record['labels'], (label) => isEnumValue(label, issueLabelValues)) &&
    isPrincipalOfKind(record['author'], ['operator', 'researcher']) &&
    passes(isoTimestampCheck, record['createdAt'])
  )
}

function isIssueWithStatus(value: unknown, status: string): boolean {
  const record = asRecord(value)
  if (record === null) return false
  return record['status'] === status && isIssueBase(value)
}

function isOpenIssue(value: unknown): boolean {
  return isIssueWithStatus(value, 'open')
}

function isAssignedIssue(value: unknown): boolean {
  if (!isIssueWithStatus(value, 'assigned')) return false
  const record = asRecord(value)
  if (record === null) return false
  return (
    isPrincipalOfKind(record['assignee'], ['researcher']) &&
    passes(isoTimestampCheck, record['assignedAt']) &&
    isArrayOf(record['experimentIds'], isIdentifier)
  )
}

function isClosedIssue(value: unknown): boolean {
  if (!isIssueWithStatus(value, 'closed')) return false
  const record = asRecord(value)
  if (record === null) return false
  const assigneeSessionId = record['assigneeSessionId']
  const sessionOk = assigneeSessionId === null || typeof assigneeSessionId === 'string'
  return (
    sessionOk &&
    passes(isoTimestampCheck, record['closedAt']) &&
    isEnumValue(record['resolution'], ['accepted', 'rejected', 'abandoned']) &&
    isText(record['summary'])
  )
}

function isIssue(value: unknown): boolean {
  const record = asRecord(value)
  if (record === null) return false
  const status = record['status']
  if (status === 'open') return isOpenIssue(value)
  if (status === 'assigned') return isAssignedIssue(value)
  if (status === 'closed') return isClosedIssue(value)
  return false
}

function isEnvironment(value: unknown): boolean {
  return passes(environmentCheck, value)
}

function isArtifactRef(value: unknown): boolean {
  return passes(artifactRefCheck, value)
}

function isLineage(value: unknown): boolean {
  const record = asRecord(value)
  if (record === null) return false
  if (record['strategy'] === 'derive') {
    return (
      isIdentifier(record['baseExperimentId']) &&
      isCommit(record['baseCommit']) &&
      isFiniteNumber(record['temperature']) &&
      isFiniteNumber(record['sampledWeight'])
    )
  }
  if (record['strategy'] === 'fresh') {
    return isCommit(record['baseCommit']) && isFiniteNumber(record['freshStartProbability'])
  }
  return false
}

function isExperimentBase(value: unknown): boolean {
  const record = asRecord(value)
  if (record === null) return false
  return (
    isIdentifier(record['id']) &&
    isIdentifier(record['programId']) &&
    isIdentifier(record['issueId']) &&
    isText(record['branch']) &&
    isCommit(record['head']) &&
    isEnvironment(record['environment']) &&
    isLineage(record['lineage']) &&
    isIdentifier(record['planCommentId']) &&
    isPrincipalOfKind(record['createdBy'], ['researcher']) &&
    passes(isoTimestampCheck, record['createdAt'])
  )
}

function isExperimentWithStatus(value: unknown, status: string): boolean {
  const record = asRecord(value)
  if (record === null) return false
  return record['status'] === status && isExperimentBase(value)
}

function isOpenExperiment(value: unknown): boolean {
  return isExperimentWithStatus(value, 'open')
}

function isReadyExperiment(value: unknown): boolean {
  if (!isExperimentWithStatus(value, 'ready')) return false
  const record = asRecord(value)
  return record !== null && passes(isoTimestampCheck, record['readyAt'])
}

function isCIPendingExperiment(value: unknown): boolean {
  if (!isExperimentWithStatus(value, 'ci-pending')) return false
  const record = asRecord(value)
  if (record === null) return false
  return isIdentifier(record['ciRunId']) && passes(isoTimestampCheck, record['requestedAt'])
}

function isClosedExperiment(value: unknown): boolean {
  if (!isExperimentWithStatus(value, 'closed')) return false
  const record = asRecord(value)
  if (record === null) return false
  return (
    passes(isoTimestampCheck, record['closedAt']) &&
    isText(record['closeReason']) &&
    isEnumValue(record['outcome'], ['concluded', 'failed', 'cancelled'])
  )
}

function isExperiment(value: unknown): boolean {
  const record = asRecord(value)
  if (record === null) return false
  const status = record['status']
  if (status === 'open') return isOpenExperiment(value)
  if (status === 'ready') return isReadyExperiment(value)
  if (status === 'ci-pending') return isCIPendingExperiment(value)
  if (status === 'closed') return isClosedExperiment(value)
  if (status === 'ci-running' || status === 'ci-passed' || status === 'ci-failed') {
    return isExperimentBase(value)
  }
  return false
}

function isIssueComment(value: unknown): boolean {
  const record = asRecord(value)
  if (record === null) return false
  return (
    isIdentifier(record['id']) &&
    isIdentifier(record['issueId']) &&
    typeof record['authorSessionId'] === 'string' &&
    isText(record['body']) &&
    passes(isoTimestampCheck, record['at']) &&
    isEnumValue(record['kind'], ['comment', 'plan'])
  )
}

function isExperimentReview(value: unknown): boolean {
  const record = asRecord(value)
  if (record === null) return false
  return (
    isIdentifier(record['id']) &&
    isIdentifier(record['experimentId']) &&
    isPrincipalOfKind(record['author'], ['researcher']) &&
    isText(record['body']) &&
    passes(isoTimestampCheck, record['at']) &&
    record['kind'] === 'review' &&
    isEnumValue(record['verdict'], ['approve', 'request-changes', 'comment'])
  )
}

function isAttentionSubject(value: unknown): boolean {
  const record = asRecord(value)
  if (record === null) return false
  if (!isEnumValue(record['kind'], attentionSubjectKinds)) return false
  return isIdentifier(record['id'])
}

function isAttention(value: unknown): boolean {
  const record = asRecord(value)
  if (record === null) return false
  const acknowledgedAt = record['acknowledgedAt']
  const acknowledgementOk = acknowledgedAt === undefined || passes(isoTimestampCheck, acknowledgedAt)
  return (
    typeof record['id'] === 'string' &&
    isAttentionSubject(record['subject']) &&
    isEnumValue(record['severity'], severityValues) &&
    typeof record['reason'] === 'string' &&
    typeof record['detail'] === 'string' &&
    passes(isoTimestampCheck, record['at']) &&
    acknowledgementOk
  )
}

function isMetricMap(value: unknown): boolean {
  const record = asRecord(value)
  if (record === null) return false
  for (const [, metricValue] of Object.entries(record)) {
    if (!isFiniteNumber(metricValue)) return false
  }
  return true
}

function isCIRecord(value: unknown): boolean {
  const record = asRecord(value)
  if (record === null) return false
  if (
    !isIdentifier(record['id']) ||
    !isIdentifier(record['programId']) ||
    !isIdentifier(record['experimentId']) ||
    !isCommit(record['commit']) ||
    !isIdentifier(record['requestedBy']) ||
    !passes(isoTimestampCheck, record['requestedAt']) ||
    !isEnumValue(record['status'], ciStatusValues)
  ) {
    return false
  }
  if (record['status'] === 'passed') {
    return (
      passes(isoTimestampCheck, record['startedAt']) &&
      passes(isoTimestampCheck, record['finishedAt']) &&
      typeof record['environmentDigest'] === 'string' &&
      isMetricMap(record['metrics']) &&
      isArrayOf(record['artifacts'], isArtifactRef) &&
      passes(durationCheck, record['durationMs'])
    )
  }
  if (record['status'] === 'running') {
    return typeof record['environmentDigest'] === 'string' && passes(isoTimestampCheck, record['startedAt'])
  }
  if (record['status'] === 'failed') {
    return (
      passes(isoTimestampCheck, record['finishedAt']) &&
      typeof record['reason'] === 'string' &&
      typeof record['detail'] === 'string' &&
      passes(durationCheck, record['durationMs'])
    )
  }
  return true
}

function isMetricSummary(value: unknown): boolean {
  const record = asRecord(value)
  if (record === null) return false
  return isMetricName(record['metric']) && isFiniteNumber(record['value'])
}

function isMetricQueryResult(value: unknown): boolean {
  const record = asRecord(value)
  if (record === null) return false
  return isArrayOf(record['rows'], isCIRecord) && isArrayOf(record['summaries'], isMetricSummary)
}

function isAuditSubject(value: unknown): boolean {
  const record = asRecord(value)
  if (record === null) return false
  return isEnumValue(record['kind'], auditSubjectKinds) && isIdentifier(record['id'])
}

function isAuditEntry(value: unknown): boolean {
  const record = asRecord(value)
  if (record === null) return false
  return (
    isIdentifier(record['id']) &&
    passes(isoTimestampCheck, record['at']) &&
    isIdentifier(record['programId']) &&
    isText(record['action']) &&
    isAuditSubject(record['subject']) &&
    isAuditActor(record['actor']) &&
    asRecord(record['detail']) !== null
  )
}

function isProgramSnapshot(value: unknown): boolean {
  const record = asRecord(value)
  if (record === null) return false
  return (
    isProgramBase(record['program']) &&
    isArrayOf(record['issues'], isIssue) &&
    isArrayOf(record['comments'], isIssueComment) &&
    isArrayOf(record['experiments'], isExperiment) &&
    isArrayOf(record['ciRecords'], isCIRecord) &&
    isArrayOf(record['artifacts'], isArtifactRef) &&
    isArrayOf(record['attention'], isAttention) &&
    isArrayOf(record['audit'], isAuditEntry)
  )
}

function isIssueList(value: unknown): boolean {
  return isArrayOf(value, isIssue)
}

// ---------------------------------------------------------------------------
// JSON Schema documents for command/read outputs.
// ---------------------------------------------------------------------------

const PROGRAM_OUTPUT_JSON: Readonly<Record<string, unknown>> = {
  type: 'object',
  required: ['id', 'name', 'goal', 'methodology', 'contract', 'utility', 'exploration', 'budget', 'usage', 'createdAt', 'status'],
  properties: {
    id: ID_JSON,
    name: TEXT_JSON,
    goal: TEXT_JSON,
    methodology: TEXT_JSON,
    contract: { type: 'object' },
    utility: { type: 'object' },
    exploration: { enum: ['low', 'normal', 'high'] },
    budget: { type: 'object' },
    usage: { type: 'object' },
    createdAt: STRING_JSON,
    status: { enum: programStatusValues },
  },
}

const ISSUE_OUTPUT_JSON: Readonly<Record<string, unknown>> = {
  type: 'object',
  required: ['id', 'programId', 'title', 'body', 'labels', 'author', 'createdAt', 'status'],
  properties: {
    id: ID_JSON,
    programId: ID_JSON,
    title: TEXT_JSON,
    body: TEXT_JSON,
    labels: { type: 'array', items: { enum: issueLabelValues } },
    author: { type: 'object' },
    createdAt: STRING_JSON,
    status: { enum: issueStatusValues },
    assignee: { type: 'object' },
    assignedAt: STRING_JSON,
    experimentIds: { type: 'array', items: ID_JSON },
    assigneeSessionId: { type: ['string', 'null'] },
    closedAt: STRING_JSON,
    resolution: { enum: ['accepted', 'rejected', 'abandoned'] },
    summary: TEXT_JSON,
  },
}

const EXPERIMENT_OUTPUT_JSON: Readonly<Record<string, unknown>> = {
  type: 'object',
  required: ['id', 'programId', 'issueId', 'branch', 'head', 'environment', 'lineage', 'planCommentId', 'createdBy', 'createdAt', 'status'],
  properties: {
    id: ID_JSON,
    programId: ID_JSON,
    issueId: ID_JSON,
    branch: TEXT_JSON,
    head: COMMIT_JSON,
    environment: ENVIRONMENT_JSON,
    lineage: { type: 'object' },
    planCommentId: ID_JSON,
    createdBy: { type: 'object' },
    createdAt: STRING_JSON,
    status: { enum: experimentStatusValues },
    readyAt: STRING_JSON,
    ciRunId: ID_JSON,
    requestedAt: STRING_JSON,
    closedAt: STRING_JSON,
    closeReason: TEXT_JSON,
    outcome: { enum: ['concluded', 'failed', 'cancelled'] },
  },
}

const ISSUE_COMMENT_OUTPUT_JSON: Readonly<Record<string, unknown>> = {
  type: 'object',
  required: ['id', 'issueId', 'authorSessionId', 'body', 'at', 'kind'],
  properties: {
    id: ID_JSON,
    issueId: ID_JSON,
    authorSessionId: STRING_JSON,
    body: TEXT_JSON,
    at: STRING_JSON,
    kind: { enum: ['comment', 'plan'] },
  },
}

const EXPERIMENT_REVIEW_OUTPUT_JSON: Readonly<Record<string, unknown>> = {
  type: 'object',
  required: ['id', 'experimentId', 'author', 'body', 'at', 'kind', 'verdict'],
  properties: {
    id: ID_JSON,
    experimentId: ID_JSON,
    author: { type: 'object' },
    body: TEXT_JSON,
    at: STRING_JSON,
    kind: { const: 'review' },
    verdict: { enum: ['approve', 'request-changes', 'comment'] },
  },
}

const ATTENTION_OUTPUT_JSON: Readonly<Record<string, unknown>> = {
  type: 'object',
  required: ['id', 'subject', 'severity', 'reason', 'detail', 'at'],
  properties: {
    id: STRING_JSON,
    subject: ATTENTION_SUBJECT_JSON,
    severity: { enum: severityValues },
    reason: STRING_JSON,
    detail: STRING_JSON,
    at: STRING_JSON,
    acknowledgedAt: STRING_JSON,
  },
}

const METRIC_QUERY_RESULT_JSON: Readonly<Record<string, unknown>> = {
  type: 'object',
  required: ['rows', 'summaries'],
  properties: {
    rows: { type: 'array', items: { type: 'object' } },
    summaries: {
      type: 'array',
      items: {
        type: 'object',
        required: ['metric', 'value'],
        properties: { metric: METRIC_NAME_JSON, value: { type: 'number' } },
      },
    },
  },
}

const PROGRAM_SNAPSHOT_JSON: Readonly<Record<string, unknown>> = {
  type: 'object',
  required: ['program', 'issues', 'comments', 'experiments', 'ciRecords', 'artifacts', 'attention', 'audit'],
  properties: {
    program: PROGRAM_OUTPUT_JSON,
    issues: { type: 'array', items: ISSUE_OUTPUT_JSON },
    comments: { type: 'array', items: ISSUE_COMMENT_OUTPUT_JSON },
    experiments: { type: 'array', items: EXPERIMENT_OUTPUT_JSON },
    ciRecords: { type: 'array', items: { type: 'object' } },
    artifacts: { type: 'array', items: { type: 'object' } },
    attention: { type: 'array', items: ATTENTION_OUTPUT_JSON },
    audit: { type: 'array', items: { type: 'object' } },
  },
}

const ISSUE_LIST_JSON: Readonly<Record<string, unknown>> = {
  type: 'array',
  items: ISSUE_OUTPUT_JSON,
}

// ---------------------------------------------------------------------------
// Output schemas.
// ---------------------------------------------------------------------------

const programSnapshotOutput = outputSchema<ProgramSnapshot>('program snapshot', PROGRAM_SNAPSHOT_JSON, isProgramSnapshot)
const metricQueryResultOutput = outputSchema<MetricQueryResult>(
  'metric query result',
  METRIC_QUERY_RESULT_JSON,
  isMetricQueryResult,
)
const issueListOutput = outputSchema<readonly Issue[]>('stalled issue list', ISSUE_LIST_JSON, isIssueList)
const experimentOutput = outputSchema<Experiment>('experiment', EXPERIMENT_OUTPUT_JSON, isExperiment)
const attentionOutput = outputSchema<Attention>('attention', ATTENTION_OUTPUT_JSON, isAttention)
const issueCommentOutput = outputSchema<IssueComment>('issue comment', ISSUE_COMMENT_OUTPUT_JSON, isIssueComment)
const experimentReviewOutput = outputSchema<ExperimentReview>(
  'experiment review',
  EXPERIMENT_REVIEW_OUTPUT_JSON,
  isExperimentReview,
)
const openIssueOutput = outputSchema<OpenIssue>('open issue', ISSUE_OUTPUT_JSON, isOpenIssue)
const assignedIssueOutput = outputSchema<AssignedIssue>('assigned issue', ISSUE_OUTPUT_JSON, isAssignedIssue)
const closedIssueOutput = outputSchema<ClosedIssue>('closed issue', ISSUE_OUTPUT_JSON, isClosedIssue)
const openExperimentOutput = outputSchema<OpenExperiment>('open experiment', EXPERIMENT_OUTPUT_JSON, isOpenExperiment)
const readyExperimentOutput = outputSchema<ReadyExperiment>('ready experiment', EXPERIMENT_OUTPUT_JSON, isReadyExperiment)
const ciPendingExperimentOutput = outputSchema<CIPendingExperiment>(
  'CI-pending experiment',
  EXPERIMENT_OUTPUT_JSON,
  isCIPendingExperiment,
)
const closedExperimentOutput = outputSchema<ClosedExperiment>(
  'closed experiment',
  EXPERIMENT_OUTPUT_JSON,
  isClosedExperiment,
)
const runningProgramOutput = outputSchema<RunningProgram>('running program', PROGRAM_OUTPUT_JSON, (value) =>
  isProgramWithStatus(value, 'running'),
)
const pausedProgramOutput = outputSchema<PausedProgram>('paused program', PROGRAM_OUTPUT_JSON, (value) =>
  isProgramWithStatus(value, 'paused'),
)
const stoppedProgramOutput = outputSchema<StoppedProgram>('stopped program', PROGRAM_OUTPUT_JSON, (value) =>
  isProgramWithStatus(value, 'stopped'),
)

// ---------------------------------------------------------------------------
// Tool definitions.
// ---------------------------------------------------------------------------

function commandTool<K extends CommandType, Input>(
  command: K,
  name: string,
  description: string,
  parameters: Schema<Input>,
  output: Schema<CommandResult<K>>,
): CommandTool<K, Input> {
  return { command, name, description, parameters, output }
}

export const RESEARCHER_TOOLS: ResearcherTools = {
  readProgram: {
    name: 'researcher_read_program',
    description: 'Read a Program: goal, methodology, evaluation contract, budget, usage and status.',
    parameters: readProgramParameters,
    output: programSnapshotOutput,
  },
  readMetrics: {
    name: 'researcher_read_metrics',
    description: 'Query raw CI metric records and query-time summaries for a Program.',
    parameters: readMetricsParameters,
    output: metricQueryResultOutput,
  },
  createIssue: commandTool(
    'issue.create',
    'researcher_create_issue',
    'Create a research Issue in a Program.',
    createIssueParameters,
    openIssueOutput,
  ),
  claimIssue: commandTool(
    'issue.claim',
    'researcher_claim_issue',
    'Claim an open Issue as the calling Researcher.',
    claimIssueParameters,
    assignedIssueOutput,
  ),
  commentOnIssue: commandTool(
    'issue.comment',
    'researcher_comment_on_issue',
    'Add a comment or a typed experiment plan to an Issue.',
    commentOnIssueParameters,
    issueCommentOutput,
  ),
  proposeExperiment: commandTool(
    'experiment.propose',
    'researcher_propose_experiment',
    'Propose an Experiment for an Issue you are assigned to; the Host supplies the assignment proof.',
    proposeExperimentParameters,
    openExperimentOutput,
  ),
  reviewExperiment: commandTool(
    'experiment.review',
    'researcher_review_experiment',
    'Review an Experiment with a verdict and a written rationale.',
    reviewExperimentParameters,
    experimentReviewOutput,
  ),
  requestCI: commandTool(
    'ci.request',
    'researcher_request_ci',
    'Request a CI run for a ready Experiment.',
    requestCIParameters,
    ciPendingExperimentOutput,
  ),
  closeIssue: commandTool(
    'issue.close',
    'researcher_close_issue',
    'Close an Issue with a resolution and a summary.',
    closeIssueParameters,
    closedIssueOutput,
  ),
  closeExperiment: commandTool(
    'experiment.close',
    'researcher_close_experiment',
    'Close an Experiment with a reason; the Host supplies the assignment proof.',
    closeExperimentParameters,
    closedExperimentOutput,
  ),
}

export const IMPLEMENTER_TOOLS: ImplementerTools = {
  submitImplementation: commandTool(
    'ticket.submit',
    'implementer_submit_implementation',
    'Submit a commit and environment for the Experiment bound to this Session; the Host supplies the ticket binding.',
    submitImplementationParameters,
    readyExperimentOutput,
  ),
  readExperiment: {
    name: 'implementer_read_experiment',
    description: 'Read an Experiment by id.',
    parameters: readExperimentParameters,
    output: experimentOutput,
  },
}

export const OPERATOR_TOOLS: OperatorTools = {
  createProgram: commandTool(
    'program.create',
    'operator_create_program',
    'Create and start a Program with its evaluation contract, utility, exploration level and budget.',
    createProgramParameters,
    runningProgramOutput,
  ),
  pauseProgram: commandTool(
    'program.pause',
    'operator_pause_program',
    'Pause a running Program.',
    pauseProgramParameters,
    pausedProgramOutput,
  ),
  resumeProgram: commandTool(
    'program.resume',
    'operator_resume_program',
    'Resume a paused Program.',
    resumeProgramParameters,
    runningProgramOutput,
  ),
  stopProgram: commandTool(
    'program.stop',
    'operator_stop_program',
    'Stop a Program permanently with a reason.',
    stopProgramParameters,
    stoppedProgramOutput,
  ),
  setGoal: commandTool(
    'program.set-goal',
    'operator_set_goal',
    'Replace the goal of a Program.',
    setGoalParameters,
    runningProgramOutput,
  ),
  setMethodology: commandTool(
    'program.set-methodology',
    'operator_set_methodology',
    'Replace the methodology of a Program.',
    setMethodologyParameters,
    runningProgramOutput,
  ),
  setExploration: commandTool(
    'program.set-exploration',
    'operator_set_exploration',
    'Set the exploration level of a Program.',
    setExplorationParameters,
    runningProgramOutput,
  ),
  createIssue: commandTool(
    'issue.create',
    'operator_create_issue',
    'Create an Issue in a Program.',
    createIssueParameters,
    openIssueOutput,
  ),
}

export const WATCHDOG_TOOLS: WatchdogTools = {
  listStalled: {
    name: 'watchdog_list_stalled',
    description: 'List Issues that are stalled and need attention.',
    parameters: listStalledParameters,
    output: issueListOutput,
  },
  raiseAttention: {
    name: 'watchdog_raise_attention',
    description: 'Raise an attention item about a Program, Issue, Experiment or CI run.',
    parameters: raiseAttentionParameters,
    output: attentionOutput,
  },
  readMetrics: {
    name: 'watchdog_read_metrics',
    description: 'Query raw CI metric records and query-time summaries for a Program.',
    parameters: readMetricsParameters,
    output: metricQueryResultOutput,
  },
}

export const TOOL_REGISTRY: {
  readonly operator: OperatorTools
  readonly researcher: ResearcherTools
  readonly implementer: ImplementerTools
  readonly watchdog: WatchdogTools
} = {
  operator: OPERATOR_TOOLS,
  researcher: RESEARCHER_TOOLS,
  implementer: IMPLEMENTER_TOOLS,
  watchdog: WATCHDOG_TOOLS,
}
