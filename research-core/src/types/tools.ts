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
import type { ProgramSnapshot } from './api.js'
import type { ArtifactRef } from './artifacts.js'
import type { Attention } from './attention.js'
import type { CommandOf, CommandResult, CommandType } from './commands.js'
import type { DomainError, Result } from './errors.js'
import type { ExperimentId, IssueId, ProgramId } from './ids.js'
import type { AttentionSubject } from './attention.js'

/** A boundary schema: it parses untrusted input and emits JSON Schema for DSH tools. */
export interface Schema<T> {
  readonly parse: (input: unknown) => Result<T, DomainError>
  readonly toJsonSchema: () => unknown
}

export interface ToolDefinition<Input, Output> {
  readonly name: string
  readonly description: string
  readonly parameters: Schema<Input>
  readonly output: Schema<Output>
}

/** A tool exposing one command; its output is the command's declared result. */
export interface CommandTool<K extends CommandType, Input = CommandOf<K>>
  extends ToolDefinition<Input, CommandResult<K>> {
  readonly command: K
}


/** Researcher tools; the adapter injects the ResearcherPrincipal, never the model. */
export interface ResearcherTools {
  readonly readProgram: ToolDefinition<{ readonly programId: ProgramId }, ProgramSnapshot>
  readonly readMetrics: ToolDefinition<MetricQuery, MetricQueryResult>
  readonly createIssue: CommandTool<'issue.create'>
  readonly claimIssue: CommandTool<'issue.claim'>
  readonly commentOnIssue: CommandTool<'issue.comment'>
  readonly proposeExperiment: CommandTool<'experiment.propose', Omit<CommandOf<'experiment.propose'>, 'assignment'>>
  readonly reviewExperiment: CommandTool<'experiment.review', Omit<CommandOf<'experiment.review'>, 'assignment'>>
  readonly requestCI: CommandTool<'ci.request'>
  readonly closeIssue: CommandTool<'issue.close'>
  readonly closeExperiment: CommandTool<'experiment.close', Omit<CommandOf<'experiment.close'>, 'assignment'>>
}

/**
 * Implementer tools. The command carries ticketId and experimentId, but the tool input
 * omits both: the Host knows which Ticket and Experiment own the Session.
 */
export interface ImplementerTools {
  readonly submitImplementation: CommandTool<'ticket.submit', Omit<CommandOf<'ticket.submit'>, 'binding'>>
  readonly readExperiment: ToolDefinition<{ readonly experimentId: ExperimentId }, Experiment>
}

/** Operator tools; the adapter only registers them on the operator surface. */
export interface OperatorTools {
  readonly createProgram: CommandTool<'program.create'>
  readonly pauseProgram: CommandTool<'program.pause'>
  readonly resumeProgram: CommandTool<'program.resume'>
  readonly stopProgram: CommandTool<'program.stop'>
  readonly setGoal: CommandTool<'program.set-goal'>
  readonly setMethodology: CommandTool<'program.set-methodology'>
  readonly setExploration: CommandTool<'program.set-exploration'>
  readonly createIssue: CommandTool<'issue.create'>
}

export interface WatchdogTools {
  readonly listStalled: ToolDefinition<Record<string, never>, readonly Issue[]>
  readonly raiseAttention: ToolDefinition<{ readonly reason: string; readonly subject: AttentionSubject }, Attention>
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

