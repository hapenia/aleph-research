/** Researcher pool configuration and wake policy. */
import type { SessionId } from './ids.js'

export interface ResearcherPoolConfig {
  /** How many Researcher Sessions exist at once. */
  readonly size: number
  readonly preset: string
}

export type WakeReason =
  | { readonly kind: 'issue-assigned'; readonly issueId: string }
  | { readonly kind: 'ci-completed'; readonly ciRunId: string }
  | { readonly kind: 'review-comment'; readonly experimentId: string }
  | { readonly kind: 'timer-tick'; readonly at: string }

export interface ResearcherAssignment {
  readonly sessionId: SessionId
  readonly activeIssueId: string | null
}
