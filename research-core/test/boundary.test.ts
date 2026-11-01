/**
 * Runtime tests for the factory/hydration boundary.
 *
 * These tests are the acceptance gate for the construction rules in
 * docs/runtime-safety-contract.md: factories validate untrusted input and return a
 * `Result`, hydration only mints states from validated rows, ownership tokens carry the
 * association the transitions check, and a hydrated object still exposes the methods
 * declared on its class (the JSON round-trip problem the blueprint calls out).
 *
 * Fixtures are plain data rows shaped like the `*Data` records in
 * `runtime/domain.ts`, because that is what repositories persist and what hydration reads.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createArtifactRef,
  createAssignedIssue,
  createCIRequestToken,
  createCIFailedExperiment,
  createCIPassedExperiment,
  createCIPendingExperiment,
  createCIRunningExperiment,
  createCancelledTicket,
  createClock,
  createClosedExperiment,
  createClosedIssue,
  createCompletedProgram,
  createDerivedLineage,
  createFailedCICompletion,
  createFailedTicket,
  createFreshLineage,
  createHostPrincipal,
  createImplementerPrincipal,
  createIssueAssignment,
  createOpenExperiment,
  createOpenIssue,
  createOpenTicket,
  createOperatorPrincipal,
  createPassedCICompletion,
  createPausedProgram,
  createReadyExperiment,
  createResearcherPrincipal,
  createRouterPrincipal,
  createRunningProgram,
  createRunningTicket,
  createStoppedProgram,
  createSubmittedTicket,
  createTicketBinding,
  createWatchdogPrincipal,
  EXPLORATION_PRESETS,
} from '../src/factories.ts'
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
} from '../src/hydration.ts'

/** Test-only stand-in for a branded value minted by the parser boundary. */
function forged<T>(value: unknown): T {
  return value as T
}

const T0 = '2026-01-01T00:00:00.000Z'
const T1 = '2026-01-01T01:00:00.000Z'
const T2 = '2026-01-01T02:00:00.000Z'
const T3 = '2026-01-01T03:00:00.000Z'
const T4 = '2026-01-01T04:00:00.000Z'
const T5 = '2026-01-01T05:00:00.000Z'
const HEAD = 'a'.repeat(40)
const OTHER_HEAD = 'b'.repeat(40)
const PROGRAM = 'program-1'
const ISSUE = 'issue-1'
const EXPERIMENT = 'experiment-1'
const TICKET = 'ticket-1'
const CI = 'ci-1'

const environment = { kind: 'uv-lock', lockFile: 'uv.lock', pythonVersion: '3.12' }
const freshLineage = { strategy: 'fresh', baseCommit: HEAD, freshStartProbability: 0.1 }
const derivedLineage = {
  strategy: 'derive',
  baseExperimentId: 'experiment-0',
  baseCommit: HEAD,
  temperature: 1,
  sampledWeight: 0.5,
}

const operator = createOperatorPrincipal(forged('operator-session'))
const researcher = createResearcherPrincipal(forged('researcher-1'))
const otherResearcher = createResearcherPrincipal(forged('researcher-2'))
const implementer = createImplementerPrincipal(forged('impl-1'), forged(TICKET))
const host = createHostPrincipal()

function programRow(overrides = {}) {
  return {
    status: 'running',
    id: PROGRAM,
    name: 'Battery research',
    goal: 'raise the score',
    methodology: 'ablation driven',
    contract: { ciEntry: 'uv run ci', timeoutMs: 60000, requiredMetrics: ['score'] },
    utility: { metrics: [{ name: 'score', direction: 'higher', weight: 1 }] },
    exploration: 'normal',
    budget: { maxExperiments: 10, maxComputeMinutes: 100, maxTokens: 1000 },
    usage: { experiments: 0, computeMinutes: 0, tokens: 0 },
    createdAt: T0,
    ...overrides,
  }
}

function pausedProgramRow(overrides = {}) {
  return programRow({ status: 'paused', pausedAt: T1, ...overrides })
}

function stoppedProgramRow(overrides = {}) {
  return programRow({ status: 'stopped', stoppedAt: T2, stopReason: 'done', ...overrides })
}

function completedProgramRow(overrides = {}) {
  return programRow({
    status: 'completed',
    completedAt: T2,
    completionReason: 'last issue closed',
    ...overrides,
  })
}

function openIssueRow(overrides = {}) {
  return {
    status: 'open',
    id: ISSUE,
    programId: PROGRAM,
    title: 'Is a wider window better?',
    body: 'Compare a wider clipping window.',
    labels: ['research'],
    author: { kind: 'researcher', sessionId: 'researcher-1' },
    createdAt: T0,
    ...overrides,
  }
}

