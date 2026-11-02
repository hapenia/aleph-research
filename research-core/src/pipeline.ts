/**
 * Typed research pipeline: each stage's output is the only accepted input of the next.
 * A stage cannot be skipped or reordered, and a composition that has not implemented a
 * stage cannot fabricate its evidence type. This is the compile-time shape of the
 * experiment -> trigger -> Ticket -> Worker -> CI -> review chain.
 *
 * The evidence classes are nominal; their constructors are intentionally private. They
 * are produced only by the corresponding stage and consumed by the next one.
 */
import type { DomainError, Result } from './types/errors.js'
import type { CIRunId, CommitSha, ExperimentId, IssueId, ProgramId, TicketId } from './types/ids.js'
import { unimplemented } from './completion.js'

export declare class ExperimentProposedEvidence {
  private constructor()
  private readonly __experimentProposed: true
  readonly programId: ProgramId
  readonly issueId: IssueId
  readonly experimentId: ExperimentId
}

export declare class TriggerAcceptedEvidence {
  private constructor()
  private readonly __triggerAccepted: true
  readonly programId: ProgramId
  readonly experimentId: ExperimentId
  readonly threadId: string
}

export declare class TicketCreatedEvidence {
  private constructor()
  private readonly __ticketCreated: true
  readonly programId: ProgramId
  readonly experimentId: ExperimentId
  readonly ticketId: TicketId
}

export declare class WorkerStartedEvidence {
  private constructor()
  private readonly __workerStarted: true
  readonly ticketId: TicketId
  readonly sessionId: string
  readonly commit: CommitSha
}

export declare class CIRecordedEvidence {
  private constructor()
  private readonly __ciRecorded: true
  readonly ticketId: TicketId
  readonly experimentId: ExperimentId
  readonly ciRunId: CIRunId
}

export declare class ReviewCompletedEvidence {
  private constructor()
  private readonly __reviewCompleted: true
  readonly experimentId: ExperimentId
  readonly issueId: IssueId
}

/** One typed step; the input evidence cannot be constructed by a caller. */
export interface PipelineStage<From, To> {
  run(input: From): Promise<Result<To, DomainError>>
}

/** The complete chain. Every stage is required; missing wiring is a compile error. */
export interface ResearchPipeline {
  readonly experimentToTrigger: PipelineStage<ExperimentProposedEvidence, TriggerAcceptedEvidence>
  readonly triggerToTicket: PipelineStage<TriggerAcceptedEvidence, TicketCreatedEvidence>
  readonly ticketToWorker: PipelineStage<TicketCreatedEvidence, WorkerStartedEvidence>
  readonly workerToCIRecord: PipelineStage<WorkerStartedEvidence, CIRecordedEvidence>
  readonly ciRecordToReview: PipelineStage<CIRecordedEvidence, ReviewCompletedEvidence>
}

export type PipelineStageName = keyof ResearchPipeline

/**
 * The honest default while the chain is unfinished: calling any stage throws
 * UnimplementedError instead of pretending to proceed. Once a stage is implemented it
 * returns the nominal evidence of the next stage.
 */
export function createUnimplementedPipeline(): ResearchPipeline {
  // TODO(@experiment-to-ticket): deliver experiment.proposed to the Source Eval and
  // return TriggerAcceptedEvidence only after the trigger is accepted.
  // TODO(@implementer-ticket-execution): create the Implementer Ticket and return
  // TicketCreatedEvidence only after the executor assigns a Worker.
  // TODO(@ci-evaluation-writeback): run the environment/CI and return CIRecordedEvidence.
  // TODO(@researcher-review-loop): return ReviewCompletedEvidence only after the
  // Researcher review is recorded and the Issue/Experiment have transitioned.
  return {
    experimentToTrigger: {
      run: async () => unimplemented('experiment-to-ticket', 'Source Eval delivery is not wired'),
    },
    triggerToTicket: {
      run: async () => unimplemented('experiment-to-ticket', 'Ticket creation after Eval accept is not wired'),
    },
    ticketToWorker: {
      run: async () => unimplemented('implementer-ticket-execution', 'Executor/Worker start is not wired'),
    },
    workerToCIRecord: {
      run: async () => unimplemented('ci-evaluation-writeback', 'CI execution and CIRecord writeback are not wired'),
    },
    ciRecordToReview: {
      run: async () => unimplemented('researcher-review-loop', 'Researcher review loop is not wired'),
    },
  }
}
