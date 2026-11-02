/**
 * Command handlers: the one implementation of the write executor over a `UnitOfWork`.
 *
 * Every command follows the same shape:
 *
 * 1. read the aggregates it names (`Versioned<T>`), refusing `not-found` when one is absent;
 * 2. apply the pure transition in `runtime/domain.ts` and assemble the next state through
 *    the factory boundary — the domain values are plain records, the factories are the
 *    only modules allowed to construct the nominal classes;
 * 3. perform every write (state saves, comment/review/CI-record appends, success audit) in
 *    one `UnitOfWork.transaction`, so a store refusal rolls the whole command back and no
 *    partial write survives a failure;
 * 4. return `CommandOutcome<K>`: a success carries the mapped audit action, a refusal
 *    carries a `command.refused` entry. A handler never throws a domain refusal.
 *
 * Design decisions forced by the fixed `(uow, clock)` signature and the frozen types:
 *
 * - **Ids are minted from the request id.** The Host supplies one `RequestId` per command
 *   and no id service is composed here, so an aggregate id is `<kind>-<requestId>`. The
 *   scheme is idempotency-oriented: a retried request addresses the same aggregate (and
 *   loses the optimistic-concurrency check as a `version-conflict` refusal), and a second
 *   create in one request cannot mint two different rows. It is a Phase 1 stand-in, not a
 *   security or uniqueness claim: the Host composition root will mint UUIDs through an id
 *   service in the adapter, and the tests only pin that distinct request ids produce
 *   distinct ids. Append-only records (comments, reviews) are not deduplicated by the
 *   Phase 1 store, so request-id deduplication there stays a Host concern.
 * - **Proposals record a provisional fresh lineage.** Base selection by the Boltzmann
 *   sampler is a Host layer that is not part of this constructor; `experiment.propose`
 *   accepts the plan as written, appends it as the Issue's plan comment and records a
 *   `FreshLineage` with the Program's fixed fresh-start probability. The provisional
 *   scaffold commit is replaced by the real head in `ticket.submit`; the sampling layer
 *   replaces the lineage when it is wired in.
 *   sampled lineage; until then this handler never fabricates a derived base or a "best"
 *   previous Experiment.
 * - **`program.set-goal` / `set-methodology` / `set-exploration` need a running program.**
 *   Known limitation: the pure transitions also accept a paused program, but
 *   `CommandResultMap` fixes the result of these commands to `RunningProgram`. A paused
 *   program is therefore refused with `invalid-state` instead of returning a value of the
 *   wrong declared state; the transitions are not widened to make the map fit. If
 *   editing a paused Program becomes a requirement, the map (and this rule) must change
 *   together.
 * - **A `ticket.submit` refusal may happen before any aggregate is known.** The command
 *   carries only the Host binding, so its refusal is attributed to the ticket or
 *   experiment Program when one is found and to a documented sentinel otherwise; it is
 *   still audited.
 * - **`issue.close` is researcher-only.** `ActorForCommand` fixes the actor to a
 *   Researcher, so an Operator closing an unassigned Issue is not expressible through this
 *   command; the handler closes only the assignee's Issue through `authorize`. The
 *   Operator-takeover rule stays the open Phase 1 decision named in the runtime contract.
 *
 * No global clock is read, no untrusted value is parsed here (the write routes did that)
 * and no assertion is used: the factories validate what this module hands them.
 */
import type { IssueAssignment as IssueAssignmentToken, ResearcherPrincipal } from '../types/actors.js'
import type { AuditEntryOf } from '../types/audit.js'
import type {
  AuditActionOf,
  CommandContext,
  CommandOf,
  CommandOutcome,
  CommandResult,
  CommandType,
} from '../types/commands.js'
import type { DomainError, Err, Ok, Result, StoreError } from '../types/errors.js'
import type { CommandHandlers } from '../types/executor.js'
import type { Experiment, ExperimentPlan, ExperimentReview } from '../types/experiment.js'
import type { Issue, IssueComment } from '../types/issue.js'
import type {
  AuditId,
  CIRunId,
  CommentId,
  CommitSha,
  ExperimentId,
  IssueId,
  NonEmptyString,
  ProgramId,
  ReviewId,
  Version,
} from '../types/ids.js'
import type { CIRecord, RequestedCIRecord } from '../types/metrics.js'
import type { Program } from '../types/program.js'
import type { Clock } from '../types/services.js'
import type { UnitOfWork, Versioned } from '../types/storage.js'
import type { Ticket } from '../types/ticket.js'
import type { ExperimentData, IssueAssignmentData, IssueData } from './domain.js'

import {
  addExperiment,
  authorizeIssue,
  claimIssue,
  closeAssignedIssue,
  closeExperiment,
  pauseProgram,
  requestExperimentCI,
  resumeProgram,
  setExploration,
  setGoal,
  setMethodology,
  stopProgram,
  submitExperiment,
  submitTicket,
} from './domain.js'
import {
  EXPLORATION_PRESETS,
  createAssignedIssue,
  createCIPendingExperiment,
  createCIRequestToken,
  createClosedExperiment,
  createClosedIssue,
  createFreshLineage,
  createOpenExperiment,
  createOpenIssue,
  createPausedProgram,
  createReadyExperiment,
  createRunningProgram,
  createStoppedProgram,
  createSubmittedTicket,
} from '../factories.js'

// ---------------------------------------------------------------------------
// Refinements. Each declares a runtime invariant already established by the line above
// it (the same overload convention as `runtime/storage.ts` and `runtime/tools.ts`).
// ---------------------------------------------------------------------------

/** An id minted from the Host-supplied request id; the argument is never untrusted. */
function mintId<T extends string>(value: string): T
function mintId(value: string): string {
  return value
}

