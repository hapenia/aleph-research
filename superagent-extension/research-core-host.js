import { createHash } from 'node:crypto'

import { loadBundledCommandBridge } from '../research-core/dist/adapter/command-bridge.js'
import { createCommandSurface } from '../research-core/dist/adapter/command-surface.js'
import { createDshCommandStore } from '../research-core/dist/adapter/command-store.js'
import { evaluateSubmission } from './evaluation.js'
import { createDshCoreRuntime } from './research-core-runtime.js'
import { bindCoreSurface, createSurfaceHandlers } from './research-core-surface.js'

export const name = 'aleph-research-core-host'
export const inject = ['webServer', 'tools']

const SERVICE_NAME = 'alephResearchCore'
const HOST_SERVICE_NAME = 'alephResearchHost'
const SESSIONS_SERVICE_NAME = 'alephResearchSessions'
const API_PREFIX = '/aleph/api/research'
const DEFAULT_BODY_LIMIT_BYTES = 256 * 1024
const DEFAULT_ACTOR_SESSION = 'aleph-operator-1'
const PRESET_ROLE = Object.freeze({
  'aleph-operator': 'operator',
  'aleph-researcher': 'researcher',
  'aleph-implementer': 'implementer',
  'aleph-watchdog': 'watchdog',
})

const ok = (value) => ({ ok: true, value })
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

