/**
 * Runtime tests for the pure domain transitions.
 *
 * The fixtures are plain data records, mirroring what the factory boundary hands to the
 * transition functions. Every refusal test asserts the DomainError code, and every
 * ownership-sensitive transition is exercised with a matching token, a wrong-target
 * token and a wrong-session token.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  addExperiment,
  authorizeIssue,
  cancelCIRecord,
  cancelExperiment,
  cancelTicket,
  claimIssue,
  closeAssignedIssue,
  closeExperiment,
  closeOpenIssue,
  completeProgram,
  createTicketBinding,
  failCIRecord,
  failExperimentCI,
  failTicket,
  passCIRecord,
  passExperimentCI,
  pauseProgram,
  recordUsage,
  requestCIRecord,
  requestExperimentCI,
  resumeProgram,
  reviseExperiment,
  setExploration,
  setGoal,
  setMethodology,
  startCIRecord,
  startExperimentCI,
  startTicket,
  stopProgram,
  submitExperiment,
  submitTicket,
} from '../src/runtime/domain.ts'

const T0 = '2026-01-01T00:00:00.000Z'
const T1 = '2026-01-01T01:00:00.000Z'
const T2 = '2026-01-01T02:00:00.000Z'
const T3 = '2026-01-01T03:00:00.000Z'
const T4 = '2026-01-01T04:00:00.000Z'
const T5 = '2026-01-01T05:00:00.000Z'
const T6 = '2026-01-01T06:00:00.000Z'

const environment = {
  kind: 'uv-lock',
  lockFile: 'uv.lock',
  pythonVersion: '3.12',
}

const otherEnvironment = {
  kind: 'requirements',
  requirementsFile: 'requirements.txt',
  pythonVersion: '3.11',
}

const freshLineage = {
  strategy: 'fresh',
  baseCommit: 'commit-0',
  freshStartProbability: 0.1,
}

const derivedLineage = {
  strategy: 'derive',
  baseExperimentId: 'experiment-0',
  baseCommit: 'commit-0',
  temperature: 1,
  sampledWeight: 0.5,
}

function unwrap(result) {
  if (result.ok) {
    return result.value
  }
  assert.fail(`expected Ok, got ${result.error.code}: ${result.error.message}`)
}

function expectRefusal(result, code) {
  assert.equal(result.ok, false)
  if (result.ok) {
    return
  }
  assert.equal(result.error.code, code)
  assert.ok(result.error.message.length > 0)
}

// ---------------------------------------------------------------------------
// Program fixtures and transitions
// ---------------------------------------------------------------------------

function runningProgram(overrides = {}) {
  return {
    status: 'running',
    id: 'program-1',
    name: 'Battery research',
    goal: 'improve the score',
    methodology: 'ablation driven',
    contract: {
      ciEntry: 'uv run ci',
      timeoutMs: 60000,
      requiredMetrics: ['score'],
    },
    utility: {
      metrics: [{ name: 'score', direction: 'higher', weight: 1 }],
    },
    exploration: 'normal',
    budget: { maxExperiments: 10, maxComputeMinutes: 100, maxTokens: 1000 },
    usage: { experiments: 1, computeMinutes: 10, tokens: 100 },
    createdAt: T0,
    ...overrides,
  }
}

function pausedProgram(overrides = {}) {
  return runningProgram({ status: 'paused', pausedAt: T1, ...overrides })
}

test('program pause and resume round trip', () => {
  const paused = unwrap(pauseProgram(runningProgram(), T1))
  assert.equal(paused.status, 'paused')
  assert.equal(paused.pausedAt, T1)

  const resumed = unwrap(resumeProgram(paused))
  assert.equal(resumed.status, 'running')
  assert.equal(resumed.goal, 'improve the score')
})

test('program pause rejects every non-running state', () => {
  expectRefusal(pauseProgram(pausedProgram(), T1), 'invalid-state')
  expectRefusal(
    pauseProgram(runningProgram({ status: 'stopped', stoppedAt: T1, stopReason: 'done' }), T2),
    'invalid-state',
  )
  expectRefusal(
    pauseProgram(
      runningProgram({ status: 'completed', completedAt: T1, completionReason: 'done' }),
      T2,
    ),
    'invalid-state',
  )
  expectRefusal(resumeProgram(runningProgram()), 'invalid-state')
})

test('program stop and complete reach terminal states', () => {
  const stopped = unwrap(stopProgram(pausedProgram(), 'operator stop', T2))
  assert.equal(stopped.status, 'stopped')
  assert.equal(stopped.stopReason, 'operator stop')
  assert.equal(stopped.stoppedAt, T2)
  expectRefusal(stopProgram(stopped, 'again', T3), 'invalid-state')

  const completed = unwrap(completeProgram(runningProgram(), 'all issues closed', T2))
  assert.equal(completed.status, 'completed')
  assert.equal(completed.completionReason, 'all issues closed')
  expectRefusal(completeProgram(completed, 'again', T3), 'invalid-state')
  expectRefusal(pauseProgram(stopped, T3), 'invalid-state')
})

test('program setters only change running or paused programs', () => {
  const running = runningProgram()
  assert.equal(unwrap(setGoal(running, 'new goal')).goal, 'new goal')
  assert.equal(unwrap(setMethodology(running, 'new method')).methodology, 'new method')
  assert.equal(unwrap(setExploration(running, 'high')).exploration, 'high')

  const paused = pausedProgram()
  const pausedGoal = unwrap(setGoal(paused, 'paused goal'))
  assert.equal(pausedGoal.status, 'paused')
  assert.equal(pausedGoal.goal, 'paused goal')
  assert.equal(unwrap(setMethodology(paused, 'paused method')).methodology, 'paused method')
  assert.equal(unwrap(setExploration(paused, 'low')).exploration, 'low')

  expectRefusal(setGoal(running, ''), 'invalid-input')
  const stopped = runningProgram({ status: 'stopped', stoppedAt: T1, stopReason: 'done' })
  expectRefusal(setGoal(stopped, 'later'), 'invalid-state')
  expectRefusal(setMethodology(stopped, 'later'), 'invalid-state')
  expectRefusal(setExploration(stopped, 'high'), 'invalid-state')
})

test('recordUsage adds non-negative deltas monotonically', () => {
  const first = unwrap(
    recordUsage(runningProgram(), { experiments: 1, computeMinutes: 5, tokens: 50 }),
  )
  assert.deepEqual(first.usage, { experiments: 2, computeMinutes: 15, tokens: 150 })
  const second = unwrap(
    recordUsage(first, { experiments: 2, computeMinutes: 30, tokens: 300 }),
  )
  assert.deepEqual(second.usage, { experiments: 4, computeMinutes: 45, tokens: 450 })

  const paused = unwrap(
    recordUsage(pausedProgram(), { experiments: 0, computeMinutes: 1, tokens: 1 }),
  )
  assert.equal(paused.status, 'paused')
  assert.deepEqual(paused.usage, { experiments: 1, computeMinutes: 11, tokens: 101 })

  expectRefusal(
    recordUsage(runningProgram(), { experiments: -1, computeMinutes: 0, tokens: 0 }),
    'invalid-input',
  )
  expectRefusal(
    recordUsage(runningProgram(), { experiments: 0, computeMinutes: Number.NaN, tokens: 0 }),
    'invalid-input',
  )
  expectRefusal(
    recordUsage(runningProgram(), {
      experiments: 0,
      computeMinutes: 0,
      tokens: Number.POSITIVE_INFINITY,
    }),
    'invalid-input',
  )
  const stopped = runningProgram({ status: 'stopped', stoppedAt: T1, stopReason: 'done' })
  expectRefusal(
    recordUsage(stopped, { experiments: 1, computeMinutes: 1, tokens: 1 }),
    'invalid-state',
  )
})

// ---------------------------------------------------------------------------
// Issue fixtures and transitions
// ---------------------------------------------------------------------------

function openIssue(overrides = {}) {
  return {
    status: 'open',
    id: 'issue-1',
    programId: 'program-1',
    title: 'Does calibration help?',
    body: 'Compare calibration against the baseline.',
    labels: ['research'],
    author: { kind: 'researcher', sessionId: 'researcher-1' },
    createdAt: T0,
    ...overrides,
  }
}

function assignedIssue(overrides = {}) {
  return {
    status: 'assigned',
    id: 'issue-1',
    programId: 'program-1',
    title: 'Does calibration help?',
    body: 'Compare calibration against the baseline.',
    labels: ['research'],
    author: { kind: 'researcher', sessionId: 'researcher-1' },
    createdAt: T0,
    assigneeSessionId: 'researcher-1',
    assignedAt: T1,
    experimentIds: [],
    ...overrides,
  }
}

function closedIssue(overrides = {}) {
  return assignedIssue({
    status: 'closed',
    assigneeSessionId: 'researcher-1',
    closedAt: T2,
    resolution: 'accepted',
    summary: 'accepted',
    ...overrides,
  })
}

test('issue claim assigns one researcher and authorize proves it', () => {
  const assigned = unwrap(claimIssue(openIssue(), 'researcher-1', T1))
  assert.equal(assigned.status, 'assigned')
  assert.equal(assigned.assigneeSessionId, 'researcher-1')
  assert.deepEqual(assigned.experimentIds, [])

  const assignment = unwrap(authorizeIssue(assigned, 'researcher-1'))
  assert.deepEqual(assignment, { issueId: 'issue-1', assigneeSessionId: 'researcher-1' })

  expectRefusal(authorizeIssue(assigned, 'researcher-2'), 'forbidden')
  expectRefusal(authorizeIssue(openIssue(), 'researcher-1'), 'invalid-state')
  expectRefusal(authorizeIssue(closedIssue(), 'researcher-1'), 'invalid-state')
  expectRefusal(claimIssue(assigned, 'researcher-2', T2), 'invalid-state')
  expectRefusal(claimIssue(openIssue(), '', T1), 'invalid-input')
})

test('issue addExperiment requires the exact assignment token', () => {
  const issue = assignedIssue({ experimentIds: ['experiment-1'] })
  const assignment = { issueId: 'issue-1', assigneeSessionId: 'researcher-1' }

  const next = unwrap(addExperiment(issue, assignment, 'experiment-2'))
  assert.deepEqual(next.experimentIds, ['experiment-1', 'experiment-2'])

  expectRefusal(
    addExperiment(issue, { issueId: 'issue-2', assigneeSessionId: 'researcher-1' }, 'x'),
    'forbidden',
  )
  expectRefusal(
    addExperiment(issue, { issueId: 'issue-1', assigneeSessionId: 'researcher-2' }, 'x'),
    'forbidden',
  )
  expectRefusal(addExperiment(issue, assignment, 'experiment-1'), 'conflict')
  expectRefusal(addExperiment(issue, assignment, ''), 'invalid-input')
  expectRefusal(addExperiment(openIssue(), assignment, 'x'), 'invalid-state')
})

test('issue close follows the assignment token and records the resolution', () => {
  const issue = assignedIssue()
  const assignment = { issueId: 'issue-1', assigneeSessionId: 'researcher-1' }

  const closed = unwrap(
    closeAssignedIssue(issue, assignment, 'rejected', 'the effect was noise', T2),
  )
  assert.equal(closed.status, 'closed')
  assert.equal(closed.resolution, 'rejected')
  assert.equal(closed.summary, 'the effect was noise')
  assert.equal(closed.assigneeSessionId, 'researcher-1')

  expectRefusal(
    closeAssignedIssue(issue, { issueId: 'issue-2', assigneeSessionId: 'researcher-1' }, 'accepted', 'x', T2),
    'forbidden',
  )
  expectRefusal(
    closeAssignedIssue(issue, { issueId: 'issue-1', assigneeSessionId: 'researcher-2' }, 'accepted', 'x', T2),
    'forbidden',
  )
  expectRefusal(closeAssignedIssue(issue, assignment, 'accepted', '', T2), 'invalid-input')
  expectRefusal(closeAssignedIssue(closedIssue(), assignment, 'accepted', 'x', T2), 'invalid-state')

  const operatorClosed = unwrap(closeOpenIssue(openIssue(), 'abandoned', 'not pursued', T2))
  assert.equal(operatorClosed.status, 'closed')
  assert.equal(operatorClosed.assigneeSessionId, null)
  expectRefusal(closeOpenIssue(issue, 'accepted', 'x', T2), 'invalid-state')
})

// ---------------------------------------------------------------------------
// Ticket fixtures and transitions
// ---------------------------------------------------------------------------

function openTicket(overrides = {}) {
  return {
    status: 'open',
    id: 'ticket-1',
    programId: 'program-1',
    issueId: 'issue-1',
    experimentId: 'experiment-1',
    baseCommit: 'commit-1',
    createdAt: T0,
    ...overrides,
  }
}

function runningTicket(overrides = {}) {
  return openTicket({
    status: 'running',
    sessionId: 'implementer-1',
    startedAt: T1,
    ...overrides,
  })
}

function submittedTicket(overrides = {}) {
  return runningTicket({
    status: 'submitted',
    head: 'commit-2',
    submittedAt: T2,
    ...overrides,
  })
}

test('ticket start and submit are session bound', () => {
  const running = unwrap(startTicket(openTicket(), 'implementer-1', T1))
  assert.equal(running.status, 'running')
  assert.equal(running.sessionId, 'implementer-1')

  const submitted = unwrap(submitTicket(running, 'implementer-1', 'commit-2', T2))
  assert.equal(submitted.status, 'submitted')
  assert.equal(submitted.head, 'commit-2')

  expectRefusal(submitTicket(running, 'implementer-2', 'commit-2', T2), 'forbidden')
  expectRefusal(submitTicket(openTicket(), 'implementer-1', 'commit-2', T2), 'invalid-state')
  expectRefusal(submitTicket(submitted, 'implementer-1', 'commit-3', T3), 'invalid-state')
  expectRefusal(startTicket(running, 'implementer-2', T2), 'invalid-state')
})

test('ticket cancel and fail are terminal', () => {
  const cancelled = unwrap(cancelTicket(runningTicket(), 'stalled', T2))
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.reason, 'stalled')

  const failed = unwrap(failTicket(submittedTicket(), 'worker crashed', T3))
  assert.equal(failed.status, 'failed')
  assert.equal(failed.reason, 'worker crashed')

  expectRefusal(cancelTicket(cancelled, 'again', T3), 'invalid-state')
  expectRefusal(failTicket(failed, 'again', T3), 'invalid-state')
  expectRefusal(cancelTicket(runningTicket(), '', T2), 'invalid-input')
})

test('createTicketBinding compares program, issue, experiment and session', () => {
  const expectation = {
    programId: 'program-1',
    issueId: 'issue-1',
    experimentId: 'experiment-1',
    sessionId: 'implementer-1',
  }

  const binding = unwrap(createTicketBinding(submittedTicket(), expectation))
  assert.deepEqual(binding, {
    ticketId: 'ticket-1',
    experimentId: 'experiment-1',
    sessionId: 'implementer-1',
  })

  expectRefusal(createTicketBinding(openTicket(), expectation), 'invalid-state')
  expectRefusal(
    createTicketBinding(submittedTicket(), { ...expectation, programId: 'program-2' }),
    'forbidden',
  )
  expectRefusal(
    createTicketBinding(submittedTicket(), { ...expectation, issueId: 'issue-2' }),
    'forbidden',
  )
  expectRefusal(
    createTicketBinding(submittedTicket(), { ...expectation, experimentId: 'experiment-2' }),
    'forbidden',
  )
  expectRefusal(
    createTicketBinding(submittedTicket(), { ...expectation, sessionId: 'implementer-2' }),
    'forbidden',
  )
})

// ---------------------------------------------------------------------------
// Experiment fixtures and transitions
// ---------------------------------------------------------------------------

function openExperiment(overrides = {}) {
  return {
    status: 'open',
    id: 'experiment-1',
    programId: 'program-1',
    issueId: 'issue-1',
    branch: 'experiment/calibration',
    head: 'commit-1',
    environment,
    lineage: freshLineage,
    planCommentId: 'comment-1',
    createdBySessionId: 'researcher-1',
    createdAt: T0,
    ...overrides,
  }
}

function readyExperiment(overrides = {}) {
  return openExperiment({ status: 'ready', head: 'commit-2', readyAt: T2, ...overrides })
}

function pendingExperiment(overrides = {}) {
  return readyExperiment({
    status: 'ci-pending',
    ciRunId: 'ci-1',
    requestedAt: T3,
    ...overrides,
  })
}

function runningExperiment(overrides = {}) {
  return pendingExperiment({
    status: 'ci-running',
    startedAt: T4,
    environmentDigest: 'digest-1',
    ...overrides,
  })
}

function failedExperiment(overrides = {}) {
  return runningExperiment({
    status: 'ci-failed',
    startedAt: T4,
    environmentDigest: 'digest-1',
    failureReason: 'entry-failed',
    failureDetail: 'the entry exited with code 1',
    failedAt: T5,
    ...overrides,
  })
}

const binding = {
  ticketId: 'ticket-1',
  experimentId: 'experiment-1',
  sessionId: 'implementer-1',
}

const assignment = { issueId: 'issue-1', assigneeSessionId: 'researcher-1' }

const ciRequestToken = {
  ciRunId: 'ci-1',
  experimentId: 'experiment-1',
  commit: 'commit-2',
  requestedAt: T3,
}

function passedRecord(overrides = {}) {
  return {
    status: 'passed',
    id: 'ci-1',
    programId: 'program-1',
    experimentId: 'experiment-1',
    commit: 'commit-2',
    requestedBySessionId: 'researcher-1',
    requestedAt: T3,
    startedAt: T4,
    finishedAt: T5,
    environmentDigest: 'digest-1',
    metrics: { score: 0.9 },
    artifacts: [],
    durationMs: 1000,
    ...overrides,
  }
}

function failedRecord(overrides = {}) {
  return {
    status: 'failed',
    id: 'ci-1',
    programId: 'program-1',
    experimentId: 'experiment-1',
    commit: 'commit-2',
    requestedBySessionId: 'researcher-1',
    requestedAt: T3,
    startedAt: T4,
    finishedAt: T5,
    environmentDigest: 'digest-1',
    reason: 'entry-failed',
    detail: 'the entry exited with code 1',
    durationMs: 1000,
    ...overrides,
  }
}

test('experiment submit requires the ticket and binding to agree', () => {
  const ready = unwrap(
    submitExperiment(
      openExperiment(),
      submittedTicket(),
      'implementer-1',
      binding,
      'commit-2',
      environment,
      T2,
    ),
  )
  assert.equal(ready.status, 'ready')
  assert.equal(ready.head, 'commit-2')
  assert.equal(ready.readyAt, T2)
  assert.equal(ready.lineage.strategy, 'fresh')

  expectRefusal(
    submitExperiment(
      openExperiment(),
      submittedTicket(),
      'implementer-1',
      { ...binding, experimentId: 'experiment-2' },
      'commit-2',
      environment,
      T2,
    ),
    'forbidden',
  )
  expectRefusal(
    submitExperiment(
      openExperiment(),
      submittedTicket(),
      'implementer-1',
      { ...binding, ticketId: 'ticket-2' },
      'commit-2',
      environment,
      T2,
    ),
    'forbidden',
  )
  expectRefusal(
    submitExperiment(
      openExperiment(),
      submittedTicket(),
      'implementer-2',
      binding,
      'commit-2',
      environment,
      T2,
    ),
    'forbidden',
  )
  expectRefusal(
    submitExperiment(
      openExperiment(),
      submittedTicket({ experimentId: 'experiment-2' }),
      'implementer-1',
      binding,
      'commit-2',
      environment,
      T2,
    ),
    'forbidden',
  )
  expectRefusal(
    submitExperiment(
      openExperiment(),
      submittedTicket(),
      'implementer-1',
      binding,
      'commit-3',
      environment,
      T2,
    ),
    'invalid-state',
  )
  expectRefusal(
    submitExperiment(
      readyExperiment(),
      submittedTicket(),
      'implementer-1',
      binding,
      'commit-3',
      environment,
      T3,
    ),
    'invalid-state',
  )
})

test('experiment requestCI requires the issue assignment and CI token', () => {
  const pending = unwrap(
    requestExperimentCI(readyExperiment(), assignment, ciRequestToken),
  )
  assert.equal(pending.status, 'ci-pending')
  assert.equal(pending.ciRunId, 'ci-1')
  assert.equal(pending.requestedAt, T3)

  expectRefusal(
    requestExperimentCI(readyExperiment(), { ...assignment, issueId: 'issue-2' }, ciRequestToken),
    'forbidden',
  )
  expectRefusal(
    requestExperimentCI(
      readyExperiment(),
      { ...assignment, assigneeSessionId: 'researcher-2' },
      ciRequestToken,
    ),
    'forbidden',
  )
  expectRefusal(
    requestExperimentCI(
      readyExperiment(),
      assignment,
      { ...ciRequestToken, experimentId: 'experiment-2' },
    ),
    'forbidden',
  )
  expectRefusal(
    requestExperimentCI(readyExperiment(), assignment, { ...ciRequestToken, commit: 'commit-9' }),
    'forbidden',
  )
  expectRefusal(requestExperimentCI(openExperiment(), assignment, ciRequestToken), 'invalid-state')
  expectRefusal(
    requestExperimentCI(pendingExperiment(), assignment, ciRequestToken),
    'invalid-state',
  )
})

test('experiment CI lifecycle records the evidence', () => {
  const running = unwrap(startExperimentCI(pendingExperiment(), 'digest-1', T4))
  assert.equal(running.status, 'ci-running')
  assert.equal(running.startedAt, T4)

  const passed = unwrap(
    passExperimentCI(running, { ciRunId: 'ci-1', record: passedRecord() }),
  )
  assert.equal(passed.status, 'ci-passed')
  assert.equal(passed.finishedAt, T5)
  assert.equal(passed.ciRunId, 'ci-1')

  const failed = unwrap(
    failExperimentCI(running, { ciRunId: 'ci-1', record: failedRecord() }),
  )
  assert.equal(failed.status, 'ci-failed')
  assert.equal(failed.failureReason, 'entry-failed')
  assert.equal(failed.failureDetail, 'the entry exited with code 1')
  assert.equal(failed.failedAt, T5)

  expectRefusal(startExperimentCI(readyExperiment(), 'digest-1', T4), 'invalid-state')
  expectRefusal(startExperimentCI(pendingExperiment(), '', T4), 'invalid-input')
})

test('experiment CI evidence must belong to the experiment run', () => {
  const running = runningExperiment()

  expectRefusal(
    passExperimentCI(running, { ciRunId: 'ci-2', record: passedRecord() }),
    'forbidden',
  )
  expectRefusal(
    failExperimentCI(running, { ciRunId: 'ci-2', record: failedRecord() }),
    'forbidden',
  )
  expectRefusal(
    passExperimentCI(running, {
      ciRunId: 'ci-1',
      record: passedRecord({ commit: 'commit-9' }),
    }),
    'invalid-state',
  )
  expectRefusal(
    passExperimentCI(running, {
      ciRunId: 'ci-1',
      record: passedRecord({ status: 'failed' }),
    }),
    'invalid-state',
  )
  expectRefusal(
    passExperimentCI(running, {
      ciRunId: 'ci-1',
      record: passedRecord({ environmentDigest: 'digest-9' }),
    }),
    'invalid-state',
  )
  expectRefusal(
    passExperimentCI(running, {
      ciRunId: 'ci-1',
      record: passedRecord({ experimentId: 'experiment-9' }),
    }),
    'invalid-state',
  )
  expectRefusal(
    passExperimentCI(running, {
      ciRunId: 'ci-1',
      record: passedRecord({ startedAt: T2 }),
    }),
    'invalid-state',
  )
  expectRefusal(
    failExperimentCI(running, {
      ciRunId: 'ci-1',
      record: failedRecord({ reason: 'timeout', startedAt: T2 }),
    }),
    'invalid-state',
  )
})

test('experiment revise returns to open and clears CI evidence', () => {
  const revisedReady = unwrap(
    reviseExperiment(
      readyExperiment(),
      submittedTicket(),
      'implementer-1',
      binding,
      'commit-3',
      otherEnvironment,
    ),
  )
  assert.equal(revisedReady.status, 'open')
  assert.equal(revisedReady.head, 'commit-3')
  assert.equal(revisedReady.environment, otherEnvironment)
  assert.equal(Object.hasOwn(revisedReady, 'ciRunId'), false)

  const revisedFailed = unwrap(
    reviseExperiment(
      failedExperiment(),
      submittedTicket(),
      'implementer-1',
      binding,
      'commit-4',
      environment,
    ),
  )
  assert.equal(revisedFailed.status, 'open')
  assert.equal(Object.hasOwn(revisedFailed, 'failureReason'), false)

  expectRefusal(
    reviseExperiment(
      readyExperiment(),
      submittedTicket(),
      'implementer-2',
      binding,
      'commit-3',
      environment,
    ),
    'forbidden',
  )
  expectRefusal(
    reviseExperiment(
      pendingExperiment(),
      submittedTicket(),
      'implementer-1',
      binding,
      'commit-3',
      environment,
    ),
    'invalid-state',
  )
})

test('experiment cancel and close follow the CI outcome', () => {
  const cancelledReady = unwrap(cancelExperiment(readyExperiment(), 'superseded', T4))
  assert.equal(cancelledReady.status, 'closed')
  assert.equal(cancelledReady.outcome, 'cancelled')

  const cancelledRunning = unwrap(cancelExperiment(runningExperiment(), 'budget', T5))
  assert.equal(cancelledRunning.outcome, 'cancelled')

  const passed = runningExperiment({ status: 'ci-passed', finishedAt: T5 })
  const concluded = unwrap(closeExperiment(passed, assignment, 'significant', T6))
  assert.equal(concluded.status, 'closed')
  assert.equal(concluded.outcome, 'concluded')
  assert.equal(concluded.closeReason, 'significant')

  const failed = failedExperiment()
  const failedOutcome = unwrap(closeExperiment(failed, assignment, 'not significant', T6))
  assert.equal(failedOutcome.outcome, 'failed')

  expectRefusal(
    closeExperiment(passed, { ...assignment, issueId: 'issue-2' }, 'x', T6),
    'forbidden',
  )
  expectRefusal(
    closeExperiment(passed, { ...assignment, assigneeSessionId: 'researcher-2' }, 'x', T6),
    'forbidden',
  )
  expectRefusal(closeExperiment(runningExperiment(), assignment, 'x', T6), 'invalid-state')
  expectRefusal(closeExperiment(cancelledReady, assignment, 'x', T6), 'invalid-state')
  expectRefusal(cancelExperiment(passed, 'too late', T6), 'invalid-state')
  expectRefusal(cancelExperiment(runningExperiment(), '', T6), 'invalid-input')
})

// ---------------------------------------------------------------------------
// CI record transitions
// ---------------------------------------------------------------------------

function requestedCIRecord(overrides = {}) {
  return {
    status: 'requested',
    id: 'ci-1',
    programId: 'program-1',
    experimentId: 'experiment-1',
    commit: 'commit-2',
    requestedBySessionId: 'researcher-1',
    requestedAt: T3,
    ...overrides,
  }
}

function runningCIRecord(overrides = {}) {
  return requestedCIRecord({
    status: 'running',
    startedAt: T4,
    environmentDigest: 'digest-1',
    ...overrides,
  })
}

test('CI record request binds to the pending experiment and token', () => {
  const record = unwrap(requestCIRecord(pendingExperiment(), ciRequestToken))
  assert.equal(record.status, 'requested')
  assert.equal(record.id, 'ci-1')
  assert.equal(record.requestedBySessionId, 'researcher-1')

  expectRefusal(
    requestCIRecord(pendingExperiment(), { ...ciRequestToken, experimentId: 'experiment-2' }),
    'forbidden',
  )
  expectRefusal(
    requestCIRecord(pendingExperiment(), { ...ciRequestToken, commit: 'commit-9' }),
    'forbidden',
  )
  expectRefusal(
    requestCIRecord(pendingExperiment(), { ...ciRequestToken, ciRunId: 'ci-2' }),
    'invalid-state',
  )
})

test('CI record start only moves a requested run', () => {
  const running = unwrap(startCIRecord(requestedCIRecord(), T4, 'digest-1'))
  assert.equal(running.status, 'running')
  assert.equal(running.environmentDigest, 'digest-1')

  expectRefusal(startCIRecord(running, T5, 'digest-1'), 'invalid-state')
  expectRefusal(startCIRecord(requestedCIRecord(), '', 'digest-1'), 'invalid-input')
  expectRefusal(startCIRecord(requestedCIRecord(), T4, ''), 'invalid-input')
})

test('CI record pass validates finite and required metrics', () => {
  const result = {
    finishedAt: T5,
    metrics: { score: 0.9, loss: 0.1 },
    artifacts: [],
    durationMs: 1000,
  }
  const passed = unwrap(passCIRecord(runningCIRecord(), result, ['score']))
  assert.equal(passed.status, 'passed')
  assert.equal(passed.metrics.score, 0.9)
  assert.equal(passed.durationMs, 1000)

  expectRefusal(passCIRecord(requestedCIRecord(), result, ['score']), 'invalid-state')
  expectRefusal(passCIRecord(runningCIRecord(), result, ['score', 'accuracy']), 'invalid-input')
  expectRefusal(
    passCIRecord(runningCIRecord(), { ...result, metrics: { score: Number.NaN } }, ['score']),
    'invalid-input',
  )
  expectRefusal(
    passCIRecord(runningCIRecord(), { ...result, durationMs: -1 }, ['score']),
    'invalid-input',
  )
})

test('CI record fail and cancel persist failed evidence', () => {
  const failed = unwrap(
    failCIRecord(runningCIRecord(), {
      finishedAt: T5,
      reason: 'entry-failed',
      detail: 'the entry exited with code 1',
      durationMs: 1000,
      environmentDigest: 'digest-1',
    }),
  )
  assert.equal(failed.status, 'failed')
  assert.equal(failed.reason, 'entry-failed')
  assert.equal(failed.startedAt, T4)

  const cancelled = unwrap(cancelCIRecord(runningCIRecord(), T5, 1000))
  assert.equal(cancelled.status, 'failed')
  assert.equal(cancelled.reason, 'cancelled')

  const requested = unwrap(cancelCIRecord(requestedCIRecord(), T5, 0))
  assert.equal(requested.startedAt, undefined)

  expectRefusal(cancelCIRecord(runningCIRecord(), '', 0), 'invalid-input')
  expectRefusal(cancelCIRecord(requestedCIRecord(), T5, Number.NaN), 'invalid-input')
})

// A failed-request transition on a requested record is legal; this test keeps the
// distinction explicit instead of relying on the earlier cancel path.
test('CI record fail from a requested record keeps no start evidence', () => {
  const failed = unwrap(
    failCIRecord(requestedCIRecord(), {
      finishedAt: T4,
      reason: 'environment-build-failed',
      detail: 'uv could not resolve the lock file',
      durationMs: 200,
      environmentDigest: undefined,
    }),
  )
  assert.equal(failed.status, 'failed')
  assert.equal(failed.startedAt, undefined)
  assert.equal(failed.environmentDigest, undefined)
})

// ---------------------------------------------------------------------------
// Cross-aggregate and identity refusals
// ---------------------------------------------------------------------------

test('cross-aggregate tokens never move another aggregate', () => {
  const otherIssueAssignment = { issueId: 'issue-2', assigneeSessionId: 'researcher-1' }
  expectRefusal(
    addExperiment(assignedIssue(), otherIssueAssignment, 'experiment-1'),
    'forbidden',
  )
  expectRefusal(
    closeAssignedIssue(assignedIssue(), otherIssueAssignment, 'accepted', 'x', T2),
    'forbidden',
  )
  expectRefusal(
    requestExperimentCI(readyExperiment(), otherIssueAssignment, ciRequestToken),
    'forbidden',
  )
  expectRefusal(
    closeExperiment(runningExperiment({ status: 'ci-passed', finishedAt: T5 }), otherIssueAssignment, 'x', T6),
    'forbidden',
  )

  const otherBinding = {
    ticketId: 'ticket-1',
    experimentId: 'experiment-2',
    sessionId: 'implementer-1',
  }
  expectRefusal(
    submitExperiment(
      openExperiment(),
      submittedTicket(),
      'implementer-1',
      otherBinding,
      'commit-2',
      environment,
      T2,
    ),
    'forbidden',
  )
  expectRefusal(
    reviseExperiment(
      readyExperiment(),
      submittedTicket(),
      'implementer-1',
      otherBinding,
      'commit-3',
      environment,
    ),
    'forbidden',
  )
})

test('lineage survives every experiment transition unchanged', () => {
  const derived = openExperiment({ lineage: derivedLineage })
  const ready = unwrap(
    submitExperiment(
      derived,
      submittedTicket(),
      'implementer-1',
      binding,
      'commit-2',
      environment,
      T2,
    ),
  )
  assert.deepEqual(ready.lineage, derivedLineage)
  const pending = unwrap(requestExperimentCI(ready, assignment, ciRequestToken))
  assert.deepEqual(pending.lineage, derivedLineage)
  const closed = unwrap(cancelExperiment(pending, 'superseded', T4))
  assert.deepEqual(closed.lineage, derivedLineage)
})