/** The optimistic-concurrency version; the store mints the next one. */
function mintVersion(value: number): Version
function mintVersion(value: number): number {
  return value
}

/** Every refusal message is a literal or is built from ids and factory messages. */
function nonEmpty(value: string): NonEmptyString
function nonEmpty(value: string): string {
  return value.length === 0 ? 'refused' : value
}

function ok<T>(value: T): Ok<T> {
  return { ok: true, value }
}

function err<E>(error: E): Err<E> {
  return { ok: false, error }
}

const INITIAL_VERSION: Version = mintVersion(0)

/**
 * The scaffold commit of a fresh lineage.
 *
 * This layer composes no `Sampler` and no `RepositoryService`, so a proposal cannot know
 * the real scaffold head; the all-zero object id is the documented "not resolved yet"
 * placeholder. `ticket.submit` replaces the Experiment head with the submitted commit, and
 * the Host sampling layer replaces `lineage.baseCommit` before CI runs.
 *
 * instead of this sentinel.
 */
const PENDING_SCAFFOLD_COMMIT = mintId<CommitSha>('0000000000000000000000000000000000000000')

/**
 * Program a `ticket.submit` refusal is audited against when neither the Experiment nor the
 * Ticket named by the binding exists.
 */
const UNBOUND_PROGRAM = mintId<ProgramId>('unbound-program')

/** The branch an Experiment gets at proposal time; the ticket layer works from it. */
function experimentBranch(experimentId: ExperimentId): string {
  return `experiment/${experimentId}`
}

function notFound(message: string): DomainError {
  return { code: 'not-found', message: nonEmpty(message) }
}

function forbidden(message: string): DomainError {
  return { code: 'forbidden', message: nonEmpty(message) }
}

function invalidState(message: string): DomainError {
  return { code: 'invalid-state', message: nonEmpty(message) }
}

// ---------------------------------------------------------------------------
// Nominal-state adapters
//
// The pure transitions consume the plain `*Data` records from `runtime/domain.ts`; the
// repositories return the nominal states. The two differ in exactly one field per
// aggregate (the ownership principal is flattened to its Session id), so the adapters
// below read that field instead of reconstructing the record field by field. They never
// construct a class: a state is always assembled by its factory.
// ---------------------------------------------------------------------------

/** Flatten `assignee` to the domain record's `assigneeSessionId` for an assigned Issue. */
function issueData(issue: Issue): IssueData {
  switch (issue.status) {
    case 'open':
      return issue
    case 'assigned':
      return { ...issue, assigneeSessionId: issue.assignee.sessionId }
    case 'closed':
      return issue
  }
}

/**
 * Flatten `createdBy` to the domain record's `createdBySessionId`.
 *
 * The failed variant spells its optional fields as required `| undefined` properties in
 * the domain record, so it is rebuilt explicitly; every other variant differs only in the
 * flattened principal.
 */
function experimentData(experiment: Experiment): ExperimentData {
  switch (experiment.status) {
    case 'ci-failed':
      return {
        ...experiment,
        createdBySessionId: experiment.createdBy.sessionId,
        startedAt: experiment.startedAt,
        environmentDigest: experiment.environmentDigest,
      }
    case 'open':
    case 'ready':
    case 'ci-pending':
    case 'ci-running':
    case 'ci-passed':
    case 'closed':
      return { ...experiment, createdBySessionId: experiment.createdBy.sessionId }
  }
}

/** Flatten the assignment token's principal to the Session id the transition compares. */
function assignmentData(assignment: IssueAssignmentToken): IssueAssignmentData {
  return {
    issueId: assignment.issueId,
    assigneeSessionId: assignment.assignee.sessionId,
  }
}

