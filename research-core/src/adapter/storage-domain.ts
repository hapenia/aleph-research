/**
 * Persistent `UnitOfWork`/`ReadModel` adapter over the DSH `aleph_research` storage
 * domain.
 *
 * The DSH domain form (`ctx.storageDomain.open(...)`) exposes one table handle per
 * declared table with synchronous `get`/`entries` reads and durable `put`/`update`/
 * `delete` writes. It does **not** expose a record version, an etag or a cross-table
 * transaction (see the package README: "No cross-table transactions"). This module
 * therefore depends on a small injected `DomainStore` interface instead of importing
 * DSH runtime types. The `superagent-extension` adapter implements that interface over
 * the opened domain and is responsible for:
 *
 * - persisting a monotonic version token per row (for example a `{ version, value }`
 *   record, or a sidecar table), which this module maps to the domain `Version`;
 * - serializing read-compare-write per key so the version check is a real CAS in one
 *   process (`KvTable.update` gives an in-process chain slot; a cross-process lock is
 *   outside DSH's contract);
 * - mapping the store's opaque etag to diagnostic metadata (this module only carries
 *   it through);
 * - declaring the table schemas on the DSH domain so a malformed medium is rejected
 *   before this module ever sees it.
 *
 * Rows are stored as plain data records. Nominal states come back through
 * `src/hydration.ts`; a row that does not hydrate is refused as `StoreError` `corrupt`
 * (a thrown `DomainStoreFailure` on methods whose port has no `Result`, an `Err` on
 * methods that do). The DSH domain's zod schemas and this hydration pass are two
 * independent checks: the first validates the medium, the second validates the domain.
 *
 * Transaction semantics: when `DomainStore.transaction` is present the adapter delegates
 * to it (`transactionMode: 'auto'`). DSH provides no such transaction, so the default
 * production path is the snapshot/rollback adapter: every table is listed before the
 * work starts and restored if it throws. That is a best-effort compensation, not
 * isolation: it rewrites every row, takes a full-table snapshot, can race a concurrent
 * writer, and cannot roll version numbers back (versions only ever increase). The limit
 * is deliberate and documented in `docs/notes/storage-domain-adapter.md`.
 */
import type { ProgramSnapshot } from '../types/api.js'
import type { ArtifactRef } from '../types/artifacts.js'
import type { Attention } from '../types/attention.js'
import type { AuditEntry, AuditLog } from '../types/audit.js'
import type { DomainError, Err, Ok, Result, StoreError } from '../types/errors.js'
import type { Experiment, ExperimentReview } from '../types/experiment.js'
import type {
  MetricName,
  NonEmptyString,
  PositiveNumber,
  ProgramId,
  Version,
} from '../types/ids.js'
import type { Issue, IssueComment } from '../types/issue.js'
import type {
  CIRecord,
  MetricMap,
  MetricQuery,
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
import { createResearcherPrincipal } from '../factories.js'
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
} from '../hydration.js'
import {
  experimentId as parseExperimentId,
  isoTimestamp as parseIsoTimestamp,
  nonEmptyString as parseNonEmptyString,
  researcherSessionId as parseResearcherSessionId,
  reviewId as parseReviewId,
  version as parseVersion,
} from '../parsers.js'

/** The DSH storage domain this adapter is written for. */
export const ALEPH_RESEARCH_DOMAIN = 'aleph_research'

/**
 * Tables of `aleph_research`. Names match DSH's `UNIT_NAME_RE` (`^[a-z][a-z0-9_]*$`).
 * The first four hold versioned aggregates; the rest are append/list tables.
 */
export type DomainTable =
  | 'programs'
  | 'issues'
  | 'experiments'
  | 'tickets'
  | 'issue_comments'
  | 'experiment_reviews'
  | 'ci_records'
  | 'artifacts'
  | 'attention'
  | 'audit'

/** Every table, in an order suitable for deterministic snapshots. */
export const DOMAIN_TABLES: readonly DomainTable[] = [
  'programs',
  'issues',
  'experiments',
  'tickets',
  'issue_comments',
  'experiment_reviews',
  'ci_records',
  'artifacts',
  'attention',
  'audit',
]

/**
 * One row returned by a `DomainStore`.
 *
 * `version` is the optimistic-concurrency token mapped to the domain `Version` (the
 * first save expects `0`). `etag` is the adapter's opaque diagnostic token; the domain
 * adapter never compares it but carries it so a store can expose external-change
 * detection without changing this contract.
 */
