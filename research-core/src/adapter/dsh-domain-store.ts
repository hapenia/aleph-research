/**
 * Production `DomainStore` seam (see `./storage-domain.ts`) over one opened DSH
 * `aleph_research` storage domain.
 *
 * This module deliberately imports no `@deepseek-ai/dsh-storage-domain` package: the
 * installed payload ships only `lib/index.js` (the `types` entry points at a missing
 * `lib/types/index.d.ts`), so a type import cannot compile. Instead the store accepts a
 * minimal structural `DshDomainLike` that mirrors the table handle observed at runtime
 * in `@deepseek-ai/dsh-storage-domain@0.2.2-alpha.2`.
 *
 * ## Mapping to the real DSH API
 *
 * | This seam | DSH `DomainTable` / `KvTable` handle | Behavior |
 * | --- | --- | --- |
 * | `domain.table(name)` | `Domain<R>.table(name: keyof R['tables'])` | Resolves a declared table handle; an undeclared name throws. |
 * | `table.get(key)` | `KvTable.get(key): V \| undefined` | Synchronous read from validated in-memory state. |
 * | `table.entries()` | `KvTable.entries(): IterableIterator<[string, V]>` | Synchronous iteration, in insertion order. |
 * | `table.put(key, value)` | `KvTable.put(key, value): Promise<void>` | Durable when it resolves; **no existence check and no compare-and-set**. |
 * | `table.delete(key)` | `KvTable.delete(key): Promise<boolean>` | `false` when the key was absent; resolves after durability. |
 * | `table.update(key, fn)` | `KvTable.update(key, fn): Promise<V>` | The transform runs at the domain's single write-chain slot, so it observes every previously committed write; throwing rejects the write without storing, and an absent key rejects with `DomainError('missing-key')`. |
 * | version token | none | DSH exposes no per-record version, etag or CAS; the store persists its own envelope. |
 * | change notification | `domain/changed` (in-process only) | Not used: this seam needs no external-change detection, and the event does not cross processes. |
 *
 * The table surface is intentionally narrow. The real handle also exposes `keys`, `size`
 * and `deleteMany`; this store does not need them.
 *
 * ## Version envelope
 *
 * Every logical row is stored as a version envelope:
 *
 * ```text
 * { "version": 3, "value": { ...the domain row... } }
 * ```
 *
 * A create checks that the key is absent and then `put`s version `1`; an update compares
 * the stored version with the caller's `expected` inside the `update` transform and
 * writes `version + 1`. The transform's check is the real per-record CAS: it runs at the
 * DSH write-chain slot, so a writer that read the same version earlier cannot overwrite a
 * newer write. The domain declaration must use the same envelope schema for every table
 * (`{ version: number, value: unknown }`), which also means the DSH domain layer rejects a
 * malformed medium before this store sees it. The store re-validates the envelope anyway
 * so a row written around the schema (or by an older deployment) becomes
 * `StoreError('corrupt')` instead of a silent `undefined`.
 *
 * ## Serialization and limits
 *
 * Writes are serialized on a per-store promise chain, so the store's own read-check-write
 * (notably the create check) cannot interleave. Updates also delegate their version check
 * to the DSH `update` transform, which is serialized per open domain. The guarantees still
 * stop at process boundaries: DSH has no per-record etag, conditional put or cross-process
 * write lock, so cross-process CAS is best-effort, and two store instances over the same
 * domain can both "create" one missing key (last write wins) even in one process. Reads are
 * not queued: `get`/`list` observe the last committed state, which is what the DSH handle
 * itself returns.
 *
 * Table names are logical (`DomainTable`) and mapped to their declared DSH names. The
 * defaults are the identity: all ten logical names already match DSH's
 * `^[a-z][a-z0-9_]*$` (`UNIT_NAME_RE`). `createDshDomainStore` accepts overrides, validates
 * every resolved name against that pattern and refuses two logical tables sharing one
 * physical table, so a bad mapping fails at wiring time rather than mixing rows.
 *
 * Error mapping: methods with a `Result` port (`put`, `delete`) return `StoreError`;
 * methods without one (`get`, `list`) throw `DomainStoreFailure` carrying the same error,
 * exactly like the storage-domain adapter. An underlying DSH failure (closed domain,
 * backend failure) becomes `StoreError('io')`; a version mismatch becomes
 * `StoreError('version-conflict')`, and an update whose key disappeared before the write
 * slot is a conflict at the absent version `0`.
 */
