/** Issues: research questions claimed by one Researcher and worked to completion. */
import type { CommitSha, IsoTimestamp, IssueId, ProgramId, ExperimentId, SessionId } from './ids.js'

export type IssueStatus = 'open' | 'assigned' | 'in-review' | 'closed'
export type IssueResolution = 'accepted' | 'rejected' | 'abandoned'
export type IssueLabel = 'research' | 'experiment' | 'analysis' | 'bug' | 'blocked'

interface IssueBase {
  readonly id: IssueId
  readonly programId: ProgramId
  readonly title: string
  /** Goal and acceptance criteria, written by the operator or a Researcher. */
  readonly body: string
  readonly labels: readonly IssueLabel[]
  readonly createdBy: SessionId
  readonly createdAt: IsoTimestamp
}

/** One state per discriminant; illegal field combinations do not typecheck. */
export interface OpenIssue extends IssueBase {
  readonly status: 'open'
}

export interface AssignedIssue extends IssueBase {
  readonly status: 'assigned'
  readonly assignee: SessionId
  readonly assignedAt: IsoTimestamp
}

export interface InReviewIssue extends IssueBase {
  readonly status: 'in-review'
  readonly assignee: SessionId
  readonly assignedAt: IsoTimestamp
  /** The Experiment whose CI is being reviewed. */
  readonly experimentId: ExperimentId
  readonly head: CommitSha
}

export interface ClosedIssue extends IssueBase {
  readonly status: 'closed'
  readonly assignee: SessionId | null
  readonly closedAt: IsoTimestamp
  readonly resolution: IssueResolution
}

export type Issue = OpenIssue | AssignedIssue | InReviewIssue | ClosedIssue

/** Comments are the discussion of an Issue; the experiment plan lives here. */
export interface IssueComment {
  readonly id: string
  readonly issueId: IssueId
  readonly author: SessionId
  readonly body: string
  readonly at: IsoTimestamp
}
