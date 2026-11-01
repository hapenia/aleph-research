/**
 * Host service ports: CI execution, environment building, git, merge policy, Sessions
 * and attention. Implementations live in phase 2+; domain code depends only on these.
 */
import type { CIRun, CheckResult, CIRequest } from './ci.js'
import type { BuiltEnvironment, EnvironmentDeclaration, RepositorySnapshot } from './environment.js'
import type { EvaluationContract } from './program.js'

import type { DomainError, Result } from './errors.js'
import type { BranchName, CommitSha, IsoTimestamp, SessionId } from './ids.js'
import type { Attention } from './attention.js'
import type { WakeReason } from './session.js'

export interface Clock {
  now(): IsoTimestamp
}

/** Runs the Program's CI entry inside the Experiment environment. */
export interface CIRunner {
  run(request: CIExecutionRequest): Promise<CIExecutionResult>
}

export interface CIExecutionRequest {
  readonly request: CIRequest
  readonly snapshot: RepositorySnapshot
  readonly environment: BuiltEnvironment
  readonly contract: EvaluationContract
}

export type CIExecutionResult =
  | {
      readonly status: 'passed'
      readonly score: number
      readonly checks: readonly CheckResult[]
      /** Where the entry left the results the Host must persist. */
      readonly artifacts: readonly ArtifactCandidate[]
      readonly logPath: string
      readonly durationMs: number
    }
  | {
      readonly status: 'failed'
      readonly reason: string
      readonly detail: string
      readonly logPath: string
    }

/** Builds a Experiment's declared environment with uv. */
export interface EnvironmentBuilder {
  build(declaration: EnvironmentDeclaration): Promise<Result<BuiltEnvironment, DomainError>>
}

/** The Host never merges branches: research keeps experiments as snapshots. */
export interface RepositoryService {
  head(branch: BranchName): Promise<CommitSha>
  /** Copies one branch at a commit into a workspace for CI. */
  snapshot(input: { readonly branch: BranchName; readonly commit: CommitSha }): Promise<RepositorySnapshot>
}

/** Pause/stop immediately cancel the Implementer work already running. */
export interface RunCanceller {
  cancelOpenImplementers(programId: string, reason: string): Promise<readonly string[]>
}

/** Persists results across runs; declared in artifacts.ts. */
export type { ArtifactStore } from './artifacts.js'

/** Holds the resident Researcher Sessions and wakes the right one. */
export interface SessionPool {
  ensure(researcherId: string): Promise<SessionId>
  wake(sessionId: SessionId, reason: WakeReason, prompt: string): Promise<void>
  idle(): Promise<readonly SessionId[]>
}

export interface AttentionSink {
  raise(attention: Attention): Promise<void>
}


/** A result file a CI entry produced; the Host copies it into ArtifactStore. */
export interface ArtifactCandidate {
  readonly kind: 'model-weights' | 'report' | 'figure' | 'dataset' | 'log' | 'other'
  readonly path: string
  readonly retention: 'keep-best' | 'keep-forever' | 'discard-after-merge' | 'temporary'
}
