/** CI runs: requested by a Researcher, executed by the Host in the declaration env. */
import type { ArtifactRef } from './artifacts.js'
import type { HostPrincipal, ResearcherPrincipal } from './actors.js'
import type { MetricMap } from './metrics.js'
import type { CIRunId, CommitSha, DurationMs, ExperimentId, IsoTimestamp, NonEmptyString } from './ids.js'

export type CIFailureReason =
  | 'environment-build-failed'
  | 'entry-failed'
  | 'missing-required-metric'
  | 'invalid-metrics'
  | 'timeout'
  | 'infrastructure'

export interface CIRequest {
  readonly experimentId: ExperimentId
  readonly commit: CommitSha
  readonly requestedBy: ResearcherPrincipal
}

export declare class RequestedCIRun {
  private constructor()
  private readonly __requested: true
  readonly status: 'requested'
  readonly id: CIRunId
  readonly experimentId: ExperimentId
  readonly commit: CommitSha
  readonly requestedBy: ResearcherPrincipal
  readonly requestedAt: IsoTimestamp
  start(actor: HostPrincipal, environmentDigest: string, at: IsoTimestamp): RunningCIRun
}

export declare class RunningCIRun {
  private constructor()
  private readonly __running: true
  readonly status: 'running'
  readonly id: CIRunId
  readonly experimentId: ExperimentId
  readonly commit: CommitSha
  readonly requestedBy: ResearcherPrincipal
  readonly requestedAt: IsoTimestamp
  readonly startedAt: IsoTimestamp
  readonly environmentDigest: string
  pass(
    actor: HostPrincipal,
    metrics: MetricMap,
    artifacts: readonly ArtifactRef[],
    durationMs: DurationMs,
  ): PassedCIRun
  fail(actor: HostPrincipal, reason: CIFailureReason, detail: NonEmptyString): FailedCIRun
}

export declare class PassedCIRun {
  private constructor()
  private readonly __passed: true
  readonly status: 'passed'
  readonly id: CIRunId
  readonly experimentId: ExperimentId
  readonly commit: CommitSha
  readonly requestedBy: ResearcherPrincipal
  readonly requestedAt: IsoTimestamp
  readonly startedAt: IsoTimestamp
  readonly finishedAt: IsoTimestamp
  readonly environmentDigest: string
  readonly metrics: MetricMap
  readonly artifacts: readonly ArtifactRef[]
  readonly durationMs: DurationMs
}

export declare class FailedCIRun {
  private constructor()
  private readonly __failed: true
  readonly status: 'failed'
  readonly id: CIRunId
  readonly experimentId: ExperimentId
  readonly commit: CommitSha
  readonly requestedBy: ResearcherPrincipal
  readonly requestedAt: IsoTimestamp
  readonly startedAt: IsoTimestamp
  readonly finishedAt: IsoTimestamp
  readonly environmentDigest: string
  readonly reason: CIFailureReason
  readonly detail: NonEmptyString
}

export type CIRun = RequestedCIRun | RunningCIRun | PassedCIRun | FailedCIRun
