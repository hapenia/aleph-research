/** CI completion tokens: only the Host CI runner can mint one. */
import type { FailedCIRecord, PassedCIRecord } from './metrics.js'
import type { DomainError } from './errors.js'
import type { Result, StoreError } from './errors.js'
import type { CIRunId, CommitSha, ExperimentId, IsoTimestamp } from './ids.js'

export type CIFailureReason =
  | 'environment-build-failed'
  | 'entry-failed'
  | 'missing-required-metric'
  | 'invalid-metrics'
  | 'timeout'
  | 'infrastructure'
  | 'cancelled'

/** Proof that the Host accepted a CI request for one Experiment and commit. */
export declare class CIRequestToken {
  private constructor()
  private readonly __ciRequest: true
  readonly ciRunId: CIRunId
  readonly experimentId: ExperimentId
  readonly commit: CommitSha
  readonly requestedAt: IsoTimestamp
}

/** Proof that a specific Experiment/commit finished CI successfully. */
export declare class PassedCICompletion {
  private constructor()
  private readonly __passedCompletion: true
  readonly ciRunId: CIRunId
  /** The single source of the evidence; association is checked against its fields. */
  readonly record: PassedCIRecord
}

/** Proof that a specific Experiment/commit failed CI for a stated reason. */
export declare class FailedCICompletion {
  private constructor()
  private readonly __failedCompletion: true
  readonly ciRunId: CIRunId
  /** The single source of the evidence; association is checked against its fields. */
  readonly record: FailedCIRecord
}
