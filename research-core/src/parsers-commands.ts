/**
 * Command parser table (implementation phase).
 *
 * Every write route selects one entry by its `CommandType`. An entry accepts the
 * untrusted body as `unknown` and returns the model-supplied part of the command: the
 * ownership proofs the Host injects (`assignment` for the Experiment commands,
 * `binding` for `ticket.submit`) are omitted at the type level and rejected at runtime
 * when a body tries to smuggle them in.
 *
 * The module is a thin composition over `./parsers.ts`: every branded id and refinement
 * comes from that boundary, and this file only checks object shapes, required fields and
 * enums. It never asserts a type, parses JSON or trusts an object shape.
 *
 * Bodies may either carry their `type` literal (the tool-input shape) or omit it (the
 * raw HTTP DTO shape); when present it must name the same command the route selected.
 */
import type { ArtifactInput } from './types/artifacts.js'
import type { CommandOf, CommandType } from './types/commands.js'
import type { EnvironmentDeclaration } from './types/environment.js'
import type { DomainError, Result } from './types/errors.js'
import type { ExperimentPlan } from './types/experiment.js'
import type { IssueLabel, IssueResolution } from './types/issue.js'
import type { MetricDefinition } from './types/metrics.js'
import type { Budget, EvaluationContract, UtilityConfig } from './types/program.js'
import type { NonEmptyArray } from './types/ids.js'
import {
  artifactId,
  commitSha,
  durationMs,
  experimentId,
  explorationLevel,
  issueId,
  metricDirection,
  metricName,
  nonEmptyString,
  positiveInt,
  positiveNumber,
  programId,
} from './parsers.js'

/**
 * The command field only the Host may supply for this command literal. It is `never` for
 * every command whose tool input already omits nothing.
 */
export type HostInjectedField<K extends CommandType> =
  K extends 'experiment.propose' | 'experiment.review' | 'experiment.close'
    ? 'assignment'
    : K extends 'ticket.submit'
      ? 'binding'
      : never

/** A command as a write route may return it: the Host-injected fields are omitted. */
export type ModelCommandOf<K extends CommandType> = Omit<CommandOf<K>, HostInjectedField<K>>

/** One command parser: untrusted body in, model-supplied command out. */
export type CommandParser<K extends CommandType> = (
  input: unknown,
) => Result<ModelCommandOf<K>, DomainError>

/** The parser table; mapped over every command literal, so a parser cannot be missing. */
export type CommandParsers = { readonly [K in CommandType]: CommandParser<K> }

// ---------------------------------------------------------------------------
// Result and object helpers. There is deliberately no validator predicate: an object
// is only ever read through `field`, so the parser table cannot mint a branded value.
// ---------------------------------------------------------------------------

function ok<T>(value: T): Result<T, DomainError> {
  return { ok: true, value }
}

/**
 * Build an `invalid-input` refusal with a non-empty message. `nonEmptyString` is the
 * same refinement every other parser uses; its own failure is unreachable for the
 * literal messages below and is returned as the fallback rather than asserted away.
 */
function invalid<T>(message: string): Result<T, DomainError> {
  const parsed = nonEmptyString(message)
  return parsed.ok
    ? { ok: false, error: { code: 'invalid-input', message: parsed.value } }
    : parsed
}

/** A non-array, non-null object. The check mirrors `parsers.ts`'s record predicate. */
function requireObject(value: unknown, path: string): Result<object, DomainError> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid(`${path} must be an object`)
  }
  return ok(value)
}

/**
 * Read one own property. Only own properties are visible to the parser, so an inherited
 * or polluted property cannot be mistaken for a model-supplied field.
 */
function field(source: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(source, key)?.value
}

/** The first property outside the allowed shape, or `undefined` when the shape is exact. */
function unexpectedKey(source: object, allowed: readonly string[]): string | undefined {
  for (const key of Object.getOwnPropertyNames(source)) {
    if (!allowed.includes(key)) return key
  }
  return undefined
}

function parseAt<T>(
  value: unknown,
  path: string,
  parse: (input: unknown) => Result<T, DomainError>,
): Result<T, DomainError> {
  const parsed = parse(value)
  if (parsed.ok) return parsed
  return invalid(`${path}: ${parsed.error.message}`)
}

function parseField<T>(
  source: object,
  key: string,
  path: string,
  parse: (input: unknown) => Result<T, DomainError>,
): Result<T, DomainError> {
  return parseAt(field(source, key), `${path}.${key}`, parse)
}

