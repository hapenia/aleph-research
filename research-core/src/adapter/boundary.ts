import type { Principal } from '../types/actors.js'
import type { DomainError, Result } from '../types/errors.js'
import type { AuditId, ExperimentId, IssueId, ProgramId } from '../types/ids.js'
import type {
  Artifacts,
  BenchmarkRunner,
  Clock,
  Http,
  Sessions,
  Storage,
  TicketExecutor,
  Tools,
  TriggerSource,
} from './plugin.js'
import type { RouteName, Surface } from './surface.js'

export const CORE_BOUNDARY_VERSION = 1

export type CommandDraftName = RouteName

export interface CoreStartInput {
  readonly programId: ProgramId
  readonly issueId: IssueId
  readonly experimentId: ExperimentId
}

export interface CoreStartOutput {
  readonly experimentId: ExperimentId
  readonly outcome: 'concluded' | 'failed' | 'cancelled'
  readonly audit: readonly AuditId[]
}

export interface CoreCommandInput {
  readonly type: CommandDraftName
  readonly actor: Principal
  readonly body: unknown
}

export interface CoreCommandOutput {
  readonly value: unknown
  readonly audit: readonly AuditId[]
}

export interface CoreExports {
  readonly boundaryVersion: number
  start(input: CoreStartInput): Promise<Result<CoreStartOutput, DomainError>>
  execute(input: CoreCommandInput): Promise<Result<CoreCommandOutput, DomainError>>
}

export interface CoreImports {
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

export interface WasmInstance {
  readonly exports: CoreExports
}

export interface WasmRuntime {
  instantiate(module: Uint8Array, imports: CoreImports): Promise<WasmInstance>
}

export interface CoreSource {
  readonly module: Uint8Array
}

export type CoreLoadError = {
  readonly kind: 'boundary-version'
  readonly expected: number
  readonly actual: number
}
