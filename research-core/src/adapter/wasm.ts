import type { Result } from '../types/errors.js'
import type {
  CoreBridgeError,
  CoreCompletion,
  CoreConcepts,
  CoreEffect,
  CoreEffectFailure,
  CoreEffectFrame,
  CoreEffectResume,
  CoreFactory,
  CoreFrame,
  CoreHandle,
  CoreLoadError,
  CoreStartInput,
  CoreWireFrame,
  ResearchCore,
} from './boundary.js'
import { CORE_BOUNDARY_VERSION } from './boundary.js'
import { decodeBase64 } from './base64.js'
import { Core } from './wasm-bindgen/core.js'
import { WASM_CORE_BASE64, initCore } from './wasm-core.js'

export * from './boundary.js'

export interface LoadResearchCoreInput {
  readonly concepts: CoreConcepts
  readonly factory?: CoreFactory
}

const DEFAULT_FACTORY: CoreFactory = {
  create: () => {
    initCore()
    return new Core()
  },
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : 'the wasm core failed'
}

function attempt<T>(
  work: () => Promise<Result<T, CoreEffectFailure>>,
): Promise<Result<T, CoreEffectFailure>> {
  return work().catch((error: unknown) => ({
    ok: false,
    error: { kind: 'unavailable', message: errorMessage(error) },
  }))
}

class WasmCore implements ResearchCore {
  readonly boundaryVersion: number
  private readonly core: CoreHandle
  private readonly concepts: CoreConcepts

  constructor(core: CoreHandle, concepts: CoreConcepts, boundaryVersion: number) {
    this.core = core
    this.concepts = concepts
    this.boundaryVersion = boundaryVersion
  }

  start(input: CoreStartInput): Result<CoreFrame, CoreBridgeError> {
    try {
      return frameResult(this.core.start(input))
    } catch (error) {
      return { ok: false, error: { kind: 'transport', message: errorMessage(error) } }
    }
  }

  resume(input: CoreEffectResume): Result<CoreFrame, CoreBridgeError> {
    try {
      return frameResult(this.core.resume(input))
    } catch (error) {
      return { ok: false, error: { kind: 'transport', message: errorMessage(error) } }
    }
  }

  async run(input: CoreStartInput): Promise<Result<CoreCompletion, CoreBridgeError>> {
    const started = this.start(input)
    if (!started.ok) return started
    let frame = started.value
    while (frame.kind === 'effect') {
      const effect = effectOf(frame)
      let pending: CoreEffectResume
      try {
        pending = await performEffect(this.concepts, frame.sequence, effect)
      } catch (error) {
        return {
          ok: false,
          error: { kind: 'concept', message: errorMessage(error), effect: frame.effect },
        }
      }
      const resumed = this.resume(pending)
      if (!resumed.ok) {
        return { ok: false, error: { ...resumed.error, effect: frame.effect } }
      }
      frame = resumed.value
    }
    return { ok: true, value: { outcome: frame.outcome, stages: frame.stages } }
  }
}

function frameResult(frame: CoreWireFrame): Result<CoreFrame, CoreBridgeError> {
  if (frame.kind === 'protocol') {
    return { ok: false, error: { kind: 'protocol', message: frame.message } }
  }
  if (frame.kind === 'domain') {
    return { ok: false, error: { kind: 'domain', message: frame.message } }
  }
  return { ok: true, value: frame }
}

export function effectOf(frame: CoreEffectFrame): CoreEffect {
  switch (frame.effect) {
    case 'storage.loadProgram':
      return { name: frame.effect, programId: frame.payload.programId }
    case 'trigger.deliver':
      return {
        name: frame.effect,
        experimentId: frame.payload.experimentId,
        branch: frame.payload.branch,
        baseCommit: frame.payload.baseCommit,
      }
    case 'executor.open':
      return {
        name: frame.effect,
        programId: frame.payload.programId,
        issueId: frame.payload.issueId,
        experimentId: frame.payload.experimentId,
      }
    case 'sessions.startWorker':
      return {
        name: frame.effect,
        ticketId: frame.payload.ticketId,
        experimentId: frame.payload.experimentId,
      }
    case 'sessions.submitCommit':
      return {
        name: frame.effect,
        ticketId: frame.payload.ticketId,
        workerSessionId: frame.payload.workerSessionId,
      }
    case 'benchmark.buildEnvironment':
      return {
        name: frame.effect,
        commit: frame.payload.commit,
        environment: frame.payload.environment,
      }
    case 'benchmark.specHash':
      return { name: frame.effect, spec: frame.payload.spec }
    case 'benchmark.run':
      return {
        name: frame.effect,
        experimentId: frame.payload.experimentId,
        ticketId: frame.payload.ticketId,
        spec: frame.payload.spec,
        commit: frame.payload.commit,
        environmentDigest: frame.payload.environmentDigest,
        attempt: frame.payload.attempt,
        maxAttempts: frame.payload.maxAttempts,
      }
    case 'storage.appendBenchmarkRecord':
      return { name: frame.effect, record: frame.payload.record }
    case 'sessions.review':
      return {
        name: frame.effect,
        experimentId: frame.payload.experimentId,
        benchmark: frame.payload.benchmark,
      }
    case 'clock.now':
      return { name: frame.effect }
  }
}