function oneOf<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): Result<T, DomainError> {
  for (const candidate of allowed) {
    if (value === candidate) return ok(candidate)
  }
  return invalid(`${path} must be one of: ${allowed.join(', ')}`)
}

function parseArray<T>(
  value: unknown,
  path: string,
  parseItem: (input: unknown, path: string) => Result<T, DomainError>,
): Result<readonly T[], DomainError> {
  if (!Array.isArray(value)) return invalid(`${path} must be an array`)
  const items: T[] = []
  for (let index = 0; index < value.length; index += 1) {
    const item: unknown = value[index]
    const parsed = parseItem(item, `${path}[${index}]`)
    if (!parsed.ok) return parsed
    items.push(parsed.value)
  }
  return ok(items)
}

function parseNonEmptyArray<T>(
  value: unknown,
  path: string,
  parseItem: (input: unknown, path: string) => Result<T, DomainError>,
): Result<NonEmptyArray<T>, DomainError> {
  const items = parseArray(value, path, parseItem)
  if (!items.ok) return items
  const [first, ...rest] = items.value
  if (first === undefined) return invalid(`${path} must not be empty`)
  const nonEmpty: NonEmptyArray<T> = [first, ...rest]
  return ok(nonEmpty)
}

/**
 * Validate the outer body, reject unexpected fields and check the optional `type`
 * literal. Every command parser starts here.
 */
function commandBody(
  input: unknown,
  command: CommandType,
  allowed: readonly string[],
): Result<object, DomainError> {
  const body = requireObject(input, `${command} body`)
  if (!body.ok) return body
  const unexpected = unexpectedKey(body.value, allowed)
  if (unexpected !== undefined) {
    return invalid(`${command} body has an unexpected field: ${unexpected}`)
  }
  const declaredType = field(body.value, 'type')
  if (declaredType !== undefined && declaredType !== command) {
    return invalid(`${command} body.type must be ${command}`)
  }
  return body
}

// ---------------------------------------------------------------------------
// Enum tables.
// ---------------------------------------------------------------------------

const ISSUE_LABELS: readonly IssueLabel[] = ['research', 'experiment', 'analysis', 'bug', 'blocked']
const ISSUE_RESOLUTIONS: readonly IssueResolution[] = ['accepted', 'rejected', 'abandoned']
const COMMENT_KINDS: readonly ('comment' | 'plan')[] = ['comment', 'plan']
const REVIEW_VERDICTS: readonly ('approve' | 'request-changes' | 'comment')[] = [
  'approve',
  'request-changes',
  'comment',
]
const ENVIRONMENT_KINDS: readonly ('uv-lock' | 'requirements')[] = ['uv-lock', 'requirements']

// ---------------------------------------------------------------------------
// program.create: contract, utility, exploration and budget.
// ---------------------------------------------------------------------------

const CREATE_PROGRAM_KEYS: readonly string[] = [
  'type',
  'name',
  'goal',
  'methodology',
  'contract',
  'utility',
  'exploration',
  'budget',
]
const CONTRACT_KEYS: readonly string[] = ['ciEntry', 'timeoutMs', 'requiredMetrics']
const UTILITY_KEYS: readonly string[] = ['metrics']
/**
 * `required` belongs to the raw DTO (`types/api.ts`); the domain derives requiredness
 * from `contract.requiredMetrics`, so the field is accepted and dropped here.
 */
const METRIC_DEFINITION_KEYS: readonly string[] = ['name', 'direction', 'weight', 'required']
const BUDGET_KEYS: readonly string[] = ['maxExperiments', 'maxComputeMinutes', 'maxTokens']

function parseContract(value: unknown, path: string): Result<EvaluationContract, DomainError> {
  const body = requireObject(value, path)
  if (!body.ok) return body
  const unexpected = unexpectedKey(body.value, CONTRACT_KEYS)
  if (unexpected !== undefined) return invalid(`${path}.${unexpected} is not a contract field`)

  const ciEntry = parseField(body.value, 'ciEntry', path, nonEmptyString)
  if (!ciEntry.ok) return ciEntry
  const timeoutMs = parseField(body.value, 'timeoutMs', path, durationMs)
  if (!timeoutMs.ok) return timeoutMs
  const requiredMetrics = parseNonEmptyArray(
    field(body.value, 'requiredMetrics'),
    `${path}.requiredMetrics`,
    metricName,
  )
  if (!requiredMetrics.ok) return requiredMetrics

  return ok<EvaluationContract>({
    ciEntry: ciEntry.value,
    timeoutMs: timeoutMs.value,
    requiredMetrics: requiredMetrics.value,
  })
}

