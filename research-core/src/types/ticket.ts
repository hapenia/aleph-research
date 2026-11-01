/** Tickets: the Implementer work item for one Experiment; status is a variant union. */
import type { ImplementerSessionId, CIRunId, CommitSha, ExperimentId, IsoTimestamp, IssueId, ProgramId, TicketId } from './ids.js'

interface TicketBase {
  readonly id: TicketId
  readonly programId: ProgramId
  readonly issueId: IssueId
  readonly experimentId: ExperimentId
  readonly baseCommit: CommitSha
  readonly createdAt: IsoTimestamp
}

export interface OpenTicket extends TicketBase {
  readonly status: 'open'
}

export interface RunningTicket extends TicketBase {
  readonly status: 'running'
  readonly sessionId: ImplementerSessionId
  readonly startedAt: IsoTimestamp
}

export interface SubmittedTicket extends TicketBase {
  readonly status: 'submitted'
  readonly sessionId: ImplementerSessionId
  readonly head: CommitSha
  readonly submittedAt: IsoTimestamp
}

export interface CancelledTicket extends TicketBase {
  readonly status: 'cancelled'
  readonly reason: string
  readonly cancelledAt: IsoTimestamp
}

export interface FailedTicket extends TicketBase {
  readonly status: 'failed'
  readonly reason: string
  readonly failedAt: IsoTimestamp
}

/** Status and fields are discriminated; illegal combinations do not typecheck. */
export type Ticket = OpenTicket | RunningTicket | SubmittedTicket | CancelledTicket | FailedTicket
