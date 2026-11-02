import type { Result } from '../types/errors.js'
import type {
  CoreBridgeError,
  CoreCompletion,
  CoreConcepts,
  CoreEffect,
  CoreEffectFailure,
  CoreEffectResume,
  CoreFrame,
  CoreLoadError,
  CoreSource,
  CoreStartInput,
  CoreWasmExports,
  ResearchCore,
  WasmInstance,
  WasmRuntime,
} from './boundary.js'
import { CORE_BOUNDARY_VERSION } from './boundary.js'
import { decodeBase64, decodeEffect, decodeFrame, encodeResume, encodeStart } from './wasm-codec.js'
import { WASM_CORE_BASE64 } from './wasm-core.js'

export * from './boundary.js'

declare const WebAssembly: {
  instantiate(module: Uint8Array): Promise<{ readonly instance: WasmInstance }>
}

export interface LoadResearchCoreInput {
  readonly source: CoreSource
  readonly concepts: CoreConcepts
  readonly runtime?: WasmRuntime
}

const DEFAULT_RUNTIME: WasmRuntime = {
  instantiate: async (module) => {
    const instantiated = await WebAssembly.instantiate(module)
    return { exports: instantiated.instance.exports }
  },
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : 'the wasm core failed'
}

function transport(message: string): Result<never, CoreBridgeError> {
  return { ok: false, error: { kind: 'transport', message } }
}

function missingExport(exports: CoreWasmExports): string | undefined {
  if (exports.memory === undefined || exports.memory.buffer === undefined) return 'memory'
  if (typeof exports.aleph_bridge_version !== 'function') return 'aleph_bridge_version'
  if (typeof exports.aleph_alloc !== 'function') return 'aleph_alloc'
  if (typeof exports.aleph_free !== 'function') return 'aleph_free'
  if (typeof exports.aleph_start !== 'function') return 'aleph_start'
  if (typeof exports.aleph_resume !== 'function') return 'aleph_resume'
  if (typeof exports.aleph_response_len !== 'function') return 'aleph_response_len'
  if (typeof exports.aleph_response_write !== 'function') return 'aleph_response_write'
  return undefined
}

async function attempt<T>(
  work: () => Promise<Result<T, CoreEffectFailure>>,
): Promise<Result<T, CoreEffectFailure>> {
  try {
    return await work()
  } catch (error) {
    return { ok: false, error: { kind: 'unavailable', message: errorMessage(error) } }
  }
}

class WasmCore implements ResearchCore {
  readonly boundaryVersion: number
  private readonly exports: CoreWasmExports
  private readonly concepts: CoreConcepts

  constructor(exports: CoreWasmExports, concepts: CoreConcepts, boundaryVersion: number) {
    this.exports = exports
    this.concepts = concepts
    this.boundaryVersion = boundaryVersion
  }

  start(input: CoreStartInput): Result<CoreFrame, CoreBridgeError> {
    return this.invoke(this.exports.aleph_start, encodeStart(input))
  }

  resume(input: CoreEffectResume): Result<CoreFrame, CoreBridgeError> {
    return this.invoke(this.exports.aleph_resume, encodeResume(input))
  }

