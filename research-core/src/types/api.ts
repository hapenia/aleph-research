/**
 * Management API and the read-only panel DTOs. Routes are actor-typed, every failure is
 * a DomainFailure whose status follows from the refusal code, and every body passes a
 * parser before it becomes a command.
 */
import type { OperatorPrincipal, Principal, ResearcherPrincipal } from './actors.js'
import type { ArtifactRef } from './artifacts.js'
import type { Attention } from './attention.js'
import type { AuditEntry } from './audit.js'
import type { CIRecord } from './metrics.js'
import type { Experiment } from './experiment.js'
import type { Issue, IssueComment } from './issue.js'
import type { ExplorationLevel, PausedProgram, Program, RunningProgram, StoppedProgram } from './program.js'
import type { ActorOfCommand, CommandOf, CommandOutcome, CommandType } from './commands.js'
import type { CommandExecutor } from './executor.js'
import type { DomainError, DomainFailure, Result } from './errors.js'
import type { ExperimentId, IssueId, NonEmptyString, NonEmptyArray, ProgramId } from './ids.js'

export type ApiResponse<T> =
  | { readonly ok: true; readonly value: T; readonly audit: readonly AuditEntry[] }
  | (DomainFailure & { readonly audit: readonly AuditEntry[] })

/** The panel's single read model; raw CI records only, views derived at query time. */
export interface ProgramSnapshot {
  readonly program: Program
  readonly issues: readonly Issue[]
  readonly comments: readonly IssueComment[]
  readonly experiments: readonly Experiment[]
  readonly ciRecords: readonly CIRecord[]
  readonly artifacts: readonly ArtifactRef[]
  readonly attention: readonly Attention[]
  readonly audit: readonly AuditEntry[]
}

/** Raw HTTP bodies; only parsers turn these into commands. */
export interface CreateProgramDto {
  readonly name: string
  readonly goal: string
  readonly methodology: string
  readonly contract: {
    readonly ciEntry: string
    readonly timeoutMs: number
    readonly requiredMetrics: readonly string[]
  }
  readonly utility: {
    readonly metrics: readonly {
      readonly name: string
      readonly direction: string
      readonly weight: number
      readonly required: boolean
    }[]
  }
  readonly exploration: string
  readonly budget: {
    readonly maxExperiments: number
    readonly maxComputeMinutes: number
    readonly maxTokens: number
  }
}

export interface CreateIssueDto {
  readonly programId: string
  readonly title: string
  readonly body: string
  readonly labels: readonly string[]
}

/** Parsers refine untrusted bodies into commands; validation errors are domain refusals. */
export interface RequestParsers {
  createProgram(input: unknown): Result<CommandOf<'program.create'>, DomainError>
  pauseProgram(input: unknown): Result<CommandOf<'program.pause'>, DomainError>
  resumeProgram(input: unknown): Result<CommandOf<'program.resume'>, DomainError>
  stopProgram(input: unknown): Result<CommandOf<'program.stop'>, DomainError>
  setGoal(input: unknown): Result<CommandOf<'program.set-goal'>, DomainError>
  setMethodology(input: unknown): Result<CommandOf<'program.set-methodology'>, DomainError>
  setExploration(input: unknown): Result<CommandOf<'program.set-exploration'>, DomainError>
  createIssue(input: unknown): Result<CommandOf<'issue.create'>, DomainError>
  claimIssue(input: unknown): Result<CommandOf<'issue.claim'>, DomainError>
  commentIssue(input: unknown): Result<CommandOf<'issue.comment'>, DomainError>
  closeIssue(input: unknown): Result<CommandOf<'issue.close'>, DomainError>
  proposeExperiment(input: unknown): Result<CommandOf<'experiment.propose'>, DomainError>
  reviewExperiment(input: unknown): Result<CommandOf<'experiment.review'>, DomainError>
  closeExperiment(input: unknown): Result<CommandOf<'experiment.close'>, DomainError>
  requestCI(input: unknown): Result<CommandOf<'ci.request'>, DomainError>
}

/**
 * Every write route is an executor call with the command's own actor type. A handler
 * cannot write state directly: it receives the executor and returns its typed outcome,
 * and the HTTP layer only maps the outcome to a status.
 */
export type ApiWriteRoutes = {
  readonly [K in CommandType]: (
    executor: CommandExecutor,
    actor: ActorOfCommand<K>,
    input: unknown,
  ) => Promise<CommandOutcome<K>>
}

/** The panel surface; read-only and the only non-write route family. */
export interface PanelApi {
  snapshot(actor: Principal, programId: ProgramId): Promise<ApiResponse<ProgramSnapshot>>
}
