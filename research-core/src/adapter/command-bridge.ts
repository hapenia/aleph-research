import type { Result } from '../types/errors.js'
import type {
  CommandBridge,
  CommandConcepts,
  CommandEffect,
  CommandFactory,
  CoreCommandEffectFrame,
  CommandHandle,
  CommandLoadError,
  CoreCommandActor,
  CoreCommandDraft,
  CoreCommandEffectFailure,
  CoreCommandEffectResume,
  CoreCommandError,
  CoreCommandOutcome,
} from './command-boundary.js'
import { COMMAND_BOUNDARY_VERSION } from './command-boundary.js'
import { Core } from './wasm-bindgen/core.js'
import { initCore } from './wasm-core.js'

const DEFAULT_FACTORY: CommandFactory = {
  create: () => {
    initCore()
    return new Core()
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

function failure(message: string): CoreCommandEffectFailure {
  return { kind: 'unavailable', message }
}

function notFound(message: string): CoreCommandEffectFailure {
  return { kind: 'not-found', message }
}

type EffectOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: CoreCommandEffectFailure }

async function attempt<T>(work: () => Promise<T>): Promise<EffectOutcome<T>> {
  try {
    return { ok: true, value: await work() }
  } catch (error) {
    return { ok: false, failure: failure(errorMessage(error)) }
  }
}

function effectOf(frame: CoreCommandEffectFrame): CommandEffect {
  switch (frame.effect) {
    case 'storage.loadProgram':
      return { name: frame.effect, programId: frame.payload.programId }
    case 'storage.saveProgram':
      return {
        name: frame.effect,
        expected: frame.payload.expected,
        program: frame.payload.program,
      }
    case 'storage.loadIssue':
      return { name: frame.effect, issueId: frame.payload.issueId }
    case 'storage.saveIssue':
      return {
        name: frame.effect,
        expected: frame.payload.expected,
        issue: frame.payload.issue,
      }
    case 'storage.loadExperiment':
      return { name: frame.effect, experimentId: frame.payload.experimentId }
    case 'storage.saveExperiment':
      return {
        name: frame.effect,
        expected: frame.payload.expected,
        experiment: frame.payload.experiment,
      }
    case 'storage.loadTicket':
      return { name: frame.effect, ticketId: frame.payload.ticketId }
    case 'storage.saveTicket':
      return {
        name: frame.effect,
        expected: frame.payload.expected,
        ticket: frame.payload.ticket,
      }
    case 'storage.appendAudit':
      return {
        name: frame.effect,
        role: frame.payload.role,
        entry: frame.payload.entry,
      }
    case 'clock.now':
      return { name: frame.effect }
  }
}

async function performEffect(
  concepts: CommandConcepts,
  effect: CommandEffect,
  sequence: string,
): Promise<CoreCommandEffectResume> {
  const store = concepts.store
  switch (effect.name) {
    case 'storage.loadProgram': {
      const loaded = await attempt(() => store.loadProgram(effect.programId))
      if (!loaded.ok) {
        return { effect: effect.name, sequence, result: { ok: false, failure: loaded.failure } }
      }
      if (loaded.value === undefined) {
        return {
          effect: effect.name,
          sequence,
          result: {
            ok: false,
            failure: notFound(`program ${effect.programId} does not exist`),
          },
        }
      }
      return {
        effect: effect.name,
        sequence,
        result: { ok: true, value: loaded.value },
      }
    }
    case 'storage.saveProgram': {
      const saved = await attempt(() => store.saveProgram(effect.program, effect.expected))
      if (!saved.ok) {
        return { effect: effect.name, sequence, result: { ok: false, failure: saved.failure } }
      }
      return saved.value.ok
        ? { effect: effect.name, sequence, result: { ok: true, value: saved.value.value } }
        : { effect: effect.name, sequence, result: { ok: false, failure: saved.value.error } }
    }
    case 'storage.loadIssue': {
      const loaded = await attempt(() => store.loadIssue(effect.issueId))
      if (!loaded.ok) {
        return { effect: effect.name, sequence, result: { ok: false, failure: loaded.failure } }
      }
      if (loaded.value === undefined) {
        return {
          effect: effect.name,
          sequence,
          result: {
            ok: false,
            failure: notFound(`issue ${effect.issueId} does not exist`),
          },
        }
      }
      return { effect: effect.name, sequence, result: { ok: true, value: loaded.value } }
    }
    case 'storage.saveIssue': {
      const saved = await attempt(() => store.saveIssue(effect.issue, effect.expected))
      if (!saved.ok) {
        return { effect: effect.name, sequence, result: { ok: false, failure: saved.failure } }
      }
      return saved.value.ok
        ? { effect: effect.name, sequence, result: { ok: true, value: saved.value.value } }
        : { effect: effect.name, sequence, result: { ok: false, failure: saved.value.error } }
    }
    case 'storage.loadExperiment': {
      const loaded = await attempt(() => store.loadExperiment(effect.experimentId))
      if (!loaded.ok) {
        return { effect: effect.name, sequence, result: { ok: false, failure: loaded.failure } }
      }
      if (loaded.value === undefined) {
        return {
          effect: effect.name,
          sequence,
          result: {
            ok: false,
            failure: notFound(`experiment ${effect.experimentId} does not exist`),
          },
        }
      }
      return { effect: effect.name, sequence, result: { ok: true, value: loaded.value } }
    }
    case 'storage.saveExperiment': {
      const saved = await attempt(() =>
        store.saveExperiment(effect.experiment, effect.expected),
      )
      if (!saved.ok) {
        return { effect: effect.name, sequence, result: { ok: false, failure: saved.failure } }
      }
      return saved.value.ok
        ? { effect: effect.name, sequence, result: { ok: true, value: saved.value.value } }
        : { effect: effect.name, sequence, result: { ok: false, failure: saved.value.error } }
    }
    case 'storage.loadTicket': {
      const loaded = await attempt(() => store.loadTicket(effect.ticketId))
      if (!loaded.ok) {
        return { effect: effect.name, sequence, result: { ok: false, failure: loaded.failure } }
      }
      if (loaded.value === undefined) {
        return {
          effect: effect.name,
          sequence,
          result: {
            ok: false,
            failure: notFound(`ticket ${effect.ticketId} does not exist`),
          },
        }
      }
      return { effect: effect.name, sequence, result: { ok: true, value: loaded.value } }
    }
    case 'storage.saveTicket': {
      const saved = await attempt(() => store.saveTicket(effect.ticket, effect.expected))
      if (!saved.ok) {
        return { effect: effect.name, sequence, result: { ok: false, failure: saved.failure } }
      }
      return saved.value.ok
        ? { effect: effect.name, sequence, result: { ok: true, value: saved.value.value } }
        : { effect: effect.name, sequence, result: { ok: false, failure: saved.value.error } }
    }
    case 'storage.appendAudit': {
      const appended = await attempt(() => store.appendAudit(effect.entry, effect.role))
      if (!appended.ok) {
        return {
          effect: effect.name,
          sequence,
          result: { ok: false, failure: appended.failure },
        }
      }
      return appended.value.ok
        ? { effect: effect.name, sequence, result: { ok: true, value: { acknowledged: true } } }
        : { effect: effect.name, sequence, result: { ok: false, failure: appended.value.error } }
    }
    case 'clock.now':
      return {
        effect: effect.name,
        sequence,
        result: { ok: true, value: concepts.clock.now() },
      }
  }
}

class WasmCommandBridge implements CommandBridge {
  readonly boundaryVersion: number
  private readonly core: CommandHandle
  private readonly concepts: CommandConcepts
  private requestSequence = 0

  constructor(core: CommandHandle, concepts: CommandConcepts, boundaryVersion: number) {
    this.core = core
    this.concepts = concepts
    this.boundaryVersion = boundaryVersion
  }

  async execute(
    actor: CoreCommandActor,
    draft: CoreCommandDraft,
  ): Promise<Result<CoreCommandOutcome, CoreCommandError>> {
    this.requestSequence += 1
    const requestId = `command-${this.requestSequence}`
    let frame
    try {
      frame = this.core.command_start({ actor, requestId, draft })
    } catch (error) {
      return { ok: false, error: transport(errorMessage(error)) }
    }
    while (frame.kind === 'effect') {
      const effect = effectOf(frame)
      const resume = await performEffect(this.concepts, effect, frame.sequence)
      let resumed
      try {
        resumed = this.core.command_resume(resume)
      } catch (error) {
        return { ok: false, error: transport(errorMessage(error)) }
      }
      frame = resumed
    }
    if (frame.kind === 'protocol') {
      return { ok: false, error: { kind: 'protocol', message: frame.message } }
    }
    if (frame.kind === 'command-error') {
      return {
        ok: false,
        error: {
          kind: frame.errorKind,
          command: frame.command,
          message: frame.message,
        },
      }
    }
    return { ok: true, value: frame.outcome }
  }
}

export interface LoadCommandBridgeInput {
  readonly concepts: CommandConcepts
  readonly factory?: CommandFactory
}

export function loadCommandBridge(
  input: LoadCommandBridgeInput,
): Promise<Result<CommandBridge, CommandLoadError>> {
  let core: CommandHandle
  try {
    core = (input.factory ?? DEFAULT_FACTORY).create()
  } catch (error) {
    return Promise.resolve({
      ok: false,
      error: { kind: 'instantiate', message: errorMessage(error) },
    })
  }
  const actual = core.boundary_version()
  if (actual !== COMMAND_BOUNDARY_VERSION) {
    return Promise.resolve({
      ok: false,
      error: {
        kind: 'boundary-version',
        expected: COMMAND_BOUNDARY_VERSION,
        actual,
      },
    })
  }
  return Promise.resolve({
    ok: true,
    value: new WasmCommandBridge(core, input.concepts, actual),
  })
}

export function loadBundledCommandBridge(
  concepts: CommandConcepts,
): Promise<Result<CommandBridge, CommandLoadError>> {
  return loadCommandBridge({ concepts })
}
