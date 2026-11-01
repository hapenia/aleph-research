/** Domain results, refusals and their HTTP mapping. */
import type { NonEmptyString } from './ids.js'

export type Ok<T> = { readonly ok: true; readonly value: T }
export type Err<E> = { readonly ok: false; readonly error: E }
export type Result<T, E> = Ok<T> | Err<E>

export type DomainErrorCode =
  | 'not-found'
  | 'conflict'
  | 'version-conflict'
  | 'forbidden'
  | 'invalid-state'
  | 'invalid-input'
  | 'budget-exhausted'
  | 'ci-not-passed'
  | 'environment-invalid'
  | 'sampling-unavailable'

/** A refusal is a union per code, so the mapped extraction is inhabitable. */
export type DomainError = {
  readonly [C in DomainErrorCode]: {
    readonly code: C
    readonly message: NonEmptyString
    readonly details?: Readonly<Record<string, string | number | boolean | null>>
  }
}[DomainErrorCode]

export type StoreError =
  | { readonly kind: 'version-conflict'; readonly expected: number; readonly actual: number }
  | { readonly kind: 'io'; readonly message: NonEmptyString }
  | { readonly kind: 'corrupt'; readonly message: NonEmptyString }

export type HttpStatusForError = {
  readonly 'not-found': 404
  readonly conflict: 409
  readonly 'version-conflict': 409
  readonly forbidden: 403
  readonly 'invalid-state': 409
  readonly 'invalid-input': 400
  readonly 'budget-exhausted': 422
  readonly 'ci-not-passed': 422
  readonly 'environment-invalid': 422
  readonly 'sampling-unavailable': 422
}

export type StatusOf<C extends DomainErrorCode> = HttpStatusForError[C]

export type DomainFailure = {
  readonly [C in DomainErrorCode]: {
    readonly ok: false
    readonly status: StatusOf<C>
    readonly error: Extract<DomainError, { readonly code: C }>
  }
}[DomainErrorCode]
