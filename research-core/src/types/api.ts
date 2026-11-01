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
import type {
  CIPendingExperiment,
  ClosedExperiment,
  Experiment,
  ExperimentReview,
  OpenExperiment,
} from './experiment.js'
import type { AssignedIssue, ClosedIssue, Issue, IssueComment, OpenIssue } from './issue.js'
import type { ExplorationLevel, PausedProgram, Program, RunningProgram, StoppedProgram } from './program.js'
import type { CommandOf } from './commands.js'
import type { DomainError, DomainFailure, Result } from './errors.js'
import type { ExperimentId, IssueId, NonEmptyString, ProgramId } from './ids.js'

export type ApiResponse<T> = { readonly ok: true; readonly value: T } | DomainFailure

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

/** Route surface; the actor parameter is the compile-time authorization. */
export interface ManagementApi {
  createProgram(actor: OperatorPrincipal, body: unknown): Promise<ApiResponse<RunningProgram>>
  pauseProgram(actor: OperatorPrincipal, programId: ProgramId): Promise<ApiResponse<PausedProgram>>
  resumeProgram(actor: OperatorPrincipal, programId: ProgramId): Promise<ApiResponse<RunningProgram>>
  stopProgram(actor: OperatorPrincipal, programId: ProgramId): Promise<ApiResponse<StoppedProgram>>
  setGoal(actor: OperatorPrincipal, programId: ProgramId, goal: NonEmptyString): Promise<ApiResponse<RunningProgram>>
  setMethodology(actor: OperatorPrincipal, programId: ProgramId, methodology: NonEmptyString): Promise<ApiResponse<RunningProgram>>
  setExploration(actor: OperatorPrincipal, programId: ProgramId, level: ExplorationLevel): Promise<ApiResponse<RunningProgram>>
  createIssue(actor: OperatorPrincipal | ResearcherPrincipal, body: unknown): Promise<ApiResponse<OpenIssue>>
  claimIssue(actor: ResearcherPrincipal, issueId: IssueId): Promise<ApiResponse<AssignedIssue>>
  commentIssue(actor: OperatorPrincipal | ResearcherPrincipal, issueId: IssueId, body: unknown): Promise<ApiResponse<IssueComment>>
  closeIssue(actor: OperatorPrincipal | ResearcherPrincipal, issueId: IssueId, body: unknown): Promise<ApiResponse<ClosedIssue>>
  proposeExperiment(actor: ResearcherPrincipal, issueId: IssueId, body: unknown): Promise<ApiResponse<OpenExperiment>>
  reviewExperiment(actor: ResearcherPrincipal, experimentId: ExperimentId, body: unknown): Promise<ApiResponse<ExperimentReview>>
  closeExperiment(actor: ResearcherPrincipal, experimentId: ExperimentId, body: unknown): Promise<ApiResponse<ClosedExperiment>>
  requestCI(actor: ResearcherPrincipal, experimentId: ExperimentId): Promise<ApiResponse<CIPendingExperiment>>
  snapshot(actor: Principal, programId: ProgramId): Promise<ApiResponse<ProgramSnapshot>>
}