export interface DomainRow {
  readonly key: string
  readonly value: unknown
  readonly version: Version
  readonly etag: string
}

/** What a successful `put` returns. */
export interface DomainWrite {
  readonly version: Version
  readonly etag: string
}

/**
 * The storage seam the DSH adapter provides for one opened `aleph_research` domain.
 *
 * `put` must compare `expected` with the row's current version and refuse with
 * `version-conflict`; it must not overwrite. A missing row has version `0`. `delete`
 * is idempotent. `transaction`, when present, must make the callback atomic over all
 * tables of this domain; DSH does not provide one.
 */
export interface DomainStore {
  list(table: DomainTable): Promise<readonly DomainRow[]>
  get(table: DomainTable, key: string): Promise<DomainRow | undefined>
  put(
    table: DomainTable,
    key: string,
    value: unknown,
    expected: Version,
  ): Promise<Result<DomainWrite, StoreError>>
  delete(table: DomainTable, key: string): Promise<Result<void, StoreError>>
  readonly transaction?: <T>(work: () => Promise<T>) => Promise<T>
}

export interface StorageDomainOptions {
  /**
   * `auto` (default) delegates to `DomainStore.transaction` when the store exposes one
   * and otherwise uses the snapshot/rollback adapter. `snapshot` always uses the
   * adapter, even when the store could transact natively.
   */
  readonly transactionMode?: 'auto' | 'snapshot'
}

/** The persistent store is both the write unit of work and the panel read model. */
export interface StorageDomainUnitOfWork extends UnitOfWork, ReadModel {}

/**
 * Raised when a store operation fails on a port that has no `Result` return.
 *
 * Methods whose ports do return a `Result` report the same `StoreError` as a value; this
 * class is for reads (an unhydratable row throws instead of disappearing from a list)
 * and for the void-returning audit append.
 */
export class DomainStoreFailure extends Error {
  readonly storeError: StoreError

  constructor(error: StoreError) {
    super(describeStoreError(error))
    this.name = 'DomainStoreFailure'
    this.storeError = error
  }
}

type Hydrator<T> = (row: unknown) => Result<T, StoreError>

interface TableSnapshot {
  readonly table: DomainTable
  readonly rows: readonly DomainRow[]
}

interface AttentionProgramIndex {
  readonly issues: ReadonlyMap<string, ProgramId>
  readonly experiments: ReadonlyMap<string, ProgramId>
  readonly ciRecords: ReadonlyMap<string, ProgramId>
}

/** The version a first save or a create expects. */
const INITIAL_VERSION: Version = initialVersion()

/**
 * Create the `UnitOfWork` and `ReadModel` over one opened storage domain.
 *
 * Repositories do not cache: every read goes to the store and every nominal value is
 * hydrated from the stored row, so a corrupt row is refused on the read that touches
 * it. `ProgramSnapshot` is assembled from separate reads, exactly like the in-memory
 * reference store; DSH cannot give a cross-table atomic read either.
 */
