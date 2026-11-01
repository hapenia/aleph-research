/**
 * Mapping research events to SuperAgent Triggers.
 *
 * The prototype owns Eval, Mandate, Ticket and routing. The rewrite does not replace
 * that machinery: it turns its own domain events into Triggers on the Program Thread,
 * so authorization and Worker launch keep using the prototype's decision path.
 */
import type { ProgramState, ProgramEvent, EventEnvelope } from './events.js'
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

/** What the factory produces; the prototype adds its own ids, channel and policy. */
export interface ResearchTriggerDraft {
  readonly kind: ResearchTriggerKind
  readonly programId: ProgramId
  readonly issueId?: string
  readonly pullRequestId?: string
  readonly ciRunId?: string
  readonly threads: readonly ResearchThreadRef[]
  /** Who caused the event; the prototype's Policy checks the actor. */
  readonly actor: { readonly source: 'aleph'; readonly id: SessionId | 'host' }
  readonly human: boolean
  readonly at: IsoTimestamp
  readonly text: string
  readonly addressed: 'mention' | 'direct' | null
  readonly meta: Readonly<Record<string, string | number | boolean | null>>
}

/**
 * Pure mapping: an appended event plus the folded state becomes one Trigger draft,
 * or null when the event must not wake anyone (for example a CI run that is already
 * superseded by a newer head).
 */
export type TriggerFactory = (
  envelope: EventEnvelope<ProgramEvent>,
  state: ProgramState,
) => ResearchTriggerDraft | null