function parseMetricDefinition(value: unknown, path: string): Result<MetricDefinition, DomainError> {
  const body = requireObject(value, path)
  if (!body.ok) return body
  const unexpected = unexpectedKey(body.value, METRIC_DEFINITION_KEYS)
  if (unexpected !== undefined) return invalid(`${path}.${unexpected} is not a metric definition field`)

  const name = parseField(body.value, 'name', path, metricName)
  if (!name.ok) return name
  const direction = parseField(body.value, 'direction', path, metricDirection)
  if (!direction.ok) return direction
  const weight = parseField(body.value, 'weight', path, positiveNumber)
  if (!weight.ok) return weight

  const required = field(body.value, 'required')
  if (required !== undefined && typeof required !== 'boolean') {
    return invalid(`${path}.required must be a boolean when present`)
  }

  return ok<MetricDefinition>({
    name: name.value,
    direction: direction.value,
    weight: weight.value,
  })
}

function parseUtility(value: unknown, path: string): Result<UtilityConfig, DomainError> {
  const body = requireObject(value, path)
  if (!body.ok) return body
  const unexpected = unexpectedKey(body.value, UTILITY_KEYS)
  if (unexpected !== undefined) return invalid(`${path}.${unexpected} is not a utility field`)

  const metrics = parseNonEmptyArray(
    field(body.value, 'metrics'),
    `${path}.metrics`,
    parseMetricDefinition,
  )
  if (!metrics.ok) return metrics
  return ok<UtilityConfig>({ metrics: metrics.value })
}

function parseBudget(value: unknown, path: string): Result<Budget, DomainError> {
  const body = requireObject(value, path)
  if (!body.ok) return body
  const unexpected = unexpectedKey(body.value, BUDGET_KEYS)
  if (unexpected !== undefined) return invalid(`${path}.${unexpected} is not a budget field`)

  const maxExperiments = parseField(body.value, 'maxExperiments', path, positiveInt)
  if (!maxExperiments.ok) return maxExperiments
  const maxComputeMinutes = parseField(body.value, 'maxComputeMinutes', path, positiveInt)
  if (!maxComputeMinutes.ok) return maxComputeMinutes
  const maxTokens = parseField(body.value, 'maxTokens', path, positiveInt)
  if (!maxTokens.ok) return maxTokens

  return ok<Budget>({
    maxExperiments: maxExperiments.value,
    maxComputeMinutes: maxComputeMinutes.value,
    maxTokens: maxTokens.value,
  })
}

function parseCreateProgram(input: unknown): Result<ModelCommandOf<'program.create'>, DomainError> {
  const path = 'program.create'
  const body = commandBody(input, path, CREATE_PROGRAM_KEYS)
  if (!body.ok) return body

  const name = parseField(body.value, 'name', path, nonEmptyString)
  if (!name.ok) return name
  const goal = parseField(body.value, 'goal', path, nonEmptyString)
  if (!goal.ok) return goal
  const methodology = parseField(body.value, 'methodology', path, nonEmptyString)
  if (!methodology.ok) return methodology
  const contract = parseAt(field(body.value, 'contract'), `${path}.contract`, (value) =>
    parseContract(value, `${path}.contract`),
  )
  if (!contract.ok) return contract
  const utility = parseAt(field(body.value, 'utility'), `${path}.utility`, (value) =>
    parseUtility(value, `${path}.utility`),
  )
  if (!utility.ok) return utility
  const exploration = parseField(body.value, 'exploration', path, explorationLevel)
  if (!exploration.ok) return exploration
  const budget = parseAt(field(body.value, 'budget'), `${path}.budget`, (value) =>
    parseBudget(value, `${path}.budget`),
  )
  if (!budget.ok) return budget

  return ok<ModelCommandOf<'program.create'>>({
    type: 'program.create',
    name: name.value,
    goal: goal.value,
    methodology: methodology.value,
    contract: contract.value,
    utility: utility.value,
    exploration: exploration.value,
    budget: budget.value,
  })
}

// ---------------------------------------------------------------------------
// program pause/resume/stop/set-goal/set-methodology/set-exploration.
// ---------------------------------------------------------------------------

