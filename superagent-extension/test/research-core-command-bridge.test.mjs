import assert from 'node:assert/strict'
import test from 'node:test'

import { loadBundledCommandBridge } from '../../research-core/dist/adapter/command-bridge.js'
import { createCommandSurface } from '../../research-core/dist/adapter/command-surface.js'
import { createInMemoryStore } from '../../research-core/dist/runtime/storage.js'
import { createDshCommandStore } from '../../research-core/dist/adapter/command-store.js'

const NOW = '2026-01-01T00:00:00.000Z'

function createFixture() {
  const store = createInMemoryStore()
  const clock = { now: () => NOW }
  return { store, clock }
}

async function createBridge(store, clock) {
  const loaded = await loadBundledCommandBridge({
    store: createDshCommandStore({ store, clock }),
    clock,
  })
  assert.equal(loaded.ok, true)
  if (!loaded.ok) throw new Error(`the command bridge did not load: ${loaded.error.kind}`)
  return createCommandSurface({ bridge: loaded.value })
}

const operator = { kind: 'operator', sessionId: 'operator-1' }
const researcher = { kind: 'researcher', sessionId: 'researcher-1' }

const programInput = {
  name: 'Program',
  goal: 'Improve the benchmark',
  methodology: 'Propose, run, review',
  contract: {
    ciEntry: 'bench.py',
    timeoutMs: 30_000,
    requiredMetrics: ['score'],
  },
  utility: {
    metrics: [{ name: 'score', direction: 'higher', weight: 1 }],
  },
  exploration: 'normal',
  budget: {
    maxExperiments: 4,
    maxComputeMinutes: 60,
    maxTokens: 10_000,
  },
}

test('the rust bridge drives a program through the dsh store and audits it', async () => {
  const { store, clock } = createFixture()
  const surface = await createBridge(store, clock)
  const created = await surface.execute('program.create', programInput, operator)
  assert.equal(created.ok, true)
  if (!created.ok) return
  assert.equal(created.value.command.kind, 'program-created')
  const programId = created.value.command.program
  const program = await store.programs.get(programId)
  assert.ok(program)
  assert.equal(program.value.name, 'Program')
  assert.equal(program.value.status, 'running')
  assert.equal(program.version, 1)

  const paused = await surface.execute('program.pause', { programId }, operator)
  assert.equal(paused.ok, true)
  assert.equal((await store.programs.get(programId))?.value.status, 'paused')
  const resumed = await surface.execute('program.resume', { programId }, operator)
  assert.equal(resumed.ok, true)
  assert.equal((await store.programs.get(programId))?.value.status, 'running')

  const denied = await surface.execute(
    'program.pause',
    { programId },
    { kind: 'researcher', sessionId: 'researcher-1' },
  )
  assert.equal(denied.ok, false)
  if (denied.ok) return
  assert.equal(denied.error.code, 'forbidden')
  assert.equal((await store.programs.get(programId))?.value.status, 'running')

  const audits = await store.audit.list(programId, 20)
  assert.deepEqual(
    audits.map((entry) => entry.action),
    ['program.created', 'program.paused', 'program.resumed'],
  )
})

test('issue and experiment commands use the rust bridge and fake dsh storage', async () => {
  const { store, clock } = createFixture()
  const surface = await createBridge(store, clock)
  const created = await surface.execute('program.create', programInput, operator)
  assert.equal(created.ok, true)
  if (!created.ok) return
  const programId = created.value.command.program

  const issueCreated = await surface.execute(
    'issue.create',
    {
      programId,
      title: 'Find a better model',
      body: 'The benchmark can improve.',
      labels: ['research'],
    },
    operator,
  )
  assert.equal(issueCreated.ok, true)
  if (!issueCreated.ok) return
  const issueId = issueCreated.value.command.issue
  const issue = await store.issues.get(issueId)
  assert.ok(issue)
  assert.equal(issue.value.status, 'open')

  const claimed = await surface.execute('issue.claim', { programId, issueId }, researcher)
  assert.equal(claimed.ok, true)
  const assigned = await store.issues.get(issueId)
  assert.ok(assigned)
  assert.equal(assigned.value.status, 'assigned')
  assert.equal(assigned.value.assignee.sessionId, 'researcher-1')

  const proposed = await surface.execute(
    'experiment.propose',
    {
      programId,
      issueId,
      branch: 'experiment/one',
      head: '0'.repeat(40),
      environment: { kind: 'requirements', file: 'requirements.txt' },
      lineage: {
        strategy: 'fresh',
        baseCommit: '0'.repeat(40),
        freshStartProbability: 0,
      },
    },
    researcher,
  )
  assert.equal(proposed.ok, true, JSON.stringify(proposed.error))
  if (!proposed.ok) return
  const experimentId = proposed.value.command.experiment
  const experiment = await store.experiments.get(experimentId)
  assert.ok(experiment)
  assert.equal(experiment.value.status, 'open')
  assert.equal(experiment.value.createdBy.sessionId, 'researcher-1')
  const linked = await store.issues.get(issueId)
  assert.deepEqual(linked?.value.experimentIds, [experimentId])

  const forged = await surface.execute(
    'experiment.propose',
    {
      programId,
      issueId,
      branch: 'experiment/two',
      head: '1'.repeat(40),
      environment: { kind: 'requirements', file: 'requirements.txt' },
      lineage: {
        strategy: 'fresh',
        baseCommit: '1'.repeat(40),
        freshStartProbability: 0,
      },
    },
    { kind: 'researcher', sessionId: 'researcher-2' },
  )
  assert.equal(forged.ok, false)
  if (forged.ok) return
  assert.equal(forged.error.code, 'forbidden')

  const audits = await store.audit.list(programId, 20)
  assert.deepEqual(
    audits.map((entry) => entry.action),
    [
      'program.created',
      'issue.created',
      'issue.claimed',
      'experiment.proposed',
    ],
  )
})
