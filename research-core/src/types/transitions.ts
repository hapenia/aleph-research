/**
 * Legal state transitions, enforced by the compiler.
 *
 * Each transition accepts only its source variant and returns only its target variant,
 * so an illegal move is a type error rather than a runtime refusal. Handlers implement
 * these signatures in phase 1; the interface is the contract.
 */
import type {
  AssignedIssue,
  ClosedIssue,
  InReviewIssue,
  IssueResolution,
  OpenIssue,
} from './issue.js'
import type {
  CIPassedExperiment,
  CIRequestedExperiment,
  CIRunningExperiment,
  ClosedExperiment,
  CloseReason,
  OpenExperiment,
} from './experiment.js'
import type { FailedCIRun, PassedCIRun, RequestedCIRun, RunningCIRun } from './ci.js'
import type { AuditEntry } from './audit.js'
import type { DomainError, Result } from './errors.js'
import type { IsoTimestamp, SessionId } from './ids.js'
import type { ImplementerIdentity, ResearcherIdentity, SessionIdentity } from './roles.js'
import type { ClaimIssueCommand, CloseIssueCommand, RequestCICommand } from './commands.js'

/** What a successful transition returns: the next state bound to its audit records. */
export interface TransitionOutcome<S> {
  readonly state: S
  readonly audit: readonly AuditEntry[]
}

/** A typed transition; `From` and `To` are concrete variants, not the whole union. */
export type Transition<From, Command, To, Actor> = (
  state: From,
  command: Command,
  actor: Actor,
  at: IsoTimestamp,
) => Result<TransitionOutcome<To>, DomainError>

/** The Host actor for transitions only the Host may perform. */
export interface HostActor {
  readonly kind: 'host'
}

export interface HostTransitionInput {
  readonly at: IsoTimestamp
}

export interface IssueTransitions {
  readonly claim: Transition<OpenIssue, ClaimIssueCommand, AssignedIssue, ResearcherIdentity>
  readonly attachExperiment: Transition<
    AssignedIssue,
    { readonly experimentId: string; readonly head: string },
    InReviewIssue,
    SessionIdentity
  >
  readonly close: Transition<
    OpenIssue | AssignedIssue | InReviewIssue,
    CloseIssueCommand & { readonly resolution: IssueResolution },
    ClosedIssue,
    SessionIdentity
  >
}

export interface ExperimentTransitions {
  readonly requestCI: Transition<OpenExperiment, RequestCICommand, CIRequestedExperiment, ResearcherIdentity>
  readonly startCI: Transition<CIRequestedExperiment, { readonly at: IsoTimestamp }, CIRunningExperiment, HostActor>
  readonly passCI: Transition<CIRunningExperiment, PassedCIRun, CIPassedExperiment, HostActor>
  readonly failCI: Transition<CIRunningExperiment, FailedCIRun, CIPassedExperiment | ClosedExperiment, HostActor>
  readonly close: Transition<OpenExperiment | CIRequestedExperiment | CIRunningExperiment | CIPassedExperiment, { readonly reason: CloseReason; readonly at: IsoTimestamp }, ClosedExperiment, SessionIdentity>
}

export interface CITransitions {
  readonly start: Transition<RequestedCIRun, HostTransitionInput, RunningCIRun, HostActor>
  readonly pass: Transition<RunningCIRun, PassedCIRun, PassedCIRun, HostActor>
  readonly fail: Transition<RunningCIRun, FailedCIRun, FailedCIRun, HostActor>
}

export interface ImplementerTransitions {
  /** The Host injects the ticket identity, so the Implementer cannot choose it. */
  readonly submit: Transition<
    { readonly ticketId: string },
    { readonly branch: string; readonly head: string; readonly environment: unknown },
    { readonly status: 'submitted' },
    ImplementerIdentity
  >
}

/** Compile-time view of the whole legal move set; handlers must implement exactly this. */
export interface StateMachines {
  readonly issue: IssueTransitions
  readonly experiment: ExperimentTransitions
  readonly ci: CITransitions
  readonly implementer: ImplementerTransitions
}

/** Exhaustiveness helper for statements over closed unions. */
export type Never<T extends never = never> = T
