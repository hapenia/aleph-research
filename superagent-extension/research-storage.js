// TODO(@case-migration-live-run): this seam is not part of a verified end-to-end path yet; do not claim completion.
/**
 * DSH storage-domain form of AlephResearch state.
 *
 * This module is the host-side composition seam between the installed DSH
 * storage-domain package and `research-core`'s `DomainStore` port: it declares the
 * `aleph_research` domain with the ten version-envelope tables, opens it through the
 * DSH domain facility, and wraps the opened domain with `createDshDomainStore` from the
 * compiled runtime.
 *
 * ## DSH API mapping
 *
 * Observed in the installed payload
 * `@deepseek-ai/dsh-storage-domain@0.2.2-alpha.2` (`lib/index.js`) and
 * `@deepseek-ai/dsh-storage@0.2.2-alpha.2`:
 *
 * | Here | Installed package | Notes |
 * | --- | --- | --- |
 * | `inject = ['storageDomain']` | The `storage-domain` plugin calls `ctx.provide('storageDomain', facility)`. | The prompt's sketch said `['storage']`; the actual consumable service is `storageDomain`. `storage` is the hub (backend registry plus mounted forms) and is injected by `storage-domain`, not by this plugin. |
 * | `ctx.storageDomain.open(spec)` | `DomainFacility.open(spec): Promise<Domain>` | Asynchronous. There is no `ctx.storage.domain(name)` method. The caller owns the returned handle and closes it with `domain.close()`. |
 * | `domain.table(name)` | `Domain.table(name)` | Resolves one declared table; an undeclared name throws. Handled inside `createDshDomainStore`. |
 * | `ctx.provide(STORE_SERVICE_NAME, store)` | `ctx.provide(name, value)` | Exposes the opened `DomainStore` as the `alephResearchStore` service. Provided services are disposed with the plugin fiber. |
 * | domain backend route | `storage-domain` `Config` | `ctx.storage` never chooses a backend for us: the host mounts `storage-domain` with `{ backend: '<name>' }` (and optional `routes`), and mounts the corresponding backend such as `@deepseek-ai/dsh-storage-json` (`{"backend":"json"}`). |
 *
 * `defineDomain` and `domainTable` are deliberately not imported. The installed package
 * ships only `lib/index.js`; its `types` entry points at a missing
 * `lib/types/index.d.ts`, and the package is not a dependency of
 * `superagent-extension`, so a static import would neither typecheck nor resolve in the
 * repository's test environment. The runtime contract is small and stable:
 * `domainTable(schema)` returns exactly `{ valueSchema: schema }`, and `defineDomain`
 * validates the domain name, a non-negative integer version, and table names against
 * DSH's `UNIT_NAME_RE` (`/^[a-z][a-z0-9_]*$/`). This module uses the installed zod
 * (4.4.3) for the record schema and mirrors those declaration checks locally, so the
 * spec it builds is structurally the spec `defineDomain` would return and can be passed
 * to `ctx.storageDomain.open`.
 *
 * ## Version envelope
 *
 * Every one of the ten tables uses the same schema:
 *
 * ```text
 * { version: number (integer, >= 0), value?: unknown }
 * ```
 *
 * `createDshDomainStore` persists that envelope per row itself: a create writes
 * version `1` after proving the key is absent, an update compares the stored version
 * with the caller's expected version inside the DSH `update` transform and writes
 * `version + 1`. The domain declaration validates the envelope when the domain opens,
 * so a malformed medium is refused before the store sees it; the store validates it
 * again and reports `StoreError('corrupt')`.
 *
 * ## Table set and ordering
 *
 * The ten logical tables are exactly `DOMAIN_TABLES` in
 * `research-core/src/adapter/storage-domain.ts`; the defaults are identity names and the
 * test asserts parity with the compiled runtime. A `tableNames` config entry renames the
 * physical DSH table while `createDshDomainStore` keeps the logical name, so callers
 * always use `programs`, `issues`, ... regardless of the medium's table names.
 *
 * No `layout` is declared, so the JSON backend's default `single` layout applies and
 * preserves object key order; the audit and other append tables rely on
 * `DomainStore.list` returning insertion order. Routing this domain to a layout that
 * does not preserve order (or to SQLite) makes audit ordering the host's problem; the
 * adapter note `docs/notes/storage-domain-adapter.md` records that limit.
 *
 * ## Prerequisite
 *
 * `createResearchDomainStore` imports `../research-core/dist/adapter/dsh-domain-store.js`.
 * Build `research-core` (`npm run build`) before loading this plugin when `dist/` is
 * absent or stale.
 */