function assignedIssueRow(overrides = {}) {
  return {
    ...openIssueRow(),
    status: 'assigned',
    assigneeSessionId: 'researcher-1',
    assignedAt: T1,
    experimentIds: [],
    ...overrides,
  }
}

function closedIssueRow(overrides = {}) {
  return {
    ...openIssueRow(),
    status: 'closed',
    assigneeSessionId: 'researcher-1',
    closedAt: T2,
    resolution: 'accepted',
    summary: 'accepted',
    ...overrides,
  }
}

function experimentBase(overrides = {}) {
  return {
    id: EXPERIMENT,
    programId: PROGRAM,
    issueId: ISSUE,
    branch: 'feat/window',
    head: HEAD,
    environment,
    lineage: freshLineage,
    planCommentId: 'comment-1',
    createdBySessionId: 'researcher-1',
    createdAt: T0,
    ...overrides,
  }
}

function openExperimentRow(overrides = {}) {
  return { ...experimentBase(), status: 'open', ...overrides }
}

function readyExperimentRow(overrides = {}) {
  return { ...experimentBase(), status: 'ready', readyAt: T1, ...overrides }
}

function pendingExperimentRow(overrides = {}) {
  return {
    ...experimentBase(),
    status: 'ci-pending',
    ciRunId: CI,
    requestedAt: T2,
    ...overrides,
  }
}

function runningExperimentRow(overrides = {}) {
  return {
    ...experimentBase(),
    status: 'ci-running',
    ciRunId: CI,
    requestedAt: T2,
    startedAt: T3,
    environmentDigest: 'digest-1',
    ...overrides,
  }
}

function passedExperimentRow(overrides = {}) {
  return {
    ...runningExperimentRow(),
    status: 'ci-passed',
    finishedAt: T4,
    ...overrides,
  }
}

function failedExperimentRow(overrides = {}) {
  return {
    ...experimentBase(),
    status: 'ci-failed',
    ciRunId: CI,
    requestedAt: T2,
    startedAt: T3,
    environmentDigest: 'digest-1',
    failureReason: 'entry-failed',
    failureDetail: 'the entry exited with status 1',
    failedAt: T4,
    ...overrides,
  }
}

function closedExperimentRow(overrides = {}) {
  return {
    ...experimentBase(),
    status: 'closed',
    closedAt: T5,
    closeReason: 'concluded',
    outcome: 'concluded',
    ...overrides,
  }
}

function ticketBase(overrides = {}) {
  return {
    id: TICKET,
    programId: PROGRAM,
    issueId: ISSUE,
    experimentId: EXPERIMENT,
    baseCommit: HEAD,
    createdAt: T0,
    ...overrides,
  }
}

function openTicketRow(overrides = {}) {
  return { ...ticketBase(), status: 'open', ...overrides }
}

function runningTicketRow(overrides = {}) {
  return {
    ...ticketBase(),
    status: 'running',
    sessionId: 'impl-1',
    startedAt: T1,
    ...overrides,
  }
}

function submittedTicketRow(overrides = {}) {
  return {
    ...ticketBase(),
    status: 'submitted',
    sessionId: 'impl-1',
    head: HEAD,
    submittedAt: T2,
    ...overrides,
  }
}

function cancelledTicketRow(overrides = {}) {
  return {
    ...ticketBase(),
    status: 'cancelled',
    reason: 'program paused',
    cancelledAt: T2,
    ...overrides,
  }
}

function failedTicketRow(overrides = {}) {
  return { ...ticketBase(), status: 'failed', reason: 'sandbox died', failedAt: T2, ...overrides }
}

function artifactRow(overrides = {}) {
  return {
    id: 'artifact-1',
    kind: 'report',
    digest: 'sha256:0123456789abcdef',
    bytes: 1024,
    programId: PROGRAM,
    experimentId: EXPERIMENT,
    commit: HEAD,
    ciRunId: CI,
    retention: 'keep',
    createdAt: T0,
    ...overrides,
  }
}

function requestedCIRecordRow(overrides = {}) {
  return {
    status: 'requested',
    id: CI,
    programId: PROGRAM,
    experimentId: EXPERIMENT,
    commit: HEAD,
    requestedBySessionId: 'researcher-1',
    requestedAt: T2,
    ...overrides,
  }
}

function runningCIRecordRow(overrides = {}) {
  return {
    ...requestedCIRecordRow(),
    status: 'running',
    startedAt: T3,
    environmentDigest: 'digest-1',
    ...overrides,
  }
}

function passedCIRecordRow(overrides = {}) {
  return {
    ...requestedCIRecordRow(),
    status: 'passed',
    startedAt: T3,
    finishedAt: T4,
    environmentDigest: 'digest-1',
    metrics: { score: 1.5, accuracy: 0.75 },
    artifacts: [artifactRow()],
    durationMs: 60000,
    ...overrides,
  }
}

