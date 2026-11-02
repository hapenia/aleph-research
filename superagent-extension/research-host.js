/**
 * AlephResearch Host plugin: the compiled research runtime behind the DSH web server.
 *
 * The runtime composition root in `research-core` owns the domain; this module is the
 * transport adapter. It composes one `ResearchHost` (an in-memory store unless config
 * injects a store, a persistent `DomainStore` exists, or a whole host is injected),
 * registers the browser-facing routes below, and disposes both the routes and the host
 * when the plugin fiber goes away.
 *
 * Routes (all JSON, all `cache-control: no-store`):
 *
 *   GET  /aleph/api/research/health              -> { ok, version, persistent }
 *   POST /aleph/api/research/requests            -> the runtime's HTTP response
 *   GET  /aleph/api/research/programs            -> { ok, count, programs }
 *   GET  /aleph/api/research/programs/:programId -> the runtime's ProgramSnapshot
 *   GET  /aleph/api/research/attention/:programId -> { ok, programId, attention }
 *
 * ## Persistence
 *
 * The plugin declares only `webServer` and reads the optional `alephResearchStore`
 * service with `ctx.get` at apply time. `research-storage` provides that service as a
 * `DomainStore` over the opened `aleph_research` DSH domain. When the service is present
 * (or `config.domainStore` names one), the plugin builds the compiled
 * `createStorageDomainUnitOfWork(domainStore, { transactionMode: 'snapshot' })` and passes
 * that persistent UnitOfWork to `createResearchHost`, so programs and their records
 * survive a host restart. An absent, throwing or malformed lookup never fails startup: it
 * falls back to the in-memory store with a warning, and the health route then reports
 * `persistent: false`. `config.host` bypasses composition entirely and reports
 * `persistent: false` too, because the transport did not build the store.
 *
 * `POST /requests` is the only write surface. Its body is
 * `{ path, body, actorKind? }`; the adapter turns it into the runtime's HttpRequest
 * (`{ method: 'POST', path, body, actor }`), so the compiled boundary still owns route
 * matching, actor admission, parsing and status mapping. `actorKind` defaults to the
 * first configured kind (operator by default) and must name a configured kind.
 *
 * Program listing has no runtime method: it reads `host.store.programs.list()` when the
 * composed host exposes that repository, and otherwise answers 404. A host injected as
 * `config.host` may therefore be read-only for the list route.
 *
 * ## The `alephResearchHost` service
 *
 * After the host exists the plugin provides the `alephResearchHost` service. That service
 * is the DSH-side execution seam: `research-tools` passes the service into a handler map
 * for every registered tool, and `research-trigger-bridge` registers a trigger sink on it.
 *
 * - `executeTool(toolName, input, context?)` resolves the runtime tool from the compiled
 *   `TOOL_REGISTRY`, parses the input through that tool's own `Schema`, mints the actor
 *   from the tool's role (`context.actorKind` may override it), and then:
 *   - for command tools, fills the compiled `ROUTE_TABLE` path with the parsed path
 *     parameters and calls `host.handleHttp`; the runtime still owns route admission,
 *     actor gates, ownership proofs, parsing and status mapping. A non-2xx response is
 *     returned as `{ ok: false, status, error }`; it is never thrown.
 *   - for the read tools (which have no HTTP route in the frozen command surface), it
 *     reads the corresponding host surface: `snapshot` for `readProgram`, the store's
 *     `ciRecords.query` for `readMetrics`, `experiments.get` for `readExperiment`,
 *     `issues.listByProgram` for `listStalled`, and the attention repository for
 *     `raiseAttention`. `listStalled` needs the Host context's `programId` because the
 *     tool carries no parameters.
 *   - `implementer_submit_implementation` carries no ticket binding by design. The
 *     transport only mints an implementer principal when trusted Host context supplies
 *     one (`context.actor`, or `context.ticketId` / `config.ticketBinding`); without a
 *     binding resolver the call is refused with a clear `forbidden` error.
 * - `triggerPort` is a runtime `TriggerPort`. It forwards a report's draft to the
 *   registered sink, or records the report when no sink is attached. The service also
 *   exports `onTrigger` / `setTriggerSink`; a sink failure is logged and never fails the
 *   tool call. After every command response (success or refusal) the audit entries in
 *   the response are mapped with `createTriggerFactory` and delivered to the same sink,
 *   so a DSH bridge sees the same trigger stream the runtime's `deliverTriggers` uses.
 * - `dispose()` clears the sink. It is called by the plugin fiber's effect.
 *
 * The service needs the compiled `runtime/tools.js`, `runtime/triggers.js` and
 * `runtime/api.js`. They are loaded with `composition.js`; when `config.host` is injected
 * but `dist/` is missing, the host still starts and only the service is omitted (a
 * warning is logged), preserving the injected-host escape hatch.
 *
 * Configuration (all optional):
 *
 * - `actorKinds` — kinds the request route may mint. Default `['operator']`. Supported:
 *   `operator`, `researcher`, `watchdog`, `host`. `implementer` is refused because its
 *   principal carries a Host-minted Ticket binding that an HTTP body must never supply.
 * - `maxBodyBytes` — request body limit for `/requests`. Default 256 KiB.
 * - `domainStore` — an explicit persistent `DomainStore` (the `research-core` adapter
 *   port: `list`, `get`, `put`, `delete`). It takes precedence over the
 *   `alephResearchStore` service and over `config.store`. A malformed value falls back
 *   to memory with a warning, like a malformed service.
 * - `host` — an already composed ResearchHost; it is used as-is and disposed on cleanup.
 *   A host bypasses composition, so neither `domainStore` nor the service is consulted.
 * - `store`, `clock`, `requestIds`, `hostContexts`, `sampler`, `triggerPort`, `random` —
 *   passed through to `createResearchHost`. An absent `store` gets the in-memory one,
 *   and a resolved `domainStore` replaces it with the persistent UnitOfWork. The service
 *   always installs its own trigger port so the bridge sees deliveries; a configured
 *   `triggerPort` remains the fallback receiver when no bridge sink is registered.
 * - `ticketBinding` — optional trusted resolver for `implementer_submit_implementation`:
 *   `(context) => ticketId | { ticketId, sessionId }`. Without it (and without a
 *   `context.ticketId` from the embedding Host) that tool is refused as forbidden,
 *   because the model must never supply the ticket binding.
 *
 * The dynamic import is the build boundary: `research-core` returns TypeScript, so this
 * adapter consumes `dist/`. A missing `dist/` does not fail the plugin: the fiber then
 * registers only `GET /aleph/api/research/health`, which answers 503
 * `{ ok: false, error: { code: 'research/build-missing' } }`, so the host process still
 * starts and the missing build is visible over HTTP. Every other import failure (a
 * broken or stale build) still fails startup with the build command to run, instead of
 * registering a half-working route table. Only `dist/adapter/composition.js` is loaded
 * when persistence is off; `dist/adapter/storage-domain.js` is loaded on demand when a
 * `DomainStore` is used.
 *
 * `JSON.parse` is deliberately absent: the adapter's ESLint boundary confines it to the
 * designated format-parser modules, so the request body goes through the platform
 * `Response.json()` reader, and `JSON.stringify` is used only to write responses.
 */

