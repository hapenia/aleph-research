/** Experiments: one attempt at an Issue; a snapshot, never merged. */
import type { HostPrincipal, ImplementerPrincipal, IssueAssignment, ResearcherPrincipal, TicketBinding } from './actors.js'
import type { ArtifactRef } from './artifacts.js'
import type { FailedCICompletion, PassedCICompletion } from './ci.js'
import type { EnvironmentDeclaration } from './environment.js'
import type { MetricMap } from './metrics.js'
import type { DomainError, Result, StoreError } from './errors.js'
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
  ReviewId,
} from './ids.js'

export type ExperimentStatus =
  | 'open'
  | 'ready'
  | 'ci-pending'
  | 'ci-running'
  | 'ci-passed'
  | 'ci-failed'
  | 'closed'

/** Sampled base: a previous Experiment's commit, with the sampling evidence attached. */
export declare class DerivedLineage {
  private constructor()
  private readonly __derived: true
  readonly strategy: 'derive'
  readonly baseExperimentId: ExperimentId
  readonly baseCommit: CommitSha
  readonly temperature: number
  readonly sampledWeight: number
  static create(input: Omit<DerivedLineage, 'strategy'>): DerivedLineage
  static fromRow(row: unknown): Result<DerivedLineage, StoreError>
}

/** Fresh start: the scaffold commit, not any previous Experiment. */
export declare class FreshLineage {
  private constructor()
  private readonly __fresh: true
  readonly strategy: 'fresh'
  readonly baseCommit: CommitSha
  readonly freshStartProbability: number
  static create(input: Omit<FreshLineage, 'strategy'>): FreshLineage
  static fromRow(row: unknown): Result<FreshLineage, StoreError>
}

export type ExperimentLineage = DerivedLineage | FreshLineage

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
  static create(input: Omit<OpenExperiment, 'status' | 'submit' | 'cancel'>): OpenExperiment
  static fromRow(row: unknown): Result<OpenExperiment, StoreError>
  /** Implementer marks the Experiment ready; the Ticket binding must match. */
  submit(binding: TicketBinding, head: CommitSha, environment: EnvironmentDeclaration, at: IsoTimestamp): ReadyExperiment
  cancel(actor: HostPrincipal, at: IsoTimestamp): ClosedExperiment
}

export declare class ReadyExperiment implements ExperimentCommon {
  private constructor()
  private readonly __ready: true
  readonly status: 'ready'
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
  readonly readyAt: IsoTimestamp
  static create(input: Omit<ReadyExperiment, 'status' | 'callRequestCI' | 'revise' | 'cancel'>): ReadyExperiment
  static fromRow(row: unknown): Result<ReadyExperiment, StoreError>
  /** Only the Issue assignee may request CI; the Host mints the CI run id. */
  requestCI(assignment: IssueAssignment, ciRunId: CIRunId, at: IsoTimestamp): CIPendingExperiment
  revise(binding: TicketBinding, head: CommitSha, environment: EnvironmentDeclaration, at: IsoTimestamp): OpenExperiment
  cancel(actor: HostPrincipal, at: IsoTimestamp): ClosedExperiment
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
  static create(input: Omit<CIPendingExperiment, 'status' | 'startCI' | 'cancel'>): CIPendingExperiment
  static fromRow(row: unknown): Result<CIPendingExperiment, StoreError>
  startCI(actor: HostPrincipal, digest: string, at: IsoTimestamp): CIRunningExperiment
  cancel(actor: HostPrincipal, at: IsoTimestamp): ClosedExperiment
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
  static create(input: Omit<CIRunningExperiment, 'status' | 'passCI' | 'failCI' | 'cancel'>): CIRunningExperiment
  static fromRow(row: unknown): Result<CIRunningExperiment, StoreError>
  /** Evidence comes from a Host-minted completion token, not from a bare run object. */
  passCI(actor: HostPrincipal, completion: PassedCICompletion, at: IsoTimestamp): CIPassedExperiment
  failCI(actor: HostPrincipal, completion: FailedCICompletion, at: IsoTimestamp): CIFailedExperiment
  cancel(actor: HostPrincipal, at: IsoTimestamp): ClosedExperiment
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
  readonly requestedAt: IsoTimestamp
  readonly startedAt: IsoTimestamp
  readonly environmentDigest: string
  readonly metrics: MetricMap
  readonly artifacts: readonly ArtifactRef[]
  readonly finishedAt: IsoTimestamp
  static create(input: Omit<CIPassedExperiment, 'status' | 'close'>): CIPassedExperiment
  static fromRow(row: unknown): Result<CIPassedExperiment, StoreError>
  close(assignment: IssueAssignment, reason: NonEmptyString, at: IsoTimestamp): ClosedExperiment
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
  readonly requestedAt: IsoTimestamp
  readonly startedAt?: IsoTimestamp
  readonly environmentDigest?: string
  readonly failureReason: FailedCICompletion['reason']
  readonly failureDetail: string
  readonly failedAt: IsoTimestamp
  static create(input: Omit<CIFailedExperiment, 'status' | 'revise' | 'close'>): CIFailedExperiment
  static fromRow(row: unknown): Result<CIFailedExperiment, StoreError>
  revise(binding: TicketBinding, head: CommitSha, environment: EnvironmentDeclaration, at: IsoTimestamp): OpenExperiment
  close(assignment: IssueAssignment, reason: NonEmptyString, at: IsoTimestamp): ClosedExperiment
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
  readonly outcome: 'concluded' | 'failed' | 'cancelled'
  static create(input: Omit<ClosedExperiment, 'status'>): ClosedExperiment
  static fromRow(row: unknown): Result<ClosedExperiment, StoreError>
}

export type Experiment =
  | OpenExperiment
  | ReadyExperiment
  | CIPendingExperiment
  | CIRunningExperiment
  | CIPassedExperiment
  | CIFailedExperiment
  | ClosedExperiment

/** Plans live in Issue comments; this is the typed plan the Researcher submits. */
export interface ExperimentPlan {
  readonly hypothesis: NonEmptyString
  readonly steps: NonEmptyArray<NonEmptyString>
  readonly expected: { readonly direction: 'higher' | 'lower'; readonly rationale: NonEmptyString }
  readonly environment: EnvironmentDeclaration
  /** Earlier artifacts this Experiment consumes. */
  readonly inputs: readonly ArtifactRef[]
}

export interface ExperimentReview {
  readonly id: ReviewId
  readonly experimentId: ExperimentId
  readonly author: ResearcherPrincipal
  readonly body: NonEmptyString
  readonly at: IsoTimestamp
  readonly kind: 'review' | 'ci-request'
  readonly verdict: 'approve' | 'request-changes' | 'comment'
}