export function createStorageDomainUnitOfWork(
  store: DomainStore,
  options: StorageDomainOptions = {},
): StorageDomainUnitOfWork {
  const transactionMode = options.transactionMode ?? 'auto'

  const programs: ProgramRepository = {
    get(id: ProgramId): Promise<Versioned<Program> | undefined> {
      return readVersioned(store, 'programs', id, hydrateProgram)
    },
    list(): Promise<readonly Versioned<Program>[]> {
      return listVersioned(store, 'programs', hydrateProgram)
    },
    save(expected: Version, next: Program): Promise<Result<Version, StoreError>> {
      return saveAggregate(store, 'programs', expected, next, hydrateProgram)
    },
  }

  const issues: IssueRepository = {
    get(id) {
      return readVersioned(store, 'issues', id, hydrateIssue)
    },
    async listByProgram(programId) {
      const stored = await readMany(store, 'issues', hydrateIssue)
      return stored.filter((issue) => issue.programId === programId)
    },
    async listAssignedTo(assignee) {
      const stored = await readMany(store, 'issues', hydrateIssue)
      return stored.filter((issue) => {
        if (issue.status !== 'assigned') return false
        return issue.assignee.sessionId === assignee
      })
    },
    save(expected, next) {
      return saveAggregate(store, 'issues', expected, next, hydrateIssue)
    },
    async comments(issueId) {
      const stored = await readMany(store, 'issue_comments', hydrateIssueComment)
      return stored.filter((comment) => comment.issueId === issueId)
    },
    appendComment(comment) {
      return appendValidated(store, 'issue_comments', comment.id, comment, hydrateIssueComment)
    },
  }

  const experiments: ExperimentRepository = {
    get(id) {
      return readVersioned(store, 'experiments', id, hydrateExperiment)
    },
    async listByProgram(programId) {
      const stored = await readMany(store, 'experiments', hydrateExperiment)
      return stored.filter((experiment) => experiment.programId === programId)
    },
    async listByIssue(issueId) {
      const stored = await readMany(store, 'experiments', hydrateExperiment)
      return stored.filter((experiment) => experiment.issueId === issueId)
    },
    save(expected, next) {
      return saveAggregate(store, 'experiments', expected, next, hydrateExperiment)
    },
    async reviews(experimentId) {
      const stored = await readMany(store, 'experiment_reviews', readReview)
      return stored.filter((review) => review.experimentId === experimentId)
    },
    appendReview(review) {
      return appendValidated(store, 'experiment_reviews', review.id, review, readReview)
    },
  }

  const ciRecords: CIRecordRepository = {
    get(id) {
      return readPlain(store, 'ci_records', id, hydrateCIRecord)
    },
    async listByExperiment(experimentId) {
      const stored = await readMany(store, 'ci_records', hydrateCIRecord)
      return stored.filter((record) => record.experimentId === experimentId)
    },
    async listPassed(programId) {
      const [stored, program] = await Promise.all([
        readMany(store, 'ci_records', hydrateCIRecord),
        readPlain(store, 'programs', programId, hydrateProgram),
      ])
      const required = requiredMetricsOf(program)
      const result: PassedCIRecord[] = []
      for (const record of stored) {
        if (record.programId !== programId) continue
        if (record.status !== 'passed') continue
        if (!isUsablePassed(record, required)) continue
        result.push(record)
      }
      return result
    },
    async query(query) {
      const [stored, program] = await Promise.all([
        readMany(store, 'ci_records', hydrateCIRecord),
        readPlain(store, 'programs', query.programId, hydrateProgram),
      ])
      const matched: CIRecord[] = []
      for (const record of stored) {
        if (record.programId !== query.programId) continue
        if (query.experimentId !== undefined && record.experimentId !== query.experimentId) continue
        matched.push(record)
      }

      const sorted = sortRecords(matched, query.sort)
      const required = requiredMetricsOf(program)
      const summaries = query.aggregate === undefined
        ? []
        : summarize(usablePassed(sorted, required), query.aggregate)
      const rows = applyLimit(sorted, query.limit)
      return { rows, summaries }
    },
    append(record) {
      return appendValidated(store, 'ci_records', record.id, record, hydrateCIRecord)
    },
  }

  const tickets: TicketRepository = {
    get(ticketId) {
      return readVersioned(store, 'tickets', ticketId, hydrateTicket)
    },
    async listByExperiment(experimentId) {
      const stored = await readMany(store, 'tickets', hydrateTicket)
      return stored.filter((ticket) => ticket.experimentId === experimentId)
    },
    save(expected, next) {
      return saveAggregate(store, 'tickets', expected, next, hydrateTicket)
    },
  }

  const artifacts: ArtifactRepository = {
    get(id) {
      return readPlain(store, 'artifacts', id, hydrateArtifact)
    },
    async listByExperiment(experimentId) {
      const stored = await readMany(store, 'artifacts', hydrateArtifact)
      return stored.filter((artifact) => artifact.experimentId === experimentId)
    },
    append(ref) {
      return appendValidated(store, 'artifacts', ref.id, ref, hydrateArtifact)
    },
  }

  const attention: AttentionRepository = {
    async listByProgram(programId) {
      const [entries, index] = await Promise.all([
        readMany(store, 'attention', hydrateAttention),
        readAttentionIndex(store),
      ])
      return entries.filter((entry) => attentionProgramId(entry, index) === programId)
    },
    append(entry) {
      return appendValidated(store, 'attention', entry.id, entry, hydrateAttention)
    },
  }

  const audit: AuditLog = {
    async append(entries) {
      const encoded: { readonly key: string; readonly value: unknown }[] = []
      for (const entry of entries) {
        const row = encodeRow(entry, hydrateAuditEntry)
        if (!row.ok) throw new DomainStoreFailure(row.error)
        encoded.push({ key: entry.id, value: row.value })
      }
      for (const row of encoded) {
        const written = await upsert(store, 'audit', row.key, row.value)
        if (!written.ok) throw new DomainStoreFailure(written.error)
      }
    },
    async list(programId, limit) {
      const entries = await readMany(store, 'audit', hydrateAuditEntry)
      const matching = entries.filter((entry) => entry.programId === programId)
      // The append tables preserve store order; `limit` keeps the most recent entries.
      return tail(matching, limit)
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
      const native = transactionMode === 'auto' ? store.transaction : undefined
      if (native !== undefined) return native(() => work(unitOfWork))

      const snapshot = await captureSnapshot(store)
      try {
        return await work(unitOfWork)
      } catch (error) {
        try {
          await restoreSnapshot(store, snapshot)
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'storage-domain transaction failed and its snapshot rollback also failed',
          )
        }
        throw error
      }
    },
  }

  return {
    ...unitOfWork,
    async snapshot(programId: ProgramId): Promise<Result<ProgramSnapshot, DomainError>> {
      return snapshotProgram(store, programId)
    },
  }
}

