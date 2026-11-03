import type { Result } from '../types/errors.js'
import type {
  CoreBenchmarkRecord,
  CoreBenchmarkSpec,
  CoreCompletedFrame,
  CoreFrame as CoreWireFrame,
  CoreEffectFailure,
  CoreEffectFrame,
  CoreEffectResume,
  CoreEnvironmentDeclaration,
  CoreProgram,
  CoreResearcherDecision,
  CoreStageName,
  CoreStartRequest,
} from './bindings.js'

export type {
  CoreActor,
  CoreActorRole,
  CoreAck,
  CoreAuditEntry,
  CoreBenchmarkMetric,
  CoreBenchmarkRecord,
  CoreBenchmarkSpec,
  CoreBenchmarkStatus,
  CoreCommandCompletedFrame,
  CoreCommandDraft,
  CoreCommandEffectFrame,
  CoreCommandEffectResume,
  CoreCommandErrorFrame,
  CoreCommandErrorFrameKind,
  CoreCommandName,
  CoreCommandOutcome,
  CoreCommandRequest,
  CoreCompletedFrame,
  CoreDomainFrame,
  CoreEffectFailure,
  CoreEffectFailureKind,
  CoreEffectFrame,
  CoreEffectResult,
  CoreEffectResume,
  CoreEnvironmentDeclaration,
  CoreEnvironmentKind,
  CoreExecutorOpen,
  CoreExperiment,
  CoreExperimentStatus,
  CoreExploration,
  CoreIssue,
  CoreIssueStatus,
  CoreLineage,
  CoreLineageStrategy,
  CoreMetric,
  CoreMetricDirection,
  CoreMetricWeight,
  CoreProgram,
  CoreProgramStatus,
  CoreProtocolFrame,
  CoreResearchPolicy,
  CoreResearcherDecision,
  CoreResearchOutcome,
  CoreSessionsReview,
  CoreSessionsStartWorker,
  CoreSessionsSubmitCommit,
  CoreStageName,
  CoreStartRequest,
  CoreStopReason,
  CoreStorageAppendAudit,
  CoreStorageAppendBenchmarkRecord,
  CoreStorageLoadExperiment,
  CoreStorageLoadIssue,
  CoreStorageLoadProgram,
  CoreStorageLoadTicket,
  CoreStorageSaveExperiment,
  CoreStorageSaveIssue,
  CoreStorageSaveProgram,
  CoreStorageSaveTicket,
  CoreTicket,
  CoreTicketStatus,
  CoreTriggerDeliver,
  CoreUsage,
  CoreVersioned,
} from './bindings.js'

export type { CoreFrame as CoreWireFrame } from './bindings.js'

export const CORE_BOUNDARY_VERSION = 2

export type CoreStartInput = CoreStartRequest
export type CoreOutcome = 'concluded' | 'failed' | 'cancelled'
export type CoreFrame = CoreEffectFrame | CoreCompletedFrame
export type CoreCompletion = {
  readonly outcome: CoreOutcome
  readonly stages: readonly CoreStageName[]
}

export type CoreEffectName =
  | 'storage.loadProgram'
  | 'trigger.deliver'
  | 'executor.open'
  | 'sessions.startWorker'
  | 'sessions.submitCommit'
  | 'benchmark.buildEnvironment'
  | 'benchmark.specHash'
  | 'benchmark.run'
  | 'storage.appendBenchmarkRecord'
  | 'sessions.review'
  | 'clock.now'

export type CoreEffect =
  | { readonly name: 'storage.loadProgram'; readonly programId: string }
  | {
      readonly name: 'trigger.deliver'
      readonly experimentId: string
      readonly branch: string
      readonly baseCommit: string
    }
  | {
      readonly name: 'executor.open'
      readonly programId: string
      readonly issueId: string
      readonly experimentId: string
    }
  | {
      readonly name: 'sessions.startWorker'
      readonly ticketId: string
      readonly experimentId: string
    }
  | {
      readonly name: 'sessions.submitCommit'
      readonly ticketId: string
      readonly workerSessionId: string
    }
  | {
      readonly name: 'benchmark.buildEnvironment'
      readonly commit: string
      readonly environment: CoreEnvironmentDeclaration
    }
  | { readonly name: 'benchmark.specHash'; readonly spec: CoreBenchmarkSpec }
  | {
      readonly name: 'benchmark.run'
      readonly experimentId: string
      readonly ticketId: string
      readonly spec: CoreBenchmarkSpec
      readonly commit: string
      readonly environmentDigest: string
      readonly attempt: number
      readonly maxAttempts: number
    }
  | { readonly name: 'storage.appendBenchmarkRecord'; readonly record: CoreBenchmarkRecord }
  | {
      readonly name: 'sessions.review'
      readonly experimentId: string
      readonly benchmark: CoreBenchmarkRecord
    }
  | { readonly name: 'clock.now' }

