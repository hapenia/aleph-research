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

/**
 * A write route only parses. It cannot fabricate a success or choose another command:
 * the generic `executeRoute` takes the route key, the typed actor and the executor.
 */
export type ApiWriteRoutes = {
  readonly [K in CommandType]: (input: unknown) => Result<CommandOf<K>, DomainError>
}

export declare function executeRoute<K extends CommandType>(
  routes: ApiWriteRoutes,
  executor: CommandExecutor,
  actor: ActorOfCommand<K>,
  route: K,
  input: unknown,
): Promise<CommandOutcome<K>>

/** The panel surface; read-only and the only non-write route family. */
export interface PanelApi {
  snapshot(actor: Principal, programId: ProgramId): Promise<ApiResponse<ProgramSnapshot>>
}