export const name = 'aleph-research-host'
export const inject = ['webServer']

/** Reported by GET /aleph/api/research/health. */
export const VERSION = 'research-host/1'

/** Health error code when `research-core` has not been built into `dist/`. */
export const BUILD_MISSING_CODE = 'research/build-missing'

/** The build command the 503 health body and the load error name. */
const BUILD_COMMAND = 'Run "npm run build" in research-core.'

const HEALTH_PATH = '/aleph/api/research/health'
const REQUESTS_PATH = '/aleph/api/research/requests'
const PROGRAMS_PATH = '/aleph/api/research/programs'
const ATTENTION_PATH = '/aleph/api/research/attention'

/** Prefix used to slice a programId out of the already-matched request path. */
const PROGRAMS_TAIL_PREFIX = `${PROGRAMS_PATH}/`
const ATTENTION_TAIL_PREFIX = `${ATTENTION_PATH}/`

const DEFAULT_BODY_LIMIT_BYTES = 256 * 1024
const DEFAULT_ACTOR_KINDS = ['operator']

/** Runtime options a config object may forward to `createResearchHost`. */
const HOST_OPTION_KEYS = ['store', 'clock', 'requestIds', 'hostContexts', 'sampler', 'triggerPort', 'random']

/** The actor kinds this transport can mint without accepting proof material from a body. */
const SUPPORTED_ACTOR_KINDS = ['operator', 'researcher', 'watchdog', 'host']

/** Prefix of the stable Sessions the adapter mints; valid entity ids (colons allowed). */
const SESSION_PREFIX = 'aleph-host'

/**
 * The optional service `research-storage` provides with the opened `DomainStore`.
 *
 * The literal matches `STORE_SERVICE_NAME` in `research-storage.js`; importing that module
 * would make the optional store (and its zod/DSH wiring) a hard dependency of this one.
 */
const STORE_SERVICE_NAME = 'alephResearchStore'

/** Methods a `DomainStore` must expose before the adapter treats a service as usable. */
const DOMAIN_STORE_METHODS = ['list', 'get', 'put', 'delete']

const COMPOSITION_URL = new URL('../research-core/dist/adapter/composition.js', import.meta.url)
const STORAGE_DOMAIN_URL = new URL('../research-core/dist/adapter/storage-domain.js', import.meta.url)
const TOOLS_URL = new URL('../research-core/dist/runtime/tools.js', import.meta.url)
const TRIGGERS_URL = new URL('../research-core/dist/runtime/triggers.js', import.meta.url)
const API_URL = new URL('../research-core/dist/runtime/api.js', import.meta.url)

/**
 * The service name `research-tools` and `research-trigger-bridge` resolve with `ctx.get`.
 *
 * The literal is repeated in those modules so they do not import this transport module
 * (and its web-server/compiled-runtime dependencies) just to learn one string.
 */
export const RESEARCH_HOST_SERVICE = 'alephResearchHost'

/** The runtime roles, in the tool registry's own order. */
const TOOL_ROLES = ['operator', 'researcher', 'implementer', 'watchdog']

/**
 * Actor kinds `executeTool` may mint from trusted Host context. `implementer` is here
 * only because the binding resolver below mints it from a Host-supplied ticket; the HTTP
 * body route still refuses it (see `SUPPORTED_ACTOR_KINDS`).
 */
const TOOL_ACTOR_KINDS = ['operator', 'researcher', 'implementer', 'watchdog', 'host']

/** Runtime command tools whose role is not their actor kind (the Implementer family). */
const IMPLEMENTER_ROLE = 'implementer'

/** The default read handlers, keyed by the registry's stable `<role>.<key>` id. */
const READ_TOOL_IDS = new Set([
  'researcher.readProgram',
  'researcher.readMetrics',
  'implementer.readExperiment',
  'watchdog.listStalled',
  'watchdog.raiseAttention',
  'watchdog.readMetrics',
])

/** A refusal this transport understands; anything else becomes a generic 500. */
class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

/** Read one own data property without invoking an untrusted accessor. */
const ownValue = (source, key) => Object.getOwnPropertyDescriptor(source, key)?.value

const hasOwn = (source, key) => Object.getOwnPropertyDescriptor(source, key) !== undefined

const sendJson = (res, status, value) => {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

const methodNotAllowed = (res, allowed) => {
  res.setHeader('allow', allowed)
  sendJson(res, 405, {
    ok: false,
    error: { code: 'method-not-allowed', message: `this route accepts ${allowed}` },
  })
}

/**
 * Read a JSON request body.
 *
 * The ESLint adapter boundary confines `JSON.parse` to the designated format-parser
 * modules, and this transport module is not one of them. The platform `Response.json()`
 * reader parses the same JSON grammar, so the body reader stays small and reviewed
 * rather than growing a second parser (or a hand-rolled one) in the adapter.
 */
const readJsonBody = async (req, limit) => {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new HttpError(413, 'too-large', `the request body exceeds ${limit} bytes`)
    chunks.push(buffer)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return await new Response(text, { headers: { 'content-type': 'application/json' } }).json()
  } catch {
    throw new HttpError(400, 'invalid-input', 'the request body is not valid JSON')
  }
}

