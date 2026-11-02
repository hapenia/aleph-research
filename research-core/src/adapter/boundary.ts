import type { Result } from '../types/errors.js'
import type {
  BranchName,
  CommitSha,
  ExperimentId,
  ImplementerSessionId,
  IsoTimestamp,
  IssueId,
  ProgramId,
  TicketId,
} from '../types/ids.js'

export const CORE_BOUNDARY_VERSION = 1

export type CoreStageName =
  | 'IssueAssigned'
  | 'ExperimentProposed'
  | 'TriggerAccepted'
  | 'TicketOpened'
  | 'WorkerStarted'
  | 'CommitSubmitted'
  | 'EnvironmentBuilt'
  | 'BenchmarkPassed'
  | 'BenchmarkFailed'
  | 'BenchmarkRetryable'
  | 'ResultRecorded'
  | 'ReviewRecorded'
  | 'ResearchCompleted'

export type CoreOutcome = 'concluded' | 'failed' | 'cancelled'

export type CoreProgramStatus = 'running' | 'paused' | 'stopped'

export type CoreMetricDirection = 'maximize' | 'minimize'

export type CoreBenchmarkStatus = 'passed' | 'failed' | 'retryable'

export type CoreExploration = 'low' | 'normal' | 'high'

export type CoreStopReason =
  | 'goal-met'
  | 'policy-exhausted'
  | 'no-hypothesis'
  | 'cancelled'

export interface CoreBenchmarkMetric {
  readonly name: string
  readonly direction: CoreMetricDirection
  readonly required: boolean
  readonly tolerance?: number
}

export interface CoreBenchmarkSpec {
  readonly id: string
  readonly entry: string
  readonly timeoutMs: number
  readonly metrics: readonly CoreBenchmarkMetric[]
  readonly maxRetries: number
  readonly baseline: Readonly<Record<string, number>>
  readonly dataset?: string
}

export interface CoreMetric {
  readonly name: string
  readonly value: number
}

export interface CoreMetricWeight {
  readonly name: string
  readonly direction: CoreMetricDirection
  readonly weight: number
}

export interface CoreUsage {
  readonly experiments: number
  readonly computeMinutes: number
  readonly tokens: number
}

export interface CoreResearchPolicy {
  readonly maxExperiments: number
  readonly maxComputeMinutes: number
  readonly maxTokens: number
  readonly maxAttemptsPerExperiment: number
}

export interface CoreProgram {
  readonly id: ProgramId
  readonly owner: string
  readonly name: string
  readonly goal: string
  readonly methodology: string
  readonly benchmark: CoreBenchmarkSpec
  readonly utility: readonly CoreMetricWeight[]
  readonly exploration: CoreExploration
  readonly policy: CoreResearchPolicy
  readonly usage: CoreUsage
  readonly status: CoreProgramStatus
  readonly createdAt: IsoTimestamp
}

export type CoreEnvironmentKind = 'requirements' | 'uv-lock'

export interface CoreEnvironmentDeclaration {
  readonly kind: CoreEnvironmentKind
  readonly file: string
}

export interface CoreBenchmarkRecord {
  readonly id: string
  readonly experimentId: ExperimentId
  readonly ticketId: TicketId
  readonly commit: CommitSha
  readonly specHash: string
  readonly environmentDigest: string
  readonly metrics: readonly CoreMetric[]
  readonly status: CoreBenchmarkStatus
  readonly attempt: number
  readonly maxAttempts: number
  readonly stdout: string
  readonly stderr: string
  readonly artifacts: readonly string[]
  readonly createdAt: IsoTimestamp
}

