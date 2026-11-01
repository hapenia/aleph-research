/**
 * Tests for the DSH storage-domain plugin.
 *
 * The fake domain mirrors the observed DSH table handle used by
 * `research-core/test/dsh-domain-store.test.ts`: synchronous `get`/`entries`, durable
 * `put`/`delete`/`update` promises that yield a microtask before committing, and an
 * `update` on an absent key rejecting with `DomainError('missing-key')`. The fake
 * `storageDomain` facility records the opened spec, and the fake context records the
 * fiber effect and the provided service, so the plugin is exercised without the DSH
 * payload.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ALEPH_RESEARCH_DOMAIN,
  ALEPH_RESEARCH_DOMAIN_VERSION,
  ALEPH_RESEARCH_TABLES,
  RESEARCH_ROW_SCHEMA,
  STORE_SERVICE_NAME,
  alephResearchDomainSpec,
  apply,
  createResearchDomainStore,
  defineResearchDomain,
  inject,
  name,
  parseResearchStorageConfig,
} from '../research-storage.js'
import { DEFAULT_DSH_TABLE_NAMES } from '../../research-core/dist/adapter/dsh-domain-store.js'
import { DOMAIN_TABLES } from '../../research-core/dist/adapter/storage-domain.js'

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function expectOk(result, context) {
  assert.equal(result.ok, true, `${context}: expected Ok`)
  if (!result.ok) throw new Error(`${context}: expected Ok`)
  return result.value
}

function expectErr(result, context) {
  assert.equal(result.ok, false, `${context}: expected Err`)
  if (result.ok) throw new Error(`${context}: expected Err`)
  return result.error
}

// ---------------------------------------------------------------------------
// Fake DSH domain
// ---------------------------------------------------------------------------

/** Mirrors DSH's `DomainError` shape: a stable `code` plus a message. */
class FakeDomainError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'DomainError'
    this.code = code
  }
}

class FakeTable {
  records = new Map()

  get(key) {
    return this.records.get(key)
  }

  entries() {
    return this.records.entries()
  }

  async put(key, value) {
    // Yield one microtask before committing: the write is in flight, not yet visible.
    await Promise.resolve()
    this.records.set(key, value)
  }

  async delete(key) {
    await Promise.resolve()
    return this.records.delete(key)
  }

  async update(key, transform) {
    await Promise.resolve()
    const current = this.records.get(key)
    if (current === undefined) throw new FakeDomainError('missing-key', `no record '${key}'`)
    const next = transform(current)
    this.records.set(key, next)
    return next
  }

  seed(key, value, version = 1) {
    this.records.set(key, { version, value })
  }
}

class FakeDomain {
  tables = new Map()
  requested = []
  missing = new Set()
  closed = false

  table(tableName) {
    this.requested.push(tableName)
    if (this.missing.has(tableName)) {
      throw new FakeDomainError('missing-table', `domain declares no table '${tableName}'`)
    }
    const existing = this.tables.get(tableName)
    if (existing !== undefined) return existing
    const created = new FakeTable()
    this.tables.set(tableName, created)
    return created
  }

  /** Access an already-resolved table without recording another `domain.table` call. */
  peek(tableName) {
    return this.tables.get(tableName)
  }

  async close() {
    this.closed = true
  }
}

/** Build a Cordis-like context backed by one fake domain. */
function makeContext(domain) {
  const opened = []
  const effects = []
  const services = new Map()
  const ctx = {
    storageDomain: {
      async open(spec) {
        opened.push(spec)
        return domain
      },
    },
    effect(execute, label) {
      const dispose = execute()
      const entry = { dispose, label }
      effects.push(entry)
      return () => {
        const index = effects.indexOf(entry)
        if (index !== -1) effects.splice(index, 1)
        return dispose()
      }
    },
    provide(serviceName, value) {
      services.set(serviceName, value)
      return () => services.delete(serviceName)
    },
  }
  return { ctx, opened, effects, services }
}

function tableOf(domain, tableName) {
  const table = domain.peek(tableName)
  if (table === undefined) throw new Error(`test expected the domain to expose table '${tableName}'`)
  return table
}

// ---------------------------------------------------------------------------
// Plugin metadata and declaration
// ---------------------------------------------------------------------------