// ---------------------------------------------------------------------------
// Store reads and writes
// ---------------------------------------------------------------------------

/** Read one versioned aggregate; an absent row is `undefined`, a corrupt one throws. */
async function readVersioned<T>(
  store: DomainStore,
  table: DomainTable,
  key: string,
  hydrate: Hydrator<T>,
): Promise<Versioned<T> | undefined> {
  const row = await store.get(table, key)
  if (row === undefined) return undefined
  return { value: decodeRow(row.value, hydrate, table, key), version: row.version }
}

/** Read every versioned aggregate in store order. */
async function listVersioned<T>(
  store: DomainStore,
  table: DomainTable,
  hydrate: Hydrator<T>,
): Promise<readonly Versioned<T>[]> {
  const rows = await store.list(table)
  const result: Versioned<T>[] = []
  for (const row of rows) {
    result.push({ value: decodeRow(row.value, hydrate, table, row.key), version: row.version })
  }
  return result
}

/** Read one unversioned row; an absent row is `undefined`, a corrupt one throws. */
async function readPlain<T>(
  store: DomainStore,
  table: DomainTable,
  key: string,
  hydrate: Hydrator<T>,
): Promise<T | undefined> {
  const row = await store.get(table, key)
  return row === undefined ? undefined : decodeRow(row.value, hydrate, table, key)
}

/** Read every unversioned row in store order, hydrating each one. */
async function readMany<T>(
  store: DomainStore,
  table: DomainTable,
  hydrate: Hydrator<T>,
): Promise<readonly T[]> {
  const rows = await store.list(table)
  const result: T[] = []
  for (const row of rows) result.push(decodeRow(row.value, hydrate, table, row.key))
  return result
}

/** Validate one encoded row and write it with the caller's expected version. */
async function saveAggregate<T extends { readonly id: string }>(
  store: DomainStore,
  table: DomainTable,
  expected: Version,
  next: T,
  hydrate: Hydrator<T>,
): Promise<Result<Version, StoreError>> {
  const row = encodeRow(next, hydrate)
  if (!row.ok) return row
  const written = await store.put(table, next.id, row.value, expected)
  if (!written.ok) return written
  return ok(written.value.version)
}

/** Validate, encode and upsert one append-table record. */
async function appendValidated<T>(
  store: DomainStore,
  table: DomainTable,
  key: string,
  value: T,
  hydrate: Hydrator<T>,
): Promise<Result<void, StoreError>> {
  const row = encodeRow(value, hydrate)
  if (!row.ok) return row
  return upsert(store, table, key, row.value)
}

/** Replace-or-create with the current version; the version check stays optimistic. */
async function upsert(
  store: DomainStore,
  table: DomainTable,
  key: string,
  value: unknown,
): Promise<Result<void, StoreError>> {
  const current = await store.get(table, key)
  const expected = current === undefined ? INITIAL_VERSION : current.version
  const written = await store.put(table, key, value, expected)
  if (!written.ok) return written
  return okVoid()
}

