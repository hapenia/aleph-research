/** Experiments: one Implementer Ticket per experiment, reviewed by a Researcher. */
import type {
  BranchName,
  CommitSha,
  CIRunId,
  CommentId,
  IsoTimestamp,
  IssueId,
  ProgramId,
  ExperimentId,
  Score,
  SessionId,
} from './ids.js'
import type { EnvironmentDeclaration } from './environment.js'

export type ExperimentStatus =
  | 'open'
  | 'ci-requested'
  | 'ci-running'
  | 'ci-passed'
  | 'ci-failed'
  | 'closed'

export type CloseReason = 'superseded' | 'abandoned' | 'rejected' | 'concluded'

/** Exploit continues from the best result; explore deliberately starts elsewhere. */
export type ExperimentStrategy = 'exploit' | 'explore'

/**
 * Where an Experiment's branch started. The Host chooses: exploit Experiments start
 * from the best result, explore Experiments from the research mainline.
 */
export type ExperimentBaseRef = { readonly kind: 'best' } | { readonly kind: 'mainline' }

/**
 * Lineage is part of the Experiment, not a comment: the Host needs it to measure
 * diversity and to reproduce where a result came from.
 */
export interface ExperimentLineage {
  readonly base: ExperimentBaseRef
  readonly baseCommit: CommitSha
  readonly strategy: ExperimentStrategy
  /** The base is always assigned by the Host from the operator's exploration level. */
  readonly chosenBy: 'host-policy'
  readonly rationale: string
}

interface ExperimentBase {
  readonly id: ExperimentId
  readonly programId: ProgramId
  readonly issueId: IssueId
  readonly branch: BranchName
  readonly lineage: ExperimentLineage
  /** The commit CI reviewed last; a new commit invalidates an older CI verdict. */
  readonly head: CommitSha
  readonly environment: EnvironmentDeclaration
  readonly createdBy: SessionId
  readonly createdAt: IsoTimestamp
}

/**
 * A Experiment is an experiment snapshot, not a branch to merge into a mainline:
 * research does not need git merge semantics. It ends by closing with a reason;
 * the best result is tracked separately on the Program.
 */
export type Experiment =
  | (ExperimentBase & { readonly status: 'open' })
  | (ExperimentBase & {
      readonly status: 'ci-requested'
      readonly ciRunId: CIRunId
      readonly requestedAt: IsoTimestamp
    })
  | (ExperimentBase & { readonly status: 'ci-running'; readonly ciRunId: CIRunId })
  | (ExperimentBase & {
      readonly status: 'ci-passed'
      readonly ciRunId: CIRunId
      readonly score: Score
      readonly reviewedBy: SessionId
    })
  | (ExperimentBase & {
      readonly status: 'ci-failed'
      readonly ciRunId: CIRunId
      readonly reason: string
    })
  | (ExperimentBase & {
      readonly status: 'closed'
      readonly closedAt: IsoTimestamp
      readonly reason: CloseReason
    })

/** Review comments are the Researcher's judgement, separate from CI output. */
export interface ReviewComment {
  readonly id: CommentId
  readonly experimentId: ExperimentId
  readonly author: SessionId
  readonly body: string
  readonly at: IsoTimestamp
  readonly kind: 'review' | 'ci-request' | 'merge-request'
}
