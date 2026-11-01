/**
 * Pure domain transitions over plain data records.
 *
 * The nominal classes in `src/types/` cannot be constructed outside the factory
 * boundary. This module therefore mirrors every state variant as a `*Data` record with
 * plain primitives and returns the next record; the factory boundary keeps ownership of
 * converting records to and from the nominal classes. Nothing here constructs a class,
 * reads the clock, parses JSON or asserts a type.
 *
 * Ownership is checked here, not by the caller: assignment, binding and CI completion
 * tokens are plain data records compared against the aggregate before a transition moves
 * state. A mismatch returns `forbidden` (the token belongs to another aggregate or
 * session) or `invalid-state` (the evidence does not match this aggregate's commit, run
 * id or environment).
 */
import type { EnvironmentDeclaration } from '../types/environment.js'
import type { ExperimentLineage } from '../types/experiment.js'
import type { ArtifactRef } from '../types/artifacts.js'
import type { CIFailureReason } from '../types/ci.js'
import type { DomainError, DomainErrorCode, Err, Ok, Result } from '../types/errors.js'
import type { NonEmptyString } from '../types/ids.js'
import type { IssueLabel, IssueResolution } from '../types/issue.js'
import type { MetricMap } from '../types/metrics.js'
import type { EvaluationContract, ExplorationLevel, UtilityConfig } from '../types/program.js'

/**
 * `DomainError.message` is a nominal `NonEmptyString`. The factory boundary normally
 * mints branded values; this data-only module never consumes untrusted input, and every
 * refusal message is a literal constant defined in this file. This refinement declares
 * the non-empty invariant once, with a runtime fallback, so the transitions can return
 * `DomainError` without a type assertion.
 */
function nonEmpty(value: string): NonEmptyString
function nonEmpty(value: string): string {
  return value.length === 0 ? 'refused' : value
}

function ok<T>(value: T): Ok<T> {
  return { ok: true, value }
}

function invalidState(message: string): Err<DomainError> {
  return { ok: false, error: { code: 'invalid-state', message: nonEmpty(message) } }
}

function forbidden(message: string): Err<DomainError> {
  return { ok: false, error: { code: 'forbidden', message: nonEmpty(message) } }
}

function invalidInput(message: string): Err<DomainError> {
  return { ok: false, error: { code: 'invalid-input', message: nonEmpty(message) } }
}

function conflict(message: string): Err<DomainError> {
  return { ok: false, error: { code: 'conflict', message: nonEmpty(message) } }
}

function isText(value: string): boolean {
  return value.length > 0
}

function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

// ---------------------------------------------------------------------------
// Program records
// ---------------------------------------------------------------------------

export interface BudgetData {
  readonly maxExperiments: number
  readonly maxComputeMinutes: number
  readonly maxTokens: number
}

export interface BudgetUsageData {
  readonly experiments: number
  readonly computeMinutes: number
  readonly tokens: number
}

/** Host-recorded deltas; the runtime rejects negative or non-finite values. */
export interface UsageDeltaData {
  readonly experiments: number
  readonly computeMinutes: number
  readonly tokens: number
}

export interface ProgramCommonData {
  readonly id: string
  readonly name: string
  readonly goal: string
  readonly methodology: string
  readonly contract: EvaluationContract
  readonly utility: UtilityConfig
  readonly exploration: ExplorationLevel
  readonly budget: BudgetData
  readonly usage: BudgetUsageData
  readonly createdAt: string
}

export interface RunningProgramData extends ProgramCommonData {
  readonly status: 'running'
}

export interface PausedProgramData extends ProgramCommonData {
  readonly status: 'paused'
  readonly pausedAt: string
}

export interface StoppedProgramData extends ProgramCommonData {
  readonly status: 'stopped'
  readonly stoppedAt: string
  readonly stopReason: string
}

export interface CompletedProgramData extends ProgramCommonData {
  readonly status: 'completed'
  readonly completedAt: string
  readonly completionReason: string
}

export type ProgramData =
  | RunningProgramData
  | PausedProgramData
  | StoppedProgramData
  | CompletedProgramData

function programCommon(program: ProgramData): ProgramCommonData {
  return {
    id: program.id,
    name: program.name,
    goal: program.goal,
    methodology: program.methodology,
    contract: program.contract,
    utility: program.utility,
    exploration: program.exploration,
    budget: program.budget,
    usage: program.usage,
    createdAt: program.createdAt,
  }
}

function negativeUsageFields(delta: UsageDeltaData): string | undefined {
  if (!isNonNegativeFinite(delta.experiments)) {
    return 'experiments delta must be a finite non-negative number'
  }
  if (!isNonNegativeFinite(delta.computeMinutes)) {
    return 'computeMinutes delta must be a finite non-negative number'
  }
  if (!isNonNegativeFinite(delta.tokens)) {
    return 'tokens delta must be a finite non-negative number'
  }
  return undefined
}

export function pauseProgram(
  program: ProgramData,
  at: string,
): Result<PausedProgramData, DomainError> {
  switch (program.status) {
    case 'running':
      if (!isText(at)) {
        return invalidInput('pause timestamp must be non-empty')
      }
      return ok({ ...programCommon(program), status: 'paused', pausedAt: at })
    case 'paused':
    case 'stopped':
    case 'completed':
      return invalidState('only a running program can be paused')
  }
}

export function resumeProgram(
  program: ProgramData,
): Result<RunningProgramData, DomainError> {
  switch (program.status) {
    case 'paused':
      return ok({ ...programCommon(program), status: 'running' })
    case 'running':
    case 'stopped':
    case 'completed':
      return invalidState('only a paused program can be resumed')
  }
}

