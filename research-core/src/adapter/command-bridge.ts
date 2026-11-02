import type { Result } from '../types/errors.js'
import type {
  CommandBridge,
  CommandConcepts,
  CommandEffect,
  CommandEffectResult,
  CommandFrame,
  CommandLoadError,
  CommandWasmExports,
  CommandWasmInstance,
  CommandWasmRuntime,
  CoreCommandActor,
  CoreCommandDraft,
  CoreCommandEffectFailure,
  CoreCommandError,
  CoreCommandOutcome,
} from './command-boundary.js'
import { COMMAND_BOUNDARY_VERSION } from './command-boundary.js'
import {
  decodeCommandEffect,
  decodeCommandFrame,
  encodeClockValue,
  encodeCommandRequest,
  encodeCommandResume,
  encodeEmptyValue,
  encodeLoadExperimentValue,
  encodeLoadIssueValue,
  encodeLoadProgramValue,
  encodeLoadTicketValue,
  encodeVersionValue,
} from './command-codec.js'
import { decodeBase64 } from './wasm-codec.js'
import { WASM_CORE_BASE64 } from './wasm-core.js'

declare const WebAssembly: {
  instantiate(module: Uint8Array): Promise<{ readonly instance: CommandWasmInstance }>
}

const DEFAULT_RUNTIME: CommandWasmRuntime = {
  instantiate: async (module) => {
    const instantiated = await WebAssembly.instantiate(module)
    return { exports: instantiated.instance.exports }
  },
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : 'the command bridge failed'
}

function transport(message: string): CoreCommandError {
  return { kind: 'transport', message }
}

function missingExport(exports: CommandWasmExports): string | undefined {
  if (exports.memory === undefined || exports.memory.buffer === undefined) return 'memory'
  if (typeof exports.aleph_bridge_version !== 'function') return 'aleph_bridge_version'
  if (typeof exports.aleph_alloc !== 'function') return 'aleph_alloc'
  if (typeof exports.aleph_free !== 'function') return 'aleph_free'
  if (typeof exports.aleph_command_start !== 'function') return 'aleph_command_start'
  if (typeof exports.aleph_command_resume !== 'function') return 'aleph_command_resume'
  if (typeof exports.aleph_response_len !== 'function') return 'aleph_response_len'
  if (typeof exports.aleph_response_write !== 'function') return 'aleph_response_write'
  return undefined
}

type EffectOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: CoreCommandEffectFailure }

async function attempt<T>(work: () => Promise<T>): Promise<EffectOutcome<T>> {
  try {
    return { ok: true, value: await work() }
  } catch (error) {
    return { ok: false, failure: { kind: 'unavailable', message: errorMessage(error) } }
  }
}

function notFound(message: string): EffectOutcome<never> {
  return { ok: false, failure: { kind: 'not-found', message } }
}

async function performEffect(
  concepts: CommandConcepts,
  effect: CommandEffect,
): Promise<CommandEffectResult['result']> {
  const store = concepts.store
  switch (effect.name) {
    case 'storage.loadProgram': {
      const loaded = await attempt(() => store.loadProgram(effect.programId))
      if (!loaded.ok) return { ok: false, failure: loaded.failure }
      if (loaded.value === undefined) {
        return notFound(`program ${effect.programId} does not exist`)
      }
      return { ok: true, value: encodeLoadProgramValue(loaded.value) }
    }
    case 'storage.saveProgram': {
      const saved = await attempt(() => store.saveProgram(effect.program, effect.expected))
      if (!saved.ok) return { ok: false, failure: saved.failure }
      if (!saved.value.ok) return { ok: false, failure: saved.value.error }
      return { ok: true, value: encodeVersionValue(saved.value.value) }
    }
    case 'storage.loadIssue': {
      const loaded = await attempt(() => store.loadIssue(effect.issueId))
      if (!loaded.ok) return { ok: false, failure: loaded.failure }
      if (loaded.value === undefined) return notFound(`issue ${effect.issueId} does not exist`)
      return { ok: true, value: encodeLoadIssueValue(loaded.value) }
    }
    case 'storage.saveIssue': {
      const saved = await attempt(() => store.saveIssue(effect.issue, effect.expected))
      if (!saved.ok) return { ok: false, failure: saved.failure }
      if (!saved.value.ok) return { ok: false, failure: saved.value.error }
      return { ok: true, value: encodeVersionValue(saved.value.value) }
    }
    case 'storage.loadExperiment': {
      const loaded = await attempt(() => store.loadExperiment(effect.experimentId))
      if (!loaded.ok) return { ok: false, failure: loaded.failure }
      if (loaded.value === undefined) {
        return notFound(`experiment ${effect.experimentId} does not exist`)
      }
      return { ok: true, value: encodeLoadExperimentValue(loaded.value) }
    }
    case 'storage.saveExperiment': {
      const saved = await attempt(() =>
        store.saveExperiment(effect.experiment, effect.expected),
      )
      if (!saved.ok) return { ok: false, failure: saved.failure }
      if (!saved.value.ok) return { ok: false, failure: saved.value.error }
      return { ok: true, value: encodeVersionValue(saved.value.value) }
    }
    case 'storage.loadTicket': {
      const loaded = await attempt(() => store.loadTicket(effect.ticketId))
      if (!loaded.ok) return { ok: false, failure: loaded.failure }
      if (loaded.value === undefined) return notFound(`ticket ${effect.ticketId} does not exist`)
      return { ok: true, value: encodeLoadTicketValue(loaded.value) }
    }
    case 'storage.saveTicket': {
      const saved = await attempt(() => store.saveTicket(effect.ticket, effect.expected))
      if (!saved.ok) return { ok: false, failure: saved.failure }
      if (!saved.value.ok) return { ok: false, failure: saved.value.error }
      return { ok: true, value: encodeVersionValue(saved.value.value) }
    }
    case 'storage.appendAudit': {
      const appended = await attempt(() => store.appendAudit(effect.entry, effect.role))
      if (!appended.ok) return { ok: false, failure: appended.failure }
      if (!appended.value.ok) return { ok: false, failure: appended.value.error }
      return { ok: true, value: encodeEmptyValue() }
    }
    case 'clock.now':
      try {
        return { ok: true, value: encodeClockValue(concepts.clock.now()) }
      } catch (error) {
        return { ok: false, failure: { kind: 'unavailable', message: errorMessage(error) } }
      }
  }
}

