/**
 * In-memory reference implementation of the Host storage ports.
 *
 * The module implements `UnitOfWork` (every repository plus the audit log and the
 * transaction) and `ReadModel` over one shared state object. It is the runtime evidence
 * for the storage rows of `docs/runtime-safety-contract.md`:
 *
 * - every aggregate read is a `Versioned<T>` and `save` compares the expected version, so
 *   a lost update is a `version-conflict` `StoreError` instead of a silent overwrite;
 * - stored values are deep copies; a caller that keeps a reference to what it saved (or
 *   to what it read) cannot mutate the store, and a read cannot mutate the value another
 *   read returns;
 * - every CI record is persisted, failures included; a passed record with a metric that
 *   is not a finite number is refused as `corrupt` before it enters the store;
 * - `listPassed` and the metric summaries of `query` only consider passed records that
 *   carry every required metric with a finite value, and summaries are computed at query
 *   time, never stored;
 * - `transaction` snapshots every map and array and restores the snapshot when the work
 *   throws, so a failed command does not leave partial writes behind.
 *
 * Values are plain data records. The nominal state classes in `src/types/` are
 * declaration-only in Phase 1; storage therefore neither constructs nor validates them
 * beyond the CI metric rule, and the factory/hydration boundary owns shape validation.
 */
import type { ProgramSnapshot } from '../types/api.js'
import type { ArtifactRef } from '../types/artifacts.js'
import type { Attention } from '../types/attention.js'
import type { AuditEntry, AuditLog } from '../types/audit.js'
import type { DomainError, Err, Ok, Result, StoreError } from '../types/errors.js'
import type { Experiment, ExperimentReview } from '../types/experiment.js'
import type {
  ArtifactId,
  CIRunId,
  ExperimentId,
  IssueId,
  MetricName,
  NonEmptyString,
  ProgramId,
  ResearcherSessionId,
  TicketId,
  Version,
} from '../types/ids.js'
import type { Issue, IssueComment } from '../types/issue.js'
import type {
  CIRecord,
  MetricMap,
  MetricQuery,
  MetricQueryResult,
  MetricSort,
  MetricSummary,
  PassedCIRecord,
} from '../types/metrics.js'
import type { Program } from '../types/program.js'
import type {
  ArtifactRepository,
  AttentionRepository,
  CIRecordRepository,
  ExperimentRepository,
  IssueRepository,
  ProgramRepository,
  ReadModel,
  TicketRepository,
  UnitOfWork,
  Versioned,
} from '../types/storage.js'
import type { Ticket } from '../types/ticket.js'

/** The aggregate a versioned record can be keyed by. */
interface Identified {
  readonly id: string
}

/** The aggregate rows the in-memory store holds for one program universe. */
interface StoreState {
  programs: Map<string, Versioned<Program>>
  issues: Map<string, Versioned<Issue>>
  comments: Map<string, readonly IssueComment[]>
  experiments: Map<string, Versioned<Experiment>>
  reviews: Map<string, readonly ExperimentReview[]>
  ciRecords: Map<string, CIRecord>
  tickets: Map<string, Versioned<Ticket>>
  artifacts: Map<string, ArtifactRef>
  attention: readonly Attention[]
  audit: readonly AuditEntry[]
}

/** One in-memory store that is both the write unit of work and the panel read model. */
export interface InMemoryStore extends UnitOfWork, ReadModel {}

/** The version a caller passes for the first save of an aggregate. */
export const INITIAL_VERSION: Version = toVersion(0)

/**
 * Create one isolated in-memory store.
 *
 * Every call creates a fresh state, so tests and the adapter's per-test composition get
 * independent stores. The returned object can be used as a `UnitOfWork` (the executor
 * ports) and as the `ReadModel` (the panel) at the same time.
 */
