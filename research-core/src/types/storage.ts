/**
 * Host storage interfaces: the only components that touch persistence.
 *
 * The Host is the sole writer of research state. The event store is the source of
 * truth and the read repositories are projections; both are behind these interfaces
 * so phase 1 can start in memory and swap to SQLite without changing the domain.
 */
import type { Program } from './program.js'
import type { Issue, IssueComment } from './issue.js'
import type { Experiment, ReviewComment } from './experiment.js'
import type { CIRun } from './ci.js'
import type { AuditLog } from './audit.js'
import type { DomainError, Result } from './errors.js'
import type { ProgramId } from './ids.js'
import type { SessionIdentity } from './roles.js'
import type { IsoTimestamp } from './ids.js'
import type { Decision } from './commands.js'

export interface ProgramRepository {
  get(id: ProgramId): Promise<Program | undefined>
  list(): Promise<readonly Program[]>
  save(program: Program): Promise<void>
}

export interface IssueRepository {
  get(id: string): Promise<Issue | undefined>
  listByProgram(programId: ProgramId): Promise<readonly Issue[]>
  listAssignedTo(researcherId: string): Promise<readonly Issue[]>
  comments(issueId: string): Promise<readonly IssueComment[]>
}

export interface ExperimentRepository {
  get(id: string): Promise<Experiment | undefined>
  listByProgram(programId: ProgramId): Promise<readonly Experiment[]>
  listByIssue(issueId: string): Promise<readonly Experiment[]>
  reviews(experimentId: string): Promise<readonly ReviewComment[]>
}

export interface CIRunRepository {
  get(id: string): Promise<CIRun | undefined>
  listByExperiment(experimentId: string): Promise<readonly CIRun[]>
}

/** Who executes a command, and when; deciders and handlers receive this, not raw sessions. */
export interface CommandContext {
  readonly identity: SessionIdentity
  readonly at: IsoTimestamp
  readonly requestId: string
}

/** Repositories are the source of truth; state is updated in place, audited separately. */
export interface UnitOfWork {
  readonly programs: ProgramRepository
  readonly issues: IssueRepository
  readonly experiments: ExperimentRepository
  readonly ciRuns: CIRunRepository
  readonly audit: AuditLog
  transaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T>
}

/**
 * Executes one command against current state, records the audit entries in the same
 * transaction and returns the refreshed read model pieces. There is no replay engine:
 * the audit log is for people, not for rebuilding state.
 */
export interface CommandExecutor {
  execute<C, R>(command: C, context: CommandContext): Promise<Result<Decision<R>, DomainError>>
}

/** Read model assembled from the repositories for the panel and Session tools. */
export interface ReadModel {
  snapshot(programId: ProgramId): Promise<import('./api.js').ProgramSnapshot>
}
