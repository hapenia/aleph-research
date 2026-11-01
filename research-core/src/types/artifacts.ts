/** Persisted results: model weights, reports, figures and logs. */
import type { ArtifactId, CIRunId, CommitSha, ExperimentId, IsoTimestamp, NonEmptyString, ProgramId } from './ids.js'
import type { Result, StoreError } from './errors.js'

export type ArtifactKind = 'model-weights' | 'report' | 'figure' | 'logs' | 'other'
export type ArtifactRetention = 'keep' | 'temporary'

export declare class ArtifactRef {
  private constructor()
  private readonly __artifact: true
  readonly id: ArtifactId
  readonly kind: ArtifactKind
  readonly digest: string
  readonly bytes: number
  readonly programId: ProgramId
  readonly experimentId: ExperimentId
  readonly commit: CommitSha
  readonly ciRunId: CIRunId
  readonly retention: ArtifactRetention
  readonly createdAt: IsoTimestamp
}

/** A result file the CI entry produced; the Host copies it into ArtifactStore. */
/** A typed reference the model supplies: which stored artifact to mount, and where. */
export interface ArtifactInput {
  readonly artifactId: ArtifactId
  readonly mountAs: NonEmptyString
}

export interface ArtifactCandidate {
  readonly kind: ArtifactKind
  readonly path: string
  readonly retention: ArtifactRetention
}

export interface ArtifactStore {
  put(input: {
    readonly candidate: ArtifactCandidate
    readonly programId: ProgramId
    readonly experimentId: ExperimentId
    readonly commit: CommitSha
    readonly ciRunId: CIRunId
  }): Promise<ArtifactRef>
  get(id: ArtifactId): Promise<ArtifactRef | undefined>
  listByExperiment(experimentId: ExperimentId): Promise<readonly ArtifactRef[]>
  pruneTemporary(now: IsoTimestamp): Promise<number>
}
