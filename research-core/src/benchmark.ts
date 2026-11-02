import type { CommitSha, ExperimentId, TicketId } from './types/ids.js'
import type { MetricDirection } from './types/metrics.js'

export interface MetricSpec {
  readonly name: string
  readonly direction: MetricDirection
  readonly required: boolean
  readonly tolerance?: number
}

export interface BenchmarkSpec {
  readonly id: string
  readonly entry: string
  readonly timeoutMs: number
  readonly metrics: readonly MetricSpec[]
  readonly maxRetries: number
  readonly baseline?: Readonly<Record<string, number>>
  readonly dataset?: string
}

export interface BenchmarkRecord {
  readonly id: string
  readonly experimentId: ExperimentId
  readonly ticketId: TicketId
  readonly commit: CommitSha
  readonly specHash: string
  readonly environmentDigest: string
  readonly metrics: Readonly<Record<string, number>>
  readonly passed: boolean
  readonly artifacts: readonly string[]
  readonly createdAt: string
}

export interface ResearchPolicy {
  readonly maxExperiments: number
  readonly maxComputeMinutes: number
  readonly maxTokens: number
  readonly maxAttemptsPerExperiment: number
}

export type ResearcherDecision = 'propose' | 'revise' | 'stop'