/** Read and validate `config.actorKinds`; unsupported kinds fail startup, not a request. */
const actorKindsOf = (value) => {
  if (value === undefined) return [...DEFAULT_ACTOR_KINDS]
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('aleph-research-host: config.actorKinds must be a non-empty array of actor kinds')
  }
  const kinds = []
  for (const kind of value) {
    if (typeof kind !== 'string' || !SUPPORTED_ACTOR_KINDS.includes(kind)) {
      throw new Error(
        `aleph-research-host: config.actorKinds may only name ${SUPPORTED_ACTOR_KINDS.join(', ')}; `
        + 'an implementer principal carries a Host-minted ticket binding and cannot be created from an HTTP body',
      )
    }
    if (!kinds.includes(kind)) kinds.push(kind)
  }
  return kinds
}

/** Read and validate `config.maxBodyBytes`. */
const bodyLimitOf = (value) => {
  if (value === undefined) return DEFAULT_BODY_LIMIT_BYTES
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('aleph-research-host: config.maxBodyBytes must be a positive integer')
  }
  return value
}

/**
 * Mint the Principal for one allowed actor kind.
 *
 * Operator and Researcher need only a Session; Watchdog and Host need no proof for any
 * route in the frozen command surface. The Session ids are stable so a client that
 * claims an Issue as `researcher` is the same principal when it later proposes an
 * Experiment. The kind was checked against config before this runs.
 */
const actorFor = (kind) => {
  switch (kind) {
    case 'operator':
      return { kind, sessionId: `${SESSION_PREFIX}:operator` }
    case 'researcher':
      return { kind, sessionId: `${SESSION_PREFIX}:researcher` }
    case 'watchdog':
      return { kind, sessionId: `${SESSION_PREFIX}:watchdog` }
    case 'host':
      return { kind }
    default:
      throw new HttpError(403, 'forbidden', 'the requested actorKind is not allowed on this host')
  }
}

/** Resolve the default or explicitly requested actor kind against the configuration. */
const actorKindFor = (requested, allowed) => {
  if (requested === undefined) return allowed[0]
  if (typeof requested !== 'string' || !allowed.includes(requested)) {
    throw new HttpError(403, 'forbidden', `this host accepts actorKind ${allowed.join(', ')}`)
  }
  return requested
}

/** Import one compiled runtime module; a failing import names the build command. */
const importCompiled = async (url) => {
  try {
    return await import(url.href)
  } catch (error) {
    const reason = String(error?.message ?? error)
    throw new Error(
      `aleph-research-host: cannot load the compiled research runtime at ${url.pathname} (${reason}). `
      + BUILD_COMMAND,
      { cause: error },
    )
  }
}

/**
 * True when a wrapped import failure is a missing compiled file.
 *
 * Only `ERR_MODULE_NOT_FOUND` is the absent-`dist/` boundary that may degrade to a 503
 * health route. A syntax error, a missing export or any other import failure is a broken
 * or stale build and stays a startup error, because a half-working route table would hide
 * it. `importCompiled` wraps the original error as `cause`, so the chain is walked rather
 * than the message parsed.
 */
const isBuildMissing = (error) => {
  for (let cursor = error; cursor !== null && cursor !== undefined; cursor = cursor.cause) {
    if (cursor?.code === 'ERR_MODULE_NOT_FOUND') return true
  }
  return false
}

/**
 * Load the compiled modules this fiber needs.
 *
 * The storage-domain adapter is imported only when a persistent store was resolved, so a
 * host that runs in memory depends on `composition.js` alone. The tool, trigger and route
 * tables are loaded with it because the `alephResearchHost` service needs all three; a
 * missing `dist/` still degrades to the 503 health route.
 */
const loadRuntime = async (withStorageDomain) => {
  const [composition, tools, triggers, api] = await Promise.all([
    importCompiled(COMPOSITION_URL),
    importCompiled(TOOLS_URL),
    importCompiled(TRIGGERS_URL),
    importCompiled(API_URL),
  ])
  const storageDomain = withStorageDomain ? await importCompiled(STORAGE_DOMAIN_URL) : undefined
  return { composition, storageDomain, tools, triggers, api }
}

/**
 * Load only the tables the `alephResearchHost` service needs.
 *
 * This is the `config.host` path: the caller already owns a ResearchHost, so a missing
 * `dist/` must not fail startup. The caller warns and omits the service instead.
 */
const loadServiceRuntime = async () => {
  const [tools, triggers, api] = await Promise.all([
    importCompiled(TOOLS_URL),
    importCompiled(TRIGGERS_URL),
    importCompiled(API_URL),
  ])
  return { tools, triggers, api }
}

/** True when `value` exposes the four methods the storage-domain adapter calls. */
const isDomainStore = (value) => {
  if (typeof value !== 'object' || value === null) return false
  for (const method of DOMAIN_STORE_METHODS) {
    if (typeof value[method] !== 'function') return false
  }
  return true
}

/** Warn once about a missing or unusable optional store; the caller falls back to memory. */
const warnMemoryFallback = (ctx, reason) => {
  ctx.logger?.warn?.(
    'aleph-research-host: %s; using the in-memory store (persistent: false). '
    + 'Mount the aleph-research-storage plugin to persist research state.',
    reason,
  )
}

/**
 * Resolve the optional persistent `DomainStore` for this fiber.
 *
 * `config.domainStore` wins when it is set; otherwise the `alephResearchStore` service is
 * read with `ctx.get`, which needs no `inject` entry because the service is optional by
 * design. Every refusal path warns and returns `undefined`; none throws, so a profile
 * without the storage plugin still starts. The returned object is used to compose the
 * persistent UnitOfWork.
 */
const resolveDomainStore = (ctx, settings) => {
  if (settings.domainStore !== undefined) {
    if (isDomainStore(settings.domainStore)) return settings.domainStore
    warnMemoryFallback(ctx, 'config.domainStore is not a DomainStore (list/get/put/delete)')
    return undefined
  }
  if (typeof ctx.get !== 'function') {
    warnMemoryFallback(ctx, 'this context cannot resolve the alephResearchStore service')
    return undefined
  }
  let provided
  try {
    provided = ctx.get(STORE_SERVICE_NAME)
  } catch (error) {
    const reason = String(error?.message ?? error)
    warnMemoryFallback(ctx, `resolving the alephResearchStore service failed (${reason})`)
    return undefined
  }
  if (provided === undefined) {
    warnMemoryFallback(ctx, `no ${STORE_SERVICE_NAME} service is provided`)
    return undefined
  }
  if (!isDomainStore(provided)) {
    warnMemoryFallback(ctx, `the ${STORE_SERVICE_NAME} service is not a DomainStore (list/get/put/delete)`)
    return undefined
  }
  return provided
}

