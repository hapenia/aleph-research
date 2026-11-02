import type { Result } from '../types/errors.js'
import type { IsoTimestamp } from '../types/ids.js'
import type {
  CoreBenchmarkSpec,
  CoreEnvironmentDeclaration,
  CoreMetricWeight,
  CoreProgram,
  CoreResearchPolicy,
} from './boundary.js'

export const COMMAND_BOUNDARY_VERSION = 1

export type CoreCommandRole = 'operator' | 'researcher' | 'implementer'

export interface CoreCommandActor {
  readonly id: string
  readonly role: CoreCommandRole
  readonly sessionId?: string
}

export type CoreIssueStatus = 'open' | 'assigned' | 'closed'
export type CoreExperimentStatus = 'open' | 'concluded' | 'failed' | 'cancelled'
export type CoreTicketStatus = 'open' | 'running' | 'succeeded' | 'failed' | 'abandoned'
export type CoreLineageStrategy = 'continue' | 'branch' | 'fresh'

export interface CoreIssue {
  readonly id: string
  readonly programId: string
  readonly title: string
  readonly body: string
  readonly labels: readonly string[]
  readonly author: string
  readonly createdAt: IsoTimestamp
  readonly status: CoreIssueStatus
  readonly assignee?: string
  readonly experiments: readonly string[]
}

export interface CoreLineage {
  readonly strategy: CoreLineageStrategy
  readonly baseCommit: string
  readonly freshStartProbability: number
}

export interface CoreExperiment {
  readonly id: string
  readonly programId: string
  readonly issueId: string
  readonly branch: string
  readonly head: string
  readonly environment: CoreEnvironmentDeclaration
  readonly lineage: CoreLineage
  readonly planCommentId?: string
  readonly createdBy: string
  readonly createdAt: IsoTimestamp
  readonly status: CoreExperimentStatus
}

export interface CoreTicket {
  readonly id: string
  readonly experimentId: string
  readonly branch: string
  readonly baseCommit: string
  readonly status: CoreTicketStatus
  readonly commit?: string
  readonly workerSessionId?: string
}

export interface CoreAuditEntry {
  readonly id: string
  readonly actor: string
  readonly action: string
  readonly subject: string
  readonly detail: string
  readonly requestId: string
  readonly createdAt: IsoTimestamp
}

export interface CoreVersioned<T> {
  readonly value: T
  readonly version: number
}

export type CoreCommandName =
  | 'program.create'
  | 'program.pause'
  | 'program.resume'
  | 'program.stop'
  | 'program.goal'
  | 'program.methodology'
  | 'program.exploration'
  | 'issue.create'
  | 'issue.claim'
  | 'issue.comment'
  | 'issue.close'
  | 'experiment.propose'
  | 'experiment.review'
  | 'experiment.close'
  | 'benchmark.request'
  | 'ticket.submit'

export type CoreResearcherDecision =
  | { readonly kind: 'propose' }
  | { readonly kind: 'revise' }
  | {
      readonly kind: 'stop'
      readonly reason: 'goal-met' | 'policy-exhausted' | 'no-hypothesis' | 'cancelled'
    }

export type CoreCommandDraft =
  | {
      readonly name: 'program.create'
      readonly id: string
      readonly programName: string
      readonly goal: string
      readonly methodology: string
      readonly benchmark: CoreBenchmarkSpec
      readonly utility: readonly CoreMetricWeight[]
      readonly exploration: 'low' | 'normal' | 'high'
      readonly policy: CoreResearchPolicy
    }
  | { readonly name: 'program.pause'; readonly programId: string }
  | { readonly name: 'program.resume'; readonly programId: string }
  | { readonly name: 'program.stop'; readonly programId: string }
  | { readonly name: 'program.goal'; readonly programId: string; readonly goal: string }
  | {
      readonly name: 'program.methodology'
      readonly programId: string
      readonly methodology: string
    }
  | {
      readonly name: 'program.exploration'
      readonly programId: string
      readonly exploration: 'low' | 'normal' | 'high'
    }
  | {
      readonly name: 'issue.create'
      readonly id: string
      readonly programId: string
      readonly title: string
      readonly body: string
      readonly labels: readonly string[]
    }
  | { readonly name: 'issue.claim'; readonly issueId: string }
  | { readonly name: 'issue.comment'; readonly issueId: string; readonly body: string }
  | { readonly name: 'issue.close'; readonly issueId: string }
  | {
      readonly name: 'experiment.propose'
      readonly id: string
      readonly programId: string
      readonly issueId: string
      readonly branch: string
      readonly head: string
      readonly environment: CoreEnvironmentDeclaration
      readonly lineage: CoreLineage
      readonly planCommentId?: string
    }
  | {
      readonly name: 'experiment.review'
      readonly experimentId: string
      readonly decision: CoreResearcherDecision
    }
  | { readonly name: 'experiment.close'; readonly experimentId: string }
  | { readonly name: 'benchmark.request'; readonly experimentId: string }
  | {
      readonly name: 'ticket.submit'
      readonly ticketId: string
      readonly commit: string
    }

