/** Mapping research audit facts to SuperAgent Triggers. */
import type { AuditEntry } from './audit.js'
import type { Principal } from './actors.js'
import type { DomainError, Result } from './errors.js'
import type { IsoTimestamp, NonEmptyArray, ProgramId, TicketId } from './ids.js'
import type { ProgramSnapshot } from './api.js'

export type ResearchTriggerKind =
  | 'issue-created'
  | 'issue-claimed'
  | 'experiment-proposed'
  | 'experiment-opened'
  | 'ci-requested'
  | 'ci-completed'
  | 'review-commented'
  | 'attention-raised'

export type ResearchThreadRef =
  | { readonly kind: 'program'; readonly id: string }
  | { readonly kind: 'issue'; readonly id: string }
  | { readonly kind: 'experiment'; readonly id: string }

export interface ResearchTriggerDraft {
  readonly kind: ResearchTriggerKind
  readonly programId: ProgramId
  readonly threads: NonEmptyArray<ResearchThreadRef>
  readonly actor: Principal
  readonly human: boolean
  readonly at: IsoTimestamp
  readonly text: string
  readonly ticketId?: TicketId
  readonly meta: Readonly<Record<string, string | number | boolean | null>>
}

export type TriggerFactory = (entry: AuditEntry, snapshot: ProgramSnapshot) => ResearchTriggerDraft | null

/** The prototype seam: the adapter receives drafts and wakes the router. */
export interface TriggerPort {
  receive(draft: ResearchTriggerDraft): Promise<Result<void, DomainError>>
}
