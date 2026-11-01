/**
 * Contract tests for the production DSH `DomainStore` seam.
 *
 * The fake domain mirrors the observed DSH table handle (`get`/`entries` synchronous,
 * `put`/`delete`/`update` durable promises, `update` rejecting an absent key) without
 * importing the DSH package, whose type payload is missing. Its writes yield a microtask
 * before committing, so a store that did not serialize its check-then-write would fail the
 * concurrent-create test. Envelopes are seeded directly for the corruption and
 * concurrent-writer cases, which is how a malformed medium or another writer would appear.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createDshDomainStore,
  DEFAULT_DSH_TABLE_NAMES,
  DSH_TABLE_NAME_PATTERN,
  resolveDshTableNames,
} from '../src/adapter/dsh-domain-store.js'
import type {
  DshDomainLike,
  DshDomainTableLike,
  DshVersionEnvelope,
} from '../src/adapter/dsh-domain-store.js'
import { DomainStoreFailure, DOMAIN_TABLES } from '../src/adapter/storage-domain.js'
import type { DomainStore } from '../src/adapter/storage-domain.js'
import { version as parseVersion } from '../src/parsers.js'
import type { Result } from '../src/types/errors.js'
import type { Version } from '../src/types/ids.js'

// ---------------------------------------------------------------------------
// Result and branding helpers
// ---------------------------------------------------------------------------

function expectOk<T, E>(result: Result<T, E>, context: string): T {
  assert.equal(result.ok, true, `${context}: expected Ok`)
  if (!result.ok) throw new Error(`${context}: expected Ok`)
  return result.value
}

function expectErr<T, E>(result: Result<T, E>, context: string): E {
  assert.equal(result.ok, false, `${context}: expected Err`)
  if (result.ok) throw new Error(`${context}: expected Err`)
  return result.error
}

function version(value: number): Version {
  return expectOk(parseVersion(value), `version ${value}`)
}

/** Test-only stand-in for a value the storage medium could hold; tests are outside lint. */
function forged<T>(value: unknown): T {
  return value as T
}

/** Assert a read rejects with `DomainStoreFailure` and return it for inspection. */
async function failureOf(work: Promise<unknown>): Promise<DomainStoreFailure> {
  try {
    await work
  } catch (error) {
    assert.ok(error instanceof DomainStoreFailure, 'expected a DomainStoreFailure')
    if (!(error instanceof DomainStoreFailure)) throw error
    return error
  }
  assert.fail('expected the store operation to throw DomainStoreFailure')
}

// ---------------------------------------------------------------------------
// Fake DSH domain
// ---------------------------------------------------------------------------

/** Mirrors DSH's `DomainError` shape: a stable `code` plus a message. */
class FakeDomainError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'DomainError'
    this.code = code
  }
}

class FakeTable implements DshDomainTableLike {
  readonly records = new Map<string, DshVersionEnvelope>()
  gets = 0
  putAttempts = 0
  updateAttempts = 0
  deleteAttempts = 0
  readFailure: Error | undefined
  writeFailure: Error | undefined
  beforeUpdate: ((key: string) => void) | undefined

  get(key: string): DshVersionEnvelope | undefined {
    this.gets += 1
    if (this.readFailure !== undefined) throw this.readFailure
    return this.records.get(key)
  }

  entries(): Iterable<readonly [string, DshVersionEnvelope]> {
    if (this.readFailure !== undefined) throw this.readFailure
    return this.records.entries()
  }

  async put(key: string, value: DshVersionEnvelope): Promise<void> {
    // Yield one microtask before committing: the write is in flight, not yet visible.
    await Promise.resolve()
    this.putAttempts += 1
    if (this.writeFailure !== undefined) throw this.writeFailure
    this.records.set(key, value)
  }

  async delete(key: string): Promise<boolean> {
    await Promise.resolve()
    this.deleteAttempts += 1
    if (this.writeFailure !== undefined) throw this.writeFailure
    return this.records.delete(key)
  }

