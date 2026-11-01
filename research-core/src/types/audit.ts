/**
 * Audit log: every Host decision is recorded, but the log is not the source of truth.
 *
 * The review decided that replaying history has no meaning for research. State lives in
 * current-state repositories; the audit log exists so a person can see who changed what,
 * why, and what the Host checked, without reconstructing old states.
 *
 * The entry is a discriminated union: an action can only be paired with the actor and
 * subject its type permits, so "CI passed, recorded by a Researcher" or "issue claimed,
 * subject is a CI run" cannot be represented.
 */
import type { ExperimentId, IsoTimestamp, ProgramId, SessionId } from './ids.js'

export type AuditAction =
  | 'program.created'
  | 'program.paused'
  | 'program.resumed'
  | 'program.stopped'
  | 'program.exploration-changed'
  | 'issue.created'
  | 'issue.claimed'
  | 'issue.commented'
  | 'issue.closed'
  | 'experiment.proposed'
  | 'experiment.opened'
  | 'experiment.reviewed'
  | 'implementation.submitted'
  | 'ci.requested'
  | 'ci.started'
  | 'ci.passed'
  | 'ci.failed'
  | 'artifact.stored'
  | 'attention.raised'

export type AuditActorKind = 'operator' | 'researcher' | 'implementer' | 'watchdog' | 'host'

export type AuditActor =
  | { readonly kind: 'operator'; readonly sessionId: SessionId }
  | { readonly kind: 'researcher'; readonly sessionId: SessionId }
  | { readonly kind: 'implementer'; readonly sessionId: SessionId }
  | { readonly kind: 'watchdog'; readonly sessionId: SessionId }
  | { readonly kind: 'host' }

export type AuditSubjectKind = 'program' | 'issue' | 'experiment' | 'ci-run' | 'artifact'

/** Compile-time table: the only actor kinds an action may be recorded from. */
export type ActorKindForAction = {
  readonly 'program.created': 'operator'
  readonly 'program.paused': 'operator'
  readonly 'program.resumed': 'operator'
  readonly 'program.stopped': 'operator'
  readonly 'program.exploration-changed': 'operator'
  readonly 'issue.created': 'operator' | 'researcher'
  readonly 'issue.claimed': 'researcher'
  readonly 'issue.commented': 'researcher'
  readonly 'issue.closed': 'researcher'
  readonly 'experiment.proposed': 'researcher'
  readonly 'experiment.opened': 'host'
  readonly 'experiment.reviewed': 'researcher'
  readonly 'implementation.submitted': 'implementer'
  readonly 'ci.requested': 'researcher'
  readonly 'ci.started': 'host'
  readonly 'ci.passed': 'host'
  readonly 'ci.failed': 'host'
  readonly 'artifact.stored': 'host'
  readonly 'attention.raised': 'watchdog' | 'host'
}

/** Compile-time table: the only subject kind an action may point at. */
export type SubjectKindForAction = {
  readonly 'program.created': 'program'
  readonly 'program.paused': 'program'
  readonly 'program.resumed': 'program'
  readonly 'program.stopped': 'program'
  readonly 'program.exploration-changed': 'program'
  readonly 'issue.created': 'issue'
  readonly 'issue.claimed': 'issue'
  readonly 'issue.commented': 'issue'
  readonly 'issue.closed': 'issue'
  readonly 'experiment.proposed': 'issue'
  readonly 'experiment.opened': 'experiment'
  readonly 'experiment.reviewed': 'experiment'
  readonly 'implementation.submitted': 'experiment'
  readonly 'ci.requested': 'ci-run'
  readonly 'ci.started': 'ci-run'
  readonly 'ci.passed': 'ci-run'
  readonly 'ci.failed': 'ci-run'
  readonly 'artifact.stored': 'artifact'
  readonly 'attention.raised': 'program'
}

interface AuditEntryBase<A extends AuditAction> {
  readonly id: string
  readonly at: IsoTimestamp
  readonly programId: ProgramId
  readonly action: A
  readonly subject: {
    readonly kind: SubjectKindForAction[A]
    readonly id: string
    /** Present only for experiment subjects so a reader can jump to the right program. */
    readonly experimentId?: ExperimentId
  }
  /** Free-form facts the Host checked; never a model's summary. */
  readonly detail: Readonly<Record<string, string | number | boolean | null>>
  readonly severity?: 'info' | 'warning' | 'blocked'
}

/** One immutable audit record; actor and subject follow from the action at compile time. */
export type AuditEntry = {
  readonly [A in AuditAction]: AuditEntryBase<A> & {
    readonly actor: Extract<AuditActor, { readonly kind: ActorKindForAction[A] }>
  }
}[AuditAction]

/** The audit action a command type records, derived at compile time. */
export type AuditActionForCommand = {
  readonly 'program.create': 'program.created'
  readonly 'program.pause': 'program.paused'
  readonly 'program.stop': 'program.stopped'
  readonly 'program.set-exploration': 'program.exploration-changed'
  readonly 'issue.create': 'issue.created'
  readonly 'issue.claim': 'issue.claimed'
  readonly 'issue.comment': 'issue.commented'
  readonly 'issue.close': 'issue.closed'
  readonly 'experiment.propose': 'experiment.proposed'
  readonly 'ci.request': 'ci.requested'
  readonly 'implementation.submit': 'implementation.submitted'
  readonly 'experiment.open': 'experiment.opened'
}

export type AuditActionOf<T extends keyof AuditActionForCommand> = AuditActionForCommand[T]

export interface AuditLog {
  append(entries: readonly AuditEntry[]): Promise<void>
  list(programId: ProgramId, limit: number): Promise<readonly AuditEntry[]>
}
