/** Program: goal, methodology, metrics contract, exploration level, budget and status. */
import type { MetricDefinition } from './metrics.js'
import type { OperatorPrincipal } from './actors.js'
import type { DurationMs, IsoTimestamp, NonEmptyArray, NonEmptyString, PositiveInt, ProgramId } from './ids.js'

export type ExplorationLevel = 'low' | 'normal' | 'high'

export interface EvaluationContract {
  /** Command the Host runs inside the Experiment environment. */
  readonly ciEntry: NonEmptyString
  readonly timeoutMs: DurationMs
  /** Metrics every CI record must contain to be usable; others may be reported too. */
  readonly requiredMetrics: NonEmptyArray<string>
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
  readonly experiments: number
  readonly computeMinutes: number
  readonly tokens: number
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

/** A running Program may change its goal, exploration and methodology. */
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
  pause(actor: OperatorPrincipal, at: IsoTimestamp): PausedProgram
  stop(actor: OperatorPrincipal, reason: NonEmptyString, at: IsoTimestamp): StoppedProgram
  setGoal(actor: OperatorPrincipal, goal: NonEmptyString, at: IsoTimestamp): RunningProgram
  setMethodology(actor: OperatorPrincipal, methodology: NonEmptyString, at: IsoTimestamp): RunningProgram
  setExploration(actor: OperatorPrincipal, level: ExplorationLevel, at: IsoTimestamp): RunningProgram
  recordUsage(next: BudgetUsage): RunningProgram
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
  resume(actor: OperatorPrincipal, at: IsoTimestamp): RunningProgram
  stop(actor: OperatorPrincipal, reason: NonEmptyString, at: IsoTimestamp): StoppedProgram
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
}

export type Program = RunningProgram | PausedProgram | StoppedProgram