  async update(
    key: string,
    transform: (current: DshVersionEnvelope) => DshVersionEnvelope,
  ): Promise<DshVersionEnvelope> {
    await Promise.resolve()
    this.updateAttempts += 1
    if (this.writeFailure !== undefined) throw this.writeFailure
    if (this.beforeUpdate !== undefined) this.beforeUpdate(key)
    const current = this.records.get(key)
    if (current === undefined) throw new FakeDomainError('missing-key', `no record '${key}'`)
    const next = transform(current)
    this.records.set(key, next)
    return next
  }

  seed(key: string, value: unknown, versionNumber = 1): void {
    this.records.set(key, { version: versionNumber, value })
  }

  seedRaw(key: string, raw: unknown): this {
    this.records.set(key, forged<DshVersionEnvelope>(raw))
    return this
  }
}

class FakeDomain implements DshDomainLike {
  private readonly tables = new Map<string, FakeTable>()
  readonly requested: string[] = []
  readonly missing = new Set<string>()

  table(name: string): FakeTable {
    this.requested.push(name)
    if (this.missing.has(name)) {
      throw new FakeDomainError('missing-table', `domain declares no table '${name}'`)
    }
    const existing = this.tables.get(name)
    if (existing !== undefined) return existing
    const created = new FakeTable()
    this.tables.set(name, created)
    return created
  }

  /** Access an already-resolved table without recording another `domain.table` call. */
  peek(name: string): FakeTable | undefined {
    return this.tables.get(name)
  }
}

function mustTable(domain: FakeDomain, name: string): FakeTable {
  const table = domain.peek(name)
  if (table === undefined) throw new Error(`test expected the domain to expose table '${name}'`)
  return table
}

// ---------------------------------------------------------------------------
// Table names
// ---------------------------------------------------------------------------

test('defaults to safe identity table names and validates overrides', () => {
  assert.equal(Object.keys(DEFAULT_DSH_TABLE_NAMES).length, DOMAIN_TABLES.length)
  for (const table of DOMAIN_TABLES) {
    const name = DEFAULT_DSH_TABLE_NAMES[table]
    assert.equal(name, table, `default name for ${table}`)
    assert.match(name, DSH_TABLE_NAME_PATTERN, `default name for ${table} is a safe DSH name`)
  }

  const renamed = resolveDshTableNames({ issues: 'issue_records' })
  assert.equal(renamed.get('issues'), 'issue_records')
  assert.equal(renamed.get('programs'), 'programs')

  assert.throws(() => resolveDshTableNames({ programs: 'Programs' }), /must match/)
  assert.throws(() => resolveDshTableNames({ programs: '9programs' }), /must match/)
  assert.throws(
    () => resolveDshTableNames({ programs: 'shared', issues: 'shared' }),
    /both map to DSH table 'shared'/,
  )
})

test('resolves every logical table on the domain before the first operation', () => {
  const domain = new FakeDomain()
  createDshDomainStore(domain)
  assert.deepEqual(domain.requested, [...DOMAIN_TABLES])
})

test('fails at wiring time when the domain does not declare a table', () => {
  const domain = new FakeDomain()
  domain.missing.add('audit')
  assert.throws(() => createDshDomainStore(domain), /does not expose table 'audit'/)
})

test('maps logical tables onto configured physical names', async () => {
  const domain = new FakeDomain()
  const store = createDshDomainStore(domain, { programs: 'research_programs' })
  const table = mustTable(domain, 'research_programs')

  const created = expectOk(
    await store.put('programs', 'program-1', 'row', version(0)),
    'create under renamed table',
  )
  assert.equal(created.version, version(1))
  assert.equal(table.records.has('program-1'), true)
  assert.equal(domain.requested.includes('research_programs'), true)
  assert.equal(domain.requested.includes('programs'), false)

  const row = await store.get('programs', 'program-1')
  assert.equal(row?.value, 'row')
})

// ---------------------------------------------------------------------------
// Create / get
// ---------------------------------------------------------------------------