function failedCIRecordRow(overrides = {}) {
  return {
    ...requestedCIRecordRow(),
    status: 'failed',
    startedAt: T3,
    environmentDigest: 'digest-1',
    finishedAt: T4,
    reason: 'entry-failed',
    detail: 'the entry exited with status 1',
    durationMs: 60000,
    ...overrides,
  }
}

function auditRow(overrides = {}) {
  return {
    id: 'audit-1',
    at: T0,
    programId: PROGRAM,
    action: 'issue.claimed',
    subject: { kind: 'issue', id: ISSUE },
    detail: { note: 'claimed', count: 1, ok: true, missing: null },
    actor: { kind: 'researcher', sessionId: 'researcher-1' },
    ...overrides,
  }
}

function attentionRow(overrides = {}) {
  return {
    id: 'attention-1',
    subject: { kind: 'program', id: PROGRAM },
    severity: 'warning',
    reason: 'budget nearly exhausted',
    detail: 'experiments used 9 of 10',
    at: T0,
    ...overrides,
  }
}

function commentRow(overrides = {}) {
  return {
    id: 'comment-1',
    issueId: ISSUE,
    authorSessionId: 'researcher-1',
    body: 'the plan is appended',
    at: T0,
    kind: 'plan',
    ...overrides,
  }
}

function unwrap(result) {
  if (result.ok) return result.value
  assert.fail(`expected Ok, got ${JSON.stringify(result.error)}`)
}

function expectDomainError(result, code) {
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.code, code)
  assert.ok(result.error.message.length > 0)
}

function expectCorrupt(result) {
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.kind, 'corrupt')
  assert.ok(result.error.message.length > 0)
}

function bindingFor(ticket) {
  return unwrap(
    createTicketBinding({
      ticket,
      expected: {
        programId: PROGRAM,
        issueId: ISSUE,
        experimentId: EXPERIMENT,
        sessionId: 'impl-1',
      },
    }),
  )
}

// ---------------------------------------------------------------------------
// Principals and ownership tokens
// ---------------------------------------------------------------------------

test('principal factories mint every declared role', () => {
  assert.equal(operator.kind, 'operator')
  assert.equal(operator.sessionId, 'operator-session')
  assert.equal(researcher.kind, 'researcher')
  assert.equal(researcher.sessionId, 'researcher-1')
  assert.equal(implementer.kind, 'implementer')
  assert.equal(implementer.sessionId, 'impl-1')
  assert.equal(implementer.ticketId, TICKET)
  assert.equal(createWatchdogPrincipal(forged('watchdog-1')).kind, 'watchdog')
  assert.equal(createRouterPrincipal(forged('router-1')).kind, 'router')
  assert.equal(createHostPrincipal().kind, 'host')
  assert.equal(typeof createClock().now(), 'string')
})

test('createIssueAssignment requires an issue and a researcher principal', () => {
  const assignment = unwrap(createIssueAssignment(forged(ISSUE), researcher))
  assert.equal(assignment.issueId, ISSUE)
  assert.equal(assignment.assignee.sessionId, 'researcher-1')

  expectDomainError(createIssueAssignment(forged(''), researcher), 'invalid-input')
  expectDomainError(
    createIssueAssignment(forged(ISSUE), forged({ kind: 'operator', sessionId: 'x' })),
    'invalid-input',
  )
})

test('createTicketBinding can only mint from a matching ticket', () => {
  const binding = bindingFor(submittedTicketRow())
  assert.equal(binding.ticketId, TICKET)
  assert.equal(binding.experimentId, EXPERIMENT)
  assert.equal(binding.sessionId, 'impl-1')

  expectDomainError(
    createTicketBinding({
      ticket: submittedTicketRow(),
      expected: { programId: 'program-2', issueId: ISSUE, experimentId: EXPERIMENT, sessionId: 'impl-1' },
    }),
    'forbidden',
  )
  expectDomainError(
    createTicketBinding({
      ticket: runningTicketRow(),
      expected: { programId: PROGRAM, issueId: ISSUE, experimentId: EXPERIMENT, sessionId: 'impl-2' },
    }),
    'forbidden',
  )
  expectDomainError(
    createTicketBinding({
      ticket: openTicketRow(),
      expected: {
        programId: PROGRAM,
        issueId: ISSUE,
        experimentId: EXPERIMENT,
        sessionId: 'impl-1',
      },
    }),
    'invalid-state',
  )
  expectDomainError(createTicketBinding({ expected: {} }), 'invalid-input')
  expectDomainError(createTicketBinding({ ticket: submittedTicketRow() }), 'invalid-input')
})

