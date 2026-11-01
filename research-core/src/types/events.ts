/**
 * Domain events and decision functions.
 *
 * The Host is an event-sourced authority: commands are decided against the current
 * Program state, accepted commands produce events, events are appended with the
 * expected version, and the read models are folds of the same events. Types here
 * define the wire shape; implementations come in phase 1.
 */
import type { Program } from './program.js'
import type { Issue, IssueComment } from './issue.js'
import type { PullRequest, ReviewComment } from './pull-request.js'
import type { CIRun } from './ci.js'
import type { DomainError, Result } from './errors.js'
import type { EventId, IsoTimestamp, ProgramId, Version } from './ids.js'
import type { SessionIdentity } from './roles.js'

/** Every event names the Program it belongs to; one event store is per Program. */
export interface EventEnvelope<E> {
  readonly id: EventId
  readonly programId: ProgramId
  /** Contiguous sequence, starting at 1; the store rejects gaps and duplicates. */
  readonly sequence: Version
  readonly at: IsoTimestamp
  readonly event: E
}

export type ProgramEvent =
  | { readonly type: 'program-created'; readonly program: Program }
  | { readonly type: 'program-paused'; readonly at: IsoTimestamp }
  | { readonly type: 'program-resumed'; readonly at: IsoTimestamp }
  | { readonly type: 'program-stopped'; readonly reason: string; readonly at: IsoTimestamp }
  | { readonly type: 'issue-created'; readonly issue: Issue }
  | { readonly type: 'issue-claimed'; readonly issueId: string; readonly assignee: string; readonly at: IsoTimestamp }
  | { readonly type: 'issue-commented'; readonly comment: IssueComment }
  | { readonly type: 'issue-closed'; readonly issueId: string; readonly resolution: string; readonly at: IsoTimestamp }
  | { readonly type: 'pull-request-opened'; readonly pullRequest: PullRequest }
  | { readonly type: 'pull-request-updated'; readonly pullRequest: PullRequest }
  | { readonly type: 'review-commented'; readonly comment: ReviewComment }
  | { readonly type: 'ci-requested'; readonly ciRun: CIRun }
  | { readonly type: 'ci-started'; readonly ciRunId: string; readonly at: IsoTimestamp }
  | { readonly type: 'ci-finished'; readonly ciRun: CIRun }
  | {
      readonly type: 'pull-request-merged'
      readonly pullRequestId: string
      readonly ciRunId: string
      readonly mergeCommit: string
      readonly at: IsoTimestamp
    }
  | { readonly type: 'attention-raised'; readonly reason: string; readonly at: IsoTimestamp }

/** The fold state a decider sees; read models are projections of this. */
export interface ProgramState {
  readonly program: Program | null
  readonly version: Version
  readonly issues: ReadonlyMap<string, Issue>
  readonly pullRequests: ReadonlyMap<string, PullRequest>
  readonly ciRuns: ReadonlyMap<string, CIRun>
}

/** Everything a decider may use beyond state; no I/O happens inside a decider. */
export interface DecisionContext {
  readonly identity: SessionIdentity
  readonly at: IsoTimestamp
}

/** A command decider: pure, total over the command union, returns events or a refusal. */
export type Decider<Command> = (
  state: ProgramState,
  command: Command,
  context: DecisionContext,
) => Result<readonly ProgramEvent[], DomainError>

/** An event reducer: pure fold; must be exhaustive over ProgramEvent. */
export type Reducer = (state: ProgramState, event: ProgramEvent) => ProgramState