export function stopProgram(
  program: ProgramData,
  reason: string,
  at: string,
): Result<StoppedProgramData, DomainError> {
  switch (program.status) {
    case 'running':
    case 'paused':
      if (!isText(reason)) {
        return invalidInput('stop reason must be non-empty')
      }
      if (!isText(at)) {
        return invalidInput('stop timestamp must be non-empty')
      }
      return ok({ ...programCommon(program), status: 'stopped', stoppedAt: at, stopReason: reason })
    case 'stopped':
    case 'completed':
      return invalidState('a stopped or completed program cannot be stopped')
  }
}

export function completeProgram(
  program: ProgramData,
  reason: string,
  at: string,
): Result<CompletedProgramData, DomainError> {
  switch (program.status) {
    case 'running':
    case 'paused':
      if (!isText(reason)) {
        return invalidInput('completion reason must be non-empty')
      }
      if (!isText(at)) {
        return invalidInput('completion timestamp must be non-empty')
      }
      return ok({
        ...programCommon(program),
        status: 'completed',
        completedAt: at,
        completionReason: reason,
      })
    case 'stopped':
    case 'completed':
      return invalidState('a stopped or completed program cannot be completed')
  }
}

export function setGoal(
  program: ProgramData,
  goal: string,
): Result<RunningProgramData | PausedProgramData, DomainError> {
  if (!isText(goal)) {
    return invalidInput('goal must be non-empty')
  }
  switch (program.status) {
    case 'running':
      return ok({ ...programCommon(program), status: 'running', goal })
    case 'paused':
      return ok({ ...programCommon(program), status: 'paused', pausedAt: program.pausedAt, goal })
    case 'stopped':
    case 'completed':
      return invalidState('the goal of a stopped or completed program cannot change')
  }
}

export function setMethodology(
  program: ProgramData,
  methodology: string,
): Result<RunningProgramData | PausedProgramData, DomainError> {
  if (!isText(methodology)) {
    return invalidInput('methodology must be non-empty')
  }
  switch (program.status) {
    case 'running':
      return ok({ ...programCommon(program), status: 'running', methodology })
    case 'paused':
      return ok({
        ...programCommon(program),
        status: 'paused',
        pausedAt: program.pausedAt,
        methodology,
      })
    case 'stopped':
    case 'completed':
      return invalidState('the methodology of a stopped or completed program cannot change')
  }
}

export function setExploration(
  program: ProgramData,
  exploration: ExplorationLevel,
): Result<RunningProgramData | PausedProgramData, DomainError> {
  switch (program.status) {
    case 'running':
      return ok({ ...programCommon(program), status: 'running', exploration })
    case 'paused':
      return ok({
        ...programCommon(program),
        status: 'paused',
        pausedAt: program.pausedAt,
        exploration,
      })
    case 'stopped':
    case 'completed':
      return invalidState('the exploration level of a stopped or completed program cannot change')
  }
}

export function recordUsage(
  program: ProgramData,
  delta: UsageDeltaData,
): Result<RunningProgramData | PausedProgramData, DomainError> {
  const invalidDelta = negativeUsageFields(delta)
  if (invalidDelta !== undefined) {
    return invalidInput(invalidDelta)
  }
  switch (program.status) {
    case 'running': {
      const usage = addUsage(program.usage, delta)
      return ok({ ...programCommon(program), status: 'running', usage })
    }
    case 'paused': {
      const usage = addUsage(program.usage, delta)
      return ok({ ...programCommon(program), status: 'paused', pausedAt: program.pausedAt, usage })
    }
    case 'stopped':
    case 'completed':
      return invalidState('usage can only be recorded on a running or paused program')
  }
}

function addUsage(usage: BudgetUsageData, delta: UsageDeltaData): BudgetUsageData {
  return {
    experiments: usage.experiments + delta.experiments,
    computeMinutes: usage.computeMinutes + delta.computeMinutes,
    tokens: usage.tokens + delta.tokens,
  }
}

// ---------------------------------------------------------------------------
// Issue records
// ---------------------------------------------------------------------------

export interface IssueAuthorRefData {
  readonly kind: 'operator' | 'researcher'
  readonly sessionId: string
}

export interface IssueCommonData {
  readonly id: string
  readonly programId: string
  readonly title: string
  readonly body: string
  readonly labels: readonly IssueLabel[]
  readonly author: IssueAuthorRefData
  readonly createdAt: string
}

export interface OpenIssueData extends IssueCommonData {
  readonly status: 'open'
}

export interface AssignedIssueData extends IssueCommonData {
  readonly status: 'assigned'
  readonly assigneeSessionId: string
  readonly assignedAt: string
  readonly experimentIds: readonly string[]
}

export interface ClosedIssueData extends IssueCommonData {
  readonly status: 'closed'
  readonly assigneeSessionId: string | null
  readonly closedAt: string
  readonly resolution: IssueResolution
  readonly summary: string
}

export type IssueData = OpenIssueData | AssignedIssueData | ClosedIssueData

/** Proof that the calling Researcher Session is the current Issue assignee. */
export interface IssueAssignmentData {
  readonly issueId: string
  readonly assigneeSessionId: string
}

function issueCommon(issue: IssueData): IssueCommonData {
  return {
    id: issue.id,
    programId: issue.programId,
    title: issue.title,
    body: issue.body,
    labels: issue.labels,
    author: issue.author,
    createdAt: issue.createdAt,
  }
}

