/** Commands: the only way to change a Program; each role may issue a subset. */
import type { Budget, EvaluationContract } from './program.js'
import type { IssueLabel } from './issue.js'

import type { EnvironmentDeclaration } from './environment.js'
import type { AuditEntry } from './audit.js'
import type { CommitSha, IssueId, ProgramId, ExperimentId, TicketId } from './ids.js'

/** What the operator creates; the only command that carries the whole contract. */
export interface CreateProgramCommand {
  readonly type: 'program.create'
  readonly name: string
  readonly goal: string
  readonly contract: EvaluationContract
  readonly budget: Budget
}

export interface PauseProgramCommand {
  readonly type: 'program.pause'
  readonly programId: ProgramId
}

export interface StopProgramCommand {
  readonly type: 'program.stop'
  readonly programId: ProgramId
  readonly reason: string
}

export interface CreateIssueCommand {
  readonly type: 'issue.create'
  readonly programId: ProgramId
  readonly title: string
  readonly body: string
  readonly labels: readonly IssueLabel[]
}

/** The claiming Researcher is the Session in the decision context, not a command field. */
export interface ClaimIssueCommand {
  readonly type: 'issue.claim'
  readonly programId: ProgramId
  readonly issueId: IssueId
}

export interface CommentOnIssueCommand {
  readonly type: 'issue.comment'
  readonly programId: ProgramId
  readonly issueId: IssueId
  readonly body: string
}

/** The Researcher's experiment plan; the Host turns it into an Implementer Ticket. */
export interface ProposeExperimentCommand {
  readonly type: 'experiment.propose'
  readonly programId: ProgramId
  readonly issueId: IssueId
  readonly plan: ExperimentPlan
}

/** A typed reference to a stored artifact; the Host mounts it into the ticket. */
export interface ArtifactInputRef {
  readonly artifactId: string
  readonly mountAs: string
}

export interface ExperimentPlan {
  readonly hypothesis: string
  readonly steps: readonly string[]
  /** Earlier artifacts this Experiment consumes, such as the best model weights. */
  readonly inputs?: readonly ArtifactInputRef[]
  /** What would count as success when CI reports, before seeing the score. */
  readonly expected: {
    readonly direction: 'higher' | 'lower'
    readonly minDelta?: number
    readonly rationale: string
  }
  readonly environment: EnvironmentDeclaration
}

/** Host-internal: opens the Experiment after assigning lineage from the exploration quota. */
export interface HostOpenExperimentCommand {
  readonly type: 'experiment.open'
  readonly programId: ProgramId
  readonly issueId: IssueId
  readonly plan: ExperimentPlan
  readonly lineage: {
    readonly base: 'best' | 'mainline'
    readonly baseCommit: CommitSha
    readonly strategy: 'exploit' | 'explore'
  }
}

export interface RequestCICommand {
  readonly type: 'ci.request'
  readonly programId: ProgramId
  readonly experimentId: ExperimentId
  readonly commit: CommitSha
}

export interface CloseIssueCommand {
  readonly type: 'issue.close'
  readonly programId: ProgramId
  readonly issueId: IssueId
  readonly resolution: 'accepted' | 'rejected' | 'abandoned'
  readonly summary: string
}

/** Implementer submits the Ticket for CI; no score is claimed here. */
export interface SubmitImplementationCommand {
  readonly type: 'implementation.submit'
  readonly ticketId: TicketId
  readonly branch: string
  readonly head: CommitSha
  readonly environment: EnvironmentDeclaration
}

/** Host-internal commands; only the Host's effects may issue them. */
export type HostCommand =
  | HostOpenExperimentCommand
  | { readonly type: 'ci.start'; readonly ciRunId: string }
  | { readonly type: 'ci.finish'; readonly ciRunId: string }

export interface SetExplorationCommand {
  readonly type: 'program.set-exploration'
  readonly programId: ProgramId
  readonly level: 'low' | 'normal' | 'high'
}

export type OperatorCommand =
  | CreateProgramCommand
  | PauseProgramCommand
  | StopProgramCommand
  | CreateIssueCommand
  | SetExplorationCommand
export type ResearcherCommand =
  | ClaimIssueCommand
  | CommentOnIssueCommand
  | ProposeExperimentCommand
  | RequestCICommand
  | CloseIssueCommand
export type ImplementerCommand = SubmitImplementationCommand
/** Every command type literal, the key of the compile-time maps below. */
export type CommandType = AnyCommand['type']

/** The payload type of one command literal. */
export type CommandOf<T extends CommandType> = Extract<AnyCommand, { readonly type: T }>

/** Which capability a command requires; a command in no map is Host-internal. */
export type CapabilityForCommand = {
  readonly 'program.create': 'program:create'
  readonly 'program.pause': 'program:pause'
  readonly 'program.stop': 'program:stop'
  readonly 'program.set-exploration': 'program:exploration'
  readonly 'issue.create': 'issue:create'
  readonly 'issue.claim': 'issue:claim'
  readonly 'issue.comment': 'issue:comment'
  readonly 'issue.close': 'issue:close'
  readonly 'experiment.propose': 'experiment:propose'
  readonly 'ci.request': 'ci:request'
  readonly 'implementation.submit': 'ticket:submit'
}

/** The capability is known at compile time from the command literal. */
export type CapabilityOfCommand<T extends CommandType> =
  T extends keyof CapabilityForCommand ? CapabilityForCommand[T] : never

/** A command whose type is statically known to require this capability. */
export type RequiringCapability<K extends string> = {
  readonly [T in keyof CapabilityForCommand]: CapabilityForCommand[T] extends K ? T : never
}[keyof CapabilityForCommand]

/** What executing one command returns: the read value plus the audit records it wrote. */
export interface Decision<R> {
  readonly result: R
  readonly audit: readonly AuditEntry[]
}

export type AnyCommand = OperatorCommand | ResearcherCommand | ImplementerCommand | HostCommand
