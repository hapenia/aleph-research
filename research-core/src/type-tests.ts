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
  CommandContext,
  CommandExecutor,
  UserCommand,
  CommandOf,
  Decision,
  DerivedLineage,
  DomainFailure,
  FreshLineage,
  HostPrincipal,
  ImplementerPrincipal,
  ImplementerTools,
  IssueId,
  IssueRepository,
  OpenIssue,
  OperatorPrincipal,
  PausedProgram,
  ProgramId,
  ResearcherPrincipal,
  RunningProgram,
  StoppedProgram,
  ToolDefinition,
  NonEmptyString,
  IsoTimestamp,
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
declare const programId: ProgramId
declare const issueId: IssueId
declare const issues: IssueRepository
declare const executor: CommandExecutor
declare const pauseCommand: CommandOf<'program.pause'>
declare const at: IsoTimestamp
declare const requestId: string

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

// Transitions return exactly one target variant.
const failedRun: CIFailedExperiment = runningCI.failCI(host, 'entry-failed', 'boom' as NonEmptyString, at)
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

// A decision always carries audit entries.
// @ts-expect-error audit is a non-empty array
const emptyDecision: Decision<RunningProgram> = { value: running, audit: [] }

// Implementer tool input omits Host-injected fields.
declare const fullSubmitTool: ToolDefinition<CommandOf<'ticket.submit'>, OpenIssue>
declare const implementerTools: ImplementerTools
// @ts-expect-error the tool input must not include ticketId/experimentId
const wrongSubmitTool: ImplementerTools['submitImplementation'] = fullSubmitTool

// Lineage variants are nominal.
declare const freshLineage: FreshLineage
declare const derivedLineage: DerivedLineage
// @ts-expect-error a fresh lineage is not a derived lineage
const wrongLineage: DerivedLineage = freshLineage
// @ts-expect-error a derived lineage is not a fresh lineage
const wrongLineage2: FreshLineage = derivedLineage

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
  emptyDecision,
  wrongSubmitTool,
  wrongLineage,
  wrongLineage2,
}