export type CoreEffectValue = {
  readonly 'storage.loadProgram': CoreProgram
  readonly 'trigger.deliver': string
  readonly 'executor.open': string
  readonly 'sessions.startWorker': string
  readonly 'sessions.submitCommit': string
  readonly 'benchmark.buildEnvironment': string
  readonly 'benchmark.specHash': string
  readonly 'benchmark.run': CoreBenchmarkRecord
  readonly 'storage.appendBenchmarkRecord': null
  readonly 'sessions.review': CoreResearcherDecision
  readonly 'clock.now': string
}

export type CoreEffectResultFor<E extends CoreEffectName> =
  | { readonly ok: true; readonly value: CoreEffectValue[E] }
  | { readonly ok: false; readonly failure: CoreEffectFailure }

export type CoreResume = CoreEffectResume

export interface CoreTriggerRequest {
  readonly experimentId: string
  readonly branch: string
  readonly baseCommit: string
}

export interface CoreTicketRequest {
  readonly programId: string
  readonly issueId: string
  readonly experimentId: string
}

export interface CoreWorkerRequest {
  readonly ticketId: string
  readonly experimentId: string
}

export interface CoreCommitRequest {
  readonly ticketId: string
  readonly workerSessionId: string
}

export interface CoreEnvironmentRequest {
  readonly commit: string
  readonly environment: CoreEnvironmentDeclaration
}

export interface CoreBenchmarkRequest {
  readonly experimentId: string
  readonly ticketId: string
  readonly spec: CoreBenchmarkSpec
  readonly commit: string
  readonly environmentDigest: string
  readonly attempt: number
  readonly maxAttempts: number
}

export interface CoreReviewRequest {
  readonly experimentId: string
  readonly benchmark: CoreBenchmarkRecord
}

export interface CoreStorageConcepts {
  loadProgram(programId: string): Promise<Result<CoreProgram, CoreEffectFailure>>
  appendBenchmarkRecord(
    record: CoreBenchmarkRecord,
  ): Promise<Result<void, CoreEffectFailure>>
}

export interface CoreTriggerConcepts {
  deliver(request: CoreTriggerRequest): Promise<Result<string, CoreEffectFailure>>
}

export interface CoreExecutorConcepts {
  open(request: CoreTicketRequest): Promise<Result<string, CoreEffectFailure>>
}

export interface CoreSessionsConcepts {
  startWorker(request: CoreWorkerRequest): Promise<Result<string, CoreEffectFailure>>
  submitCommit(request: CoreCommitRequest): Promise<Result<string, CoreEffectFailure>>
  review(request: CoreReviewRequest): Promise<Result<CoreResearcherDecision, CoreEffectFailure>>
}

export interface CoreBenchmarkConcepts {
  specHash(spec: CoreBenchmarkSpec): Promise<Result<string, CoreEffectFailure>>
  buildEnvironment(
    request: CoreEnvironmentRequest,
  ): Promise<Result<string, CoreEffectFailure>>
  run(request: CoreBenchmarkRequest): Promise<Result<CoreBenchmarkRecord, CoreEffectFailure>>
}

export interface CoreClockConcepts {
  now(): string
}

export interface CoreConcepts {
  readonly storage: CoreStorageConcepts
  readonly trigger: CoreTriggerConcepts
  readonly executor: CoreExecutorConcepts
  readonly sessions: CoreSessionsConcepts
  readonly benchmark: CoreBenchmarkConcepts
  readonly clock: CoreClockConcepts
}

export type CoreBridgeErrorKind = 'protocol' | 'domain' | 'concept' | 'transport'

export interface CoreBridgeError {
  readonly kind: CoreBridgeErrorKind
  readonly message: string
  readonly effect?: CoreEffectName
}

export interface CoreHandle {
  boundary_version(): number
  start(input: CoreStartRequest): CoreWireFrame
  resume(input: CoreEffectResume): CoreWireFrame
}

export interface CoreFactory {
  create(): CoreHandle
}

export type CoreLoadError =
  | {
      readonly kind: 'boundary-version'
      readonly expected: number
      readonly actual: number
    }
  | { readonly kind: 'instantiate'; readonly message: string }

export interface ResearchCore {
  readonly boundaryVersion: number
  start(input: CoreStartInput): Result<CoreFrame, CoreBridgeError>
  resume(input: CoreResume): Result<CoreFrame, CoreBridgeError>
  run(input: CoreStartInput): Promise<Result<CoreCompletion, CoreBridgeError>>
}
