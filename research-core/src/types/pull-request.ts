/** Pull requests: one Implementer Ticket per experiment, reviewed by a Researcher. */
import type {
  BranchName,
  CommitSha,
  CIRunId,
  CommentId,
  IsoTimestamp,
  IssueId,
  ProgramId,
  PullRequestId,
  Score,
  SessionId,
} from './ids.js'
import type { EnvironmentDeclaration } from './environment.js'

export type PullRequestStatus =
  | 'open'
  | 'ci-requested'
  | 'ci-running'
  | 'ci-passed'
  | 'ci-failed'
  | 'merged'
  | 'closed'

export type CloseReason = 'superseded' | 'abandoned' | 'rejected'

interface PullRequestBase {
  readonly id: PullRequestId
  readonly programId: ProgramId
  readonly issueId: IssueId
  readonly branch: BranchName
  /** The commit CI reviewed last; a new commit invalidates an older CI verdict. */
  readonly head: CommitSha
  readonly environment: EnvironmentDeclaration
  readonly createdBy: SessionId
  readonly createdAt: IsoTimestamp
}

/**
 * A Pull request in `merged` must carry the evidence the Host checked: the merge
 * gate reads `ciRunId` and `acceptedBy`, so "merged without CI" cannot be constructed.
 */
export type PullRequest =
  | (PullRequestBase & { readonly status: 'open' })
  | (PullRequestBase & {
      readonly status: 'ci-requested'
      readonly ciRunId: CIRunId
      readonly requestedAt: IsoTimestamp
    })
  | (PullRequestBase & { readonly status: 'ci-running'; readonly ciRunId: CIRunId })
  | (PullRequestBase & {
      readonly status: 'ci-passed'
      readonly ciRunId: CIRunId
      readonly score: Score
      readonly reviewedBy: SessionId
    })
  | (PullRequestBase & {
      readonly status: 'ci-failed'
      readonly ciRunId: CIRunId
      readonly reason: string
    })
  | (PullRequestBase & {
      readonly status: 'merged'
      readonly ciRunId: CIRunId
      readonly score: Score
      readonly mergeCommit: CommitSha
      readonly mergedAt: IsoTimestamp
    })
  | (PullRequestBase & {
      readonly status: 'closed'
      readonly closedAt: IsoTimestamp
      readonly reason: CloseReason
    })

/** Review comments are the Researcher's judgement, separate from CI output. */
export interface ReviewComment {
  readonly id: CommentId
  readonly pullRequestId: PullRequestId
  readonly author: SessionId
  readonly body: string
  readonly at: IsoTimestamp
  readonly kind: 'review' | 'ci-request' | 'merge-request'
}
