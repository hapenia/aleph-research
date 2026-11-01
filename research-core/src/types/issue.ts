/** Issues: research questions with exactly one Researcher owner and many Experiments. */
import type {
  IssueAssignment,
  IssueAuthor,
  OperatorPrincipal,
  ResearcherPrincipal,
} from './actors.js'
import type { DomainError, Result, StoreError } from './errors.js'
import type {
  CommentId,
  ExperimentId,
  IsoTimestamp,
  IssueId,
  NonEmptyArray,
  NonEmptyString,
  ProgramId,
  ResearcherSessionId,
} from './ids.js'

export type IssueLabel = 'research' | 'experiment' | 'analysis' | 'bug' | 'blocked'
export type IssueResolution = 'accepted' | 'rejected' | 'abandoned'

interface IssueCommon {
  readonly id: IssueId
  readonly programId: ProgramId
  readonly title: NonEmptyString
  readonly body: NonEmptyString
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
  readonly title: NonEmptyString
  readonly body: NonEmptyString
  readonly labels: readonly IssueLabel[]
  readonly author: IssueAuthor
  readonly createdAt: IsoTimestamp
  claim(actor: ResearcherPrincipal, at: IsoTimestamp): AssignedIssue
  close(actor: OperatorPrincipal, resolution: IssueResolution, summary: NonEmptyString, at: IsoTimestamp): ClosedIssue
}

export declare class AssignedIssue implements IssueCommon {
  private constructor()
  private readonly __assigned: true
  readonly status: 'assigned'
  readonly id: IssueId
  readonly programId: ProgramId
  readonly title: NonEmptyString
  readonly body: NonEmptyString
  readonly labels: readonly IssueLabel[]
  readonly author: IssueAuthor
  readonly createdAt: IsoTimestamp
  readonly assignee: ResearcherPrincipal
  readonly assignedAt: IsoTimestamp
  /** Every Experiment proposed for this Issue; iteration does not add a new entry. */
  readonly experimentIds: readonly ExperimentId[]
  /** Runtime check: only the assignee gets a token. */
  authorize(actor: ResearcherPrincipal): Result<IssueAssignment, DomainError>
  addExperiment(
    assignment: IssueAssignment,
    experimentId: ExperimentId,
    at: IsoTimestamp,
  ): Result<AssignedIssue, DomainError>
  close(
    assignment: IssueAssignment,
    resolution: IssueResolution,
    summary: NonEmptyString,
    at: IsoTimestamp,
  ): Result<ClosedIssue, DomainError>
}

export declare class ClosedIssue implements IssueCommon {
  private constructor()
  private readonly __closed: true
  readonly status: 'closed'
  readonly id: IssueId
  readonly programId: ProgramId
  readonly title: NonEmptyString
  readonly body: NonEmptyString
  readonly labels: readonly IssueLabel[]
  readonly author: IssueAuthor
  readonly createdAt: IsoTimestamp
  readonly assigneeSessionId: ResearcherSessionId | null
  readonly closedAt: IsoTimestamp
  readonly resolution: IssueResolution
  readonly summary: NonEmptyString
}

export type Issue = OpenIssue | AssignedIssue | ClosedIssue

/** Comments carry the typed plan reference and the review discussion. */
export interface IssueComment {
  readonly id: CommentId
  readonly issueId: IssueId
  readonly authorSessionId: ResearcherSessionId | 'operator'
  readonly body: NonEmptyString
  readonly at: IsoTimestamp
  readonly kind: 'comment' | 'plan'
}