export function createInMemoryStore(): InMemoryStore {
  const state: StoreState = {
    programs: new Map<string, Versioned<Program>>(),
    issues: new Map<string, Versioned<Issue>>(),
    comments: new Map<string, readonly IssueComment[]>(),
    experiments: new Map<string, Versioned<Experiment>>(),
    reviews: new Map<string, readonly ExperimentReview[]>(),
    ciRecords: new Map<string, CIRecord>(),
    tickets: new Map<string, Versioned<Ticket>>(),
    artifacts: new Map<string, ArtifactRef>(),
    attention: [],
    audit: [],
  }

  const programs: ProgramRepository = {
    get(id: ProgramId): Promise<Versioned<Program> | undefined> {
      return resolved(readVersioned(state.programs, id))
    },
    list(): Promise<readonly Versioned<Program>[]> {
      return resolved(listVersioned(state.programs))
    },
    save(expected: Version, next: Program): Promise<Result<Version, StoreError>> {
      return resolved(saveVersioned(state.programs, expected, next))
    },
  }

  const issues: IssueRepository = {
    get(id: IssueId): Promise<Versioned<Issue> | undefined> {
      return resolved(readVersioned(state.issues, id))
    },
    listByProgram(programId: ProgramId): Promise<readonly Issue[]> {
      const result: Issue[] = []
      for (const stored of state.issues.values()) {
        if (stored.value.programId === programId) result.push(copy(stored.value))
      }
      return resolved(result)
    },
    listAssignedTo(assignee: ResearcherSessionId): Promise<readonly Issue[]> {
      const result: Issue[] = []
      for (const stored of state.issues.values()) {
        const issue = stored.value
        if (issue.status !== 'assigned') continue
        if (issue.assignee.sessionId === assignee) result.push(copy(issue))
      }
      return resolved(result)
    },
    save(expected: Version, next: Issue): Promise<Result<Version, StoreError>> {
      return resolved(saveVersioned(state.issues, expected, next))
    },
    comments(issueId: IssueId): Promise<readonly IssueComment[]> {
      return resolved(copyList(state.comments.get(issueId)))
    },
    appendComment(comment: IssueComment): Promise<Result<void, StoreError>> {
      appendToMap(state.comments, comment.issueId, copy(comment))
      return resolved(okVoid())
    },
  }

  const experiments: ExperimentRepository = {
    get(id: ExperimentId): Promise<Versioned<Experiment> | undefined> {
      return resolved(readVersioned(state.experiments, id))
    },
    listByProgram(programId: ProgramId): Promise<readonly Experiment[]> {
      const result: Experiment[] = []
      for (const stored of state.experiments.values()) {
        if (stored.value.programId === programId) result.push(copy(stored.value))
      }
      return resolved(result)
    },
    listByIssue(issueId: IssueId): Promise<readonly Experiment[]> {
      const result: Experiment[] = []
      for (const stored of state.experiments.values()) {
        if (stored.value.issueId === issueId) result.push(copy(stored.value))
      }
      return resolved(result)
    },
    save(expected: Version, next: Experiment): Promise<Result<Version, StoreError>> {
      return resolved(saveVersioned(state.experiments, expected, next))
    },
    reviews(experimentId: ExperimentId): Promise<readonly ExperimentReview[]> {
      return resolved(copyList(state.reviews.get(experimentId)))
    },
    appendReview(review: ExperimentReview): Promise<Result<void, StoreError>> {
      appendToMap(state.reviews, review.experimentId, copy(review))
      return resolved(okVoid())
    },
  }

  const ciRecords: CIRecordRepository = {
    get(id: CIRunId): Promise<CIRecord | undefined> {
      const record = state.ciRecords.get(id)
      return resolved(record === undefined ? undefined : copy(record))
    },
    listByExperiment(experimentId: ExperimentId): Promise<readonly CIRecord[]> {
      const result: CIRecord[] = []
      for (const record of state.ciRecords.values()) {
        if (record.experimentId === experimentId) result.push(copy(record))
      }
      return resolved(result)
    },
    listPassed(programId: ProgramId): Promise<readonly PassedCIRecord[]> {
      const required = requiredMetricsOf(state.programs.get(programId))
      const result: PassedCIRecord[] = []
      for (const record of state.ciRecords.values()) {
        if (record.programId !== programId) continue
        if (record.status !== 'passed') continue
        if (!isUsablePassed(record, required)) continue
        result.push(copy(record))
      }
      return resolved(result)
    },
    query(query: MetricQuery): Promise<MetricQueryResult> {
      const matched: CIRecord[] = []
      for (const record of state.ciRecords.values()) {
        if (record.programId !== query.programId) continue
        if (query.experimentId !== undefined && record.experimentId !== query.experimentId) continue
        matched.push(record)
      }

      const sorted = sortRecords(matched, query.sort)
      const required = requiredMetricsOf(state.programs.get(query.programId))
      const summaries = query.aggregate === undefined
        ? []
        : summarize(usablePassed(sorted, required), query.aggregate)
      const rows = applyLimit(sorted, query.limit).map((record) => copy(record))
      return resolved({ rows, summaries })
    },
    append(record: CIRecord): Promise<Result<void, StoreError>> {
      const refusal = validateCIRecord(record)
      if (refusal !== null) return resolved(refusal)
      // A later snapshot of the same run (requested -> running -> passed/failed) replaces
      // the previous one: the run id identifies the run, the record is its current state.
      state.ciRecords.set(record.id, copy(record))
      return resolved(okVoid())
    },
  }

  const tickets: TicketRepository = {
    get(ticketId: TicketId): Promise<Versioned<Ticket> | undefined> {
      return resolved(readVersioned(state.tickets, ticketId))
    },
    listByExperiment(experimentId: ExperimentId): Promise<readonly Ticket[]> {
      const result: Ticket[] = []
      for (const stored of state.tickets.values()) {
        if (stored.value.experimentId === experimentId) result.push(copy(stored.value))
      }
      return resolved(result)
    },
    save(expected: Version, next: Ticket): Promise<Result<Version, StoreError>> {
      return resolved(saveVersioned(state.tickets, expected, next))
    },
  }

  const artifacts: ArtifactRepository = {
    get(id: ArtifactId): Promise<ArtifactRef | undefined> {
      const ref = state.artifacts.get(id)
      return resolved(ref === undefined ? undefined : copy(ref))
    },
    listByExperiment(experimentId: ExperimentId): Promise<readonly ArtifactRef[]> {
      const result: ArtifactRef[] = []
      for (const ref of state.artifacts.values()) {
        if (ref.experimentId === experimentId) result.push(copy(ref))
      }
      return resolved(result)
    },
    append(ref: ArtifactRef): Promise<Result<void, StoreError>> {
      // Artifacts are content-addressed: the id is the address, so a repeated append is
      // the same artifact and must not create a second row.
      state.artifacts.set(ref.id, copy(ref))
      return resolved(okVoid())
    },
  }

  const attention: AttentionRepository = {
    listByProgram(programId: ProgramId): Promise<readonly Attention[]> {
      const result: Attention[] = []
      for (const entry of state.attention) {
        if (!attentionBelongsToProgram(state, entry, programId)) continue
        result.push(copy(entry))
      }
      return resolved(result)
    },
    append(entry: Attention): Promise<Result<void, StoreError>> {
      state.attention = [...state.attention, copy(entry)]
      return resolved(okVoid())
    },
  }

  const audit: AuditLog = {
    append(entries: readonly AuditEntry[]): Promise<void> {
      state.audit = [...state.audit, ...entries.map((entry) => copy(entry))]
      return Promise.resolve()
    },
    list(programId: ProgramId, limit: number): Promise<readonly AuditEntry[]> {
      const matching: AuditEntry[] = []
      for (const entry of state.audit) {
        if (entry.programId === programId) matching.push(entry)
      }
      // The log is chronological; `limit` keeps the most recent entries in append order.
      return resolved(tail(matching, limit).map((entry) => copy(entry)))
    },
  }

  const unitOfWork: UnitOfWork = {
    programs,
    issues,
    experiments,
    ciRecords,
    tickets,
    artifacts,
    attention,
    audit,
    async transaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {
      const snapshot = snapshotState(state)
      try {
        return await work(unitOfWork)
      } catch (error) {
        restoreState(state, snapshot)
        throw error
      }
    },
  }

  return {
    ...unitOfWork,
    snapshot(programId: ProgramId): Promise<Result<ProgramSnapshot, DomainError>> {
      return resolved(snapshotProgram(state, programId))
    },
  }
}