/**
 * Build the persistent UnitOfWork over one resolved `DomainStore`.
 *
 * `transactionMode: 'snapshot'` is explicit: DSH has no cross-table transaction (see
 * `docs/notes/storage-domain-adapter.md`), so the adapter's snapshot/rollback compensation
 * is the only transaction available. A compiled runtime without the factory is a stale
 * `dist/`, which fails startup like a missing `composition.js`; a factory that rejects the
 * store is reported as a fallback, because persistence is optional.
 */
const composePersistentStore = (ctx, storageDomain, domainStore) => {
  const create = storageDomain?.createStorageDomainUnitOfWork
  if (typeof create !== 'function') {
    throw new Error(
      'aleph-research-host: the compiled research runtime does not export createStorageDomainUnitOfWork. '
      + BUILD_COMMAND,
    )
  }
  try {
    return create(domainStore, { transactionMode: 'snapshot' })
  } catch (error) {
    const reason = String(error?.message ?? error)
    warnMemoryFallback(ctx, `composing the persistent store failed (${reason})`)
    return undefined
  }
}

/** The runtime-facing port surface this transport needs before it registers routes. */
const assertHost = (host, label) => {
  for (const method of ['handleHttp', 'snapshot', 'attention']) {
    if (typeof host?.[method] !== 'function') {
      throw new Error(`aleph-research-host: ${label} does not provide ${method}()`)
    }
  }
  return host
}

/** Collect the createResearchHost options config may inject, ignoring transport keys. */
const hostOptionsOf = (settings) => {
  const options = {}
  for (const key of HOST_OPTION_KEYS) {
    if (hasOwn(settings, key)) options[key] = settings[key]
  }
  return options
}

// ---------------------------------------------------------------------------
// The `alephResearchHost` service: tool execution and trigger delivery.
// ---------------------------------------------------------------------------

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A service-level refusal: `{ ok: false, error }`, never thrown. */
const serviceFailure = (code, message) => ({ ok: false, error: { code, message } })

/** Extract a draft from either a `TriggerReport` (`{ action, kind, draft }`) or a draft. */
const triggerDraftOf = (value) => {
  if (!isRecord(value)) return null
  if (hasOwn(value, 'draft')) return isRecord(value.draft) ? value.draft : null
  return Array.isArray(value.threads) && typeof value.kind === 'string' ? value : null
}

/**
 * Build the trigger port the ResearchHost delivers through.
 *
 * `receive` forwards a report's draft to the registered sink, or records the report when
 * no sink is attached. A sink failure is logged and returned as a failed `Result`; it is
 * never thrown, so a bridge cannot break the tool path. `config.triggerPort` is honoured
 * as a fallback receiver when no sink is registered, which keeps the documented
 * pass-through behavior without hiding the bridge.
 */
export function createTriggerPort(logger, fallbackPort) {
  const recorded = []
  let sink = null

  return {
    get recorded() {
      return recorded.slice()
    },
    async receive(report) {
      const draft = triggerDraftOf(report)
      if (draft === null) return { ok: true, value: undefined }
      if (sink !== null) {
        try {
          await sink(draft, report)
          return { ok: true, value: undefined }
        } catch (error) {
          logger?.warn?.(
            'aleph-research-host: the trigger sink failed for %s: %s',
            String(draft.kind),
            String(error?.message ?? error),
          )
          return serviceFailure('internal', 'the trigger sink failed')
        }
      }
      if (fallbackPort !== null && typeof fallbackPort === 'object' && typeof fallbackPort.receive === 'function') {
        try {
          return await fallbackPort.receive(report)
        } catch (error) {
          logger?.warn?.(
            'aleph-research-host: the fallback trigger port failed: %s',
            String(error?.message ?? error),
          )
          return serviceFailure('internal', 'the fallback trigger port failed')
        }
      }
      recorded.push(report)
      return { ok: true, value: undefined }
    },
    onTrigger(callback) {
      if (callback !== null && callback !== undefined && typeof callback !== 'function') {
        throw new TypeError('onTrigger requires a function or null')
      }
      sink = callback ?? null
      return () => {
        if (sink === callback) sink = null
      }
    },
    setTriggerSink(callback) {
      sink = typeof callback === 'function' ? callback : null
    },
    dispose() {
      sink = null
    },
  }
}

/**
 * Index the compiled tool registry under the names a caller may use.
 *
 * The DSH adapter passes the runtime name (`researcher_read_program`); tests and other
 * embeddings may pass the `<role>.<key>` catalog id, the default-prefixed DSH name, the
 * operation name, or a descriptor object. Aliases resolve without importing the
 * `research-tools` adapter, so this transport does not depend on the tool-registration
 * plugin (and its DSH schema conversion).
 */
const indexTools = (registry) => {
  const byId = new Map()
  const byRuntimeName = new Map()
  const byOperation = new Map()
  for (const role of TOOL_ROLES) {
    const tools = registry[role]
    if (!isRecord(tools)) continue
    for (const [key, definition] of Object.entries(tools)) {
      if (!isRecord(definition) || typeof definition.name !== 'string') continue
      const entry = {
        id: `${role}.${key}`,
        role,
        key,
        runtimeName: definition.name,
        command: typeof definition.command === 'string' ? definition.command : undefined,
        schema: definition.parameters,
      }
      byId.set(entry.id, entry)
      byRuntimeName.set(entry.runtimeName, entry)
      const operation = entry.runtimeName.startsWith(`${role}_`)
        ? entry.runtimeName.slice(role.length + 1)
        : entry.runtimeName
      // A collision (the same operation in two roles) has no unique alias; a third
      // occurrence must not resurrect one, so track it through `has` rather than a value.
      if (byOperation.has(operation)) byOperation.set(operation, null)
      else byOperation.set(operation, entry)
    }
  }
  return { byId, byRuntimeName, byOperation }
}

/** The default DSH prefix; kept local so this module does not import `research-tools.js`. */
const DEFAULT_SERVICE_PREFIX = 'aleph_research_'

