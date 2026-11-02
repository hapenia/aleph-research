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
  ReadyExperiment,
  AssignedIssue,
  IssueAssignment,
  CIPendingExperiment,
  TriggerReportFor,
  CIRequestToken,
  ApiWriteRoutes,
  SubmittedTicket,
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

// Transitions that check ownership return Result; the state itself is not the outcome.
declare const readyExperiment: ReadyExperiment
declare const ciRequestToken: CIRequestToken
// @ts-expect-error requestCI returns a Result, not a bare pending Experiment
const barePending: CIPendingExperiment = readyExperiment.requestCI(issueAssignment, ciRequestToken, at)
const ownershipChecked: import('./types/errors.js').Result<CIPendingExperiment, import('./types/errors.js').DomainError> =
  readyExperiment.requestCI(issueAssignment, ciRequestToken, at)

// Closing a passed Experiment needs the ownership token, not a principal.
declare const passedExperiment: CIPassedExperiment
// @ts-expect-error a Researcher principal is not an ownership token
passedExperiment.close(someResearcher, 'done' as NonEmptyString, at)

// Refusal audit is the command.refused fact, not the successful action.
// @ts-expect-error a refusal cannot cite the successful pause entry
const wrongRefusalAudit: CommandOutcome<'program.pause'> = {
  ok: false,
  error: { code: 'invalid-state', message: 'x' as NonEmptyString },
  audit: [pauseAudit],
}

// The trigger kind follows literally from the action.
declare const passedTrigger: TriggerReportFor<'ci.passed'>
const passedTriggerKind: 'ci-passed' = passedTrigger.kind

// A write route only parses; it cannot return an outcome without the executor.
declare const writeRoutes: ApiWriteRoutes
const parsedCIRequest: import('./types/errors.js').Result<
  import('./types/commands.js').CommandOf<'ci.request'>,
  import('./types/errors.js').DomainError
> = writeRoutes['ci.request']({})

// Ticket fields are discriminated by status.
declare const submittedTicket: SubmittedTicket
const submittedHead: import('./types/ids.js').CommitSha = submittedTicket.head

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

// ---------------------------------------------------------------------------------------
// Appended coverage for the mutation harness's known survivors. Keep new tests below the
// existing ones: mutation expectations are anchored to line numbers above this block.
// ---------------------------------------------------------------------------------------

type AuditActionName = import('./types/audit.js').AuditAction
type TriggerKindTable = import('./types/triggers.js').TriggerKindForAction
type AllCommandTypes = import('./types/commands.js').CommandType
type CapabilityTable = import('./types/commands.js').CapabilityForCommand
type CommandAuditTable = import('./types/commands.js').CommandAuditMap

// Host-injected ownership proofs are required command fields.
declare const proposeWithoutAssignment: Omit<CommandOf<'experiment.propose'>, 'assignment'>
// @ts-expect-error a propose command must carry the Host-minted IssueAssignment
const invalidProposeCommand: CommandOf<'experiment.propose'> = proposeWithoutAssignment
declare const reviewWithoutAssignment: Omit<CommandOf<'experiment.review'>, 'assignment'>
// @ts-expect-error a review command must carry the Host-minted IssueAssignment
const invalidReviewCommand: CommandOf<'experiment.review'> = reviewWithoutAssignment
declare const closeWithoutAssignment: Omit<CommandOf<'experiment.close'>, 'assignment'>
// @ts-expect-error a close command must carry the Host-minted IssueAssignment
const invalidCloseCommand: CommandOf<'experiment.close'> = closeWithoutAssignment
declare const submitWithoutBinding: Omit<CommandOf<'ticket.submit'>, 'binding'>
// @ts-expect-error a submit command must carry the Host-minted TicketBinding
const invalidSubmitCommand: CommandOf<'ticket.submit'> = submitWithoutBinding

