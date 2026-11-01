/**
 * Tool contracts: the typed surface each role sees in a Session.
 *
 * These are the only research operations a model may call. A tool's input is a
 * command payload or a read query; its output is a view or a Result. Runtime zod
 * schemas in phase 1 will be derived from these types, not written independently.
 */
import type { CIRun } from './ci.js'
import type { DomainError } from './errors.js'
import type { Issue } from './issue.js'
import type { Program, Paginated } from './program.js'
import type { Experiment } from './experiment.js'
import type {
  ClaimIssueCommand,
  CloseIssueCommand,
  CommentOnIssueCommand,
  CreateIssueCommand,
  CreateProgramCommand,
  ProposeExperimentCommand,
  RequestCICommand,
} from './commands.js'

/** A tool declares only its name, purpose and payload types; schemas come later. */
export interface ToolContract<Input, Output> {
  readonly name: string
  readonly description: string
  // The schema field is added in phase 1 from the Input/Output types.
}

export type ToolResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: DomainError }

export interface ProgramView {
  readonly program: Program
  readonly issues: Paginated<Issue>
  readonly experiments: Paginated<Experiment>
  readonly ciRuns: Paginated<CIRun>
}

/** Researcher tools; every mutation names the Program and is checked against the assignee. */
export interface ResearcherTools {
  readonly readProgram: ToolContract<{ readonly programId: string }, ToolResult<ProgramView>>
  readonly claimIssue: ToolContract<ClaimIssueCommand, ToolResult<Issue>>
  readonly commentOnIssue: ToolContract<CommentOnIssueCommand, ToolResult<Issue>>
  readonly proposeExperiment: ToolContract<ProposeExperimentCommand, ToolResult<Experiment>>
  readonly requestCI: ToolContract<RequestCICommand, ToolResult<CIRun>>
  readonly closeIssue: ToolContract<CloseIssueCommand, ToolResult<Issue>>
  readonly createIssue: ToolContract<CreateIssueCommand, ToolResult<Issue>>
}

/** Implementer tools; the Ticket identity is injected by the Host, never by the model. */
export interface ImplementerTools {
  readonly submitImplementation: ToolContract<
    { readonly summary: string; readonly branch: string; readonly head: string },
    ToolResult<{ readonly ticketId: string; readonly status: 'submitted' }>
  >
  readonly readExperiment: ToolContract<{ readonly experimentId: string }, ToolResult<Experiment>>
}

/** Operator tools; goal, budget and stopping are the operator's authority. */
export interface OperatorTools {
  readonly createProgram: ToolContract<CreateProgramCommand, ToolResult<Program>>
  readonly createIssue: ToolContract<CreateIssueCommand, ToolResult<Issue>>
  readonly pauseProgram: ToolContract<{ readonly programId: string }, ToolResult<Program>>
  readonly stopProgram: ToolContract<{ readonly programId: string; readonly reason: string }, ToolResult<Program>>
}

/** Watchdog tools; no research decisions, only attention. */
export interface WatchdogTools {
  readonly listStalled: ToolContract<Record<string, never>, ToolResult<readonly Issue[]>>
  readonly raiseAttention: ToolContract<{ readonly reason: string; readonly subject: string }, ToolResult<void>>
}
