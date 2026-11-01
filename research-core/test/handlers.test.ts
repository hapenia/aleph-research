/**
 * Runtime tests for the command handlers.
 *
 * The handlers are the execution half of the write path: the route tests prove that
 * `executeRoute` reaches exactly one slot, these tests prove what the slot does. Every
 * command has a happy path against the in-memory unit of work, and the refusals prove the
 * properties the type surface cannot: a missing aggregate or a stale version is a
 * `command.refused` outcome rather than an exception, ownership checks run against the
 * stored records, a refused command leaves no partial write behind, and both outcomes
 * carry the audit fact the contract requires.
 *
 * Fixtures use the factory boundary (the same constructors the composition root uses) and
 * one `forged` helper for branded strings, mirroring `executor.test.ts`: tests are outside
 * the ESLint and `tsc` scopes in this package, and the assertion is confined to fixture
 * values the factories did not mint themselves (session ids, timestamps, `RequestId`s).
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { IssueAssignment, TicketBinding } from '../src/types/actors.js'
import type { AuditAction, AuditEntry, AuditEntryOf } from '../src/types/audit.js'
import type {
  ActorOfCommand,
  CommandContext,
  CommandOf,
  CommandOutcome,
  CommandResult,
  CommandType,
} from '../src/types/commands.js'
import type { DomainError, Result, StoreError } from '../src/types/errors.js'
import type { EnvironmentDeclaration } from '../src/types/environment.js'
import type { Experiment, ExperimentPlan, OpenExperiment } from '../src/types/experiment.js'
import type {
  CommitSha,
  CIRunId,
  DurationMs,
  ExperimentId,
  ImplementerSessionId,
  IsoTimestamp,
  IssueId,
  MetricName,
  NonEmptyArray,
  NonEmptyString,
  OperatorSessionId,
  PositiveInt,
  PositiveNumber,
  ProgramId,
  RequestId,
  ResearcherSessionId,
  TicketId,
  Version,
} from '../src/types/ids.js'
import type { IssueLabel } from '../src/types/issue.js'
import type { EvaluationContract, UtilityConfig } from '../src/types/program.js'
import type { Clock } from '../src/types/services.js'
import type { UnitOfWork, Versioned } from '../src/types/storage.js'
import type { RunningTicket } from '../src/types/ticket.js'
import type { CommandHandlers } from '../src/types/executor.js'
import type { Program } from '../src/types/program.js'
import { INITIAL_VERSION, createInMemoryStore } from '../src/runtime/storage.js'
import { createCommandHandlers } from '../src/runtime/handlers.js'
import {
  executeRoute,
  type AuditSubjectParsers,
  type RefusalAuditPort,
  type WriteRoutes,
} from '../src/runtime/executor.js'
import { COMMAND_PARSERS } from '../src/parsers-commands.js'
import {
  createCIFailedExperiment,
  createCIPassedExperiment,
  createImplementerPrincipal,
  createIssueAssignment,
  createOperatorPrincipal,
  createResearcherPrincipal,
  createRunningTicket,
  createTicketBinding,
} from '../src/factories.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Stand-in for a branded value a factory did not mint (session ids, test timestamps). */
function forged<T>(value: unknown): T {
  return value as T
}

const AT = forged<IsoTimestamp>('2026-11-02T00:00:00.000Z')
const HEAD = forged<CommitSha>('0123456789abcdef0123456789abcdef01234567')

const operator = createOperatorPrincipal(forged<OperatorSessionId>('operator-session'))
const researcher = createResearcherPrincipal(forged<ResearcherSessionId>('researcher-session'))
const otherResearcher = createResearcherPrincipal(forged<ResearcherSessionId>('other-researcher'))
const IMPLEMENTER = forged<ImplementerSessionId>('implementer-session')
const OTHER_IMPLEMENTER = forged<ImplementerSessionId>('other-implementer')

const LABELS = forged<NonEmptyArray<IssueLabel>>(['research'])
const PLAN: ExperimentPlan = {
  hypothesis: forged<NonEmptyString>('a wider clipping window improves the score'),
  steps: forged<NonEmptyArray<NonEmptyString>>(['change the window', 'run the evaluation']),
  expected: { direction: 'higher', rationale: forged<NonEmptyString>('less truncation') },
  environment: forged<EnvironmentDeclaration>({
    kind: 'uv-lock',
    lockFile: 'uv.lock',
    pythonVersion: '3.12',
  }),
  inputs: [],
}
const SUBMITTED_ENVIRONMENT = forged<EnvironmentDeclaration>({
  kind: 'requirements',
  requirementsFile: 'requirements.txt',
  pythonVersion: '3.12',
})
const CONTRACT: EvaluationContract = {
  ciEntry: forged<NonEmptyString>('evaluate.py'),
  timeoutMs: forged<DurationMs>(600_000),
  requiredMetrics: forged<NonEmptyArray<MetricName>>(['score']),
}
const UTILITY: UtilityConfig = {
  metrics: [
    {
      name: forged<MetricName>('score'),
      direction: 'higher',
      weight: forged<PositiveNumber>(1),
    },
  ],
}
const BUDGET = {
  maxExperiments: forged<PositiveInt>(10),
  maxComputeMinutes: forged<PositiveInt>(60),
  maxTokens: forged<PositiveInt>(100_000),
}

function clockAt(at: IsoTimestamp = AT): Clock {
  return { now: () => at }
}

function context<K extends CommandType>(
  actor: ActorOfCommand<K>,
  requestId: string,
): CommandContext<K> {
  return { actor, at: AT, requestId: forged<RequestId>(requestId) }
}

function createProgramCommand(): CommandOf<'program.create'> {
  return {
    type: 'program.create',
    name: forged<NonEmptyString>('Aleph research program'),
    goal: forged<NonEmptyString>('improve the score'),
    methodology: forged<NonEmptyString>('change one variable at a time'),
    contract: CONTRACT,
    utility: UTILITY,
    exploration: 'normal',
    budget: BUDGET,
  }
}

