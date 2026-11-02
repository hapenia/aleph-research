export type CompletionFeature =
  | 'experiment-to-ticket'
  | 'implementer-ticket-execution'
  | 'benchmark-evaluation-writeback'
  | 'researcher-review-loop'
  | 'researcher-session-tools'
  | 'case-migration-live-run'
  | 'sampler-wiring'

export const COMPLETION_FEATURES: readonly CompletionFeature[] = [
  'experiment-to-ticket',
  'implementer-ticket-execution',
  'benchmark-evaluation-writeback',
  'researcher-review-loop',
  'researcher-session-tools',
  'case-migration-live-run',
  'sampler-wiring',
]

export type CompletionState = 'done' | 'todo'

export const COMPLETION: Readonly<Record<CompletionFeature, CompletionState>> = {
  'experiment-to-ticket': 'todo',
  'implementer-ticket-execution': 'todo',
  'benchmark-evaluation-writeback': 'todo',
  'researcher-review-loop': 'todo',
  'researcher-session-tools': 'todo',
  'case-migration-live-run': 'todo',
  'sampler-wiring': 'todo',
}

export function pendingFeatures(): readonly CompletionFeature[] {
  return COMPLETION_FEATURES.filter((feature) => COMPLETION[feature] === 'todo')
}

export type DoneLedger = { readonly [K in CompletionFeature]: 'done' }

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

export function unimplemented(feature: CompletionFeature, detail: string): never {
  throw new UnimplementedError(feature, detail)
}
