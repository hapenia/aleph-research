/**
 * Host storage ports: current-state repositories plus an audit log. There is no replay
 * engine; every write is versioned for optimistic concurrency.
 */
import type { ArtifactId, CIRunId, ExperimentId, IssueId, ProgramId, ResearcherSessionId, TicketId, Version } from './ids.js'
import type { Program } from './program.js'
import type { Issue, IssueComment } from './issue.js'
import type { Experiment, ExperimentReview } from './experiment.js'
import type { MetricQuery, MetricQueryResult, CIRecord, PassedCIRecord } from './metrics.js'
import type { ArtifactRef } from './artifacts.js'
import type { Attention } from './attention.js'
import type { Ticket } from './ticket.js'
import type { AuditLog } from './audit.js'
import type { CommandExecutor } from './executor.js'
import type { DomainError, Result, StoreError } from './errors.js'
import type { ProgramSnapshot } from './api.js'

export interface Versioned<T> {
  readonly value: T
  readonly version: Version
}

export interface ProgramRepository {
  get(id: ProgramId): Promise<Versioned<Program> | undefined>
  list(): Promise<readonly Versioned<Program>[]>
  save(expected: Version, next: Program): Promise<Result<Version, StoreError>>
}

export interface IssueRepository {
  get(id: IssueId): Promise<Versioned<Issue> | undefined>
  listByProgram(programId: ProgramId): Promise<readonly Issue[]>
  listAssignedTo(assignee: ResearcherSessionId): Promise<readonly Issue[]>
  save(expected: Version, next: Issue): Promise<Result<Version, StoreError>>
  comments(issueId: IssueId): Promise<readonly IssueComment[]>
  appendComment(comment: IssueComment): Promise<Result<void, StoreError>>
}

export interface ExperimentRepository {
  get(id: ExperimentId): Promise<Versioned<Experiment> | undefined>
  listByProgram(programId: ProgramId): Promise<readonly Experiment[]>
  listByIssue(issueId: IssueId): Promise<readonly Experiment[]>
  save(expected: Version, next: Experiment): Promise<Result<Version, StoreError>>
  reviews(experimentId: ExperimentId): Promise<readonly ExperimentReview[]>
  appendReview(review: ExperimentReview): Promise<Result<void, StoreError>>
}

export interface CIRecordRepository {
  get(id: CIRunId): Promise<CIRecord | undefined>
  listByExperiment(experimentId: ExperimentId): Promise<readonly CIRecord[]>
  /** Only passed records with all required metrics; used by the sampler. */
  listPassed(programId: ProgramId): Promise<readonly PassedCIRecord[]>
  query(query: MetricQuery): Promise<MetricQueryResult>
  append(record: CIRecord): Promise<Result<void, StoreError>>
}

/** The Host reads the Ticket to mint a TicketBinding; the model never supplies it. */
export interface TicketRepository {
  get(ticketId: TicketId): Promise<Ticket | undefined>
  listByExperiment(experimentId: ExperimentId): Promise<readonly Ticket[]>
  save(expected: Version, next: Ticket): Promise<Result<Version, StoreError>>
}

export interface ArtifactRepository {
  get(id: ArtifactId): Promise<ArtifactRef | undefined>
  listByExperiment(experimentId: ExperimentId): Promise<readonly ArtifactRef[]>
  append(ref: ArtifactRef): Promise<Result<void, StoreError>>
}

export interface AttentionRepository {
  listByProgram(programId: ProgramId): Promise<readonly Attention[]>
  append(attention: Attention): Promise<Result<void, StoreError>>
}

export interface UnitOfWork {
  readonly programs: ProgramRepository
  readonly issues: IssueRepository
  readonly experiments: ExperimentRepository
  readonly ciRecords: CIRecordRepository
  readonly tickets: TicketRepository
  readonly artifacts: ArtifactRepository
  readonly attention: AttentionRepository
  readonly audit: AuditLog
  transaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T>
}

export interface ReadModel {
  snapshot(programId: ProgramId): Promise<Result<ProgramSnapshot, DomainError>>
}

export type { CommandExecutor }
