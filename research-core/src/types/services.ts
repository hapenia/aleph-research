/**
 * Host service ports: CI execution, environment building, git, merge policy, Sessions
 * and attention. Implementations live in phase 2+; domain code depends only on these.
 */
import type { CIRun, CheckResult, CIRequest } from './ci.js'
import type { BuiltEnvironment, EnvironmentDeclaration, RepositorySnapshot } from './environment.js'
import type { EvaluationContract, AcceptanceRule, Program } from './program.js'
import type { PullRequest } from './pull-request.js'
import type { DomainError, Result } from './errors.js'
import type { BranchName, CommitSha, IsoTimestamp, SessionId } from './ids.js'
import type { Attention } from './attention.js'
import type { WakeReason } from './session.js'

export interface Clock {
  now(): IsoTimestamp
}

/** Runs the Program's CI entry inside the Pull request environment. */
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
      readonly logPath: string
      readonly durationMs: number
    }
  | {
      readonly status: 'failed'
      readonly reason: string
      readonly detail: string
      readonly logPath: string
    }

/** Builds a Pull request's declared environment with uv. */
export interface EnvironmentBuilder {
  build(declaration: EnvironmentDeclaration): Promise<Result<BuiltEnvironment, DomainError>>
}

export interface GitService {
  head(branch: BranchName): Promise<CommitSha>
  merge(input: {
    readonly branch: BranchName
    readonly into: BranchName
    readonly message: string
  }): Promise<Result<{ readonly mergeCommit: CommitSha }, DomainError>>
}

/** Result of applying the Program's acceptance rule to a Pull request. */
export interface MergeDecision {
  readonly allowed: boolean
  readonly ruleTrace: readonly RuleEvaluation[]
  readonly reason: string
}

export interface RuleEvaluation {
  readonly rule: AcceptanceRule
  readonly passed: boolean
  readonly detail: string
}

/** The Host decides merges; a model only proposes them. */
export interface MergeGate {
  decide(program: Program, pullRequest: PullRequest, ciRun: CIRun): MergeDecision
}

/** Holds the resident Researcher Sessions and wakes the right one. */
export interface SessionPool {
  ensure(researcherId: string): Promise<SessionId>
  wake(sessionId: SessionId, reason: WakeReason, prompt: string): Promise<void>
  idle(): Promise<readonly SessionId[]>
}

export interface AttentionSink {
  raise(attention: Attention): Promise<void>
}
