import type { Ok } from '../src/types/errors.js'
import type {
  CIRunId,
  CommitSha,
  DurationMs,
  ExperimentId,
  ImplementerSessionId,
  IsoTimestamp,
  IssueId,
  MetricName,
  NonEmptyString,
  ProgramId,
  ResearcherSessionId,
  TicketId,
} from '../src/types/ids.js'
import type { ArtifactStore } from '../src/types/artifacts.js'
import type { CIRunner, SessionPool } from '../src/types/services.js'
import type { TriggerPort } from '../src/types/triggers.js'
import type { Plugin } from '../src/adapter/plugin.js'
import type {
  Handler,
  RouteRegistrar,
  SettingRegistrar,
  SurfaceHandlers,
  SurfacePorts,
  ToolRegistrar,
  PresetRegistrar,
} from '../src/adapter/surface.js'
import type { TicketPort } from '../src/adapter/runtime.js'
import { PRESETS, ROUTES, SETTINGS, SURFACE, TOOLS } from '../src/adapter/surface.js'
import { createInMemoryStore } from '../src/runtime/storage.js'
import {
  ciRunId as parseCIRunId,
  commitSha as parseCommitSha,
  durationMs as parseDurationMs,
  experimentId as parseExperimentId,
  implementerSessionId as parseImplementerSessionId,
  isoTimestamp as parseIsoTimestamp,
  issueId as parseIssueId,
  metricName as parseMetricName,
  nonEmptyString as parseNonEmptyString,
  programId as parseProgramId,
  researcherSessionId as parseResearcherSessionId,
  ticketId as parseTicketId,
} from '../src/parsers.js'

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value }
}

export function message(value: string): NonEmptyString {
  const parsed = parseNonEmptyString(value)
  if (!parsed.ok) throw new Error('the fixture built an empty message')
  return parsed.value
}

export function programId(value: string): ProgramId {
  const parsed = parseProgramId(value)
  if (!parsed.ok) throw new Error(`the fixture built an invalid program id: ${value}`)
  return parsed.value
}

export function issueId(value: string): IssueId {
  const parsed = parseIssueId(value)
  if (!parsed.ok) throw new Error(`the fixture built an invalid issue id: ${value}`)
  return parsed.value
}

export function experimentId(value: string): ExperimentId {
  const parsed = parseExperimentId(value)
  if (!parsed.ok) throw new Error(`the fixture built an invalid experiment id: ${value}`)
  return parsed.value
}

export function ciRunId(value: string): CIRunId {
  const parsed = parseCIRunId(value)
  if (!parsed.ok) throw new Error(`the fixture built an invalid benchmark run id: ${value}`)
  return parsed.value
}

export function ticketId(value: string): TicketId {
  const parsed = parseTicketId(value)
  if (!parsed.ok) throw new Error(`the fixture built an invalid ticket id: ${value}`)
  return parsed.value
}

export function implementerSessionId(value: string): ImplementerSessionId {
  const parsed = parseImplementerSessionId(value)
  if (!parsed.ok) throw new Error(`the fixture built an invalid implementer session id: ${value}`)
  return parsed.value
}

export function researcherSessionId(value: string): ResearcherSessionId {
  const parsed = parseResearcherSessionId(value)
  if (!parsed.ok) throw new Error(`the fixture built an invalid researcher session id: ${value}`)
  return parsed.value
}

export function commitSha(value: string): CommitSha {
  const parsed = parseCommitSha(value)
  if (!parsed.ok) throw new Error(`the fixture built an invalid commit: ${value}`)
  return parsed.value
}

export function at(value: string): IsoTimestamp {
  const parsed = parseIsoTimestamp(value)
  if (!parsed.ok) throw new Error(`the fixture built an invalid timestamp: ${value}`)
  return parsed.value
}

export function durationMs(value: number): DurationMs {
  const parsed = parseDurationMs(value)
  if (!parsed.ok) throw new Error('the fixture built an invalid duration')
  return parsed.value
}

export function metricName(value: string): MetricName {
  const parsed = parseMetricName(value)
  if (!parsed.ok) throw new Error(`the fixture built an invalid metric name: ${value}`)
  return parsed.value
}

export interface PluginFixture {
  readonly plugin: Plugin
  readonly calls: {
    readonly triggers: unknown[]
    readonly presets: unknown[]
    readonly tools: unknown[]
    readonly routes: unknown[]
  }
}

export function createPluginFixture(): PluginFixture {
  const store = createInMemoryStore()
  const triggers: unknown[] = []
  const presets: unknown[] = []
  const tools: unknown[] = []
  const routes: unknown[] = []
  const plugin: Plugin = {
    storage: {
      programs: store.programs,
      issues: store.issues,
      experiments: store.experiments,
      tickets: store.tickets,
      ciRecords: store.ciRecords,
      artifacts: store.artifacts,
      attention: store.attention,
      audit: store.audit,
    },
    trigger: {
      deliver: async (draft) => {
        triggers.push(draft)
        return ok(undefined)
      },
    },
    executor: {
      open: async () => ok(ticketId('ticket:1')),
      start: async () => ok(implementerSessionId('session:1')),
      submit: async () => ok(undefined),
    },
    sessions: {
      ensureResearcher: async () => ok(undefined),
      ensureImplementer: async () => ok(implementerSessionId('session:1')),
      wakeResearcher: async () => ok(undefined),
      registerPreset: async (preset) => {
        presets.push(preset)
        return ok(undefined)
      },
    },
    benchmark: {
      run: async () => ok({
        status: 'failed',
        reason: 'infrastructure',
        detail: 'the fixture performs no benchmark',
        durationMs: durationMs(1),
        logPath: '/tmp/benchmark.log',
      }),
    },
    artifacts: {
      put: async () => ({
        ok: false,
        error: { code: 'invalid-input', message: message('the fixture stores no artifacts') },
      }),
      get: async () => ok(undefined),
      listByExperiment: async () => ok([]),
      pruneTemporary: async () => ok(0),
    },
    clock: {
      now: () => at('2026-01-01T00:00:00.000Z'),
    },
    tools: {
      register: async (tool) => {
        tools.push(tool)
        return ok(undefined)
      },
    },
    http: {
      register: async (route) => {
        routes.push(route)
        return ok(undefined)
      },
    },
    surface: SURFACE,
  }
  return { plugin, calls: { triggers, presets, tools, routes } }
}