// ---------------------------------------------------------------------------
// Versioned aggregates
// ---------------------------------------------------------------------------

/** Read one aggregate and hand out a copy. */
function readVersioned<T>(map: Map<string, Versioned<T>>, id: string): Versioned<T> | undefined {
  const stored = map.get(id)
  return stored === undefined ? undefined : copyVersioned(stored)
}

/** Read every aggregate, in insertion order, each as a copy. */
function listVersioned<T>(map: Map<string, Versioned<T>>): readonly Versioned<T>[] {
  const result: Versioned<T>[] = []
  for (const stored of map.values()) result.push(copyVersioned(stored))
  return result
}

/** Optimistic concurrency for one aggregate map. */
function saveVersioned<T extends Identified>(
  map: Map<string, Versioned<T>>,
  expected: Version,
  next: T,
): Result<Version, StoreError> {
  const current = map.get(next.id)
  const actual: number = current === undefined ? 0 : current.version
  if (actual !== expected) return versionConflict(expected, actual)
  const version = toVersion(actual + 1)
  map.set(next.id, { value: copy(next), version })
  return ok(version)
}

function copyVersioned<T>(stored: Versioned<T>): Versioned<T> {
  return { value: copy(stored.value), version: stored.version }
}

function versionConflict(expected: Version, actual: number): Err<StoreError> {
  return err({ kind: 'version-conflict', expected, actual })
}

