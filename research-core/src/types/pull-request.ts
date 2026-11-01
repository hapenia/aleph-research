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
  | 'closed'

export type CloseReason = 'superseded' | 'abandoned' | 'rejected' | 'concluded'

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
 * A Pull request is an experiment snapshot, not a branch to merge into a mainline:
 * research does not need git merge semantics. It ends by closing with a reason;
 * the best result is tracked separately on the Program.
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
