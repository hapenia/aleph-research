/**
 * Legal state transitions as types.
 *
 * Handlers check transitions at runtime; declaring them here keeps the state machines
 * explicit and lets tests enumerate every edge. No replay engine is implied: this is a
 * table of allowed moves for current-state records.
 */
import type { IssueStatus, IssueResolution } from './issue.js'
import type { ExperimentStatus, CloseReason } from './experiment.js'
import type { CIStatus } from './ci.js'

export type IssueTransition =
  | { readonly from: 'open'; readonly to: 'assigned'; readonly by: 'claim' }
  | { readonly from: 'assigned'; readonly to: 'in-review'; readonly by: 'open-experiment' }
  | { readonly from: 'in-review'; readonly to: 'closed'; readonly by: 'close'; readonly resolution: IssueResolution }
  | { readonly from: 'assigned'; readonly to: 'closed'; readonly by: 'close'; readonly resolution: IssueResolution }
  | { readonly from: 'open'; readonly to: 'closed'; readonly by: 'close'; readonly resolution: IssueResolution }

export type ExperimentTransition =
  | { readonly from: 'open'; readonly to: 'ci-requested'; readonly by: 'request-ci' }
  | { readonly from: 'ci-requested'; readonly to: 'ci-running'; readonly by: 'start-ci' }
  | { readonly from: 'ci-running'; readonly to: 'ci-passed'; readonly by: 'finish-ci' }
  | { readonly from: 'ci-running'; readonly to: 'ci-failed'; readonly by: 'finish-ci'; readonly reason: string }
  | { readonly from: 'ci-failed'; readonly to: 'ci-requested'; readonly by: 'request-ci' }
  | { readonly from: 'open'; readonly to: 'closed'; readonly by: 'close'; readonly reason: CloseReason }
  | { readonly from: 'ci-passed'; readonly to: 'closed'; readonly by: 'close'; readonly reason: CloseReason }

export type CITransition =
  | { readonly from: 'requested'; readonly to: 'running'; readonly by: 'start' }
  | { readonly from: 'running'; readonly to: 'passed'; readonly by: 'finish' }
  | { readonly from: 'running'; readonly to: 'failed'; readonly by: 'finish' }

/** A state machine is a closed set of states and its transition table. */
export interface StateMachine<S extends string, T> {
  readonly initial: S
  readonly transitions: readonly T[]
}
