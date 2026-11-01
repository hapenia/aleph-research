/** Nominal identities and refined boundary values. */
declare const brand: unique symbol
export type Brand<T, B extends string> = T & { readonly [brand]: B }

export type ProgramId = Brand<string, 'ProgramId'>
export type IssueId = Brand<string, 'IssueId'>
export type ExperimentId = Brand<string, 'ExperimentId'>
export type CIRunId = Brand<string, 'CIRunId'>
export type CommentId = Brand<string, 'CommentId'>
export type ReviewId = Brand<string, 'ReviewId'>
export type ArtifactId = Brand<string, 'ArtifactId'>
export type AuditId = Brand<string, 'AuditId'>
export type AttentionId = Brand<string, 'AttentionId'>
export type RequestId = Brand<string, 'RequestId'>
export type MetricName = Brand<string, 'MetricName'>

export type ResearcherSessionId = Brand<string, 'ResearcherSessionId'>
export type ImplementerSessionId = Brand<string, 'ImplementerSessionId'>
export type OperatorSessionId = Brand<string, 'OperatorSessionId'>
export type WatchdogSessionId = Brand<string, 'WatchdogSessionId'>
export type RouterSessionId = Brand<string, 'RouterSessionId'>

export type TicketId = Brand<string, 'TicketId'>
export type CommitSha = Brand<string, 'CommitSha'>
export type BranchName = Brand<string, 'BranchName'>
export type IsoTimestamp = Brand<string, 'IsoTimestamp'>
export type Version = Brand<number, 'Version'>
export type NonEmptyString = Brand<string, 'NonEmptyString'>
export type PositiveInt = Brand<number, 'PositiveInt'>
export type NonNegativeNumber = Brand<number, 'NonNegativeNumber'>
export type DurationMs = Brand<number, 'DurationMs'>
export type NonEmptyArray<T> = readonly [T, ...T[]]
export type Untrusted<T> = T & { readonly untrusted: true }