export function claimIssue(
  issue: IssueData,
  sessionId: string,
  at: string,
): Result<AssignedIssueData, DomainError> {
  switch (issue.status) {
    case 'open':
      if (!isText(sessionId)) {
        return invalidInput('claiming session must be non-empty')
      }
      if (!isText(at)) {
        return invalidInput('claim timestamp must be non-empty')
      }
      return ok({
        ...issueCommon(issue),
        status: 'assigned',
        assigneeSessionId: sessionId,
        assignedAt: at,
        experimentIds: [],
      })
    case 'assigned':
      return invalidState('the issue is already assigned')
    case 'closed':
      return invalidState('a closed issue cannot be claimed')
  }
}

/** Runtime ownership check: the actor Session must equal the assignee. */
export function authorizeIssue(
  issue: IssueData,
  sessionId: string,
): Result<IssueAssignmentData, DomainError> {
  switch (issue.status) {
    case 'assigned':
      if (!isText(sessionId)) {
        return invalidInput('authorizing session must be non-empty')
      }
      if (issue.assigneeSessionId !== sessionId) {
        return forbidden('only the assigned researcher may act on the issue')
      }
      return ok({ issueId: issue.id, assigneeSessionId: issue.assigneeSessionId })
    case 'open':
      return invalidState('an open issue has no assignee to authorize')
    case 'closed':
      return invalidState('a closed issue cannot authorize work')
  }
}

function assignmentMismatch(issue: AssignedIssueData, assignment: IssueAssignmentData): boolean {
  return (
    assignment.issueId !== issue.id ||
    assignment.assigneeSessionId !== issue.assigneeSessionId
  )
}

export function addExperiment(
  issue: IssueData,
  assignment: IssueAssignmentData,
  experimentId: string,
): Result<AssignedIssueData, DomainError> {
  switch (issue.status) {
    case 'assigned':
      if (assignmentMismatch(issue, assignment)) {
        return forbidden('the assignment token does not belong to this issue and assignee')
      }
      if (!isText(experimentId)) {
        return invalidInput('experiment id must be non-empty')
      }
      if (issue.experimentIds.includes(experimentId)) {
        return conflict('the experiment is already linked to the issue')
      }
      return ok({ ...issue, experimentIds: [...issue.experimentIds, experimentId] })
    case 'open':
      return invalidState('an open issue has no assignee to add an experiment for')
    case 'closed':
      return invalidState('a closed issue cannot receive experiments')
  }
}

/** Operator path: an open issue is closed without an assignment token. */
export function closeOpenIssue(
  issue: IssueData,
  resolution: IssueResolution,
  summary: string,
  at: string,
): Result<ClosedIssueData, DomainError> {
  switch (issue.status) {
    case 'open':
      if (!isText(summary)) {
        return invalidInput('closing summary must be non-empty')
      }
      if (!isText(at)) {
        return invalidInput('close timestamp must be non-empty')
      }
      return ok({
        ...issueCommon(issue),
        status: 'closed',
        assigneeSessionId: null,
        closedAt: at,
        resolution,
        summary,
      })
    case 'assigned':
      return invalidState('an assigned issue is closed by its assignee')
    case 'closed':
      return invalidState('the issue is already closed')
  }
}

export function closeAssignedIssue(
  issue: IssueData,
  assignment: IssueAssignmentData,
  resolution: IssueResolution,
  summary: string,
  at: string,
): Result<ClosedIssueData, DomainError> {
  switch (issue.status) {
    case 'assigned':
      if (assignmentMismatch(issue, assignment)) {
        return forbidden('the assignment token does not belong to this issue and assignee')
      }
      if (!isText(summary)) {
        return invalidInput('closing summary must be non-empty')
      }
      if (!isText(at)) {
        return invalidInput('close timestamp must be non-empty')
      }
      return ok({
        ...issueCommon(issue),
        status: 'closed',
        assigneeSessionId: issue.assigneeSessionId,
        closedAt: at,
        resolution,
        summary,
      })
    case 'open':
      return invalidState('an open issue has no assignee to close it')
    case 'closed':
      return invalidState('the issue is already closed')
  }
}

// ---------------------------------------------------------------------------
// Ticket records
// ---------------------------------------------------------------------------

export interface TicketBaseData {
  readonly id: string
  readonly programId: string
  readonly issueId: string
  readonly experimentId: string
  readonly baseCommit: string
  readonly createdAt: string
}

export interface OpenTicketData extends TicketBaseData {
  readonly status: 'open'
}

export interface RunningTicketData extends TicketBaseData {
  readonly status: 'running'
  readonly sessionId: string
  readonly startedAt: string
}

export interface SubmittedTicketData extends TicketBaseData {
  readonly status: 'submitted'
  readonly sessionId: string
  readonly head: string
  readonly submittedAt: string
}

export interface CancelledTicketData extends TicketBaseData {
  readonly status: 'cancelled'
  readonly reason: string
  readonly cancelledAt: string
}

export interface FailedTicketData extends TicketBaseData {
  readonly status: 'failed'
  readonly reason: string
  readonly failedAt: string
}

export type TicketData =
  | OpenTicketData
  | RunningTicketData
  | SubmittedTicketData
  | CancelledTicketData
  | FailedTicketData

/** Proof that an Implementer Session owns the Ticket for one Experiment. */
export interface TicketBindingData {
  readonly ticketId: string
  readonly experimentId: string
  readonly sessionId: string
}

/** What the Host repository checked before minting the binding. */
export interface TicketBindingExpectationData {
  readonly programId: string
  readonly issueId: string
  readonly experimentId: string
  readonly sessionId: string
}

