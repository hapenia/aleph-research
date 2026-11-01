/**
 * Factory boundary (implementation phase): the only module allowed to construct nominal
 * domain states, call private constructors or trust Host input. ESLint and ast-grep reject
 * `.create(` calls, assertions and `any` outside this module and hydration.ts.
 *
 * Inputs are `unknown` on purpose: a factory validates at runtime and returns a Result;
 * typed payloads belong to the command/parser layer, not to the trust boundary.
 */
import type {
  HostPrincipal,
  ImplementerPrincipal,
  IssueAssignment,
  OperatorPrincipal,
  ResearcherPrincipal,
  RouterPrincipal,
  TicketBinding,
  WatchdogPrincipal,
} from './types/actors.js'
import type { ArtifactRef } from './types/artifacts.js'
import type { ExplorationLevel } from './types/program.js'
import type { ExplorationPreset } from './types/sampling.js'
import type { CIRequestToken, FailedCICompletion, PassedCICompletion } from './types/ci.js'
import type { DomainError, Result } from './types/errors.js'
import type { DerivedLineage, FreshLineage, OpenExperiment } from './types/experiment.js'
import type { OpenIssue } from './types/issue.js'
import type { Program, RunningProgram } from './types/program.js'
import type {
  CIRunId,
  CommitSha,
  ExperimentId,
  ImplementerSessionId,
  IssueId,
  OperatorSessionId,
  ProgramId,
  ResearcherSessionId,
  RouterSessionId,
  TicketId,
  WatchdogSessionId,
} from './types/ids.js'

export declare function createHostPrincipal(): HostPrincipal
export declare function createClock(): import('./types/services.js').Clock
export declare function createOperatorPrincipal(sessionId: OperatorSessionId): OperatorPrincipal
export declare function createResearcherPrincipal(sessionId: ResearcherSessionId): ResearcherPrincipal
export declare function createImplementerPrincipal(
  sessionId: ImplementerSessionId,
  ticketId: TicketId,
): ImplementerPrincipal
export declare function createWatchdogPrincipal(sessionId: WatchdogSessionId): WatchdogPrincipal
export declare function createRouterPrincipal(sessionId: RouterSessionId): RouterPrincipal

export declare function createIssueAssignment(
  issueId: IssueId,
  assignee: ResearcherPrincipal,
): Result<IssueAssignment, DomainError>
export declare function createTicketBinding(input: unknown): Result<TicketBinding, DomainError>

export declare function createRunningProgram(input: unknown): Result<RunningProgram, DomainError>
export declare function createOpenIssue(input: unknown): Result<OpenIssue, DomainError>
export declare function createOpenExperiment(input: unknown): Result<OpenExperiment, DomainError>
export declare function createDerivedLineage(input: unknown): Result<DerivedLineage, DomainError>
export declare function createFreshLineage(input: unknown): Result<FreshLineage, DomainError>
export declare function createArtifactRef(input: unknown): Result<ArtifactRef, DomainError>

export declare const EXPLORATION_PRESETS: Readonly<Record<ExplorationLevel, ExplorationPreset>>

export declare function createCIRequestToken(input: unknown): Result<CIRequestToken, DomainError>
export declare function createPassedCICompletion(input: unknown): Result<PassedCICompletion, DomainError>
export declare function createFailedCICompletion(input: unknown): Result<FailedCICompletion, DomainError>

/** A facts-only view used by the Host when it needs a Program before construction. */
export declare function programOf(input: unknown): Result<Program, DomainError>