function parsePauseProgram(input: unknown): Result<ModelCommandOf<'program.pause'>, DomainError> {
  const path = 'program.pause'
  const body = commandBody(input, path, ['type', 'programId'])
  if (!body.ok) return body
  const program = parseField(body.value, 'programId', path, programId)
  if (!program.ok) return program
  return ok<ModelCommandOf<'program.pause'>>({ type: 'program.pause', programId: program.value })
}

function parseResumeProgram(input: unknown): Result<ModelCommandOf<'program.resume'>, DomainError> {
  const path = 'program.resume'
  const body = commandBody(input, path, ['type', 'programId'])
  if (!body.ok) return body
  const program = parseField(body.value, 'programId', path, programId)
  if (!program.ok) return program
  return ok<ModelCommandOf<'program.resume'>>({ type: 'program.resume', programId: program.value })
}

function parseStopProgram(input: unknown): Result<ModelCommandOf<'program.stop'>, DomainError> {
  const path = 'program.stop'
  const body = commandBody(input, path, ['type', 'programId', 'reason'])
  if (!body.ok) return body
  const program = parseField(body.value, 'programId', path, programId)
  if (!program.ok) return program
  const reason = parseField(body.value, 'reason', path, nonEmptyString)
  if (!reason.ok) return reason
  return ok<ModelCommandOf<'program.stop'>>({
    type: 'program.stop',
    programId: program.value,
    reason: reason.value,
  })
}

function parseSetGoal(input: unknown): Result<ModelCommandOf<'program.set-goal'>, DomainError> {
  const path = 'program.set-goal'
  const body = commandBody(input, path, ['type', 'programId', 'goal'])
  if (!body.ok) return body
  const program = parseField(body.value, 'programId', path, programId)
  if (!program.ok) return program
  const goal = parseField(body.value, 'goal', path, nonEmptyString)
  if (!goal.ok) return goal
  return ok<ModelCommandOf<'program.set-goal'>>({
    type: 'program.set-goal',
    programId: program.value,
    goal: goal.value,
  })
}

function parseSetMethodology(
  input: unknown,
): Result<ModelCommandOf<'program.set-methodology'>, DomainError> {
  const path = 'program.set-methodology'
  const body = commandBody(input, path, ['type', 'programId', 'methodology'])
  if (!body.ok) return body
  const program = parseField(body.value, 'programId', path, programId)
  if (!program.ok) return program
  const methodology = parseField(body.value, 'methodology', path, nonEmptyString)
  if (!methodology.ok) return methodology
  return ok<ModelCommandOf<'program.set-methodology'>>({
    type: 'program.set-methodology',
    programId: program.value,
    methodology: methodology.value,
  })
}

function parseSetExploration(
  input: unknown,
): Result<ModelCommandOf<'program.set-exploration'>, DomainError> {
  const path = 'program.set-exploration'
  const body = commandBody(input, path, ['type', 'programId', 'level'])
  if (!body.ok) return body
  const program = parseField(body.value, 'programId', path, programId)
  if (!program.ok) return program
  const level = parseField(body.value, 'level', path, explorationLevel)
  if (!level.ok) return level
  return ok<ModelCommandOf<'program.set-exploration'>>({
    type: 'program.set-exploration',
    programId: program.value,
    level: level.value,
  })
}

// ---------------------------------------------------------------------------
// issue.create/claim/comment/close.
// ---------------------------------------------------------------------------

function parseIssueLabel(value: unknown, path: string): Result<IssueLabel, DomainError> {
  return oneOf(value, path, ISSUE_LABELS)
}

function parseCreateIssue(input: unknown): Result<ModelCommandOf<'issue.create'>, DomainError> {
  const path = 'issue.create'
  const body = commandBody(input, path, ['type', 'programId', 'title', 'body', 'labels'])
  if (!body.ok) return body
  const program = parseField(body.value, 'programId', path, programId)
  if (!program.ok) return program
  const title = parseField(body.value, 'title', path, nonEmptyString)
  if (!title.ok) return title
  const issueBody = parseField(body.value, 'body', path, nonEmptyString)
  if (!issueBody.ok) return issueBody
  const labels = parseNonEmptyArray(field(body.value, 'labels'), `${path}.labels`, parseIssueLabel)
  if (!labels.ok) return labels
  return ok<ModelCommandOf<'issue.create'>>({
    type: 'issue.create',
    programId: program.value,
    title: title.value,
    body: issueBody.value,
    labels: labels.value,
  })
}