export type CoreCommandOutcome =
  | { readonly kind: 'program-created'; readonly program: string; readonly version: number }
  | { readonly kind: 'program-updated'; readonly program: string; readonly version: number }
  | { readonly kind: 'issue-created'; readonly issue: string; readonly version: number }
  | { readonly kind: 'issue-updated'; readonly issue: string; readonly version: number }
  | { readonly kind: 'issue-commented'; readonly issue: string }
  | { readonly kind: 'experiment-created'; readonly experiment: string; readonly version: number }
  | { readonly kind: 'experiment-updated'; readonly experiment: string; readonly version: number }
  | {
      readonly kind: 'experiment-reviewed'
      readonly experiment: string
      readonly decision: CoreResearcherDecision
    }
  | { readonly kind: 'benchmark-requested'; readonly experiment: string }
  | {
      readonly kind: 'ticket-submitted'
      readonly ticket: string
      readonly commit: string
      readonly version: number
    }

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
  readonly command?: string
  readonly message: string
}

export type CoreCommandEffectFailureKind =
  | 'rejected'
  | 'unavailable'
  | 'not-found'
  | 'conflict'

export interface CoreCommandEffectFailure {
  readonly kind: CoreCommandEffectFailureKind
  readonly message: string
}

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
      readonly expected?: number
      readonly program: CoreProgram
    }
  | { readonly name: 'storage.loadIssue'; readonly issueId: string }
  | {
      readonly name: 'storage.saveIssue'
      readonly expected?: number
      readonly issue: CoreIssue
    }
  | { readonly name: 'storage.loadExperiment'; readonly experimentId: string }
  | {
      readonly name: 'storage.saveExperiment'
      readonly expected?: number
      readonly experiment: CoreExperiment
    }
  | { readonly name: 'storage.loadTicket'; readonly ticketId: string }
  | {
      readonly name: 'storage.saveTicket'
      readonly expected?: number
      readonly ticket: CoreTicket
    }
  | {
      readonly name: 'storage.appendAudit'
      readonly role: CoreCommandRole
      readonly entry: CoreAuditEntry
    }
  | { readonly name: 'clock.now' }

export type CommandEffectValue = {
  readonly 'storage.loadProgram': CoreVersioned<CoreProgram>
  readonly 'storage.saveProgram': number
  readonly 'storage.loadIssue': CoreVersioned<CoreIssue>
  readonly 'storage.saveIssue': number
  readonly 'storage.loadExperiment': CoreVersioned<CoreExperiment>
  readonly 'storage.saveExperiment': number
  readonly 'storage.loadTicket': CoreVersioned<CoreTicket>
  readonly 'storage.saveTicket': number
  readonly 'storage.appendAudit': void
  readonly 'clock.now': IsoTimestamp
}

export type CommandEffectResult =
  | {
      readonly effect: CommandEffectName
      readonly sequence: number
      readonly result:
        | { readonly ok: true; readonly value: Uint8Array }
        | {
            readonly ok: false
            readonly failure: CoreCommandEffectFailure
          }
    }

export interface CommandEffectFrame {
  readonly kind: 'effect'
  readonly effect: CommandEffectName
  readonly sequence: number
  readonly payload: Uint8Array
}

export interface CommandCompletedFrame {
  readonly kind: 'completed'
  readonly outcome: CoreCommandOutcome
}

export type CommandFrame = CommandEffectFrame | CommandCompletedFrame

export interface CommandStore {
  loadProgram(programId: string): Promise<CoreVersioned<CoreProgram> | undefined>
  saveProgram(
    program: CoreProgram,
    expected?: number,
  ): Promise<Result<number, CoreCommandEffectFailure>>
  loadIssue(issueId: string): Promise<CoreVersioned<CoreIssue> | undefined>
  saveIssue(
    issue: CoreIssue,
    expected?: number,
  ): Promise<Result<number, CoreCommandEffectFailure>>
  loadExperiment(experimentId: string): Promise<CoreVersioned<CoreExperiment> | undefined>
  saveExperiment(
    experiment: CoreExperiment,
    expected?: number,
  ): Promise<Result<number, CoreCommandEffectFailure>>
  loadTicket(ticketId: string): Promise<CoreVersioned<CoreTicket> | undefined>
  saveTicket(
    ticket: CoreTicket,
    expected?: number,
  ): Promise<Result<number, CoreCommandEffectFailure>>
  appendAudit(
    entry: CoreAuditEntry,
    role: CoreCommandRole,
  ): Promise<Result<void, CoreCommandEffectFailure>>
}

export interface CommandClock {
  now(): IsoTimestamp
}

export interface CommandConcepts {
  readonly store: CommandStore
  readonly clock: CommandClock
}

export interface CommandWasmMemory {
  readonly buffer: ArrayBuffer
}

export interface CommandWasmExports {
  readonly memory: CommandWasmMemory
  readonly aleph_bridge_version: () => number
  readonly aleph_alloc: (length: number) => number
  readonly aleph_free: (pointer: number, length: number) => void
  readonly aleph_command_start: (pointer: number, length: number) => number
  readonly aleph_command_resume: (pointer: number, length: number) => number
  readonly aleph_response_len: () => number
  readonly aleph_response_write: (pointer: number, capacity: number) => number
}

export interface CommandWasmInstance {
  readonly exports: CommandWasmExports
}

export interface CommandWasmRuntime {
  instantiate(module: Uint8Array): Promise<CommandWasmInstance>
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
  | { readonly kind: 'missing-export'; readonly name: string }
