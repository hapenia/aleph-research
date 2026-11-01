/**
 * Boltzmann base selection. There is no "best": every CI record contributes a weighted
 * candidate, and a fresh start is always possible with the level's fixed probability.
 */
import type { BaseChoice } from './experiment.js'
import type { DomainError, Result } from './errors.js'
import type { CommitSha, ExperimentId } from './ids.js'
import type { MetricDefinition, MetricMap } from './metrics.js'
import type { ExplorationLevel } from './program.js'

export interface ExplorationPreset {
  readonly temperature: number
  readonly freshStartProbability: number
}

/** Fixed table; no per-Program override (review decision). */
export const EXPLORATION_PRESETS: Readonly<Record<ExplorationLevel, ExplorationPreset>> = {
  low: { temperature: 0.2, freshStartProbability: 0.02 },
  normal: { temperature: 1.0, freshStartProbability: 0.1 },
  high: { temperature: 3.0, freshStartProbability: 0.25 },
}

export interface SampleCandidate {
  readonly experimentId: ExperimentId
  readonly commit: CommitSha
  readonly metrics: MetricMap
}

export interface SampleInput {
  readonly level: ExplorationLevel
  readonly definitions: readonly MetricDefinition[]
  /** Every Experiment with at least one valid CI record; may be empty on bootstrap. */
  readonly population: readonly SampleCandidate[]
}

/** The Host uses this port; implementations are pure functions with an injected RNG. */
export interface Sampler {
  sample(input: SampleInput): Result<BaseChoice, DomainError>
}
