/** The Program: goal, evaluation contract, budget and best result. */
import type { CIRunId, CommitSha, IsoTimestamp, ProgramId, ExperimentId, Score } from './ids.js'
import type { ArtifactRef } from './artifacts.js'

export type ProgramStatus = 'running' | 'paused' | 'stopped'

/**
 * Exploration breadth, inherited from the retired design and kept for its purpose:
 * genetic-algorithm-like diversity so a Researcher does not lock onto one method.
 * The Operator owns the level; the Researcher never chooses a strategy.
 *
 * Fixed quota semantics (review decision): `low` exploits only, `normal` requires one
 * explore Experiment in every three, `high` requires one in every two. Explore
 * Experiments branch from the research mainline, exploit Experiments from the best
 * result.
 */
export type ExplorationLevel = 'low' | 'normal' | 'high'

export type ExplorationQuota =
  | { readonly level: 'low'; readonly exploitOnly: true; readonly exploreEvery: null }
  | { readonly level: 'normal' | 'high'; readonly exploitOnly: false; readonly exploreEvery: number }
export type StopReason = 'goal-met' | 'budget-exhausted' | 'operator' | 'error'

/** The declared compute budget of one Program. No scheduler enforces it; the Host does. */
export interface Budget {
  readonly maxExperiments: number
  readonly maxComputeMinutes: number
  readonly maxTokens: number
}

export interface BudgetUsage {
  readonly experiments: number
  readonly computeMinutes: number
  readonly tokens: number
}

/** The evaluation contract names the CI entry and how a score is read from it. */
export interface EvaluationContract {
  /** Command run in the Experiment environment, for example `eval/ci.sh`. */
  readonly ciEntry: string
  /** Timeout for one CI run. */
  readonly timeoutMs: number
  /** The JSON score is read from this field of the entry's stdout. */
  readonly scoreField: string
}



export interface BestResult {
  readonly score: Score
  readonly experimentId: ExperimentId
  readonly commit: CommitSha
  readonly ciRunId: CIRunId
  /** The persisted model weights or report this score belongs to. */
  readonly artifacts: readonly ArtifactRef[]
  readonly at: IsoTimestamp
}

export interface Program {
  readonly id: ProgramId
  readonly name: string
  /** The research goal in the operator's words; the only field the operator edits. */
  readonly goal: string
  readonly contract: EvaluationContract
  readonly budget: Budget
  readonly status: ProgramStatus
  readonly stopReason?: StopReason
  /** How the Workers of this Program are told to research; editable per Program. */
  readonly methodology: string
  /** How much diversity the Host requires across Experiments (operator-owned). */
  readonly exploration: ExplorationLevel
  readonly best: BestResult | null
  readonly createdAt: IsoTimestamp
}


/** A page of a collection for Session tools and the read-only panel. */
export interface Paginated<T> {
  readonly items: readonly T[]
  readonly total: number
  readonly offset: number
  readonly limit: number
}