test('exports the Cordis plugin metadata for the actual storage service', () => {
  assert.equal(name, 'aleph-research-storage')
  assert.deepEqual(inject, ['storageDomain'])
  assert.equal(ALEPH_RESEARCH_DOMAIN, 'aleph_research')
  assert.equal(ALEPH_RESEARCH_DOMAIN_VERSION, 1)
  assert.equal(STORE_SERVICE_NAME, 'alephResearchStore')
})

test('declares exactly the ten tables required by the compiled store', () => {
  assert.deepEqual(ALEPH_RESEARCH_TABLES, DOMAIN_TABLES)
  assert.deepEqual(Object.keys(DEFAULT_DSH_TABLE_NAMES), DOMAIN_TABLES)
  assert.deepEqual(Object.keys(alephResearchDomainSpec.tables), DOMAIN_TABLES)
  assert.equal(alephResearchDomainSpec.name, ALEPH_RESEARCH_DOMAIN)
  assert.equal(alephResearchDomainSpec.version, ALEPH_RESEARCH_DOMAIN_VERSION)
  assert.equal(Object.isFrozen(alephResearchDomainSpec), true)
  assert.equal(Object.isFrozen(alephResearchDomainSpec.tables), true)
})

test('every table carries the same version-envelope schema', () => {
  for (const tableName of DOMAIN_TABLES) {
    const table = alephResearchDomainSpec.tables[tableName]
    assert.ok(table, `table ${tableName} is declared`)
    assert.equal(table.valueSchema, RESEARCH_ROW_SCHEMA, `table ${tableName} uses the envelope schema`)
  }

  const parsed = RESEARCH_ROW_SCHEMA.safeParse({ version: 0 })
  assert.equal(parsed.success, true)
  if (parsed.success) assert.deepEqual(parsed.data, { version: 0 })

  const withValue = RESEARCH_ROW_SCHEMA.safeParse({ version: 3, value: { id: 'program-1' } })
  assert.equal(withValue.success, true)
  if (withValue.success) assert.deepEqual(withValue.data, { version: 3, value: { id: 'program-1' } })
})

test('the envelope rejects malformed rows', () => {
  const malformed = [
    null,
    [],
    {},
    { version: -1 },
    { version: 1.5 },
    { version: Number.NaN },
    { version: Number.POSITIVE_INFINITY },
    { version: '1' },
    { value: { id: 'program-1' } },
  ]
  for (const row of malformed) {
    assert.equal(
      RESEARCH_ROW_SCHEMA.safeParse(row).success,
      false,
      `expected ${String(row)} to fail the envelope schema`,
    )
  }
})