// ---------------------------------------------------------------------------
// CI records
// ---------------------------------------------------------------------------

/**
 * Reject a passed record whose metric map is not a finite number map.
 *
 * Only passed records carry metrics in the type; other statuses are persisted as they
 * are. The check is repeated by `listPassed`/`query` because a record may also be
 * hydrated or constructed elsewhere and then reach the store through another path.
 */
function validateCIRecord(record: CIRecord): Err<StoreError> | null {
  if (record.status !== 'passed') return null
  const metrics: unknown = record.metrics
  if (typeof metrics !== 'object' || metrics === null || isArrayLike(metrics)) {
    return corrupt(`CI record ${String(record.id)} has no metric map`)
  }
  const entries: readonly (readonly [string, unknown])[] = Object.entries(metrics)
  for (const entry of entries) {
    if (typeof entry[1] !== 'number' || !Number.isFinite(entry[1])) {
      return corrupt(`CI record ${String(record.id)} has an invalid metric ${entry[0]}`)
    }
  }
  return null
}

/** A passed record is usable only when every metric is finite and every required one exists. */
function isUsablePassed(record: PassedCIRecord, required: readonly MetricName[]): boolean {
  for (const entry of Object.entries(record.metrics)) {
    if (typeof entry[1] !== 'number' || !Number.isFinite(entry[1])) return false
  }
  for (const name of required) {
    if (findMetric(record.metrics, name) === undefined) return false
  }
  return true
}

/** The passed records among `records` that the sampler and the metric query may use. */
function usablePassed(
  records: readonly CIRecord[],
  required: readonly MetricName[],
): readonly PassedCIRecord[] {
  const result: PassedCIRecord[] = []
  for (const record of records) {
    if (record.status !== 'passed') continue
    if (!isUsablePassed(record, required)) continue
    result.push(record)
  }
  return result
}

/** Required metrics of a program; an unknown program contributes no requirement. */
function requiredMetricsOf(program: Versioned<Program> | undefined): readonly MetricName[] {
  return program === undefined ? [] : program.value.contract.requiredMetrics
}

/** Sort rows by the query's metric keys; higher/lower means better first. */
function sortRecords(records: readonly CIRecord[], sort: readonly MetricSort[] | undefined): CIRecord[] {
  const rows = [...records]
  if (sort === undefined) return rows
  rows.sort((left, right) => {
    for (const key of sort) {
      const order = compareMetric(left, right, key)
      if (order !== 0) return order
    }
    return 0
  })
  return rows
}

function compareMetric(left: CIRecord, right: CIRecord, sort: MetricSort): number {
  const leftValue = recordMetric(left, sort.metric)
  const rightValue = recordMetric(right, sort.metric)
  // A row without the metric sorts after the rows that have it, whatever the direction.
  if (leftValue === undefined && rightValue === undefined) return 0
  if (leftValue === undefined) return 1
  if (rightValue === undefined) return -1
  const ascending = leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
  return sort.direction === 'higher' ? -ascending : ascending
}

/** One metric of a passed record, or undefined when the record has no finite value. */
function recordMetric(record: CIRecord, metric: MetricName): number | undefined {
  if (record.status !== 'passed') return undefined
  return finiteMetric(record.metrics, metric)
}

/** Aggregate every metric present in the usable passed population, one summary each. */
function summarize(
  records: readonly PassedCIRecord[],
  aggregate: NonNullable<MetricQuery['aggregate']>,
): readonly MetricSummary[] {
  const names = new Set<string>()
  for (const record of records) {
    for (const entry of Object.entries(record.metrics)) names.add(entry[0])
  }
  const result: MetricSummary[] = []
  for (const name of [...names].sort()) {
    const value = aggregateMetric(records, name, aggregate)
    if (value === undefined) continue
    result.push({ metric: toMetricName(name), value })
  }
  return result
}

