/**
 * Boltzmann base selection for the research mechanism.
 *
 * The Host never picks a stored "best": it samples one of the Experiments that carry a
 * valid CI record with probability proportional to `exp(utility / temperature)`, or takes
 * a fresh start from the scaffold with the level's fixed probability. Utility is the
 * Operator's weighted sum of the metrics min-max normalized over the current population;
 * a lower-is-better metric is inverted before weighting because the weights reward a high
 * utility.
 *
 * Everything here is a pure function of its input, including the RNG. The Interface's
 * `Sampler` port is produced by `createSampler`.
 */
import type { DomainError, Result } from '../types/errors.js'
import type { NonEmptyString } from '../types/ids.js'
import type { MetricDefinition, MetricMap } from '../types/metrics.js'
import type { ExplorationLevel } from '../types/program.js'
import type {
  BaseChoice,
  ExplorationPreset,
  SampleCandidate,
  SampleInput,
  Sampler,
} from '../types/sampling.js'

/** Fixed exploration levels. The table is mechanism, not configuration. */
export const EXPLORATION_PRESETS: Readonly<Record<ExplorationLevel, ExplorationPreset>> = {
  low: { temperature: 0.2, freshStartProbability: 0.02 },
  normal: { temperature: 1.0, freshStartProbability: 0.1 },
  high: { temperature: 3.0, freshStartProbability: 0.25 },
}

/** Min and max of one metric over the current population. */
interface MetricRange {
  readonly min: number
  readonly max: number
}

/** The `Sampler` port with the mechanism's fixed presets. */
export function createSampler(): Sampler {
  return {
    presets(level: ExplorationLevel): ExplorationPreset {
      const preset: ExplorationPreset | undefined = EXPLORATION_PRESETS[level]
      // A typed caller always hits a preset; the fallback only shields runtime junk.
      return preset ?? EXPLORATION_PRESETS.normal
    },
    sample(input: SampleInput): Result<BaseChoice, DomainError> {
      return sampleBase(input)
    },
  }
}

/**
 * The weighted sum of min-max normalized metrics for every candidate.
 *
 * Each metric is normalized over the whole population; when a metric is constant its
 * range is zero and it contributes nothing (every candidate is equal on it, so it must
 * not affect the ranking). A `lower` metric is inverted, `higher` is used as is. The
 * population and definitions are expected to be valid: `sample` validates before it gets
 * here.
 */
export function computeUtilities(
  population: readonly SampleCandidate[],
  definitions: readonly MetricDefinition[],
): readonly number[] {
  const ranges = new Map<string, MetricRange>()
  for (const definition of definitions) {
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (const candidate of population) {
      const value = metricValue(candidate.metrics, definition.name)
      if (value < min) min = value
      if (value > max) max = value
    }
    ranges.set(definition.name, { min, max })
  }

  return population.map((candidate) => {
    let utility = 0
    for (const definition of definitions) {
      const range = ranges.get(definition.name)
      if (range === undefined) continue
      const span = range.max - range.min
      if (span === 0) continue
      const value = metricValue(candidate.metrics, definition.name)
      const normalized = definition.direction === 'higher'
        ? (value - range.min) / span
        : (range.max - value) / span
      utility += definition.weight * normalized
    }
    return utility
  })
}

/** Validate a sample request and return the refusal, or null when it can be sampled. */
function validateInput(input: SampleInput): DomainError | null {
  if (!isArrayLike(input.population)) {
    return invalidInput('the sample population must be an array')
  }
  if (input.population.length === 0) return null

  if (!isArrayLike(input.definitions)) {
    return invalidInput('the sample definitions must be an array')
  }
  if (input.definitions.length === 0) {
    return invalidInput('a non-empty population needs at least one metric definition')
  }

  const definitionNames = new Set<string>()
  for (const definition of input.definitions) {
    if (typeof definition !== 'object' || definition === null) {
      return invalidInput('every metric definition must be an object')
    }
    const name: unknown = definition.name
    if (typeof name !== 'string' || name.length === 0) {
      return invalidInput('every metric definition needs a non-empty name')
    }
    if (definitionNames.has(name)) {
      return invalidInput(`duplicate metric definition: ${name}`)
    }
    definitionNames.add(name)
    const direction: unknown = definition.direction
    if (direction !== 'higher' && direction !== 'lower') {
      return invalidInput(`metric ${name} needs a higher or lower direction`)
    }
    const weight: unknown = definition.weight
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
      return invalidInput(`metric ${name} needs a finite positive weight`)
    }
  }

  const experimentIds = new Set<string>()
  const ciRunIds = new Set<string>()
  for (const candidate of input.population) {
    if (typeof candidate !== 'object' || candidate === null) {
      return invalidInput('every candidate must be an object')
    }
    const experimentId: unknown = candidate.experimentId
    if (typeof experimentId !== 'string' || experimentId.length === 0) {
      return invalidInput('every candidate needs a non-empty experimentId')
    }
    const ciRunId: unknown = candidate.ciRunId
    if (typeof ciRunId !== 'string' || ciRunId.length === 0) {
      return invalidInput(`experiment ${experimentId} needs a non-empty ciRunId`)
    }
    const commit: unknown = candidate.commit
    if (typeof commit !== 'string' || commit.length === 0) {
      return invalidInput(`experiment ${experimentId} needs a non-empty commit`)
    }
    if (experimentIds.has(experimentId)) {
      return invalidInput(`duplicate experiment in the sample population: ${experimentId}`)
    }
    experimentIds.add(experimentId)
    if (ciRunIds.has(ciRunId)) {
      return invalidInput(`duplicate CI run in the sample population: ${ciRunId}`)
    }
    ciRunIds.add(ciRunId)

    const metrics: unknown = candidate.metrics
    if (typeof metrics !== 'object' || metrics === null || Array.isArray(metrics)) {
      return invalidInput(`experiment ${experimentId} needs a metric map`)
    }
    for (const definition of input.definitions) {
      const value = findMetric(candidate.metrics, definition.name)
      if (value === undefined) {
        return invalidInput(`experiment ${experimentId} is missing required metric ${definition.name}`)
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return invalidInput(`experiment ${experimentId} has a non-finite ${definition.name}`)
      }
    }
  }
  return null
}

