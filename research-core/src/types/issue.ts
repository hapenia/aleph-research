/** Issues: research questions with exactly one Researcher owner. */
import type { IssueAuthor, OperatorPrincipal, ResearcherPrincipal } from './actors.js'
import type { CommitSha, ExperimentId, IsoTimestamp, IssueId, ProgramId, ResearcherSessionId } from './ids.js'

export type IssueLabel = 'research' | 'experiment' | 'analysis' | 'bug' | 'blocked'
export type IssueResolution = 'accepted' | 'rejected' | 'abandoned'

interface IssueCommon {
  readonly id: IssueId
  readonly programId: ProgramId
  readonly title: string
  readonly body: string
  readonly labels: readonly IssueLabel[]
  readonly author: IssueAuthor
  readonly createdAt: IsoTimestamp
}

export declare class OpenIssue implements IssueCommon {
  private constructor()
  private readonly __open: true
  readonly status: 'open'
  readonly id: IssueId
  readonly programId: ProgramId
  readonly title: string
  readonly body: string
  readonly labels: readonly IssueLabel[]
  readonly author: IssueAuthor
  readonly createdAt: IsoTimestamp
  claim(actor: ResearcherPrincipal, at: IsoTimestamp): AssignedIssue
  close(actor: OperatorPrincipal, resolution: IssueResolution, at: IsoTimestamp): ClosedIssue
}

export declare class AssignedIssue implements IssueCommon {
  private constructor()
  private readonly __assigned: true
  readonly status: 'assigned'
  readonly id: IssueId
  readonly programId: ProgramId
  readonly title: string
  readonly body: string
  readonly labels: readonly IssueLabel[]
  readonly author: IssueAuthor
  readonly createdAt: IsoTimestamp
  readonly assignee: ResearcherPrincipal
  readonly assignedAt: IsoTimestamp
  /** The assignee only may attach the Experiment it proposed. */
  attachExperiment(actor: ResearcherPrincipal, experimentId: ExperimentId, head: CommitSha, at: IsoTimestamp): InReviewIssue
  close(actor: ResearcherPrincipal, resolution: IssueResolution, at: IsoTimestamp): ClosedIssue
}

export declare class InReviewIssue implements IssueCommon {
  private constructor()
  private readonly __inReview: true
  readonly status: 'in-review'
  readonly id: IssueId
  readonly programId: ProgramId
  readonly title: string
  readonly body: string
  readonly labels: readonly IssueLabel[]
  readonly author: IssueAuthor
  readonly createdAt: IsoTimestamp
  readonly assignee: ResearcherPrincipal
  readonly assignedAt: IsoTimestamp
  readonly experimentId: ExperimentId
  readonly head: CommitSha
  close(actor: ResearcherPrincipal, resolution: IssueResolution, at: IsoTimestamp): ClosedIssue
}

export declare class ClosedIssue implements IssueCommon {
  private constructor()
  private readonly __closed: true
  readonly status: 'closed'
  readonly id: IssueId
  readonly programId: ProgramId
  readonly title: string
  readonly body: string
  readonly labels: readonly IssueLabel[]
  readonly author: IssueAuthor
  readonly createdAt: IsoTimestamp
  readonly assignee: ResearcherSessionId | null
  readonly closedAt: IsoTimestamp
  readonly resolution: IssueResolution
}

export type Issue = OpenIssue | AssignedIssue | InReviewIssue | ClosedIssue

/** Comments carry the typed experiment plan and the review discussion. */
export interface IssueComment {
  readonly id: string
  readonly issueId: IssueId
  readonly authorSessionId: ResearcherSessionId | 'operator'
  readonly body: string
  readonly at: IsoTimestamp
  readonly kind: 'comment' | 'plan'
}
