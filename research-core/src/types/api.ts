/**
 * Management API and read-only panel DTOs.
 *
 * The Host is the authority; every mutating route parses an untrusted body into a
 * command and returns a Result. The panel in version 1 consumes the read models only.
 */
import type { CIRun } from './ci.js'
import type { Issue, IssueComment } from './issue.js'
import type { Program, Paginated } from './program.js'
import type { PullRequest, ReviewComment } from './pull-request.js'
import type { Attention } from './attention.js'
import type { DomainError } from './errors.js'
import type { ProgramId } from './ids.js'

export type ApiResponse<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: DomainError }

export interface ProgramSummary {
  readonly id: ProgramId
  readonly name: string
  readonly status: Program['status']
  readonly bestScore: number | null
  readonly openIssues: number
  readonly openPullRequests: number
}

/** The one snapshot the panel polls; the panel never asks the prototype directly. */
export interface ProgramSnapshot {
  readonly program: Program
  readonly issues: Paginated<Issue>
  readonly issueComments: Readonly<Record<string, readonly IssueComment[]>>
  readonly pullRequests: Paginated<PullRequest>
  readonly reviews: Readonly<Record<string, readonly ReviewComment[]>>
  readonly ciRuns: Paginated<CIRun>
  readonly attention: readonly Attention[]
}

/** Operator routes; the panel stays read-only until the mechanism is proven. */
export interface CreateProgramRequest {
  readonly goal: string
  readonly contract: {
    readonly ciEntry: string
    readonly timeoutMs: number
    readonly scoreField: string
    readonly acceptance: unknown
  }
  readonly budget: { readonly maxPullRequests: number; readonly maxComputeMinutes: number; readonly maxTokens: number }
}

export interface CreateIssueRequest {
  readonly programId: ProgramId
  readonly title: string
  readonly body: string
  readonly labels: readonly string[]
}

export interface ClaimIssueRequest {
  readonly programId: ProgramId
  readonly issueId: string
}

export interface CommentRequest {
  readonly programId: ProgramId
  readonly issueId: string
  readonly body: string
}

export interface RequestCIRequest {
  readonly programId: ProgramId
  readonly pullRequestId: string
}

/** Route table the Host mounts; handlers are typed by these request/response pairs. */
export interface ManagementRoutes {
  readonly 'GET /aleph/api/programs': { readonly response: ApiResponse<readonly ProgramSummary[]> }
  readonly 'POST /aleph/api/programs': { readonly request: CreateProgramRequest; readonly response: ApiResponse<Program> }
  readonly 'GET /aleph/api/programs/:id': { readonly response: ApiResponse<ProgramSnapshot> }
  readonly 'POST /aleph/api/issues': { readonly request: CreateIssueRequest; readonly response: ApiResponse<Issue> }
  readonly 'POST /aleph/api/issues/:id/claim': { readonly request: ClaimIssueRequest; readonly response: ApiResponse<Issue> }
  readonly 'POST /aleph/api/issues/:id/comments': { readonly request: CommentRequest; readonly response: ApiResponse<IssueComment> }
  readonly 'POST /aleph/api/pull-requests/:id/ci': { readonly request: RequestCIRequest; readonly response: ApiResponse<CIRun> }
}