function ticketBase(ticket: TicketData): TicketBaseData {
  return {
    id: ticket.id,
    programId: ticket.programId,
    issueId: ticket.issueId,
    experimentId: ticket.experimentId,
    baseCommit: ticket.baseCommit,
    createdAt: ticket.createdAt,
  }
}

export function startTicket(
  ticket: TicketData,
  sessionId: string,
  at: string,
): Result<RunningTicketData, DomainError> {
  switch (ticket.status) {
    case 'open':
      if (!isText(sessionId)) {
        return invalidInput('starting session must be non-empty')
      }
      if (!isText(at)) {
        return invalidInput('start timestamp must be non-empty')
      }
      return ok({
        ...ticketBase(ticket),
        status: 'running',
        sessionId,
        startedAt: at,
      })
    case 'running':
    case 'submitted':
    case 'cancelled':
    case 'failed':
      return invalidState('only an open ticket can start')
  }
}

export function submitTicket(
  ticket: TicketData,
  sessionId: string,
  head: string,
  at: string,
): Result<SubmittedTicketData, DomainError> {
  switch (ticket.status) {
    case 'running':
      if (ticket.sessionId !== sessionId) {
        return forbidden('only the bound implementer session may submit the ticket')
      }
      if (!isText(head)) {
        return invalidInput('submitted head commit must be non-empty')
      }
      if (!isText(at)) {
        return invalidInput('submit timestamp must be non-empty')
      }
      return ok({
        ...ticketBase(ticket),
        status: 'submitted',
        sessionId: ticket.sessionId,
        head,
        submittedAt: at,
      })
    case 'open':
      return invalidState('an open ticket has no implementer session to submit')
    case 'submitted':
      return invalidState('the ticket is already submitted')
    case 'cancelled':
    case 'failed':
      return invalidState('a cancelled or failed ticket cannot be submitted')
  }
}

export function cancelTicket(
  ticket: TicketData,
  reason: string,
  at: string,
): Result<CancelledTicketData, DomainError> {
  switch (ticket.status) {
    case 'open':
    case 'running':
    case 'submitted':
      if (!isText(reason)) {
        return invalidInput('cancellation reason must be non-empty')
      }
      if (!isText(at)) {
        return invalidInput('cancellation timestamp must be non-empty')
      }
      return ok({
        ...ticketBase(ticket),
        status: 'cancelled',
        reason,
        cancelledAt: at,
      })
    case 'cancelled':
    case 'failed':
      return invalidState('a terminal ticket cannot be cancelled')
  }
}

export function failTicket(
  ticket: TicketData,
  reason: string,
  at: string,
): Result<FailedTicketData, DomainError> {
  switch (ticket.status) {
    case 'open':
    case 'running':
    case 'submitted':
      if (!isText(reason)) {
        return invalidInput('failure reason must be non-empty')
      }
      if (!isText(at)) {
        return invalidInput('failure timestamp must be non-empty')
      }
      return ok({
        ...ticketBase(ticket),
        status: 'failed',
        reason,
        failedAt: at,
      })
    case 'cancelled':
    case 'failed':
      return invalidState('a terminal ticket cannot fail')
  }
}

/**
 * Mint the Implementer binding from a Ticket in a Session-bearing state. The mint
 * compares the repository expectation with the Ticket fields, so a binding cannot be
 * minted from a different ticket, program, issue, experiment or session.
 */
export function createTicketBinding(
  ticket: TicketData,
  expected: TicketBindingExpectationData,
): Result<TicketBindingData, DomainError> {
  switch (ticket.status) {
    case 'running':
    case 'submitted':
      if (
        expected.programId !== ticket.programId ||
        expected.issueId !== ticket.issueId ||
        expected.experimentId !== ticket.experimentId ||
        expected.sessionId !== ticket.sessionId
      ) {
        return forbidden('the binding expectation does not match the ticket')
      }
      return ok({
        ticketId: ticket.id,
        experimentId: ticket.experimentId,
        sessionId: ticket.sessionId,
      })
    case 'open':
      return invalidState('an open ticket has no implementer session to bind')
    case 'cancelled':
    case 'failed':
      return invalidState('a terminal ticket cannot be bound')
  }
}

// ---------------------------------------------------------------------------
// Experiment records
// ---------------------------------------------------------------------------

export interface ExperimentBaseData {
  readonly id: string
  readonly programId: string
  readonly issueId: string
  readonly branch: string
  readonly head: string
  readonly environment: EnvironmentDeclaration
  readonly lineage: ExperimentLineage
  readonly planCommentId: string
  readonly createdBySessionId: string
  readonly createdAt: string
}

export interface OpenExperimentData extends ExperimentBaseData {
  readonly status: 'open'
}

export interface ReadyExperimentData extends ExperimentBaseData {
  readonly status: 'ready'
  readonly readyAt: string
}

export interface CIPendingExperimentData extends ExperimentBaseData {
  readonly status: 'ci-pending'
  readonly ciRunId: string
  readonly requestedAt: string
}

export interface CIRunningExperimentData extends ExperimentBaseData {
  readonly status: 'ci-running'
  readonly ciRunId: string
  readonly requestedAt: string
  readonly startedAt: string
  readonly environmentDigest: string
}

export interface CIPassedExperimentData extends ExperimentBaseData {
  readonly status: 'ci-passed'
  readonly ciRunId: string
  readonly requestedAt: string
  readonly startedAt: string
  readonly environmentDigest: string
  readonly finishedAt: string
}

export interface CIFailedExperimentData extends ExperimentBaseData {
  readonly status: 'ci-failed'
  readonly ciRunId: string
  readonly requestedAt: string
  readonly startedAt: string | undefined
  readonly environmentDigest: string | undefined
  readonly failureReason: CIFailureReason
  readonly failureDetail: string
  readonly failedAt: string
}