function parseClaimIssue(input: unknown): Result<ModelCommandOf<'issue.claim'>, DomainError> {
  const path = 'issue.claim'
  const body = commandBody(input, path, ['type', 'programId', 'issueId'])
  if (!body.ok) return body
  const program = parseField(body.value, 'programId', path, programId)
  if (!program.ok) return program
  const issue = parseField(body.value, 'issueId', path, issueId)
  if (!issue.ok) return issue
  return ok<ModelCommandOf<'issue.claim'>>({
    type: 'issue.claim',
    programId: program.value,
    issueId: issue.value,
  })
}

function parseCommentOnIssue(
  input: unknown,
): Result<ModelCommandOf<'issue.comment'>, DomainError> {
  const path = 'issue.comment'
  const body = commandBody(input, path, ['type', 'programId', 'issueId', 'body', 'kind'])
  if (!body.ok) return body
  const program = parseField(body.value, 'programId', path, programId)
  if (!program.ok) return program
  const issue = parseField(body.value, 'issueId', path, issueId)
  if (!issue.ok) return issue
  const commentBody = parseField(body.value, 'body', path, nonEmptyString)
  if (!commentBody.ok) return commentBody
  const kind = parseField(body.value, 'kind', path, (value) =>
    oneOf(value, `${path}.kind`, COMMENT_KINDS),
  )
  if (!kind.ok) return kind
  return ok<ModelCommandOf<'issue.comment'>>({
    type: 'issue.comment',
    programId: program.value,
    issueId: issue.value,
    body: commentBody.value,
    kind: kind.value,
  })
}

function parseCloseIssue(input: unknown): Result<ModelCommandOf<'issue.close'>, DomainError> {
  const path = 'issue.close'
  const body = commandBody(input, path, [
    'type',
    'programId',
    'issueId',
    'resolution',
    'summary',
  ])
  if (!body.ok) return body
  const program = parseField(body.value, 'programId', path, programId)
  if (!program.ok) return program
  const issue = parseField(body.value, 'issueId', path, issueId)
  if (!issue.ok) return issue
  const resolution = parseField(body.value, 'resolution', path, (value) =>
    oneOf(value, `${path}.resolution`, ISSUE_RESOLUTIONS),
  )
  if (!resolution.ok) return resolution
  const summary = parseField(body.value, 'summary', path, nonEmptyString)
  if (!summary.ok) return summary
  return ok<ModelCommandOf<'issue.close'>>({
    type: 'issue.close',
    programId: program.value,
    issueId: issue.value,
    resolution: resolution.value,
    summary: summary.value,
  })
}

// ---------------------------------------------------------------------------
// Environment declarations, experiment plans and artifact inputs.
// ---------------------------------------------------------------------------

const UV_LOCK_KEYS: readonly string[] = ['kind', 'lockFile', 'pythonVersion']
const REQUIREMENTS_KEYS: readonly string[] = ['kind', 'requirementsFile', 'pythonVersion']
const EXPERIMENT_PLAN_KEYS: readonly string[] = [
  'hypothesis',
  'steps',
  'expected',
  'environment',
  'inputs',
]
const EXPECTED_KEYS: readonly string[] = ['direction', 'rationale']
const ARTIFACT_INPUT_KEYS: readonly string[] = ['artifactId', 'mountAs']

function parseEnvironment(value: unknown, path: string): Result<EnvironmentDeclaration, DomainError> {
  const body = requireObject(value, path)
  if (!body.ok) return body

  const kind = parseAt(field(body.value, 'kind'), `${path}.kind`, (candidate) =>
    oneOf(candidate, `${path}.kind`, ENVIRONMENT_KINDS),
  )
  if (!kind.ok) return kind

  const allowed = kind.value === 'uv-lock' ? UV_LOCK_KEYS : REQUIREMENTS_KEYS
  const unexpected = unexpectedKey(body.value, allowed)
  if (unexpected !== undefined) {
    return invalid(`${path}.${unexpected} is not a field of an ${kind.value} environment`)
  }

  const fileKey = kind.value === 'uv-lock' ? 'lockFile' : 'requirementsFile'
  const file = parseField(body.value, fileKey, path, nonEmptyString)
  if (!file.ok) return file
  const pythonVersion = parseField(body.value, 'pythonVersion', path, nonEmptyString)
  if (!pythonVersion.ok) return pythonVersion

  if (kind.value === 'uv-lock') {
    return ok<EnvironmentDeclaration>({
      kind: 'uv-lock',
      lockFile: file.value,
      pythonVersion: pythonVersion.value,
    })
  }
  return ok<EnvironmentDeclaration>({
    kind: 'requirements',
    requirementsFile: file.value,
    pythonVersion: pythonVersion.value,
  })
}

