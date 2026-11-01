/** Raw multi-metric CI records; research quality is not one number. */
import type {
  CIRunId,
  CommitSha,
  ExperimentId,
  IsoTimestamp,
  MetricName,
  NonNegativeNumber,
  PositiveInt,
  ProgramId,
} from './ids.js'

export type MetricDirection = 'higher' | 'lower'

export interface MetricDefinition {
  readonly name: MetricName
  readonly direction: MetricDirection
  readonly weight: PositiveInt
  readonly required: boolean
}

export type MetricMap = ReadonlyMap<MetricName, number>

/** One raw CI result row; every view is derived from these at query time. */
export interface CIRecord {
  readonly id: CIRunId
  readonly programId: ProgramId
  readonly experimentId: ExperimentId
  readonly commit: CommitSha
  readonly at: IsoTimestamp
  readonly metrics: MetricMap
  /** False when a required metric is missing; such rows never enter sampling. */
  readonly acceptedForSampling: boolean
}

export type MetricSort = { readonly metric: MetricName; readonly direction: MetricDirection }

export interface MetricQuery {
  readonly programId: ProgramId
  readonly experimentId?: ExperimentId
  readonly sort?: readonly MetricSort[]
  readonly aggregate?: 'latest' | 'average' | 'min' | 'max'
  readonly limit?: PositiveInt
}

export interface MetricSummary {
  readonly metric: MetricName
  readonly value: NonNegativeNumber
}

export interface MetricQueryResult {
  readonly rows: readonly CIRecord[]
  readonly summaries: readonly MetricSummary[]
}
