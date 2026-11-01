/** Attention: what a person must look at; the Host never decides it silently. */
import type { IsoTimestamp, ProgramId } from './ids.js'

export type AttentionSeverity = 'info' | 'warning' | 'blocked'

export type AttentionSubject =
  | { readonly kind: 'program'; readonly programId: ProgramId }
  | { readonly kind: 'issue'; readonly programId: ProgramId; readonly issueId: string }
  | { readonly kind: 'experiment'; readonly programId: ProgramId; readonly experimentId: string }
  | { readonly kind: 'ci-run'; readonly programId: ProgramId; readonly ciRunId: string }

export interface Attention {
  readonly id: string
  readonly subject: AttentionSubject
  readonly severity: AttentionSeverity
  readonly reason: string
  readonly detail: string
  readonly at: IsoTimestamp
  readonly acknowledgedAt?: IsoTimestamp
}