test('createCIRequestToken checks the experiment and commit association', () => {
  const token = unwrap(
    createCIRequestToken({
      ciRunId: CI,
      experimentId: EXPERIMENT,
      commit: HEAD,
      requestedAt: T2,
      experiment: openExperimentRow({ head: HEAD }),
    }),
  )
  assert.equal(token.ciRunId, CI)
  assert.equal(token.commit, HEAD)

  expectDomainError(
    createCIRequestToken({
      ciRunId: CI,
      experimentId: 'experiment-2',
      commit: HEAD,
      requestedAt: T2,
      experiment: openExperimentRow(),
    }),
    'forbidden',
  )
  expectDomainError(
    createCIRequestToken({
      ciRunId: CI,
      experimentId: EXPERIMENT,
      commit: OTHER_HEAD,
      requestedAt: T2,
      experiment: openExperimentRow(),
    }),
    'forbidden',
  )
  expectDomainError(createCIRequestToken({ ciRunId: CI, experimentId: EXPERIMENT }), 'invalid-input')
})

test('CI completion tokens carry the record and reject mismatched or wrong-status evidence', () => {
  const passed = unwrap(createPassedCICompletion({ ciRunId: CI, record: passedCIRecordRow() }))
  assert.equal(passed.ciRunId, CI)
  assert.equal(passed.record.status, 'passed')
  assert.equal(passed.record.metrics['score'], 1.5)

  const failed = unwrap(createFailedCICompletion({ ciRunId: CI, record: failedCIRecordRow() }))
  assert.equal(failed.record.status, 'failed')
  assert.equal(failed.record.reason, 'entry-failed')

  // A bare record is accepted too; the completion's run id is the record's id.
  const bare = unwrap(createPassedCICompletion(passedCIRecordRow()))
  assert.equal(bare.ciRunId, CI)

  expectDomainError(
    createPassedCICompletion({ ciRunId: 'ci-2', record: passedCIRecordRow() }),
    'invalid-input',
  )
  expectDomainError(
    createPassedCICompletion({ ciRunId: CI, record: failedCIRecordRow() }),
    'invalid-input',
  )
  expectDomainError(
    createFailedCICompletion({ ciRunId: CI, record: passedCIRecordRow() }),
    'invalid-input',
  )
  expectDomainError(
    createPassedCICompletion({
      ciRunId: CI,
      record: passedCIRecordRow({ metrics: { score: Number.NaN } }),
    }),
    'invalid-input',
  )
})

// ---------------------------------------------------------------------------
// Lineages, artifacts and presets
// ---------------------------------------------------------------------------

test('lineage factories validate the fixed strategy fields', () => {
  const derived = unwrap(createDerivedLineage(derivedLineage))
  assert.equal(derived.strategy, 'derive')
  assert.equal(derived.baseExperimentId, 'experiment-0')
  assert.equal(derived.temperature, 1)

  const fresh = unwrap(createFreshLineage(freshLineage))
  assert.equal(fresh.strategy, 'fresh')
  assert.equal(fresh.freshStartProbability, 0.1)

  expectDomainError(
    createFreshLineage({ ...freshLineage, freshStartProbability: 2 }),
    'invalid-input',
  )
  expectDomainError(createDerivedLineage({ ...derivedLineage, temperature: -1 }), 'invalid-input')
  expectDomainError(createDerivedLineage({ strategy: 'fresh' }), 'invalid-input')
})

test('createArtifactRef validates kind, digest, size and retention', () => {
  const artifact = unwrap(createArtifactRef(artifactRow()))
  assert.equal(artifact.id, 'artifact-1')
  assert.equal(artifact.bytes, 1024)
  assert.equal(artifact.retention, 'keep')

  expectDomainError(createArtifactRef(artifactRow({ kind: 'video' })), 'invalid-input')
  expectDomainError(createArtifactRef(artifactRow({ bytes: -1 })), 'invalid-input')
  expectDomainError(createArtifactRef(artifactRow({ digest: '' })), 'invalid-input')
  expectDomainError(createArtifactRef(artifactRow({ retention: 'forever' })), 'invalid-input')
})

test('the exploration presets are the fixed mechanism table', () => {
  assert.deepEqual(EXPLORATION_PRESETS, {
    low: { temperature: 0.2, freshStartProbability: 0.02 },
    normal: { temperature: 1.0, freshStartProbability: 0.1 },
    high: { temperature: 3.0, freshStartProbability: 0.25 },
  })
})

// ---------------------------------------------------------------------------
// Program factories and transitions
// ---------------------------------------------------------------------------

test('program factories build every declared state with its methods', () => {
  const running = unwrap(createRunningProgram(programRow()))
  assert.equal(running.status, 'running')
  assert.equal(typeof running.pause, 'function')
  assert.equal(typeof running.complete, 'function')

  const paused = unwrap(createPausedProgram(pausedProgramRow()))
  assert.equal(paused.status, 'paused')
  assert.equal(paused.pausedAt, T1)
  assert.equal(typeof paused.resume, 'function')

  const stopped = unwrap(createStoppedProgram(stoppedProgramRow()))
  assert.equal(stopped.status, 'stopped')
  assert.equal(stopped.stopReason, 'done')

  const completed = unwrap(createCompletedProgram(completedProgramRow()))
  assert.equal(completed.status, 'completed')
  assert.equal(completed.completionReason, 'last issue closed')
})

