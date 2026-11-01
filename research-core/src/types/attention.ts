/** Attention: what a person must look at; the Host never decides it silently. */
import type { CIRunId, ExperimentId, IsoTimestamp, IssueId, ProgramId } from './ids.js'

export type AttentionSeverity = 'info' | 'warning' | 'blocked'

export type AttentionSubject =
  | { readonly kind: 'program'; readonly id: ProgramId }
  | { readonly kind: 'issue'; readonly id: IssueId }
  | { readonly kind: 'experiment'; readonly id: ExperimentId }
  | { readonly kind: 'ci-run'; readonly id: CIRunId }

export interface Attention {
  readonly id: string
  readonly subject: AttentionSubject
  readonly severity: AttentionSeverity
  readonly reason: string
  readonly detail: string
  readonly at: IsoTimestamp
  readonly acknowledgedAt?: IsoTimestamp
}
