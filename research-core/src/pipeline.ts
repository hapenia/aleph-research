import type { DomainError, Result } from './types/errors.js'
import type { CommitSha, ExperimentId, IssueId, ProgramId, TicketId } from './types/ids.js'
import type { BenchmarkRecord, ResearcherDecision } from './benchmark.js'

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

export declare class BenchmarkPassed {
  private constructor()
  private readonly __benchmarkPassed: true
  readonly record: BenchmarkRecord
}

export declare class BenchmarkFailed {
  private constructor()
  private readonly __benchmarkFailed: true
  readonly record: BenchmarkRecord
  readonly reason: string
}

export declare class BenchmarkRetryable {
  private constructor()
  private readonly __benchmarkRetryable: true
  readonly benchmarkRunId: string
  readonly attempt: number
  readonly maxAttempts: number
  readonly reason: string
}

export declare class ResultRecorded {
  private constructor()
  private readonly __resultRecorded: true
  readonly record: BenchmarkRecord
}

export declare class ReviewRecorded {
  private constructor()
  private readonly __reviewRecorded: true
  readonly experimentId: ExperimentId
  readonly issueId: IssueId
  readonly decision: ResearcherDecision
}

export declare class ResearchCompleted {
  private constructor()
  private readonly __researchCompleted: true
  readonly experimentId: ExperimentId
  readonly issueId: IssueId
  readonly outcome: 'concluded' | 'failed' | 'cancelled'
}

export interface Step<From, To> {
  run(input: From): Promise<Result<To, DomainError>>
}

export interface ResearchPipeline {
  readonly deliverTrigger: Step<ExperimentProposed, TriggerAccepted>
  readonly openTicket: Step<TriggerAccepted, TicketOpened>
  readonly startWorker: Step<TicketOpened, WorkerStarted>
  readonly submitCommit: Step<WorkerStarted, CommitSubmitted>
  readonly buildEnvironment: Step<CommitSubmitted, EnvironmentBuilt>
  readonly runBenchmark: Step<EnvironmentBuilt, BenchmarkPassed | BenchmarkFailed | BenchmarkRetryable>
  readonly retryBenchmark: Step<BenchmarkRetryable, EnvironmentBuilt>
  readonly recordResult: Step<BenchmarkPassed, ResultRecorded>
  readonly reviewResult: Step<ResultRecorded, ReviewRecorded>
  readonly closePassed: Step<ReviewRecorded, ResearchCompleted>
  readonly closeFailed: Step<BenchmarkFailed | BenchmarkRetryable, ResearchCompleted>
}

export type StepName = keyof ResearchPipeline
