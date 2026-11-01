/** Program: goal, methodology, metrics contract, exploration level, budget and status. */
import type { HostPrincipal, OperatorPrincipal } from './actors.js'
import type { DomainError, Result, StoreError } from './errors.js'
import type { DurationMs, IsoTimestamp, MetricName, NonEmptyArray, NonEmptyString, NonNegativeNumber, PositiveInt, ProgramId } from './ids.js'
import type { MetricDefinition } from './metrics.js'

export type ExplorationLevel = 'low' | 'normal' | 'high'

export interface EvaluationContract {
  readonly ciEntry: NonEmptyString
  readonly timeoutMs: DurationMs
  /** Every CI record must contain these metrics to be usable; others may be reported. */
  readonly requiredMetrics: NonEmptyArray<MetricName>
}

export interface UtilityConfig {
  readonly metrics: NonEmptyArray<MetricDefinition>
}

export interface Budget {
  readonly maxExperiments: PositiveInt
  readonly maxComputeMinutes: PositiveInt
  readonly maxTokens: PositiveInt
}

export interface BudgetUsage {
  readonly experiments: NonNegativeNumber
  readonly computeMinutes: NonNegativeNumber
  readonly tokens: NonNegativeNumber
}

/** Host-recorded, monotonic deltas; negative usage cannot be expressed. */
export interface UsageDelta {
  readonly experiments: NonNegativeNumber
  readonly computeMinutes: NonNegativeNumber
  readonly tokens: NonNegativeNumber
}

interface ProgramCommon {
  readonly id: ProgramId
  readonly name: NonEmptyString
  readonly goal: NonEmptyString
  readonly methodology: NonEmptyString
  readonly contract: EvaluationContract
  readonly utility: UtilityConfig
  readonly exploration: ExplorationLevel
  readonly budget: Budget
  readonly usage: BudgetUsage
  readonly createdAt: IsoTimestamp
}

export declare class RunningProgram implements ProgramCommon {
  private constructor()
  private readonly __running: true
  readonly status: 'running'
  readonly id: ProgramId
  readonly name: NonEmptyString
  readonly goal: NonEmptyString
  readonly methodology: NonEmptyString
  readonly contract: EvaluationContract
  readonly utility: UtilityConfig
  readonly exploration: ExplorationLevel
  readonly budget: Budget
  readonly usage: BudgetUsage
  readonly createdAt: IsoTimestamp
  static create(input: Omit<RunningProgram, 'status' | 'pause' | 'pauseForBudget' | 'stop' | 'complete' | 'setGoal' | 'setMethodology' | 'setExploration' | 'recordUsage'>): RunningProgram
  static fromRow(row: unknown): Result<RunningProgram, StoreError>
  pause(actor: OperatorPrincipal, at: IsoTimestamp): PausedProgram
  /** The Host pauses without an operator when a budget counter is exhausted. */
  pauseForBudget(actor: HostPrincipal, at: IsoTimestamp): PausedProgram
  resume(actor: OperatorPrincipal, at: IsoTimestamp): RunningProgram
  stop(actor: OperatorPrincipal, reason: NonEmptyString, at: IsoTimestamp): StoppedProgram
  complete(actor: HostPrincipal, reason: NonEmptyString, at: IsoTimestamp): CompletedProgram
  setGoal(actor: OperatorPrincipal, goal: NonEmptyString, at: IsoTimestamp): RunningProgram
  setMethodology(actor: OperatorPrincipal, methodology: NonEmptyString, at: IsoTimestamp): RunningProgram
  setExploration(actor: OperatorPrincipal, level: ExplorationLevel, at: IsoTimestamp): RunningProgram
  recordUsage(actor: HostPrincipal, delta: UsageDelta): RunningProgram
}

export declare class PausedProgram implements ProgramCommon {
  private constructor()
  private readonly __paused: true
  readonly status: 'paused'
  readonly id: ProgramId
  readonly name: NonEmptyString
  readonly goal: NonEmptyString
  readonly methodology: NonEmptyString
  readonly contract: EvaluationContract
  readonly utility: UtilityConfig
  readonly exploration: ExplorationLevel
  readonly budget: Budget
  readonly usage: BudgetUsage
  readonly createdAt: IsoTimestamp
  readonly pausedAt: IsoTimestamp
  static create(input: Omit<PausedProgram, 'status' | 'resume' | 'stop' | 'complete' | 'setGoal' | 'setMethodology' | 'setExploration' | 'recordUsage'>): PausedProgram
  static fromRow(row: unknown): Result<PausedProgram, StoreError>
  resume(actor: OperatorPrincipal, at: IsoTimestamp): RunningProgram
  stop(actor: OperatorPrincipal, reason: NonEmptyString, at: IsoTimestamp): StoppedProgram
  complete(actor: HostPrincipal, reason: NonEmptyString, at: IsoTimestamp): CompletedProgram
  setGoal(actor: OperatorPrincipal, goal: NonEmptyString, at: IsoTimestamp): PausedProgram
  setMethodology(actor: OperatorPrincipal, methodology: NonEmptyString, at: IsoTimestamp): PausedProgram
  setExploration(actor: OperatorPrincipal, level: ExplorationLevel, at: IsoTimestamp): PausedProgram
  recordUsage(actor: HostPrincipal, delta: UsageDelta): PausedProgram
}

export declare class StoppedProgram implements ProgramCommon {
  private constructor()
  private readonly __stopped: true
  readonly status: 'stopped'
  readonly id: ProgramId
  readonly name: NonEmptyString
  readonly goal: NonEmptyString
  readonly methodology: NonEmptyString
  readonly contract: EvaluationContract
  readonly utility: UtilityConfig
  readonly exploration: ExplorationLevel
  readonly budget: Budget
  readonly usage: BudgetUsage
  readonly createdAt: IsoTimestamp
  readonly stoppedAt: IsoTimestamp
  readonly stopReason: NonEmptyString
  static create(input: Omit<StoppedProgram, 'status'>): StoppedProgram
  static fromRow(row: unknown): Result<StoppedProgram, StoreError>
}

export declare class CompletedProgram implements ProgramCommon {
  private constructor()
  private readonly __completed: true
  readonly status: 'completed'
  readonly id: ProgramId
  readonly name: NonEmptyString
  readonly goal: NonEmptyString
  readonly methodology: NonEmptyString
  readonly contract: EvaluationContract
  readonly utility: UtilityConfig
  readonly exploration: ExplorationLevel
  readonly budget: Budget
  readonly usage: BudgetUsage
  readonly createdAt: IsoTimestamp
  readonly completedAt: IsoTimestamp
  readonly completionReason: NonEmptyString
  static create(input: Omit<CompletedProgram, 'status'>): CompletedProgram
  static fromRow(row: unknown): Result<CompletedProgram, StoreError>
}

export type Program = RunningProgram | PausedProgram | StoppedProgram | CompletedProgram