/** Resolve a tool name (or a descriptor from the DSH adapter) into one registry entry. */
const resolveToolEntry = (index, toolName) => {
  if (isRecord(toolName)) {
    for (const key of [toolName.id, toolName.runtimeName, toolName.name]) {
      if (typeof key !== 'string') continue
      const entry = index.byId.get(key) ?? index.byRuntimeName.get(key)
      if (entry !== undefined) return entry
    }
    return undefined
  }
  if (typeof toolName !== 'string') return undefined
  const exact = index.byId.get(toolName) ?? index.byRuntimeName.get(toolName)
  if (exact !== undefined) return exact
  if (toolName.startsWith(DEFAULT_SERVICE_PREFIX)) {
    const rest = toolName.slice(DEFAULT_SERVICE_PREFIX.length)
    const stripped = index.byRuntimeName.get(rest)
      ?? index.byId.get(rest)
      ?? index.byOperation.get(rest)
    if (stripped !== undefined) return stripped
  }
  for (const role of TOOL_ROLES) {
    if (!toolName.startsWith(`${role}_`)) continue
    const entry = index.byRuntimeName.get(toolName)
    if (entry !== undefined) return entry
  }
  return index.byOperation.get(toolName) ?? undefined
}

/** Fill one compiled `ROUTE_TABLE` path with the parsed command's path parameters. */
const pathForRoute = (template, input) => {
  let missing = false
  const path = template.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_match, name) => {
    const value = isRecord(input) ? input[name] : undefined
    if (typeof value !== 'string' && typeof value !== 'number') {
      missing = true
      return ''
    }
    return encodeURIComponent(String(value))
  })
  return missing ? undefined : path
}

/** Mint the Principal for a non-Implementer tool role. */
const actorForToolRole = (kind, context) => {
  const session = typeof context.sessionId === 'string' && context.sessionId.length > 0
    ? context.sessionId
    : undefined
  switch (kind) {
    case 'operator':
      return { kind, sessionId: session ?? `${SESSION_PREFIX}:operator` }
    case 'researcher':
      return { kind, sessionId: session ?? `${SESSION_PREFIX}:researcher` }
    case 'watchdog':
      return { kind, sessionId: session ?? `${SESSION_PREFIX}:watchdog` }
    case 'host':
      return { kind }
    default:
      return undefined
  }
}

/**
 * Read the Host-minted ticket id for an Implementer tool call.
 *
 * The tool schema deliberately omits `ticketId`/`binding`, so the only accepted sources
 * are trusted Host context (`context.actor`, `context.ticketId`) and the optional
 * `config.ticketBinding` resolver. A model-supplied value never reaches this function.
 */
const resolveTicketId = async (settings, context) => {
  if (isRecord(context.actor) && context.actor.kind === IMPLEMENTER_ROLE
    && typeof context.actor.ticketId === 'string' && context.actor.ticketId.length > 0) {
    return { ticketId: context.actor.ticketId, sessionId: context.actor.sessionId }
  }
  if (typeof context.ticketId === 'string' && context.ticketId.length > 0) {
    return { ticketId: context.ticketId }
  }
  if (typeof settings.ticketBinding !== 'function') return undefined
  const resolved = await settings.ticketBinding(context)
  if (typeof resolved === 'string' && resolved.length > 0) return { ticketId: resolved }
  if (isRecord(resolved) && typeof resolved.ticketId === 'string' && resolved.ticketId.length > 0) {
    return { ticketId: resolved.ticketId, sessionId: resolved.sessionId }
  }
  return undefined
}

/**
 * Create the `alephResearchHost` service over one composed ResearchHost.
 *
 * @param {{
 *   host: object,
 *   tools: object,
 *   triggers: object,
 *   api: object,
 *   triggerPort?: object,
 *   ticketBinding?: Function,
 *   logger?: object,
 * }} options
 * @returns the service (`executeTool`, `triggerPort`, `onTrigger`, `setTriggerSink`, `dispose`).
 */