function createIssueCommand(programId: ProgramId): CommandOf<'issue.create'> {
  return {
    type: 'issue.create',
    programId,
    title: forged<NonEmptyString>('Wider clipping window'),
    body: forged<NonEmptyString>('Test whether a wider window helps.'),
    labels: LABELS,
  }
}

function assignmentFor(issueId: IssueId, assignee = researcher): IssueAssignment {
  const assignment = createIssueAssignment(issueId, assignee)
  if (!assignment.ok) assert.fail(`createIssueAssignment refused: ${assignment.error.message}`)
  return assignment.value
}

interface Harness {
  readonly store: ReturnType<typeof createInMemoryStore>
  readonly handlers: CommandHandlers
}

function makeHarness(clock: Clock = clockAt()): Harness {
  const store = createInMemoryStore()
  return { store, handlers: createCommandHandlers(store, clock) }
}

function expectOk<K extends CommandType>(outcome: CommandOutcome<K>): CommandResult<K> {
  if (!outcome.ok) {
    assert.fail(`expected success but the command was refused with ${outcome.error.code}`)
  }
  assert.equal(outcome.audit.length, 1, 'a success carries exactly its mapped audit entry')
  return outcome.value
}

function expectRefused<K extends CommandType>(
  outcome: CommandOutcome<K>,
  code: DomainError['code'],
): DomainError {
  if (outcome.ok) assert.fail('expected the command to be refused')
  assert.equal(outcome.error.code, code)
  assert.equal(outcome.audit.length, 1, 'a refusal carries exactly one audit entry')
  assert.equal(outcome.audit[0].action, 'command.refused')
  return outcome.error
}

function expectAudit(entry: AuditEntry, action: AuditAction, subjectKind: string, subjectId: string): void {
  assert.equal(entry.action, action)
  assert.equal(entry.subject.kind, subjectKind)
  assert.equal(entry.subject.id, subjectId)
  assert.equal(entry.at, AT, 'the injected clock stamps the audit fact')
}

async function auditFor(store: Harness['store'], programId: ProgramId): Promise<readonly AuditEntry[]> {
  return store.audit.list(programId, 100)
}

async function seedProgram(harness: Harness, requestId = 'request-program'): Promise<ProgramId> {
  const outcome = await harness.handlers['program.create'](createProgramCommand(), context(operator, requestId))
  return expectOk(outcome).id
}

async function seedIssue(
  harness: Harness,
  programId: ProgramId,
  requestId = 'request-issue',
): Promise<IssueId> {
  const outcome = await harness.handlers['issue.create'](createIssueCommand(programId), context(researcher, requestId))
  return expectOk(outcome).id
}

async function seedClaimedIssue(harness: Harness, programId: ProgramId): Promise<IssueId> {
  const issueId = await seedIssue(harness, programId)
  const claimed = await harness.handlers['issue.claim'](
    { type: 'issue.claim', programId, issueId },
    context(researcher, 'request-claim'),
  )
  expectOk(claimed)
  return issueId
}

async function seedProposedExperiment(
  harness: Harness,
  programId: ProgramId,
  issueId: IssueId,
  requestId = 'request-propose',
  assignee: typeof researcher = researcher,
): Promise<OpenExperiment> {
  const outcome = await harness.handlers['experiment.propose'](
    {
      type: 'experiment.propose',
      programId,
      issueId,
      assignment: assignmentFor(issueId, assignee),
      plan: PLAN,
    },
    context(assignee, requestId),
  )
  return expectOk(outcome)
}

interface RunningTicketFixture {
  readonly ticket: RunningTicket
  readonly binding: TicketBinding
}

/** The Host creates the Ticket and the binding; no user command does either. */
async function seedRunningTicket(
  harness: Harness,
  experiment: OpenExperiment,
  sessionId: ImplementerSessionId = IMPLEMENTER,
): Promise<RunningTicketFixture> {
  const ticketId = forged<TicketId>(`ticket-${experiment.id}`)
  const created = createRunningTicket({
    id: ticketId,
    programId: experiment.programId,
    issueId: experiment.issueId,
    experimentId: experiment.id,
    baseCommit: experiment.head,
    createdAt: AT,
    status: 'running',
    sessionId,
    startedAt: AT,
  })
  if (!created.ok) assert.fail(`createRunningTicket refused: ${created.error.message}`)
  const saved = await harness.store.tickets.save(INITIAL_VERSION, created.value)
  if (!saved.ok) assert.fail(`ticket save failed: ${saved.error.kind}`)
  const bound = createTicketBinding({
    ticket: created.value,
    expected: {
      programId: experiment.programId,
      issueId: experiment.issueId,
      experimentId: experiment.id,
      sessionId,
    },
  })
  if (!bound.ok) assert.fail(`createTicketBinding refused: ${bound.error.message}`)
  return { ticket: created.value, binding: bound.value }
}

async function seedReadyExperiment(
  harness: Harness,
  ticketFixture: RunningTicketFixture,
  requestId = 'request-submit',
): Promise<ExperimentId> {
  const implementer = createImplementerPrincipal(IMPLEMENTER, ticketFixture.ticket.id)
  const outcome = await harness.handlers['ticket.submit'](
    {
      type: 'ticket.submit',
      binding: ticketFixture.binding,
      head: HEAD,
      environment: SUBMITTED_ENVIRONMENT,
    },
    context(implementer, requestId),
  )
  return expectOk(outcome).id
}

/**
 * Move the stored Experiment to a terminal CI state. CI evidence is minted by the Host CI
 * runner, so the fixture inserts the record through the factory instead of a command.
 */
