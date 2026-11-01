/** CI runs: requested by a Researcher, executed by the Host in the PR environment. */
import type { CIRunId, CommitSha, IsoTimestamp, PullRequestId, ResearcherId, Score } from './ids.js'

export type CIStatus = 'requested' | 'running' | 'passed' | 'failed'
export type CIFailureReason =
  | 'environment-build-failed'
  | 'entry-failed'
  | 'invalid-score'
  | 'timeout'
  | 'infrastructure'

interface CIRunBase {
  readonly id: CIRunId
  readonly pullRequestId: PullRequestId
  readonly commit: CommitSha
  readonly requestedBy: ResearcherId
  readonly requestedAt: IsoTimestamp
  /** Digest of the environment the run used, so a result is reproducible. */
  readonly environmentDigest?: string
}

export type CIRun =
  | (CIRunBase & { readonly status: 'requested' })
  | (CIRunBase & { readonly status: 'running'; readonly startedAt: IsoTimestamp })
  | (CIRunBase & {
      readonly status: 'passed'
      readonly startedAt: IsoTimestamp
      readonly finishedAt: IsoTimestamp
      readonly score: Score
      readonly checks: readonly CheckResult[]
      readonly logPath: string
      readonly durationMs: number
    })
  | (CIRunBase & {
      readonly status: 'failed'
      readonly startedAt?: IsoTimestamp
      readonly finishedAt: IsoTimestamp
      readonly reason: CIFailureReason
      readonly detail: string
      readonly logPath: string
    })

/** One check inside a CI run; the Program contract may require several. */
export interface CheckResult {
  readonly name: string
  readonly passed: boolean
  readonly detail: string
}

export interface CIRequest {
  readonly pullRequestId: PullRequestId
  readonly commit: CommitSha
  readonly requestedBy: ResearcherId
}