test('program methods delegate to the pure transitions', () => {
  const running = unwrap(createRunningProgram(programRow()))
  const paused = running.pause(operator, T1)
  assert.equal(paused.status, 'paused')
  assert.equal(paused.pausedAt, T1)

  const resumed = paused.resume(operator, T2)
  assert.equal(resumed.status, 'running')

  const used = resumed.recordUsage(host, {
    experiments: 1,
    computeMinutes: 2,
    tokens: 3,
  })
  assert.equal(used.usage.experiments, 1)
  assert.equal(used.usage.computeMinutes, 2)
  assert.equal(used.usage.tokens, 3)

  const stopped = used.stop(operator, forged('budget'), T3)
  assert.equal(stopped.status, 'stopped')
  assert.throws(() => resumed.resume(operator, T4))
})

test('program factories reject malformed input and the wrong status', () => {
  expectDomainError(createRunningProgram(null), 'invalid-input')
  expectDomainError(createRunningProgram({ status: 'running' }), 'invalid-input')
  expectDomainError(createRunningProgram(programRow({ exploration: 'extreme' })), 'invalid-input')
  expectDomainError(createRunningProgram(programRow({ name: '' })), 'invalid-input')
  expectDomainError(
    createRunningProgram(
      programRow({ usage: { experiments: -1, computeMinutes: 0, tokens: 0 } }),
    ),
    'invalid-input',
  )
  expectDomainError(createPausedProgram(programRow()), 'invalid-input')
  expectDomainError(createRunningProgram(pausedProgramRow()), 'invalid-input')
})

// ---------------------------------------------------------------------------
// Issue factories and ownership
// ---------------------------------------------------------------------------

test('issue factories build open, assigned and closed states', () => {
  const open = unwrap(createOpenIssue(openIssueRow()))
  assert.equal(open.status, 'open')
  assert.equal(typeof open.claim, 'function')

  const assigned = unwrap(createAssignedIssue(assignedIssueRow()))
  assert.equal(assigned.status, 'assigned')
  assert.equal(assigned.assignee.sessionId, 'researcher-1')
  assert.equal(typeof assigned.authorize, 'function')

  const closed = unwrap(createClosedIssue(closedIssueRow()))
  assert.equal(closed.status, 'closed')
  assert.equal(closed.resolution, 'accepted')
  assert.equal(closed.summary, 'accepted')
})

test('issue ownership: claim, authorize, addExperiment and close', () => {
  const open = unwrap(createOpenIssue(openIssueRow()))
  const assigned = open.claim(researcher, T1)
  assert.equal(assigned.status, 'assigned')
  assert.equal(assigned.assignee.sessionId, 'researcher-1')

  const assignment = unwrap(assigned.authorize(researcher))
  assert.equal(assignment.issueId, ISSUE)
  expectDomainError(assigned.authorize(otherResearcher), 'forbidden')

  const withExperiment = unwrap(assigned.addExperiment(assignment, forged(EXPERIMENT), T2))
  assert.deepEqual(withExperiment.experimentIds, [EXPERIMENT])
  expectDomainError(
    withExperiment.addExperiment(assignment, forged(EXPERIMENT), T2),
    'conflict',
  )

  const closed = unwrap(withExperiment.close(assignment, 'accepted', forged('accepted'), T3))
  assert.equal(closed.status, 'closed')
  assert.equal(closed.assigneeSessionId, 'researcher-1')
  expectDomainError(withExperiment.close(assignment, 'accepted', forged(''), T3), 'invalid-input')
})

test('issue factories reject malformed labels, resolution and author', () => {
  expectDomainError(createOpenIssue(openIssueRow({ labels: ['research', 'nope'] })), 'invalid-input')
  expectDomainError(createOpenIssue(openIssueRow({ title: '' })), 'invalid-input')
  expectDomainError(
    createOpenIssue(openIssueRow({ author: { kind: 'robot', sessionId: 'x' } })),
    'invalid-input',
  )
  expectDomainError(createClosedIssue(closedIssueRow({ resolution: 'maybe' })), 'invalid-input')
  expectDomainError(createAssignedIssue(assignedIssueRow({ assigneeSessionId: '' })), 'invalid-input')
})

// ---------------------------------------------------------------------------
// Ticket factories
// ---------------------------------------------------------------------------

