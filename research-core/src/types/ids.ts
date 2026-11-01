/**
 * Nominal identities and value types.
 *
 * Every domain object gets a branded id so a ProgramId cannot be passed where an
 * IssueId is expected. The brand exists only in the type system; parsing at the
 * boundary is what turns untrusted strings into these values.
 */

declare const brand: unique symbol

/** A nominal type: the base type plus a compile-time brand. */
export type Brand<T, B extends string> = T & { readonly [brand]: B }

export type ProgramId = Brand<string, 'ProgramId'>
export type IssueId = Brand<string, 'IssueId'>
export type ExperimentId = Brand<string, 'ExperimentId'>
export type CIRunId = Brand<string, 'CIRunId'>
export type CommentId = Brand<string, 'CommentId'>
export type EventId = Brand<string, 'EventId'>
export type ImplementerId = Brand<string, 'ImplementerId'>
export type SessionId = Brand<string, 'SessionId'>
export type TicketId = Brand<string, 'TicketId'>

/** A git commit id; the domain never rewrites history of a reviewed commit. */
export type CommitSha = Brand<string, 'CommitSha'>

/** ISO-8601 timestamp, normalized to `Date#toISOString` form at the boundary. */
export type IsoTimestamp = Brand<string, 'IsoTimestamp'>

/** A branch name in the research repository. */
export type BranchName = Brand<string, 'BranchName'>

/** Monotonic aggregate version used for optimistic concurrency. */
export type Version = Brand<number, 'Version'>

/** A non-negative evaluation score; the unit belongs to the Program contract. */
export type Score = Brand<number, 'Score'>

/** Marks every value that came from an untrusted boundary (HTTP, model output). */
export type Untrusted<T> = T & { readonly untrusted: true }


/** Text that a boundary parser has checked to be non-empty and trimmed. */
export type NonEmptyString = Brand<string, 'NonEmptyString'>

/** A count or size that is greater than zero. */
export type PositiveInt = Brand<number, 'PositiveInt'>

/** A count that may be zero (usage counters). */
export type NonNegativeInt = Brand<number, 'NonNegativeInt'>

/** Duration in milliseconds, greater than zero. */
export type DurationMs = Brand<number, 'DurationMs'>

/** An HTTP status chosen by the API mapping table, never invented per handler. */
export type HttpStatus = 200 | 201 | 202 | 400 | 403 | 404 | 409 | 422 | 500
