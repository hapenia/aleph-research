/** CI records: every run is stored with its status; views are derived at query time. */
import type { ArtifactRef } from './artifacts.js'
import type { CIFailureReason } from './ci.js'
import type {
  CIRunId,
  CommitSha,
  DurationMs,
  ExperimentId,
  IsoTimestamp,
  MetricName,
  PositiveNumber,
  ProgramId,
  ResearcherSessionId,
} from './ids.js'

export type MetricDirection = 'higher' | 'lower'

export interface MetricDefinition {
  readonly name: MetricName
  readonly direction: MetricDirection
  readonly weight: PositiveNumber
  readonly required: boolean
}

export type MetricMap = ReadonlyMap<MetricName, number>

interface CIRecordBase {
  readonly id: CIRunId
  readonly programId: ProgramId
  readonly experimentId: ExperimentId
  readonly commit: CommitSha
  readonly requestedBy: ResearcherSessionId
  readonly requestedAt: IsoTimestamp
}

export interface RequestedCIRecord extends CIRecordBase {
  readonly status: 'requested'
}

export interface RunningCIRecord extends CIRecordBase {
  readonly status: 'running'
  readonly startedAt: IsoTimestamp
  readonly environmentDigest: string
}

export interface PassedCIRecord extends CIRecordBase {
  readonly status: 'passed'
  readonly startedAt: IsoTimestamp
  readonly finishedAt: IsoTimestamp
  readonly environmentDigest: string
  readonly metrics: MetricMap
  readonly artifacts: readonly ArtifactRef[]
  readonly durationMs: DurationMs
}

export interface FailedCIRecord extends CIRecordBase {
  readonly status: 'failed'
  readonly startedAt?: IsoTimestamp
  readonly finishedAt: IsoTimestamp
  readonly environmentDigest?: string
  readonly reason: CIFailureReason
  readonly detail: string
  readonly durationMs: DurationMs
}

/** Every run is persisted; only passed records feed the sampler. */
export type CIRecord = RequestedCIRecord | RunningCIRecord | PassedCIRecord | FailedCIRecord

export type MetricSort = { readonly metric: MetricName; readonly direction: MetricDirection }

export interface MetricQuery {
  readonly programId: ProgramId
  readonly experimentId?: ExperimentId
  readonly sort?: readonly MetricSort[]
  readonly aggregate?: 'latest' | 'average' | 'min' | 'max'
  readonly limit?: PositiveNumber
}

/** Aggregates are computed at query time, never stored. */
export interface MetricSummary {
  readonly metric: MetricName
  readonly value: number
}

export interface MetricQueryResult {
  readonly rows: readonly CIRecord[]
  readonly summaries: readonly MetricSummary[]
}

