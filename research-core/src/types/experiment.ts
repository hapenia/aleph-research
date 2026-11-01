/** Experiments: one attempt at an Issue; a snapshot, never merged. */
import type { HostPrincipal, ImplementerPrincipal, ResearcherPrincipal } from './actors.js'
import type { ArtifactRef } from './artifacts.js'
import type { CIFailureReason, RunningCIRun } from './ci.js'
import type { EnvironmentDeclaration } from './environment.js'
import type { MetricMap } from './metrics.js'
import type {
  BranchName,
  CIRunId,
  CommentId,
  CommitSha,
  ExperimentId,
  IsoTimestamp,
  IssueId,
  NonEmptyArray,
  NonEmptyString,
  ProgramId,
} from './ids.js'

export type ExperimentStatus =
  | 'open'
  | 'ci-pending'
  | 'ci-running'
  | 'ci-passed'
  | 'ci-failed'
  | 'closed'

/** How the Host chose the base: a sampled previous Experiment, or a fresh start. */
export declare class DerivedLineage {
  private constructor()
  private readonly __derived: true
  readonly strategy: 'derive'
  readonly baseExperimentId: ExperimentId
  readonly baseCommit: CommitSha
  readonly temperature: number
  readonly sampledWeight: number
}

export declare class FreshLineage {
  private constructor()
  private readonly __fresh: true
  readonly strategy: 'fresh'
  readonly baseCommit: CommitSha
  readonly freshStartProbability: number
}

export type ExperimentLineage = DerivedLineage | FreshLineage

/** What the sampler may choose; the Host turns it into a lineage. */
export type BaseChoice =
  | { readonly kind: 'derived'; readonly experimentId: ExperimentId; readonly commit: CommitSha }
  | { readonly kind: 'fresh' }

interface ExperimentCommon {
  readonly id: ExperimentId
  readonly programId: ProgramId
  readonly issueId: IssueId
  readonly branch: BranchName
  readonly head: CommitSha
  readonly environment: EnvironmentDeclaration
  readonly lineage: ExperimentLineage
  readonly planCommentId: CommentId
  readonly createdBy: ResearcherPrincipal
  readonly createdAt: IsoTimestamp
}

export declare class OpenExperiment implements ExperimentCommon {
  private constructor()
  private readonly __open: true
  readonly status: 'open'
  readonly id: ExperimentId
  readonly programId: ProgramId
  readonly issueId: IssueId
  readonly branch: BranchName
  readonly head: CommitSha
  readonly environment: EnvironmentDeclaration
  readonly lineage: ExperimentLineage
  readonly planCommentId: CommentId
  readonly createdBy: ResearcherPrincipal
  readonly createdAt: IsoTimestamp
  /** Iteration: a new commit on the same Experiment; no new population entry. */
  revise(actor: ImplementerPrincipal, head: CommitSha, environment: EnvironmentDeclaration, at: IsoTimestamp): OpenExperiment
  requestCI(actor: ResearcherPrincipal, ciRunId: CIRunId, at: IsoTimestamp): CIPendingExperiment
  close(actor: ResearcherPrincipal, reason: NonEmptyString, at: IsoTimestamp): ClosedExperiment
}

export declare class CIPendingExperiment implements ExperimentCommon {
  private constructor()
  private readonly __pending: true
  readonly status: 'ci-pending'
  readonly id: ExperimentId
  readonly programId: ProgramId
  readonly issueId: IssueId
  readonly branch: BranchName
  readonly head: CommitSha
  readonly environment: EnvironmentDeclaration
  readonly lineage: ExperimentLineage
  readonly planCommentId: CommentId
  readonly createdBy: ResearcherPrincipal
  readonly createdAt: IsoTimestamp
  readonly ciRunId: CIRunId
  readonly requestedAt: IsoTimestamp
  startCI(actor: HostPrincipal, digest: string, at: IsoTimestamp): CIRunningExperiment
  close(actor: ResearcherPrincipal, reason: NonEmptyString, at: IsoTimestamp): ClosedExperiment
}

