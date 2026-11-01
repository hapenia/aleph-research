/** The Program: goal, evaluation contract, budget and best result. */
import type { CIRunId, CommitSha, IsoTimestamp, ProgramId, PullRequestId, Score } from './ids.js'

export type ProgramStatus = 'running' | 'paused' | 'stopped'
export type StopReason = 'goal-met' | 'budget-exhausted' | 'operator' | 'error'

/** The declared compute budget of one Program. No scheduler enforces it; the Host does. */
export interface Budget {
  readonly maxPullRequests: number
  readonly maxComputeMinutes: number
  readonly maxTokens: number
}

export interface BudgetUsage {
  readonly pullRequests: number
  readonly computeMinutes: number
  readonly tokens: number
}

/** The Program's acceptance rule for a Pull request; the Host evaluates it, not a model. */
export type AcceptanceRule =
  | { readonly kind: 'ci-passed' }
  | { readonly kind: 'score-improvement'; readonly minDelta: number }
  | { readonly kind: 'score-at-least'; readonly minScore: number }
  | { readonly kind: 'all'; readonly rules: readonly AcceptanceRule[] }
  | { readonly kind: 'any'; readonly rules: readonly AcceptanceRule[] }

/** The evaluation contract names the CI entry and how a score is read from it. */
export interface EvaluationContract {
  /** Command run in the Pull request environment, for example `eval/ci.sh`. */
  readonly ciEntry: string
  /** Timeout for one CI run. */
  readonly timeoutMs: number
  /** The JSON score is read from this field of the entry's stdout. */
  readonly scoreField: string
  /** The Host merges a Pull request only when this rule holds. */
  readonly acceptance: AcceptanceRule
}

export interface BestResult {
  readonly score: Score
  readonly pullRequestId: PullRequestId
  readonly commit: CommitSha
  readonly ciRunId: CIRunId
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