test('put creates a versioned envelope through table put', async () => {
  const domain = new FakeDomain()
  const store = createDshDomainStore(domain)
  const table = mustTable(domain, 'programs')

  const created = expectOk(
    await store.put('programs', 'program-1', { id: 'program-1' }, version(0)),
    'create',
  )
  assert.equal(created.version, version(1))
  assert.equal(created.etag, 'programs/program-1@1')
  assert.deepEqual(table.records.get('program-1'), {
    version: 1,
    value: { id: 'program-1' },
  })
  assert.equal(table.putAttempts, 1)
  assert.equal(table.updateAttempts, 0)

  assert.equal(await store.get('programs', 'missing'), undefined)
  const row = await store.get('programs', 'program-1')
  assert.equal(row?.key, 'program-1')
  assert.equal(row?.version, version(1))
  assert.equal(row?.etag, created.etag)
  assert.deepEqual(row?.value, { id: 'program-1' })
})

test('put refuses a create when the row exists or the expected version is not initial', async () => {
  const domain = new FakeDomain()
  const store = createDshDomainStore(domain)

  expectOk(await store.put('issues', 'issue-1', 'first', version(0)), 'seed issue')
  const duplicate = expectErr(
    await store.put('issues', 'issue-1', 'second', version(0)),
    'duplicate create',
  )
  assert.deepEqual(duplicate, { kind: 'version-conflict', expected: version(0), actual: version(1) })
  assert.equal(mustTable(domain, 'issues').records.get('issue-1')?.value, 'first')

  const missing = expectErr(
    await store.put('issues', 'issue-2', 'late', version(2)),
    'create with a non-initial expected version',
  )
  assert.deepEqual(missing, { kind: 'version-conflict', expected: version(2), actual: version(0) })
  assert.equal(mustTable(domain, 'issues').records.has('issue-2'), false)
})

test('an envelope without a value reads as undefined', async () => {
  const domain = new FakeDomain()
  const store = createDshDomainStore(domain)
  mustTable(domain, 'programs').seedRaw('program-1', { version: 2 })

  const row = await store.get('programs', 'program-1')
  assert.equal(row?.version, version(2))
  assert.equal(row?.value, undefined)
  assert.equal(row?.etag, 'programs/program-1@2')
})

// ---------------------------------------------------------------------------
// Version CAS
// ---------------------------------------------------------------------------

test('put updates an existing row through the table update transform', async () => {
  const domain = new FakeDomain()
  const store = createDshDomainStore(domain)
  const table = mustTable(domain, 'programs')

  const created = expectOk(await store.put('programs', 'program-1', 'first', version(0)), 'create')
  const updated = expectOk(
    await store.put('programs', 'program-1', 'second', version(1)),
    'update',
  )
  assert.equal(updated.version, version(2))
  assert.notEqual(updated.etag, created.etag)
  assert.equal(table.putAttempts, 1)
  assert.equal(table.updateAttempts, 1)
  assert.deepEqual(table.records.get('program-1'), { version: 2, value: 'second' })

  const row = await store.get('programs', 'program-1')
  assert.equal(row?.version, version(2))
  assert.equal(row?.value, 'second')
  assert.equal(row?.etag, updated.etag)
})

test('put reports a stale expected version and leaves the row untouched', async () => {
  const domain = new FakeDomain()
  const store = createDshDomainStore(domain)
  const table = mustTable(domain, 'programs')

  expectOk(await store.put('programs', 'program-1', 'first', version(0)), 'create')
  expectOk(await store.put('programs', 'program-1', 'second', version(1)), 'update')

  const conflict = expectErr(
    await store.put('programs', 'program-1', 'stale', version(1)),
    'stale update',
  )
  assert.deepEqual(conflict, {
    kind: 'version-conflict',
    expected: version(1),
    actual: version(2),
  })
  assert.deepEqual(table.records.get('program-1'), { version: 2, value: 'second' })
})

