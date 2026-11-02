import type { ArtifactStore } from '../types/artifacts.js'
import type { DomainError, Result } from '../types/errors.js'
import type {
  CommitSha,
  ImplementerSessionId,
  NonEmptyString,
  TicketId,
} from '../types/ids.js'
import type { CIRunner, SessionPool } from '../types/services.js'
import type { UnitOfWork } from '../types/storage.js'
import type { TriggerPort } from '../types/triggers.js'
import { nonEmptyString as parseNonEmptyString } from '../parsers.js'
import type {
  Artifacts,
  BenchmarkRunner,
  Clock,
  Http,
  Plugin,
  Sessions,
  Storage,
  TicketExecutor,
  TicketOpen,
  Tools,
  TriggerSource,
} from './plugin.js'
import type {
  PresetRegistrar,
  RouteRegistrar,
  SettingRegistrar,
  Surface,
  SurfacePorts,
  ToolRegistrar,
} from './surface.js'
import { SURFACE } from './surface.js'

export interface TicketPort {
  open(input: TicketOpen): Promise<Result<TicketId, DomainError>>
  start(ticketId: TicketId): Promise<Result<ImplementerSessionId, DomainError>>
  submit(ticketId: TicketId, commit: CommitSha): Promise<Result<void, DomainError>>
}

export interface PluginParts {
  readonly store: UnitOfWork
  readonly clock: Clock
  readonly trigger: TriggerPort
  readonly tickets: TicketPort
  readonly sessions: SessionPool
  readonly presets: PresetRegistrar
  readonly benchmark: CIRunner
  readonly artifacts: ArtifactStore
  readonly tools: ToolRegistrar
  readonly http: RouteRegistrar
  readonly settings: SettingRegistrar
  readonly surface?: Surface
}

export interface PluginAssembly {
  readonly plugin: Plugin
  readonly surfacePorts: SurfacePorts
}

const HOST_FAILURE_MESSAGE = requiredMessage('the host operation failed')

function requiredMessage(value: string): NonEmptyString {
  const parsed = parseNonEmptyString(value)
  if (!parsed.ok) throw new Error('the adapter generated an empty host message')
  return parsed.value
}

function hostFailure(cause: unknown): DomainError {
  const candidate = cause instanceof Error && cause.message.length > 0
    ? cause.message
    : 'the host operation failed'
  const parsed = parseNonEmptyString(candidate)
  return {
    code: 'invalid-state',
    message: parsed.ok ? parsed.value : HOST_FAILURE_MESSAGE,
  }
}

async function attempt<T>(work: () => Promise<T>): Promise<Result<T, DomainError>> {
  try {
    return { ok: true, value: await work() }
  } catch (cause) {
    return { ok: false, error: hostFailure(cause) }
  }
}

export function createPlugin(parts: PluginParts): PluginAssembly {
  const storage: Storage = {
    programs: parts.store.programs,
    issues: parts.store.issues,
    experiments: parts.store.experiments,
    tickets: parts.store.tickets,
    ciRecords: parts.store.ciRecords,
    artifacts: parts.store.artifacts,
    attention: parts.store.attention,
    audit: parts.store.audit,
  }

  const trigger: TriggerSource = {
    deliver: (draft) => parts.trigger.receive(draft),
  }

  const executor: TicketExecutor = {
    open: (input) => parts.tickets.open(input),
    start: (ticketId) => parts.tickets.start(ticketId),
    submit: (ticketId, commit) => parts.tickets.submit(ticketId, commit),
  }

  const sessions: Sessions = {
    ensureResearcher: (sessionId) =>
      attempt(async () => {
        await parts.sessions.ensureResearcher(sessionId)
      }),
    ensureImplementer: (ticketId) => attempt(() => parts.sessions.ensureImplementer(ticketId)),
    wakeResearcher: (sessionId, message) =>
      attempt(async () => {
        await parts.sessions.wakeResearcher(sessionId, message)
      }),
    registerPreset: (preset) => parts.presets.register(preset),
  }

  const benchmark: BenchmarkRunner = {
    run: (input) => parts.benchmark.run(input),
  }

  const artifacts: Artifacts = {
    put: (input) => attempt(() => parts.artifacts.put(input)),
    get: (id) => attempt(() => parts.artifacts.get(id)),
    listByExperiment: (experimentId) => attempt(() => parts.artifacts.listByExperiment(experimentId)),
    pruneTemporary: (now) => attempt(() => parts.artifacts.pruneTemporary(now)),
  }

  const clock: Clock = {
    now: () => parts.clock.now(),
  }

  const tools: Tools = {
    register: (tool) => parts.tools.register(tool),
  }

  const http: Http = {
    register: (route) => parts.http.register(route),
  }

  const plugin: Plugin = {
    storage,
    trigger,
    executor,
    sessions,
    benchmark,
    artifacts,
    clock,
    tools,
    http,
    surface: parts.surface ?? SURFACE,
  }

  return {
    plugin,
    surfacePorts: {
      http: parts.http,
      tools: parts.tools,
      sessions: parts.presets,
      settings: parts.settings,
    },
  }
}