export function createCorrectHandlers(): SurfaceHandlers {
  const handlers: Partial<Record<string, Handler>> = {}
  for (const declaration of Object.values(ROUTES)) handlers[declaration.name] = handlerOf('route')
  for (const declaration of Object.values(TOOLS)) handlers[declaration.name] = handlerOf('tool')
  for (const declaration of Object.values(PRESETS)) handlers[declaration.name] = handlerOf('preset')
  for (const declaration of Object.values(SETTINGS)) handlers[declaration.name] = handlerOf('setting')
  return handlers as SurfaceHandlers
}

function handlerOf(kind: 'route' | 'tool' | 'preset' | 'setting'): Handler {
  if (kind === 'route') {
    return {
      kind: 'route',
      handle: async () => ({ status: 200, body: null }),
    }
  }
  if (kind === 'tool') {
    return {
      kind: 'tool',
      handle: async () => ok(null),
    }
  }
  if (kind === 'preset') {
    return {
      kind: 'preset',
      handle: async () => ok('session:1'),
    }
  }
  return {
    kind: 'setting',
    handle: async () => ok(undefined),
  }
}

export interface SurfaceCalls {
  readonly routes: unknown[]
  readonly tools: unknown[]
  readonly presets: unknown[]
  readonly settings: unknown[]
}

export interface SurfaceFixture {
  readonly routes: RouteRegistrar
  readonly tools: ToolRegistrar
  readonly sessions: PresetRegistrar
  readonly settings: SettingRegistrar
  readonly calls: SurfaceCalls
}

export function surfacePortsOf(fixture: SurfaceFixture): SurfacePorts {
  return {
    http: fixture.routes,
    tools: fixture.tools,
    sessions: fixture.sessions,
    settings: fixture.settings,
  }
}

export function createSurfaceFixture(): SurfaceFixture {
  const routes: unknown[] = []
  const tools: unknown[] = []
  const presets: unknown[] = []
  const settings: unknown[] = []
  return {
    routes: {
      register: async (route) => {
        routes.push(route)
        return ok(undefined)
      },
    },
    tools: {
      register: async (tool) => {
        tools.push(tool)
        return ok(undefined)
      },
    },
    sessions: {
      register: async (preset) => {
        presets.push(preset)
        return ok(undefined)
      },
    },
    settings: {
      register: async (setting) => {
        settings.push(setting)
        return ok(undefined)
      },
    },
    calls: { routes, tools, presets, settings },
  }
}

export interface RuntimeFixture {
  readonly ticket: TicketPort
  readonly triggers: TriggerPort
  readonly sessions: SessionPool
  readonly benchmark: CIRunner
  readonly artifacts: ArtifactStore
  readonly calls: {
    readonly ticketOpens: unknown[]
    readonly ticketStarts: unknown[]
    readonly ticketSubmits: unknown[]
    readonly triggers: unknown[]
    readonly researcherSessions: unknown[]
    readonly implementerSessions: unknown[]
    readonly wakes: unknown[]
    readonly benchmarkRuns: unknown[]
    readonly artifactPuts: unknown[]
  }
}

export function createRuntimeFixture(): RuntimeFixture {
  const ticketOpens: unknown[] = []
  const ticketStarts: unknown[] = []
  const ticketSubmits: unknown[] = []
  const triggers: unknown[] = []
  const researcherSessions: unknown[] = []
  const implementerSessions: unknown[] = []
  const wakes: unknown[] = []
  const benchmarkRuns: unknown[] = []
  const artifactPuts: unknown[] = []
  return {
    ticket: {
      open: async (input) => {
        ticketOpens.push(input)
        return ok(ticketId('ticket:1'))
      },
      start: async (id) => {
        ticketStarts.push(id)
        return ok(implementerSessionId('session:1'))
      },
      submit: async (id, commit) => {
        ticketSubmits.push([id, commit])
        return ok(undefined)
      },
    },
    triggers: {
      receive: async (draft) => {
        triggers.push(draft)
        return ok(undefined)
      },
    },
    sessions: {
      ensureResearcher: async (id) => {
        researcherSessions.push(id)
      },
      ensureImplementer: async (id) => {
        implementerSessions.push(id)
        return implementerSessionId('session:1')
      },
      wakeResearcher: async (id, text) => {
        wakes.push([id, text])
      },
    },
    benchmark: {
      run: async (input) => {
        benchmarkRuns.push(input)
        return ok({
          status: 'failed',
          reason: 'infrastructure',
          detail: 'the fixture performs no benchmark',
          durationMs: durationMs(1),
          logPath: '/tmp/benchmark.log',
        })
      },
    },
    artifacts: {
      put: async (input) => {
        artifactPuts.push(input)
        throw new Error('the fixture stores no artifacts')
      },
      get: async () => undefined,
      listByExperiment: async () => [],
      pruneTemporary: async () => 0,
    },
    calls: {
      ticketOpens,
      ticketStarts,
      ticketSubmits,
      triggers,
      researcherSessions,
      implementerSessions,
      wakes,
      benchmarkRuns,
      artifactPuts,
    },
  }
}
