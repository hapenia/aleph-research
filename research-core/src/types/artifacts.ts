/**
 * Artifacts: results that must outlive a CI run.
 *
 * Model weights, reports, figures and datasets are stored, not discarded after
 * evaluation. The Host owns an artifact store on its filesystem; the domain keeps
 * typed references, sizes and retention class so best results stay reproducible.
 */
import type { CIRunId, CommitSha, IsoTimestamp, ProgramId, ExperimentId, Score } from './ids.js'

export type ArtifactKind = 'model-weights' | 'report' | 'figure' | 'dataset' | 'log' | 'other'

export type ArtifactRetention = 'keep-best' | 'keep-forever' | 'discard-after-merge' | 'temporary'

/** A content-addressed reference; the bytes live in the Host artifact store. */
export interface ArtifactRef {
  readonly id: string
  readonly kind: ArtifactKind
  /** SHA-256 of the content, so identical results deduplicate. */
  readonly digest: string
  readonly bytes: number
  readonly programId: ProgramId
  readonly experimentId: ExperimentId
  readonly commit: CommitSha
  readonly ciRunId: CIRunId
  /** The score this artifact was produced with; absent for logs and figures. */
  readonly score?: Score
  readonly retention: ArtifactRetention
  readonly createdAt: IsoTimestamp
}

export interface ArtifactMetadata {
  readonly ref: ArtifactRef
  readonly programId: ProgramId
  readonly createdAt: IsoTimestamp
  readonly deletedAt?: IsoTimestamp
}

/** Port to the Host artifact store; failures are infrastructure errors, not domain refusals. */
export interface ArtifactStore {
  put(input: {
    readonly kind: ArtifactKind
    readonly sourcePath: string
    readonly programId: ProgramId
    readonly experimentId: ExperimentId
    readonly commit: CommitSha
    readonly ciRunId: CIRunId
    readonly score?: Score
    readonly retention: ArtifactRetention
  }): Promise<ArtifactRef>
  get(id: string): Promise<ArtifactMetadata | undefined>
  listByProgram(programId: ProgramId): Promise<readonly ArtifactMetadata[]>
  /** Deletes only artifacts whose retention allows it. */
  prune(now: IsoTimestamp): Promise<number>
}