export type CoreResearcherDecision =
  | { readonly kind: 'propose' }
  | { readonly kind: 'revise' }
  | { readonly kind: 'stop'; readonly reason: CoreStopReason }

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
  | { readonly name: 'storage.loadProgram'; readonly programId: ProgramId }
  | {
      readonly name: 'trigger.deliver'
      readonly experimentId: ExperimentId
      readonly branch: BranchName
      readonly baseCommit: CommitSha
    }
  | {
      readonly name: 'executor.open'
      readonly programId: ProgramId
      readonly issueId: IssueId
      readonly experimentId: ExperimentId
    }
  | {
      readonly name: 'sessions.startWorker'
      readonly ticketId: TicketId
      readonly experimentId: ExperimentId
    }
  | {
      readonly name: 'sessions.submitCommit'
      readonly ticketId: TicketId
      readonly workerSessionId: ImplementerSessionId
    }
  | {
      readonly name: 'benchmark.buildEnvironment'
      readonly commit: CommitSha
      readonly environment: CoreEnvironmentDeclaration
    }
  | { readonly name: 'benchmark.specHash'; readonly spec: CoreBenchmarkSpec }
  | {
      readonly name: 'benchmark.run'
      readonly experimentId: ExperimentId
      readonly ticketId: TicketId
      readonly spec: CoreBenchmarkSpec
      readonly commit: CommitSha
      readonly environmentDigest: string
      readonly attempt: number
      readonly maxAttempts: number
    }
  | { readonly name: 'storage.appendBenchmarkRecord'; readonly record: CoreBenchmarkRecord }
  | {
      readonly name: 'sessions.review'
      readonly experimentId: ExperimentId
      readonly benchmark: CoreBenchmarkRecord
    }
  | { readonly name: 'clock.now' }

export interface CoreTriggerRequest {
  readonly experimentId: ExperimentId
  readonly branch: BranchName
  readonly baseCommit: CommitSha
}

export interface CoreTicketRequest {
  readonly programId: ProgramId
  readonly issueId: IssueId
  readonly experimentId: ExperimentId
}

export interface CoreWorkerRequest {
  readonly ticketId: TicketId
  readonly experimentId: ExperimentId
}

export interface CoreCommitRequest {
  readonly ticketId: TicketId
  readonly workerSessionId: ImplementerSessionId
}

export interface CoreEnvironmentRequest {
  readonly commit: CommitSha
  readonly environment: CoreEnvironmentDeclaration
}

export interface CoreBenchmarkRequest {
  readonly experimentId: ExperimentId
  readonly ticketId: TicketId
  readonly spec: CoreBenchmarkSpec
  readonly commit: CommitSha
  readonly environmentDigest: string
  readonly attempt: number
  readonly maxAttempts: number
}

export interface CoreReviewRequest {
  readonly experimentId: ExperimentId
  readonly benchmark: CoreBenchmarkRecord
}

export interface CoreEffectFailure {
  readonly kind: 'rejected' | 'unavailable'
  readonly message: string
}

export type CoreEffectValue = {
  readonly 'storage.loadProgram': CoreProgram
  readonly 'trigger.deliver': string
  readonly 'executor.open': TicketId
  readonly 'sessions.startWorker': ImplementerSessionId
  readonly 'sessions.submitCommit': CommitSha
  readonly 'benchmark.buildEnvironment': string
  readonly 'benchmark.specHash': string
  readonly 'benchmark.run': CoreBenchmarkRecord
  readonly 'storage.appendBenchmarkRecord': void
  readonly 'sessions.review': CoreResearcherDecision
  readonly 'clock.now': IsoTimestamp
}

export type CoreEffectResultFor<E extends CoreEffectName> =
  | { readonly ok: true; readonly value: CoreEffectValue[E] }
  | { readonly ok: false; readonly failure: CoreEffectFailure }

export type CoreEffectResume = {
  readonly [E in CoreEffectName]: {
    readonly effect: E
    readonly sequence: number
    readonly result: CoreEffectResultFor<E>
  }
}[CoreEffectName]

export interface CoreStorageConcepts {
  loadProgram(programId: ProgramId): Promise<Result<CoreProgram, CoreEffectFailure>>
  appendBenchmarkRecord(
    record: CoreBenchmarkRecord,
  ): Promise<Result<void, CoreEffectFailure>>
}