async function markExperiment(
  harness: Harness,
  experiment: OpenExperiment,
  status: 'ci-passed' | 'ci-failed',
): Promise<void> {
  const stored = await harness.store.experiments.get(experiment.id)
  if (stored === undefined) assert.fail('the experiment must be stored before it is marked')
  const input = {
    id: experiment.id,
    programId: experiment.programId,
    issueId: experiment.issueId,
    branch: experiment.branch,
    head: HEAD,
    environment: experiment.environment,
    lineage: experiment.lineage,
    planCommentId: experiment.planCommentId,
    createdBySessionId: researcher.sessionId,
    createdAt: experiment.createdAt,
    status,
    ciRunId: forged<CIRunId>('ci-run-1'),
    requestedAt: AT,
    startedAt: AT,
    environmentDigest: 'digest-1',
    finishedAt: AT,
    failureReason: 'entry-failed',
    failureDetail: 'the evaluation entry exited non-zero',
    failedAt: AT,
  }
  const replacement =
    status === 'ci-passed' ? createCIPassedExperiment(input) : createCIFailedExperiment(input)
  if (!replacement.ok) assert.fail(`marking the experiment refused: ${replacement.error.message}`)
  const saved = await harness.store.experiments.save(stored.version, replacement.value)
  if (!saved.ok) assert.fail(`marking the experiment failed: ${saved.error.kind}`)
}

// ---------------------------------------------------------------------------
// Program commands
// ---------------------------------------------------------------------------

test('program.create saves a running program at version zero with a program.created audit', async () => {
  const harness = makeHarness()
  const outcome = await harness.handlers['program.create'](
    createProgramCommand(),
    context(operator, 'create-1'),
  )
  const program = expectOk(outcome)

  assert.equal(program.status, 'running')
  assert.equal(program.id, forged<ProgramId>('program-create-1'))
  assert.equal(program.goal, 'improve the score')
  assert.equal(program.createdAt, AT)
  assert.deepEqual(program.usage, { experiments: 0, computeMinutes: 0, tokens: 0 })

  const stored = await harness.store.programs.get(program.id)
  if (stored === undefined) assert.fail('the program must be stored')
  assert.equal(stored.version, 1, 'the first save starts at version zero and stores version one')
  assert.equal(stored.value.status, 'running')

  expectAudit(outcome.audit[0], 'program.created', 'program', program.id)
  assert.equal(outcome.audit[0].actor.kind, 'operator')
  const audit = await auditFor(harness.store, program.id)
  assert.deepEqual(
    audit.map((entry) => entry.action),
    ['program.created'],
  )
})

test('program.pause pauses a running program and audits program.paused', async () => {
  const harness = makeHarness()
  const programId = await seedProgram(harness)
  const outcome = await harness.handlers['program.pause'](
    { type: 'program.pause', programId },
    context(operator, 'pause-1'),
  )
  const program = expectOk(outcome)

  assert.equal(program.status, 'paused')
  assert.equal(program.pausedAt, AT)
  const stored = await harness.store.programs.get(programId)
  assert.equal(stored?.version, 2)
  assert.equal(stored?.value.status, 'paused')
  expectAudit(outcome.audit[0], 'program.paused', 'program', programId)
})

test('program.resume resumes a paused program and audits program.resumed', async () => {
  const harness = makeHarness()
  const programId = await seedProgram(harness)
  const paused = await harness.handlers['program.pause'](
    { type: 'program.pause', programId },
    context(operator, 'pause-1'),
  )
  expectOk(paused)
  const outcome = await harness.handlers['program.resume'](
    { type: 'program.resume', programId },
    context(operator, 'resume-1'),
  )
  const program = expectOk(outcome)

  assert.equal(program.status, 'running')
  assert.equal(program.goal, 'improve the score', 'resuming preserves the program content')
  assert.equal((await harness.store.programs.get(programId))?.version, 3)
  expectAudit(outcome.audit[0], 'program.resumed', 'program', programId)
})

test('program.stop stops a running program with the reason and audits program.stopped', async () => {
  const harness = makeHarness()
  const programId = await seedProgram(harness)
  const outcome = await harness.handlers['program.stop'](
    { type: 'program.stop', programId, reason: forged<NonEmptyString>('budget review') },
    context(operator, 'stop-1'),
  )
  const program = expectOk(outcome)

  assert.equal(program.status, 'stopped')
  if (program.status !== 'stopped') assert.fail('unreachable')
  assert.equal(program.stopReason, 'budget review')
  assert.equal(program.stoppedAt, AT)
  expectAudit(outcome.audit[0], 'program.stopped', 'program', programId)
})

test('program.set-goal changes the goal of a running program', async () => {
  const harness = makeHarness()
  const programId = await seedProgram(harness)
  const outcome = await harness.handlers['program.set-goal'](
    { type: 'program.set-goal', programId, goal: forged<NonEmptyString>('a new goal') },
    context(operator, 'goal-1'),
  )
  const program = expectOk(outcome)

  assert.equal(program.status, 'running')
  assert.equal(program.goal, 'a new goal')
  expectAudit(outcome.audit[0], 'program.goal-changed', 'program', programId)
  assert.equal((await harness.store.programs.get(programId))?.version, 2)
})

test('program.set-methodology changes the methodology of a running program', async () => {
  const harness = makeHarness()
  const programId = await seedProgram(harness)
  const outcome = await harness.handlers['program.set-methodology'](
    {
      type: 'program.set-methodology',
      programId,
      methodology: forged<NonEmptyString>('ablate one parameter per experiment'),
    },
    context(operator, 'methodology-1'),
  )
  const program = expectOk(outcome)

  assert.equal(program.methodology, 'ablate one parameter per experiment')
  expectAudit(outcome.audit[0], 'program.methodology-changed', 'program', programId)
})

test('program.set-exploration changes the exploration level of a running program', async () => {
  const harness = makeHarness()
  const programId = await seedProgram(harness)
  const outcome = await harness.handlers['program.set-exploration'](
    { type: 'program.set-exploration', programId, level: 'high' },
    context(operator, 'exploration-1'),
  )
  const program = expectOk(outcome)

  assert.equal(program.exploration, 'high')
  expectAudit(outcome.audit[0], 'program.exploration-changed', 'program', programId)
})

// ---------------------------------------------------------------------------
// Issue commands
// ---------------------------------------------------------------------------

