import type { Result } from '../types/errors.js'
import type { CommitSha } from '../types/ids.js'
import type {
  CoreBridgeError,
  CoreConcepts,
  CoreEffectFailure,
  CoreEffectResume,
  CoreFrame,
  CoreLoadError,
  CoreOutcome,
  CoreResearcherDecision,
  CoreStageName,
  CoreStartInput,
  ResearchCore,
} from './boundary.js'
import { effectOf, loadBundledResearchCore, performEffect } from './wasm.js'

export interface CoreRuntimeHooks {
  canSubmitCommit(ticketId: string): Promise<boolean>
}

export interface CorePending {
  readonly effect: 'sessions.review' | 'sessions.submitCommit'
  readonly sequence: string
  readonly stage: CoreStageName
}

export type CoreProgress =
  | { readonly status: 'paused'; readonly pending: CorePending }
  | {
      readonly status: 'completed'
      readonly outcome: CoreOutcome
      readonly stages: readonly CoreStageName[]
    }
  | { readonly status: 'failed'; readonly error: CoreBridgeError }

export interface CoreRuntime {
  start(input: CoreStartInput): Promise<CoreProgress>
  resumeReview(decision: CoreResearcherDecision): Promise<CoreProgress>
  resumeCommit(commit: CommitSha): Promise<CoreProgress>
  failPending(message: string): Promise<CoreProgress>
  pending(): CorePending | undefined
  readonly core: ResearchCore
  readonly concepts: CoreConcepts
}

export interface CoreRuntimeInput {
  readonly concepts: CoreConcepts
  readonly hooks?: CoreRuntimeHooks
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : 'the core runtime failed'
}

function failed(error: CoreBridgeError): CoreProgress {
  return { status: 'failed', error }
}

function protocolFailure(message: string): CoreProgress {
  return failed({ kind: 'protocol', message })
}

class Runtime implements CoreRuntime {
  readonly core: ResearchCore
  readonly concepts: CoreConcepts
  private readonly hooks: CoreRuntimeHooks | undefined
  private current: CorePending | undefined

  constructor(core: ResearchCore, concepts: CoreConcepts, hooks: CoreRuntimeHooks | undefined) {
    this.core = core
    this.concepts = concepts
    this.hooks = hooks
    this.current = undefined
  }

  pending(): CorePending | undefined {
    return this.current
  }

  async start(input: CoreStartInput): Promise<CoreProgress> {
    this.current = undefined
    const started = this.core.start(input)
    if (!started.ok) return failed(started.error)
    return this.advance(started.value)
  }

  async resumeReview(decision: CoreResearcherDecision): Promise<CoreProgress> {
    const pending = this.current
    if (pending === undefined || pending.effect !== 'sessions.review') {
      return protocolFailure('no review effect is pending')
    }
    this.current = undefined
    const resumed = this.core.resume({
      effect: 'sessions.review',
      sequence: pending.sequence,
      result: { ok: true, value: decision },
    })
    if (!resumed.ok) return failed(resumed.error)
    return this.advance(resumed.value)
  }

  async resumeCommit(commit: CommitSha): Promise<CoreProgress> {
    const pending = this.current
    if (pending === undefined || pending.effect !== 'sessions.submitCommit') {
      return protocolFailure('no commit effect is pending')
    }
    this.current = undefined
    const resumed = this.core.resume({
      effect: 'sessions.submitCommit',
      sequence: pending.sequence,
      result: { ok: true, value: commit },
    })
    if (!resumed.ok) return failed(resumed.error)
    return this.advance(resumed.value)
  }

  async failPending(message: string): Promise<CoreProgress> {
    const pending = this.current
    if (pending === undefined) return protocolFailure('no effect is pending')
    this.current = undefined
    const failure: CoreEffectFailure = { kind: 'unavailable', message }
    const resumed = pending.effect === 'sessions.submitCommit'
      ? this.core.resume({
          effect: 'sessions.submitCommit',
          sequence: pending.sequence,
          result: { ok: false, failure },
        })
      : this.core.resume({
          effect: 'sessions.review',
          sequence: pending.sequence,
          result: { ok: false, failure },
        })
    if (!resumed.ok) return failed(resumed.error)
    return this.advance(resumed.value)
  }

  private async advance(frame: CoreFrame): Promise<CoreProgress> {
    let current = frame
    while (current.kind === 'effect') {
      if (current.effect === 'sessions.review') {
        this.current = {
          effect: 'sessions.review',
          sequence: current.sequence,
          stage: current.stage,
        }
        return { status: 'paused', pending: this.current }
      }
      if (
        current.effect === 'sessions.submitCommit'
        && this.hooks !== undefined
        && !(await this.hooks.canSubmitCommit(current.payload.ticketId))
      ) {
        this.current = {
          effect: 'sessions.submitCommit',
          sequence: current.sequence,
          stage: current.stage,
        }
        return { status: 'paused', pending: this.current }
      }
      let resume: CoreEffectResume
      try {
        resume = await performEffect(this.concepts, current.sequence, effectOf(current))
      } catch (error) {
        return failed({
          kind: 'concept',
          message: errorMessage(error),
          effect: current.effect,
        })
      }
      const resumed = this.core.resume(resume)
      if (!resumed.ok) {
        return failed({ ...resumed.error, effect: current.effect })
      }
      current = resumed.value
    }
    return { status: 'completed', outcome: current.outcome, stages: current.stages }
  }
}

export async function createCoreRuntime(
  input: CoreRuntimeInput,
): Promise<Result<CoreRuntime, CoreLoadError>> {
  const loaded = await loadBundledResearchCore(input.concepts)
  if (!loaded.ok) return loaded
  return {
    ok: true,
    value: new Runtime(loaded.value, input.concepts, input.hooks),
  }
}
