/** Mapping research audit facts to SuperAgent Triggers. */
import type { AuditAction, AuditEntryOf } from './audit.js'
import type { Principal } from './actors.js'
import type { DomainError, Result } from './errors.js'
import type { IsoTimestamp, NonEmptyArray, ProgramId, TicketId } from './ids.js'
import type { ProgramSnapshot } from './api.js'

export type ResearchTriggerKind =
  | 'program-created'
  | 'program-paused'
  | 'program-resumed'
  | 'program-stopped'
  | 'program-completed'
  | 'program-goal-changed'
  | 'program-methodology-changed'
  | 'program-exploration-changed'
  | 'issue-created'
  | 'issue-claimed'
  | 'issue-commented'
  | 'issue-closed'
  | 'experiment-proposed'
  | 'experiment-opened'
  | 'experiment-ready'
  | 'experiment-revised'
  | 'experiment-reviewed'
  | 'experiment-closed'
  | 'ci-requested'
  | 'ci-started'
  | 'ci-passed'
  | 'ci-failed'
  | 'artifact-stored'
  | 'usage-recorded'
  | 'attention-raised'

/** Compile-time total map; adding an audit action forces a trigger decision. */
export type TriggerKindForAction = {
  readonly [A in AuditAction]: ResearchTriggerKind | null
}

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

export type TriggerReportFor<A extends AuditAction> = {
  readonly action: A
  readonly kind: TriggerKindForAction[A]
  readonly draft: ResearchTriggerDraft | null
}

/** The mapper must return the trigger kind its action maps to at compile time. */
export interface TriggerFactory {
  make<A extends AuditAction>(entry: AuditEntryOf<A>, snapshot: ProgramSnapshot): TriggerReportFor<A>
}

/** The prototype seam: the adapter receives drafts and wakes the router. */
export interface TriggerPort {
  receive(draft: ResearchTriggerDraft): Promise<Result<void, DomainError>>
}