export declare class CIRunningExperiment implements ExperimentCommon {
  private constructor()
  private readonly __running: true
  readonly status: 'ci-running'
  readonly id: ExperimentId
  readonly programId: ProgramId
  readonly issueId: IssueId
  readonly branch: BranchName
  readonly head: CommitSha
  readonly environment: EnvironmentDeclaration
  readonly lineage: ExperimentLineage
  readonly planCommentId: CommentId
  readonly createdBy: ResearcherPrincipal
  readonly createdAt: IsoTimestamp
  readonly ciRunId: CIRunId
  readonly requestedAt: IsoTimestamp
  readonly startedAt: IsoTimestamp
  readonly environmentDigest: string
  passCI(
    actor: HostPrincipal,
    run: RunningCIRun,
    metrics: MetricMap,
    artifacts: readonly ArtifactRef[],
    at: IsoTimestamp,
  ): CIPassedExperiment
  failCI(actor: HostPrincipal, reason: CIFailureReason, detail: NonEmptyString, at: IsoTimestamp): CIFailedExperiment
  close(actor: ResearcherPrincipal, reason: NonEmptyString, at: IsoTimestamp): ClosedExperiment
}

export declare class CIPassedExperiment implements ExperimentCommon {
  private constructor()
  private readonly __passed: true
  readonly status: 'ci-passed'
  readonly id: ExperimentId
  readonly programId: ProgramId
  readonly issueId: IssueId
  readonly branch: BranchName
  readonly head: CommitSha
  readonly environment: EnvironmentDeclaration
  readonly lineage: ExperimentLineage
  readonly planCommentId: CommentId
  readonly createdBy: ResearcherPrincipal
  readonly createdAt: IsoTimestamp
  readonly ciRunId: CIRunId
  readonly metrics: MetricMap
  readonly artifacts: readonly ArtifactRef[]
  readonly finishedAt: IsoTimestamp
  close(actor: ResearcherPrincipal, reason: NonEmptyString, at: IsoTimestamp): ClosedExperiment
}

export declare class CIFailedExperiment implements ExperimentCommon {
  private constructor()
  private readonly __failed: true
  readonly status: 'ci-failed'
  readonly id: ExperimentId
  readonly programId: ProgramId
  readonly issueId: IssueId
  readonly branch: BranchName
  readonly head: CommitSha
  readonly environment: EnvironmentDeclaration
  readonly lineage: ExperimentLineage
  readonly planCommentId: CommentId
  readonly createdBy: ResearcherPrincipal
  readonly createdAt: IsoTimestamp
  readonly ciRunId: CIRunId
  readonly failureReason: CIFailureReason
  readonly failureDetail: NonEmptyString
  readonly failedAt: IsoTimestamp
  /** A failed Experiment may be revised (new commit) or closed. */
  revise(actor: ImplementerPrincipal, head: CommitSha, environment: EnvironmentDeclaration, at: IsoTimestamp): OpenExperiment
  close(actor: ResearcherPrincipal, reason: NonEmptyString, at: IsoTimestamp): ClosedExperiment
}

export declare class ClosedExperiment implements ExperimentCommon {
  private constructor()
  private readonly __closed: true
  readonly status: 'closed'
  readonly id: ExperimentId
  readonly programId: ProgramId
  readonly issueId: IssueId
  readonly branch: BranchName
  readonly head: CommitSha
  readonly environment: EnvironmentDeclaration
  readonly lineage: ExperimentLineage
  readonly planCommentId: CommentId
  readonly createdBy: ResearcherPrincipal
  readonly createdAt: IsoTimestamp
  readonly closedAt: IsoTimestamp
  readonly closeReason: NonEmptyString
}

export type Experiment =
  | OpenExperiment
  | CIPendingExperiment
  | CIRunningExperiment
  | CIPassedExperiment
  | CIFailedExperiment
  | ClosedExperiment

/** Plans live in Issue comments; this is the typed plan a Researcher submits. */
export interface ExperimentPlan {
  readonly hypothesis: NonEmptyString
  readonly steps: NonEmptyArray<NonEmptyString>
  readonly expected: { readonly direction: 'higher' | 'lower'; readonly rationale: NonEmptyString }
  readonly environment: EnvironmentDeclaration
  /** Earlier artifacts this Experiment consumes. */
  readonly inputs: readonly ArtifactRef[]
}

export interface ExperimentReview {
  readonly id: string
  readonly experimentId: ExperimentId
  readonly author: ResearcherPrincipal
  readonly body: string
  readonly at: IsoTimestamp
  readonly kind: 'review' | 'ci-request'
}
