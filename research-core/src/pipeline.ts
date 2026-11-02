/**
 * Typed research flow: each step consumes the previous step's nominal receipt and
 * returns the next receipt. A receipt can only be minted by the step that performed the
 * action, so a caller cannot skip, reorder or replace a step.
 *
 * A receipt proves that the Host step completed; it does not prove that an external
 * service really performed the side effect. That trust boundary is explicit in the
 * factory that mints receipts.
 */
import type { DomainError, Result } from './types/errors.js'
import type {
  CIRunId,
  CommitSha,
  ExperimentId,
  IssueId,
  ProgramId,
  TicketId,
} from './types/ids.js'
import { unimplemented } from './completion.js'

export declare class IssueAssignedReceipt {
  private constructor()
  private readonly __issueAssigned: true
  readonly programId: ProgramId
  readonly issueId: IssueId
  readonly assigneeSessionId: string
}

export declare class ExperimentProposedReceipt {
  private constructor()
  private readonly __experimentProposed: true
  readonly programId: ProgramId
  readonly issueId: IssueId
  readonly experimentId: ExperimentId
  readonly planCommentId: string
}

export declare class TriggerAcceptedReceipt {
  private constructor()
  private readonly __triggerAccepted: true
  readonly programId: ProgramId
  readonly experimentId: ExperimentId
  readonly triggerId: string
  readonly threadId: string
}

export declare class TicketOpenedReceipt {
  private constructor()
  private readonly __ticketOpened: true
  readonly programId: ProgramId
  readonly experimentId: ExperimentId
  readonly ticketId: TicketId
}

export declare class WorkerStartedReceipt {
  private constructor()
  private readonly __workerStarted: true
  readonly ticketId: TicketId
  readonly workerSessionId: string
}

export declare class CommitSubmittedReceipt {
  private constructor()
  private readonly __commitSubmitted: true
  readonly ticketId: TicketId
  readonly commit: CommitSha
}

export declare class EnvironmentBuiltReceipt {
  private constructor()
  private readonly __environmentBuilt: true
  readonly ticketId: TicketId
  readonly commit: CommitSha
  readonly environmentDigest: string
}

export declare class CIPassedReceipt {
  private constructor()
  private readonly __ciPassed: true
  readonly ticketId: TicketId
  readonly experimentId: ExperimentId
  readonly ciRunId: CIRunId
  readonly commit: CommitSha
}

export declare class CIFailedReceipt {
  private constructor()
  private readonly __ciFailed: true
  readonly ticketId: TicketId
  readonly experimentId: ExperimentId
  readonly ciRunId: CIRunId
  readonly commit: CommitSha
  readonly reason: string
}

export declare class ResultRecordedReceipt {
  private constructor()
  private readonly __resultRecorded: true
  readonly experimentId: ExperimentId
  readonly ciRunId: CIRunId
}

export declare class ReviewRecordedReceipt {
  private constructor()
  private readonly __reviewRecorded: true
  readonly experimentId: ExperimentId
  readonly issueId: IssueId
  readonly verdict: 'approve' | 'request-changes' | 'comment'
}

export declare class ResearchCompletedReceipt {
  private constructor()
  private readonly __researchCompleted: true
  readonly experimentId: ExperimentId
  readonly issueId: IssueId
  readonly outcome: 'concluded' | 'failed' | 'cancelled'
}

/** One typed step; its input receipt cannot be constructed by a caller. */
export interface FlowStep<From, To> {
  run(input: From): Promise<Result<To, DomainError>>
}

/** The complete chain. Every step is required; missing wiring is a compile error. */
export interface ResearchFlow {
  readonly deliverTrigger: FlowStep<ExperimentProposedReceipt, TriggerAcceptedReceipt>
  readonly openTicket: FlowStep<TriggerAcceptedReceipt, TicketOpenedReceipt>
  readonly startWorker: FlowStep<TicketOpenedReceipt, WorkerStartedReceipt>
  readonly submitCommit: FlowStep<WorkerStartedReceipt, CommitSubmittedReceipt>
  readonly buildEnvironment: FlowStep<CommitSubmittedReceipt, EnvironmentBuiltReceipt>
  readonly runCI: FlowStep<EnvironmentBuiltReceipt, CIPassedReceipt | CIFailedReceipt>
  readonly recordResult: FlowStep<CIPassedReceipt, ResultRecordedReceipt>
  readonly reviewResult: FlowStep<ResultRecordedReceipt, ReviewRecordedReceipt>
  readonly closePassed: FlowStep<ReviewRecordedReceipt, ResearchCompletedReceipt>
  readonly closeFailed: FlowStep<CIFailedReceipt, ResearchCompletedReceipt>
}

export type FlowStepName = keyof ResearchFlow

/**
 * Honest placeholder wiring for development: every step throws UnimplementedError with
 * the completion-ledger feature instead of returning a fabricated receipt.
 */
export function createUnimplementedFlow(): ResearchFlow {
  // TODO(@experiment-to-ticket): deliver experiment.proposed to the Source Eval and
  // return TriggerAcceptedReceipt only after the Eval accepts.
  // TODO(@implementer-ticket-execution): open a Ticket and return TicketOpenedReceipt.
  // TODO(@ci-evaluation-writeback): build the environment, run CI and return the
  // matching CIPassedReceipt/CIFailedReceipt.
  // TODO(@researcher-review-loop): record the review and close the Issue/Experiment.
  return {
    deliverTrigger: { run: () => unimplemented('experiment-to-ticket', 'Source Eval delivery is not wired') },
    openTicket: { run: () => unimplemented('experiment-to-ticket', 'Ticket opening is not wired') },
    startWorker: { run: () => unimplemented('implementer-ticket-execution', 'Worker start is not wired') },
    submitCommit: { run: () => unimplemented('implementer-ticket-execution', 'Commit submission is not wired') },
    buildEnvironment: { run: () => unimplemented('ci-evaluation-writeback', 'Environment build is not wired') },
    runCI: { run: () => unimplemented('ci-evaluation-writeback', 'CI execution is not wired') },
    recordResult: { run: () => unimplemented('ci-evaluation-writeback', 'Result writeback is not wired') },
    reviewResult: { run: () => unimplemented('researcher-review-loop', 'Researcher review is not wired') },
    closePassed: { run: () => unimplemented('researcher-review-loop', 'Passed close is not wired') },
    closeFailed: { run: () => unimplemented('researcher-review-loop', 'Failed close is not wired') },
  }
}