/** Turn a stored value into a nominal value, or throw the hydrator's `corrupt` error. */
function decodeRow<T>(
  value: unknown,
  hydrate: Hydrator<T>,
  table: DomainTable,
  key: string,
): T {
  const decoded = hydrate(value)
  if (decoded.ok) return decoded.value
  throw new DomainStoreFailure(withLocation(decoded.error, table, key))
}

/**
 * Validate an encoded row through the same hydrator used on read.
 *
 * This is the write-side half of the storage contract: a value that would not hydrate
 * is refused before it can become a corrupt row, and the caller gets a `StoreError`.
 */
function encodeRow<T>(value: T, hydrate: Hydrator<T>): Result<unknown, StoreError> {
  const row = copyRow(value)
  const checked = hydrate(row)
  if (!checked.ok) return checked
  return ok(row)
}

/** Copy a nominal/class value into a plain data row; methods and `undefined` are dropped. */
function copyRow(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    const items: unknown[] = []
    for (const item of Object.values(value)) items.push(copyRow(item))
    return items
  }
  const record: Record<string, unknown> = {}
  for (const entry of Object.entries(value)) {
    if (typeof entry[1] === 'function' || entry[1] === undefined) continue
    record[entry[0]] = copyRow(entry[1])
  }
  return record
}

function withLocation(error: StoreError, table: DomainTable, key: string): StoreError {
  if (error.kind !== 'corrupt') return error
  return { kind: 'corrupt', message: toMessage(`${table}/${key}: ${error.message}`) }
}

// ---------------------------------------------------------------------------
// Reviews (the only structural record without a hydrator in src/hydration.ts)
// ---------------------------------------------------------------------------

/**
 * Validate an `ExperimentReview` row.
 *
 * Reviews are structural records, not nominal states, but no hydration helper exists
 * for them yet. This parser uses the same boundary helpers the hydrators use (id,
 * timestamp and non-empty-string parsers, plus the principal factory) rather than an
 * assertion, so a corrupt stored review is still refused as `StoreError`.
 */
function readReview(row: unknown): Result<ExperimentReview, StoreError> {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    return corrupt('experiment review row must be an object')
  }
  const id = fromParser(parseReviewId(readField(row, 'id')), 'experiment review.id')
  if (!id.ok) return id
  const experiment = fromParser(
    parseExperimentId(readField(row, 'experimentId')),
    'experiment review.experimentId',
  )
  if (!experiment.ok) return experiment
  const body = fromParser(
    parseNonEmptyString(readField(row, 'body')),
    'experiment review.body',
  )
  if (!body.ok) return body
  const at = fromParser(parseIsoTimestamp(readField(row, 'at')), 'experiment review.at')
  if (!at.ok) return at
  if (readField(row, 'kind') !== 'review') return corrupt('experiment review.kind must be review')
  const verdict = readField(row, 'verdict')
  if (verdict !== 'approve' && verdict !== 'request-changes' && verdict !== 'comment') {
    return corrupt('experiment review.verdict must be approve, request-changes or comment')
  }
  const author = readField(row, 'author')
  if (typeof author !== 'object' || author === null || Array.isArray(author)) {
    return corrupt('experiment review.author must be an object')
  }
  if (readField(author, 'kind') !== 'researcher') {
    return corrupt('experiment review.author.kind must be researcher')
  }
  const session = fromParser(
    parseResearcherSessionId(readField(author, 'sessionId')),
    'experiment review.author.sessionId',
  )
  if (!session.ok) return session

  return ok({
    id: id.value,
    experimentId: experiment.value,
    author: createResearcherPrincipal(session.value),
    body: body.value,
    at: at.value,
    kind: 'review',
    verdict,
  })
}

/** Read a field from an already-narrowed object without asserting a row type. */
function readField(target: object, key: string): unknown {
  const value: unknown = Reflect.get(target, key)
  return value
}

function fromParser<T>(
  result: Result<T, DomainError>,
  label: string,
): Result<T, StoreError> {
  if (result.ok) return result
  return corrupt(`${label}: ${result.error.code}: ${result.error.message}`)
}

// ---------------------------------------------------------------------------
// CI record views
// ---------------------------------------------------------------------------

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