test('issue.create saves an open issue authored by the calling principal', async () => {
  const harness = makeHarness()
  const programId = await seedProgram(harness)
  const outcome = await harness.handlers['issue.create'](
    createIssueCommand(programId),
    context(researcher, 'issue-create-1'),
  )
  const issue = expectOk(outcome)

  assert.equal(issue.status, 'open')
  assert.equal(issue.id, forged<IssueId>('issue-issue-create-1'))
  assert.equal(issue.programId, programId)
  assert.equal(issue.author.kind, 'researcher')
  assert.equal(issue.author.sessionId, researcher.sessionId)

  const stored = await harness.store.issues.get(issue.id)
  assert.equal(stored?.version, 1)
  expectAudit(outcome.audit[0], 'issue.created', 'issue', issue.id)
  assert.equal(outcome.audit[0].actor.kind, 'researcher')
})

test('issue.claim assigns the issue to the calling researcher', async () => {
  const harness = makeHarness()
  const programId = await seedProgram(harness)
  const issueId = await seedIssue(harness, programId)
  const outcome = await harness.handlers['issue.claim'](
    { type: 'issue.claim', programId, issueId },
    context(researcher, 'claim-1'),
  )
  const issue = expectOk(outcome)

  assert.equal(issue.status, 'assigned')
  if (issue.status !== 'assigned') assert.fail('unreachable')
  assert.equal(issue.assignee.sessionId, researcher.sessionId)
  assert.equal(issue.assignedAt, AT)
  assert.deepEqual(issue.experimentIds, [])
  assert.equal((await harness.store.issues.get(issueId))?.version, 2)
  expectAudit(outcome.audit[0], 'issue.claimed', 'issue', issueId)
})

test('issue.comment appends the comment and audits issue.commented', async () => {
  const harness = makeHarness()
  const programId = await seedProgram(harness)
  const issueId = await seedIssue(harness, programId)
  const outcome = await harness.handlers['issue.comment'](
    {
      type: 'issue.comment',
      programId,
      issueId,
      body: forged<NonEmptyString>('the plan is in this comment'),
      kind: 'plan',
    },
    context(researcher, 'comment-1'),
  )
  const comment = expectOk(outcome)

  assert.equal(comment.issueId, issueId)
  assert.equal(comment.kind, 'plan')
  assert.equal(comment.authorSessionId, researcher.sessionId)
  assert.equal(comment.at, AT)
  const stored = await harness.store.issues.comments(issueId)
  assert.equal(stored.length, 1)
  assert.deepEqual(stored[0], comment)
  expectAudit(outcome.audit[0], 'issue.commented', 'issue', issueId)
})

test('issue.close closes an assigned issue for its assignee', async () => {
  const harness = makeHarness()
  const programId = await seedProgram(harness)
  const issueId = await seedClaimedIssue(harness, programId)
  const outcome = await harness.handlers['issue.close'](
    {
      type: 'issue.close',
      programId,
      issueId,
      resolution: 'accepted',
      summary: forged<NonEmptyString>('the question is answered'),
    },
    context(researcher, 'issue-close-1'),
  )
  const issue = expectOk(outcome)

  assert.equal(issue.status, 'closed')
  if (issue.status !== 'closed') assert.fail('unreachable')
  assert.equal(issue.resolution, 'accepted')
  assert.equal(issue.summary, 'the question is answered')
  assert.equal(issue.assigneeSessionId, researcher.sessionId)
  expectAudit(outcome.audit[0], 'issue.closed', 'issue', issueId)
})

// ---------------------------------------------------------------------------
// Experiment commands
// ---------------------------------------------------------------------------

test('experiment.propose records an open experiment, its plan comment and the issue link', async () => {
  const harness = makeHarness()
  const programId = await seedProgram(harness)
  const issueId = await seedClaimedIssue(harness, programId)
  const experiment = await seedProposedExperiment(harness, programId, issueId)

  assert.equal(experiment.status, 'open')
  assert.equal(experiment.issueId, issueId)
  assert.equal(experiment.createdBy.sessionId, researcher.sessionId)
  assert.equal(experiment.planCommentId, forged<string>('plan-request-propose'))
  assert.equal(experiment.lineage.strategy, 'fresh')
  if (experiment.lineage.strategy !== 'fresh') assert.fail('unreachable')
  assert.equal(
    experiment.lineage.freshStartProbability,
    0.1,
    'the fresh-start probability comes from the normal exploration preset',
  )

  const issue = await harness.store.issues.get(issueId)
  assert.deepEqual(issue?.value.status === 'assigned' ? issue.value.experimentIds : [], [
    experiment.id,
  ])
  const comments = await harness.store.issues.comments(issueId)
  assert.equal(comments.length, 1)
  assert.equal(comments[0].kind, 'plan')
  assert.equal(comments[0].id, experiment.planCommentId)
  assert.match(comments[0].body, /a wider clipping window/)

  const audit = await auditFor(harness.store, programId)
  const proposed = audit.find((entry) => entry.action === 'experiment.proposed')
  if (proposed === undefined) assert.fail('the proposal must be audited')
  expectAudit(proposed, 'experiment.proposed', 'issue', issueId)
  assert.equal(proposed.actor.kind, 'researcher')
})

test('experiment.propose refuses a researcher who is not the issue assignee without writing', async () => {
  const harness = makeHarness()
  const programId = await seedProgram(harness)
  const issueId = await seedClaimedIssue(harness, programId)
  const before = await harness.store.issues.get(issueId)
  const outcome = await harness.handlers['experiment.propose'](
    {
      type: 'experiment.propose',
      programId,
      issueId,
      assignment: assignmentFor(issueId),
      plan: PLAN,
    },
    context(otherResearcher, 'propose-other'),
  )
  expectRefused(outcome, 'forbidden')

  const after = await harness.store.issues.get(issueId)
  assert.equal(after?.version, before?.version, 'the issue is not written on a refusal')
  assert.deepEqual(await harness.store.issues.comments(issueId), [], 'no plan comment is appended')
  assert.deepEqual(await harness.store.experiments.listByIssue(issueId), [], 'no experiment is created')
  const audit = await auditFor(harness.store, programId)
  assert.deepEqual(
    audit.map((entry) => entry.action),
    ['program.created', 'issue.created', 'issue.claimed', 'command.refused'],
  )
})