export function createResearchHostService(options) {
  const settings = options ?? {}
  const host = settings.host
  if (!isRecord(host)) throw new TypeError('createResearchHostService requires a ResearchHost')
  const registry = settings.tools?.TOOL_REGISTRY
  if (!isRecord(registry)) {
    throw new Error(
      'aleph-research-host: the compiled research runtime does not export TOOL_REGISTRY. ' + BUILD_COMMAND,
    )
  }
  const routeTable = settings.api?.ROUTE_TABLE
  if (!isRecord(routeTable)) {
    throw new Error(
      'aleph-research-host: the compiled research runtime does not export ROUTE_TABLE. ' + BUILD_COMMAND,
    )
  }
  const triggerFactory = typeof settings.triggers?.createTriggerFactory === 'function'
    ? settings.triggers.createTriggerFactory()
    : null
  const index = indexTools(registry)
  const triggerPort = settings.triggerPort ?? createTriggerPort(settings.logger)
  const logger = settings.logger
  const seenAuditIds = new Set()
  let closed = false
  let attentionSequence = 0

  const repositoryOf = (name) => {
    const repository = host.store?.[name]
    return isRecord(repository) ? repository : undefined
  }

  const readProgram = async (input) => {
    if (typeof host.snapshot !== 'function') {
      return serviceFailure('not-implemented', 'this research host cannot read a Program snapshot')
    }
    const snapshot = await host.snapshot(input.programId)
    if (!isRecord(snapshot)) return serviceFailure('internal', 'the research host returned no snapshot')
    if (snapshot.ok !== true) {
      return {
        ok: false,
        status: Number.isInteger(snapshot.status) ? snapshot.status : 404,
        error: snapshot.error ?? { code: 'not-found', message: `program ${input.programId} does not exist` },
      }
    }
    return snapshot
  }

  const readMetrics = async (input) => {
    const repository = repositoryOf('ciRecords')
    if (typeof repository?.query !== 'function') {
      return serviceFailure('not-implemented', 'this research host cannot query metric records')
    }
    return { ok: true, value: await repository.query(input) }
  }

  const readExperiment = async (input) => {
    const repository = repositoryOf('experiments')
    if (typeof repository?.get !== 'function') {
      return serviceFailure('not-implemented', 'this research host cannot read an Experiment')
    }
    const found = await repository.get(input.experimentId)
    if (found === undefined) {
      return {
        ok: false,
        status: 404,
        error: { code: 'not-found', message: `experiment ${input.experimentId} does not exist` },
      }
    }
    return { ok: true, value: found.value }
  }

  /** The runtime has no stalled projection yet: non-closed Issues are the honest answer. */
  const listStalled = async (_input, context) => {
    const programId = typeof context.programId === 'string' && context.programId.length > 0
      ? context.programId
      : undefined
    if (programId === undefined) {
      return serviceFailure(
        'invalid-input',
        'listStalled carries no parameters, so the Host context must name the programId to inspect',
      )
    }
    const repository = repositoryOf('issues')
    if (typeof repository?.listByProgram !== 'function') {
      return serviceFailure('not-implemented', 'this research host cannot list Issues')
    }
    const stalled = []
    for (const issue of await repository.listByProgram(programId)) {
      if (issue?.status !== 'closed') stalled.push(issue)
    }
    return { ok: true, value: stalled }
  }

  /** Resolve the Program an Attention subject belongs to through the store. */
  const programOfSubject = async (subject) => {
    if (subject.kind === 'program') return subject.id
    if (subject.kind === 'issue') {
      const found = await repositoryOf('issues')?.get(subject.id)
      return found?.value?.programId
    }
    if (subject.kind === 'experiment') {
      const found = await repositoryOf('experiments')?.get(subject.id)
      return found?.value?.programId
    }
    if (subject.kind === 'ci-run') {
      const found = await repositoryOf('ciRecords')?.get(subject.id)
      return found?.programId
    }
    return undefined
  }

  /**
   * Append one Attention for the Watchdog tool.
   *
   * The frozen command surface has no `attention.raise` route, so this is a direct
   * repository write, not a command: it mints the record the tool output contract needs
   * (`severity` defaults to `warning`, since no severity is modelled in the tool input)
   * and does not fabricate a `attention.raised` audit entry.
   */
  const raiseAttention = async (input) => {
    const programId = await programOfSubject(input.subject)
    if (typeof programId !== 'string' || programId.length === 0) {
      return {
        ok: false,
        status: 404,
        error: { code: 'not-found', message: `attention subject ${String(input.subject?.id)} does not exist` },
      }
    }
    const repository = repositoryOf('attention')
    if (typeof repository?.append !== 'function') {
      return serviceFailure('not-implemented', 'this research host cannot store attention entries')
    }
    attentionSequence += 1
    const at = typeof host.clock?.now === 'function' ? host.clock.now() : new Date().toISOString()
    const attention = {
      id: `attention-${at}-${attentionSequence}`,
      subject: input.subject,
      severity: 'warning',
      reason: input.reason,
      detail: input.reason,
      at,
    }
    const stored = await repository.append(attention)
    if (isRecord(stored) && stored.ok === false) {
      const kind = typeof stored.error?.kind === 'string' ? stored.error.kind : 'store-error'
      return serviceFailure(kind, stored.error?.message ?? 'the attention entry could not be stored')
    }
    return { ok: true, value: attention }
  }

  const readTools = {
    'researcher.readProgram': readProgram,
    'researcher.readMetrics': readMetrics,
    'implementer.readExperiment': readExperiment,
    'watchdog.listStalled': listStalled,
    'watchdog.raiseAttention': raiseAttention,
    'watchdog.readMetrics': readMetrics,
  }

  /** Map the audit entries a command response carries and deliver their drafts. */
  const emitResponseTriggers = async (response) => {
    if (closed || triggerFactory === null) return
    const entries = response?.body?.audit
    if (!Array.isArray(entries) || entries.length === 0) return
    if (typeof host.snapshot !== 'function') return
    const snapshots = new Map()
    for (const entry of entries) {
      if (!isRecord(entry)) continue
      if (typeof entry.id === 'string') {
        if (seenAuditIds.has(entry.id)) continue
        seenAuditIds.add(entry.id)
      }
      const programId = entry.programId
      if (typeof programId !== 'string') continue
      let snapshot = snapshots.get(programId)
      if (snapshot === undefined) {
        try {
          const stored = await host.snapshot(programId)
          snapshot = isRecord(stored) && stored.ok === true ? stored.value : null
        } catch {
          snapshot = null
        }
        snapshots.set(programId, snapshot)
      }
      if (snapshot === null) continue
      const report = triggerFactory.make(entry, snapshot)
      if (!isRecord(report) || !isRecord(report.draft)) continue
      await triggerPort.receive(report)
    }
  }

  /** Run one command tool through the compiled route table and the host boundary. */
  const runCommand = async (entry, parsed, context) => {
    const requested = context.actorKind
    const actorKind = requested === undefined ? entry.role : requested
    if (!TOOL_ACTOR_KINDS.includes(actorKind)) {
      return serviceFailure(
        'forbidden',
        `this host cannot mint actorKind ${String(actorKind)} for ${entry.runtimeName}`,
      )
    }

    let actor
    if (actorKind === IMPLEMENTER_ROLE) {
      const ticket = await resolveTicketId(settings, context)
      if (ticket === undefined) {
        return serviceFailure(
          'forbidden',
          `${entry.runtimeName} requires a Host-minted ticket binding; `
          + 'no ticket resolver is available (pass context.ticketId or config.ticketBinding)',
        )
      }
      const stored = await repositoryOf('tickets')?.get(ticket.ticketId)
      const storedSession = stored?.value?.sessionId
      const contextSession = typeof context.sessionId === 'string' && context.sessionId.length > 0
        ? context.sessionId
        : undefined
      const sessionId = typeof ticket.sessionId === 'string' && ticket.sessionId.length > 0
        ? ticket.sessionId
        : typeof storedSession === 'string' && storedSession.length > 0
          ? storedSession
          : contextSession ?? `${SESSION_PREFIX}:implementer`
      actor = { kind: IMPLEMENTER_ROLE, ticketId: ticket.ticketId, sessionId }
    } else {
      actor = actorForToolRole(actorKind, context)
      if (actor === undefined) {
        return serviceFailure('forbidden', `this host cannot mint actorKind ${String(actorKind)}`)
      }
    }

    const route = routeTable[entry.command]
    if (!isRecord(route) || typeof route.path !== 'string') {
      return serviceFailure('not-implemented', `the compiled runtime has no route for ${String(entry.command)}`)
    }
    const path = pathForRoute(route.path, parsed)
    if (path === undefined) {
      return serviceFailure(
        'invalid-input',
        `${entry.runtimeName} input does not name every path parameter of ${route.path}`,
      )
    }

    const response = await host.handleHttp({ method: 'POST', path, body: parsed, actor })
    // Trigger delivery is an effect beside the command, not part of it: a bridge or port
    // failure must not change the tool result the model sees.
    try {
      await emitResponseTriggers(response)
    } catch (error) {
      logger?.warn?.(
        'aleph-research-host: trigger delivery after %s failed: %s',
        String(entry.runtimeName),
        String(error?.message ?? error),
      )
    }
    if (!isRecord(response)) {
      return serviceFailure('internal', 'the research host returned no HTTP response')
    }
    const status = response.status
    const body = response.body
    if (!Number.isInteger(status) || status < 200 || status >= 300 || body?.ok === false) {
      const error = isRecord(body?.error)
        ? body.error
        : { code: 'http-error', message: `the research host answered ${String(status)}` }
      return { ok: false, status, error }
    }
    if (isRecord(body) && body.ok === true) return body
    return { ok: true, value: body }
  }

  /** Serve one read-family tool from the host's read surfaces. */
  const runRead = async (entry, parsed, context) => {
    if (!READ_TOOL_IDS.has(entry.id)) {
      return serviceFailure('not-implemented', `${entry.runtimeName} has no Host read implementation`)
    }
    return readTools[entry.id](parsed, context)
  }

  return {
    /**
     * Execute one runtime tool by name or descriptor.
     *
     * Input is parsed by the tool's own boundary `Schema` before any host call, and every
     * failure (unknown tool, invalid input, refusal, transport exception) is returned as
     * `{ ok: false, error }`; this method never throws.
     */
    async executeTool(toolName, input, context) {
      if (closed) return serviceFailure('conflict', 'the research host service is disposed')
      const call = isRecord(context) ? context : {}
      try {
        const entry = resolveToolEntry(index, toolName)
        if (entry === undefined) {
          return serviceFailure('not-found', `unknown research tool ${String(toolName)}`)
        }
        const parsed = entry.schema.parse(input)
        if (!isRecord(parsed) || parsed.ok !== true) {
          const error = parsed?.error
          return serviceFailure(
            typeof error?.code === 'string' ? error.code : 'invalid-input',
            typeof error?.message === 'string' && error.message.length > 0
              ? error.message
              : `${entry.runtimeName} input is invalid`,
          )
        }
        if (entry.command !== undefined) return await runCommand(entry, parsed.value, call)
        return await runRead(entry, parsed.value, call)
      } catch (error) {
        logger?.warn?.(
          'aleph-research-host: executeTool(%s) failed: %s',
          String(toolName),
          String(error?.message ?? error),
        )
        return serviceFailure('internal', `the research host failed to execute ${String(toolName)}`)
      }
    },
    triggerPort,
    onTrigger(callback) {
      return triggerPort.onTrigger(callback)
    },
    setTriggerSink(callback) {
      triggerPort.setTriggerSink(callback)
    },
    dispose() {
      closed = true
      triggerPort.dispose()
    },
  }
}