export interface ClosedExperimentData extends ExperimentBaseData {
  readonly status: 'closed'
  readonly closedAt: string
  readonly closeReason: string
  readonly outcome: 'concluded' | 'failed' | 'cancelled'
}

export type ExperimentData =
  | OpenExperimentData
  | ReadyExperimentData
  | CIPendingExperimentData
  | CIRunningExperimentData
  | CIPassedExperimentData
  | CIFailedExperimentData
  | ClosedExperimentData

/** Proof that the Host accepted a CI request for one Experiment and commit. */
export interface CIRequestTokenData {
  readonly ciRunId: string
  readonly experimentId: string
  readonly commit: string
  readonly requestedAt: string
}

/** Proof that one Experiment/commit finished CI successfully. */
export interface PassedCICompletionData {
  readonly ciRunId: string
  readonly record: PassedCIRecordData
}

/** Proof that one Experiment/commit failed CI for a stated reason. */
export interface FailedCICompletionData {
  readonly ciRunId: string
  readonly record: FailedCIRecordData
}

function experimentBase(experiment: ExperimentData): ExperimentBaseData {
  return {
    id: experiment.id,
    programId: experiment.programId,
    issueId: experiment.issueId,
    branch: experiment.branch,
    head: experiment.head,
    environment: experiment.environment,
    lineage: experiment.lineage,
    planCommentId: experiment.planCommentId,
    createdBySessionId: experiment.createdBySessionId,
    createdAt: experiment.createdAt,
  }
}

function bindingMismatch(
  experiment: ExperimentBaseData,
  ticket: TicketData,
  binding: TicketBindingData,
  actorSessionId: string,
): string | undefined {
  if (binding.ticketId !== ticket.id) {
    return 'binding ticket does not match the ticket'
  }
  if (ticket.experimentId !== experiment.id) {
    return 'ticket does not belong to the experiment'
  }
  if (ticket.programId !== experiment.programId || ticket.issueId !== experiment.issueId) {
    return 'ticket and experiment belong to different program or issue'
  }
  if (binding.experimentId !== experiment.id) {
    return 'binding experiment does not match the experiment'
  }
  if (binding.sessionId !== actorSessionId) {
    return 'binding session does not match the acting implementer session'
  }
  return undefined
}

function ticketSession(ticket: TicketData): string | undefined {
  switch (ticket.status) {
    case 'running':
    case 'submitted':
      return ticket.sessionId
    case 'open':
    case 'cancelled':
    case 'failed':
      return undefined
  }
}

export function submitExperiment(
  experiment: ExperimentData,
  ticket: TicketData,
  actorSessionId: string,
  binding: TicketBindingData,
  head: string,
  environment: EnvironmentDeclaration,
  at: string,
): Result<ReadyExperimentData, DomainError> {
  switch (experiment.status) {
    case 'open': {
      if (!isText(head)) {
        return invalidInput('experiment head commit must be non-empty')
      }
      if (!isText(at)) {
        return invalidInput('ready timestamp must be non-empty')
      }
      const mismatch = bindingMismatch(experiment, ticket, binding, actorSessionId)
      if (mismatch !== undefined) {
        return forbidden(mismatch)
      }
      const session = ticketSession(ticket)
      if (session === undefined) {
        return invalidState('the ticket has no implementer session to submit for')
      }
      if (ticket.status === 'submitted' && ticket.head !== head) {
        return invalidState('the submitted ticket head does not match the experiment head')
      }
      return ok({
        ...experimentBase(experiment),
        status: 'ready',
        head,
        environment,
        readyAt: at,
      })
    }
    case 'ready':
    case 'ci-pending':
    case 'ci-running':
    case 'ci-passed':
    case 'ci-failed':
    case 'closed':
      return invalidState('only an open experiment can be submitted for review')
  }
}

export function reviseExperiment(
  experiment: ExperimentData,
  ticket: TicketData,
  actorSessionId: string,
  binding: TicketBindingData,
  head: string,
  environment: EnvironmentDeclaration,
): Result<OpenExperimentData, DomainError> {
  switch (experiment.status) {
    case 'ready':
      return reviseOpen(experiment, ticket, actorSessionId, binding, head, environment)
    case 'ci-failed':
      return reviseOpen(experiment, ticket, actorSessionId, binding, head, environment)
    case 'open':
    case 'ci-pending':
    case 'ci-running':
    case 'ci-passed':
    case 'closed':
      return invalidState('only a ready or failed experiment can be revised')
  }
}

function reviseOpen(
  experiment: ExperimentData,
  ticket: TicketData,
  actorSessionId: string,
  binding: TicketBindingData,
  head: string,
  environment: EnvironmentDeclaration,
): Result<OpenExperimentData, DomainError> {
  if (!isText(head)) {
    return invalidInput('revised head commit must be non-empty')
  }
  const mismatch = bindingMismatch(experiment, ticket, binding, actorSessionId)
  if (mismatch !== undefined) {
    return forbidden(mismatch)
  }
  const session = ticketSession(ticket)
  if (session === undefined) {
    return invalidState('the ticket has no implementer session to revise for')
  }
  return ok({
    ...experimentBase(experiment),
    status: 'open',
    head,
    environment,
  })
}