// Every trigger action pins its own literal kind.
const expectedTriggerKinds: { readonly [A in AuditActionName]: TriggerKindTable[A] } = {
  'program.created': 'program-created',
  'program.paused': 'program-paused',
  'program.resumed': 'program-resumed',
  'program.stopped': 'program-stopped',
  'program.budget-paused': 'program-budget-paused',
  'program.goal-changed': 'program-goal-changed',
  'program.methodology-changed': 'program-methodology-changed',
  'program.exploration-changed': 'program-exploration-changed',
  'program.completed': 'program-completed',
  'usage.recorded': 'usage-recorded',
  'issue.created': 'issue-created',
  'issue.claimed': 'issue-claimed',
  'issue.commented': 'issue-commented',
  'issue.closed': 'issue-closed',
  'experiment.proposed': 'experiment-proposed',
  'experiment.opened': 'experiment-opened',
  'experiment.revised': 'experiment-revised',
  'experiment.ready': 'experiment-ready',
  'experiment.reviewed': 'experiment-reviewed',
  'experiment.closed': 'experiment-closed',
  'experiment.cancelled': 'experiment-cancelled',
  'ci.requested': 'ci-requested',
  'ci.started': 'ci-started',
  'ci.passed': 'ci-passed',
  'ci.failed': 'ci-failed',
  'artifact.stored': 'artifact-stored',
  'attention.raised': 'attention-raised',
  'command.refused': null,
}

// Every command pins its own capability and audit action.
const expectedCapabilities: { readonly [K in AllCommandTypes]: CapabilityTable[K] } = {
  'program.create': 'program:create',
  'program.pause': 'program:pause',
  'program.resume': 'program:pause',
  'program.stop': 'program:stop',
  'program.set-goal': 'program:goal',
  'program.set-methodology': 'program:goal',
  'program.set-exploration': 'program:exploration',
  'issue.create': 'issue:create',
  'issue.claim': 'issue:claim',
  'issue.comment': 'issue:comment',
  'issue.close': 'issue:close',
  'experiment.propose': 'experiment:propose',
  'experiment.review': 'experiment:review',
  'experiment.close': 'issue:close',
  'ci.request': 'ci:request',
  'ticket.submit': 'ticket:submit',
}

const expectedAuditActions: { readonly [K in AllCommandTypes]: CommandAuditTable[K] } = {
  'program.create': 'program.created',
  'program.pause': 'program.paused',
  'program.resume': 'program.resumed',
  'program.stop': 'program.stopped',
  'program.set-goal': 'program.goal-changed',
  'program.set-methodology': 'program.methodology-changed',
  'program.set-exploration': 'program.exploration-changed',
  'issue.create': 'issue.created',
  'issue.claim': 'issue.claimed',
  'issue.comment': 'issue.commented',
  'issue.close': 'issue.closed',
  'experiment.propose': 'experiment.proposed',
  'experiment.review': 'experiment.reviewed',
  'experiment.close': 'experiment.closed',
  'ci.request': 'ci.requested',
  'ticket.submit': 'experiment.ready',
}

export {
  invalidProposeCommand,
  invalidReviewCommand,
  invalidCloseCommand,
  invalidSubmitCommand,
  expectedTriggerKinds,
  expectedCapabilities,
  expectedAuditActions,
}

// ---------------------------------------------------------------------------------------
// Typed pipeline chain: a stage cannot accept the evidence of an earlier stage.
// ---------------------------------------------------------------------------------------
declare const researchPipeline: import('./pipeline.js').ResearchPipeline
declare const proposedEvidence: import('./pipeline.js').ExperimentProposedEvidence
// @ts-expect-error triggerToTicket requires TriggerAcceptedEvidence, not ExperimentProposedEvidence
researchPipeline.triggerToTicket.run(proposedEvidence)
declare const acceptedEvidence: import('./pipeline.js').TriggerAcceptedEvidence
// @ts-expect-error ticketToWorker requires TicketCreatedEvidence
researchPipeline.ticketToWorker.run(acceptedEvidence)