test('experiment.review appends a review for the assignee and audits experiment.reviewed', async () => {
  const harness = makeHarness()
  const programId = await seedProgram(harness)
  const issueId = await seedClaimedIssue(harness, programId)
  const experiment = await seedProposedExperiment(harness, programId, issueId)
  const outcome = await harness.handlers['experiment.review'](
    {
      type: 'experiment.review',
      programId,
      experimentId: experiment.id,
      assignment: assignmentFor(issueId),
      body: forged<NonEmptyString>('the hypothesis is testable'),
      verdict: 'approve',
    },
    context(researcher, 'review-1'),
  )
  const review = expectOk(outcome)

  assert.equal(review.experimentId, experiment.id)
  assert.equal(review.verdict, 'approve')
  assert.equal(review.author.sessionId, researcher.sessionId)
  assert.equal(review.at, AT)
  const stored = await harness.store.experiments.reviews(experiment.id)
  assert.equal(stored.length, 1)
  assert.deepEqual(stored[0], review)
  expectAudit(outcome.audit[0], 'experiment.reviewed', 'experiment', experiment.id)
})

test('experiment.close closes a passed experiment as concluded', async () => {
  const harness = makeHarness()
  const programId = await seedProgram(harness)
  const issueId = await seedClaimedIssue(harness, programId)
  const experiment = await seedProposedExperiment(harness, programId, issueId)
  await markExperiment(harness, experiment, 'ci-passed')
  const outcome = await harness.handlers['experiment.close'](
    {
      type: 'experiment.close',
      programId,
      experimentId: experiment.id,
      assignment: assignmentFor(issueId),
      reason: forged<NonEmptyString>('the result improved the score'),
    },
    context(researcher, 'close-1'),
  )
  const closed = expectOk(outcome)

  assert.equal(closed.status, 'closed')
  if (closed.status !== 'closed') assert.fail('unreachable')
  assert.equal(closed.outcome, 'concluded')
  assert.equal(closed.closeReason, 'the result improved the score')
  const stored = await harness.store.experiments.get(experiment.id)
  assert.equal(stored?.value.status, 'closed')
  expectAudit(outcome.audit[0], 'experiment.closed', 'experiment', experiment.id)
})

test('experiment.close closes a failed experiment as failed', async () => {
  const harness = makeHarness()
  const programId = await seedProgram(harness)
  const issueId = await seedClaimedIssue(harness, programId)
  const experiment = await seedProposedExperiment(harness, programId, issueId)
  await markExperiment(harness, experiment, 'ci-failed')
  const outcome = await harness.handlers['experiment.close'](
    {
      type: 'experiment.close',
      programId,
      experimentId: experiment.id,
      assignment: assignmentFor(issueId),
      reason: forged<NonEmptyString>('the entry failed reproducibly'),
    },
    context(researcher, 'close-2'),
  )
  const closed = expectOk(outcome)

  assert.equal(closed.status, 'closed')
  if (closed.status !== 'closed') assert.fail('unreachable')
  assert.equal(closed.outcome, 'failed', 'the close outcome follows the CI result')
  expectAudit(outcome.audit[0], 'experiment.closed', 'experiment', experiment.id)
})

test('ci.request turns a ready experiment into a pending one and stores the requested record', async () => {
  const harness = makeHarness()
  const programId = await seedProgram(harness)
  const issueId = await seedClaimedIssue(harness, programId)
  const experiment = await seedProposedExperiment(harness, programId, issueId)
  const ticket = await seedRunningTicket(harness, experiment)
  const experimentId = await seedReadyExperiment(harness, ticket)

  const outcome = await harness.handlers['ci.request'](
    { type: 'ci.request', programId, experimentId },
    context(researcher, 'ci-request-1'),
  )
  const pending = expectOk(outcome)

  assert.equal(pending.status, 'ci-pending')
  if (pending.status !== 'ci-pending') assert.fail('unreachable')
  assert.equal(pending.ciRunId, forged<CIRunId>('ci-ci-request-1'))
  assert.equal(pending.requestedAt, AT)
  const records = await harness.store.ciRecords.listByExperiment(experimentId)
  assert.equal(records.length, 1)
  assert.equal(records[0].status, 'requested')
  if (records[0].status !== 'requested') assert.fail('unreachable')
  assert.equal(records[0].id, pending.ciRunId)
  assert.equal(records[0].commit, HEAD)
  assert.equal(records[0].requestedBy, researcher.sessionId)
  const stored = await harness.store.experiments.get(experimentId)
  assert.equal(stored?.value.status, 'ci-pending')
  expectAudit(outcome.audit[0], 'ci.requested', 'ci-run', pending.ciRunId)
})

test('ticket.submit marks the ticket submitted and the experiment ready', async () => {
  const harness = makeHarness()
  const programId = await seedProgram(harness)
  const issueId = await seedClaimedIssue(harness, programId)
  const experiment = await seedProposedExperiment(harness, programId, issueId)
  const ticket = await seedRunningTicket(harness, experiment)
  const implementer = createImplementerPrincipal(IMPLEMENTER, ticket.ticket.id)

  const outcome = await harness.handlers['ticket.submit'](
    { type: 'ticket.submit', binding: ticket.binding, head: HEAD, environment: SUBMITTED_ENVIRONMENT },
    context(implementer, 'submit-1'),
  )
  const ready = expectOk(outcome)

  assert.equal(ready.status, 'ready')
  if (ready.status !== 'ready') assert.fail('unreachable')
  assert.equal(ready.id, experiment.id)
  assert.equal(ready.head, HEAD, 'the submitted commit replaces the provisional scaffold head')
  assert.deepEqual(ready.environment, SUBMITTED_ENVIRONMENT)
  assert.equal(ready.readyAt, AT)

  const storedTicket = await harness.store.tickets.get(ticket.ticket.id)
  assert.equal(storedTicket?.value.status, 'submitted')
  if (storedTicket?.value.status !== 'submitted') assert.fail('unreachable')
  assert.equal(storedTicket.value.head, HEAD)
  assert.equal(storedTicket.value.sessionId, IMPLEMENTER)
  expectAudit(outcome.audit[0], 'experiment.ready', 'experiment', experiment.id)
  assert.equal(outcome.audit[0].actor.kind, 'implementer')
})

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