class WasmCommandBridge implements CommandBridge {
  readonly boundaryVersion: number
  private readonly exports: CommandWasmExports
  private readonly concepts: CommandConcepts
  private requestSequence = 0

  constructor(
    exports: CommandWasmExports,
    concepts: CommandConcepts,
    boundaryVersion: number,
  ) {
    this.exports = exports
    this.concepts = concepts
    this.boundaryVersion = boundaryVersion
  }

  async execute(
    actor: CoreCommandActor,
    draft: CoreCommandDraft,
  ): Promise<Result<CoreCommandOutcome, CoreCommandError>> {
    this.requestSequence += 1
    const requestId = `command-${this.requestSequence}`
    let frame = this.invoke(
      this.exports.aleph_command_start,
      encodeCommandRequest(actor, requestId, draft),
    )
    if (!frame.ok) return frame
    while (frame.value.kind === 'effect') {
      const effect = decodeCommandEffect(frame.value.effect, frame.value.payload)
      if (!effect.ok) return effect
      const result = await performEffect(this.concepts, effect.value)
      const resume: CommandEffectResult = {
        effect: effect.value.name,
        sequence: frame.value.sequence,
        result,
      }
      const resumed = this.invoke(
        this.exports.aleph_command_resume,
        encodeCommandResume(resume),
      )
      if (!resumed.ok) return resumed
      frame = resumed
    }
    return { ok: true, value: frame.value.outcome }
  }

  private invoke(
    call: (pointer: number, length: number) => number,
    request: Uint8Array,
  ): Result<CommandFrame, CoreCommandError> {
    const requestPointer = this.exports.aleph_alloc(request.length)
    if (requestPointer === 0) return { ok: false, error: transport('the core could not allocate a request buffer') }
    new Uint8Array(this.exports.memory.buffer, requestPointer, request.length).set(request)
    const accepted = call(requestPointer, request.length)
    this.exports.aleph_free(requestPointer, request.length)
    if (accepted === 0) return { ok: false, error: transport('the core refused the request buffer') }
    const length = this.exports.aleph_response_len()
    if (length === 0) return { ok: false, error: transport('the core produced an empty response') }
    const responsePointer = this.exports.aleph_alloc(length)
    if (responsePointer === 0) {
      return { ok: false, error: transport('the core could not allocate a response buffer') }
    }
    const written = this.exports.aleph_response_write(responsePointer, length)
    const response = new Uint8Array(
      this.exports.memory.buffer,
      responsePointer,
      written,
    ).slice()
    this.exports.aleph_free(responsePointer, length)
    if (written !== length) {
      return { ok: false, error: transport('the core produced an incomplete response') }
    }
    return decodeCommandFrame(response)
  }
}

export interface LoadCommandBridgeInput {
  readonly concepts: CommandConcepts
  readonly runtime?: CommandWasmRuntime
  readonly source?: Uint8Array
}

export async function loadCommandBridge(
  input: LoadCommandBridgeInput,
): Promise<Result<CommandBridge, CommandLoadError>> {
  let instance: CommandWasmInstance
  try {
    const module = input.source ?? decodeBase64(WASM_CORE_BASE64)
    instance = await (input.runtime ?? DEFAULT_RUNTIME).instantiate(module)
  } catch (error) {
    return { ok: false, error: { kind: 'instantiate', message: errorMessage(error) } }
  }
  const missing = missingExport(instance.exports)
  if (missing !== undefined) {
    return { ok: false, error: { kind: 'missing-export', name: missing } }
  }
  const actual = instance.exports.aleph_bridge_version()
  if (actual !== COMMAND_BOUNDARY_VERSION) {
    return {
      ok: false,
      error: {
        kind: 'boundary-version',
        expected: COMMAND_BOUNDARY_VERSION,
        actual,
      },
    }
  }
  return {
    ok: true,
    value: new WasmCommandBridge(instance.exports, input.concepts, actual),
  }
}

export async function loadBundledCommandBridge(
  concepts: CommandConcepts,
): Promise<Result<CommandBridge, CommandLoadError>> {
  return loadCommandBridge({ concepts })
}
