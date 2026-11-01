import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ConfigStore } from '../config-store.js'

/** Make a throwaway store rooted in the OS temp directory. */
async function makeStore({ name = 'aleph-config', validate = null } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'aleph-config-store-'))
  const dir = path.join(root, 'nested', 'config')
  return { root, dir, store: new ConfigStore({ dir, name, validate }) }
}

test('an empty store reports revision 0 with no value or timestamp', async () => {
  const { root, store } = await makeStore()
  try {
    assert.deepEqual(store.current(), { revision: 0, value: null, updatedAt: null })
    assert.deepEqual(store.history(), [])
    assert.deepEqual(store.changes(), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('two saves produce revisions 1 and 2 and the latest value', async () => {
  const { root, dir, store } = await makeStore()
  try {
    const first = store.save({ threshold: 1 })
    const second = store.save({ threshold: 2 })

    assert.equal(first.revision, 1)
    assert.equal(second.revision, 2)
    assert.equal(store.current().revision, 2)
    assert.deepEqual(store.current().value, { threshold: 2 })
    assert.ok(store.current().updatedAt)

    const live = JSON.parse(await readFile(path.join(dir, 'aleph-config.json'), 'utf8'))
    assert.deepEqual(live, { revision: 2, value: { threshold: 2 }, updatedAt: store.current().updatedAt })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('history lists both revisions newest first with their origin', async () => {
  const { root, store } = await makeStore()
  try {
    store.save('one', { origin: 'cli' })
    store.save('two')

    const history = store.history()
    assert.deepEqual(history.map((entry) => entry.revision), [2, 1])
    assert.deepEqual(history.map((entry) => entry.value), ['two', 'one'])
    assert.equal(history[1].origin, 'cli')
    assert.equal(history[0].origin, 'api')

    assert.deepEqual(store.changes(), [
      { revision: 2, updatedAt: history[0].updatedAt, origin: 'api', changed: true },
      { revision: 1, updatedAt: history[1].updatedAt, origin: 'cli', changed: true },
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('restoring revision 1 creates revision 3 with the old value and keeps every record', async () => {
  const { root, store } = await makeStore()
  try {
    store.save('one')
    store.save('two')

    const restored = store.restore(1)
    assert.equal(restored.revision, 3)
    assert.equal(restored.value, 'one')
    assert.equal(store.current().revision, 3)
    assert.equal(store.current().value, 'one')
    assert.deepEqual(store.history().map((entry) => entry.revision), [3, 2, 1])
    assert.deepEqual(store.history().map((entry) => entry.value), ['one', 'two', 'one'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rollbackLast re-saves the previous revision value as a new revision', async () => {
  const { root, store } = await makeStore()
  try {
    store.save('one')
    store.save('two')

    const rolledBack = store.rollbackLast()
    assert.equal(rolledBack.revision, 3)
    assert.equal(rolledBack.value, 'one')
    assert.equal(store.current().value, 'one')
    assert.deepEqual(store.history().map((entry) => entry.revision), [3, 2, 1])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rollbackLast refuses when there is nothing to roll back to', async () => {
  const { root, store } = await makeStore()
  try {
    assert.throws(() => store.rollbackLast(), /nothing to roll back/)

    store.save('one')
    assert.throws(() => store.rollbackLast(), /no revision 0 to roll back to/)
    assert.equal(store.current().revision, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('restoring an unknown revision throws and leaves the store untouched', async () => {
  const { root, store } = await makeStore()
  try {
    store.save('one')
    assert.throws(() => store.restore(99), /no revision 99/)
    assert.equal(store.current().revision, 1)
    assert.equal(store.current().value, 'one')
    assert.deepEqual(store.history().map((entry) => entry.revision), [1])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a rejected value leaves the store unchanged', async () => {
  const validate = (value) => {
    if (typeof value !== 'string') throw new TypeError('value must be a string')
  }
  const { root, store } = await makeStore({ validate })
  try {
    store.save('accepted')
    assert.throws(() => store.save(42), /value must be a string/)
    assert.equal(store.current().revision, 1)
    assert.equal(store.current().value, 'accepted')
    assert.deepEqual(store.history().map((entry) => entry.revision), [1])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a corrupted current file makes a read throw with the file path', async () => {
  const { root, dir, store } = await makeStore()
  try {
    const file = path.join(dir, 'aleph-config.json')
    await writeFile(file, '{ this is not json', 'utf8')

    assert.throws(
      () => store.current(),
      (error) => error instanceof Error && error.message.includes(file) && /corrupted/.test(error.message),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a missing or empty history file reads as an empty history', async () => {
  const { root, dir } = await makeStore()
  try {
    const emptyHistory = new ConfigStore({ dir })
    assert.deepEqual(emptyHistory.history(), [])
    assert.deepEqual(emptyHistory.changes(), [])

    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'aleph-config.history.json'), '', 'utf8')
    assert.deepEqual(emptyHistory.history(), [])

    await writeFile(path.join(dir, 'aleph-config.history.json'), '   \n', 'utf8')
    assert.deepEqual(emptyHistory.history(), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('history is capped at the newest 50 entries', async () => {
  const { root, store } = await makeStore()
  try {
    for (let revision = 1; revision <= 55; revision += 1) store.save(`value-${revision}`)

    const history = store.history()
    assert.equal(history.length, 50)
    assert.equal(history[0].revision, 55)
    assert.equal(history.at(-1).revision, 6)
    assert.equal(history[0].value, 'value-55')
    assert.equal(store.current().revision, 55)

    const onDisk = JSON.parse(await readFile(path.join(store.dir, 'aleph-config.history.json'), 'utf8'))
    assert.equal(onDisk.length, 50)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a custom name selects its own files and creates the directory', async () => {
  const { root, dir, store } = await makeStore({ name: 'research' })
  try {
    store.save({ project: 'kunlungpt' })
    assert.deepEqual(store.current().value, { project: 'kunlungpt' })
    assert.ok(await readFile(path.join(dir, 'research.json'), 'utf8'))
    assert.ok(await readFile(path.join(dir, 'research.history.json'), 'utf8'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
