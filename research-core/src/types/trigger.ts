/**
 * Mapping research facts to SuperAgent Triggers.
 *
 * The prototype owns Eval, Mandate, Ticket and routing; the rewrite turns its own audit
 * facts into Triggers on a Program Thread so authorization and Worker launch keep using
 * the prototype's decision path. State is not replayed: the snapshot is the current
 * read model.
 */
import type { AuditEntry } from './audit.js'
import type { ProgramSnapshot } from './api.js'
import type { IsoTimestamp, ProgramId, SessionId } from './ids.js'

export type ResearchTriggerKind =
  | 'issue-created'
  | 'issue-claimed'
  | 'experiment-proposed'
  | 'pull-request-opened'
  | 'ci-requested'
  | 'ci-completed'
  | 'review-commented'
  | 'attention-raised'

/** The Thread a Trigger lands on: one per Program, plus the Issue/Pull request thread. */
export interface ResearchThreadRef {
  /** `research:<programId>` or `research:<programId>:pr:<pullRequestId>`. */
  readonly id: string
  readonly kind: 'program' | 'issue' | 'pull-request' | 'ci-run'
}

/** What the factory produces; the prototype adds ids, channel and policy. */
export interface ResearchTriggerDraft {
  readonly kind: ResearchTriggerKind
  readonly programId: ProgramId
  readonly issueId?: string
  readonly pullRequestId?: string
  readonly ciRunId?: string
  readonly threads: readonly ResearchThreadRef[]
  /** Who caused the fact; the prototype's Policy checks the actor. */
  readonly actor: { readonly source: 'aleph'; readonly id: SessionId | 'host' }
  readonly human: boolean
  readonly at: IsoTimestamp
  readonly text: string
  readonly addressed: 'mention' | 'direct' | null
  readonly meta: Readonly<Record<string, string | number | boolean | null>>
}

/**
 * Pure mapping: one audit fact plus the current snapshot becomes a Trigger draft, or
 * null when the fact must not wake anyone (for example a CI result for a superseded
 * head commit).
 */
export type TriggerFactory = (entry: AuditEntry, snapshot: ProgramSnapshot) => ResearchTriggerDraft | null
