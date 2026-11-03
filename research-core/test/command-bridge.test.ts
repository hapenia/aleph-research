import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  CommandConcepts,
  CommandStore,
  CoreAuditEntry,
  CoreCommandActor,
  CoreCommandDraft,
  CoreCommandEffectFailure,
  CoreCommandRole,
  CoreExperiment,
  CoreIssue,
  CoreProgram,
  CoreTicket,
  CoreVersioned,
} from '../src/adapter/command-boundary.js'
import { loadBundledCommandBridge } from '../src/adapter/command-bridge.js'
import type { Result } from '../src/types/errors.js'
import type { IsoTimestamp } from '../src/types/ids.js'

const NOW = '2026-01-01T00:00:00.000Z'

function ok<T>(value: T): Result<T, CoreCommandEffectFailure> {
  return { ok: true, value }
}

function conflict(): Result<never, CoreCommandEffectFailure> {
  return { ok: false, error: { kind: 'conflict', message: 'version conflict' } }
}

class MemoryCommandStore implements CommandStore {
  readonly programs = new Map<string, CoreVersioned<CoreProgram>>()
  readonly issues = new Map<string, CoreVersioned<CoreIssue>>()
  readonly experiments = new Map<string, CoreVersioned<CoreExperiment>>()
  readonly tickets = new Map<string, CoreVersioned<CoreTicket>>()
  readonly audits: { readonly entry: CoreAuditEntry; readonly role: CoreCommandRole }[] = []

  private save<T extends { readonly id: string }>(
    rows: Map<string, CoreVersioned<T>>,
    value: T,
    expected?: string,
  ): Result<string, CoreCommandEffectFailure> {
    const current = Number(rows.get(value.id)?.version ?? '0')
    if (Number(expected ?? '0') !== current) return conflict()
    const version = String(current + 1)
    rows.set(value.id, { value, version })
    return ok(version)
  }

  async loadProgram(programId: string): Promise<CoreVersioned<CoreProgram> | undefined> {
    return this.programs.get(programId)
  }

  async saveProgram(
    program: CoreProgram,
    expected?: number,
  ): Promise<Result<string, CoreCommandEffectFailure>> {
    return this.save(this.programs, program, expected)
  }

  async loadIssue(issueId: string): Promise<CoreVersioned<CoreIssue> | undefined> {
    return this.issues.get(issueId)
  }

  async saveIssue(
    issue: CoreIssue,
    expected?: number,
  ): Promise<Result<string, CoreCommandEffectFailure>> {
    return this.save(this.issues, issue, expected)
  }

  async loadExperiment(
    experimentId: string,
  ): Promise<CoreVersioned<CoreExperiment> | undefined> {
    return this.experiments.get(experimentId)
  }

  async saveExperiment(
    experiment: CoreExperiment,
    expected?: number,
  ): Promise<Result<string, CoreCommandEffectFailure>> {
    return this.save(this.experiments, experiment, expected)
  }

  async loadTicket(ticketId: string): Promise<CoreVersioned<CoreTicket> | undefined> {
    return this.tickets.get(ticketId)
  }

  async saveTicket(
    ticket: CoreTicket,
    expected?: number,
  ): Promise<Result<string, CoreCommandEffectFailure>> {
    return this.save(this.tickets, ticket, expected)
  }

  async appendAudit(
    entry: CoreAuditEntry,
    role: CoreCommandRole,
  ): Promise<Result<void, CoreCommandEffectFailure>> {
    this.audits.push({ entry, role })
    return ok(undefined)
  }
}

function clock(): { now(): IsoTimestamp } {
  return { now: () => NOW }
}

const OPERATOR: CoreCommandActor = { id: 'operator-1', role: 'operator' }
const OTHER_OPERATOR: CoreCommandActor = { id: 'operator-2', role: 'operator' }
const RESEARCHER: CoreCommandActor = {
  id: 'researcher-1',
  role: 'researcher',
  sessionId: 'session-1',
}
const IMPLEMENTER: CoreCommandActor = {
  id: 'implementer-1',
  role: 'implementer',
  sessionId: 'session-2',
}

function createProgramDraft(): CoreCommandDraft {
  return {
    name: 'program.create',
    id: 'program-1',
    programName: 'Program',
    goal: 'Improve the benchmark',
    methodology: 'Propose, run, review',
    benchmark: {
      id: 'benchmark-1',
      entry: 'bench.py',
      timeoutMs: '30000',
      metrics: [
        { name: 'score', direction: 'maximize', required: true },
      ],
      maxRetries: 1,
      baseline: {},
    },
    utility: [{ name: 'score', direction: 'maximize', weight: 1 }],
    exploration: 'normal',
    policy: {
      maxExperiments: 4,
      maxComputeMinutes: '60',
      maxTokens: '10000',
      maxAttemptsPerExperiment: 2,
    },
  }
}

function pauseDraft(): CoreCommandDraft {
  return { name: 'program.pause', programId: 'program-1' }
}

function issueDraft(): CoreCommandDraft {
  return {
    name: 'issue.create',
    id: 'issue-1',
    programId: 'program-1',
    title: 'Find a better model',
    body: 'The benchmark can improve.',
    labels: ['research'],
  }
}

function claimDraft(): CoreCommandDraft {
  return { name: 'issue.claim', issueId: 'issue-1' }
}

function proposeDraft(): CoreCommandDraft {
  return {
    name: 'experiment.propose',
    id: 'experiment-1',
    programId: 'program-1',
    issueId: 'issue-1',
    branch: 'experiment/one',
    head: '0'.repeat(40),
    environment: { kind: 'requirements', file: 'requirements.txt' },
    lineage: {
      strategy: 'fresh',
      baseCommit: '0'.repeat(40),
      freshStartProbability: 0,
    },
  }
}

