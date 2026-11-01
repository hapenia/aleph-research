/** Researcher pool configuration and wake policy. */
import type { ResearcherId } from './ids.js'

export interface ResearcherPoolConfig {
  /** How many Researcher Sessions exist at once. */
  readonly size: number
  readonly preset: string
  /** Every Researcher gets a stable id derived from its Session. */
  readonly idPrefix: string
}

export type WakeReason =
  | { readonly kind: 'issue-assigned'; readonly issueId: string }
  | { readonly kind: 'ci-completed'; readonly ciRunId: string }
  | { readonly kind: 'review-comment'; readonly pullRequestId: string }
  | { readonly kind: 'timer-tick'; readonly at: string }

export interface ResearcherAssignment {
  readonly researcherId: ResearcherId
  readonly activeIssueId: string | null
}