test('different request ids mint different aggregate ids', async () => {
  const harness = makeHarness()
  const first = await harness.handlers['program.create'](
    createProgramCommand(),
    context(operator, 'request-a'),
  )
  const second = await harness.handlers['program.create'](
    createProgramCommand(),
    context(operator, 'request-b'),
  )
  const firstProgram = expectOk(first)
  const secondProgram = expectOk(second)
  assert.notEqual(firstProgram.id, secondProgram.id)
  assert.equal(firstProgram.id, forged<ProgramId>('program-request-a'))
  assert.equal(secondProgram.id, forged<ProgramId>('program-request-b'))

  const firstIssue = await harness.handlers['issue.create'](
    createIssueCommand(secondProgram.id),
    context(researcher, 'issue-request-a'),
  )
  const secondIssue = await harness.handlers['issue.create'](
    createIssueCommand(secondProgram.id),
    context(researcher, 'issue-request-b'),
  )
  assert.notEqual(expectOk(firstIssue).id, expectOk(secondIssue).id)
})

// ---------------------------------------------------------------------------
// Refusals: missing aggregates, ownership, stale versions and bad states
// ---------------------------------------------------------------------------

test('a command against a missing program is refused as not-found and audited', async () => {
  const harness = makeHarness()
  const programId = forged<ProgramId>('program-missing')
  const outcome = await harness.handlers['program.pause'](
    { type: 'program.pause', programId },
    context(operator, 'missing-program'),
  )
  const error = expectRefused(outcome, 'not-found')

  assert.match(error.message, /does not exist/)
  const audit = await auditFor(harness.store, programId)
  assert.equal(audit.length, 1, 'the refusal is the only fact and no state write happened')
  assert.equal(audit[0].action, 'command.refused')
  assert.equal(audit[0].subject.kind, 'program')
  assert.equal(audit[0].programId, programId)
})

test('a command against a missing issue is refused as not-found without writing', async () => {
  const harness = makeHarness()
  const programId = await seedProgram(harness)
  const issueId = forged<IssueId>('issue-missing')
  const outcome = await harness.handlers['issue.claim'](
    { type: 'issue.claim', programId, issueId },
    context(researcher, 'missing-issue'),
  )
  expectRefused(outcome, 'not-found')
  const issue = await harness.store.issues.get(issueId)
  assert.equal(issue, undefined)
  const audit = await auditFor(harness.store, programId)
  assert.equal(audit[audit.length - 1].action, 'command.refused')
})

test('a stale version is refused as version-conflict, does not overwrite and is audited', async () => {
  const harness = makeHarness()
  const programId = await seedProgram(harness)
  const stale = await harness.store.programs.get(programId)
  if (stale === undefined) assert.fail('the program must exist')

  // A concurrent writer moves the program from running to paused after the read below.
  const paused = await harness.handlers['program.pause'](
    { type: 'program.pause', programId },
    context(operator, 'pause-current'),
  )
  expectOk(paused)

  const staleReads: UnitOfWork = {
    ...harness.store,
    programs: {
      ...harness.store.programs,
      get: async (id: ProgramId): Promise<Versioned<Program> | undefined> =>
        id === programId ? stale : harness.store.programs.get(id),
    },
  }
  const staleHandlers = createCommandHandlers(staleReads, clockAt())
  const outcome = await staleHandlers['program.pause'](
    { type: 'program.pause', programId },
    context(operator, 'pause-stale'),
  )
  expectRefused(outcome, 'version-conflict')

  const current = await harness.store.programs.get(programId)
  assert.equal(current?.version, 2, 'the concurrent write is preserved')
  assert.equal(current?.value.status, 'paused')
  const audit = await auditFor(harness.store, programId)
  assert.deepEqual(
    audit.map((entry) => entry.action),
    ['program.created', 'program.paused', 'command.refused'],
  )
})

test('re-proposing the same request is refused as a conflict and links nothing twice', async () => {
  const harness = makeHarness()
  const programId = await seedProgram(harness)
  const issueId = await seedClaimedIssue(harness, programId)
  const proposal = seedProposedExperiment(harness, programId, issueId, 'request-retry')
  const first = await proposal
  const issueBefore = await harness.store.issues.get(issueId)
  const commentsBefore = await harness.store.issues.comments(issueId)

  // The same request id mints the same experiment id, so `addExperiment` sees the link and
  // refuses before any write; the issue and its thread stay exactly as they were.
  const outcome = await harness.handlers['experiment.propose'](
    {
      type: 'experiment.propose',
      programId,
      issueId,
      assignment: assignmentFor(issueId),
      plan: PLAN,
    },
    context(researcher, 'request-retry'),
  )
  expectRefused(outcome, 'conflict')

  const issueAfter = await harness.store.issues.get(issueId)
  assert.equal(issueAfter?.version, issueBefore?.version, 'the issue version is unchanged')
  if (issueAfter?.value.status !== 'assigned') assert.fail('the issue must stay assigned')
  assert.deepEqual(issueAfter.value.experimentIds, [first.id], 'no duplicate experiment link')
  assert.deepEqual(await harness.store.issues.comments(issueId), commentsBefore, 'no plan comment')
  assert.equal((await harness.store.experiments.get(first.id))?.version, 1, 'the experiment is untouched')
  const audit = await auditFor(harness.store, programId)
  assert.equal(audit[audit.length - 1].action, 'command.refused')
  assert.equal(audit[audit.length - 1].subject.kind, 'program')
})

