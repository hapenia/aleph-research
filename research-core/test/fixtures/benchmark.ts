import type {
  BenchmarkRecord,
  BenchmarkSpec,
  MetricSpec,
  ResearchPolicy,
} from '../../src/benchmark.js'
import type { DomainError, Err, Result } from '../../src/types/errors.js'
import type { CommitSha, ExperimentId, NonEmptyString, TicketId } from '../../src/types/ids.js'
import type { MetricDirection } from '../../src/types/metrics.js'
import {
  affordError,
  attemptAllowed,
  recordUsage,
  type Usage,
  type UsageDelta,
} from './policy.js'

export type BenchmarkStatus = 'passed' | 'failed' | 'retryable'

export interface BenchmarkContract {
  readonly specHash: string
  readonly environmentDigest: string
}

export interface MetricSpecInput {
  readonly name: string
  readonly direction: MetricDirection
  readonly required: boolean
  readonly tolerance?: number
}

export interface BenchmarkSpecInput {
  readonly id: string
  readonly entry: string
  readonly timeoutMs: number
  readonly metrics: readonly MetricSpecInput[]
  readonly maxRetries: number
  readonly baseline?: Readonly<Record<string, number>>
  readonly dataset?: string
}

export interface BenchmarkOutcome {
  readonly status: BenchmarkStatus
  readonly metrics: Readonly<Record<string, number>>
  readonly artifacts: readonly string[]
  readonly stdout: string
  readonly stderr: string
  readonly reason?: string
}

export interface LabBenchmarkRecord extends BenchmarkRecord {
  readonly status: BenchmarkStatus
  readonly attempt: number
  readonly maxAttempts: number
  readonly stdout: string
  readonly stderr: string
  readonly reason?: string
}

export interface BenchmarkFiles {
  readonly root: string
  list(): readonly string[]
  read(path: string): Result<string, DomainError>
  write(path: string, content: string): Result<void, DomainError>
}

export interface BenchmarkAttempt {
  readonly spec: BenchmarkSpec
  readonly specHash: string
  readonly environmentDigest: string
  readonly experimentId: ExperimentId
  readonly ticketId: TicketId
  readonly commit: CommitSha
  readonly attempt: number
  readonly maxAttempts: number
}

export interface FakeBenchmarkOptions {
  readonly spec: BenchmarkSpec
  readonly contract: BenchmarkContract
  readonly files: BenchmarkFiles
  readonly outcomes: readonly BenchmarkOutcome[]
  readonly policy: ResearchPolicy
  readonly usage: Usage
  readonly perAttempt: UsageDelta
}

export interface FakeBenchmark {
  run(input: BenchmarkAttempt): Promise<Result<BenchmarkOutcome, DomainError>>
  readonly attempts: readonly BenchmarkAttempt[]
  readonly results: readonly BenchmarkOutcome[]
}

function invalid(message: string): Err<DomainError> {
  return {
    ok: false,
    error: { code: 'invalid-input', message: message as NonEmptyString },
  }
}

function forbidden(message: string): Err<DomainError> {
  return {
    ok: false,
    error: { code: 'forbidden', message: message as NonEmptyString },
  }
}

function notFound(message: string): Err<DomainError> {
  return {
    ok: false,
    error: { code: 'not-found', message: message as NonEmptyString },
  }
}

function environmentInvalid(message: string): Err<DomainError> {
  return {
    ok: false,
    error: { code: 'environment-invalid', message: message as NonEmptyString },
  }
}

function budget(message: string): Err<DomainError> {
  return {
    ok: false,
    error: { code: 'budget-exhausted', message: message as NonEmptyString },
  }
}

function isNonEmpty(value: string): boolean {
  return value.trim().length > 0
}

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value)
}

function freezeMetric(metric: MetricSpecInput): MetricSpec {
  return Object.freeze({
    name: metric.name,
    direction: metric.direction,
    required: metric.required,
    ...(metric.tolerance === undefined ? {} : { tolerance: metric.tolerance }),
  })
}