export interface CoreTriggerConcepts {
  deliver(request: CoreTriggerRequest): Promise<Result<string, CoreEffectFailure>>
}

export interface CoreExecutorConcepts {
  open(request: CoreTicketRequest): Promise<Result<TicketId, CoreEffectFailure>>
}

export interface CoreSessionsConcepts {
  startWorker(
    request: CoreWorkerRequest,
  ): Promise<Result<ImplementerSessionId, CoreEffectFailure>>
  submitCommit(request: CoreCommitRequest): Promise<Result<CommitSha, CoreEffectFailure>>
  review(
    request: CoreReviewRequest,
  ): Promise<Result<CoreResearcherDecision, CoreEffectFailure>>
}

export interface CoreBenchmarkConcepts {
  specHash(spec: CoreBenchmarkSpec): Promise<Result<string, CoreEffectFailure>>
  buildEnvironment(
    request: CoreEnvironmentRequest,
  ): Promise<Result<string, CoreEffectFailure>>
  run(request: CoreBenchmarkRequest): Promise<Result<CoreBenchmarkRecord, CoreEffectFailure>>
}

export interface CoreClockConcepts {
  now(): IsoTimestamp
}

export interface CoreConcepts {
  readonly storage: CoreStorageConcepts
  readonly trigger: CoreTriggerConcepts
  readonly executor: CoreExecutorConcepts
  readonly sessions: CoreSessionsConcepts
  readonly benchmark: CoreBenchmarkConcepts
  readonly clock: CoreClockConcepts
}

export interface CoreStartInput {
  readonly programId: ProgramId
  readonly issueId: IssueId
  readonly experimentId: ExperimentId
  readonly branch: BranchName
  readonly baseCommit: CommitSha
  readonly environment: CoreEnvironmentDeclaration
}

export interface CoreEffectFrame {
  readonly kind: 'effect'
  readonly effect: CoreEffectName
  readonly sequence: number
  readonly stage: CoreStageName
  readonly payload: Uint8Array
}

export interface CoreCompletedFrame {
  readonly kind: 'completed'
  readonly outcome: CoreOutcome
  readonly stages: readonly CoreStageName[]
}

export type CoreFrame = CoreEffectFrame | CoreCompletedFrame

export interface CoreCompletion {
  readonly outcome: CoreOutcome
  readonly stages: readonly CoreStageName[]
}

export type CoreBridgeErrorKind = 'protocol' | 'domain' | 'concept' | 'transport'

export interface CoreBridgeError {
  readonly kind: CoreBridgeErrorKind
  readonly message: string
  readonly effect?: CoreEffectName
}

export interface CoreWasmMemory {
  readonly buffer: ArrayBuffer
}

export interface CoreWasmExports {
  readonly memory: CoreWasmMemory
  readonly aleph_bridge_version: () => number
  readonly aleph_alloc: (length: number) => number
  readonly aleph_free: (pointer: number, length: number) => void
  readonly aleph_start: (pointer: number, length: number) => number
  readonly aleph_resume: (pointer: number, length: number) => number
  readonly aleph_response_len: () => number
  readonly aleph_response_write: (pointer: number, capacity: number) => number
}

export interface WasmInstance {
  readonly exports: CoreWasmExports
}

export interface WasmRuntime {
  instantiate(module: Uint8Array): Promise<WasmInstance>
}

export interface CoreSource {
  readonly module: Uint8Array
}

export type CoreLoadError =
  | {
      readonly kind: 'boundary-version'
      readonly expected: number
      readonly actual: number
    }
  | { readonly kind: 'instantiate'; readonly message: string }
  | { readonly kind: 'missing-export'; readonly name: string }

export interface ResearchCore {
  readonly boundaryVersion: number
  start(input: CoreStartInput): Result<CoreFrame, CoreBridgeError>
  resume(input: CoreEffectResume): Result<CoreFrame, CoreBridgeError>
  run(input: CoreStartInput): Promise<Result<CoreCompletion, CoreBridgeError>>
}