export async function performEffect(
  concepts: CoreConcepts,
  sequence: string,
  effect: CoreEffect,
): Promise<CoreEffectResume> {
  switch (effect.name) {
    case 'storage.loadProgram': {
      const result = await attempt(() => concepts.storage.loadProgram(effect.programId))
      return result.ok
        ? { effect: 'storage.loadProgram', sequence, result: { ok: true, value: result.value } }
        : {
            effect: 'storage.loadProgram',
            sequence,
            result: { ok: false, failure: result.error },
          }
    }
    case 'trigger.deliver': {
      const result = await attempt(() =>
        concepts.trigger.deliver({
          experimentId: effect.experimentId,
          branch: effect.branch,
          baseCommit: effect.baseCommit,
        }),
      )
      return result.ok
        ? { effect: 'trigger.deliver', sequence, result: { ok: true, value: result.value } }
        : {
            effect: 'trigger.deliver',
            sequence,
            result: { ok: false, failure: result.error },
          }
    }
    case 'executor.open': {
      const result = await attempt(() =>
        concepts.executor.open({
          programId: effect.programId,
          issueId: effect.issueId,
          experimentId: effect.experimentId,
        }),
      )
      return result.ok
        ? { effect: 'executor.open', sequence, result: { ok: true, value: result.value } }
        : {
            effect: 'executor.open',
            sequence,
            result: { ok: false, failure: result.error },
          }
    }
    case 'sessions.startWorker': {
      const result = await attempt(() =>
        concepts.sessions.startWorker({
          ticketId: effect.ticketId,
          experimentId: effect.experimentId,
        }),
      )
      return result.ok
        ? { effect: 'sessions.startWorker', sequence, result: { ok: true, value: result.value } }
        : {
            effect: 'sessions.startWorker',
            sequence,
            result: { ok: false, failure: result.error },
          }
    }
    case 'sessions.submitCommit': {
      const result = await attempt(() =>
        concepts.sessions.submitCommit({
          ticketId: effect.ticketId,
          workerSessionId: effect.workerSessionId,
        }),
      )
      return result.ok
        ? {
            effect: 'sessions.submitCommit',
            sequence,
            result: { ok: true, value: result.value },
          }
        : {
            effect: 'sessions.submitCommit',
            sequence,
            result: { ok: false, failure: result.error },
          }
    }
    case 'benchmark.buildEnvironment': {
      const result = await attempt(() =>
        concepts.benchmark.buildEnvironment({
          commit: effect.commit,
          environment: effect.environment,
        }),
      )
      return result.ok
        ? {
            effect: 'benchmark.buildEnvironment',
            sequence,
            result: { ok: true, value: result.value },
          }
        : {
            effect: 'benchmark.buildEnvironment',
            sequence,
            result: { ok: false, failure: result.error },
          }
    }
    case 'benchmark.specHash': {
      const result = await attempt(() => concepts.benchmark.specHash(effect.spec))
      return result.ok
        ? {
            effect: 'benchmark.specHash',
            sequence,
            result: { ok: true, value: result.value },
          }
        : {
            effect: 'benchmark.specHash',
            sequence,
            result: { ok: false, failure: result.error },
          }
    }
    case 'benchmark.run': {
      const result = await attempt(() =>
        concepts.benchmark.run({
          experimentId: effect.experimentId,
          ticketId: effect.ticketId,
          spec: effect.spec,
          commit: effect.commit,
          environmentDigest: effect.environmentDigest,
          attempt: effect.attempt,
          maxAttempts: effect.maxAttempts,
        }),
      )
      return result.ok
        ? { effect: 'benchmark.run', sequence, result: { ok: true, value: result.value } }
        : {
            effect: 'benchmark.run',
            sequence,
            result: { ok: false, failure: result.error },
          }
    }
    case 'storage.appendBenchmarkRecord': {
      const result = await attempt(() =>
        concepts.storage.appendBenchmarkRecord(effect.record),
      )
      return result.ok
        ? {
            effect: 'storage.appendBenchmarkRecord',
            sequence,
            result: { ok: true, value: { acknowledged: true } },
          }
        : {
            effect: 'storage.appendBenchmarkRecord',
            sequence,
            result: { ok: false, failure: result.error },
          }
    }
    case 'sessions.review': {
      const result = await attempt(() =>
        concepts.sessions.review({
          experimentId: effect.experimentId,
          benchmark: effect.benchmark,
        }),
      )
      return result.ok
        ? { effect: 'sessions.review', sequence, result: { ok: true, value: result.value } }
        : {
            effect: 'sessions.review',
            sequence,
            result: { ok: false, failure: result.error },
          }
    }
    case 'clock.now': {
      return {
        effect: 'clock.now',
        sequence,
        result: { ok: true, value: concepts.clock.now() },
      }
    }
  }
}

export function loadResearchCore(
  input: LoadResearchCoreInput,
): Promise<Result<ResearchCore, CoreLoadError>> {
  let core: CoreHandle
  try {
    core = (input.factory ?? DEFAULT_FACTORY).create()
  } catch (error) {
    return Promise.resolve({
      ok: false,
      error: { kind: 'instantiate', message: errorMessage(error) },
    })
  }
  const actual = core.boundary_version()
  if (actual !== CORE_BOUNDARY_VERSION) {
    return Promise.resolve({
      ok: false,
      error: {
        kind: 'boundary-version',
        expected: CORE_BOUNDARY_VERSION,
        actual,
      },
    })
  }
  return Promise.resolve({
    ok: true,
    value: new WasmCore(core, input.concepts, actual),
  })
}

export function bundledResearchCoreModule(): Uint8Array {
  return decodeBase64(WASM_CORE_BASE64)
}

export function loadBundledResearchCore(
  concepts: CoreConcepts,
): Promise<Result<ResearchCore, CoreLoadError>> {
  return loadResearchCore({ concepts })
}
