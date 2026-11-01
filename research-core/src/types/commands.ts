/**
 * User commands. Payloads are data; who may issue them is fixed at compile time by
 * CapabilityForCommand and ActorForCommand, and the result type by CommandResultMap.
 */
import type {
  ImplementerPrincipal,
  IssueAssignment,
  OperatorPrincipal,
  ResearcherPrincipal,
  TicketBinding,
} from './actors.js'
import type {
  CommitSha,
  DurationMs,
  ExperimentId,
  IssueId,
  NonEmptyArray,
  NonEmptyString,
  PositiveInt,
  ProgramId,
  TicketId,
} from './ids.js'
import type { Budget, EvaluationContract, ExplorationLevel, UtilityConfig } from './program.js'
import type { EnvironmentDeclaration } from './environment.js'
import type { IssueLabel, IssueResolution, IssueComment } from './issue.js'
import type {
  ClosedExperiment,
  CIPendingExperiment,
  ExperimentPlan,
  ExperimentReview,
  OpenExperiment,
  ReadyExperiment,
} from './experiment.js'
import type { AuditAction, AuditEntry, AuditEntryOf } from './audit.js'
import type { DomainError } from './errors.js'
import type { Capability } from './actors.js'
import type { AssignedIssue, ClosedIssue, OpenIssue } from './issue.js'
import type { PausedProgram, RunningProgram, StoppedProgram } from './program.js'

export interface CreateProgramCommand {
  readonly type: 'program.create'
  readonly name: NonEmptyString
  readonly goal: NonEmptyString
  readonly methodology: NonEmptyString
  readonly contract: EvaluationContract
  readonly utility: UtilityConfig
  readonly exploration: ExplorationLevel
  readonly budget: Budget
}

export interface PauseProgramCommand { readonly type: 'program.pause'; readonly programId: ProgramId }
export interface ResumeProgramCommand { readonly type: 'program.resume'; readonly programId: ProgramId }
export interface StopProgramCommand {
  readonly type: 'program.stop'
  readonly programId: ProgramId
  readonly reason: NonEmptyString
}
export interface SetGoalCommand {
  readonly type: 'program.set-goal'
  readonly programId: ProgramId
  readonly goal: NonEmptyString
}
export interface SetMethodologyCommand {
  readonly type: 'program.set-methodology'
  readonly programId: ProgramId
  readonly methodology: NonEmptyString
}
export interface SetExplorationCommand {
  readonly type: 'program.set-exploration'
  readonly programId: ProgramId
  readonly level: ExplorationLevel
}
export interface CreateIssueCommand {
  readonly type: 'issue.create'
  readonly programId: ProgramId
  readonly title: NonEmptyString
  readonly body: NonEmptyString
  readonly labels: NonEmptyArray<IssueLabel>
}
export interface ClaimIssueCommand {
  readonly type: 'issue.claim'
  readonly programId: ProgramId
  readonly issueId: IssueId
}
export interface CommentOnIssueCommand {
  readonly type: 'issue.comment'
  readonly programId: ProgramId
  readonly issueId: IssueId
  readonly body: NonEmptyString
  readonly kind: 'comment' | 'plan'
}
export interface CloseIssueCommand {
  readonly type: 'issue.close'
  readonly programId: ProgramId
  readonly issueId: IssueId
  readonly resolution: IssueResolution
  readonly summary: NonEmptyString
}
export interface ProposeExperimentCommand {
  readonly type: 'experiment.propose'
  readonly programId: ProgramId
  readonly issueId: IssueId
  /** Host-injected ownership proof; the tool input omits it. */
  readonly assignment: IssueAssignment
  readonly plan: ExperimentPlan
}
export interface ReviewExperimentCommand {
  readonly type: 'experiment.review'
  readonly programId: ProgramId
  readonly experimentId: ExperimentId
  /** Host-injected ownership proof; the tool input omits it. */
  readonly assignment: IssueAssignment
  readonly body: NonEmptyString
  readonly verdict: 'approve' | 'request-changes' | 'comment'
}
export interface CloseExperimentCommand {
  readonly type: 'experiment.close'
  readonly programId: ProgramId
  readonly experimentId: ExperimentId
  /** Host-injected ownership proof; the tool input omits it. */
  readonly assignment: IssueAssignment
  readonly reason: NonEmptyString
}
export interface RequestCICommand {
  readonly type: 'ci.request'
  readonly programId: ProgramId
  readonly experimentId: ExperimentId
}
/** The Host injects the TicketBinding; the model only supplies the submission. */
export interface SubmitImplementationCommand {
  readonly type: 'ticket.submit'
  readonly binding: TicketBinding
  readonly head: CommitSha
  readonly environment: EnvironmentDeclaration
}

export type OperatorCommand =
  | CreateProgramCommand
  | PauseProgramCommand
  | ResumeProgramCommand
  | StopProgramCommand
  | SetGoalCommand
  | SetMethodologyCommand
  | SetExplorationCommand
  | CreateIssueCommand

export type ResearcherCommand =
  | ClaimIssueCommand
  | CommentOnIssueCommand
  | CloseIssueCommand
  | ProposeExperimentCommand
  | ReviewExperimentCommand
  | CloseExperimentCommand
  | RequestCICommand
  | CreateIssueCommand

