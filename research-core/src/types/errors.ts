/** Domain results and errors. Commands return a Result; they never throw for domain refusals. */
import type { HttpStatus, Version } from './ids.js'

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


/** Compile-time mapping from domain refusal to HTTP status; handlers cannot invent one. */
export type HttpStatusForError = {
  readonly 'not-found': 404
  readonly conflict: 409
  readonly 'version-conflict': 409
  readonly forbidden: 403
  readonly 'invalid-state': 409
  readonly 'invalid-input': 400
  readonly 'budget-exhausted': 422
  readonly 'acceptance-not-met': 422
  readonly 'ci-not-passed': 422
  readonly 'merge-conflict': 409
  readonly 'environment-invalid': 422
}

export type StatusOf<E extends DomainErrorCode> = HttpStatusForError[E] extends HttpStatus
  ? HttpStatusForError[E]
  : never

/** The API answer for a refusal; the status follows from the code. */
export type DomainFailure = {
  readonly [E in DomainErrorCode]: {
    readonly ok: false
    readonly status: StatusOf<E>
    readonly error: Extract<DomainError, { readonly code: E }>
  }
}[DomainErrorCode]