/** A unit of work whose experiment save always loses the optimistic-concurrency check. */
async function conflictOnExperimentSave(
  expected: Version,
  _next: Experiment,
): Promise<Result<Version, StoreError>> {
  return { ok: false, error: { kind: 'version-conflict', expected, actual: expected + 1 } }
}

test('a store failure on the second write of a proposal rolls the first write back', async () => {
  const harness = makeHarness()
  const programId = await seedProgram(harness)
  const issueId = await seedClaimedIssue(harness, programId)
  const issueBefore = await harness.store.issues.get(issueId)
  const commentsBefore = await harness.store.issues.comments(issueId)

  // The issue save succeeds first; the experiment save then reports a stale version. The
  // transaction snapshot must undo the issue write as well.
  const failing: UnitOfWork = {
    ...harness.store,
    experiments: { ...harness.store.experiments, save: conflictOnExperimentSave },
    transaction: async (work) => harness.store.transaction(async () => work(failing)),
  }
  const failingHandlers = createCommandHandlers(failing, clockAt())
  const outcome = await failingHandlers['experiment.propose'](
    {
      type: 'experiment.propose',
      programId,
      issueId,
      assignment: assignmentFor(issueId),
      plan: PLAN,
    },
    context(researcher, 'request-rollback'),
  )
  expectRefused(outcome, 'version-conflict')

  const issueAfter = await harness.store.issues.get(issueId)
  assert.equal(issueAfter?.version, issueBefore?.version, 'the earlier issue save is rolled back')
  if (issueAfter?.value.status !== 'assigned') assert.fail('the issue must stay assigned')
  assert.deepEqual(issueAfter.value.experimentIds, [], 'the experiment link is rolled back')
  assert.deepEqual(await harness.store.issues.comments(issueId), commentsBefore, 'no plan comment')
  assert.deepEqual(
    await harness.store.experiments.listByIssue(issueId),
    [],
    'the experiment is not stored',
  )
  const audit = await auditFor(harness.store, programId)
  assert.equal(audit[audit.length - 1].action, 'command.refused')
  assert.equal(audit[audit.length - 1].subject.kind, 'program')
})

test('resuming a running program is refused as invalid-state without a write', async () => {
  const harness = makeHarness()
  const programId = await seedProgram(harness)
  const outcome = await harness.handlers['program.resume'](
    { type: 'program.resume', programId },
    context(operator, 'resume-running'),
  )
  expectRefused(outcome, 'invalid-state')
  const stored = await harness.store.programs.get(programId)
  assert.equal(stored?.version, 1, 'a bad-state refusal does not save')
  assert.equal(stored?.value.status, 'running')
})

test('claiming an assigned issue is refused as invalid-state', async () => {
  const harness = makeHarness()
  const programId = await seedProgram(harness)
  const issueId = await seedClaimedIssue(harness, programId)
  const outcome = await harness.handlers['issue.claim'](
    { type: 'issue.claim', programId, issueId },
    context(researcher, 'claim-again'),
  )
  expectRefused(outcome, 'invalid-state')
  assert.equal((await harness.store.issues.get(issueId))?.version, 2)
})

test('changing the goal of a paused program is refused (the result type is RunningProgram)', async () => {
  const harness = makeHarness()
  const programId = await seedProgram(harness)
  const paused = await harness.handlers['program.pause'](
    { type: 'program.pause', programId },
    context(operator, 'pause-goal'),
  )
  expectOk(paused)
  const outcome = await harness.handlers['program.set-goal'](
    { type: 'program.set-goal', programId, goal: forged<NonEmptyString>('a paused goal') },
    context(operator, 'goal-paused'),
  )
  expectRefused(outcome, 'invalid-state')
  const stored = await harness.store.programs.get(programId)
  assert.equal(stored?.value.status, 'paused')
  assert.equal(stored?.value.goal, 'improve the score')
})

test('requesting CI for an experiment that is not ready is refused and stores no record', async () => {
  const harness = makeHarness()
  const programId = await seedProgram(harness)
  const issueId = await seedClaimedIssue(harness, programId)
  const experiment = await seedProposedExperiment(harness, programId, issueId)
  const outcome = await harness.handlers['ci.request'](
    { type: 'ci.request', programId, experimentId: experiment.id },
    context(researcher, 'ci-early'),
  )
  expectRefused(outcome, 'invalid-state')
  assert.deepEqual(await harness.store.ciRecords.listByExperiment(experiment.id), [])
  assert.equal((await harness.store.experiments.get(experiment.id))?.value.status, 'open')
})

test('a submit from another implementer session is refused and leaves both records untouched', async () => {
  const harness = makeHarness()
  const programId = await seedProgram(harness)
  const issueId = await seedClaimedIssue(harness, programId)
  const experiment = await seedProposedExperiment(harness, programId, issueId)
  const ticket = await seedRunningTicket(harness, experiment)
  const intruder = createImplementerPrincipal(OTHER_IMPLEMENTER, ticket.ticket.id)

  const outcome = await harness.handlers['ticket.submit'](
    { type: 'ticket.submit', binding: ticket.binding, head: HEAD, environment: SUBMITTED_ENVIRONMENT },
    context(intruder, 'submit-intruder'),
  )
  expectRefused(outcome, 'forbidden')

  assert.equal((await harness.store.experiments.get(experiment.id))?.value.status, 'open')
  assert.equal((await harness.store.tickets.get(ticket.ticket.id))?.value.status, 'running')
  const audit = await auditFor(harness.store, programId)
  assert.equal(audit[audit.length - 1].action, 'command.refused')
})

