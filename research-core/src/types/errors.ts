/** Domain results and errors. Commands return a Result; they never throw for domain refusals. */
import type { Version } from './ids.js'

export type Ok<T> = { readonly ok: true; readonly value: T }
export type Err<E> = { readonly ok: false; readonly error: E }
export type Result<T, E> = Ok<T> | Err<E>

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value })
export const err = <E>(error: E): Err<E> => ({ ok: false, error })

/** Closed set of domain refusal reasons; the management API maps each to a status. */
export type DomainErrorCode =
  | 'not-found'
  | 'conflict'
  | 'version-conflict'
  | 'forbidden'
  | 'invalid-state'
  | 'invalid-input'
  | 'budget-exhausted'
  | 'acceptance-not-met'
  | 'ci-not-passed'
  | 'merge-conflict'
  | 'environment-invalid'

export interface DomainError {
  readonly code: DomainErrorCode
  readonly message: string
  /** Structured details for the panel and logs; never parsed by the domain. */
  readonly details?: Readonly<Record<string, unknown>>
}

export interface VersionConflict {
  readonly code: 'version-conflict'
  readonly expected: Version
  readonly actual: Version
}

/** Storage/appending failures are separate from domain refusals. */
export type StoreError =
  | { readonly kind: 'version-conflict'; readonly conflict: VersionConflict }
  | { readonly kind: 'io'; readonly message: string }
  | { readonly kind: 'corrupt'; readonly message: string }
