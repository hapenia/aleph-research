/**
 * Parser boundary (implementation phase): the only module allowed to turn untrusted
 * input into branded ids, timestamps, versions, metric names, JSON schemas and tool
 * schemas. The adapter imports this module; it must not cast outside it.
 */
import type { DomainError, Result } from './types/errors.js'
import type {
  BranchName,
  CommitSha,
  IsoTimestamp,
  MetricName,
  RequestId,
  ResearcherSessionId,
  Version,
} from './types/ids.js'

export declare function researcherSessionId(input: unknown): Result<ResearcherSessionId, DomainError>
export declare function commitSha(input: unknown): Result<CommitSha, DomainError>
export declare function branchName(input: unknown): Result<BranchName, DomainError>
export declare function isoTimestamp(input: unknown): Result<IsoTimestamp, DomainError>
export declare function version(input: unknown): Result<Version, DomainError>
export declare function metricName(input: unknown): Result<MetricName, DomainError>
export declare function requestId(input: unknown): Result<RequestId, DomainError>

export declare function schema<T>(input: unknown): Result<import('./types/tools.js').Schema<T>, DomainError>
