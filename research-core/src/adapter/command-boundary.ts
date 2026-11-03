import type { Result } from '../types/errors.js'
import type {
  CoreActor,
  CoreActorRole,
  CoreAuditEntry,
  CoreCommandCompletedFrame,
  CoreCommandDraft,
  CoreCommandEffectFrame,
  CoreCommandEffectResume,
  CoreCommandErrorFrame,
  CoreCommandName,
  CoreCommandOutcome,
  CoreCommandRequest,
  CoreEffectFailure,
  CoreEffectFailureKind,
  CoreExperiment,
  CoreIssue,
  CoreProgram,
  CoreProtocolFrame,
  CoreTicket,
  CoreVersioned,
} from './bindings.js'

export type {
  CoreAuditEntry,
  CoreBenchmarkMetric,
  CoreBenchmarkSpec,
  CoreCommandCompletedFrame,
  CoreCommandDraft,
  CoreCommandEffectFrame,
  CoreCommandEffectResume,
  CoreCommandErrorFrame,
  CoreCommandErrorFrameKind,
  CoreCommandName,
  CoreCommandOutcome,
  CoreCommandRequest,
  CoreEnvironmentDeclaration,
  CoreExperiment,
  CoreExperimentStatus,
  CoreIssue,
  CoreIssueStatus,
  CoreLineage,
  CoreLineageStrategy,
  CoreMetricWeight,
  CoreProgram,
  CoreResearchPolicy,
  CoreResearcherDecision,
  CoreTicket,
  CoreTicketStatus,
  CoreVersioned,
} from './bindings.js'

export const COMMAND_BOUNDARY_VERSION = 2

export type CoreCommandRole = CoreActorRole
export type CoreCommandActor = CoreActor
export type CoreCommandErrorKind =
  | 'invalid-draft'
  | 'unauthorized'
  | 'forbidden'
  | 'ownership'
  | 'state-conflict'
  | 'storage'
  | 'clock'
  | 'protocol'
  | 'transport'

export interface CoreCommandError {
  readonly kind: CoreCommandErrorKind
  readonly command?: CoreCommandName
  readonly message: string
}

export type CoreCommandEffectFailureKind = CoreEffectFailureKind
export type CoreCommandEffectFailure = CoreEffectFailure

export type CommandEffectName =
  | 'storage.loadProgram'
  | 'storage.saveProgram'
  | 'storage.loadIssue'
  | 'storage.saveIssue'
  | 'storage.loadExperiment'
  | 'storage.saveExperiment'
  | 'storage.loadTicket'
  | 'storage.saveTicket'
  | 'storage.appendAudit'
  | 'clock.now'

export type CommandEffect =
  | { readonly name: 'storage.loadProgram'; readonly programId: string }
  | {
      readonly name: 'storage.saveProgram'
      readonly expected?: string | undefined
      readonly program: CoreProgram
    }
  | { readonly name: 'storage.loadIssue'; readonly issueId: string }
  | {
      readonly name: 'storage.saveIssue'
      readonly expected?: string | undefined
      readonly issue: CoreIssue
    }
  | { readonly name: 'storage.loadExperiment'; readonly experimentId: string }
  | {
      readonly name: 'storage.saveExperiment'
      readonly expected?: string | undefined
      readonly experiment: CoreExperiment
    }
  | { readonly name: 'storage.loadTicket'; readonly ticketId: string }
  | {
      readonly name: 'storage.saveTicket'
      readonly expected?: string | undefined
      readonly ticket: CoreTicket
    }
  | {
      readonly name: 'storage.appendAudit'
      readonly role: CoreCommandRole
      readonly entry: CoreAuditEntry
    }
  | { readonly name: 'clock.now' }

export type CommandFrame = CoreCommandEffectFrame | CoreCommandCompletedFrame

export interface CommandStore {
  loadProgram(programId: string): Promise<CoreVersioned<CoreProgram> | undefined>
  saveProgram(
    program: CoreProgram,
    expected?: string,
  ): Promise<Result<string, CoreCommandEffectFailure>>
  loadIssue(issueId: string): Promise<CoreVersioned<CoreIssue> | undefined>
  saveIssue(
    issue: CoreIssue,
    expected?: string,
  ): Promise<Result<string, CoreCommandEffectFailure>>
  loadExperiment(
    experimentId: string,
  ): Promise<CoreVersioned<CoreExperiment> | undefined>
  saveExperiment(
    experiment: CoreExperiment,
    expected?: string,
  ): Promise<Result<string, CoreCommandEffectFailure>>
  loadTicket(ticketId: string): Promise<CoreVersioned<CoreTicket> | undefined>
  saveTicket(
    ticket: CoreTicket,
    expected?: string,
  ): Promise<Result<string, CoreCommandEffectFailure>>
  appendAudit(
    entry: CoreAuditEntry,
    role: CoreCommandRole,
  ): Promise<Result<void, CoreCommandEffectFailure>>
}

export interface CommandClock {
  now(): string
}

export interface CommandConcepts {
  readonly store: CommandStore
  readonly clock: CommandClock
}

export interface CommandHandle {
  boundary_version(): number
  command_start(input: CoreCommandRequest): CommandFrame | CoreCommandErrorFrame | CoreProtocolFrame
  command_resume(input: CoreCommandEffectResume): CommandFrame | CoreCommandErrorFrame | CoreProtocolFrame
}

export interface CommandFactory {
  create(): CommandHandle
}

export interface CommandBridge {
  readonly boundaryVersion: number
  execute(
    actor: CoreCommandActor,
    draft: CoreCommandDraft,
  ): Promise<Result<CoreCommandOutcome, CoreCommandError>>
}

export type CommandLoadError =
  | {
      readonly kind: 'boundary-version'
      readonly expected: number
      readonly actual: number
    }
  | { readonly kind: 'instantiate'; readonly message: string }
