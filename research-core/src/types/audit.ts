/**
 * Audit log: every Host decision is recorded, but the log is not the source of truth.
 *
 * The review decided that replaying history has no meaning for research. State lives in
 * current-state repositories; the audit log exists so a person can see who changed what,
 * why, and what the Host checked, without reconstructing old states.
 */
import type { IsoTimestamp, ProgramId, SessionId } from './ids.js'
import type { AttentionSeverity } from './attention.js'

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
  | 'experiment.commented'
  | 'ci.requested'
  | 'ci.started'
  | 'ci.passed'
  | 'ci.failed'
  | 'artifact.stored'
  | 'attention.raised'

export type AuditActor =
  | { readonly kind: 'operator'; readonly sessionId: SessionId }
  | { readonly kind: 'researcher'; readonly sessionId: SessionId }
  | { readonly kind: 'implementer'; readonly sessionId: SessionId }
  | { readonly kind: 'watchdog'; readonly sessionId: SessionId }
  | { readonly kind: 'host' }

/** One immutable audit record; the Host appends it in the same transaction as the state change. */
export interface AuditEntry {
  readonly id: string
  readonly at: IsoTimestamp
  readonly programId: ProgramId
  readonly actor: AuditActor
  readonly action: AuditAction
  readonly subject: { readonly kind: 'program' | 'issue' | 'experiment' | 'ci-run' | 'artifact'; readonly id: string }
  /** Free-form, but always the facts the Host checked (never a model's summary). */
  readonly detail: Readonly<Record<string, string | number | boolean | null>>
  readonly severity?: AttentionSeverity
}

export interface AuditLog {
  append(entries: readonly AuditEntry[]): Promise<void>
  list(programId: ProgramId, limit: number): Promise<readonly AuditEntry[]>
}


/** Compile-time map: a command type records exactly one audit action. */
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
  readonly 'implementation.submit': 'experiment.opened'
}

/** The audit action is derived from the command type, not chosen by the caller. */
export type AuditActionOf<T extends keyof AuditActionForCommand> = AuditActionForCommand[T]
