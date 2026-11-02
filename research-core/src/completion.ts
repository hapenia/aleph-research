/**
 * Completion ledger for the research runtime.
 *
 * A feature that has no end-to-end path yet must be listed here as `'todo'` and marked
 * with `TODO(@feature)` in the code that is missing. `npm run check:completion` verifies
 * the markers against this ledger; `npm run check:release` additionally fails while any
 * feature is still `'todo'` (type-level release gate).
 */
export type CompletionFeature =
  | 'experiment-to-ticket'
  | 'implementer-ticket-execution'
  | 'ci-evaluation-writeback'
  | 'researcher-review-loop'
  | 'researcher-session-tools'
  | 'case-migration-live-run'
  | 'sampler-wiring'
  | 'wasm-core-migration'

export const COMPLETION_FEATURES: readonly CompletionFeature[] = [
  'experiment-to-ticket',
  'implementer-ticket-execution',
  'ci-evaluation-writeback',
  'researcher-review-loop',
  'researcher-session-tools',
  'case-migration-live-run',
  'sampler-wiring',
  'wasm-core-migration',
]

export type CompletionState = 'done' | 'todo'

/** Every feature must be listed; missing keys are a compile error. */
export const COMPLETION: Readonly<Record<CompletionFeature, CompletionState>> = {
  'experiment-to-ticket': 'todo',
  'implementer-ticket-execution': 'todo',
  'ci-evaluation-writeback': 'todo',
  'researcher-review-loop': 'todo',
  'researcher-session-tools': 'todo',
  'case-migration-live-run': 'todo',
  'sampler-wiring': 'todo',
  'wasm-core-migration': 'todo',
}

export function pendingFeatures(): readonly CompletionFeature[] {
  return COMPLETION_FEATURES.filter((feature) => COMPLETION[feature] === 'todo')
}

export type DoneLedger = { readonly [K in CompletionFeature]: 'done' }

/**
 * Type-level release gate: passing a ledger with any `'todo'` does not typecheck.
 * Kept out of the normal build (see `release-gate.ts` and `check:release`) so day-to-day
 * typechecking stays usable, but a release cannot ignore an unfinished feature.
 */
export function assertReleaseReady<L extends Readonly<Record<CompletionFeature, CompletionState>>>(
  ledger: L & (L extends DoneLedger ? unknown : { readonly __incompleteFeaturesRemain: never }),
): void {
  void ledger
}

export class UnimplementedError extends Error {
  readonly code = 'UNIMPLEMENTED'
  readonly feature: CompletionFeature
  constructor(feature: CompletionFeature, detail: string) {
    super(`${feature} is not implemented: ${detail}`)
    this.name = 'UnimplementedError'
    this.feature = feature
  }
}

/** Throw this instead of silently returning a half-implemented result. */
export function unimplemented(feature: CompletionFeature, detail: string): never {
  throw new UnimplementedError(feature, detail)
}
