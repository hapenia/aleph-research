/**
 * Audit log: every decision is recorded, but the log is not the source of truth.
 * The entry is a mapped union: the action fixes the allowed actor kinds and the subject.
 */
import type {
  ArtifactId,
  AuditId,
  CIRunId,
  ExperimentId,
  IsoTimestamp,
  IssueId,
  NonEmptyArray,
  ProgramId,
} from './ids.js'
import type { Principal } from './actors.js'
import type { CommandType } from './commands.js'

export type AuditAction =
  | 'program.created'
  | 'program.paused'
  | 'program.resumed'
  | 'program.stopped'
  | 'program.goal-changed'
  | 'program.methodology-changed'
  | 'program.exploration-changed'
  | 'issue.created'
  | 'issue.claimed'
  | 'issue.commented'
  | 'issue.closed'
  | 'experiment.proposed'
  | 'experiment.opened'
  | 'experiment.revised'
  | 'experiment.reviewed'
  | 'experiment.closed'
  | 'ci.requested'
  | 'ci.started'
  | 'ci.passed'
  | 'ci.failed'
  | 'artifact.stored'
  | 'attention.raised'

export type ActorKindForAction = {
  readonly 'program.created': 'operator'
  readonly 'program.paused': 'operator'
  readonly 'program.resumed': 'operator'
  readonly 'program.stopped': 'operator'
  readonly 'program.goal-changed': 'operator'
  readonly 'program.methodology-changed': 'operator'
  readonly 'program.exploration-changed': 'operator'
  readonly 'issue.created': 'operator' | 'researcher'
  readonly 'issue.claimed': 'researcher'
  readonly 'issue.commented': 'researcher' | 'operator'
  readonly 'issue.closed': 'researcher' | 'operator'
  readonly 'experiment.proposed': 'researcher'
  readonly 'experiment.opened': 'host'
  readonly 'experiment.revised': 'implementer'
  readonly 'experiment.reviewed': 'researcher'
  readonly 'experiment.closed': 'researcher'
  readonly 'ci.requested': 'researcher'
  readonly 'ci.started': 'host'
  readonly 'ci.passed': 'host'
  readonly 'ci.failed': 'host'
  readonly 'artifact.stored': 'host'
  readonly 'attention.raised': 'watchdog' | 'host'
}

export type SubjectKindForAction = {
  readonly 'program.created': 'program'
  readonly 'program.paused': 'program'
  readonly 'program.resumed': 'program'
  readonly 'program.stopped': 'program'
  readonly 'program.goal-changed': 'program'
  readonly 'program.methodology-changed': 'program'
  readonly 'program.exploration-changed': 'program'
  readonly 'issue.created': 'issue'
  readonly 'issue.claimed': 'issue'
  readonly 'issue.commented': 'issue'
  readonly 'issue.closed': 'issue'
  readonly 'experiment.proposed': 'issue'
  readonly 'experiment.opened': 'experiment'
  readonly 'experiment.revised': 'experiment'
  readonly 'experiment.reviewed': 'experiment'
  readonly 'experiment.closed': 'experiment'
  readonly 'ci.requested': 'ci-run'
  readonly 'ci.started': 'ci-run'
  readonly 'ci.passed': 'ci-run'
  readonly 'ci.failed': 'ci-run'
  readonly 'artifact.stored': 'artifact'
  readonly 'attention.raised': 'program'
}

/** Typed subject per kind: the id type cannot be mixed with another subject. */
export type SubjectForAction = {
  readonly 'program.created': { readonly kind: 'program'; readonly id: ProgramId }
  readonly 'program.paused': { readonly kind: 'program'; readonly id: ProgramId }
  readonly 'program.resumed': { readonly kind: 'program'; readonly id: ProgramId }
  readonly 'program.stopped': { readonly kind: 'program'; readonly id: ProgramId }
  readonly 'program.goal-changed': { readonly kind: 'program'; readonly id: ProgramId }
  readonly 'program.methodology-changed': { readonly kind: 'program'; readonly id: ProgramId }
  readonly 'program.exploration-changed': { readonly kind: 'program'; readonly id: ProgramId }
  readonly 'issue.created': { readonly kind: 'issue'; readonly id: IssueId }
  readonly 'issue.claimed': { readonly kind: 'issue'; readonly id: IssueId }
  readonly 'issue.commented': { readonly kind: 'issue'; readonly id: IssueId }
  readonly 'issue.closed': { readonly kind: 'issue'; readonly id: IssueId }
  readonly 'experiment.proposed': { readonly kind: 'issue'; readonly id: IssueId }
  readonly 'experiment.opened': { readonly kind: 'experiment'; readonly id: ExperimentId }
  readonly 'experiment.revised': { readonly kind: 'experiment'; readonly id: ExperimentId }
  readonly 'experiment.reviewed': { readonly kind: 'experiment'; readonly id: ExperimentId }
  readonly 'experiment.closed': { readonly kind: 'experiment'; readonly id: ExperimentId }
  readonly 'ci.requested': { readonly kind: 'ci-run'; readonly id: CIRunId }
  readonly 'ci.started': { readonly kind: 'ci-run'; readonly id: CIRunId }
  readonly 'ci.passed': { readonly kind: 'ci-run'; readonly id: CIRunId }
  readonly 'ci.failed': { readonly kind: 'ci-run'; readonly id: CIRunId }
  readonly 'artifact.stored': { readonly kind: 'artifact'; readonly id: ArtifactId }
  readonly 'attention.raised': { readonly kind: 'program'; readonly id: ProgramId }
}

interface AuditBase<A extends AuditAction> {
  readonly id: AuditId
  readonly at: IsoTimestamp
  readonly programId: ProgramId
  readonly action: A
  readonly subject: SubjectForAction[A]
  readonly detail: Readonly<Record<string, string | number | boolean | null>>
}

/** Actor and subject follow from the action at compile time. */
export type AuditEntry = {
  readonly [A in AuditAction]: AuditBase<A> & {
    readonly actor: Extract<Principal, { readonly kind: ActorKindForAction[A] }>
  }
}[AuditAction]

/** Compile-time relation between a user command and its audit action. */
export type CommandAuditMap = {
  readonly 'program.create': 'program.created'
  readonly 'program.pause': 'program.paused'
  readonly 'program.resume': 'program.resumed'
  readonly 'program.stop': 'program.stopped'
  readonly 'program.set-goal': 'program.goal-changed'
  readonly 'program.set-methodology': 'program.methodology-changed'
  readonly 'program.set-exploration': 'program.exploration-changed'
  readonly 'issue.create': 'issue.created'
  readonly 'issue.claim': 'issue.claimed'
  readonly 'issue.comment': 'issue.commented'
  readonly 'issue.close': 'issue.closed'
  readonly 'experiment.propose': 'experiment.proposed'
  readonly 'experiment.review': 'experiment.reviewed'
  readonly 'experiment.close': 'experiment.closed'
  readonly 'ci.request': 'ci.requested'
  readonly 'ticket.submit': 'experiment.revised'
}

export type AuditActionOf<T extends CommandType> = T extends keyof CommandAuditMap ? CommandAuditMap[T] : never

export interface AuditLog {
  append(entries: NonEmptyArray<AuditEntry>): Promise<void>
  list(programId: ProgramId, limit: number): Promise<readonly AuditEntry[]>
}
