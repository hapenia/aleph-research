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
 *   and a resolved `domainStore` replaces it with the persistent UnitOfWork.
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
 * host that runs in memory depends on `composition.js` alone.
 */
const loadRuntime = async (withStorageDomain) => {
  const composition = await importCompiled(COMPOSITION_URL)
  const storageDomain = withStorageDomain ? await importCompiled(STORAGE_DOMAIN_URL) : undefined
  return { composition, storageDomain }
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
  let persistent = false
  let disposed = false
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
    const owned = host
    host = null
    await disposeHost(owned)
  })

  let composed
  if (settings.host !== undefined) {
    composed = assertHost(settings.host, 'config.host')
  } else {
    let runtime
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

  registerRoutes(ctx, composed, actorKinds, maxBodyBytes, persistent, routeDisposers)
  ctx.logger?.info?.(
    'aleph-research-host ready: %d research routes (persistent: %s)',
    5,
    String(persistent),
  )
}
