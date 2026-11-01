/**
 * Boltzmann base selection. There is no "best": every CI record contributes a weighted
 * candidate, and a fresh start is always possible with the level's fixed probability.
 */
import type { DomainError, Result } from './errors.js'
import type { CIRunId, CommitSha, ExperimentId } from './ids.js'
import type { MetricDefinition, MetricMap } from './metrics.js'
import type { ExplorationLevel } from './program.js'

export interface ExplorationPreset {
  readonly temperature: number
  readonly freshStartProbability: number
}

/** What the sampler chose; the Host turns it into a lineage and never trusts a caller. */
export type BaseChoice =
  | { readonly kind: 'derived'; readonly experimentId: ExperimentId; readonly commit: CommitSha }
  | { readonly kind: 'fresh' }

export interface SampleCandidate {
  readonly ciRunId: CIRunId
  readonly experimentId: ExperimentId
  readonly commit: CommitSha
  readonly metrics: MetricMap
}

export interface SampleInput {
  readonly level: ExplorationLevel
  readonly definitions: readonly MetricDefinition[]
  /** Injected RNG so sampling is reproducible in tests. */
  readonly random: () => number
  /** Every Experiment with at least one valid CI record; may be empty on bootstrap. */
  readonly population: readonly SampleCandidate[]
}

/** The Host uses this port; implementations are pure functions with an injected RNG. */
export interface Sampler {
  /** Fixed presets, no per-Program override. */
  presets(level: ExplorationLevel): ExplorationPreset
  sample(input: SampleInput): Result<BaseChoice, DomainError>
}
