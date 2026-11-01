/**
 * Tool contracts: the typed surface each role sees in a Session.
 *
 * A tool that exposes a command carries the command literal, so the payload type is
 * derived from the command union (`CommandOf<K>`). The Host injects fields the model
 * must not choose (for example the implementer ticket id) by narrowing the tool input.
 */
import type { CIRun } from './ci.js'
import type { Experiment, ExperimentReview } from './experiment.js'
import type { Issue } from './issue.js'
import type { Program, Paginated } from './program.js'
import type { CommandOf, CommandType } from './commands.js'
import type { DomainError } from './errors.js'
import type { Attention } from './attention.js'
import type { ExperimentId } from './ids.js'

/** A read-only tool: input and output are owned by the adapter. */
export interface QueryToolContract<Input, Output> {
  readonly name: string
  readonly description: string
  readonly input: Input
  readonly output: Output
}

/**
 * A tool that exposes one command. `input` defaults to the full command payload; a
 * tool may narrow it when the Host injects identity fields.
 */
export interface ToolForCommand<K extends CommandType, Output, Input = CommandOf<K>> {
  readonly name: string
  readonly description: string
  /** The command literal this tool is authorized to issue. */
  readonly command: K
  readonly input: Input
  readonly output: Output
}

export type ToolResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DomainError }

/** Snapshot a Researcher reads before acting. */
export interface ProgramView {
  readonly program: Program
  readonly issues: Paginated<Issue>
  readonly experiments: Paginated<Experiment>
  readonly ciRuns: Paginated<CIRun>
  readonly attention: readonly Attention[]
}

/** Researcher tools; the adapter injects the Researcher identity, never the model. */
export interface ResearcherTools {
  readonly readProgram: QueryToolContract<{ readonly programId: string }, ToolResult<ProgramView>>
  readonly createIssue: ToolForCommand<'issue.create', ToolResult<Issue>>
  readonly claimIssue: ToolForCommand<'issue.claim', ToolResult<Issue>>
  readonly commentOnIssue: ToolForCommand<'issue.comment', ToolResult<Issue>>
  readonly proposeExperiment: ToolForCommand<
    'experiment.propose',
    ToolResult<{ readonly status: 'proposed'; readonly experimentId: ExperimentId }>
  >
  readonly requestCI: ToolForCommand<'ci.request', ToolResult<CIRun>>
  readonly closeIssue: ToolForCommand<'issue.close', ToolResult<Issue>>
}

/**
 * Implementer tools. The command carries the ticket id, but the tool input omits it:
 * the Host knows which ticket owns the Session, so the model cannot submit elsewhere.
 */
export interface ImplementerTools {
  readonly submitImplementation: ToolForCommand<
    'implementation.submit',
    ToolResult<{ readonly status: 'submitted'; readonly ticketId: string }>,
    Omit<CommandOf<'implementation.submit'>, 'ticketId'>
  >
  readonly readExperiment: QueryToolContract<{ readonly experimentId: string }, ToolResult<Experiment>>
}

/** Operator tools; the adapters register them only for the operator surface. */
export interface OperatorTools {
  readonly createProgram: ToolForCommand<'program.create', ToolResult<Program>>
  readonly createIssue: ToolForCommand<'issue.create', ToolResult<Issue>>
  readonly pauseProgram: ToolForCommand<'program.pause', ToolResult<Program>>
  readonly stopProgram: ToolForCommand<'program.stop', ToolResult<Program>>
  readonly setExploration: ToolForCommand<'program.set-exploration', ToolResult<Program>>
}

/** Watchdog tools; no research decisions, only attention. */
export interface WatchdogTools {
  readonly listStalled: QueryToolContract<Record<string, never>, ToolResult<readonly Issue[]>>
  readonly raiseAttention: QueryToolContract<
    { readonly reason: string; readonly subject: string },
    ToolResult<{ readonly at: string }>
  >
}

/** A review a Researcher may leave on an Experiment. */
export type ExperimentReviewTool = QueryToolContract<
  { readonly experimentId: string; readonly body: string; readonly kind: ExperimentReview['kind'] },
  ToolResult<ExperimentReview>
>