/** Format the Program list from the read model; null means the host cannot list. */
const listPrograms = async (host) => {
  const repository = host.store?.programs
  if (typeof repository?.list !== 'function') return null
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

/** Extract one decoded path segment after an already-matched prefix. */
const tailOf = (url, prefix) => {
  let pathname
  try {
    pathname = new URL(typeof url === 'string' ? url : '/', 'http://localhost').pathname
  } catch {
    throw new HttpError(400, 'invalid-input', 'the request URL is not valid')
  }
  if (!pathname.startsWith(prefix)) return undefined
  const tail = pathname.slice(prefix.length)
  if (tail.length === 0 || tail.includes('/')) return undefined
  try {
    return decodeURIComponent(tail)
  } catch {
    throw new HttpError(400, 'invalid-input', 'the programId is not valid URL encoding')
  }
}

/**
 * Register the research routes into `disposers` as each registration succeeds, so a
 * failed registration still leaves every earlier route releasable.
 *
 * A handler owns its whole response; the web server turns an escaping exception into a
 * 400 and a warning, so every handler catches and maps instead. The runtime's own
 * `status` is passed through untouched. `persistent` is the health flag: it records
 * whether this fiber composed the storage-domain UnitOfWork instead of the in-memory
 * store, not whether the host currently has data.
 */
const registerRoutes = (ctx, host, actorKinds, maxBodyBytes, persistent, disposers) => {
  const install = (route) => {
    const dispose = ctx.webServer.register(route)
    if (typeof dispose === 'function') disposers.push(dispose)
  }

  const fail = (res, error) => {
    if (error instanceof HttpError) {
      sendJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
      return
    }
    ctx.logger?.warn?.('aleph-research-host request failed: %s', String(error?.message ?? error))
    sendJson(res, 500, {
      ok: false,
      error: { code: 'internal', message: 'the research host failed to handle the request' },
    })
  }

  install({
    kind: 'exact',
    path: HEALTH_PATH,
    async handler(req, res) {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
      sendJson(res, 200, { ok: true, version: VERSION, persistent })
    },
  })

  install({
    kind: 'exact',
    path: REQUESTS_PATH,
    async handler(req, res) {
      if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
      try {
        const payload = await readJsonBody(req, maxBodyBytes)
        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
          throw new HttpError(400, 'invalid-input', 'the request body must be a JSON object')
        }
        const path = ownValue(payload, 'path')
        if (typeof path !== 'string' || !path.startsWith('/')) {
          throw new HttpError(400, 'invalid-input', 'body.path must be an absolute API path')
        }
        const actor = actorFor(actorKindFor(ownValue(payload, 'actorKind'), actorKinds))
        const body = hasOwn(payload, 'body') ? ownValue(payload, 'body') : {}
        const response = await host.handleHttp({ method: 'POST', path, body, actor })
        sendJson(res, response.status, response.body)
      } catch (error) {
        fail(res, error)
      }
    },
  })

  install({
    kind: 'exact',
    path: PROGRAMS_PATH,
    async handler(req, res) {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
      try {
        const programs = await listPrograms(host)
        if (programs === null) {
          sendJson(res, 404, {
            ok: false,
            error: { code: 'not-found', message: 'this research host cannot list programs' },
          })
          return
        }
        sendJson(res, 200, { ok: true, count: programs.length, programs })
      } catch (error) {
        fail(res, error)
      }
    },
  })

  // The webserver's prefix table matches on a segment boundary, so the exact list route
  // above wins for `/programs` and this prefix serves `/programs/<id>`.
  install({
    kind: 'prefix',
    path: PROGRAMS_PATH,
    async handler(req, res) {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
      try {
        const programId = tailOf(req.url, PROGRAMS_TAIL_PREFIX)
        if (programId === undefined) throw new HttpError(404, 'not-found', 'a programId is required')
        const snapshot = await host.snapshot(programId)
        const status = snapshot?.ok === true ? 200 : Number.isInteger(snapshot?.status) ? snapshot.status : 404
        sendJson(res, status, snapshot)
      } catch (error) {
        fail(res, error)
      }
    },
  })

  install({
    kind: 'prefix',
    path: ATTENTION_PATH,
    async handler(req, res) {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
      try {
        const programId = tailOf(req.url, ATTENTION_TAIL_PREFIX)
        if (programId === undefined) throw new HttpError(404, 'not-found', 'a programId is required')
        const attention = await host.attention(programId)
        sendJson(res, 200, { ok: true, programId, attention })
      } catch (error) {
        fail(res, error)
      }
    },
  })
}