const sendJson = (res, status, value) => {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

const readJsonBody = async (req, limit) => {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new Error(`the request body exceeds ${limit} bytes`)
    chunks.push(buffer)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  return await new Response(text, { headers: { 'content-type': 'application/json' } }).json()
}

const matchPath = (pattern, path) => {
  const expected = pattern.split('/')
  const actual = path.split('/')
  if (expected.length !== actual.length) return undefined
  const params = {}
  for (let index = 0; index < expected.length; index += 1) {
    const segment = expected[index]
    const value = actual[index]
    if (segment.startsWith(':')) {
      if (value === undefined || value.length === 0) return undefined
      params[segment.slice(1)] = decodeURIComponent(value)
    } else if (segment !== value) {
      return undefined
    }
  }
  return params
}

const digest = (parts) => createHash('sha256')
  .update(parts.filter((part) => typeof part === 'string').join('\u0000'))
  .digest('hex')

const benchmarkRecordOf = (request, outcome, specHash, environmentDigest, at) => {
  const metrics = Number.isFinite(outcome.score) ? [{ name: 'score', value: outcome.score }] : []
  return {
    id: `benchmark:${request.experimentId}:${request.attempt}`,
    experimentId: request.experimentId,
    ticketId: request.ticketId,
    commit: request.commit,
    specHash,
    environmentDigest,
    metrics,
    status: Number.isFinite(outcome.score) ? 'passed' : 'failed',
    attempt: request.attempt,
    maxAttempts: request.maxAttempts,
    stdout: outcome.stdout ?? '',
    stderr: outcome.stderr ?? '',
    artifacts: [],
    createdAt: at,
  }
}

const benchmarkOf = (config, clock, fallbackSpecHash) => {
  const settings = isRecord(config.benchmark) ? config.benchmark : {}
  const command = typeof config.evalCommand === 'string' ? config.evalCommand : ''
  return {
    async specHash(spec) {
      if (typeof settings.specHash === 'function') return settings.specHash(spec)
      return ok(fallbackSpecHash(spec))
    },
    async buildEnvironment(request) {
      if (typeof settings.buildEnvironment === 'function') {
        return settings.buildEnvironment(request)
      }
      return ok(digest([request.commit, request.environment.kind, request.environment.file]))
    },
    async run(request) {
      if (typeof settings.run === 'function') return settings.run(request)
      if (command.length === 0) {
        return { ok: false, error: { kind: 'unavailable', message: 'no benchmark command is configured' } }
      }
      const outcome = await evaluateSubmission({
        command,
        cwd: typeof config.cwd === 'string' ? config.cwd : process.cwd(),
        timeoutMs: Number(request.spec.timeoutMs),
        python: typeof config.python === 'string' ? config.python : '',
      })
      const specHash = fallbackSpecHash(request.spec)
      return ok(benchmarkRecordOf(request, outcome, specHash, request.environmentDigest, clock.now()))
    },
  }
}

const fallbackSessions = () => ({
  async ensureImplementer(ticketId) {
    return `aleph-implementer-${String(ticketId).replace(/[^A-Za-z0-9._:-]/gu, '-').slice(-80)}`
  },
})

export async function apply(ctx, config) {
  const settings = isRecord(config) ? config : {}
  const hostService = typeof ctx.get === 'function' ? ctx.get(HOST_SERVICE_NAME) : undefined
  if (!isRecord(hostService) || !isRecord(hostService.host)) {
    ctx.logger?.warn?.('aleph-research-core: the %s service is absent; the core host stays inert', HOST_SERVICE_NAME)
    return
  }
  const host = hostService.host
  const store = hostService.store ?? host.store
  const sessionsService = typeof ctx.get === 'function' ? ctx.get(SESSIONS_SERVICE_NAME) : undefined
  const sessions = isRecord(sessionsService) && typeof sessionsService.ensureImplementer === 'function'
    ? sessionsService
    : fallbackSessions()
  const clock = host.clock ?? { now: () => new Date().toISOString() }
  const fallbackSpecHash = (spec) => digest([spec.id, spec.entry, String(spec.timeoutMs), JSON.stringify(spec.metrics)])
  const benchmark = benchmarkOf(settings, clock, fallbackSpecHash)

  const created = await createDshCoreRuntime({
    store,
    sessions,
    trigger: { deliver: (draft) => hostService.deliverDraft(draft) },
    benchmark,
    clock,
    logger: ctx.logger,
  })
  if (!created.ok) {
    ctx.logger?.error?.('aleph-research-core: the embedded core did not load: %s', created.error?.kind)
    return
  }
  const runtime = created.value.runtime
  const loadedCommandBridge = await loadBundledCommandBridge({
    store: createDshCommandStore({ store, clock }),
    clock: { now: () => clock.now() },
  })
  let commandSequence = 0
  const commandId = (prefix) => {
    commandSequence += 1
    const stamp = String(clock.now()).replace(/[^A-Za-z0-9._-]/gu, '-')
    return `${prefix}-${stamp}-${commandSequence}`
  }
  const commandSurface = loadedCommandBridge.ok
    ? createCommandSurface({ bridge: loadedCommandBridge.value, newId: commandId })
    : undefined
  if (!loadedCommandBridge.ok) {
    ctx.logger?.warn?.('aleph-research-core: the command bridge did not load: %s', loadedCommandBridge.error?.kind)
  }

  const routes = new Map()
  const tools = []
  const presets = []
  const registeredSettings = new Map()
  const disposers = []

  const actorOf = () => ({ kind: 'operator', sessionId: settings.operatorSession ?? DEFAULT_ACTOR_SESSION })

  const handlers = createSurfaceHandlers({
    executeTool: (tool, input, context) => hostService.executeTool(tool, input, context),
    executeCommand: commandSurface === undefined
      ? undefined
      : (name, input, actor) => (commandSurface.handles(name)
        ? commandSurface.execute(name, input, actor)
        : undefined),
    runtime,
    store,
    logger: ctx.logger,
    actorSession: settings.researcherSession ?? 'aleph-researcher-1',
    ticketOfSession: (sessionId) => created.value.ticketsBySession.get(sessionId),
  })

  const registerRoute = async (registration) => {
    routes.set(registration.path, registration)
    return ok(undefined)
  }

  const registerTool = async (registration) => {
    if (typeof ctx.tools?.register !== 'function') return ok(undefined)
    const when = (context) => PRESET_ROLE[context?.agent?.session?.header?.agentPreset] === registration.role
    const dispose = ctx.tools.register({
      name: registration.name,
      description: registration.description,
      parameters: { type: 'object', additionalProperties: true },
      output: {
        schema: {},
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? null) }],
      },
      async execute(input, exec) {
        const sessionId = exec?.agent?.id ?? exec?.agent?.session?.header?.sessionId ?? actorOf().sessionId
        const actor = { kind: registration.role, sessionId }
        const result = await registration.handle({ name: registration.name, input, actor })
        if (result.ok) return result.value
        throw new Error(result.error.message)
      },
    }, { when })
    if (typeof dispose === 'function') disposers.push(dispose)
    tools.push(registration.name)
    return ok(undefined)
  }

  const registerPreset = async (registration) => {
    presets.push(registration.name)
    return ok(undefined)
  }

  const registerSetting = async (registration) => {
    registeredSettings.set(registration.name, registration)
    return ok(undefined)
  }

  const dispatch = async (req, res) => {
    try {
      const url = new URL(typeof req.url === 'string' ? req.url : '/', 'http://localhost')
      if (req.method === 'POST') {
        let matched
        for (const registration of routes.values()) {
          if (registration.method !== 'POST') continue
          const params = matchPath(registration.path, url.pathname)
          if (params === undefined) continue
          matched = { registration, params }
          break
        }
        if (matched === undefined) {
          sendJson(res, 404, { ok: false, error: { code: 'not-found', message: `no route for ${url.pathname}` } })
          return
        }
        const body = await readJsonBody(req, settings.maxBodyBytes ?? DEFAULT_BODY_LIMIT_BYTES)
        const response = await matched.registration.handle({
          name: matched.registration.name,
          method: 'POST',
          path: url.pathname,
          params: matched.params,
          body,
          actor: actorOf(),
        })
        sendJson(res, response.status, response.body)
        return
      }
      if (req.method === 'GET') {
        const programPath = `${API_PREFIX}/programs`
        if (url.pathname === programPath) {
          const programs = await listPrograms(host)
          sendJson(res, 200, { ok: true, count: programs.length, programs })
          return
        }
        if (url.pathname.startsWith(`${programPath}/`)) {
          const programId = decodeURIComponent(url.pathname.slice(programPath.length + 1))
          const snapshot = await host.snapshot(programId)
          const status = snapshot?.ok === true ? 200 : Number.isInteger(snapshot?.status) ? snapshot.status : 404
          sendJson(res, status, snapshot)
          return
        }
        const attentionPath = `${API_PREFIX}/attention/`
        if (url.pathname.startsWith(attentionPath)) {
          const programId = decodeURIComponent(url.pathname.slice(attentionPath.length))
          sendJson(res, 200, { ok: true, programId, attention: await host.attention(programId) })
          return
        }
      }
      sendJson(res, 404, { ok: false, error: { code: 'not-found', message: `no route for ${url.pathname}` } })
    } catch (error) {
      ctx.logger?.warn?.('aleph-research-core: %s failed: %s', String(req.url), String(error?.message ?? error))
      sendJson(res, 500, { ok: false, error: { code: 'internal', message: 'the core host failed' } })
    }
  }

  const disposeRoute = ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: dispatch })
  if (typeof disposeRoute === 'function') disposers.push(disposeRoute)

  const bound = await bindCoreSurface({
    handlers,
    registerRoute,
    registerTool,
    registerPreset,
    registerSetting,
  })
  if (bound.bound.ok !== true) {
    ctx.logger?.warn?.('aleph-research-core: some surface entries did not bind')
  }

  const service = {
    runtime,
    handlers,
    routes: [...routes.keys()],
    tools,
    presets,
    settings: [...registeredSettings.keys()],
    bound,
    artifacts: {
      get(id) {
        return store.artifacts?.get?.(id)
      },
      list(experimentId) {
        return store.artifacts?.listByExperiment?.(experimentId) ?? []
      },
    },
    async start(input) {
      return runtime.start(input)
    },
    pending() {
      return runtime.pending()
    },
    dispose() {
      while (disposers.length > 0) {
        const dispose = disposers.pop()
        try {
          dispose()
        } catch {
          continue
        }
      }
    },
  }

  ctx.effect(() => () => service.dispose())
  if (typeof ctx.provide === 'function') ctx.provide(SERVICE_NAME, service)
  ctx.logger?.info?.(
    'aleph-research-core ready: %d routes, %d tools, %d presets, %d settings',
    service.routes.length,
    service.tools.length,
    service.presets.length,
    service.settings.length,
  )
}

const listPrograms = async (host) => {
  const repository = host.store?.programs
  if (typeof repository?.list !== 'function') return []
  const entries = await repository.list()
  const programs = []
  for (const entry of entries) {
    const program = entry?.value
    if (program === undefined) continue
    programs.push({
      id: program.id,
      name: program.name,
      status: program.status,
      createdAt: program.createdAt,
      version: entry.version,
    })
  }
  return programs
}