function aggregateMetric(
  records: readonly PassedCIRecord[],
  name: string,
  aggregate: NonNullable<MetricQuery['aggregate']>,
): number | undefined {
  if (aggregate === 'latest') return latestMetric(records, name)
  let sum = 0
  let count = 0
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const record of records) {
    const value = findMetric(record.metrics, name)
    if (value === undefined || !Number.isFinite(value)) continue
    sum += value
    count += 1
    if (value < min) min = value
    if (value > max) max = value
  }
  if (count === 0) return undefined
  if (aggregate === 'average') return sum / count
  return aggregate === 'min' ? min : max
}

/** The metric value of the passed record with the newest `finishedAt`. */
function latestMetric(records: readonly PassedCIRecord[], name: string): number | undefined {
  let latestAt: string | undefined
  let latestValue: number | undefined
  for (const record of records) {
    const value = findMetric(record.metrics, name)
    if (value === undefined || !Number.isFinite(value)) continue
    if (latestAt === undefined || record.finishedAt >= latestAt) {
      latestAt = record.finishedAt
      latestValue = value
    }
  }
  return latestValue
}

/** Apply a `PositiveNumber` row limit; absent means all rows and junk means none. */
function applyLimit<T>(items: readonly T[], limit: number | undefined): readonly T[] {
  if (limit === undefined) return items
  const count = Math.floor(limit)
  return count > 0 ? items.slice(0, count) : []
}

// ---------------------------------------------------------------------------
// Attention
// ---------------------------------------------------------------------------

/**
 * Resolve the program an attention entry belongs to through its subject.
 *
 * `Attention` carries no program id, so an issue/experiment/CI-run subject is resolved
 * against the current rows. A subject whose aggregate is gone cannot be attributed and
 * is left out of the program view.
 */
function attentionBelongsToProgram(
  state: StoreState,
  entry: Attention,
  programId: ProgramId,
): boolean {
  const subject = entry.subject
  if (subject.kind === 'program') return subject.id === programId
  if (subject.kind === 'issue') {
    const issue = state.issues.get(subject.id)
    return issue !== undefined && issue.value.programId === programId
  }
  if (subject.kind === 'experiment') {
    const experiment = state.experiments.get(subject.id)
    return experiment !== undefined && experiment.value.programId === programId
  }
  const record = state.ciRecords.get(subject.id)
  return record !== undefined && record.programId === programId
}

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

/** Assemble the panel snapshot from the current state, or refuse an unknown program. */
function snapshotProgram(
  state: StoreState,
  programId: ProgramId,
): Result<ProgramSnapshot, DomainError> {
  const stored = state.programs.get(programId)
  if (stored === undefined) {
    return notFound(`program ${String(programId)} does not exist`)
  }

  const issues: Issue[] = []
  for (const issue of state.issues.values()) {
    if (issue.value.programId === programId) issues.push(copy(issue.value))
  }

  const comments: IssueComment[] = []
  for (const issue of issues) {
    for (const comment of state.comments.get(issue.id) ?? []) comments.push(copy(comment))
  }

  const experiments: Experiment[] = []
  for (const experiment of state.experiments.values()) {
    if (experiment.value.programId === programId) experiments.push(copy(experiment.value))
  }

  const ciRecords: CIRecord[] = []
  for (const record of state.ciRecords.values()) {
    if (record.programId === programId) ciRecords.push(copy(record))
  }

  const artifacts: ArtifactRef[] = []
  for (const artifact of state.artifacts.values()) {
    if (artifact.programId === programId) artifacts.push(copy(artifact))
  }

  const attention: Attention[] = []
  for (const entry of state.attention) {
    if (attentionBelongsToProgram(state, entry, programId)) attention.push(copy(entry))
  }

  const audit: AuditEntry[] = []
  for (const entry of state.audit) {
    if (entry.programId === programId) audit.push(copy(entry))
  }

  return ok({
    program: copy(stored.value),
    issues,
    comments,
    experiments,
    ciRecords,
    artifacts,
    attention,
    audit,
  })
}

// ---------------------------------------------------------------------------
// Transaction snapshots
// ---------------------------------------------------------------------------

