/** CI runs: requested by a Researcher, executed by the Host in the PR environment. */
import type { ArtifactRef } from './artifacts.js'
import type { CIRunId, CommitSha, IsoTimestamp, ExperimentId, ResearcherSessionId, Score } from './ids.js'

export type CIStatus = 'requested' | 'running' | 'passed' | 'failed'
export type CIFailureReason =
  | 'environment-build-failed'
  | 'entry-failed'
  | 'invalid-score'
  | 'timeout'
  | 'infrastructure'

interface CIRunBase {
  readonly id: CIRunId
  readonly experimentId: ExperimentId
  readonly commit: CommitSha
  readonly requestedBy: ResearcherSessionId
  readonly requestedAt: IsoTimestamp
}

export interface RequestedCIRun extends CIRunBase {
  readonly status: 'requested'
}

export interface RunningCIRun extends CIRunBase {
  readonly status: 'running'
  readonly startedAt: IsoTimestamp
  /** Digest of the environment the run used; a started run always has one. */
  readonly environmentDigest: string
}

export interface PassedCIRun extends CIRunBase {
  readonly status: 'passed'
  readonly startedAt: IsoTimestamp
  readonly environmentDigest: string
  readonly finishedAt: IsoTimestamp
  readonly score: Score
  readonly checks: readonly CheckResult[]
  /** Persisted results such as model weights and reports. */
  readonly artifacts: readonly ArtifactRef[]
  readonly logPath: string
  readonly durationMs: number
}

export interface FailedCIRun extends CIRunBase {
  readonly status: 'failed'
  readonly startedAt: IsoTimestamp
  readonly environmentDigest: string
  readonly finishedAt: IsoTimestamp
  readonly reason: CIFailureReason
  readonly detail: string
  readonly logPath: string
}

export type CIRun = RequestedCIRun | RunningCIRun | PassedCIRun | FailedCIRun

/** One check inside a CI run; the Program contract may require several. */
export interface CheckResult {
  readonly name: string
  readonly passed: boolean
  readonly detail: string
}

export interface CIRequest {
  readonly experimentId: ExperimentId
  readonly commit: CommitSha
  readonly requestedBy: ResearcherSessionId
}