test('ticket factories build every status variant', () => {
  assert.equal(unwrap(createOpenTicket(openTicketRow())).status, 'open')
  assert.equal(unwrap(createRunningTicket(runningTicketRow())).status, 'running')
  assert.equal(unwrap(createSubmittedTicket(submittedTicketRow())).status, 'submitted')
  assert.equal(unwrap(createCancelledTicket(cancelledTicketRow())).status, 'cancelled')
  assert.equal(unwrap(createFailedTicket(failedTicketRow())).status, 'failed')

  const submitted = unwrap(createSubmittedTicket(submittedTicketRow()))
  assert.equal(submitted.head, HEAD)
  expectDomainError(createRunningTicket(openTicketRow()), 'invalid-input')
  expectDomainError(createOpenTicket({ ...openTicketRow(), baseCommit: undefined }), 'invalid-input')
})

// ---------------------------------------------------------------------------
// Experiment factories and the ownership flow
// ---------------------------------------------------------------------------

test('experiment factories build every declared status', () => {
  assert.equal(unwrap(createOpenExperiment(openExperimentRow())).status, 'open')
  assert.equal(unwrap(createReadyExperiment(readyExperimentRow())).status, 'ready')
  assert.equal(unwrap(createCIPendingExperiment(pendingExperimentRow())).status, 'ci-pending')
  assert.equal(unwrap(createCIRunningExperiment(runningExperimentRow())).status, 'ci-running')
  assert.equal(unwrap(createCIPassedExperiment(passedExperimentRow())).status, 'ci-passed')
  assert.equal(unwrap(createCIFailedExperiment(failedExperimentRow())).status, 'ci-failed')
  assert.equal(unwrap(createClosedExperiment(closedExperimentRow())).status, 'closed')

  assert.equal(typeof unwrap(createOpenExperiment(openExperimentRow())).submit, 'function')
  assert.equal(typeof unwrap(createReadyExperiment(readyExperimentRow())).requestCI, 'function')
  assert.equal(typeof unwrap(createCIFailedExperiment(failedExperimentRow())).revise, 'function')
})

test('experiment factories reject malformed environment, lineage and status', () => {
  expectDomainError(
    createOpenExperiment(
      openExperimentRow({ environment: { kind: 'conda', pythonVersion: '3.12' } }),
    ),
    'invalid-input',
  )
  expectDomainError(
    createOpenExperiment(openExperimentRow({ lineage: { strategy: 'magic' } })),
    'invalid-input',
  )
  expectDomainError(createReadyExperiment(openExperimentRow()), 'invalid-input')
  expectDomainError(
    createCIFailedExperiment(failedExperimentRow({ failureReason: 'bad-luck' })),
    'invalid-input',
  )
})

test('experiment ownership: submit, requestCI, startCI, passCI and close', () => {
  const created = unwrap(createOpenExperiment(openExperimentRow({ ticket: runningTicketRow() })))
  const ready = created.submit(implementer, bindingFor(runningTicketRow()), HEAD, environment, T1)
  assert.equal(ready.ok, true)
  if (!ready.ok) return
  assert.equal(ready.value.status, 'ready')

  const assignment = unwrap(createIssueAssignment(forged(ISSUE), researcher))
  const token = unwrap(
    createCIRequestToken({ ciRunId: CI, experimentId: EXPERIMENT, commit: HEAD, requestedAt: T2 }),
  )
  const pending = ready.value.requestCI(assignment, token, T2)
  assert.equal(pending.ok, true)
  if (!pending.ok) return

  const running = pending.value.startCI(host, 'digest-1', T3)
  assert.equal(running.status, 'ci-running')

  const completion = unwrap(
    createPassedCICompletion({ ciRunId: CI, record: passedCIRecordRow() }),
  )
  const passed = running.passCI(host, completion, T4)
  assert.equal(passed.ok, true)
  if (!passed.ok) return

  const closed = passed.value.close(assignment, forged('concluded'), T5)
  assert.equal(closed.ok, true)
  if (!closed.ok) return
  assert.equal(closed.value.status, 'closed')
  assert.equal(closed.value.outcome, 'concluded')
})

test('experiment ownership refusals and the binding-only submit path', () => {
  const created = unwrap(createOpenExperiment(openExperimentRow({ ticket: runningTicketRow() })))
  const validBinding = bindingFor(runningTicketRow())
  const wrongActor = createImplementerPrincipal(forged('impl-2'), forged(TICKET))
  expectDomainError(created.submit(wrongActor, validBinding, HEAD, environment, T1), 'forbidden')

  // A row without an embedded Ticket still supports submit; the binding is checked
  // against the Experiment and the acting Implementer Session.
  const withoutTicket = unwrap(createOpenExperiment(openExperimentRow()))
  const ready = withoutTicket.submit(implementer, validBinding, HEAD, environment, T1)
  assert.equal(ready.ok, true)
  if (!ready.ok) return
  assert.equal(ready.value.status, 'ready')

  const revised = ready.value.revise(implementer, validBinding, OTHER_HEAD, environment, T2)
  assert.equal(revised.ok, true)
  if (!revised.ok) return
  assert.equal(revised.value.status, 'open')
  assert.equal(revised.value.head, OTHER_HEAD)

  const otherBinding = unwrap(
    createTicketBinding({
      ticket: submittedTicketRow(),
      expected: {
        programId: PROGRAM,
        issueId: ISSUE,
        experimentId: EXPERIMENT,
        sessionId: 'impl-1',
      },
    }),
  )
  const otherExperiment = unwrap(
    createOpenExperiment(openExperimentRow({ id: 'experiment-2' })),
  )
  expectDomainError(
    otherExperiment.submit(implementer, otherBinding, HEAD, environment, T1),
    'forbidden',
  )
})