/** Snapshot every mutable container; the stored values themselves are already copies. */
function snapshotState(state: StoreState): StoreState {
  return {
    programs: new Map(state.programs),
    issues: new Map(state.issues),
    comments: new Map(state.comments),
    experiments: new Map(state.experiments),
    reviews: new Map(state.reviews),
    ciRecords: new Map(state.ciRecords),
    tickets: new Map(state.tickets),
    artifacts: new Map(state.artifacts),
    attention: [...state.attention],
    audit: [...state.audit],
  }
}

function restoreState(state: StoreState, snapshot: StoreState): void {
  state.programs = snapshot.programs
  state.issues = snapshot.issues
  state.comments = snapshot.comments
  state.experiments = snapshot.experiments
  state.reviews = snapshot.reviews
  state.ciRecords = snapshot.ciRecords
  state.tickets = snapshot.tickets
  state.artifacts = snapshot.artifacts
  state.attention = snapshot.attention
  state.audit = snapshot.audit
}

// ---------------------------------------------------------------------------
// Result and value helpers
// ---------------------------------------------------------------------------

function ok<T>(value: T): Ok<T> {
  return { ok: true, value }
}

/** Adapt a synchronously computed value to the repositories' `Promise` ports. */
function resolved<T>(value: T): Promise<T> {
  return Promise.resolve(value)
}

function okVoid(): Ok<void> {
  return { ok: true, value: undefined }
}

function err<E>(error: E): Err<E> {
  return { ok: false, error }
}

function corrupt(message: string): Err<StoreError> {
  return err({ kind: 'corrupt', message: nonEmpty(message) })
}

function notFound(message: string): Err<DomainError> {
  return err({ code: 'not-found', message: nonEmpty(message) })
}

/**
 * `StoreError.message` and `DomainError.message` are nominal `NonEmptyString`s. This
 * module never consumes untrusted input and every message is built here, so the
 * refinement declares the invariant once with a runtime fallback (the same Phase 1
 * convention as `src/runtime/domain.ts`).
 */
function nonEmpty(value: string): NonEmptyString
function nonEmpty(value: string): string {
  return value.length === 0 ? 'refused' : value
}

/** `Version` is a branded number; the store mints the next version itself. */
function toVersion(value: number): Version
function toVersion(value: number): number {
  return value
}

/** A metric key read back from a record is a `MetricName` by construction. */
function toMetricName(value: string): MetricName
function toMetricName(value: string): string {
  return value
}

/**
 * Deep copy of a stored record.
 *
 * The copy is what makes a save and a read independent: a caller cannot mutate the
 * store through the object it passed in, and two reads never share mutable state. The
 * value is frozen as well so an accidental write to a read result fails loudly in strict
 * mode. The overload keeps the caller's type without an assertion.
 */
function copy<T>(value: T): T
function copy(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (isArrayLike(value)) {
    const items: unknown[] = []
    for (const item of Object.values(value)) items.push(copy(item))
    return Object.freeze(items)
  }
  const record: Record<string, unknown> = {}
  for (const entry of Object.entries(value)) {
    record[entry[0]] = copy(entry[1])
  }
  return Object.freeze(record)
}

/** Copy a list of stored values; an absent list is an empty one. */
function copyList<T>(list: readonly T[] | undefined): readonly T[] {
  return list === undefined ? [] : list.map((item) => copy(item))
}

/** Append to the list under a key by replacing it, so a transaction snapshot stays valid. */
function appendToMap<T>(map: Map<string, readonly T[]>, key: string, value: T): void {
  map.set(key, [...(map.get(key) ?? []), value])
}

/** The last `limit` entries in order; a non-positive or non-finite limit keeps none. */
function tail<T>(items: readonly T[], limit: number): readonly T[] {
  const count = limit > 0 ? Math.floor(limit) : 0
  if (count === 0) return []
  return items.slice(Math.max(0, items.length - count))
}

/** Array check that does not narrow the typed input to `any[]` (see `sampler.ts`). */
function isArrayLike(value: unknown): boolean {
  return Array.isArray(value)
}

/** One required metric value, or undefined when the map does not carry it. */
function findMetric(metrics: MetricMap, name: string): number | undefined {
  for (const entry of Object.entries(metrics)) {
    if (entry[0] === name) return entry[1]
  }
  return undefined
}

/** One finite metric value, or undefined when missing or not a finite number. */
function finiteMetric(metrics: MetricMap, name: string): number | undefined {
  const value = findMetric(metrics, name)
  return value !== undefined && Number.isFinite(value) ? value : undefined
}