export type ImplementerCommand = SubmitImplementationCommand
export type UserCommand = OperatorCommand | ResearcherCommand | ImplementerCommand
export type CommandType = UserCommand['type']
export type CommandOf<T extends CommandType> = Extract<UserCommand, { readonly type: T }>

/** Compile-time relation between a user command and its audit action. */
export type CommandAuditMap = {
  readonly 'program.create': 'program.created'
  readonly 'program.pause': 'program.paused'
  readonly 'program.resume': 'program.resumed'
  readonly 'program.stop': 'program.stopped'
  readonly 'program.set-goal': 'program.goal-changed'
  readonly 'program.set-methodology': 'program.methodology-changed'
  readonly 'program.set-exploration': 'program.exploration-changed'
  readonly 'issue.create': 'issue.created'
  readonly 'issue.claim': 'issue.claimed'
  readonly 'issue.comment': 'issue.commented'
  readonly 'issue.close': 'issue.closed'
  readonly 'experiment.propose': 'experiment.proposed'
  readonly 'experiment.review': 'experiment.reviewed'
  readonly 'experiment.close': 'experiment.closed'
  readonly 'ci.request': 'ci.requested'
  readonly 'ticket.submit': 'experiment.ready'
}

export type AuditActionOf<T extends CommandType> = CommandAuditMap[T]

/** Compile-time capability per command. */
export type CapabilityForCommand = {
  readonly 'program.create': 'program:create'
  readonly 'program.pause': 'program:pause'
  readonly 'program.resume': 'program:pause'
  readonly 'program.stop': 'program:stop'
  readonly 'program.set-goal': 'program:goal'
  readonly 'program.set-methodology': 'program:goal'
  readonly 'program.set-exploration': 'program:exploration'
  readonly 'issue.create': 'issue:create'
  readonly 'issue.claim': 'issue:claim'
  readonly 'issue.comment': 'issue:comment'
  readonly 'issue.close': 'issue:close'
  readonly 'experiment.propose': 'experiment:propose'
  readonly 'experiment.review': 'experiment:review'
  readonly 'experiment.close': 'issue:close'
  readonly 'ci.request': 'ci:request'
  readonly 'ticket.submit': 'ticket:submit'
}

export type CapabilityOfCommand<T extends CommandType> = T extends keyof CapabilityForCommand
  ? CapabilityForCommand[T]
  : never

/** The principal that may issue each command; host-only work is not a user command. */
export type ActorForCommand = {
  readonly 'program.create': OperatorPrincipal
  readonly 'program.pause': OperatorPrincipal
  readonly 'program.resume': OperatorPrincipal
  readonly 'program.stop': OperatorPrincipal
  readonly 'program.set-goal': OperatorPrincipal
  readonly 'program.set-methodology': OperatorPrincipal
  readonly 'program.set-exploration': OperatorPrincipal
  readonly 'issue.create': OperatorPrincipal | ResearcherPrincipal
  readonly 'issue.claim': ResearcherPrincipal
  readonly 'issue.comment': OperatorPrincipal | ResearcherPrincipal
  readonly 'issue.close': ResearcherPrincipal
  readonly 'experiment.propose': ResearcherPrincipal
  readonly 'experiment.review': ResearcherPrincipal
  readonly 'experiment.close': ResearcherPrincipal
  readonly 'ci.request': ResearcherPrincipal
  readonly 'ticket.submit': ImplementerPrincipal
}

export type ActorOfCommand<T extends CommandType> = ActorForCommand[T]

/** The value a successfully executed command produces. */
export type CommandResultMap = {
  readonly 'program.create': RunningProgram
  readonly 'program.pause': PausedProgram
  readonly 'program.resume': RunningProgram
  readonly 'program.stop': StoppedProgram
  readonly 'program.set-goal': RunningProgram
  readonly 'program.set-methodology': RunningProgram
  readonly 'program.set-exploration': RunningProgram
  readonly 'issue.create': OpenIssue
  readonly 'issue.claim': AssignedIssue
  readonly 'issue.comment': IssueComment
  readonly 'issue.close': ClosedIssue
  readonly 'experiment.propose': OpenExperiment
  readonly 'experiment.review': ExperimentReview
  readonly 'experiment.close': ClosedExperiment
  readonly 'ci.request': CIPendingExperiment
  readonly 'ticket.submit': ReadyExperiment
}

export type CommandResult<T extends CommandType> = CommandResultMap[T]

export interface CommandContext<K extends CommandType> {
  readonly actor: ActorOfCommand<K>
  readonly at: import('./ids.js').IsoTimestamp
  readonly requestId: import('./ids.js').RequestId
}

/**
 * The outcome of one command: both the accepted and the refused path carry the audit
 * entries that explain the decision, so a refusal cannot be silent.
 */
export type CommandOutcome<K extends CommandType> =
  | {
      readonly ok: true
      readonly value: CommandResult<K>
      readonly audit: NonEmptyArray<AuditEntryOf<AuditActionOf<K>>>
    }
  | {
      readonly ok: false
      readonly error: DomainError
      /** Refusals are audited as a `command.refused` fact, not as a successful action. */
      readonly audit: NonEmptyArray<AuditEntryOf<'command.refused'>>
    }


/** Re-exported capability union for tool registration checks. */
export type { Capability }