export function requestExperimentCI(
  experiment: ExperimentData,
  assignment: IssueAssignmentData,
  token: CIRequestTokenData,
): Result<CIPendingExperimentData, DomainError> {
  switch (experiment.status) {
    case 'ready':
      if (assignment.issueId !== experiment.issueId) {
        return forbidden('the assignment token does not belong to the experiment issue')
      }
      if (assignment.assigneeSessionId !== experiment.createdBySessionId) {
        return forbidden('only the researcher who created the experiment may request CI')
      }
      if (token.experimentId !== experiment.id) {
        return forbidden('the CI request token belongs to another experiment')
      }
      if (token.commit !== experiment.head) {
        return forbidden('the CI request token does not match the experiment head')
      }
      return ok({
        ...experimentBase(experiment),
        status: 'ci-pending',
        ciRunId: token.ciRunId,
        requestedAt: token.requestedAt,
      })
    case 'open':
    case 'ci-pending':
    case 'ci-running':
    case 'ci-passed':
    case 'ci-failed':
    case 'closed':
      return invalidState('CI can only be requested for a ready experiment')
  }
}

export function startExperimentCI(
  experiment: ExperimentData,
  environmentDigest: string,
  at: string,
): Result<CIRunningExperimentData, DomainError> {
  switch (experiment.status) {
    case 'ci-pending':
      if (!isText(environmentDigest)) {
        return invalidInput('CI environment digest must be non-empty')
      }
      if (!isText(at)) {
        return invalidInput('CI start timestamp must be non-empty')
      }
      return ok({
        ...experimentBase(experiment),
        status: 'ci-running',
        ciRunId: experiment.ciRunId,
        requestedAt: experiment.requestedAt,
        startedAt: at,
        environmentDigest,
      })
    case 'open':
    case 'ready':
    case 'ci-running':
    case 'ci-passed':
    case 'ci-failed':
    case 'closed':
      return invalidState('CI can only start for a pending experiment')
  }
}

export function passExperimentCI(
  experiment: ExperimentData,
  completion: PassedCICompletionData,
): Result<CIPassedExperimentData, DomainError> {
  switch (experiment.status) {
    case 'ci-running': {
      const evidence = passedEvidenceMismatch(experiment, completion)
      if (evidence !== undefined) {
        return evidence
      }
      return ok({
        ...experimentBase(experiment),
        status: 'ci-passed',
        ciRunId: experiment.ciRunId,
        requestedAt: experiment.requestedAt,
        startedAt: experiment.startedAt,
        environmentDigest: experiment.environmentDigest,
        finishedAt: completion.record.finishedAt,
      })
    }
    case 'open':
    case 'ready':
    case 'ci-pending':
    case 'ci-passed':
    case 'ci-failed':
    case 'closed':
      return invalidState('CI evidence can only be recorded on a running experiment')
  }
}

export function failExperimentCI(
  experiment: ExperimentData,
  completion: FailedCICompletionData,
): Result<CIFailedExperimentData, DomainError> {
  switch (experiment.status) {
    case 'ci-running': {
      const evidence = failedEvidenceMismatch(experiment, completion)
      if (evidence !== undefined) {
        return evidence
      }
      const record = completion.record
      return ok({
        ...experimentBase(experiment),
        status: 'ci-failed',
        ciRunId: experiment.ciRunId,
        requestedAt: experiment.requestedAt,
        startedAt: record.startedAt === undefined ? experiment.startedAt : record.startedAt,
        environmentDigest:
          record.environmentDigest === undefined
            ? experiment.environmentDigest
            : record.environmentDigest,
        failureReason: record.reason,
        failureDetail: record.detail,
        failedAt: record.finishedAt,
      })
    }
    case 'open':
    case 'ready':
    case 'ci-pending':
    case 'ci-passed':
    case 'ci-failed':
    case 'closed':
      return invalidState('CI evidence can only be recorded on a running experiment')
  }
}

function passedEvidenceMismatch(
  experiment: ExperimentData & { readonly status: 'ci-running' },
  completion: PassedCICompletionData,
): Err<DomainError> | undefined {
  if (completion.ciRunId !== experiment.ciRunId) {
    return forbidden('the CI completion token belongs to another run')
  }
  if (completion.record.id !== completion.ciRunId) {
    return invalidState('the completion record does not carry the token run id')
  }
  if (completion.record.status !== 'passed') {
    return invalidState('a passed completion must carry a passed CI record')
  }
  if (completion.record.experimentId !== experiment.id) {
    return invalidState('the CI record belongs to another experiment')
  }
  if (completion.record.commit !== experiment.head) {
    return invalidState('the CI record was produced for another commit')
  }
  if (completion.record.programId !== experiment.programId) {
    return invalidState('the CI record belongs to another program')
  }
  if (completion.record.requestedAt !== experiment.requestedAt) {
    return invalidState('the CI record was requested at another time')
  }
  if (completion.record.startedAt !== experiment.startedAt) {
    return invalidState('the CI record start time does not match the running experiment')
  }
  if (completion.record.environmentDigest !== experiment.environmentDigest) {
    return invalidState('the CI record environment digest does not match the experiment')
  }
  return undefined
}

function failedEvidenceMismatch(
  experiment: ExperimentData & { readonly status: 'ci-running' },
  completion: FailedCICompletionData,
): Err<DomainError> | undefined {
  if (completion.ciRunId !== experiment.ciRunId) {
    return forbidden('the CI completion token belongs to another run')
  }
  if (completion.record.id !== completion.ciRunId) {
    return invalidState('the completion record does not carry the token run id')
  }
  if (completion.record.status !== 'failed') {
    return invalidState('a failed completion must carry a failed CI record')
  }
  if (completion.record.experimentId !== experiment.id) {
    return invalidState('the CI record belongs to another experiment')
  }
  if (completion.record.commit !== experiment.head) {
    return invalidState('the CI record was produced for another commit')
  }
  if (completion.record.programId !== experiment.programId) {
    return invalidState('the CI record belongs to another program')
  }
  if (completion.record.requestedAt !== experiment.requestedAt) {
    return invalidState('the CI record was requested at another time')
  }
  if (
    completion.record.startedAt !== undefined &&
    completion.record.startedAt !== experiment.startedAt
  ) {
    return invalidState('the CI record start time does not match the running experiment')
  }
  if (
    completion.record.environmentDigest !== undefined &&
    completion.record.environmentDigest !== experiment.environmentDigest
  ) {
    return invalidState('the CI record environment digest does not match the experiment')
  }
  return undefined
}

