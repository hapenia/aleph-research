/**
 * Tool contracts. A tool carries a real schema (parse + JSON Schema) and, for command
 * tools, the command literal, so the payload type and the allowed role are fixed at
 * compile time. Fields the Host injects are omitted from the tool input.
 */
import type { ImplementerPrincipal, OperatorPrincipal, ResearcherPrincipal, WatchdogPrincipal } from './actors.js'
import type { CIRecord, MetricQuery, MetricQueryResult } from './metrics.js'
import type { Experiment, ExperimentReview, OpenExperiment, ReadyExperiment } from './experiment.js'
import type { Issue } from './issue.js'
import type { Program } from './program.js'
import type { ArtifactRef } from './artifacts.js'
import type { Attention } from './attention.js'
import type { CommandOf, CommandType } from './commands.js'
import type { DomainError, Result } from './errors.js'
import type { ExperimentId, IssueId, ProgramId } from './ids.js'
import type { StoreError } from './errors.js'

/** A boundary schema: it parses untrusted input and emits JSON Schema for DSH tools. */
export declare class Schema<T> {
  private readonly __schema: (value: T) => T
  /** The adapter supplies the validator and the JSON Schema emitter. */
  constructor(parse: (input: unknown) => Result<T, DomainError>, toJsonSchema: () => unknown)
  parse(input: unknown): Result<T, DomainError>
  toJsonSchema(): unknown
  static fromRow<T>(row: unknown): Result<Schema<T>, StoreError>
}

export interface ToolDefinition<Input, Output> {
  readonly name: string
  readonly description: string
  readonly parameters: Schema<Input>
  readonly output: Schema<Output>
}

/** A tool exposing one command; `Input` defaults to the full command payload. */
export interface CommandTool<K extends CommandType, Output, Input = CommandOf<K>> extends ToolDefinition<Input, Output> {
  readonly command: K
}

export interface ProgramSnapshotView {
  readonly program: Program
  readonly issues: readonly Issue[]
  readonly experiments: readonly Experiment[]
  readonly ciRecords: readonly CIRecord[]
  readonly artifacts: readonly ArtifactRef[]
  readonly attention: readonly Attention[]
}

/** Researcher tools; the adapter injects the ResearcherPrincipal, never the model. */
export interface ResearcherTools {
  readonly readProgram: ToolDefinition<{ readonly programId: ProgramId }, ProgramSnapshotView>
  readonly readMetrics: ToolDefinition<MetricQuery, MetricQueryResult>
  readonly createIssue: CommandTool<'issue.create', Issue>
  readonly claimIssue: CommandTool<'issue.claim', Issue>
  readonly commentOnIssue: CommandTool<'issue.comment', Issue>
  readonly proposeExperiment: CommandTool<'experiment.propose', OpenExperiment>
  readonly reviewExperiment: CommandTool<'experiment.review', ExperimentReview>
  readonly requestCI: CommandTool<'ci.request', CIRecord>
  readonly closeIssue: CommandTool<'issue.close', Issue>
  readonly closeExperiment: CommandTool<'experiment.close', Experiment>
}

/**
 * Implementer tools. The command carries ticketId and experimentId, but the tool input
 * omits both: the Host knows which Ticket and Experiment own the Session.
 */
export interface ImplementerTools {
  readonly submitImplementation: CommandTool<
    'ticket.submit',
    ReadyExperiment,
    Omit<CommandOf<'ticket.submit'>, 'binding'>
  >
  readonly readExperiment: ToolDefinition<{ readonly experimentId: ExperimentId }, Experiment>
}

/** Operator tools; the adapter only registers them on the operator surface. */
export interface OperatorTools {
  readonly createProgram: CommandTool<'program.create', Program>
  readonly pauseProgram: CommandTool<'program.pause', Program>
  readonly resumeProgram: CommandTool<'program.resume', Program>
  readonly stopProgram: CommandTool<'program.stop', Program>
  readonly setGoal: CommandTool<'program.set-goal', Program>
  readonly setMethodology: CommandTool<'program.set-methodology', Program>
  readonly setExploration: CommandTool<'program.set-exploration', Program>
  readonly createIssue: CommandTool<'issue.create', Issue>
}

export interface WatchdogTools {
  readonly listStalled: ToolDefinition<Record<string, never>, readonly Issue[]>
  readonly raiseAttention: ToolDefinition<{ readonly reason: string; readonly subject: string }, Attention>
  readonly readMetrics: ToolDefinition<MetricQuery, MetricQueryResult>
}

/** Tool sets are tied to their principals, so a role cannot be handed another's tools. */
export type ToolSetFor<P> = P extends OperatorPrincipal
  ? OperatorTools
  : P extends ResearcherPrincipal
    ? ResearcherTools
    : P extends ImplementerPrincipal
      ? ImplementerTools
      : P extends WatchdogPrincipal
        ? WatchdogTools
        : never

export type ReviewTool = ToolDefinition<{ readonly experimentId: ExperimentId; readonly issueId: IssueId }, ExperimentReview>