test('a submit whose binding names another ticket is refused', async () => {
  const harness = makeHarness()
  const programId = await seedProgram(harness)
  const issueId = await seedClaimedIssue(harness, programId)
  const experiment = await seedProposedExperiment(harness, programId, issueId)
  const ticket = await seedRunningTicket(harness, experiment)
  const otherTicketId = forged<TicketId>('ticket-other')
  const implementer = createImplementerPrincipal(IMPLEMENTER, ticket.ticket.id)

  const outcome = await harness.handlers['ticket.submit'](
    {
      type: 'ticket.submit',
      binding: {
        ...ticket.binding,
        ticketId: otherTicketId,
      },
      head: HEAD,
      environment: SUBMITTED_ENVIRONMENT,
    },
    context(implementer, 'submit-other-ticket'),
  )
  expectRefused(outcome, 'forbidden')
  assert.equal((await harness.store.experiments.get(experiment.id))?.value.status, 'open')
})

test('a submit for a missing experiment is refused as not-found and audited', async () => {
  const harness = makeHarness()
  const binding = forged<TicketBinding>({
    ticketId: forged<TicketId>('ticket-missing'),
    experimentId: forged<ExperimentId>('experiment-missing'),
    sessionId: IMPLEMENTER,
  })
  const implementer = createImplementerPrincipal(IMPLEMENTER, binding.ticketId)
  const outcome = await harness.handlers['ticket.submit'](
    { type: 'ticket.submit', binding, head: HEAD, environment: SUBMITTED_ENVIRONMENT },
    context(implementer, 'submit-missing'),
  )
  expectRefused(outcome, 'not-found')
  assert.equal(outcome.audit[0].action, 'command.refused')
})

test('closing an experiment that has no CI result is refused as invalid-state', async () => {
  const harness = makeHarness()
  const programId = await seedProgram(harness)
  const issueId = await seedClaimedIssue(harness, programId)
  const experiment = await seedProposedExperiment(harness, programId, issueId)
  const outcome = await harness.handlers['experiment.close'](
    {
      type: 'experiment.close',
      programId,
      experimentId: experiment.id,
      assignment: assignmentFor(issueId),
      reason: forged<NonEmptyString>('too early'),
    },
    context(researcher, 'close-open'),
  )
  expectRefused(outcome, 'invalid-state')
  assert.equal((await harness.store.experiments.get(experiment.id))?.value.status, 'open')
})

test('a review with an assignment for another issue is refused as forbidden', async () => {
  const harness = makeHarness()
  const programId = await seedProgram(harness)
  const issueId = await seedClaimedIssue(harness, programId)
  const experiment = await seedProposedExperiment(harness, programId, issueId)
  const outcome = await harness.handlers['experiment.review'](
    {
      type: 'experiment.review',
      programId,
      experimentId: experiment.id,
      assignment: assignmentFor(forged<IssueId>('issue-other')),
      body: forged<NonEmptyString>('wrong issue'),
      verdict: 'comment',
    },
    context(researcher, 'review-wrong-issue'),
  )
  expectRefused(outcome, 'forbidden')
  assert.deepEqual(await harness.store.experiments.reviews(experiment.id), [])
})

// ---------------------------------------------------------------------------
// Write-path integration
// ---------------------------------------------------------------------------

test('the real write path reaches the handlers with the parsed command and Host context', async () => {
  const harness = makeHarness()
  const routes: WriteRoutes = COMMAND_PARSERS
  const parsers: AuditSubjectParsers = {
    programId: () => ({
      ok: false,
      error: { code: 'invalid-input', message: forged<NonEmptyString>('no program id') },
    }),
  }
  const refusalPort: RefusalAuditPort = {
    record: () => forged<AuditEntryOf<'command.refused'>>({ action: 'command.refused' }),
  }
  const requestId = forged<RequestId>('route-create')

  const created = await executeRoute(
    routes,
    parsers,
    harness.handlers,
    operator,
    'program.create',
    {
      type: 'program.create',
      name: 'Aleph research program',
      goal: 'improve the score',
      methodology: 'change one variable at a time',
      contract: { ciEntry: 'evaluate.py', timeoutMs: 600_000, requiredMetrics: ['score'] },
      utility: {
        metrics: [{ name: 'score', direction: 'higher', weight: 1 }],
      },
      exploration: 'normal',
      budget: { maxExperiments: 10, maxComputeMinutes: 60, maxTokens: 100_000 },
    },
    { context: context(operator, 'route-create'), programId: forged<ProgramId>('unused') },
    clockAt(),
    requestId,
    refusalPort,
  )
  const program = expectOk(created)
  assert.equal(program.id, forged<ProgramId>('program-route-create'))
  assert.equal((await harness.store.programs.get(program.id))?.value.status, 'running')

  const paused = await executeRoute(
    routes,
    parsers,
    harness.handlers,
    operator,
    'program.pause',
    { type: 'program.pause', programId: program.id },
    { context: context(operator, 'route-pause'), programId: program.id },
    clockAt(),
    forged<RequestId>('route-pause'),
    refusalPort,
  )
  const pausedProgram = expectOk(paused)
  assert.equal(pausedProgram.status, 'paused')
  const audit = await auditFor(harness.store, program.id)
  assert.deepEqual(
    audit.map((entry) => entry.action),
    ['program.created', 'program.paused'],
    'the write path appended no audit of its own: the handler owns the success facts',
  )
})

test('closing an experiment is refused for a researcher who is not the assignee', async () => {
  const harness = makeHarness()
  const programId = await seedProgram(harness)
  const issueId = await seedClaimedIssue(harness, programId)
  const experiment = await seedProposedExperiment(harness, programId, issueId)
  await markExperiment(harness, experiment, 'ci-passed')
  const outcome = await harness.handlers['experiment.close'](
    {
      type: 'experiment.close',
      programId,
      experimentId: experiment.id,
      assignment: assignmentFor(issueId, otherResearcher),
      reason: forged<NonEmptyString>('not mine to close'),
    },
    context(otherResearcher, 'close-other'),
  )
  expectRefused(outcome, 'forbidden')
  assert.equal((await harness.store.experiments.get(experiment.id))?.value.status, 'ci-passed')
})