  async run(input: CoreStartInput): Promise<Result<CoreCompletion, CoreBridgeError>> {
    const started = this.start(input)
    if (!started.ok) return started
    let frame = started.value
    while (frame.kind === 'effect') {
      const effect = decodeEffect(frame.effect, frame.payload)
      if (!effect.ok) {
        return { ok: false, error: { ...effect.error, effect: frame.effect } }
      }
      let pending: CoreEffectResume
      try {
        pending = await this.perform(frame.sequence, effect.value)
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

  private async perform(sequence: number, effect: CoreEffect): Promise<CoreEffectResume> {
    switch (effect.name) {
      case 'storage.loadProgram': {
        const result = await attempt(() =>
          this.concepts.storage.loadProgram(effect.programId),
        )
        return result.ok
          ? { effect: 'storage.loadProgram', sequence, result: { ok: true, value: result.value } }
          : { effect: 'storage.loadProgram', sequence, result: { ok: false, failure: result.error } }
      }
      case 'trigger.deliver': {
        const result = await attempt(() =>
          this.concepts.trigger.deliver({
            experimentId: effect.experimentId,
            branch: effect.branch,
            baseCommit: effect.baseCommit,
          }),
        )
        return result.ok
          ? { effect: 'trigger.deliver', sequence, result: { ok: true, value: result.value } }
          : { effect: 'trigger.deliver', sequence, result: { ok: false, failure: result.error } }
      }
      case 'executor.open': {
        const result = await attempt(() =>
          this.concepts.executor.open({
            programId: effect.programId,
            issueId: effect.issueId,
            experimentId: effect.experimentId,
          }),
        )
        return result.ok
          ? { effect: 'executor.open', sequence, result: { ok: true, value: result.value } }
          : { effect: 'executor.open', sequence, result: { ok: false, failure: result.error } }
      }
      case 'sessions.startWorker': {
        const result = await attempt(() =>
          this.concepts.sessions.startWorker({
            ticketId: effect.ticketId,
            experimentId: effect.experimentId,
          }),
        )
        return result.ok
          ? { effect: 'sessions.startWorker', sequence, result: { ok: true, value: result.value } }
          : { effect: 'sessions.startWorker', sequence, result: { ok: false, failure: result.error } }
      }
      case 'sessions.submitCommit': {
        const result = await attempt(() =>
          this.concepts.sessions.submitCommit({
            ticketId: effect.ticketId,
            workerSessionId: effect.workerSessionId,
          }),
        )
        return result.ok
          ? { effect: 'sessions.submitCommit', sequence, result: { ok: true, value: result.value } }
          : { effect: 'sessions.submitCommit', sequence, result: { ok: false, failure: result.error } }
      }
      case 'benchmark.buildEnvironment': {
        const result = await attempt(() =>
          this.concepts.benchmark.buildEnvironment({
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
        const result = await attempt(() => this.concepts.benchmark.specHash(effect.spec))
        return result.ok
          ? { effect: 'benchmark.specHash', sequence, result: { ok: true, value: result.value } }
          : { effect: 'benchmark.specHash', sequence, result: { ok: false, failure: result.error } }
      }
      case 'benchmark.run': {
        const result = await attempt(() =>
          this.concepts.benchmark.run({
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
          : { effect: 'benchmark.run', sequence, result: { ok: false, failure: result.error } }
      }
      case 'storage.appendBenchmarkRecord': {
        const result = await attempt(() =>
          this.concepts.storage.appendBenchmarkRecord(effect.record),
        )
        return result.ok
          ? {
              effect: 'storage.appendBenchmarkRecord',
              sequence,
              result: { ok: true, value: result.value },
            }
          : {
              effect: 'storage.appendBenchmarkRecord',
              sequence,
              result: { ok: false, failure: result.error },
            }
      }
      case 'sessions.review': {
        const result = await attempt(() =>
          this.concepts.sessions.review({
            experimentId: effect.experimentId,
            benchmark: effect.benchmark,
          }),
        )
        return result.ok
          ? { effect: 'sessions.review', sequence, result: { ok: true, value: result.value } }
          : { effect: 'sessions.review', sequence, result: { ok: false, failure: result.error } }
      }
      case 'clock.now': {
        return {
          effect: 'clock.now',
          sequence,
          result: { ok: true, value: this.concepts.clock.now() },
        }
      }
    }
  }

  private invoke(
    call: (pointer: number, length: number) => number,
    request: Uint8Array,
  ): Result<CoreFrame, CoreBridgeError> {
    const requestPointer = this.exports.aleph_alloc(request.length)
    if (requestPointer === 0) return transport('the core could not allocate a request buffer')
    new Uint8Array(this.exports.memory.buffer, requestPointer, request.length).set(request)
    const accepted = call(requestPointer, request.length)
    this.exports.aleph_free(requestPointer, request.length)
    if (accepted === 0) return transport('the core refused the request buffer')
    const length = this.exports.aleph_response_len()
    if (length === 0) return transport('the core produced an empty response')
    const responsePointer = this.exports.aleph_alloc(length)
    if (responsePointer === 0) return transport('the core could not allocate a response buffer')
    const written = this.exports.aleph_response_write(responsePointer, length)
    const response = new Uint8Array(
      this.exports.memory.buffer,
      responsePointer,
      written,
    ).slice()
    this.exports.aleph_free(responsePointer, length)
    if (written !== length) return transport('the core produced an incomplete response')
    return decodeFrame(response)
  }
}

export async function loadResearchCore(
  input: LoadResearchCoreInput,
): Promise<Result<ResearchCore, CoreLoadError>> {
  let instance: WasmInstance
  try {
    instance = await (input.runtime ?? DEFAULT_RUNTIME).instantiate(input.source.module)
  } catch (error) {
    return { ok: false, error: { kind: 'instantiate', message: errorMessage(error) } }
  }
  const missing = missingExport(instance.exports)
  if (missing !== undefined) {
    return { ok: false, error: { kind: 'missing-export', name: missing } }
  }
  const actual = instance.exports.aleph_bridge_version()
  if (actual !== CORE_BOUNDARY_VERSION) {
    return {
      ok: false,
      error: {
        kind: 'boundary-version',
        expected: CORE_BOUNDARY_VERSION,
        actual,
      },
    }
  }
  return {
    ok: true,
    value: new WasmCore(instance.exports, input.concepts, actual),
  }
}

export function bundledResearchCoreModule(): Uint8Array {
  return decodeBase64(WASM_CORE_BASE64)
}

export async function loadBundledResearchCore(
  concepts: CoreConcepts,
): Promise<Result<ResearchCore, CoreLoadError>> {
  return loadResearchCore({
    source: { module: bundledResearchCoreModule() },
    concepts,
  })
}