test('the update transform re-checks the version inside the DSH write slot', async () => {
  const domain = new FakeDomain()
  const store = createDshDomainStore(domain)
  const table = mustTable(domain, 'experiments')
  table.seed('experiment-1', 'original', 1)

  // A different store instance (or a direct DSH writer) commits between this store's
  // pre-check and its update slot: only the transform's comparison can catch it.
  table.beforeUpdate = (key) => {
    table.seed(key, 'concurrent', 2)
  }

  const conflict = expectErr(
    await store.put('experiments', 'experiment-1', 'ours', version(1)),
    'concurrent update',
  )
  assert.deepEqual(conflict, {
    kind: 'version-conflict',
    expected: version(1),
    actual: version(2),
  })
  assert.deepEqual(table.records.get('experiment-1'), { version: 2, value: 'concurrent' })
})

test('a row deleted between read and update is a conflict at the absent version', async () => {
  const domain = new FakeDomain()
  const store = createDshDomainStore(domain)
  const table = mustTable(domain, 'tickets')
  table.seed('ticket-1', 'ticket', 1)
  table.beforeUpdate = (key) => {
    table.records.delete(key)
  }

  const conflict = expectErr(
    await store.put('tickets', 'ticket-1', 'next', version(1)),
    'deleted before update',
  )
  assert.deepEqual(conflict, {
    kind: 'version-conflict',
    expected: version(1),
    actual: version(0),
  })
  assert.equal(table.records.has('ticket-1'), false)
})

// ---------------------------------------------------------------------------
// Serialized writes
// ---------------------------------------------------------------------------

test('serializes concurrent creates for one key', async () => {
  const domain = new FakeDomain()
  const store = createDshDomainStore(domain)

  const first = store.put('programs', 'program-1', 'first', version(0))
  const second = store.put('programs', 'program-1', 'second', version(0))
  const [firstResult, secondResult] = await Promise.all([first, second])

  const created = expectOk(firstResult, 'first create')
  assert.equal(created.version, version(1))
  const conflict = expectErr(secondResult, 'second create')
  assert.deepEqual(conflict, {
    kind: 'version-conflict',
    expected: version(0),
    actual: version(1),
  })

  const table = mustTable(domain, 'programs')
  assert.equal(table.putAttempts, 1)
  assert.deepEqual(table.records.get('program-1'), { version: 1, value: 'first' })
})

test('serializes concurrent updates and keeps the queue usable after a conflict', async () => {
  const domain = new FakeDomain()
  const store = createDshDomainStore(domain)
  const table = mustTable(domain, 'programs')
  expectOk(await store.put('programs', 'program-1', 'base', version(0)), 'create')

  const first = store.put('programs', 'program-1', 'first', version(1))
  const second = store.put('programs', 'program-1', 'second', version(1))
  const [firstResult, secondResult] = await Promise.all([first, second])

  const updated = expectOk(firstResult, 'first update')
  assert.equal(updated.version, version(2))
  const conflict = expectErr(secondResult, 'second update')
  assert.deepEqual(conflict, {
    kind: 'version-conflict',
    expected: version(1),
    actual: version(2),
  })
  assert.equal(table.updateAttempts, 1)
  assert.deepEqual(table.records.get('program-1'), { version: 2, value: 'first' })

  // A rejected write settles its queue link; the next write must still run.
  const next = expectOk(
    await store.put('programs', 'program-1', 'third', version(2)),
    'update after conflict',
  )
  assert.equal(next.version, version(3))
  assert.deepEqual(table.records.get('program-1'), { version: 3, value: 'third' })
})

// ---------------------------------------------------------------------------
// Delete / list
// ---------------------------------------------------------------------------

test('delete removes a row and is idempotent', async () => {
  const domain = new FakeDomain()
  const store = createDshDomainStore(domain)
  const table = mustTable(domain, 'artifacts')

  expectOk(await store.put('artifacts', 'artifact-1', 'bytes', version(0)), 'create')
  assert.equal(expectOk(await store.delete('artifacts', 'artifact-1'), 'delete'), undefined)
  assert.equal(await store.get('artifacts', 'artifact-1'), undefined)
  assert.equal(expectOk(await store.delete('artifacts', 'artifact-1'), 'second delete'), undefined)
  assert.equal(table.deleteAttempts, 2)

  // Re-creating after a delete starts a new envelope at version 1.
  const recreated = expectOk(
    await store.put('artifacts', 'artifact-1', 'new bytes', version(0)),
    'recreate',
  )
  assert.equal(recreated.version, version(1))
})