import { z } from 'zod'

import {
  createDshDomainStore,
  resolveDshTableNames,
} from '../research-core/dist/adapter/dsh-domain-store.js'

/** Cordis plugin name. */
export const name = 'aleph-research-storage'

/**
 * The service this plugin consumes.
 *
 * DSH's storage hub (`ctx.storage`) does not expose domains; `storage-domain` mounts
 * `ctx.storageDomain` and this plugin opens its domain there.
 */
export const inject = ['storageDomain']

/** The domain name shared with `research-core`'s storage adapter. */
export const ALEPH_RESEARCH_DOMAIN = 'aleph_research'

/**
 * Domain schema version.
 *
 * Bump it only with a compatible data story: an installed backend refuses a stored unit
 * whose version is outside `{version} ∪ compatibleVersions`.
 */
export const ALEPH_RESEARCH_DOMAIN_VERSION = 1

/**
 * The ten logical tables required by `createDshDomainStore`, in snapshot order.
 *
 * These names are the `DomainTable` union of `research-core/src/adapter/storage-domain.ts`.
 * The first four hold versioned aggregates; the remaining six are record/append tables.
 */
export const ALEPH_RESEARCH_TABLES = Object.freeze([
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
])

/** The service that carries the opened `DomainStore`. */
export const STORE_SERVICE_NAME = 'alephResearchStore'

/**
 * DSH's `UNIT_NAME_RE`, copied from `@deepseek-ai/dsh-storage` so the declaration
 * checks match `defineDomain` without importing the package.
 */
const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/

/**
 * The version envelope stored in every table.
 *
 * `value` stays `unknown`: the store treats rows as opaque data and `research-core`
 * validates hydrated rows itself. `value` is optional because an envelope whose value
 * is `undefined` cannot carry the key through JSON, and the compiled store reads an
 * absent `value` as `undefined`.
 */
export const RESEARCH_ROW_SCHEMA = z.object({
  version: z.number().int().nonnegative(),
  value: z.unknown().optional(),
})

/**
 * The subset of an opened DSH domain this plugin uses.
 *
 * @typedef {object} OpenedDomain
 * @property {(table: string) => unknown} table Resolves a declared table handle.
 * @property {() => Promise<void>} close Releases the unit; the facility frees the name.
 */

/**
 * Declare one table exactly like `domainTable` from `@deepseek-ai/dsh-storage-domain`.
 *
 * @param {object} schema - The zod record schema of the table.
 * @returns {{ valueSchema: object }} The table declaration.
 */
function domainTable(schema) {
  return { valueSchema: schema }
}

/**
 * Declare the `aleph_research` domain spec.
 *
 * The checks mirror `defineDomain` from the installed package: the name and every
 * resolved table name must match `UNIT_NAME_RE`, and the version must be a
 * non-negative integer. `resolveDshTableNames` additionally validates the optional
 * logical-to-physical renames and refuses two logical tables sharing one physical
 * table, so an override fails at wiring time rather than mixing rows.
 *
 * @param {Readonly<Record<string, string>>} [tableNames] - Optional physical-name
 *   overrides keyed by logical table (`programs`, `issues`, ...).
 * @returns {{
 *   name: string,
 *   version: number,
 *   tables: Readonly<Record<string, { valueSchema: object }>>,
 * }} The frozen domain declaration accepted by `ctx.storageDomain.open`.
 */
export function defineResearchDomain(tableNames = {}) {
  const resolved = resolveDshTableNames(tableNames)
  /** @type {Record<string, { valueSchema: object }>} */
  const tables = {}
  for (const table of ALEPH_RESEARCH_TABLES) {
    const physical = resolved.get(table)
    if (physical === undefined) {
      // Unreachable: `resolveDshTableNames` resolves every logical table.
      throw new Error(`aleph-research-storage: no DSH table resolved for logical table '${table}'`)
    }
    tables[physical] = domainTable(RESEARCH_ROW_SCHEMA)
  }

  assertDomainSpec(ALEPH_RESEARCH_DOMAIN, ALEPH_RESEARCH_DOMAIN_VERSION, tables)
  Object.freeze(tables)
  return Object.freeze({
    name: ALEPH_RESEARCH_DOMAIN,
    version: ALEPH_RESEARCH_DOMAIN_VERSION,
    tables,
  })
}