function parseArtifactInput(value: unknown, path: string): Result<ArtifactInput, DomainError> {
  const body = requireObject(value, path)
  if (!body.ok) return body
  const unexpected = unexpectedKey(body.value, ARTIFACT_INPUT_KEYS)
  if (unexpected !== undefined) return invalid(`${path}.${unexpected} is not an artifact input field`)

  const id = parseField(body.value, 'artifactId', path, artifactId)
  if (!id.ok) return id
  const mountAs = parseField(body.value, 'mountAs', path, nonEmptyString)
  if (!mountAs.ok) return mountAs
  return ok<ArtifactInput>({ artifactId: id.value, mountAs: mountAs.value })
}

function parseExpectedOutcome(
  value: unknown,
  path: string,
): Result<ExperimentPlan['expected'], DomainError> {
  const body = requireObject(value, path)
  if (!body.ok) return body
  const unexpected = unexpectedKey(body.value, EXPECTED_KEYS)
  if (unexpected !== undefined) return invalid(`${path}.${unexpected} is not an expected-outcome field`)

  const direction = parseField(body.value, 'direction', path, metricDirection)
  if (!direction.ok) return direction
  const rationale = parseField(body.value, 'rationale', path, nonEmptyString)
  if (!rationale.ok) return rationale
  return ok<ExperimentPlan['expected']>({
    direction: direction.value,
    rationale: rationale.value,
  })
}

function parseExperimentPlan(value: unknown, path: string): Result<ExperimentPlan, DomainError> {
  const body = requireObject(value, path)
  if (!body.ok) return body
  const unexpected = unexpectedKey(body.value, EXPERIMENT_PLAN_KEYS)
  if (unexpected !== undefined) return invalid(`${path}.${unexpected} is not a plan field`)

  const hypothesis = parseField(body.value, 'hypothesis', path, nonEmptyString)
  if (!hypothesis.ok) return hypothesis
  const steps = parseNonEmptyArray(
    field(body.value, 'steps'),
    `${path}.steps`,
    (step, stepPath) => parseAt(step, stepPath, nonEmptyString),
  )
  if (!steps.ok) return steps
  const expected = parseAt(field(body.value, 'expected'), `${path}.expected`, (candidate) =>
    parseExpectedOutcome(candidate, `${path}.expected`),
  )
  if (!expected.ok) return expected
  const environment = parseAt(field(body.value, 'environment'), `${path}.environment`, (candidate) =>
    parseEnvironment(candidate, `${path}.environment`),
  )
  if (!environment.ok) return environment
  const inputs = parseArray(field(body.value, 'inputs'), `${path}.inputs`, parseArtifactInput)
  if (!inputs.ok) return inputs

  return ok<ExperimentPlan>({
    hypothesis: hypothesis.value,
    steps: steps.value,
    expected: expected.value,
    environment: environment.value,
    inputs: inputs.value,
  })
}

// ---------------------------------------------------------------------------
// experiment.propose/review/close, ci.request and ticket.submit.
// ---------------------------------------------------------------------------

function parseProposeExperiment(
  input: unknown,
): Result<ModelCommandOf<'experiment.propose'>, DomainError> {
  const path = 'experiment.propose'
  const body = commandBody(input, path, ['type', 'programId', 'issueId', 'plan'])
  if (!body.ok) return body
  const program = parseField(body.value, 'programId', path, programId)
  if (!program.ok) return program
  const issue = parseField(body.value, 'issueId', path, issueId)
  if (!issue.ok) return issue
  const plan = parseAt(field(body.value, 'plan'), `${path}.plan`, (candidate) =>
    parseExperimentPlan(candidate, `${path}.plan`),
  )
  if (!plan.ok) return plan
  return ok<ModelCommandOf<'experiment.propose'>>({
    type: 'experiment.propose',
    programId: program.value,
    issueId: issue.value,
    plan: plan.value,
  })
}