/** Required metrics of a program; an absent program contributes no requirement. */
function requiredMetricsOf(program: Program | undefined): readonly MetricName[] {
  return program === undefined ? [] : program.contract.requiredMetrics
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
function applyLimit<T>(items: readonly T[], limit: PositiveNumber | undefined): readonly T[] {
  if (limit === undefined) return items
  const count = Math.floor(limit)
  return count > 0 ? items.slice(0, count) : []
}

// ---------------------------------------------------------------------------
// Attention
// ---------------------------------------------------------------------------

/** Index the subjects an attention entry can point at by their program. */
async function readAttentionIndex(store: DomainStore): Promise<AttentionProgramIndex> {
  const [issues, experiments, ciRecords] = await Promise.all([
    readMany(store, 'issues', hydrateIssue),
    readMany(store, 'experiments', hydrateExperiment),
    readMany(store, 'ci_records', hydrateCIRecord),
  ])
  const issuePrograms = new Map<string, ProgramId>()
  for (const issue of issues) issuePrograms.set(issue.id, issue.programId)
  const experimentPrograms = new Map<string, ProgramId>()
  for (const experiment of experiments) experimentPrograms.set(experiment.id, experiment.programId)
  const ciPrograms = new Map<string, ProgramId>()
  for (const record of ciRecords) ciPrograms.set(record.id, record.programId)
  return {
    issues: issuePrograms,
    experiments: experimentPrograms,
    ciRecords: ciPrograms,
  }
}

/** Resolve the program an attention entry belongs to through its subject. */
function attentionProgramId(
  entry: Attention,
  index: AttentionProgramIndex,
): ProgramId | undefined {
  const subject = entry.subject
  switch (subject.kind) {
    case 'program':
      return subject.id
    case 'issue':
      return index.issues.get(subject.id)
    case 'experiment':
      return index.experiments.get(subject.id)
    case 'ci-run':
      return index.ciRecords.get(subject.id)
  }
}

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

/** Assemble the panel snapshot, or refuse an unknown program. */
async function snapshotProgram(
  store: DomainStore,
  programId: ProgramId,
): Promise<Result<ProgramSnapshot, DomainError>> {
  const program = await readVersioned(store, 'programs', programId, hydrateProgram)
  if (program === undefined) {
    return notFound(`program ${String(programId)} does not exist`)
  }

  const [issues, comments, experiments, ciRecords, artifacts, attention, audit] = await Promise.all([
    readMany(store, 'issues', hydrateIssue),
    readMany(store, 'issue_comments', hydrateIssueComment),
    readMany(store, 'experiments', hydrateExperiment),
    readMany(store, 'ci_records', hydrateCIRecord),
    readMany(store, 'artifacts', hydrateArtifact),
    readMany(store, 'attention', hydrateAttention),
    readMany(store, 'audit', hydrateAuditEntry),
  ])

  const programIssues: Issue[] = []
  for (const issue of issues) {
    if (issue.programId === programId) programIssues.push(issue)
  }
  const programIssueIds = new Set<string>()
  const issueComments = new Map<string, IssueComment[]>()
  for (const issue of programIssues) programIssueIds.add(issue.id)
  for (const comment of comments) {
    if (!programIssueIds.has(comment.issueId)) continue
    const list = issueComments.get(comment.issueId)
    if (list === undefined) issueComments.set(comment.issueId, [comment])
    else list.push(comment)
  }
  const snapshotComments: IssueComment[] = []
  for (const issue of programIssues) {
    for (const comment of issueComments.get(issue.id) ?? []) snapshotComments.push(comment)
  }

  const programExperiments: Experiment[] = []
  for (const experiment of experiments) {
    if (experiment.programId === programId) programExperiments.push(experiment)
  }
  const programCIRecords: CIRecord[] = []
  for (const record of ciRecords) {
    if (record.programId === programId) programCIRecords.push(record)
  }
  const programArtifacts: ArtifactRef[] = []
  for (const artifact of artifacts) {
    if (artifact.programId === programId) programArtifacts.push(artifact)
  }
  const index: AttentionProgramIndex = {
    issues: new Map(programIssues.map((issue) => [String(issue.id), issue.programId])),
    experiments: new Map(
      programExperiments.map((experiment) => [String(experiment.id), experiment.programId]),
    ),
    ciRecords: new Map(programCIRecords.map((record) => [String(record.id), record.programId])),
  }
  const programAttention: Attention[] = []
  for (const entry of attention) {
    if (attentionProgramId(entry, index) === programId) programAttention.push(entry)
  }
  const programAudit: AuditEntry[] = []
  for (const entry of audit) {
    if (entry.programId === programId) programAudit.push(entry)
  }

  return ok({
    program: program.value,
    issues: programIssues,
    comments: snapshotComments,
    experiments: programExperiments,
    ciRecords: programCIRecords,
    artifacts: programArtifacts,
    attention: programAttention,
    audit: programAudit,
  })
}

// ---------------------------------------------------------------------------
// Snapshot / rollback transactions
// ---------------------------------------------------------------------------

/** Capture every table before a transaction; values are copied so work cannot mutate them. */
async function captureSnapshot(store: DomainStore): Promise<readonly TableSnapshot[]> {
  const snapshots: TableSnapshot[] = []
  for (const table of DOMAIN_TABLES) {
    const rows = await store.list(table)
    const copied: DomainRow[] = []
    for (const row of rows) {
      copied.push({
        key: row.key,
        value: copyRow(row.value),
        version: row.version,
        etag: row.etag,
      })
    }
    snapshots.push({ table, rows: copied })
  }
  return snapshots
}

/**
 * Best-effort compensation for a failed transaction.
 *
 * Each snapshot row is written back with the live row's current version, so restoring
 * our own writes succeeds; a concurrent writer makes the version check fail and the
 * whole rollback report. Rows created during the work are deleted. Version numbers are
 * not restored — they only ever increase.
 */
async function restoreSnapshot(
  store: DomainStore,
  snapshots: readonly TableSnapshot[],
): Promise<void> {
  const failures: string[] = []
  for (const snapshot of snapshots) {
    const liveRows = await store.list(snapshot.table)
    const live = new Map<string, DomainRow>()
    for (const row of liveRows) live.set(row.key, row)

    for (const row of snapshot.rows) {
      const current = live.get(row.key)
      const expected = current === undefined ? INITIAL_VERSION : current.version
      const restored = await store.put(snapshot.table, row.key, copyRow(row.value), expected)
      if (!restored.ok) {
        failures.push(`${snapshot.table}/${row.key}: ${describeStoreError(restored.error)}`)
      }
      live.delete(row.key)
    }
    for (const extra of live.values()) {
      const deleted = await store.delete(snapshot.table, extra.key)
      if (!deleted.ok) {
        failures.push(`${snapshot.table}/${extra.key}: ${describeStoreError(deleted.error)}`)
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`storage-domain snapshot rollback failed: ${failures.join('; ')}`)
  }
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

/** A metric key read back from a hydrated `MetricMap` is already a `MetricName`. */
function toMetricName(value: string): MetricName
function toMetricName(value: string): string {
  return value
}

function initialVersion(): Version {
  const parsed = parseVersion(0)
  if (!parsed.ok) throw new Error('storage domain: 0 is not a valid Version')
  return parsed.value
}

function ok<T>(value: T): Ok<T> {
  return { ok: true, value }
}

function okVoid(): Ok<void> {
  return { ok: true, value: undefined }
}

function err<E>(error: E): Err<E> {
  return { ok: false, error }
}

function corrupt(message: string): Err<StoreError> {
  return err({ kind: 'corrupt', message: toMessage(message) })
}

function notFound(message: string): Err<DomainError> {
  return err({ code: 'not-found', message: toMessage(message) })
}

/** Parse a message into the nominal `NonEmptyString`; parser failures carry their own. */
function toMessage(text: string): NonEmptyString {
  const parsed = parseNonEmptyString(text)
  return parsed.ok ? parsed.value : parsed.error.message
}

function describeStoreError(error: StoreError): string {
  switch (error.kind) {
    case 'version-conflict':
      return `version conflict: expected ${error.expected}, actual ${error.actual}`
    case 'io':
      return error.message
    case 'corrupt':
      return error.message
  }
}

/** The last `limit` entries in order; a non-positive or non-finite limit keeps none. */
function tail<T>(items: readonly T[], limit: number): readonly T[] {
  const count = limit > 0 ? Math.floor(limit) : 0
  if (count === 0) return []
  return items.slice(Math.max(0, items.length - count))
}

/** One metric value, or undefined when the map does not carry it. */
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
