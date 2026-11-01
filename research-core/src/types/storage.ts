/**
 * Host storage interfaces: the only components that touch persistence.
 *
 * The Host is the sole writer of research state. The event store is the source of
 * truth and the read repositories are projections; both are behind these interfaces
 * so phase 1 can start in memory and swap to SQLite without changing the domain.
 */
import type { Program } from './program.js'
import type { Issue, IssueComment } from './issue.js'
import type { PullRequest, ReviewComment } from './pull-request.js'
import type { CIRun } from './ci.js'
import type { ProgramEvent, ProgramState, EventEnvelope, Decider } from './events.js'
import type { DomainError, Result, StoreError } from './errors.js'
import type { ProgramId, Version } from './ids.js'
import type { DecisionContext } from './events.js'

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

export interface PullRequestRepository {
  get(id: string): Promise<PullRequest | undefined>
  listByProgram(programId: ProgramId): Promise<readonly PullRequest[]>
  listByIssue(issueId: string): Promise<readonly PullRequest[]>
  reviews(pullRequestId: string): Promise<readonly ReviewComment[]>
}

export interface CIRunRepository {
  get(id: string): Promise<CIRun | undefined>
  listByPullRequest(pullRequestId: string): Promise<readonly CIRun[]>
}

/** Append-only event log with optimistic concurrency per Program. */
export interface EventStore {
  load(programId: ProgramId): Promise<readonly EventEnvelope<ProgramEvent>[]>
  append(programId: ProgramId, expected: Version, events: readonly ProgramEvent[]): Promise<Result<readonly EventEnvelope<ProgramEvent>[], StoreError>>
}

/** One transactional unit so a command's events and projections land together. */
export interface UnitOfWork {
  readonly programs: ProgramRepository
  readonly issues: IssueRepository
  readonly pullRequests: PullRequestRepository
  readonly ciRuns: CIRunRepository
  readonly events: EventStore
  transaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T>
}

/** Executes one command through its decider and appends the produced events. */
export interface CommandExecutor {
  execute<C>(decider: Decider<C>, command: C, context: DecisionContext): Promise<Result<readonly ProgramEvent[], DomainError>>
}

/** Read-side folding used by the panel and Session tools. */
export interface ReadModel {
  loadProgramState(programId: ProgramId): Promise<ProgramState>
}
