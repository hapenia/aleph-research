# `aleph_research` storage-domain adapter

Status: Phase 1 adapter contract, implemented in
`research-core/src/adapter/storage-domain.ts`. This note records the DSH mapping that is
deliberately kept outside the adapter code, and the limits the adapter cannot remove.

## Seam

The adapter does not import DSH runtime packages. The installed
`@deepseek-ai/dsh-storage-domain` ships only `lib/index.js`: `package.json` points
`types` at `lib/types/index.d.ts`, but that file is absent from the payload. A type-only
import therefore fails `tsc`, and `research-core` has no DSH dependency anyway. The
adapter instead takes a minimal, domain-scoped `DomainStore`:

```ts
interface DomainStore {
  list(table: DomainTable): Promise<readonly DomainRow[]>
  get(table: DomainTable, key: string): Promise<DomainRow | undefined>
  put(table, key, value, expected: Version): Promise<Result<DomainWrite, StoreError>>
  delete(table: DomainTable, key: string): Promise<Result<void, StoreError>>
  transaction?<T>(work: () => Promise<T>): Promise<T>
}
```

`DomainRow` carries `{ key, value, version, etag }`; `version` is the optimistic token
mapped to the domain `Version` (first save expects `0`), and `etag` is opaque diagnostic
metadata. The store is scoped to one opened `aleph_research` domain, so the domain name
is not repeated on every call.

## DSH API mapping

Observed from `@deepseek-ai/dsh-storage-domain@0.2.2-alpha.2` (`lib/index.js`, README)
and `@deepseek-ai/dsh-storage@0.2.2-alpha.2`:

| `DomainStore` | DSH domain API | Notes |
| --- | --- | --- |
| `list(table)` | `[...domain.table(table).entries()]` | DSH reads are synchronous from validated in-memory state; wrap in `Promise.resolve`. |
| `get(table, key)` | `domain.table(table).get(key)` | Returns `undefined` for an absent key. |
| `put(table, key, value, expected)` | `table.update(key, current => next)` for an existing row; `table.put(key, next)` for a create | **No DSH record version exists.** The adapter must persist its own version envelope and perform the compare. `update` runs its transform at the domain write-chain slot; a thrown conflict rejects the update, which is the closest thing to a per-key CAS in one process. |
| `delete(table, key)` | `table.delete(key)` | Returns `boolean`; the adapter maps `false` to an idempotent `Ok`. |
| `transaction(work)` | none | DSH has no cross-table transaction; see the snapshot fallback below. |

The DSH table handle is `get` / `entries` / `keys` / `size` / `put` / `delete` /
`deleteMany` / `update`; `update` rejects an absent key with `DomainError('missing-key')`.
The domain is opened with `ctx.storageDomain.open(spec)`, where `spec` comes from
`defineDomain({ name: 'aleph_research', version, tables })` and each table from
`domainTable(zodSchema)`. Table names must match `^[a-z][a-z0-9_]*$`; the adapter uses
`programs`, `issues`, `experiments`, `tickets`, `issue_comments`, `experiment_reviews`,
`ci_records`, `artifacts`, `attention`, `audit`.

### Version envelope

Because DSH stores opaque JSON rows and exposes no per-record stamp, the adapter should
persist an envelope such as:

```json
{ "version": 3, "value": { "id": "program-1", "status": "running" } }
```

with a zod schema `z.object({ version: z.number().int().nonnegative(), value: z.unknown() })`.
The domain layer validates stored records when the domain opens; the envelope's `value`
is then validated again by `src/hydration.ts` when a repository reads it. A create writes
version `1` only after checking the key is absent. `update` compares `current.version`
with `expected` inside its transform; a mismatch throws a version-conflict error that the
adapter converts back into `StoreError`. The adapter should also serialize its own
read-compare-write queue per store because two callers can otherwise both read the same
current version before either queued write runs. There is no cross-process guarantee.

### Rows and keys

| Table | Key | Value |
| --- | --- | --- |
| `programs`, `issues`, `experiments`, `tickets` | aggregate id | validated nominal state encoded as a plain data row |
| `issue_comments`, `experiment_reviews`, `ci_records`, `artifacts`, `attention`, `audit` | record id | structural record |

Repositories encode class instances with a structural copy that drops methods, then
hydrate the encoded row before writing and every stored row before returning it. A row
that does not hydrate becomes `StoreError('corrupt')`: `get`/`list` throw
`DomainStoreFailure` (their port has no `Result`), while `save` and the structural
`append`s return the `Err`. DSH's zod schemas and the hydration pass are independent
checks: the first rejects a malformed medium, the second rejects a malformed domain row.

## Limits

- **No multi-table transaction.** DSH's README lists "No cross-table transactions"; each
  `put`/`delete` is durable per call and the domain write chain only orders calls. When
  `DomainStore.transaction` is absent, `createStorageDomainUnitOfWork` uses a
  snapshot/rollback adapter: it lists every table, runs the work, and on failure writes
  the old values back and deletes rows created during the work. This is compensation,
  not isolation: it is O(all rows), it can overwrite a concurrent writer, and version
  numbers are not rolled back (rollback writes produce new versions).
- **No cross-process CAS.** `domain/changed` is in-process only, and two host processes
  open the same unit without write locking. The version envelope is a single-process
  guard.
- **Append order is store order.** The audit log and other append tables rely on
  `list(table)` preserving insertion order. DSH's `single` JSON layout preserves object
  key order, but `per-record` directory enumeration and SQLite do not promise it. The
  production adapter must either order audit rows by `(at, id)` in `list` or persist an
  explicit sequence; the current adapter keeps the store's order, matching the
  in-memory reference store.
- **No indexes or queries.** Every `listByProgram`, `listByExperiment`, `comments`,
  `reviews`, `listPassed` and `query` scans the table and filters in memory. Fine for
  Phase 1 scale; not a database query layer.
- **Snapshot is not atomic.** `ProgramSnapshot` is assembled from separate table reads,
  just like the in-memory store; DSH cannot give a cross-table read snapshot.
- **No DSH types.** The seam is the contract. If a later DSH release ships `.d.ts` files,
  the `superagent-extension` can implement `DomainStore` directly against
  `Domain<KvTable>` types without changing `research-core`.

## Lint boundary

`src/adapter/storage-domain.ts` imports `src/hydration.ts` (and the reviewed parser and
principal factory for the one structural record without a hydrator). The current
`eslint.config.js` restricts those imports to the factory/hydration/parser modules; the
file carries a scoped `no-restricted-imports` disable explaining that the adapter is the
composition boundary. The adapter itself contains no `as`, `any`, type predicate or
`JSON` use; ast-grep passes. The existing `runtime/storage.ts` uses the same overload
branding convention for one metric-key conversion, and this adapter reuses it.