function parseReviewExperiment(
  input: unknown,
): Result<ModelCommandOf<'experiment.review'>, DomainError> {
  const path = 'experiment.review'
  const body = commandBody(input, path, [
    'type',
    'programId',
    'experimentId',
    'body',
    'verdict',
  ])
  if (!body.ok) return body
  const program = parseField(body.value, 'programId', path, programId)
  if (!program.ok) return program
  const experiment = parseField(body.value, 'experimentId', path, experimentId)
  if (!experiment.ok) return experiment
  const reviewBody = parseField(body.value, 'body', path, nonEmptyString)
  if (!reviewBody.ok) return reviewBody
  const verdict = parseField(body.value, 'verdict', path, (value) =>
    oneOf(value, `${path}.verdict`, REVIEW_VERDICTS),
  )
  if (!verdict.ok) return verdict
  return ok<ModelCommandOf<'experiment.review'>>({
    type: 'experiment.review',
    programId: program.value,
    experimentId: experiment.value,
    body: reviewBody.value,
    verdict: verdict.value,
  })
}

function parseCloseExperiment(
  input: unknown,
): Result<ModelCommandOf<'experiment.close'>, DomainError> {
  const path = 'experiment.close'
  const body = commandBody(input, path, ['type', 'programId', 'experimentId', 'reason'])
  if (!body.ok) return body
  const program = parseField(body.value, 'programId', path, programId)
  if (!program.ok) return program
  const experiment = parseField(body.value, 'experimentId', path, experimentId)
  if (!experiment.ok) return experiment
  const reason = parseField(body.value, 'reason', path, nonEmptyString)
  if (!reason.ok) return reason
  return ok<ModelCommandOf<'experiment.close'>>({
    type: 'experiment.close',
    programId: program.value,
    experimentId: experiment.value,
    reason: reason.value,
  })
}

function parseRequestCI(input: unknown): Result<ModelCommandOf<'ci.request'>, DomainError> {
  const path = 'ci.request'
  const body = commandBody(input, path, ['type', 'programId', 'experimentId'])
  if (!body.ok) return body
  const program = parseField(body.value, 'programId', path, programId)
  if (!program.ok) return program
  const experiment = parseField(body.value, 'experimentId', path, experimentId)
  if (!experiment.ok) return experiment
  return ok<ModelCommandOf<'ci.request'>>({
    type: 'ci.request',
    programId: program.value,
    experimentId: experiment.value,
  })
}

function parseSubmitImplementation(
  input: unknown,
): Result<ModelCommandOf<'ticket.submit'>, DomainError> {
  const path = 'ticket.submit'
  const body = commandBody(input, path, ['type', 'head', 'environment'])
  if (!body.ok) return body
  const head = parseField(body.value, 'head', path, commitSha)
  if (!head.ok) return head
  const environment = parseAt(field(body.value, 'environment'), `${path}.environment`, (candidate) =>
    parseEnvironment(candidate, `${path}.environment`),
  )
  if (!environment.ok) return environment
  return ok<ModelCommandOf<'ticket.submit'>>({
    type: 'ticket.submit',
    head: head.value,
    environment: environment.value,
  })
}

// ---------------------------------------------------------------------------
// The table. It is total over `CommandType`: a new command fails to compile here.
// ---------------------------------------------------------------------------

/** The write-route parser table; one entry per `CommandType`. */
export const COMMAND_PARSERS: CommandParsers = {
  'program.create': parseCreateProgram,
  'program.pause': parsePauseProgram,
  'program.resume': parseResumeProgram,
  'program.stop': parseStopProgram,
  'program.set-goal': parseSetGoal,
  'program.set-methodology': parseSetMethodology,
  'program.set-exploration': parseSetExploration,
  'issue.create': parseCreateIssue,
  'issue.claim': parseClaimIssue,
  'issue.comment': parseCommentOnIssue,
  'issue.close': parseCloseIssue,
  'experiment.propose': parseProposeExperiment,
  'experiment.review': parseReviewExperiment,
  'experiment.close': parseCloseExperiment,
  'ci.request': parseRequestCI,
  'ticket.submit': parseSubmitImplementation,
}

/** Parse one untrusted body with the parser selected by the command literal. */
export function parseCommand<K extends CommandType>(
  command: K,
  input: unknown,
): Result<ModelCommandOf<K>, DomainError> {
  return COMMAND_PARSERS[command](input)
}