import type { Err, Ok, Result, StoreError } from '../types/errors.js'
import type { NonEmptyString, Version } from '../types/ids.js'
import { nonEmptyString as parseNonEmptyString, version as parseVersion } from '../parsers.js'
import { DOMAIN_TABLES, DomainStoreFailure } from './storage-domain.js'
import type { DomainRow, DomainStore, DomainTable, DomainWrite } from './storage-domain.js'

/** DSH's `UNIT_NAME_RE`; a value that fails it is rejected by `defineDomain`. */
export const DSH_TABLE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/

/**
 * The `aleph_research` table names as declared on the DSH domain.
 *
 * These are the defaults the domain note already fixes; the identity mapping is safe
 * because every logical name matches `DSH_TABLE_NAME_PATTERN`. Kept as an explicit table
 * so a host can reuse it when building `defineDomain({ tables: ... })`.
 */
export const DEFAULT_DSH_TABLE_NAMES: Readonly<Record<DomainTable, string>> = {
  programs: 'programs',
  issues: 'issues',
  experiments: 'experiments',
  tickets: 'tickets',
  issue_comments: 'issue_comments',
  experiment_reviews: 'experiment_reviews',
  ci_records: 'ci_records',
  artifacts: 'artifacts',
  attention: 'attention',
  audit: 'audit',
}

/** Optional logical-to-physical table rename; omitted tables keep their default. */
export type DshTableNameOverrides = Readonly<Partial<Record<DomainTable, string>>>

/**
 * The version envelope persisted for every row.
 *
 * `version` is validated and mapped to the domain `Version` on read. `value` is optional
 * in the structural type for two reasons: DSH's zod schema may infer `value?: unknown`
 * (so a declared handle stays assignable), and an envelope whose `value` was `undefined`
 * round-trips through JSON without the key. The store reads an absent `value` as `undefined`
 * and always writes the key itself.
 */
export interface DshVersionEnvelope {
  readonly version: number
  readonly value?: unknown
}

/**
 * The subset of DSH's `KvTable` handle this store uses.
 *
 * Methods mirror the observed runtime exactly; see the module note for the mapping. The
 * handle's value type must be the version envelope, so `get`/`update` return it directly.
 */
export interface DshDomainTableLike {
  get(key: string): DshVersionEnvelope | undefined
  entries(): Iterable<readonly [string, DshVersionEnvelope]>
  put(key: string, value: DshVersionEnvelope): Promise<void>
  delete(key: string): Promise<boolean>
  update(
    key: string,
    transform: (current: DshVersionEnvelope) => DshVersionEnvelope,
  ): Promise<DshVersionEnvelope>
}

/** The subset of DSH's opened `Domain` handle this store uses. */
export interface DshDomainLike {
  table(name: string): DshDomainTableLike
}

/** A validated envelope, with the raw `number` parsed into the domain `Version`. */
interface StoredEnvelope {
  readonly version: Version
  readonly value: unknown
}

/** The version a first save or a create expects. */
const INITIAL_VERSION: Version = initialVersion()

/**
 * Create the `DomainStore` seam over one opened `aleph_research` domain.
 *
 * The resolved table handles are opened eagerly, so a domain that does not declare every
 * table (or a rename that collides) fails at wiring time. Writes are serialized per store
 * instance; see the module note for the process-boundary limits. No `transaction` is
 * exposed, so `createStorageDomainUnitOfWork` uses its snapshot/rollback compensation.
 */