export function cancelExperiment(
  experiment: ExperimentData,
  reason: string,
  at: string,
): Result<ClosedExperimentData, DomainError> {
  switch (experiment.status) {
    case 'open':
    case 'ready':
    case 'ci-pending':
    case 'ci-running':
      if (!isText(reason)) {
        return invalidInput('cancellation reason must be non-empty')
      }
      if (!isText(at)) {
        return invalidInput('cancellation timestamp must be non-empty')
      }
      return ok({
        ...experimentBase(experiment),
        status: 'closed',
        closedAt: at,
        closeReason: reason,
        outcome: 'cancelled',
      })
    case 'ci-passed':
    case 'ci-failed':
    case 'closed':
      return invalidState('only an open, ready, pending or running experiment can be cancelled')
  }
}

export function closeExperiment(
  experiment: ExperimentData,
  assignment: IssueAssignmentData,
  reason: string,
  at: string,
): Result<ClosedExperimentData, DomainError> {
  switch (experiment.status) {
    case 'ci-passed':
      return closeWithOutcome(experiment, assignment, reason, at, 'concluded')
    case 'ci-failed':
      return closeWithOutcome(experiment, assignment, reason, at, 'failed')
    case 'open':
    case 'ready':
    case 'ci-pending':
    case 'ci-running':
    case 'closed':
      return invalidState('only a passed or failed experiment can be closed by a researcher')
  }
}

function closeWithOutcome(
  experiment: ExperimentData,
  assignment: IssueAssignmentData,
  reason: string,
  at: string,
  outcome: 'concluded' | 'failed',
): Result<ClosedExperimentData, DomainError> {
  if (assignment.issueId !== experiment.issueId) {
    return forbidden('the assignment token does not belong to the experiment issue')
  }
  if (assignment.assigneeSessionId !== experiment.createdBySessionId) {
    return forbidden('only the researcher who created the experiment may close it')
  }
  if (!isText(reason)) {
    return invalidInput('close reason must be non-empty')
  }
  if (!isText(at)) {
    return invalidInput('close timestamp must be non-empty')
  }
  return ok({
    ...experimentBase(experiment),
    status: 'closed',
    closedAt: at,
    closeReason: reason,
    outcome,
  })
}

// ---------------------------------------------------------------------------
// CI record transitions
// ---------------------------------------------------------------------------

export interface CIRecordBaseData {
  readonly id: string
  readonly programId: string
  readonly experimentId: string
  readonly commit: string
  readonly requestedBySessionId: string
  readonly requestedAt: string
}

export interface RequestedCIRecordData extends CIRecordBaseData {
  readonly status: 'requested'
}

export interface RunningCIRecordData extends CIRecordBaseData {
  readonly status: 'running'
  readonly startedAt: string
  readonly environmentDigest: string
}

export interface PassedCIRecordData extends CIRecordBaseData {
  readonly status: 'passed'
  readonly startedAt: string
  readonly finishedAt: string
  readonly environmentDigest: string
  readonly metrics: MetricMap
  readonly artifacts: readonly ArtifactRef[]
  readonly durationMs: number
}

export interface FailedCIRecordData extends CIRecordBaseData {
  readonly status: 'failed'
  readonly startedAt: string | undefined
  readonly finishedAt: string
  readonly environmentDigest: string | undefined
  readonly reason: CIFailureReason
  readonly detail: string
  readonly durationMs: number
}

export type CIRecordData =
  | RequestedCIRecordData
  | RunningCIRecordData
  | PassedCIRecordData
  | FailedCIRecordData

/** The result body the Host CI runner collects before the pass transition. */
export interface PassedCIResultData {
  readonly finishedAt: string
  readonly metrics: MetricMap
  readonly artifacts: readonly ArtifactRef[]
  readonly durationMs: number
}

/** The result body the Host CI runner collects before the failure transition. */
export interface FailedCIResultData {
  readonly finishedAt: string
  readonly reason: CIFailureReason
  readonly detail: string
  readonly durationMs: number
  readonly environmentDigest: string | undefined
}

function ciRecordBase(record: CIRecordData): CIRecordBaseData {
  return {
    id: record.id,
    programId: record.programId,
    experimentId: record.experimentId,
    commit: record.commit,
    requestedBySessionId: record.requestedBySessionId,
    requestedAt: record.requestedAt,
  }
}

export function requestCIRecord(
  experiment: CIPendingExperimentData,
  token: CIRequestTokenData,
): Result<RequestedCIRecordData, DomainError> {
  if (token.experimentId !== experiment.id) {
    return forbidden('the CI request token belongs to another experiment')
  }
  if (token.commit !== experiment.head) {
    return forbidden('the CI request token does not match the experiment head')
  }
  if (token.ciRunId !== experiment.ciRunId) {
    return invalidState('the CI request token does not carry the pending run id')
  }
  if (token.requestedAt !== experiment.requestedAt) {
    return invalidState('the CI request token was minted at another time')
  }
  return ok({
    id: experiment.ciRunId,
    programId: experiment.programId,
    experimentId: experiment.id,
    commit: experiment.head,
    requestedBySessionId: experiment.createdBySessionId,
    requestedAt: experiment.requestedAt,
    status: 'requested',
  })
}

