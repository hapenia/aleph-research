/** Tickets: the Implementer work item for one Experiment; owned by the Host. */
import type { ImplementerSessionId, CIRunId, CommitSha, ExperimentId, IsoTimestamp, IssueId, ProgramId, TicketId } from './ids.js'

export type TicketStatus = 'open' | 'running' | 'submitted' | 'cancelled' | 'failed'

interface TicketCommon {
  readonly id: TicketId
  readonly programId: ProgramId
  readonly issueId: IssueId
  readonly experimentId: ExperimentId
  readonly createdAt: IsoTimestamp
}

export declare class Ticket implements TicketCommon {
  private constructor()
  private readonly __ticket: true
  readonly id: TicketId
  readonly programId: ProgramId
  readonly issueId: IssueId
  readonly experimentId: ExperimentId
  readonly createdAt: IsoTimestamp
  readonly status: TicketStatus
  readonly sessionId?: ImplementerSessionId
  readonly baseCommit: CommitSha
  readonly head?: CommitSha
  readonly ciRunId?: CIRunId
}
