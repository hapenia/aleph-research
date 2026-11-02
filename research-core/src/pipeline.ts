/**
 * Typed research flow: each step consumes the previous stage value and returns the next stage value.
 * A stage value can only be created by the step that performed the action, so a caller cannot skip, reorder or replace a step.
 *
 * A stage value proves that the Host step completed; it does not prove that an external
 * service really performed the side effect. That trust boundary is explicit in the
 * factory that creates the value.
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

export declare class IssueAssigned {
  private constructor()
  private readonly __issueAssigned: true
  readonly programId: ProgramId
  readonly issueId: IssueId
  readonly assigneeSessionId: string
}

export declare class ExperimentProposed {
  private constructor()
  private readonly __experimentProposed: true
  readonly programId: ProgramId
  readonly issueId: IssueId
  readonly experimentId: ExperimentId
  readonly planCommentId: string
}

export declare class TriggerAccepted {
  private constructor()
  private readonly __triggerAccepted: true
  readonly programId: ProgramId
  readonly experimentId: ExperimentId
  readonly triggerId: string
  readonly threadId: string
}

export declare class TicketOpened {
  private constructor()
  private readonly __ticketOpened: true
  readonly programId: ProgramId
  readonly experimentId: ExperimentId
  readonly ticketId: TicketId
}

export declare class WorkerStarted {
  private constructor()
  private readonly __workerStarted: true
  readonly ticketId: TicketId
  readonly workerSessionId: string
}

export declare class CommitSubmitted {
  private constructor()
  private readonly __commitSubmitted: true
  readonly ticketId: TicketId
  readonly commit: CommitSha
}

export declare class EnvironmentBuilt {
  private constructor()
  private readonly __environmentBuilt: true
  readonly ticketId: TicketId
  readonly commit: CommitSha
  readonly environmentDigest: string
}

export declare class CIPassed {
  private constructor()
  private readonly __ciPassed: true
  readonly ticketId: TicketId
  readonly experimentId: ExperimentId
  readonly ciRunId: CIRunId
  readonly commit: CommitSha
}

export declare class CIFailed {
  private constructor()
  private readonly __ciFailed: true
  readonly ticketId: TicketId
  readonly experimentId: ExperimentId
  readonly ciRunId: CIRunId
  readonly commit: CommitSha
  readonly reason: string
}

export declare class ResultRecorded {
  private constructor()
  private readonly __resultRecorded: true
  readonly experimentId: ExperimentId
  readonly ciRunId: CIRunId
}

export declare class ReviewRecorded {
  private constructor()
  private readonly __reviewRecorded: true
  readonly experimentId: ExperimentId
  readonly issueId: IssueId
  readonly verdict: 'approve' | 'request-changes' | 'comment'
}

export declare class ResearchCompleted {
  private constructor()
  private readonly __researchCompleted: true
  readonly experimentId: ExperimentId
  readonly issueId: IssueId
  readonly outcome: 'concluded' | 'failed' | 'cancelled'
}

/** One typed step; its input receipt cannot be constructed by a caller. */
export interface Step<From, To> {
  run(input: From): Promise<Result<To, DomainError>>
}

/** The complete chain. Every step is required; missing wiring is a compile error. */
export interface ResearchPipeline {
  readonly deliverTrigger: Step<ExperimentProposed, TriggerAccepted>
  readonly openTicket: Step<TriggerAccepted, TicketOpened>
  readonly startWorker: Step<TicketOpened, WorkerStarted>
  readonly submitCommit: Step<WorkerStarted, CommitSubmitted>
  readonly buildEnvironment: Step<CommitSubmitted, EnvironmentBuilt>
  readonly runCI: Step<EnvironmentBuilt, CIPassed | CIFailed>
  readonly recordResult: Step<CIPassed, ResultRecorded>
  readonly reviewResult: Step<ResultRecorded, ReviewRecorded>
  readonly closePassed: Step<ReviewRecorded, ResearchCompleted>
  readonly closeFailed: Step<CIFailed, ResearchCompleted>
}

export type StepName = keyof ResearchPipeline

/*
 * There is deliberately no unimplemented pipeline factory here.
 *
 * A complete `ResearchPipeline` is a production requirement, and tests must supply an
 * in-memory `FakePipeline` that actually implements every step. A factory that returns a
 * complete-looking object whose methods throw would let incomplete wiring pass the type
 * check and only fail at runtime, which is exactly what this blueprint is preventing.
 *
 * A specific unimplemented seam may throw `unimplemented(feature)` at its own call site;
 * it must not be wrapped into a whole pipeline.
 */
