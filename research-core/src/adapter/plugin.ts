import type { ArtifactRef, ArtifactStore } from '../types/artifacts.js'
import type { AuditLog } from '../types/audit.js'
import type { DomainError, Result } from '../types/errors.js'
import type {
  ArtifactId,
  CommitSha,
  ExperimentId,
  ImplementerSessionId,
  IsoTimestamp,
  IssueId,
  ProgramId,
  ResearcherSessionId,
  TicketId,
} from '../types/ids.js'
import type { CIExecutionInput, CIExecutionResult } from '../types/services.js'
import type {
  ArtifactRepository,
  AttentionRepository,
  CIRecordRepository,
  ExperimentRepository,
  IssueRepository,
  ProgramRepository,
  TicketRepository,
} from '../types/storage.js'
import type { ResearchTriggerDraft } from '../types/triggers.js'
import type {
  PresetRegistration,
  RouteRegistration,
  Surface,
  ToolRegistration,
} from './surface.js'

export interface Storage {
  readonly programs: ProgramRepository
  readonly issues: IssueRepository
  readonly experiments: ExperimentRepository
  readonly tickets: TicketRepository
  readonly ciRecords: CIRecordRepository
  readonly artifacts: ArtifactRepository
  readonly attention: AttentionRepository
  readonly audit: AuditLog
}

export interface TriggerSource {
  deliver(draft: ResearchTriggerDraft): Promise<Result<void, DomainError>>
}

export interface TicketOpen {
  readonly programId: ProgramId
  readonly issueId: IssueId
  readonly experimentId: ExperimentId
  readonly baseCommit: CommitSha
}

export interface TicketExecutor {
  open(input: TicketOpen): Promise<Result<TicketId, DomainError>>
  start(ticketId: TicketId): Promise<Result<ImplementerSessionId, DomainError>>
  submit(ticketId: TicketId, commit: CommitSha): Promise<Result<void, DomainError>>
}

export interface Sessions {
  ensureResearcher(sessionId: ResearcherSessionId): Promise<Result<void, DomainError>>
  ensureImplementer(ticketId: TicketId): Promise<Result<ImplementerSessionId, DomainError>>
  wakeResearcher(sessionId: ResearcherSessionId, message: string): Promise<Result<void, DomainError>>
  registerPreset(preset: PresetRegistration): Promise<Result<void, DomainError>>
}

export interface BenchmarkRunner {
  run(input: CIExecutionInput): Promise<Result<CIExecutionResult, DomainError>>
}

export interface Artifacts {
  put(input: Parameters<ArtifactStore['put']>[0]): Promise<Result<ArtifactRef, DomainError>>
  get(id: ArtifactId): Promise<Result<ArtifactRef | undefined, DomainError>>
  listByExperiment(experimentId: ExperimentId): Promise<Result<readonly ArtifactRef[], DomainError>>
  pruneTemporary(now: IsoTimestamp): Promise<Result<number, DomainError>>
}

export interface Clock {
  now(): IsoTimestamp
}

export interface Tools {
  register(tool: ToolRegistration): Promise<Result<void, DomainError>>
}

export interface Http {
  register(route: RouteRegistration): Promise<Result<void, DomainError>>
}

export interface Plugin {
  readonly storage: Storage
  readonly trigger: TriggerSource
  readonly executor: TicketExecutor
  readonly sessions: Sessions
  readonly benchmark: BenchmarkRunner
  readonly artifacts: Artifacts
  readonly clock: Clock
  readonly tools: Tools
  readonly http: Http
  readonly surface: Surface
}