// ---------------------------------------------------------------------------
// Hydration: valid rows
// ---------------------------------------------------------------------------

test('hydrateProgram accepts every declared status and exposes the methods', () => {
  const rows = [programRow(), pausedProgramRow(), stoppedProgramRow(), completedProgramRow()]
  const states = rows.map((row) => unwrap(hydrateProgram(row)))
  assert.deepEqual(
    states.map((state) => state.status),
    ['running', 'paused', 'stopped', 'completed'],
  )
  const running = states[0]
  assert.equal(typeof running.pause, 'function')
  const paused = states[1]
  assert.equal(typeof paused.resume, 'function')
})

test('hydrateIssue, hydrateTicket and hydrateArtifact round-trip structural rows', () => {
  const issues = [openIssueRow(), assignedIssueRow(), closedIssueRow()].map((row) =>
    unwrap(hydrateIssue(row)),
  )
  assert.deepEqual(
    issues.map((issue) => issue.status),
    ['open', 'assigned', 'closed'],
  )
  assert.equal(typeof issues[0].claim, 'function')
  assert.equal(typeof issues[1].authorize, 'function')

  const tickets = [
    openTicketRow(),
    runningTicketRow(),
    submittedTicketRow(),
    cancelledTicketRow(),
    failedTicketRow(),
  ].map((row) => unwrap(hydrateTicket(row)))
  assert.deepEqual(
    tickets.map((ticket) => ticket.status),
    ['open', 'running', 'submitted', 'cancelled', 'failed'],
  )

  const artifact = unwrap(hydrateArtifact(artifactRow()))
  assert.equal(artifact.kind, 'report')
  assert.equal(artifact.bytes, 1024)
})

test('hydrateExperiment accepts every declared status', () => {
  const rows = [
    openExperimentRow(),
    readyExperimentRow(),
    pendingExperimentRow(),
    runningExperimentRow(),
    passedExperimentRow(),
    failedExperimentRow(),
    closedExperimentRow(),
  ]
  const states = rows.map((row) => unwrap(hydrateExperiment(row)))
  assert.deepEqual(
    states.map((state) => state.status),
    ['open', 'ready', 'ci-pending', 'ci-running', 'ci-passed', 'ci-failed', 'closed'],
  )
  assert.equal(typeof states[0].submit, 'function')
  assert.equal(typeof states[4].close, 'function')
})

test('hydrateCIRecord accepts every declared status and validates the metrics', () => {
  const records = [
    requestedCIRecordRow(),
    runningCIRecordRow(),
    passedCIRecordRow(),
    failedCIRecordRow(),
  ].map((row) => unwrap(hydrateCIRecord(row)))
  assert.deepEqual(
    records.map((record) => record.status),
    ['requested', 'running', 'passed', 'failed'],
  )
  const passed = records[2]
  assert.equal(passed.metrics['score'], 1.5)
  assert.equal(passed.artifacts.length, 1)
  assert.equal(passed.durationMs, 60000)
})

test('hydrateAuditEntry, hydrateAttention and hydrateIssueComment accept valid rows', () => {
  const entry = unwrap(hydrateAuditEntry(auditRow()))
  assert.equal(entry.action, 'issue.claimed')
  assert.equal(entry.actor.kind, 'researcher')
  assert.equal(entry.subject.kind, 'issue')
  assert.deepEqual(entry.detail, { note: 'claimed', count: 1, ok: true, missing: null })

  const hostEntry = unwrap(
    hydrateAuditEntry(
      auditRow({
        action: 'artifact.stored',
        subject: { kind: 'artifact', id: 'artifact-1' },
        actor: { kind: 'host' },
      }),
    ),
  )
  assert.equal(hostEntry.actor.kind, 'host')

  const attention = unwrap(hydrateAttention(attentionRow()))
  assert.equal(attention.severity, 'warning')
  assert.equal(attention.subject.kind, 'program')

  const acknowledged = unwrap(hydrateAttention(attentionRow({ acknowledgedAt: T1 })))
  assert.equal(acknowledged.acknowledgedAt, T1)

  const comment = unwrap(hydrateIssueComment(commentRow()))
  assert.equal(comment.kind, 'plan')
  assert.equal(comment.body, 'the plan is appended')

  const operatorComment = unwrap(hydrateIssueComment(commentRow({ authorSessionId: 'operator' })))
  assert.equal(operatorComment.authorSessionId, 'operator')
})

