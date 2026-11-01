/**
 * Compile-time tests for the guarantees the blueprint claims. Each `@ts-expect-error`
 * is a negative test: if the type system becomes more permissive (or the test stops
 * covering the claim), `tsc` fails with "unused '@ts-expect-error' directive".
 */
import type {
  AuditEntry,
  CIPassedExperiment,
  CIRunningExperiment,
  CIFailedExperiment,
  FailedCICompletion,
  CommandContext,
  CommandExecutor,
  CommandOutcome,
  CapabilityOfCommand,
  AuditEntryOf,
  UserCommand,
  CommandOf,
  DerivedLineage,
  DomainFailure,
  FreshLineage,
  HostPrincipal,
  ImplementerPrincipal,
  IssueId,
  IssueRepository,
  OpenIssue,
  AssignedIssue,
  IssueAssignment,
  CIPendingExperiment,
  CompletedProgram,
  ExperimentId,
  OperatorPrincipal,
  PausedProgram,
  ProgramId,
  ResearcherPrincipal,
  RunningProgram,
  StoppedProgram,
  NonEmptyString,
  IsoTimestamp,
  RequestId,
  IssueComment,
} from './types/index.js'

declare const running: RunningProgram
declare const paused: PausedProgram
declare const openIssue: OpenIssue
declare const researcher: ResearcherPrincipal
declare const operator: OperatorPrincipal
declare const implementer: ImplementerPrincipal
declare const host: HostPrincipal
declare const runningCI: CIRunningExperiment
declare const failedCompletion: FailedCICompletion
declare const programId: ProgramId
declare const issueId: IssueId
declare const issues: IssueRepository
declare const executor: CommandExecutor
declare const pauseCommand: CommandOf<'program.pause'>
declare const at: IsoTimestamp
declare const requestId: RequestId

// Structural width cannot forge a nominal Program variant.
// @ts-expect-error a spread object lacks the private brand of RunningProgram
const forgedRunning: RunningProgram = { ...running, stopReason: 'operator' }

// The lookalike attack: a spread that changes the status and supplies the status fields
// has every field of StoppedProgram and would compile if the private brand were removed.
// @ts-expect-error the private brand of StoppedProgram is missing
const lookalikeStopped: StoppedProgram = {
  ...running,
  status: 'stopped',
  stoppedAt: at,
  stopReason: 'budget' as NonEmptyString,
}

// Variants do not convert into each other.
// @ts-expect-error a paused Program is not a running Program
const wrongProgramState: RunningProgram = paused
// @ts-expect-error a stopped Program has fields a running one cannot carry
const wrongStop: StoppedProgram = { ...running, stoppedAt: at }

// Transitions return exactly one target variant (inside a Result because ownership and
// completion association are runtime checks).
const failedTransition = runningCI.failCI(host, failedCompletion, at)
declare const failedRun: CIFailedExperiment
// @ts-expect-error a failed CI experiment is not a passed one
const passedFromFailure: CIPassedExperiment = failedRun
// @ts-expect-error a failed CI experiment is not an open one
const openFromFailure: OpenIssue = failedRun

// The executor has one method per command; a widened command cannot be passed.
declare const widenedCommand: UserCommand
// @ts-expect-error a widened user command is not a program.pause payload
executor['program.pause'](widenedCommand, { actor: operator, at, requestId })
// @ts-expect-error a Researcher cannot execute an operator-only command
executor['program.pause'](pauseCommand, { actor: researcher, at, requestId })
// @ts-expect-error the host principal cannot execute a user command
executor['program.pause'](pauseCommand, { actor: host, at, requestId })
// accepted: an operator may pause with the exact command
executor['program.pause'](pauseCommand, { actor: operator, at, requestId })

// Storage ids are nominal.
// @ts-expect-error a ProgramId is not an IssueId
issues.get(programId)
// @ts-expect-error a ProgramId is not an IssueId (assignee query)
issues.listAssignedTo(programId)

// The HTTP failure body is inhabitable and status follows from the code.
const validFailure: DomainFailure = {
  ok: false,
  status: 404,
  error: { code: 'not-found', message: 'missing' as NonEmptyString },
}
// @ts-expect-error conflict must map to status 409, not 404
const wrongFailureStatus: DomainFailure = {
  ok: false,
  status: 404,
  error: { code: 'conflict', message: 'x' as NonEmptyString },
}

// Audit actor follows from the action.
// @ts-expect-error issue.claimed can only be recorded by a researcher
const wrongAuditActor: AuditEntry = {
  id: 'a' as never,
  at,
  programId,
  action: 'issue.claimed',
  subject: { kind: 'issue', id: issueId },
  actor: host,
  detail: {},
}

// A command outcome always carries audit entries, on both branches.
// @ts-expect-error success audit is a non-empty array
const emptySuccess: CommandOutcome<'program.pause'> = { ok: true, value: paused, audit: [] }
// @ts-expect-error a refusal must be audited too
const emptyFailure: CommandOutcome<'program.pause'> = { ok: false, error: { code: 'invalid-state', message: 'x' as NonEmptyString }, audit: [] }
declare const issueCreatedAudit: AuditEntryOf<'issue.created'>
// @ts-expect-error a program.pause outcome must carry program.paused audit entries
const wrongOutcomeAudit: CommandOutcome<'program.pause'> = { ok: true, value: paused, audit: [issueCreatedAudit] }
declare const pauseAudit: AuditEntryOf<'program.paused'>
const correctOutcome: CommandOutcome<'program.pause'> = { ok: true, value: paused, audit: [pauseAudit] }

// Lineage variants are nominal.
declare const freshLineage: FreshLineage
declare const derivedLineage: DerivedLineage
// @ts-expect-error a fresh lineage is not a derived lineage
const wrongLineage: DerivedLineage = freshLineage
// @ts-expect-error a derived lineage is not a fresh lineage
const wrongLineage2: FreshLineage = derivedLineage

// The capability map is load-bearing: a command must map to its capability.
declare const pauseCapability: CapabilityOfCommand<'program.pause'>
const expectedPauseCapability: 'program:pause' = pauseCapability

// Ownership tokens cannot be replaced by principals.
declare const assignedIssue: AssignedIssue
declare const issueAssignment: IssueAssignment
declare const someResearcher: ResearcherPrincipal
declare const someExperimentId: ExperimentId
// @ts-expect-error a principal is not an ownership token
assignedIssue.addExperiment(someResearcher, someExperimentId, at)
assignedIssue.addExperiment(issueAssignment, someExperimentId, at)

// Cancellation is Host-only.
declare const pendingExperiment: CIPendingExperiment
// @ts-expect-error a Researcher cannot cancel pending CI
pendingExperiment.cancel(someResearcher, at)
pendingExperiment.cancel(host, at)

// A completed Program has no transitions left.
declare const completedProgram: CompletedProgram
// @ts-expect-error a completed Program cannot be paused
completedProgram.pause(operator, at)

export {
  forgedRunning,
  lookalikeStopped,
  widenedCommand,
  wrongProgramState,
  wrongStop,
  failedRun,
  passedFromFailure,
  openFromFailure,
  validFailure,
  wrongFailureStatus,
  wrongAuditActor,
  emptySuccess,
  emptyFailure,
  wrongOutcomeAudit,
  correctOutcome,
  wrongLineage,
  wrongLineage2,
}
