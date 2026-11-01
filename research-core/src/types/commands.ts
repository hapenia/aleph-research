/** Commands: the only way to change a Program; each role may issue a subset. */
import type { Budget, EvaluationContract } from './program.js'
import type { IssueLabel } from './issue.js'
import type { EnvironmentDeclaration } from './environment.js'
import type { CommitSha, IssueId, ProgramId, PullRequestId, ResearcherId, TicketId } from './ids.js'

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

export interface ClaimIssueCommand {
  readonly type: 'issue.claim'
  readonly programId: ProgramId
  readonly issueId: IssueId
  readonly researcherId: ResearcherId
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

export interface ExperimentPlan {
  readonly hypothesis: string
  readonly steps: readonly string[]
  /** What would count as success when CI reports, before seeing the score. */
  readonly expected: {
    readonly direction: 'higher' | 'lower'
    readonly minDelta?: number
    readonly rationale: string
  }
  readonly environment: EnvironmentDeclaration
}

export interface RequestPullRequestCommand {
  readonly type: 'pull-request.propose'
  readonly programId: ProgramId
  readonly issueId: IssueId
  readonly branch: string
  readonly head: CommitSha
  readonly environment: EnvironmentDeclaration
}

export interface RequestCICommand {
  readonly type: 'ci.request'
  readonly programId: ProgramId
  readonly pullRequestId: PullRequestId
  readonly commit: CommitSha
}

export interface RequestMergeCommand {
  readonly type: 'pull-request.merge'
  readonly programId: ProgramId
  readonly pullRequestId: PullRequestId
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
  | { readonly type: 'ci.start'; readonly ciRunId: string }
  | { readonly type: 'ci.finish'; readonly ciRunId: string }
  | { readonly type: 'pull-request.merge-finalize'; readonly pullRequestId: PullRequestId }

export type OperatorCommand = CreateProgramCommand | PauseProgramCommand | StopProgramCommand | CreateIssueCommand
export type ResearcherCommand =
  | ClaimIssueCommand
  | CommentOnIssueCommand
  | ProposeExperimentCommand
  | RequestPullRequestCommand
  | RequestCICommand
  | RequestMergeCommand
  | CloseIssueCommand
export type ImplementerCommand = SubmitImplementationCommand
export type AnyCommand = OperatorCommand | ResearcherCommand | ImplementerCommand | HostCommand