function conceptsFor(store: MemoryCommandStore): CommandConcepts {
  return { store, clock: clock() }
}

async function createBridge(store: MemoryCommandStore) {
  const bridge = await loadBundledCommandBridge(conceptsFor(store))
  assert.equal(bridge.ok, true)
  if (!bridge.ok) throw new Error('the command bridge did not load')
  return bridge.value
}

test('an authorized command mutates storage and writes an audit entry', async () => {
  const store = new MemoryCommandStore()
  const bridge = await createBridge(store)
  const created = await bridge.execute(OPERATOR, createProgramDraft())
  assert.equal(created.ok, true)
  if (!created.ok) return
  assert.deepEqual(created.value, {
    kind: 'program-created',
    program: 'program-1',
    version: '1',
  })
  const stored = store.programs.get('program-1')
  assert.ok(stored)
  assert.equal(stored.value.owner, 'operator-1')
  assert.equal(stored.value.status, 'running')
  assert.equal(stored.version, '1')
  assert.equal(store.audits.length, 1)
  assert.equal(store.audits[0]?.entry.action, 'program.create')
  assert.equal(store.audits[0]?.entry.subject, 'program:program-1')
  assert.match(String(store.audits[0]?.entry.id), /^audit-/)

  const paused = await bridge.execute(OPERATOR, pauseDraft())
  assert.equal(paused.ok, true)
  if (!paused.ok) return
  assert.deepEqual(paused.value, { kind: 'program-updated', program: 'program-1', version: '2' })
  assert.equal(store.programs.get('program-1')?.value.status, 'paused')
  assert.equal(store.audits.length, 2)
  assert.equal(store.audits[1]?.entry.action, 'program.pause')
})

test('an unauthorized command is refused by the rust gate', async () => {
  const store = new MemoryCommandStore()
  const bridge = await createBridge(store)
  const created = await bridge.execute(OPERATOR, createProgramDraft())
  assert.equal(created.ok, true)
  const refused = await bridge.execute(IMPLEMENTER, pauseDraft())
  assert.equal(refused.ok, false)
  if (refused.ok) return
  assert.equal(refused.error.kind, 'forbidden')
  assert.equal(store.programs.get('program-1')?.value.status, 'running')
  assert.equal(store.programs.get('program-1')?.version, '1')
  assert.equal(store.audits.length, 1)
})

test('a forged owner cannot mutate a program', async () => {
  const store = new MemoryCommandStore()
  const bridge = await createBridge(store)
  const created = await bridge.execute(OPERATOR, createProgramDraft())
  assert.equal(created.ok, true)
  const refused = await bridge.execute(OTHER_OPERATOR, pauseDraft())
  assert.equal(refused.ok, false)
  if (refused.ok) return
  assert.equal(refused.error.kind, 'ownership')
  assert.equal(store.programs.get('program-1')?.value.status, 'running')
  assert.equal(store.audits.length, 1)
})

test('a duplicate create is refused without overwriting state', async () => {
  const store = new MemoryCommandStore()
  const bridge = await createBridge(store)
  const created = await bridge.execute(OPERATOR, createProgramDraft())
  assert.equal(created.ok, true)
  const duplicate = await bridge.execute(OPERATOR, createProgramDraft())
  assert.equal(duplicate.ok, false)
  if (duplicate.ok) return
  assert.equal(duplicate.error.kind, 'state-conflict')
  assert.equal(store.programs.get('program-1')?.version, '1')
  assert.equal(store.audits.length, 1)
})

test('issue and experiment commands cross the durable aggregate boundary', async () => {
  const store = new MemoryCommandStore()
  const bridge = await createBridge(store)
  assert.equal((await bridge.execute(OPERATOR, createProgramDraft())).ok, true)
  assert.equal((await bridge.execute(OPERATOR, issueDraft())).ok, true)
  const issue = store.issues.get('issue-1')
  assert.ok(issue)
  assert.equal(issue.value.status, 'open')
  assert.equal(issue.value.author, 'operator-1')

  const claimed = await bridge.execute(RESEARCHER, claimDraft())
  assert.equal(claimed.ok, true)
  const assigned = store.issues.get('issue-1')
  assert.equal(assigned?.value.status, 'assigned')
  assert.equal(assigned?.value.assignee, 'session-1')
  assert.equal(assigned?.version, '2')

  const proposed = await bridge.execute(RESEARCHER, proposeDraft())
  assert.equal(proposed.ok, true)
  if (!proposed.ok) return
  assert.deepEqual(proposed.value, {
    kind: 'experiment-created',
    experiment: 'experiment-1',
    version: '1',
  })
  const experiment = store.experiments.get('experiment-1')
  assert.ok(experiment)
  assert.equal(experiment.value.status, 'open')
  assert.equal(experiment.value.createdBy, 'researcher-1')
  const updatedIssue = store.issues.get('issue-1')
  assert.deepEqual(updatedIssue?.value.experiments, ['experiment-1'])
  assert.equal(updatedIssue?.version, '3')
  assert.equal(store.audits.length, 4)
})

test('a command with a missing aggregate is refused without mutation', async () => {
  const store = new MemoryCommandStore()
  const bridge = await createBridge(store)
  const refused = await bridge.execute(OPERATOR, pauseDraft())
  assert.equal(refused.ok, false)
  if (refused.ok) return
  assert.equal(refused.error.kind, 'storage')
  assert.equal(store.programs.size, 0)
  assert.equal(store.audits.length, 0)
})