export function createBenchmarkSpec(input: BenchmarkSpecInput): Result<BenchmarkSpec, DomainError> {
  if (!isNonEmpty(input.id)) {
    return invalid('benchmark spec id must not be empty')
  }
  if (!isNonEmpty(input.entry)) {
    return invalid('benchmark entry must not be empty')
  }
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    return invalid('benchmark timeoutMs must be a positive integer')
  }
  if (!Number.isInteger(input.maxRetries) || input.maxRetries < 0) {
    return invalid('benchmark maxRetries must be a non-negative integer')
  }
  if (input.dataset !== undefined && !isNonEmpty(input.dataset)) {
    return invalid('benchmark dataset must not be empty')
  }
  if (input.metrics.length === 0) {
    return invalid('benchmark spec needs at least one metric')
  }
  const names = new Set<string>()
  for (const metric of input.metrics) {
    if (!isNonEmpty(metric.name)) {
      return invalid('benchmark metric name must not be empty')
    }
    if (names.has(metric.name)) {
      return invalid(`duplicate benchmark metric: ${metric.name}`)
    }
    names.add(metric.name)
    if (metric.direction !== 'higher' && metric.direction !== 'lower') {
      return invalid(`invalid metric direction: ${String(metric.direction)}`)
    }
    if (metric.tolerance !== undefined && (!isFiniteNumber(metric.tolerance) || metric.tolerance < 0)) {
      return invalid(`invalid tolerance for metric: ${metric.name}`)
    }
  }
  const baseline = input.baseline
  if (baseline !== undefined) {
    for (const [name, value] of Object.entries(baseline)) {
      if (!names.has(name)) {
        return invalid(`baseline names an unknown metric: ${name}`)
      }
      if (!isFiniteNumber(value)) {
        return invalid(`baseline value is not finite: ${name}`)
      }
    }
  }
  const metrics = Object.freeze(input.metrics.map((metric) => freezeMetric(metric)))
  const frozenBaseline = baseline === undefined ? undefined : Object.freeze({ ...baseline })
  return {
    ok: true,
    value: Object.freeze({
      id: input.id,
      entry: input.entry,
      timeoutMs: input.timeoutMs,
      metrics,
      maxRetries: input.maxRetries,
      ...(frozenBaseline === undefined ? {} : { baseline: frozenBaseline }),
      ...(input.dataset === undefined ? {} : { dataset: input.dataset }),
    }),
  }
}

function canonicalSpec(spec: BenchmarkSpec): string {
  const metrics = spec.metrics.map((metric) =>
    [
      metric.name,
      metric.direction,
      metric.required ? 'required' : 'optional',
      metric.tolerance === undefined ? '' : String(metric.tolerance),
    ].join(':'),
  )
  const baseline =
    spec.baseline === undefined
      ? []
      : Object.keys(spec.baseline)
          .sort()
          .map((name) => `${name}=${String(spec.baseline?.[name] ?? '')}`)
  return [
    `id=${spec.id}`,
    `entry=${spec.entry}`,
    `timeout=${spec.timeoutMs}`,
    `retries=${spec.maxRetries}`,
    `dataset=${spec.dataset ?? ''}`,
    `metrics=${metrics.join(';')}`,
    `baseline=${baseline.join(',')}`,
  ].join('|')
}

const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n

function hashText(value: string): string {
  let hash = FNV_OFFSET
  for (const character of value) {
    hash ^= BigInt(character.codePointAt(0) ?? 0)
    hash = BigInt.asUintN(64, hash * FNV_PRIME)
  }
  return hash.toString(16).padStart(16, '0')
}

export function hashBenchmarkSpec(spec: BenchmarkSpec): string {
  return `fnv1a64:${hashText(canonicalSpec(spec))}`
}

export function createReadOnlyBenchmarkFiles(
  root: string,
  files: Readonly<Record<string, string>>,
): BenchmarkFiles {
  const contents = new Map<string, string>(Object.entries(files))
  return Object.freeze({
    root,
    list: (): readonly string[] => [...contents.keys()].sort(),
    read: (path: string): Result<string, DomainError> => {
      const content = contents.get(path)
      if (content === undefined) {
        return notFound(`benchmark file not found: ${path}`)
      }
      return { ok: true, value: content }
    },
    write: (path: string): Result<void, DomainError> =>
      forbidden(`benchmark file is read-only: ${path}`),
  })
}

function finiteMetrics(metrics: Readonly<Record<string, number>>): Result<void, DomainError> {
  for (const [name, value] of Object.entries(metrics)) {
    if (!isFiniteNumber(value)) {
      return invalid(`non-finite metric: ${name}`)
    }
  }
  return { ok: true, value: undefined }
}

