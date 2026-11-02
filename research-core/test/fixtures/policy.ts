import type { ResearchPolicy } from '../../src/benchmark.js'
import type { DomainError, Result } from '../../src/types/errors.js'
import type { NonEmptyString } from '../../src/types/ids.js'

export interface Usage {
  experiments: number
  computeMinutes: number
  tokens: number
}

export interface UsageDelta {
  readonly computeMinutes: number
  readonly tokens: number
}

export type ProgramStopReason =
  | 'review-stop'
  | 'experiment-limit'
  | 'compute-limit'
  | 'token-limit'
  | 'budget-exhausted'
  | 'failure'

export function createUsage(): Usage {
  return { experiments: 0, computeMinutes: 0, tokens: 0 }
}

export function attemptAllowed(policy: ResearchPolicy, attempt: number): boolean {
  return attempt <= policy.maxAttemptsPerExperiment
}

export function nextAttemptAllowed(policy: ResearchPolicy, attempt: number): boolean {
  return attempt < policy.maxAttemptsPerExperiment
}

export function canAfford(policy: ResearchPolicy, usage: Usage, delta: UsageDelta): boolean {
  return (
    usage.computeMinutes + delta.computeMinutes <= policy.maxComputeMinutes &&
    usage.tokens + delta.tokens <= policy.maxTokens
  )
}

export function affordError(
  policy: ResearchPolicy,
  usage: Usage,
  delta: UsageDelta,
): Result<void, DomainError> {
  if (usage.computeMinutes + delta.computeMinutes > policy.maxComputeMinutes) {
    return {
      ok: false,
      error: {
        code: 'budget-exhausted',
        message: 'compute budget exhausted' as NonEmptyString,
        details: {
          used: usage.computeMinutes,
          requested: delta.computeMinutes,
          limit: policy.maxComputeMinutes,
        },
      },
    }
  }
  if (usage.tokens + delta.tokens > policy.maxTokens) {
    return {
      ok: false,
      error: {
        code: 'budget-exhausted',
        message: 'token budget exhausted' as NonEmptyString,
        details: {
          used: usage.tokens,
          requested: delta.tokens,
          limit: policy.maxTokens,
        },
      },
    }
  }
  return { ok: true, value: undefined }
}

export function recordUsage(usage: Usage, delta: UsageDelta): void {
  usage.computeMinutes += delta.computeMinutes
  usage.tokens += delta.tokens
}
