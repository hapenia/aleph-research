/**
 * Host service ports. Implementations live in the adapter; the domain depends only on
 * these interfaces. Each one names the exact input and output types.
 */
import type { ArtifactCandidate, ArtifactStore } from './artifacts.js'
import type { Attention } from './attention.js'
import type { CIFailureReason } from './ci.js'
import type { BuiltEnvironment, EnvironmentDeclaration, RepositorySnapshot } from './environment.js'
import type { MetricMap } from './metrics.js'
import type { ExperimentId, ImplementerSessionId, IsoTimestamp, ProgramId, ResearcherSessionId, TicketId } from './ids.js'
import type { DomainError, Result } from './errors.js'
import type { Sampler } from './sampling.js'

export interface Clock {
  now(): IsoTimestamp
}

/** Builds an Experiment's uv environment from its declaration and snapshot. */
export interface EnvironmentBuilder {
  build(declaration: EnvironmentDeclaration, snapshot: RepositorySnapshot): Promise<Result<BuiltEnvironment, DomainError>>
}

/** Copies a branch at a commit into a workspace the CI can run in. */
export interface RepositoryService {
  snapshot(branch: string, commit: string): Promise<Result<RepositorySnapshot, DomainError>>
}

export interface CIExecutionInput {
  readonly experimentId: ExperimentId
  readonly commit: string
  readonly environment: BuiltEnvironment
  /** The Program's evaluation contract: entry, timeout, required metrics. */
  readonly ciEntry: string
  readonly timeoutMs: number
  readonly requiredMetrics: readonly string[]
}

export type CIExecutionResult =
  | {
      readonly status: 'passed'
      readonly metrics: MetricMap
      readonly artifacts: readonly ArtifactCandidate[]
      readonly durationMs: number
      readonly logPath: string
    }
  | {
      readonly status: 'failed'
      readonly reason: CIFailureReason
      readonly detail: string
      readonly logPath: string
    }

export interface CIRunner {
  run(input: CIExecutionInput): Promise<Result<CIExecutionResult, DomainError>>
}

/** Pause/stop cancels in-flight Implementer work and pending CI. */
export interface RunCanceller {
  cancelProgram(programId: ProgramId, reason: string): Promise<readonly TicketId[]>
}

export interface SessionPool {
  ensureResearcher(sessionId: ResearcherSessionId): Promise<void>
  ensureImplementer(ticketId: TicketId): Promise<ImplementerSessionId>
  wakeResearcher(sessionId: ResearcherSessionId, message: string): Promise<void>
}

export interface AttentionSink {
  raise(attention: Attention): Promise<void>
}

export type { ArtifactStore, Sampler }