test('renames physical tables and refuses unsafe or colliding names', () => {
  const renamed = defineResearchDomain({ programs: 'research_programs' })
  assert.deepEqual(Object.keys(renamed.tables), [
    'research_programs',
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
  assert.equal(Object.keys(renamed.tables).length, DOMAIN_TABLES.length)

  assert.throws(() => defineResearchDomain({ programs: 'Programs' }), /must match/)
  assert.throws(
    () => defineResearchDomain({ programs: 'shared', issues: 'shared' }),
    /both map to DSH table 'shared'/,
  )
})

test('config validation defaults, accepts known renames and refuses unknown keys', () => {
  assert.deepEqual(parseResearchStorageConfig(undefined), {})
  assert.deepEqual(parseResearchStorageConfig({}), {})
  assert.deepEqual(parseResearchStorageConfig({ tableNames: { programs: 'research_programs' } }), {
    tableNames: { programs: 'research_programs' },
  })
  assert.throws(() => parseResearchStorageConfig({ tableNames: { bogus: 'table' } }), /invalid config/)
  assert.throws(() => parseResearchStorageConfig({ unknown: true }), /invalid config/)
})

// ---------------------------------------------------------------------------
// Plugin apply
// ---------------------------------------------------------------------------

test('the plugin opens the declared domain, provides the store and closes on disposal', async () => {
  const domain = new FakeDomain()
  const { ctx, opened, effects, services } = makeContext(domain)

  await apply(ctx)

  assert.equal(opened.length, 1)
  const spec = opened[0]
  assert.equal(spec, alephResearchDomainSpec)
  assert.equal(spec.name, ALEPH_RESEARCH_DOMAIN)
  assert.equal(spec.version, ALEPH_RESEARCH_DOMAIN_VERSION)
  assert.deepEqual(Object.keys(spec.tables), DOMAIN_TABLES)
  assert.deepEqual(domain.requested, DOMAIN_TABLES)

  const store = services.get(STORE_SERVICE_NAME)
  assert.ok(store, `the plugin provides ${STORE_SERVICE_NAME}`)
  for (const method of ['list', 'get', 'put', 'delete']) {
    assert.equal(typeof store[method], 'function', `store has ${method}`)
  }

  assert.equal(effects.length, 1)
  assert.match(effects[0].label, /close/)
  await effects[0].dispose()
  assert.equal(domain.closed, true)
})

test('the plugin applies configured table renames to both declaration and store', async () => {
  const domain = new FakeDomain()
  const { ctx, opened, services } = makeContext(domain)

  await apply(ctx, { tableNames: { programs: 'research_programs' } })

  const spec = opened[0]
  assert.equal(Object.keys(spec.tables).includes('programs'), false)
  assert.equal(Object.keys(spec.tables).includes('research_programs'), true)
  assert.equal(Object.keys(spec.tables).length, DOMAIN_TABLES.length)

  const store = services.get(STORE_SERVICE_NAME)
  const created = expectOk(
    await store.put('programs', 'program-1', { id: 'program-1' }, 0),
    'create under a renamed table',
  )
  assert.equal(created.version, 1)
  assert.deepEqual(tableOf(domain, 'research_programs').records.get('program-1'), {
    version: 1,
    value: { id: 'program-1' },
  })
  assert.equal(await store.get('programs', 'program-1').then((row) => row?.key), 'program-1')
})

// ---------------------------------------------------------------------------
// Factory over a fake domain
// ---------------------------------------------------------------------------

test('the factory round-trips create, read and compare-and-set through the fake domain', async () => {
  const domain = new FakeDomain()
  const store = createResearchDomainStore(domain)
  assert.deepEqual(domain.requested, DOMAIN_TABLES)

  assert.equal(await store.get('programs', 'program-1'), undefined)

  const created = expectOk(
    await store.put('programs', 'program-1', { id: 'program-1', status: 'running' }, 0),
    'create',
  )
  assert.equal(created.version, 1)
  assert.equal(created.etag, 'programs/program-1@1')

  assert.deepEqual(await store.get('programs', 'program-1'), {
    key: 'program-1',
    value: { id: 'program-1', status: 'running' },
    version: 1,
    etag: 'programs/program-1@1',
  })

  const updated = expectOk(
    await store.put('programs', 'program-1', { id: 'program-1', status: 'done' }, 1),
    'update',
  )
  assert.equal(updated.version, 2)

  const stale = expectErr(
    await store.put('programs', 'program-1', { id: 'program-1', status: 'failed' }, 1),
    'stale update',
  )
  assert.equal(stale.kind, 'version-conflict')
  assert.equal(stale.expected, 1)
  assert.equal(stale.actual, 2)

  const listed = await store.list('programs')
  assert.equal(listed.length, 1)
  assert.deepEqual(listed[0].value, { id: 'program-1', status: 'done' })

  const missing = expectErr(
    await store.put('issues', 'issue-1', { id: 'issue-1' }, 1),
    'create with a non-initial expected version',
  )
  assert.equal(missing.kind, 'version-conflict')
  assert.equal(missing.expected, 1)
  assert.equal(missing.actual, 0)

  expectOk(await store.delete('programs', 'program-1'), 'delete')
  assert.equal(await store.get('programs', 'program-1'), undefined)
  expectOk(await store.delete('programs', 'program-1'), 'idempotent delete')
})

test('a domain missing a declared table fails at wiring time with a clear error', () => {
  const domain = new FakeDomain()
  domain.missing.add('audit')

  assert.throws(
    () => createResearchDomainStore(domain),
    (error) => error instanceof Error
      && error.message.includes("does not expose table 'audit'")
      && error.message.includes("logical table 'audit'"),
  )
})

test('the plugin refuses to open when the domain is missing a declared table', async () => {
  const domain = new FakeDomain()
  domain.missing.add('attention')
  const { ctx, effects } = makeContext(domain)

  await assert.rejects(apply(ctx), /does not expose table 'attention'/)
  for (const effect of effects) await effect.dispose()
  assert.equal(domain.closed, true)
})