/**
 * Register the only route a fiber without a compiled runtime can serve.
 *
 * A missing `dist/` is an installation state, not a transport bug: the plugin stays
 * mounted, answers 503 with a machine-readable code, and keeps the build command in the
 * message so the recovery step travels with the response. Every other route is absent
 * and therefore 404, which is the truthful answer: this host cannot serve them.
 */
const registerBuildMissingHealth = (ctx, disposers, reason) => {
  ctx.logger?.warn?.(
    'aleph-research-host: %s; serving GET %s with %s until research-core is built',
    reason,
    HEALTH_PATH,
    BUILD_MISSING_CODE,
  )
  const dispose = ctx.webServer.register({
    kind: 'exact',
    path: HEALTH_PATH,
    async handler(req, res) {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
      sendJson(res, 503, {
        ok: false,
        error: {
          code: BUILD_MISSING_CODE,
          message: `the compiled research runtime is missing. ${BUILD_COMMAND}`,
        },
      })
    },
  })
  if (typeof dispose === 'function') disposers.push(dispose)
}

/**
 * Start the research transport.
 *
 * The effect is registered before the first await and its cleanup drains the same
 * disposer list the registrations push into. A fiber that disposes while the runtime is
 * still loading is therefore observed before any route is registered, and a disposal
 * after a partial registration still releases every route that was installed.
 */
export const apply = async (ctx, config) => {
  const settings = config ?? {}
  const actorKinds = actorKindsOf(settings.actorKinds)
  const maxBodyBytes = bodyLimitOf(settings.maxBodyBytes)
  // An injected host owns its own store, so the optional service is not consulted: the
  // health flag describes what this transport composed, not what the host may hold.
  const domainStore = settings.host === undefined ? resolveDomainStore(ctx, settings) : undefined

  let host = null
  let service = null
  let persistent = false
  let disposed = false
  // The port the composed host delivers its own `deliverTriggers()` reports through. It
  // is created before composition so `createResearchHost` receives the same object the
  // service exposes; `config.triggerPort`, when present, stays the fallback receiver.
  const triggerPort = createTriggerPort(ctx.logger, settings.triggerPort)
  const routeDisposers = []
  const releaseRoutes = () => {
    while (routeDisposers.length > 0) {
      const dispose = routeDisposers.pop()
      try {
        dispose()
      } catch { /* the route table is going away */ }
    }
  }
  const disposeHost = async (candidate) => {
    if (typeof candidate?.dispose === 'function') {
      try {
        await candidate.dispose()
      } catch { /* the host is going away */ }
    }
  }

  ctx.effect(() => async () => {
    disposed = true
    releaseRoutes()
    service?.dispose()
    service = null
    const owned = host
    host = null
    await disposeHost(owned)
  })

  let composed
  let runtime
  if (settings.host !== undefined) {
    composed = assertHost(settings.host, 'config.host')
  } else {
    try {
      runtime = await loadRuntime(domainStore !== undefined)
    } catch (error) {
      if (!isBuildMissing(error)) throw error
      if (disposed) return
      registerBuildMissingHealth(ctx, routeDisposers, String(error?.message ?? error))
      return
    }
    if (disposed) return
    if (typeof runtime.composition.createResearchHost !== 'function') {
      throw new Error(
        'aleph-research-host: the compiled research runtime does not export createResearchHost. '
        + BUILD_COMMAND,
      )
    }
    const options = hostOptionsOf(settings)
    // The service exposes this port, so the runtime's own deliveries must use it too.
    options.triggerPort = triggerPort
    if (domainStore !== undefined) {
      const store = composePersistentStore(ctx, runtime.storageDomain, domainStore)
      if (store !== undefined) {
        // The resolved DomainStore wins over an injected in-memory store: if the caller
        // asked for persistence, silently ignoring it would lose exactly the state the
        // option is meant to keep.
        options.store = store
        persistent = true
      }
    }
    composed = assertHost(runtime.composition.createResearchHost(options), 'createResearchHost')
  }
  if (disposed) {
    await disposeHost(composed)
    return
  }
  host = composed

  // The service is the DSH execution seam. An injected host still gets one when the
  // compiled tables are available; a missing `dist/` only omits the service, because the
  // injected-host escape hatch must not start depending on the build it bypasses.
  try {
    if (runtime === undefined) runtime = await loadServiceRuntime()
    const candidate = createResearchHostService({
      host: composed,
      tools: runtime.tools,
      triggers: runtime.triggers,
      api: runtime.api,
      triggerPort,
      ticketBinding: settings.ticketBinding,
      logger: ctx.logger,
    })
    if (disposed) {
      candidate.dispose()
      return
    }
    service = candidate
    if (typeof ctx.provide === 'function') ctx.provide(RESEARCH_HOST_SERVICE, candidate)
  } catch (error) {
    if (settings.host === undefined) throw error
    ctx.logger?.warn?.(
      'aleph-research-host: the %s service is unavailable for the injected host (%s)',
      RESEARCH_HOST_SERVICE,
      String(error?.message ?? error),
    )
  }

  registerRoutes(ctx, composed, actorKinds, maxBodyBytes, persistent, routeDisposers)
  ctx.logger?.info?.(
    'aleph-research-host ready: %d research routes (persistent: %s, service: %s)',
    5,
    String(persistent),
    String(service !== null),
  )
}