// ---------------------------------------------------------------------------
// Hydration: malformed rows are rejected, not thrown
// ---------------------------------------------------------------------------

test('hydration rejects non-object rows and unknown statuses', () => {
  expectCorrupt(hydrateProgram(null))
  expectCorrupt(hydrateProgram([]))
  expectCorrupt(hydrateProgram({ ...programRow(), status: 'sleeping' }))
  expectCorrupt(hydrateProgram({ ...programRow(), name: '' }))
  expectCorrupt(hydrateIssue({ ...openIssueRow(), status: 'draft' }))
  expectCorrupt(hydrateExperiment({ ...openExperimentRow(), status: 'unknown' }))
  expectCorrupt(hydrateTicket({ ...openTicketRow(), status: 'archived' }))
  expectCorrupt(hydrateCIRecord({ ...requestedCIRecordRow(), status: 'cancelled' }))
  expectCorrupt(hydrateArtifact(artifactRow({ kind: 'video' })))
})

test('hydration rejects missing fields, non-finite metrics and malformed records', () => {
  expectCorrupt(hydrateProgram({ ...programRow(), id: '' }))
  expectCorrupt(hydrateProgram({ ...programRow(), budget: { maxExperiments: 0 } }))
  expectCorrupt(hydrateIssue(assignedIssueRow({ assigneeSessionId: '' })))
  expectCorrupt(hydrateExperiment(openExperimentRow({ head: '' })))
  expectCorrupt(hydrateExperiment(openExperimentRow({ lineage: { strategy: 'derive' } })))
  expectCorrupt(hydrateCIRecord(passedCIRecordRow({ metrics: { score: Number.POSITIVE_INFINITY } })))
  expectCorrupt(hydrateCIRecord(passedCIRecordRow({ durationMs: -1 })))
  expectCorrupt(hydrateCIRecord(passedCIRecordRow({ artifacts: [{ id: 'x' }] })))
  expectCorrupt(hydrateIssueComment(commentRow({ kind: 'review' })))
  expectCorrupt(hydrateIssueComment(commentRow({ body: '' })))
  expectCorrupt(hydrateAttention(attentionRow({ severity: 'urgent' })))
  expectCorrupt(hydrateAttention(attentionRow({ subject: { kind: 'ticket', id: TICKET } })))
})

test('hydrateAuditEntry rejects an unknown action, wrong actor kind and wrong subject kind', () => {
  expectCorrupt(hydrateAuditEntry(auditRow({ action: 'issue.teleported' })))
  expectCorrupt(
    hydrateAuditEntry(auditRow({ actor: { kind: 'host' } })),
  )
  expectCorrupt(
    hydrateAuditEntry(auditRow({ subject: { kind: 'program', id: PROGRAM } })),
  )
  expectCorrupt(
    hydrateAuditEntry(auditRow({ actor: { kind: 'implementer', sessionId: 'impl-1' } })),
  )
  expectCorrupt(
    hydrateAuditEntry(auditRow({ detail: { nested: { not: 'allowed' } } })),
  )
})

// ---------------------------------------------------------------------------
// Round trips and StoreError mapping
// ---------------------------------------------------------------------------

test('a hydrated OpenIssue exposes claim and mints an AssignedIssue', () => {
  const open = unwrap(hydrateIssue(openIssueRow()))
  assert.equal(typeof open.claim, 'function')
  const assigned = open.claim(researcher, T1)
  assert.equal(assigned.status, 'assigned')
  assert.equal(assigned.assignee.sessionId, 'researcher-1')
  assert.equal(typeof assigned.authorize, 'function')

  const assignment = unwrap(assigned.authorize(researcher))
  assert.equal(assignment.issueId, ISSUE)
})

test('a hydrated OpenExperiment exposes submit and can become Ready', () => {
  const open = unwrap(hydrateExperiment(openExperimentRow({ ticket: submittedTicketRow() })))
  assert.equal(typeof open.submit, 'function')
  const ready = open.submit(implementer, bindingFor(submittedTicketRow()), HEAD, environment, T1)
  assert.equal(ready.ok, true)
  if (!ready.ok) return
  assert.equal(ready.value.status, 'ready')
  assert.equal(typeof ready.value.requestCI, 'function')
})

test('hydration maps factory refusals to a corrupt StoreError', () => {
  const result = hydrateProgram(programRow({ usage: { experiments: Number.NaN } }))
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.kind, 'corrupt')
  assert.match(result.error.message, /corrupt/)
})