test('list returns every envelope in store order', async () => {
  const domain = new FakeDomain()
  const store = createDshDomainStore(domain)

  expectOk(await store.put('programs', 'a', 'alpha', version(0)), 'create a')
  expectOk(await store.put('programs', 'b', 'bravo', version(0)), 'create b')
  expectOk(await store.put('programs', 'c', 'charlie', version(0)), 'create c')
  expectOk(await store.put('programs', 'a', 'alpha-2', version(1)), 'update a')

  const rows = await store.list('programs')
  assert.deepEqual(
    rows.map((row) => row.key),
    ['a', 'b', 'c'],
  )
  assert.deepEqual(
    rows.map((row) => row.version),
    [version(2), version(1), version(1)],
  )
  assert.deepEqual(
    rows.map((row) => row.value),
    ['alpha-2', 'bravo', 'charlie'],
  )
  assert.equal(rows[0]?.etag, 'programs/a@2')
  assert.deepEqual(await store.list('audit'), [])
})

// ---------------------------------------------------------------------------
// Corruption and I/O failures
// ---------------------------------------------------------------------------

test('reports a corrupt envelope on get and list', async () => {
  const domain = new FakeDomain()
  const store = createDshDomainStore(domain)
  const table = mustTable(domain, 'programs')

  const broken: readonly { readonly key: string; readonly raw: unknown }[] = [
    { key: 'null', raw: null },
    { key: 'scalar', raw: 'not-an-envelope' },
    { key: 'array', raw: [] },
    { key: 'negative', raw: { version: -1, value: 'x' } },
    { key: 'string', raw: { version: '1', value: 'x' } },
    { key: 'missing', raw: { value: 'x' } },
  ]
  for (const item of broken) {
    table.seedRaw(item.key, item.raw)
    const failure = await failureOf(store.get('programs', item.key))
    assert.equal(failure.storeError.kind, 'corrupt')
    assert.ok(
      failure.message.includes(`programs/${item.key}`),
      `corrupt message names the row: ${failure.message}`,
    )
  }

  const listFailure = await failureOf(store.list('programs'))
  assert.equal(listFailure.storeError.kind, 'corrupt')
})

test('put returns a corrupt failure without writing when the stored envelope is malformed', async () => {
  const domain = new FakeDomain()
  const store = createDshDomainStore(domain)
  const table = mustTable(domain, 'programs')
  table.seedRaw('program-1', { version: 'one', value: 'stored' })

  const failure = expectErr(
    await store.put('programs', 'program-1', 'next', version(1)),
    'put over corrupt envelope',
  )
  assert.equal(failure.kind, 'corrupt')
  assert.equal(table.putAttempts, 0)
  assert.equal(table.updateAttempts, 0)
  assert.deepEqual(table.records.get('program-1'), { version: 'one', value: 'stored' })
})

test('maps underlying DSH failures to io StoreErrors', async () => {
  const domain = new FakeDomain()
  const store: DomainStore = createDshDomainStore(domain)
  const table = mustTable(domain, 'artifacts')

  table.readFailure = new Error('backend offline')
  const readFailure = await failureOf(store.get('artifacts', 'artifact-1'))
  assert.equal(readFailure.storeError.kind, 'io')
  assert.match(readFailure.message, /backend offline/)
  const listFailure = await failureOf(store.list('artifacts'))
  assert.equal(listFailure.storeError.kind, 'io')

  table.readFailure = undefined
  table.writeFailure = new FakeDomainError('closed', 'domain closed')
  const putFailure = expectErr(
    await store.put('artifacts', 'artifact-1', 'row', version(0)),
    'write to closed domain',
  )
  assert.equal(putFailure.kind, 'io')
  assert.match(putFailure.message, /closed: domain closed/)

  const deleteFailure = expectErr(
    await store.delete('artifacts', 'artifact-1'),
    'delete from closed domain',
  )
  assert.equal(deleteFailure.kind, 'io')
})