export function validateMetrics(
  spec: BenchmarkSpec,
  metrics: Readonly<Record<string, number>>,
): Result<void, DomainError> {
  for (const metric of spec.metrics) {
    if (!metric.required) {
      continue
    }
    if (metrics[metric.name] === undefined) {
      return invalid(`missing required metric: ${metric.name}`)
    }
  }
  return finiteMetrics(metrics)
}

function defaultOutcome(spec: BenchmarkSpec): BenchmarkOutcome {
  const metrics: Record<string, number> = {}
  for (const metric of spec.metrics) {
    if (metric.required) {
      metrics[metric.name] = 0
    }
  }
  return {
    status: 'passed',
    metrics: Object.freeze(metrics),
    artifacts: Object.freeze([]),
    stdout: 'benchmark passed',
    stderr: '',
  }
}

function normalizeOutcome(spec: BenchmarkSpec, outcome: BenchmarkOutcome): BenchmarkOutcome {
  const finite = finiteMetrics(outcome.metrics)
  if (!finite.ok) {
    return Object.freeze({
      status: 'failed',
      metrics: Object.freeze({ ...outcome.metrics }),
      artifacts: Object.freeze([...outcome.artifacts]),
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      reason: finite.error.message,
    })
  }
  if (outcome.status === 'passed') {
    const required = validateMetrics(spec, outcome.metrics)
    if (!required.ok) {
      return Object.freeze({
        status: 'failed',
        metrics: Object.freeze({ ...outcome.metrics }),
        artifacts: Object.freeze([...outcome.artifacts]),
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        reason: required.error.message,
      })
    }
  }
  return Object.freeze({
    status: outcome.status,
    metrics: Object.freeze({ ...outcome.metrics }),
    artifacts: Object.freeze([...outcome.artifacts]),
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
  })
}

export function createFakeBenchmark(options: FakeBenchmarkOptions): FakeBenchmark {
  const attempts: BenchmarkAttempt[] = []
  const results: BenchmarkOutcome[] = []
  const queue = [...options.outcomes]
  return {
    attempts,
    results,
    async run(input: BenchmarkAttempt): Promise<Result<BenchmarkOutcome, DomainError>> {
      attempts.push(input)
      const actualSpecHash = hashBenchmarkSpec(options.spec)
      if (input.specHash !== actualSpecHash || options.contract.specHash !== actualSpecHash) {
        return invalid(
          `benchmark spec hash mismatch: expected ${options.contract.specHash}, computed ${actualSpecHash}`,
        )
      }
      if (input.environmentDigest !== options.contract.environmentDigest) {
        return environmentInvalid(
          `benchmark environment digest mismatch: expected ${options.contract.environmentDigest}, built ${input.environmentDigest}`,
        )
      }
      const entry = options.files.read(options.spec.entry)
      if (!entry.ok) {
        return entry
      }
      if (!attemptAllowed(options.policy, input.attempt)) {
        return budget(`attempt budget exhausted at attempt ${input.attempt}`)
      }
      const affordable = affordError(options.policy, options.usage, options.perAttempt)
      if (!affordable.ok) {
        return affordable
      }
      const outcome = normalizeOutcome(options.spec, queue.shift() ?? defaultOutcome(options.spec))
      recordUsage(options.usage, options.perAttempt)
      results.push(outcome)
      return { ok: true, value: outcome }
    },
  }
}

export function createBenchmarkRecord(input: {
  readonly id: string
  readonly attempt: BenchmarkAttempt
  readonly outcome: BenchmarkOutcome
  readonly now: string
}): LabBenchmarkRecord {
  const record: LabBenchmarkRecord = {
    id: input.id,
    experimentId: input.attempt.experimentId,
    ticketId: input.attempt.ticketId,
    commit: input.attempt.commit,
    specHash: input.attempt.specHash,
    environmentDigest: input.attempt.environmentDigest,
    metrics: Object.freeze({ ...input.outcome.metrics }),
    passed: input.outcome.status === 'passed',
    artifacts: Object.freeze([...input.outcome.artifacts]),
    createdAt: input.now,
    status: input.outcome.status,
    attempt: input.attempt.attempt,
    maxAttempts: input.attempt.maxAttempts,
    stdout: input.outcome.stdout,
    stderr: input.outcome.stderr,
    ...(input.outcome.reason === undefined ? {} : { reason: input.outcome.reason }),
  }
  return Object.freeze(record)
}
