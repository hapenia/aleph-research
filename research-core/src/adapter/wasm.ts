import { unimplemented } from '../completion.js'
import type { DomainError, Result } from '../types/errors.js'
import type { Plugin } from './plugin.js'
import type {
  CoreCommandInput,
  CoreCommandOutput,
  CoreImports,
  CoreLoadError,
  CoreSource,
  CoreStartInput,
  CoreStartOutput,
  WasmRuntime,
} from './boundary.js'
import { CORE_BOUNDARY_VERSION } from './boundary.js'

export * from './boundary.js'

export interface LoadResearchCoreInput {
  readonly source: CoreSource
  readonly plugin: Plugin
  readonly runtime: WasmRuntime
}

export interface ResearchCore {
  readonly boundaryVersion: number
  start(input: CoreStartInput): Promise<Result<CoreStartOutput, DomainError>>
  execute(input: CoreCommandInput): Promise<Result<CoreCommandOutput, DomainError>>
}

function importsOf(plugin: Plugin): CoreImports {
  return {
    storage: plugin.storage,
    trigger: plugin.trigger,
    executor: plugin.executor,
    sessions: plugin.sessions,
    benchmark: plugin.benchmark,
    artifacts: plugin.artifacts,
    clock: plugin.clock,
    tools: plugin.tools,
    http: plugin.http,
    surface: plugin.surface,
  }
}

export async function loadResearchCore(
  input: LoadResearchCoreInput,
): Promise<Result<ResearchCore, CoreLoadError>> {
  const instance = await input.runtime.instantiate(input.source.module, importsOf(input.plugin))
  const exports = instance.exports
  if (exports.boundaryVersion !== CORE_BOUNDARY_VERSION) {
    return {
      ok: false,
      error: {
        kind: 'boundary-version',
        expected: CORE_BOUNDARY_VERSION,
        actual: exports.boundaryVersion,
      },
    }
  }
  return {
    ok: true,
    value: {
      boundaryVersion: exports.boundaryVersion,
      start: (command) => exports.start(command),
      execute: (command) => exports.execute(command),
    },
  }
}

export function loadBundledResearchCore(): never {
  return unimplemented('wasm-core-loading', 'the Rust core wasm asset is not built')
}
