/**
 * Hydration boundary (implementation phase): the only module allowed to parse storage
 * rows or JSON into nominal states. Every function returns a Result and validates at
 * runtime; no other module may turn a row into a domain state.
 */
import type { Result, StoreError } from './types/errors.js'
import type { AuditEntry } from './types/audit.js'
import type { Attention } from './types/attention.js'
import type { ArtifactRef } from './types/artifacts.js'
import type { Experiment } from './types/experiment.js'
import type { Issue, IssueComment } from './types/issue.js'
import type { CIRecord } from './types/metrics.js'
import type { Program } from './types/program.js'
import type { Ticket } from './types/ticket.js'

export declare function hydrateProgram(row: unknown): Result<Program, StoreError>
export declare function hydrateIssue(row: unknown): Result<Issue, StoreError>
export declare function hydrateIssueComment(row: unknown): Result<IssueComment, StoreError>
export declare function hydrateExperiment(row: unknown): Result<Experiment, StoreError>
export declare function hydrateCIRecord(row: unknown): Result<CIRecord, StoreError>
export declare function hydrateTicket(row: unknown): Result<Ticket, StoreError>
export declare function hydrateArtifact(row: unknown): Result<ArtifactRef, StoreError>
export declare function hydrateAuditEntry(row: unknown): Result<AuditEntry, StoreError>
export declare function hydrateAttention(row: unknown): Result<Attention, StoreError>