/** The domain shape of an Issue that can authorize work, or the refusal. */
function authorizableIssueData(issue: Issue): Result<IssueData, DomainError> {
  switch (issue.status) {
    case 'open':
      return err(invalidState('the issue is not assigned, so it authorizes no work'))
    case 'closed':
      return err(invalidState('a closed issue cannot authorize work'))
    case 'assigned':
      return ok(issueData(issue))
  }
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/** A refusal is audited as `command.refused`, always against a Program subject. */
function refusalEntry<K extends CommandType>(
  clock: Clock,
  context: CommandContext<K>,
  programId: ProgramId,
  error: DomainError,
): AuditEntryOf<'command.refused'> {
  return {
    id: mintId<AuditId>(`audit-${context.requestId}-command.refused`),
    at: clock.now(),
    programId,
    action: 'command.refused',
    subject: { kind: 'program', id: programId },
    actor: context.actor,
    detail: {
      code: error.code,
      reason: error.message,
      requestId: context.requestId,
    },
  }
}

// ---------------------------------------------------------------------------
// Store failures, transactions and the commit envelope
// ---------------------------------------------------------------------------

/** Map a repository refusal into the domain refusal the outcome carries. */
function storeFailure(error: StoreError): DomainError {
  switch (error.kind) {
    case 'version-conflict':
      return {
        code: 'version-conflict',
        message: nonEmpty(`expected version ${error.expected} but the store holds ${error.actual}`),
        details: { expected: error.expected, actual: error.actual },
      }
    case 'io':
      return { code: 'conflict', message: error.message }
    case 'corrupt':
      return { code: 'invalid-input', message: error.message }
  }
}

/**
 * A write refusal discovered inside a transaction. It is thrown only to make
 * `UnitOfWork.transaction` restore its snapshot; `commit` catches it and returns the
 * audited refusal, so no exception escapes a handler.
 */
class RefusedWrite extends Error {
  readonly refusal: DomainError

  constructor(refusal: DomainError) {
    super(refusal.message)
    this.name = 'RefusedWrite'
    this.refusal = refusal
  }
}

async function saveProgram(tx: UnitOfWork, expected: Version, next: Program): Promise<void> {
  const saved = await tx.programs.save(expected, next)
  if (!saved.ok) throw new RefusedWrite(storeFailure(saved.error))
}

async function saveIssue(tx: UnitOfWork, expected: Version, next: Issue): Promise<void> {
  const saved = await tx.issues.save(expected, next)
  if (!saved.ok) throw new RefusedWrite(storeFailure(saved.error))
}

async function saveExperiment(tx: UnitOfWork, expected: Version, next: Experiment): Promise<void> {
  const saved = await tx.experiments.save(expected, next)
  if (!saved.ok) throw new RefusedWrite(storeFailure(saved.error))
}

async function saveTicket(tx: UnitOfWork, expected: Version, next: Ticket): Promise<void> {
  const saved = await tx.tickets.save(expected, next)
  if (!saved.ok) throw new RefusedWrite(storeFailure(saved.error))
}

async function appendComment(tx: UnitOfWork, comment: IssueComment): Promise<void> {
  const appended = await tx.issues.appendComment(comment)
  if (!appended.ok) throw new RefusedWrite(storeFailure(appended.error))
}

async function appendReview(tx: UnitOfWork, review: ExperimentReview): Promise<void> {
  const appended = await tx.experiments.appendReview(review)
  if (!appended.ok) throw new RefusedWrite(storeFailure(appended.error))
}

async function appendCIRecord(tx: UnitOfWork, record: CIRecord): Promise<void> {
  const appended = await tx.ciRecords.append(record)
  if (!appended.ok) throw new RefusedWrite(storeFailure(appended.error))
}

/** The facts that make one handled command: the value it returns and its audit fact. */
interface Committed<K extends CommandType> {
  readonly value: CommandResult<K>
  readonly entry: AuditEntryOf<AuditActionOf<K>>
}

interface Host {
  readonly uow: UnitOfWork
  readonly clock: Clock
}

async function refuse<K extends CommandType>(
  host: Host,
  context: CommandContext<K>,
  programId: ProgramId,
  error: DomainError,
): Promise<CommandOutcome<K>> {
  const entry = refusalEntry(host.clock, context, programId, error)
  await host.uow.audit.append([entry])
  return { ok: false, error, audit: [entry] }
}

/**
 * Run the writes of one accepted command, append its audit entry in the same transaction
 * and return the success outcome. A store refusal rolls everything back and becomes an
 * audited `command.refused` outcome; it does not escape as an exception.
 */
async function commit<K extends CommandType>(
  host: Host,
  context: CommandContext<K>,
  programId: ProgramId,
  committed: Committed<K>,
  writes: (tx: UnitOfWork) => Promise<void>,
): Promise<CommandOutcome<K>> {
  try {
    await host.uow.transaction(async (tx) => {
      await writes(tx)
      await tx.audit.append([committed.entry])
    })
    return { ok: true, value: committed.value, audit: [committed.entry] }
  } catch (error) {
    if (error instanceof RefusedWrite) {
      return refuse(host, context, programId, error.refusal)
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// Shared reads
// ---------------------------------------------------------------------------

interface AssignedExperiment {
  readonly experiment: Versioned<Experiment>
  readonly issue: Versioned<Issue>
  readonly assignment: IssueAssignmentData
}

/**
 * Load the Experiment an assignment-bearing researcher command names, check that it lives
 * in the command's Program and that the acting researcher is the Issue assignee.
 */
async function assignedExperiment(
  host: Host,
  programId: ProgramId,
  experimentId: ExperimentId,
  actor: ResearcherPrincipal,
): Promise<Result<AssignedExperiment, DomainError>> {
  const experiment = await host.uow.experiments.get(experimentId)
  if (experiment === undefined) {
    return err(notFound(`experiment ${experimentId} does not exist`))
  }
  if (experiment.value.programId !== programId) {
    return err(notFound(`experiment ${experimentId} does not belong to program ${programId}`))
  }
  const issue = await host.uow.issues.get(experiment.value.issueId)
  if (issue === undefined) {
    return err(notFound(`issue ${experiment.value.issueId} does not exist`))
  }
  if (issue.value.programId !== programId) {
    return err(
      notFound(`issue ${issue.value.id} does not belong to program ${programId}`),
    )
  }
  const assignment = authorizationOf(issue.value, actor)
  if (!assignment.ok) return assignment
  return ok({ experiment, issue, assignment: assignment.value })
}

function authorizationOf(
  issue: Issue,
  actor: ResearcherPrincipal,
): Result<IssueAssignmentData, DomainError> {
  const data = authorizableIssueData(issue)
  if (!data.ok) return data
  const assignment = authorizeIssue(data.value, actor.sessionId)
  if (!assignment.ok) return assignment
  return ok(assignment.value)
}

/** The Host-injected proof must name this Issue and this researcher. */
function assignmentMatches(
  assignment: IssueAssignmentToken,
  issue: Issue,
  actor: ResearcherPrincipal,
): boolean {
  return (
    assignment.issueId === issue.id &&
    assignment.assignee.sessionId === actor.sessionId
  )
}

/** The plan text a proposal appends to the Issue comment thread. */
function planCommentBody(plan: ExperimentPlan): NonEmptyString {
  return nonEmpty(
    [
      `Hypothesis: ${plan.hypothesis}`,
      '',
      'Steps:',
      ...plan.steps.map((step, index) => `${index + 1}. ${step}`),
      '',
      `Expected: ${plan.expected.direction} — ${plan.expected.rationale}`,
    ].join('\n'),
  )
}

// ---------------------------------------------------------------------------
// Program commands
// ---------------------------------------------------------------------------

async function createProgram(
  host: Host,
  command: CommandOf<'program.create'>,
  context: CommandContext<'program.create'>,
): Promise<CommandOutcome<'program.create'>> {
  const programId = mintId<ProgramId>(`program-${context.requestId}`)
  const created = createRunningProgram({
    id: programId,
    name: command.name,
    goal: command.goal,
    methodology: command.methodology,
    contract: command.contract,
    utility: command.utility,
    exploration: command.exploration,
    budget: command.budget,
    usage: { experiments: 0, computeMinutes: 0, tokens: 0 },
    createdAt: context.at,
    status: 'running',
  })
  if (!created.ok) return refuse(host, context, programId, created.error)

  const entry: AuditEntryOf<'program.created'> = {
    id: mintId<AuditId>(`audit-${context.requestId}-program.created`),
    at: host.clock.now(),
    programId,
    action: 'program.created',
    subject: { kind: 'program', id: programId },
    actor: context.actor,
    detail: { name: command.name, requestId: context.requestId },
  }
  return commit(host, context, programId, { value: created.value, entry }, async (tx) => {
    await saveProgram(tx, INITIAL_VERSION, created.value)
  })
}

async function pauseProgramCommand(
  host: Host,
  command: CommandOf<'program.pause'>,
  context: CommandContext<'program.pause'>,
): Promise<CommandOutcome<'program.pause'>> {
  const loaded = await host.uow.programs.get(command.programId)
  if (loaded === undefined) {
    return refuse(
      host,
      context,
      command.programId,
      notFound(`program ${command.programId} does not exist`),
    )
  }
  const next = pauseProgram(loaded.value, context.at)
  if (!next.ok) return refuse(host, context, command.programId, next.error)
  const paused = createPausedProgram(next.value)
  if (!paused.ok) return refuse(host, context, command.programId, paused.error)

  const entry: AuditEntryOf<'program.paused'> = {
    id: mintId<AuditId>(`audit-${context.requestId}-program.paused`),
    at: host.clock.now(),
    programId: command.programId,
    action: 'program.paused',
    subject: { kind: 'program', id: command.programId },
    actor: context.actor,
    detail: { requestId: context.requestId },
  }
  return commit(host, context, command.programId, { value: paused.value, entry }, async (tx) => {
    await saveProgram(tx, loaded.version, paused.value)
  })
}

async function resumeProgramCommand(
  host: Host,
  command: CommandOf<'program.resume'>,
  context: CommandContext<'program.resume'>,
): Promise<CommandOutcome<'program.resume'>> {
  const loaded = await host.uow.programs.get(command.programId)
  if (loaded === undefined) {
    return refuse(
      host,
      context,
      command.programId,
      notFound(`program ${command.programId} does not exist`),
    )
  }
  const next = resumeProgram(loaded.value)
  if (!next.ok) return refuse(host, context, command.programId, next.error)
  const running = createRunningProgram(next.value)
  if (!running.ok) return refuse(host, context, command.programId, running.error)

  const entry: AuditEntryOf<'program.resumed'> = {
    id: mintId<AuditId>(`audit-${context.requestId}-program.resumed`),
    at: host.clock.now(),
    programId: command.programId,
    action: 'program.resumed',
    subject: { kind: 'program', id: command.programId },
    actor: context.actor,
    detail: { requestId: context.requestId },
  }
  return commit(host, context, command.programId, { value: running.value, entry }, async (tx) => {
    await saveProgram(tx, loaded.version, running.value)
  })
}

async function stopProgramCommand(
  host: Host,
  command: CommandOf<'program.stop'>,
  context: CommandContext<'program.stop'>,
): Promise<CommandOutcome<'program.stop'>> {
  const loaded = await host.uow.programs.get(command.programId)
  if (loaded === undefined) {
    return refuse(
      host,
      context,
      command.programId,
      notFound(`program ${command.programId} does not exist`),
    )
  }
  const next = stopProgram(loaded.value, command.reason, context.at)
  if (!next.ok) return refuse(host, context, command.programId, next.error)
  const stopped = createStoppedProgram(next.value)
  if (!stopped.ok) return refuse(host, context, command.programId, stopped.error)

  const entry: AuditEntryOf<'program.stopped'> = {
    id: mintId<AuditId>(`audit-${context.requestId}-program.stopped`),
    at: host.clock.now(),
    programId: command.programId,
    action: 'program.stopped',
    subject: { kind: 'program', id: command.programId },
    actor: context.actor,
    detail: { reason: command.reason, requestId: context.requestId },
  }
  return commit(host, context, command.programId, { value: stopped.value, entry }, async (tx) => {
    await saveProgram(tx, loaded.version, stopped.value)
  })
}

/**
 * The change commands return a `RunningProgram` by contract, so a paused Program is
 * refused rather than returned as a value of a state the result type cannot express.
 */
async function runningProgram(
  host: Host,
  programId: ProgramId,
): Promise<Result<Versioned<Program>, DomainError>> {
  const found = await host.uow.programs.get(programId)
  if (found === undefined) return err(notFound(`program ${programId} does not exist`))
  if (found.value.status !== 'running') {
    return err(invalidState('only a running program can change its goal, methodology or exploration'))
  }
  return ok(found)
}

async function setGoalCommand(
  host: Host,
  command: CommandOf<'program.set-goal'>,
  context: CommandContext<'program.set-goal'>,
): Promise<CommandOutcome<'program.set-goal'>> {
  const loaded = await runningProgram(host, command.programId)
  if (!loaded.ok) return refuse(host, context, command.programId, loaded.error)
  const next = setGoal(loaded.value.value, command.goal)
  if (!next.ok) return refuse(host, context, command.programId, next.error)
  const running = createRunningProgram(next.value)
  if (!running.ok) return refuse(host, context, command.programId, running.error)

  const entry: AuditEntryOf<'program.goal-changed'> = {
    id: mintId<AuditId>(`audit-${context.requestId}-program.goal-changed`),
    at: host.clock.now(),
    programId: command.programId,
    action: 'program.goal-changed',
    subject: { kind: 'program', id: command.programId },
    actor: context.actor,
    detail: { goal: command.goal, requestId: context.requestId },
  }
  return commit(host, context, command.programId, { value: running.value, entry }, async (tx) => {
    await saveProgram(tx, loaded.value.version, running.value)
  })
}

async function setMethodologyCommand(
  host: Host,
  command: CommandOf<'program.set-methodology'>,
  context: CommandContext<'program.set-methodology'>,
): Promise<CommandOutcome<'program.set-methodology'>> {
  const loaded = await runningProgram(host, command.programId)
  if (!loaded.ok) return refuse(host, context, command.programId, loaded.error)
  const next = setMethodology(loaded.value.value, command.methodology)
  if (!next.ok) return refuse(host, context, command.programId, next.error)
  const running = createRunningProgram(next.value)
  if (!running.ok) return refuse(host, context, command.programId, running.error)

  const entry: AuditEntryOf<'program.methodology-changed'> = {
    id: mintId<AuditId>(`audit-${context.requestId}-program.methodology-changed`),
    at: host.clock.now(),
    programId: command.programId,
    action: 'program.methodology-changed',
    subject: { kind: 'program', id: command.programId },
    actor: context.actor,
    detail: { requestId: context.requestId },
  }
  return commit(host, context, command.programId, { value: running.value, entry }, async (tx) => {
    await saveProgram(tx, loaded.value.version, running.value)
  })
}

async function setExplorationCommand(
  host: Host,
  command: CommandOf<'program.set-exploration'>,
  context: CommandContext<'program.set-exploration'>,
): Promise<CommandOutcome<'program.set-exploration'>> {
  const loaded = await runningProgram(host, command.programId)
  if (!loaded.ok) return refuse(host, context, command.programId, loaded.error)
  const next = setExploration(loaded.value.value, command.level)
  if (!next.ok) return refuse(host, context, command.programId, next.error)
  const running = createRunningProgram(next.value)
  if (!running.ok) return refuse(host, context, command.programId, running.error)

  const entry: AuditEntryOf<'program.exploration-changed'> = {
    id: mintId<AuditId>(`audit-${context.requestId}-program.exploration-changed`),
    at: host.clock.now(),
    programId: command.programId,
    action: 'program.exploration-changed',
    subject: { kind: 'program', id: command.programId },
    actor: context.actor,
    detail: { level: command.level, requestId: context.requestId },
  }
  return commit(host, context, command.programId, { value: running.value, entry }, async (tx) => {
    await saveProgram(tx, loaded.value.version, running.value)
  })
}

// ---------------------------------------------------------------------------
// Issue commands
// ---------------------------------------------------------------------------

async function createIssue(
  host: Host,
  command: CommandOf<'issue.create'>,
  context: CommandContext<'issue.create'>,
): Promise<CommandOutcome<'issue.create'>> {
  const program = await host.uow.programs.get(command.programId)
  if (program === undefined) {
    return refuse(
      host,
      context,
      command.programId,
      notFound(`program ${command.programId} does not exist`),
    )
  }
  const issueId = mintId<IssueId>(`issue-${context.requestId}`)
  const created = createOpenIssue({
    id: issueId,
    programId: command.programId,
    title: command.title,
    body: command.body,
    labels: command.labels,
    author: { kind: context.actor.kind, sessionId: context.actor.sessionId },
    createdAt: context.at,
    status: 'open',
  })
  if (!created.ok) return refuse(host, context, command.programId, created.error)

  const entry: AuditEntryOf<'issue.created'> = {
    id: mintId<AuditId>(`audit-${context.requestId}-issue.created`),
    at: host.clock.now(),
    programId: command.programId,
    action: 'issue.created',
    subject: { kind: 'issue', id: issueId },
    actor: context.actor,
    detail: { title: command.title, requestId: context.requestId },
  }
  return commit(host, context, command.programId, { value: created.value, entry }, async (tx) => {
    await saveIssue(tx, INITIAL_VERSION, created.value)
  })
}

async function claimIssueCommand(
  host: Host,
  command: CommandOf<'issue.claim'>,
  context: CommandContext<'issue.claim'>,
): Promise<CommandOutcome<'issue.claim'>> {
  const found = await host.uow.issues.get(command.issueId)
  if (found === undefined) {
    return refuse(host, context, command.programId, notFound(`issue ${command.issueId} does not exist`))
  }
  if (found.value.programId !== command.programId) {
    return refuse(
      host,
      context,
      command.programId,
      notFound(`issue ${command.issueId} does not belong to program ${command.programId}`),
    )
  }
  if (found.value.status !== 'open') {
    return refuse(host, context, command.programId, invalidState('only an open issue can be claimed'))
  }
  const claimed = claimIssue(found.value, context.actor.sessionId, context.at)
  if (!claimed.ok) return refuse(host, context, command.programId, claimed.error)
  const assigned = createAssignedIssue(claimed.value)
  if (!assigned.ok) return refuse(host, context, command.programId, assigned.error)

  const entry: AuditEntryOf<'issue.claimed'> = {
    id: mintId<AuditId>(`audit-${context.requestId}-issue.claimed`),
    at: host.clock.now(),
    programId: command.programId,
    action: 'issue.claimed',
    subject: { kind: 'issue', id: command.issueId },
    actor: context.actor,
    detail: { sessionId: context.actor.sessionId, requestId: context.requestId },
  }
  return commit(host, context, command.programId, { value: assigned.value, entry }, async (tx) => {
    await saveIssue(tx, found.version, assigned.value)
  })
}

async function commentOnIssue(
  host: Host,
  command: CommandOf<'issue.comment'>,
  context: CommandContext<'issue.comment'>,
): Promise<CommandOutcome<'issue.comment'>> {
  const found = await host.uow.issues.get(command.issueId)
  if (found === undefined) {
    return refuse(host, context, command.programId, notFound(`issue ${command.issueId} does not exist`))
  }
  if (found.value.programId !== command.programId) {
    return refuse(
      host,
      context,
      command.programId,
      notFound(`issue ${command.issueId} does not belong to program ${command.programId}`),
    )
  }
  const comment: IssueComment = {
    id: mintId<CommentId>(`comment-${context.requestId}`),
    issueId: command.issueId,
    authorSessionId: context.actor.kind === 'operator' ? 'operator' : context.actor.sessionId,
    body: command.body,
    at: context.at,
    kind: command.kind,
  }

  const entry: AuditEntryOf<'issue.commented'> = {
    id: mintId<AuditId>(`audit-${context.requestId}-issue.commented`),
    at: host.clock.now(),
    programId: command.programId,
    action: 'issue.commented',
    subject: { kind: 'issue', id: command.issueId },
    actor: context.actor,
    detail: { kind: command.kind, requestId: context.requestId },
  }
  return commit(host, context, command.programId, { value: comment, entry }, async (tx) => {
    await appendComment(tx, comment)
  })
}

async function closeIssue(
  host: Host,
  command: CommandOf<'issue.close'>,
  context: CommandContext<'issue.close'>,
): Promise<CommandOutcome<'issue.close'>> {
  const found = await host.uow.issues.get(command.issueId)
  if (found === undefined) {
    return refuse(host, context, command.programId, notFound(`issue ${command.issueId} does not exist`))
  }
  if (found.value.programId !== command.programId) {
    return refuse(
      host,
      context,
      command.programId,
      notFound(`issue ${command.issueId} does not belong to program ${command.programId}`),
    )
  }
  const data = authorizableIssueData(found.value)
  if (!data.ok) return refuse(host, context, command.programId, data.error)
  const assignment = authorizeIssue(data.value, context.actor.sessionId)
  if (!assignment.ok) return refuse(host, context, command.programId, assignment.error)
  const closed = closeAssignedIssue(
    data.value,
    assignment.value,
    command.resolution,
    command.summary,
    context.at,
  )
  if (!closed.ok) return refuse(host, context, command.programId, closed.error)
  const closedIssue = createClosedIssue(closed.value)
  if (!closedIssue.ok) return refuse(host, context, command.programId, closedIssue.error)

  const entry: AuditEntryOf<'issue.closed'> = {
    id: mintId<AuditId>(`audit-${context.requestId}-issue.closed`),
    at: host.clock.now(),
    programId: command.programId,
    action: 'issue.closed',
    subject: { kind: 'issue', id: command.issueId },
    actor: context.actor,
    detail: {
      resolution: command.resolution,
      summary: command.summary,
      requestId: context.requestId,
    },
  }
  return commit(host, context, command.programId, { value: closedIssue.value, entry }, async (tx) => {
    await saveIssue(tx, found.version, closedIssue.value)
  })
}

// ---------------------------------------------------------------------------
// Experiment commands
// ---------------------------------------------------------------------------

async function proposeExperiment(
  host: Host,
  command: CommandOf<'experiment.propose'>,
  context: CommandContext<'experiment.propose'>,
): Promise<CommandOutcome<'experiment.propose'>> {
  const program = await host.uow.programs.get(command.programId)
  if (program === undefined) {
    return refuse(
      host,
      context,
      command.programId,
      notFound(`program ${command.programId} does not exist`),
    )
  }
  const issue = await host.uow.issues.get(command.issueId)
  if (issue === undefined) {
    return refuse(host, context, command.programId, notFound(`issue ${command.issueId} does not exist`))
  }
  if (issue.value.programId !== command.programId) {
    return refuse(
      host,
      context,
      command.programId,
      notFound(`issue ${command.issueId} does not belong to program ${command.programId}`),
    )
  }
  const data = authorizableIssueData(issue.value)
  if (!data.ok) return refuse(host, context, command.programId, data.error)
  if (!assignmentMatches(command.assignment, issue.value, context.actor)) {
    return refuse(
      host,
      context,
      command.programId,
      forbidden('the assignment token does not belong to this issue and researcher'),
    )
  }
  const assignment = authorizeIssue(data.value, context.actor.sessionId)
  if (!assignment.ok) return refuse(host, context, command.programId, assignment.error)

  const experimentId = mintId<ExperimentId>(`experiment-${context.requestId}`)
  const preset = EXPLORATION_PRESETS[program.value.exploration]
  const lineage = createFreshLineage({
    baseCommit: PENDING_SCAFFOLD_COMMIT,
    freshStartProbability: preset.freshStartProbability,
  })
  if (!lineage.ok) return refuse(host, context, command.programId, lineage.error)

  const planCommentId = mintId<CommentId>(`plan-${context.requestId}`)
  const planComment: IssueComment = {
    id: planCommentId,
    issueId: command.issueId,
    authorSessionId: context.actor.sessionId,
    body: planCommentBody(command.plan),
    at: context.at,
    kind: 'plan',
  }
  const created = createOpenExperiment({
    id: experimentId,
    programId: command.programId,
    issueId: command.issueId,
    branch: experimentBranch(experimentId),
    head: PENDING_SCAFFOLD_COMMIT,
    environment: command.plan.environment,
    lineage: lineage.value,
    planCommentId,
    createdBy: { kind: 'researcher', sessionId: context.actor.sessionId },
    createdAt: context.at,
    status: 'open',
  })
  if (!created.ok) return refuse(host, context, command.programId, created.error)

  const linked = addExperiment(data.value, assignment.value, experimentId)
  if (!linked.ok) return refuse(host, context, command.programId, linked.error)
  const linkedIssue = createAssignedIssue(linked.value)
  if (!linkedIssue.ok) return refuse(host, context, command.programId, linkedIssue.error)

  const entry: AuditEntryOf<'experiment.proposed'> = {
    id: mintId<AuditId>(`audit-${context.requestId}-experiment.proposed`),
    at: host.clock.now(),
    programId: command.programId,
    action: 'experiment.proposed',
    subject: { kind: 'issue', id: command.issueId },
    actor: context.actor,
    detail: {
      experimentId,
      hypothesis: command.plan.hypothesis,
      requestId: context.requestId,
    },
  }
  return commit(host, context, command.programId, { value: created.value, entry }, async (tx) => {
    await saveIssue(tx, issue.version, linkedIssue.value)
    await saveExperiment(tx, INITIAL_VERSION, created.value)
    await appendComment(tx, planComment)
  })
}

async function reviewExperiment(
  host: Host,
  command: CommandOf<'experiment.review'>,
  context: CommandContext<'experiment.review'>,
): Promise<CommandOutcome<'experiment.review'>> {
  const loaded = await assignedExperiment(host, command.programId, command.experimentId, context.actor)
  if (!loaded.ok) {
    return refuse(host, context, command.programId, loaded.error)
  }
  if (!assignmentMatches(command.assignment, loaded.value.issue.value, context.actor)) {
    return refuse(
      host,
      context,
      command.programId,
      forbidden('the assignment token does not belong to this issue and researcher'),
    )
  }
  const review: ExperimentReview = {
    id: mintId<ReviewId>(`review-${context.requestId}`),
    experimentId: command.experimentId,
    author: context.actor,
    body: command.body,
    at: context.at,
    kind: 'review',
    verdict: command.verdict,
  }

  const entry: AuditEntryOf<'experiment.reviewed'> = {
    id: mintId<AuditId>(`audit-${context.requestId}-experiment.reviewed`),
    at: host.clock.now(),
    programId: command.programId,
    action: 'experiment.reviewed',
    subject: { kind: 'experiment', id: command.experimentId },
    actor: context.actor,
    detail: { verdict: command.verdict, requestId: context.requestId },
  }
  return commit(host, context, command.programId, { value: review, entry }, async (tx) => {
    await appendReview(tx, review)
  })
}

async function closeExperimentCommand(
  host: Host,
  command: CommandOf<'experiment.close'>,
  context: CommandContext<'experiment.close'>,
): Promise<CommandOutcome<'experiment.close'>> {
  const loaded = await assignedExperiment(host, command.programId, command.experimentId, context.actor)
  if (!loaded.ok) {
    return refuse(host, context, command.programId, loaded.error)
  }
  if (!assignmentMatches(command.assignment, loaded.value.issue.value, context.actor)) {
    return refuse(
      host,
      context,
      command.programId,
      forbidden('the assignment token does not belong to this issue and researcher'),
    )
  }
  const closed = closeExperiment(
    experimentData(loaded.value.experiment.value),
    assignmentData(command.assignment),
    command.reason,
    context.at,
  )
  if (!closed.ok) return refuse(host, context, command.programId, closed.error)
  const closedExperiment = createClosedExperiment(closed.value)
  if (!closedExperiment.ok) return refuse(host, context, command.programId, closedExperiment.error)

  const entry: AuditEntryOf<'experiment.closed'> = {
    id: mintId<AuditId>(`audit-${context.requestId}-experiment.closed`),
    at: host.clock.now(),
    programId: command.programId,
    action: 'experiment.closed',
    subject: { kind: 'experiment', id: command.experimentId },
    actor: context.actor,
    detail: {
      outcome: closedExperiment.value.outcome,
      reason: command.reason,
      requestId: context.requestId,
    },
  }
  return commit(
    host,
    context,
    command.programId,
    { value: closedExperiment.value, entry },
    async (tx) => {
      await saveExperiment(tx, loaded.value.experiment.version, closedExperiment.value)
    },
  )
}

// ---------------------------------------------------------------------------
// CI command
// ---------------------------------------------------------------------------

async function requestCI(
  host: Host,
  command: CommandOf<'ci.request'>,
  context: CommandContext<'ci.request'>,
): Promise<CommandOutcome<'ci.request'>> {
  const loaded = await assignedExperiment(host, command.programId, command.experimentId, context.actor)
  if (!loaded.ok) {
    return refuse(host, context, command.programId, loaded.error)
  }
  const { experiment, assignment } = loaded.value
  const token = createCIRequestToken({
    ciRunId: mintId<CIRunId>(`ci-${context.requestId}`),
    experimentId: experiment.value.id,
    commit: experiment.value.head,
    requestedAt: context.at,
    experiment: experiment.value,
  })
  if (!token.ok) return refuse(host, context, command.programId, token.error)

  const pending = requestExperimentCI(experimentData(experiment.value), assignment, token.value)
  if (!pending.ok) return refuse(host, context, command.programId, pending.error)
  const pendingExperiment = createCIPendingExperiment(pending.value)
  if (!pendingExperiment.ok) return refuse(host, context, command.programId, pendingExperiment.error)

  // The RequestedCIRecord is a plain structural record (the type is not a nominal class),
  // so it is built from the token and the pending Experiment the domain just accepted; the
  // repository validates it on append.
  const record: RequestedCIRecord = {
    id: token.value.ciRunId,
    programId: pendingExperiment.value.programId,
    experimentId: pendingExperiment.value.id,
    commit: pendingExperiment.value.head,
    requestedBy: context.actor.sessionId,
    requestedAt: token.value.requestedAt,
    status: 'requested',
  }

  const entry: AuditEntryOf<'ci.requested'> = {
    id: mintId<AuditId>(`audit-${context.requestId}-ci.requested`),
    at: host.clock.now(),
    programId: command.programId,
    action: 'ci.requested',
    subject: { kind: 'ci-run', id: token.value.ciRunId },
    actor: context.actor,
    detail: {
      experimentId: experiment.value.id,
      commit: experiment.value.head,
      requestId: context.requestId,
    },
  }
  return commit(host, context, command.programId, { value: pendingExperiment.value, entry }, async (tx) => {
    await saveExperiment(tx, experiment.version, pendingExperiment.value)
    await appendCIRecord(tx, record)
  })
}

// ---------------------------------------------------------------------------
// Ticket command
// ---------------------------------------------------------------------------

async function submitImplementation(
  host: Host,
  command: CommandOf<'ticket.submit'>,
  context: CommandContext<'ticket.submit'>,
): Promise<CommandOutcome<'ticket.submit'>> {
  const experiment = await host.uow.experiments.get(command.binding.experimentId)
  const ticket = await host.uow.tickets.get(command.binding.ticketId)
  const programId = experiment?.value.programId ?? ticket?.value.programId ?? UNBOUND_PROGRAM

  if (command.binding.sessionId !== context.actor.sessionId) {
    return refuse(
      host,
      context,
      programId,
      forbidden('the ticket binding belongs to another implementer session'),
    )
  }
  if (context.actor.ticketId !== command.binding.ticketId) {
    return refuse(host, context, programId, forbidden('the implementer is bound to another ticket'))
  }
  if (experiment === undefined) {
    return refuse(
      host,
      context,
      programId,
      notFound(`experiment ${command.binding.experimentId} does not exist`),
    )
  }
  if (ticket === undefined) {
    return refuse(host, context, programId, notFound(`ticket ${command.binding.ticketId} does not exist`))
  }

  const submitted = submitTicket(ticket.value, context.actor.sessionId, command.head, context.at)
  if (!submitted.ok) return refuse(host, context, programId, submitted.error)
  const submittedTicket = createSubmittedTicket(submitted.value)
  if (!submittedTicket.ok) return refuse(host, context, programId, submittedTicket.error)

  const ready = submitExperiment(
    experimentData(experiment.value),
    submitted.value,
    context.actor.sessionId,
    command.binding,
    command.head,
    command.environment,
    context.at,
  )
  if (!ready.ok) return refuse(host, context, programId, ready.error)
  const readyExperiment = createReadyExperiment(ready.value)
  if (!readyExperiment.ok) return refuse(host, context, programId, readyExperiment.error)

  const entry: AuditEntryOf<'experiment.ready'> = {
    id: mintId<AuditId>(`audit-${context.requestId}-experiment.ready`),
    at: host.clock.now(),
    programId,
    action: 'experiment.ready',
    subject: { kind: 'experiment', id: experiment.value.id },
    actor: context.actor,
    detail: {
      ticketId: command.binding.ticketId,
      head: command.head,
      requestId: context.requestId,
    },
  }
  return commit(host, context, programId, { value: readyExperiment.value, entry }, async (tx) => {
    await saveExperiment(tx, experiment.version, readyExperiment.value)
    await saveTicket(tx, ticket.version, submittedTicket.value)
  })
}

// ---------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------

/**
 * Compose the command handlers over one unit of work and one clock.
 *
 * The map covers every `CommandType` (the mapped type makes a missing slot a compile
 * error). Each slot reads, transitions and commits as described in the module comment; the
 * clock stamps audit facts and the command context stamps state transitions.
 */
export function createCommandHandlers(uow: UnitOfWork, clock: Clock): CommandHandlers {
  const host: Host = { uow, clock }
  return {
    'program.create': (command, context) => createProgram(host, command, context),
    'program.pause': (command, context) => pauseProgramCommand(host, command, context),
    'program.resume': (command, context) => resumeProgramCommand(host, command, context),
    'program.stop': (command, context) => stopProgramCommand(host, command, context),
    'program.set-goal': (command, context) => setGoalCommand(host, command, context),
    'program.set-methodology': (command, context) => setMethodologyCommand(host, command, context),
    'program.set-exploration': (command, context) => setExplorationCommand(host, command, context),
    'issue.create': (command, context) => createIssue(host, command, context),
    'issue.claim': (command, context) => claimIssueCommand(host, command, context),
    'issue.comment': (command, context) => commentOnIssue(host, command, context),
    'issue.close': (command, context) => closeIssue(host, command, context),
    'experiment.propose': (command, context) => proposeExperiment(host, command, context),
    'experiment.review': (command, context) => reviewExperiment(host, command, context),
    'experiment.close': (command, context) => closeExperimentCommand(host, command, context),
    'ci.request': (command, context) => requestCI(host, command, context),
    'ticket.submit': (command, context) => submitImplementation(host, command, context),
  }
}
