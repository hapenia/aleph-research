import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createResearchChannel, readResearchChannel } from '../research-channel.js'

const makeDir = () => mkdtemp(join(tmpdir(), 'aleph-channel-'))

const message = (overrides = {}) => ({
  id: 'aleph:research:p:ticket:t-1',
  at: '2026-11-01T12:00:00.000Z',
  thread: 'aleph:research:p:ticket:t-1',
  address: { project: 'p', ticket: 't-1' },
  text: 'Measure the clipping floors.',
  ...overrides,
})

test('send appends one JSONL record and reports sent', async () => {
  const dir = await makeDir()
  try {
    const channel = createResearchChannel({ dir })
    const result = await channel.send({}, message())

    assert.equal(result, 'sent')
    const raw = await readFile(join(dir, 'channel.jsonl'), 'utf8')
    const lines = raw.split('\n').filter((line) => line.trim() !== '')
    assert.equal(lines.length, 1)

    const record = JSON.parse(lines[0])
    assert.deepEqual(record, {
      version: 1,
      id: 'aleph:research:p:ticket:t-1',
      at: '2026-11-01T12:00:00.000Z',
      thread: 'aleph:research:p:ticket:t-1',
      address: { project: 'p', ticket: 't-1' },
      text: 'Measure the clipping floors.',
      source: 'aleph',
    })

    const records = await readResearchChannel(dir)
    assert.equal(records.length, 1)
    assert.equal(records[0].text, 'Measure the clipping floors.')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('sending the same id twice keeps a single record', async () => {
  const dir = await makeDir()
  try {
    const channel = createResearchChannel({ dir })
    assert.equal(await channel.send({}, message()), 'sent')
    assert.equal(await channel.send({}, message({ text: 'repeated delivery' })), 'sent')

    const records = await readResearchChannel(dir)
    assert.equal(records.length, 1)
    assert.equal(records[0].text, 'Measure the clipping floors.', 'the original record is kept')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('two different ids produce two records in order', async () => {
  const dir = await makeDir()
  try {
    const channel = createResearchChannel({ dir })
    await channel.send({}, message({ id: 'm-1', text: 'first' }))
    await channel.send({}, message({ id: 'm-2', text: 'second' }))

    const records = await readResearchChannel(dir)
    assert.deepEqual(records.map((record) => record.id), ['m-1', 'm-2'])
    assert.deepEqual(records.map((record) => record.text), ['first', 'second'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reading a missing channel log returns an empty list', async () => {
  const dir = await makeDir()
  try {
    assert.deepEqual(await readResearchChannel(join(dir, 'absent')), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a malformed line in the middle is skipped', async () => {
  const dir = await makeDir()
  try {
    const channel = createResearchChannel({ dir })
    await channel.send({}, message({ id: 'm-1', text: 'first' }))
    await channel.send({}, message({ id: 'm-2', text: 'second' }))

    const path = join(dir, 'channel.jsonl')
    const lines = (await readFile(path, 'utf8')).split('\n')
    lines.splice(1, 0, '{"broken": ')
    await writeFile(path, lines.join('\n'), 'utf8')

    const records = await readResearchChannel(dir)
    assert.deepEqual(records.map((record) => record.id), ['m-1', 'm-2'])

    // A send after the malformed line still sees the existing ids.
    assert.equal(await channel.send({}, message({ id: 'm-1' })), 'sent')
    assert.equal((await readResearchChannel(dir)).length, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('link returns the configured url and both labels, allowed is true', async () => {
  const dir = await makeDir()
  try {
    const channel = createResearchChannel({ dir, linkUrl: 'http://127.0.0.1:46119/aleph' })
    assert.deepEqual(channel.link({ project: 'p', ticket: 't-1' }, []), {
      url: 'http://127.0.0.1:46119/aleph',
      label: { zh: '本地研究面板', en: 'Local research panel' },
    })
    assert.equal(channel.allowed({ project: 'p', ticket: 't-1' }, {}), true)
    assert.equal(channel.allowed({ project: 'other', ticket: 'main' }), true)

    const bare = createResearchChannel({ dir })
    assert.equal(bare.link({ project: 'p' }, []).url, '')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('send tolerates a message with missing fields', async () => {
  const dir = await makeDir()
  try {
    const channel = createResearchChannel({ dir })
    assert.equal(await channel.send({}, { id: 'm-1' }), 'sent')
    const [record] = await readResearchChannel(dir)
    assert.equal(record.at, null)
    assert.equal(record.thread, null)
    assert.equal(record.address, null)
    assert.equal(record.text, null)
    assert.equal(record.source, 'aleph')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
