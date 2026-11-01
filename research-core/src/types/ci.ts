/** CI completion tokens: only the Host CI runner can mint one. */
import type { ArtifactRef } from './artifacts.js'
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

/** Proof that a specific Experiment/commit finished CI successfully. */
export declare class PassedCICompletion {
  private constructor()
  private readonly __passedCompletion: true
  readonly record: PassedCIRecord
  readonly ciRunId: CIRunId
  readonly experimentId: ExperimentId
  readonly commit: CommitSha
  readonly metrics: PassedCIRecord['metrics']
  readonly artifacts: readonly ArtifactRef[]
  readonly environmentDigest: string
  readonly durationMs: PassedCIRecord['durationMs']
  readonly finishedAt: IsoTimestamp
}

/** Proof that a specific Experiment/commit failed CI for a stated reason. */
export declare class FailedCICompletion {
  private constructor()
  private readonly __failedCompletion: true
  readonly record: FailedCIRecord
  readonly ciRunId: CIRunId
  readonly experimentId: ExperimentId
  readonly commit: CommitSha
  readonly reason: CIFailureReason
  readonly detail: string
  readonly finishedAt: IsoTimestamp
}