export function createDshDomainStore(
  domain: DshDomainLike,
  tableNames: DshTableNameOverrides = {},
): DomainStore {
  const resolved = resolveDshTableNames(tableNames)
  const handles = new Map<DomainTable, DshDomainTableLike>()
  for (const entry of resolved) {
    handles.set(entry[0], openTable(domain, entry[0], entry[1]))
  }

  // Tail of the per-store write chain. Every link settles, so one rejected write cannot
  // strand the writes queued behind it.
  let queue: Promise<void> = Promise.resolve()

  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const started = queue.then(work, work)
    queue = started.then(noop, noop)
    return started
  }

  function handleOf(table: DomainTable): DshDomainTableLike {
    const handle = handles.get(table)
    if (handle === undefined) {
      // Unreachable: `createDshDomainStore` resolves every `DomainTable`.
      throw new Error(`dsh domain store: logical table '${table}' has no resolved DSH table`)
    }
    return handle
  }

  return {
    list(table) {
      return Promise.resolve().then(() => listRows(handleOf(table), table))
    },

    get(table, key) {
      return Promise.resolve().then(() => readRow(handleOf(table), table, key))
    },

    put(table, key, value, expected) {
      const handle = handleOf(table)
      return serialize(() => writeRow(handle, table, key, value, expected))
    },

    delete(table, key) {
      const handle = handleOf(table)
      return serialize(() => deleteRow(handle, key))
    },
  }
}

/**
 * Resolve and validate the logical-to-physical table mapping.
 *
 * Every resolved name must match `DSH_TABLE_NAME_PATTERN`, and the mapping must be
 * one-to-one so two logical tables cannot see each other's rows.
 */
export function resolveDshTableNames(
  tableNames: DshTableNameOverrides = {},
): ReadonlyMap<DomainTable, string> {
  const resolved = new Map<DomainTable, string>()
  const owners = new Map<string, DomainTable>()
  for (const table of DOMAIN_TABLES) {
    const name = tableNames[table] ?? DEFAULT_DSH_TABLE_NAMES[table]
    if (!DSH_TABLE_NAME_PATTERN.test(name)) {
      throw new Error(
        `dsh domain store: table name '${name}' for logical table '${table}' must match ${DSH_TABLE_NAME_PATTERN.source}`,
      )
    }
    const owner = owners.get(name)
    if (owner !== undefined) {
      throw new Error(
        `dsh domain store: logical tables '${owner}' and '${table}' both map to DSH table '${name}'`,
      )
    }
    owners.set(name, table)
    resolved.set(table, name)
  }
  return resolved
}