/** The mechanism: validate, then fresh start or a Boltzmann-weighted derived base. */
function sampleBase(input: SampleInput): Result<BaseChoice, DomainError> {
  const refusal = validateInput(input)
  if (refusal !== null) return { ok: false, error: refusal }

  // The bootstrap case: an empty population can only be a fresh start.
  if (input.population.length === 0) return { ok: true, value: { kind: 'fresh' } }

  const preset: ExplorationPreset | undefined = EXPLORATION_PRESETS[input.level]
  if (preset === undefined) {
    return { ok: false, error: invalidInput(`unknown exploration level: ${String(input.level)}`) }
  }
  if (typeof input.random !== 'function') {
    return { ok: false, error: invalidInput('sampling needs the injected random function') }
  }

  const freshDraw = input.random()
  if (!isUnitDraw(freshDraw)) {
    return { ok: false, error: invalidInput('the injected random function must return a number in [0, 1]') }
  }
  if (freshDraw < preset.freshStartProbability) return { ok: true, value: { kind: 'fresh' } }

  const utilities = computeUtilities(input.population, input.definitions)
  const weights = weightsFor(utilities, preset.temperature)
  const selectionDraw = input.random()
  if (!isUnitDraw(selectionDraw)) {
    return { ok: false, error: invalidInput('the injected random function must return a number in [0, 1]') }
  }
  const index = pickWeighted(weights, selectionDraw)
  const chosen = input.population[index]
  if (chosen === undefined) {
    // Unreachable for a non-empty validated population; refuse instead of guessing.
    return { ok: false, error: invalidInput('the sample population has no candidate to choose') }
  }
  return {
    ok: true,
    value: { kind: 'derived', experimentId: chosen.experimentId, commit: chosen.commit },
  }
}

/**
 * Boltzmann weights. Utilities are shifted by their maximum before exponentiation, so
 * the distribution is identical but a large utility cannot overflow `exp`.
 */
function weightsFor(utilities: readonly number[], temperature: number): readonly number[] {
  let maxUtility = Number.NEGATIVE_INFINITY
  for (const utility of utilities) {
    if (utility > maxUtility) maxUtility = utility
  }
  return utilities.map((utility) => Math.exp((utility - maxUtility) / temperature))
}

/** Pick the weight interval that contains `draw * totalWeight`; ties keep index order. */
function pickWeighted(weights: readonly number[], draw: number): number {
  let totalWeight = 0
  for (const weight of weights) totalWeight += weight
  let remaining = draw * totalWeight
  for (let index = 0; index < weights.length; index += 1) {
    const weight = weights[index]
    if (weight === undefined) continue
    remaining -= weight
    if (remaining < 0) return index
  }
  return weights.length - 1
}

/**
 * Array check without narrowing the typed input to `any[]`.
 *
 * `Array.isArray` is a type predicate, so calling it directly on `readonly T[]`
 * crosses the lint's unsafe-`any` rules; this wrapper keeps the declared element type.
 */
function isArrayLike(value: unknown): boolean {
  return Array.isArray(value)
}

/** A finite number in the closed unit interval. */
function isUnitDraw(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1
}

/** One metric value of a candidate, or undefined when the map does not carry it. */
function findMetric(metrics: MetricMap, name: string): number | undefined {
  for (const entry of Object.entries(metrics)) {
    if (entry[0] === name) return entry[1]
  }
  return undefined
}

/** One required metric value; callers validate the map before reading it. */
function metricValue(metrics: MetricMap, name: string): number {
  return findMetric(metrics, name) ?? 0
}

/**
 * `DomainError.message` is a nominal `NonEmptyString`. The factory boundary normally
 * mints branded values; this runtime module never consumes untrusted input, and every
 * refusal message is a constant defined here. This refinement declares the non-empty
 * invariant once, with a runtime fallback, so the sampler can return `DomainError`
 * without a type assertion (the same phase-1 convention as the domain transitions).
 */
function nonEmpty(value: string): NonEmptyString
function nonEmpty(value: string): string {
  return value.length === 0 ? 'refused' : value
}

/** A refusal for input the typed port should never receive unparsed. */
function invalidInput(message: string): DomainError {
  return { code: 'invalid-input', message: nonEmpty(message) }
}