export function startCIRecord(
  record: CIRecordData,
  startedAt: string,
  environmentDigest: string,
): Result<RunningCIRecordData, DomainError> {
  switch (record.status) {
    case 'requested':
      if (!isText(startedAt)) {
        return invalidInput('CI start timestamp must be non-empty')
      }
      if (!isText(environmentDigest)) {
        return invalidInput('CI environment digest must be non-empty')
      }
      return ok({
        ...ciRecordBase(record),
        status: 'running',
        startedAt,
        environmentDigest,
      })
    case 'running':
    case 'passed':
    case 'failed':
      return invalidState('only a requested CI record can start')
  }
}

export function passCIRecord(
  record: CIRecordData,
  result: PassedCIResultData,
  requiredMetrics: readonly string[],
): Result<PassedCIRecordData, DomainError> {
  switch (record.status) {
    case 'running': {
      const invalid = passedResultInvalid(result, requiredMetrics)
      if (invalid !== undefined) {
        return invalid
      }
      return ok({
        ...ciRecordBase(record),
        status: 'passed',
        startedAt: record.startedAt,
        finishedAt: result.finishedAt,
        environmentDigest: record.environmentDigest,
        metrics: result.metrics,
        artifacts: result.artifacts,
        durationMs: result.durationMs,
      })
    }
    case 'requested':
    case 'passed':
    case 'failed':
      return invalidState('only a running CI record can pass')
  }
}

export function failCIRecord(
  record: CIRecordData,
  result: FailedCIResultData,
): Result<FailedCIRecordData, DomainError> {
  switch (record.status) {
    case 'requested':
      return failedRecord(record, result, undefined)
    case 'running':
      return failedRecord(record, result, record.startedAt)
    case 'passed':
    case 'failed':
      return invalidState('a finished CI record cannot fail again')
  }
}

export function cancelCIRecord(
  record: CIRecordData,
  finishedAt: string,
  durationMs: number,
): Result<FailedCIRecordData, DomainError> {
  switch (record.status) {
    case 'requested':
      return cancelledRecord(record, finishedAt, durationMs, undefined)
    case 'running':
      return cancelledRecord(record, finishedAt, durationMs, record.startedAt)
    case 'passed':
    case 'failed':
      return invalidState('a finished CI record cannot be cancelled')
  }
}

function passedResultInvalid(
  result: PassedCIResultData,
  requiredMetrics: readonly string[],
): Err<DomainError> | undefined {
  if (!isText(result.finishedAt)) {
    return invalidInput('CI finish timestamp must be non-empty')
  }
  if (!isNonNegativeFinite(result.durationMs)) {
    return invalidInput('CI duration must be a finite non-negative number')
  }
  if (!metricsAreFinite(result.metrics)) {
    return invalidInput('CI metrics must be finite numbers')
  }
  for (const name of requiredMetrics) {
    if (!Object.hasOwn(result.metrics, name)) {
      return invalidInput(`CI result is missing the required metric ${name}`)
    }
  }
  return undefined
}

function failedRecord(
  record: RequestedCIRecordData | RunningCIRecordData,
  result: FailedCIResultData,
  startedAt: string | undefined,
): Result<FailedCIRecordData, DomainError> {
  if (!isText(result.finishedAt)) {
    return invalidInput('CI finish timestamp must be non-empty')
  }
  if (!isNonNegativeFinite(result.durationMs)) {
    return invalidInput('CI duration must be a finite non-negative number')
  }
  if (!isText(result.detail)) {
    return invalidInput('CI failure detail must be non-empty')
  }
  const fallbackStartedAt = record.status === 'running' ? record.startedAt : undefined
  const fallbackDigest = record.status === 'running' ? record.environmentDigest : undefined
  return ok({
    ...ciRecordBase(record),
    status: 'failed',
    startedAt: startedAt === undefined ? fallbackStartedAt : startedAt,
    finishedAt: result.finishedAt,
    environmentDigest:
      result.environmentDigest === undefined ? fallbackDigest : result.environmentDigest,
    reason: result.reason,
    detail: result.detail,
    durationMs: result.durationMs,
  })
}

function cancelledRecord(
  record: RequestedCIRecordData | RunningCIRecordData,
  finishedAt: string,
  durationMs: number,
  startedAt: string | undefined,
): Result<FailedCIRecordData, DomainError> {
  if (!isText(finishedAt)) {
    return invalidInput('CI cancellation timestamp must be non-empty')
  }
  if (!isNonNegativeFinite(durationMs)) {
    return invalidInput('CI duration must be a finite non-negative number')
  }
  const fallbackStartedAt = record.status === 'running' ? record.startedAt : undefined
  const fallbackDigest = record.status === 'running' ? record.environmentDigest : undefined
  return ok({
    ...ciRecordBase(record),
    status: 'failed',
    startedAt: startedAt === undefined ? fallbackStartedAt : startedAt,
    finishedAt,
    environmentDigest: fallbackDigest,
    reason: 'cancelled',
    detail: 'the CI run was cancelled by the host',
    durationMs,
  })
}

function metricsAreFinite(metrics: MetricMap): boolean {
  for (const value of Object.values(metrics)) {
    if (!Number.isFinite(value)) {
      return false
    }
  }
  return true
}

// `DomainErrorCode` is imported so the file fails to compile if the error union loses a
// code that the refusal helpers rely on; no value of this type is constructed here.
export type RefusalCode = DomainErrorCode