/**
 * The default declaration, opened unless the plugin config renames a table.
 *
 * Declaring it at module load makes a bad declaration fail before any medium is
 * touched, the same timing `defineDomain` gives its owning package.
 */
export const alephResearchDomainSpec = defineResearchDomain()

/**
 * Validate a declaration the way `defineDomain` does.
 *
 * @param {string} domain - Domain name.
 * @param {number} version - Declared version.
 * @param {Readonly<Record<string, unknown>>} tables - Declared table map.
 */
function assertDomainSpec(domain, version, tables) {
  if (!UNIT_NAME_RE.test(domain)) {
    throw new Error(`domain name '${domain}' must match ${UNIT_NAME_RE}`)
  }
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`domain '${domain}' version must be a non-negative integer, got ${version}`)
  }
  for (const table of Object.keys(tables)) {
    if (!UNIT_NAME_RE.test(table)) {
      throw new Error(`domain '${domain}' table name '${table}' must match ${UNIT_NAME_RE}`)
    }
  }
}

/**
 * Plugin config.
 *
 * `tableNames` mirrors the second parameter of `createDshDomainStore`: a partial map
 * from a logical table to a different physical DSH table name. Unknown logical names,
 * unsafe physical names and collisions are refused. A rename changes the medium's table
 * set, so changing it after data exists needs a migration; the default identity mapping
 * is the stable configuration.
 */
const RESEARCH_STORAGE_CONFIG = z
  .object({
    tableNames: z.partialRecord(z.enum(ALEPH_RESEARCH_TABLES), z.string()).optional(),
  })
  .strict()

/**
 * Validate and default the plugin config.
 *
 * @param {unknown} config - Raw Cordis plugin config.
 * @returns {{ tableNames?: Record<string, string> }} The normalized options.
 */
export function parseResearchStorageConfig(config) {
  const parsed = RESEARCH_STORAGE_CONFIG.safeParse(config ?? {})
  if (!parsed.success) {
    throw new Error(`aleph-research-storage: invalid config: ${parsed.error.message}`)
  }
  return parsed.data
}

/**
 * Create the `DomainStore` over one opened `aleph_research` domain.
 *
 * The returned object is the port `createStorageDomainUnitOfWork` expects from
 * `research-core/src/adapter/storage-domain.ts`: `list`, `get`, `put` (versioned) and
 * `delete`. It is created eagerly over every declared table, so a domain that does not
 * expose all ten tables fails here with a message naming the missing table rather than
 * on the first read.
 *
 * @param {OpenedDomain} domain The opened domain handle returned by
 *   `ctx.storageDomain.open`.
 * @param {Readonly<Record<string, string>>} [tableNames] - The same physical-name
 *   overrides passed to `defineResearchDomain`.
 * @returns {object} The opened `DomainStore` (`list`, `get`, `put`, `delete`).
 */
export function createResearchDomainStore(domain, tableNames = {}) {
  return createDshDomainStore(domain, tableNames)
}

/**
 * Mount the `aleph_research` domain and publish its store.
 *
 * Steps: open the domain through `ctx.storageDomain`, register its close as a fiber
 * effect, build the store, and provide it as `alephResearchStore`. The caller of
 * `apply` (the Cordis loader) owns this fiber; disposal closes the domain.
 *
 * @param {{
 *   storageDomain: { open(spec: object): Promise<OpenedDomain> },
 *   effect(execute: () => () => unknown, label?: string): () => unknown,
 *   provide(name: string, value: unknown): () => unknown,
 * }} ctx - The Cordis plugin context, narrowed to what this plugin uses.
 * @param {unknown} [config] - Plugin config (see `parseResearchStorageConfig`).
 * @returns {Promise<void>} Resolution once the domain is open and the service is provided.
 */
export async function apply(ctx, config) {
  const options = parseResearchStorageConfig(config)
  const spec = options.tableNames === undefined
    ? alephResearchDomainSpec
    : defineResearchDomain(options.tableNames)

  const domain = await ctx.storageDomain.open(spec)
  ctx.effect(() => () => domain.close(), 'aleph-research-storage: close aleph_research')
  const store = createResearchDomainStore(domain, options.tableNames)
  ctx.provide(STORE_SERVICE_NAME, store)
}
