import type { BenchmarkRecord, ResearcherDecision } from '../../src/benchmark.js'
import type { CommitSha, ExperimentId, IssueId, ProgramId, TicketId } from '../../src/types/ids.js'
import type {
  BenchmarkFailed,
  BenchmarkPassed,
  BenchmarkRetryable,
  CommitSubmitted,
  EnvironmentBuilt,
  ExperimentProposed,
  ResearchCompleted,
  ResultRecorded,
  ReviewRecorded,
  TicketOpened,
  TriggerAccepted,
  WorkerStarted,
} from '../../src/pipeline.js'

function stage<T>(value: object): T {
  return Object.freeze(value) as unknown as T
}

export function createExperimentProposed(input: {
  readonly programId: ProgramId
  readonly issueId: IssueId
  readonly experimentId: ExperimentId
  readonly planCommentId: string
}): ExperimentProposed {
  return stage<ExperimentProposed>(input)
}

export function createTriggerAccepted(input: {
  readonly programId: ProgramId
  readonly experimentId: ExperimentId
  readonly triggerId: string
  readonly threadId: string
}): TriggerAccepted {
  return stage<TriggerAccepted>(input)
}

export function createTicketOpened(input: {
  readonly programId: ProgramId
  readonly experimentId: ExperimentId
  readonly ticketId: TicketId
}): TicketOpened {
  return stage<TicketOpened>(input)
}

export function createWorkerStarted(input: {
  readonly ticketId: TicketId
  readonly workerSessionId: string
}): WorkerStarted {
  return stage<WorkerStarted>(input)
}

export function createCommitSubmitted(input: {
  readonly ticketId: TicketId
  readonly commit: CommitSha
}): CommitSubmitted {
  return stage<CommitSubmitted>(input)
}

export function createEnvironmentBuilt(input: {
  readonly ticketId: TicketId
  readonly commit: CommitSha
  readonly environmentDigest: string
}): EnvironmentBuilt {
  return stage<EnvironmentBuilt>(input)
}

export function createBenchmarkPassed(input: {
  readonly record: BenchmarkRecord
}): BenchmarkPassed {
  return stage<BenchmarkPassed>(input)
}

export function createBenchmarkFailed(input: {
  readonly record: BenchmarkRecord
  readonly reason: string
}): BenchmarkFailed {
  return stage<BenchmarkFailed>(input)
}

export function createBenchmarkRetryable(input: {
  readonly record: BenchmarkRecord
  readonly benchmarkRunId: string
  readonly attempt: number
  readonly maxAttempts: number
  readonly reason: string
}): BenchmarkRetryable {
  return stage<BenchmarkRetryable>(input)
}

export function createResultRecorded(input: {
  readonly record: BenchmarkRecord
}): ResultRecorded {
  return stage<ResultRecorded>(input)
}

export function createReviewRecorded(input: {
  readonly experimentId: ExperimentId
  readonly issueId: IssueId
  readonly decision: ResearcherDecision
}): ReviewRecorded {
  return stage<ReviewRecorded>(input)
}

export function createResearchCompleted(input: {
  readonly experimentId: ExperimentId
  readonly issueId: IssueId
  readonly outcome: 'concluded' | 'failed' | 'cancelled'
}): ResearchCompleted {
  return stage<ResearchCompleted>(input)
}