/** Resolve one declared table handle, translating DSH's error into a wiring failure. */
function openTable(domain: DshDomainLike, table: DomainTable, name: string): DshDomainTableLike {
  try {
    return domain.table(name)
  } catch (error) {
    throw new Error(
      `dsh domain store: the domain does not expose table '${name}' for logical table '${table}': ${describeFailure(error)}`,
      { cause: error },
    )
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Read every stored row; a corrupt envelope throws `DomainStoreFailure`. */
function listRows(handle: DshDomainTableLike, table: DomainTable): readonly DomainRow[] {
  try {
    const rows: DomainRow[] = []
    for (const entry of handle.entries()) {
      const envelope = readEnvelope(entry[1], table, entry[0])
      if (!envelope.ok) throw new DomainStoreFailure(envelope.error)
      rows.push(toRow(table, entry[0], envelope.value))
    }
    return rows
  } catch (error) {
    if (error instanceof DomainStoreFailure) throw error
    throw new DomainStoreFailure(ioFailure(error))
  }
}

/** Read one stored row; an absent key is `undefined` and a corrupt envelope throws. */
function readRow(
  handle: DshDomainTableLike,
  table: DomainTable,
  key: string,
): DomainRow | undefined {
  let raw: unknown
  try {
    raw = handle.get(key)
  } catch (error) {
    throw new DomainStoreFailure(ioFailure(error))
  }
  if (raw === undefined) return undefined
  const envelope = readEnvelope(raw, table, key)
  if (!envelope.ok) throw new DomainStoreFailure(envelope.error)
  return toRow(table, key, envelope.value)
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Read the current envelope, then create or compare-and-set it. Runs on the store queue. */
async function writeRow(
  handle: DshDomainTableLike,
  table: DomainTable,
  key: string,
  value: unknown,
  expected: Version,
): Promise<Result<DomainWrite, StoreError>> {
  let raw: unknown
  try {
    raw = handle.get(key)
  } catch (error) {
    return err(ioFailure(error))
  }
  if (raw === undefined) return createRow(handle, table, key, value, expected)
  const current = readEnvelope(raw, table, key)
  if (!current.ok) return err(current.error)
  const actual = current.value.version
  // Fast path: the row is already past the expected version. The transform below repeats
  // this comparison at the write slot, where it is authoritative.
  if (actual !== expected) return err({ kind: 'version-conflict', expected, actual })
  return updateRow(handle, table, key, value, expected, actual)
}

/**
 * Create a row with `put`, after the caller established that the key is absent.
 *
 * A non-initial `expected` means the caller believed the row exists; the absent row is
 * reported as a conflict at version `0` instead of silently creating it.
 */
async function createRow(
  handle: DshDomainTableLike,
  table: DomainTable,
  key: string,
  value: unknown,
  expected: Version,
): Promise<Result<DomainWrite, StoreError>> {
  if (expected !== INITIAL_VERSION) {
    return err({ kind: 'version-conflict', expected, actual: INITIAL_VERSION })
  }
  const next = incrementVersion(INITIAL_VERSION)
  if (!next.ok) return err(next.error)
  const envelope: DshVersionEnvelope = { version: next.value, value }
  try {
    await handle.put(key, envelope)
  } catch (error) {
    return err(ioFailure(error))
  }
  return ok({ version: next.value, etag: etagFor(table, key, next.value) })
}

/**
 * Compare-and-set an existing row through the DSH `update` transform.
 *
 * The pre-check in `writeRow` is an optimization; the authoritative comparison is the one
 * inside the transform, which runs after every earlier write on the domain chain. A thrown
 * `DshWriteAbort` aborts the DSH write and carries the `StoreError` back out.
 */
async function updateRow(
  handle: DshDomainTableLike,
  table: DomainTable,
  key: string,
  value: unknown,
  expected: Version,
  actual: Version,
): Promise<Result<DomainWrite, StoreError>> {
  const next = incrementVersion(actual)
  if (!next.ok) return err(next.error)
  const envelope: DshVersionEnvelope = { version: next.value, value }
  try {
    await handle.update(key, (current) => {
      const stored = readEnvelope(current, table, key)
      if (!stored.ok) throw new DshWriteAbort(stored.error)
      if (stored.value.version !== expected) {
        throw new DshWriteAbort({
          kind: 'version-conflict',
          expected,
          actual: stored.value.version,
        })
      }
      return envelope
    })
  } catch (error) {
    if (error instanceof DshWriteAbort) return err(error.storeError)
    if (missingKeyFailure(error)) {
      // The row disappeared between the pre-check and the write slot: missing means the
      // absent-row version, `0`.
      return err({ kind: 'version-conflict', expected, actual: INITIAL_VERSION })
    }
    return err(ioFailure(error))
  }
  return ok({ version: next.value, etag: etagFor(table, key, next.value) })
}

/** Delete a row; an absent key is an idempotent success, matching the `DomainStore` port. */
async function deleteRow(
  handle: DshDomainTableLike,
  key: string,
): Promise<Result<void, StoreError>> {
  try {
    await handle.delete(key)
  } catch (error) {
    return err(ioFailure(error))
  }
  return okVoid()
}

/**
 * Sentinel thrown inside a DSH `update` transform to abort the write.
 *
 * DSH does not write when the transform throws, but it also does not distinguish the
 * reason; this class carries the `StoreError` back to the caller unchanged.
 */
class DshWriteAbort extends Error {
  readonly storeError: StoreError

  constructor(error: StoreError) {
    super(describeStoreError(error))
    this.name = 'DshWriteAbort'
    this.storeError = error
  }
}

// ---------------------------------------------------------------------------
// Envelopes and rows
// ---------------------------------------------------------------------------

/** Validate a stored value as a version envelope; a malformed one becomes `corrupt`. */
function readEnvelope(
  raw: unknown,
  table: DomainTable,
  key: string,
): Result<StoredEnvelope, StoreError> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return corrupt(`dsh domain store: row ${table}/${key} is not a version envelope`)
  }
  const parsed = parseVersion(readField(raw, 'version'))
  if (!parsed.ok) {
    return corrupt(
      `dsh domain store: row ${table}/${key} has an invalid version: ${parsed.error.message}`,
    )
  }
  return ok({ version: parsed.value, value: readField(raw, 'value') })
}

/** Project one validated envelope onto the port's row shape. */
function toRow(table: DomainTable, key: string, envelope: StoredEnvelope): DomainRow {
  return {
    key,
    value: envelope.value,
    version: envelope.version,
    etag: etagFor(table, key, envelope.version),
  }
}

/**
 * Synthesize the diagnostic etag DSH does not provide.
 *
 * It is derived from the envelope version, so it changes on every accepted write and lets
 * a caller compare tokens for diagnostics only; the store never uses it for correctness.
 */
function etagFor(table: DomainTable, key: string, version: Version): string {
  return `${table}/${key}@${version}`
}

/** Read one property from an already-narrowed object without asserting a row type. */
function readField(target: object, key: string): unknown {
  const value: unknown = Reflect.get(target, key)
  return value
}

// ---------------------------------------------------------------------------
// Versions and errors
// ---------------------------------------------------------------------------

/** The next version; a value that cannot be represented is a corrupt row. */
function incrementVersion(version: Version): Result<Version, StoreError> {
  const parsed = parseVersion(version + 1)
  if (parsed.ok) return ok(parsed.value)
  return corrupt(`dsh domain store: version ${version} cannot be incremented`)
}

function initialVersion(): Version {
  const parsed = parseVersion(0)
  if (parsed.ok) return parsed.value
  throw new Error('dsh domain store: 0 is not a valid Version')
}

/** Map an underlying DSH failure to the port's `io` kind, keeping its message. */
function ioFailure(error: unknown): StoreError {
  return { kind: 'io', message: toMessage(describeFailure(error)) }
}

/** Describe a thrown value, including a DSH `DomainError`/`StorageError` code when present. */
function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    const code = errorCode(error)
    const text = error.message.length > 0 ? error.message : 'no error message'
    return code === undefined ? text : `${code}: ${text}`
  }
  return 'unknown DSH storage failure'
}

function errorCode(error: Error): string | undefined {
  const code = readField(error, 'code')
  return typeof code === 'string' ? code : undefined
}

/** DSH rejects `update` on an absent key with `DomainError('missing-key')`. */
function missingKeyFailure(error: unknown): boolean {
  return error instanceof Error && errorCode(error) === 'missing-key'
}

function corrupt(message: string): Err<StoreError> {
  return err({ kind: 'corrupt', message: toMessage(message) })
}

/** Mint a `NonEmptyString` message; parser failures carry their own message. */
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

function ok<T>(value: T): Ok<T> {
  return { ok: true, value }
}

function okVoid(): Ok<void> {
  return { ok: true, value: undefined }
}

function err<E>(error: E): Err<E> {
  return { ok: false, error }
}

/** Settles the queue tail without propagating the write's outcome. */
function noop(): void {
  // The caller observes the write's own promise; the queue only needs a settled link.
}
