export type CompletionFeature =
  | 'experiment-to-ticket'
  | 'implementer-ticket-execution'
  | 'benchmark-evaluation-writeback'
  | 'researcher-review-loop'
  | 'researcher-session-tools'
  | 'wasm-core-loading'
  | 'rust-command-bridge'

export const COMPLETION_FEATURES: readonly CompletionFeature[] = [
  'experiment-to-ticket',
  'implementer-ticket-execution',
  'benchmark-evaluation-writeback',
  'researcher-review-loop',
  'researcher-session-tools',
  'wasm-core-loading',
  'rust-command-bridge',
]

export type CompletionState = 'done' | 'todo'

const completion = <L extends Readonly<Record<CompletionFeature, CompletionState>>>(ledger: L): L => ledger

export const COMPLETION = completion({
  'experiment-to-ticket': 'done',
  'implementer-ticket-execution': 'done',
  'benchmark-evaluation-writeback': 'done',
  'researcher-review-loop': 'done',
  'researcher-session-tools': 'done',
  'wasm-core-loading': 'done',
  'rust-command-bridge': 'done',
})

const COMPLETION_STATES: Readonly<Record<CompletionFeature, CompletionState>> = COMPLETION

function isPending(feature: CompletionFeature): boolean {
  return COMPLETION_STATES[feature] === 'todo'
}

export function pendingFeatures(): readonly CompletionFeature[] {
  return COMPLETION_FEATURES.filter(isPending)
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
