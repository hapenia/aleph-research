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

export type AuditAction =
  | 'program.created'
  | 'program.paused'
  | 'program.budget-paused'
  | 'program.resumed'
  | 'program.stopped'
  | 'program.goal-changed'
  | 'program.methodology-changed'
  | 'program.exploration-changed'
  | 'program.completed'
  | 'usage.recorded'
  | 'issue.created'
  | 'issue.claimed'
  | 'issue.commented'
  | 'issue.closed'
  | 'experiment.proposed'
  | 'experiment.opened'
  | 'experiment.revised'
  | 'experiment.reviewed'
  | 'experiment.ready'
  | 'experiment.cancelled'
  | 'experiment.closed'
  | 'ci.requested'
  | 'ci.started'
  | 'ci.passed'
  | 'ci.failed'
  | 'artifact.stored'
  | 'attention.raised'
  | 'command.refused'

export type ActorKindForAction = {
  readonly 'program.created': 'operator'
  readonly 'program.paused': 'operator'
  readonly 'program.budget-paused': 'host'
  readonly 'program.resumed': 'operator'
  readonly 'program.stopped': 'operator'
  readonly 'program.goal-changed': 'operator'
  readonly 'program.methodology-changed': 'operator'
  readonly 'program.exploration-changed': 'operator'
  readonly 'program.completed': 'host'
  readonly 'usage.recorded': 'host'
  readonly 'issue.created': 'operator' | 'researcher'
  readonly 'issue.claimed': 'researcher'
  readonly 'issue.commented': 'researcher' | 'operator'
  readonly 'issue.closed': 'researcher' | 'operator'
  readonly 'experiment.proposed': 'researcher'
  readonly 'experiment.opened': 'host'
  readonly 'experiment.revised': 'implementer'
  readonly 'experiment.reviewed': 'researcher'
  readonly 'experiment.ready': 'implementer'
  readonly 'experiment.cancelled': 'host'
  readonly 'experiment.closed': 'researcher'
  readonly 'ci.requested': 'researcher'
  readonly 'ci.started': 'host'
  readonly 'ci.passed': 'host'
  readonly 'ci.failed': 'host'
  readonly 'artifact.stored': 'host'
  readonly 'attention.raised': 'watchdog' | 'host'
  readonly 'command.refused': 'operator' | 'researcher' | 'implementer' | 'watchdog' | 'host'
}

export type SubjectKindForAction = {
  readonly 'program.created': 'program'
  readonly 'program.paused': 'program'
  readonly 'program.budget-paused': 'program'
  readonly 'program.resumed': 'program'
  readonly 'program.stopped': 'program'
  readonly 'program.goal-changed': 'program'
  readonly 'program.methodology-changed': 'program'
  readonly 'program.exploration-changed': 'program'
  readonly 'program.completed': 'program'
  readonly 'usage.recorded': 'program'
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
  readonly 'command.refused': 'program'
}

/** Typed subject per kind: the id type cannot be mixed with another subject. */
export type SubjectForAction = {
  readonly 'program.created': { readonly kind: 'program'; readonly id: ProgramId }
  readonly 'program.paused': { readonly kind: 'program'; readonly id: ProgramId }
  readonly 'program.budget-paused': { readonly kind: 'program'; readonly id: ProgramId }
  readonly 'program.resumed': { readonly kind: 'program'; readonly id: ProgramId }
  readonly 'program.stopped': { readonly kind: 'program'; readonly id: ProgramId }
  readonly 'program.goal-changed': { readonly kind: 'program'; readonly id: ProgramId }
  readonly 'program.methodology-changed': { readonly kind: 'program'; readonly id: ProgramId }
  readonly 'program.exploration-changed': { readonly kind: 'program'; readonly id: ProgramId }
  readonly 'program.completed': { readonly kind: 'program'; readonly id: ProgramId }
  readonly 'usage.recorded': { readonly kind: 'program'; readonly id: ProgramId }
  readonly 'issue.created': { readonly kind: 'issue'; readonly id: IssueId }
  readonly 'issue.claimed': { readonly kind: 'issue'; readonly id: IssueId }
  readonly 'issue.commented': { readonly kind: 'issue'; readonly id: IssueId }
  readonly 'issue.closed': { readonly kind: 'issue'; readonly id: IssueId }
  readonly 'experiment.proposed': { readonly kind: 'issue'; readonly id: IssueId }
  readonly 'experiment.opened': { readonly kind: 'experiment'; readonly id: ExperimentId }
  readonly 'experiment.revised': { readonly kind: 'experiment'; readonly id: ExperimentId }
  readonly 'experiment.reviewed': { readonly kind: 'experiment'; readonly id: ExperimentId }
  readonly 'experiment.ready': { readonly kind: 'experiment'; readonly id: ExperimentId }
  readonly 'experiment.cancelled': { readonly kind: 'experiment'; readonly id: ExperimentId }
  readonly 'experiment.closed': { readonly kind: 'experiment'; readonly id: ExperimentId }
  readonly 'ci.requested': { readonly kind: 'ci-run'; readonly id: CIRunId }
  readonly 'ci.started': { readonly kind: 'ci-run'; readonly id: CIRunId }
  readonly 'ci.passed': { readonly kind: 'ci-run'; readonly id: CIRunId }
  readonly 'ci.failed': { readonly kind: 'ci-run'; readonly id: CIRunId }
  readonly 'artifact.stored': { readonly kind: 'artifact'; readonly id: ArtifactId }
  readonly 'attention.raised': { readonly kind: 'program'; readonly id: ProgramId }
  readonly 'command.refused': { readonly kind: 'program'; readonly id: ProgramId }
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

/** The audit entry type for one action, used to parameterize command outcomes. */
export type AuditEntryOf<A extends AuditAction> = Extract<AuditEntry, { readonly action: A }>

export interface AuditLog {
  append(entries: NonEmptyArray<AuditEntry>): Promise<void>
  list(programId: ProgramId, limit: number): Promise<readonly AuditEntry[]>
}
