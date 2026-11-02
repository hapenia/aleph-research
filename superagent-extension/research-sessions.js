/**
 * AlephResearch Session pool: the DSH Sessions that run the research presets.
 *
 * Phase 1b adds two research presets (`aleph-operator` and `aleph-researcher` in
 * `cordis.patch.yml`). A preset alone is inert: nothing creates a Session with it. This
 * module owns that lifecycle for the research plane, so a later tool bridge can address
 * an Operator or Researcher Session without inventing a Session per call.
 *
 * ## What it creates
 *
 * - **Operator** — at most one per workspace, under the deterministic id
 *   `aleph-operator-<hash>`; `<hash>` is the first 12 hex characters of the SHA-256 of
 *   the workspace id, so the same workspace always resolves to the same Session. The
 *   workspace is `config.workspaceId` when set, otherwise the registry's current
 *   (first, newest) workspace; a registry with no workspace at all gets one created for
 *   `config.cwd` (default `process.cwd()`) so the Session has a real location.
 * - **Researchers** — a fixed pool. `ensureResearcherSession(id)` resolves or creates
 *   one named Session with the `aleph-researcher` preset, and `ensurePool(n)` ensures
 *   the deterministic ids `aleph-researcher-1` … `aleph-researcher-n`. No Issue is
 *   assigned here: assignment is a later phase, and the pool only guarantees that the
 *   Sessions exist and can be woken.
 *
 * ## Wake delivery
 *
 * `wakeResearcher(id, message)` calls `agent.followup` with
 * `{ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'aleph-research' } }`,
 * which queues the message for the Session's next turn and wakes it. The `id` is a fresh
 * `aleph-research:<uuid>`: DSH's durable inbox identifies pending messages by `id` and
 * rejects a second pending message without one, so the pool mints one per wake (the
 * existing Watchdog does the same with `watchdog-<timestamp>`). Identical pending
 * messages are deduplicated for `wakeTtlMs`; the dedupe bookkeeping is bounded both per
 * Session (`maxPendingWakesPerSession`) and across Sessions
 * (`maxTrackedWakeSessions`). A message that would exceed a bound is refused with a
 * structured result instead of being dropped silently.
 *
 * ## Failure policy
 *
 * `ensureOperatorSession` and `ensureResearcherSession` return an Agent, so they throw
 * when the Session cannot be resolved or created, or when an existing Session runs a
 * different preset (a Session's preset is fixed at creation, and silently returning a
 * wrong-role Agent would be worse than failing). The bulk and delivery APIs —
 * `ensurePool` and `wakeResearcher` — never throw for one failed Session: they report
 * `{ ok: false, code, error }`, record the failure in `status()`, and let the remaining
 * work continue. `dispose()` is idempotent, clears every map and cache, and makes the
 * pool inert; there are no timers to clear because wake expiry is pruned lazily.
 *
 * ## Plugin surface
 *
 * `inject = ['sessionController', 'workspaceRegistry']`. The optional
 * `alephResearchHost` service is read with `ctx.get` and only reported as
 * `hostAttached`; it is not a dependency, so a composition without the host plugin
 * still mounts this one. The pool is published as the `alephResearchSessions` service.
 * Config is optional: `{ poolSize, workspaceId }`. `poolSize` defaults to 0 (no Session
 * is created at activation); a positive value makes `apply` call `ensurePool` once, and
 * a failure is logged rather than failing the fiber.
 */
import { createHash, randomUUID } from 'node:crypto'

/** Cordis plugin name, matching the Loader row id. */
export const name = 'aleph-research-sessions'

/** Host services this plugin hard-depends on; `alephResearchHost` stays optional. */
export const inject = ['sessionController', 'workspaceRegistry']

/** The service consumers resolve with `ctx.get('alephResearchSessions')`. */
export const SERVICE_NAME = 'alephResearchSessions'

/** Optional host service read with `ctx.get`; absent in a host-less composition. */
export const HOST_SERVICE_NAME = 'alephResearchHost'

/** Preset ids declared in `cordis.patch.yml`; they must match `PRESET_ROLES` in research-tools.js. */
export const OPERATOR_PRESET = 'aleph-operator'
export const RESEARCHER_PRESET = 'aleph-researcher'
export const IMPLEMENTER_PRESET = 'aleph-implementer'

/** Fixed Session id prefix; the suffix is the deterministic workspace hash. */
export const OPERATOR_ID_PREFIX = 'aleph-operator-'

/** Fixed researcher id prefix; the pool uses `aleph-researcher-<n>`. */
export const RESEARCHER_ID_PREFIX = 'aleph-researcher-'
export const IMPLEMENTER_ID_PREFIX = 'aleph-implementer-'

/** Offset so pool index 1 is the first Session, not the zeroth. */
const FIRST_POOL_INDEX = 1

/** Session ids this pool accepts: DSH ids are printable and colon/dot/hyphen tolerant. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/** The largest pool `ensurePool` accepts; a research deployment needs introspection, not hundreds of Sessions. */
export const MAX_POOL_SIZE = 32

/** Default bounds and expiry for wake bookkeeping. */
const DEFAULT_WAKE_TTL_MS = 5 * 60 * 1000
const DEFAULT_MAX_PENDING_WAKES_PER_SESSION = 16
const DEFAULT_MAX_TRACKED_WAKE_SESSIONS = 128
const DEFAULT_MAX_RECORDED_FAILURES = 32

/** How many hex characters of the workspace hash the operator id carries. */
const OPERATOR_HASH_LENGTH = 12

/** The two communication shapes `resolveAgent` returns in DSH. */
const isFailure = (value) => value !== null
  && typeof value === 'object'
  && Object.getOwnPropertyDescriptor(value, 'error') !== undefined

/** Read the preset a Session was created with, when the header still carries it. */
const presetOf = (agent) => {
  const preset = agent?.session?.header?.agentPreset
  return typeof preset === 'string' && preset.length > 0 ? preset : undefined
}

/** Compose the deterministic operator Session id for one workspace identity. */
const operatorIdFor = (workspace) => {
  const identity = workspace?.id ?? workspace?.path
  if (typeof identity !== 'string' || identity.length === 0) {
    throw new Error('aleph-research-sessions: the resolved workspace has no id or path to hash')
  }
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, OPERATOR_HASH_LENGTH)
  return `${OPERATOR_ID_PREFIX}${hash}`
}

/** Compose the deterministic id of pool slot `index` (1-based). */
const researcherIdFor = (index) => `${RESEARCHER_ID_PREFIX}${index}`

/** A code-carrying error for callers that distinguish failure classes. */
const poolError = (code, message) => Object.assign(new Error(message), { code })

/** Normalize a Session-domain failure value into an Error, keeping its code. */
const sessionFailure = (error, sessionId, action) => {
  if (error instanceof Error) return error
  const code = typeof error?.code === 'string' ? error.code : 'session/failed'
  const message = typeof error?.message === 'string' ? error.message : String(error)
  return poolError(code, `aleph-research-sessions: cannot ${action} session '${sessionId}': ${message}`)
}

/** Reject a Session id that DSH or this pool could not address safely. */
const assertSessionId = (sessionId) => {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new TypeError(
      'aleph-research-sessions: sessionId must be 1-128 characters matching /^[A-Za-z0-9][A-Za-z0-9._:-]*$/',
    )
  }
  return sessionId
}

/** Read one optional positive-integer setting, falling back to its default. */
const positiveIntegerOption = (value, fallback, label, max = Number.MAX_SAFE_INTEGER) => {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new TypeError(`aleph-research-sessions: ${label} must be an integer between 1 and ${max}`)
  }
  return value
}

/**
 * Validate the plugin/config options once, so every method can trust them.
 *
 * @param {unknown} config `ctx` config from the Loader, or the second argument of
 *   `createResearchSessionPool` in an embedding.
 * @returns {Readonly<object>} normalized settings.
 */
export function parseResearchSessionsConfig(config) {
  if (config !== undefined && config !== null && (typeof config !== 'object' || Array.isArray(config))) {
    throw new TypeError('aleph-research-sessions: config must be an object')
  }
  const settings = config ?? {}
  const poolSize = settings.poolSize === undefined ? 0 : settings.poolSize
  if (!Number.isSafeInteger(poolSize) || poolSize < 0 || poolSize > MAX_POOL_SIZE) {
    throw new TypeError(
      `aleph-research-sessions: config.poolSize must be an integer between 0 and ${MAX_POOL_SIZE}`,
    )
  }
  const workspaceId = settings.workspaceId
  if (workspaceId !== undefined && (typeof workspaceId !== 'string' || workspaceId.trim().length === 0)) {
    throw new TypeError('aleph-research-sessions: config.workspaceId must be a non-empty string')
  }
  const cwd = settings.cwd === undefined ? process.cwd() : settings.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new TypeError('aleph-research-sessions: config.cwd must be a non-empty string')
  }
  const now = settings.now === undefined ? Date.now : settings.now
  if (typeof now !== 'function') {
    throw new TypeError('aleph-research-sessions: config.now must be a () => number function')
  }
  return Object.freeze({
    poolSize,
    workspaceId: workspaceId?.trim(),
    cwd,
    now,
    wakeTtlMs: positiveIntegerOption(settings.wakeTtlMs, DEFAULT_WAKE_TTL_MS, 'config.wakeTtlMs'),
    maxPendingWakesPerSession: positiveIntegerOption(
      settings.maxPendingWakesPerSession,
      DEFAULT_MAX_PENDING_WAKES_PER_SESSION,
      'config.maxPendingWakesPerSession',
    ),
    maxTrackedWakeSessions: positiveIntegerOption(
      settings.maxTrackedWakeSessions,
      DEFAULT_MAX_TRACKED_WAKE_SESSIONS,
      'config.maxTrackedWakeSessions',
    ),
  })
}

/** Resolve the optional research host without making it a dependency. */
const resolveHost = (ctx) => {
  if (typeof ctx.get !== 'function') return undefined
  try {
    return ctx.get(HOST_SERVICE_NAME)
  } catch {
    return undefined
  }
}

/**
 * Build the Session pool over one Cordis context.
 *
 * The context must expose `sessionController.resolveAgent/create` and
 * `workspaceRegistry.get/list/create`; no optional service is required. Every method
 * below closes over `settings`, so a pool can be unit-tested with a fake context and a
 * fake clock.
 *
 * @param {object} ctx a Cordis context or an object with the same service shape.
 * @param {object} [config] plugin config/embedding options (`poolSize`, `workspaceId`,
 *   plus the test seams `now`, `wakeTtlMs`, `maxPendingWakesPerSession`,
 *   `maxTrackedWakeSessions`, `cwd`).
 * @returns {object} the pool service value.
 */
export function createResearchSessionPool(ctx, config) {
  if (ctx === null || typeof ctx !== 'object') {
    throw new TypeError('aleph-research-sessions: createResearchSessionPool requires a context')
  }
  const controller = ctx.sessionController
  if (controller === null || typeof controller !== 'object'
    || typeof controller.resolveAgent !== 'function' || typeof controller.create !== 'function') {
    throw new TypeError('aleph-research-sessions: ctx.sessionController must provide resolveAgent() and create()')
  }
  const registry = ctx.workspaceRegistry
  if (registry === null || typeof registry !== 'object' || typeof registry.list !== 'function') {
    throw new TypeError('aleph-research-sessions: ctx.workspaceRegistry must provide list()')
  }
  const settings = parseResearchSessionsConfig(config)
  const host = resolveHost(ctx)
  const logger = ctx.logger

  const state = {
    disposed: false,
    hostAttached: host !== undefined && host !== null,
    workspaceId: null,
    operatorSessionId: null,
    researchers: new Set(),
    failures: [],
    lastError: null,
    poolSize: settings.poolSize,
  }

  /** One workspace for the whole pool lifetime; retried after a failed resolution. */
  let workspacePromise = null
  /** Session-id -> in-flight ensure promise, so concurrent callers create once. */
  const inflight = new Map()
  /** Session-id -> Map<messageKey, expiresAt>; lazily pruned on every wake. */
  const pendingWakes = new Map()

  const recordFailure = (sessionId, code, error) => {
    const entry = {
      sessionId,
      code,
      error: String(error?.message ?? error),
      at: new Date(settings.now()).toISOString(),
    }
    state.lastError = entry
    state.failures.push(entry)
    if (state.failures.length > DEFAULT_MAX_RECORDED_FAILURES) state.failures.shift()
    logger?.warn?.('aleph-research-sessions: %s failed (%s): %s', sessionId, code, entry.error)
    return entry
  }

  const assertActive = (operation) => {
    if (state.disposed) throw poolError('disposed', `aleph-research-sessions: cannot ${operation} after dispose()`)
  }

  /**
   * Resolve the workspace this pool addresses.
   *
   * `config.workspaceId` wins and must already be registered; otherwise the registry's
   * first (newest/current) workspace is used. A registry with no workspace gets one for
   * `settings.cwd`, because DSH Session creation requires a real workspace id.
   */
  const resolveWorkspace = async () => {
    if (settings.workspaceId !== undefined) {
      const workspace = typeof registry.get === 'function' ? registry.get(settings.workspaceId) : undefined
      if (workspace === undefined || workspace === null) {
        throw poolError(
          'workspace/not-found',
          `aleph-research-sessions: workspace '${settings.workspaceId}' is not registered`,
        )
      }
      return workspace
    }
    const workspaces = await registry.list()
    if (Array.isArray(workspaces) && workspaces.length > 0) return workspaces[0]
    if (typeof registry.create !== 'function') {
      throw poolError(
        'workspace/not-found',
        'aleph-research-sessions: the workspace registry is empty and cannot create one',
      )
    }
    // The registry canonicalizes the path and returns the existing record for a repeat.
    return await registry.create(settings.cwd)
  }

  const workspace = () => {
    if (workspacePromise === null) {
      workspacePromise = resolveWorkspace()
        .then((resolved) => {
          state.workspaceId = resolved?.id ?? null
          return resolved
        })
        .catch((error) => {
          workspacePromise = null
          throw error
        })
    }
    return workspacePromise
  }

  /** Refuse a resolved Agent whose Session already runs a different preset. */
  const assertPreset = (agent, sessionId, preset) => {
    const existing = presetOf(agent)
    if (existing !== undefined && existing !== preset) {
      throw poolError(
        'preset/mismatch',
        `aleph-research-sessions: session '${sessionId}' runs preset '${existing}', expected '${preset}'`,
      )
    }
  }

  /** Resolve a Session or create it under `preset`; the preset is never changed. */
  const resolveOrCreate = async (sessionId, preset) => {
    let resolved = await controller.resolveAgent(sessionId)
    if (!isFailure(resolved)) {
      assertPreset(resolved.agent, sessionId, preset)
      return resolved.agent
    }
    if (resolved.error?.code !== 'session/not-found') {
      throw sessionFailure(resolved.error, sessionId, 'resolve')
    }
    // The workspace is needed only for creation: an existing Session is usable even when
    // the registry is temporarily unavailable.
    const resolvedWorkspace = await workspace()
    await controller.create({ sessionId, workspaceId: resolvedWorkspace.id, agentPreset: preset })
    resolved = await controller.resolveAgent(sessionId)
    if (isFailure(resolved)) throw sessionFailure(resolved.error, sessionId, 'resolve')
    assertPreset(resolved.agent, sessionId, preset)
    return resolved.agent
  }

  /** Ensure-or-create one Session, deduplicating concurrent attempts on the same id. */
  const ensureSession = (sessionId, preset) => {
    const pending = inflight.get(sessionId)
    if (pending !== undefined) return pending
    const task = resolveOrCreate(sessionId, preset)
    const tracked = task.finally(() => {
      if (inflight.get(sessionId) === tracked) inflight.delete(sessionId)
    })
    inflight.set(sessionId, tracked)
    return tracked
  }

  /**
   * Resolve or create the one Operator Session for this pool's workspace.
   *
   * @returns {Promise<object>} the live DSH Agent running `aleph-operator`.
   * @throws when the workspace or Session cannot be resolved/created, or when the id
   *   already belongs to a Session with another preset.
   */
  const ensureOperatorSession = async () => {
    assertActive('ensure the operator session')
    const resolvedWorkspace = await workspace()
    const sessionId = operatorIdFor(resolvedWorkspace)
    const agent = await ensureSession(sessionId, OPERATOR_PRESET)
    state.operatorSessionId = sessionId
    return agent
  }

  /**
   * Resolve or create one Researcher Session by id.
   *
   * @param {string} sessionId a valid DSH Session id (the pool's own ids are
   *   `aleph-researcher-<n>`).
   * @returns {Promise<object>} the live DSH Agent running `aleph-researcher`.
   * @throws when the id is malformed, the Session cannot be resolved/created, or the
   *   existing Session runs another preset.
   */
  const ensureResearcherSession = async (sessionId) => {
    assertActive('ensure a researcher session')
    assertSessionId(sessionId)
    const agent = await ensureSession(sessionId, RESEARCHER_PRESET)
    state.researchers.add(sessionId)
    return agent
  }

  const implementerIdFor = (ticketId) => {
    const suffix = String(ticketId).replace(/[^A-Za-z0-9._:-]/gu, '-').slice(-80)
    return `${IMPLEMENTER_ID_PREFIX}${suffix}`
  }

  const ensureImplementerSession = async (ticketId) => {
    assertActive('ensure an implementer session')
    if (typeof ticketId !== 'string' || ticketId.length === 0) {
      throw new TypeError('aleph-research-sessions: ensureImplementer needs a ticketId')
    }
    const sessionId = assertSessionId(implementerIdFor(ticketId))
    await ensureSession(sessionId, IMPLEMENTER_PRESET)
    return sessionId
  }

  /** Drop expired wake entries and return the live map for one Session, if any. */
  const liveWakes = (sessionId, now) => {
    const entries = pendingWakes.get(sessionId)
    if (entries === undefined) return undefined
    for (const [key, expiresAt] of entries) {
      if (expiresAt <= now) entries.delete(key)
    }
    if (entries.size === 0) {
      pendingWakes.delete(sessionId)
      return undefined
    }
    return entries
  }

  /**
   * Wake one Researcher Session with a message for its next turn.
   *
   * The Agent is ensured first, so a wake can also be the first thing that creates the
   * pool slot. Identical messages still pending within `wakeTtlMs` are deduplicated;
   * exceeding the per-Session or tracked-Session bound returns `{ ok: false }` rather
   * than silently dropping the message. This method never throws for a per-Session
   * failure: the failure is reported and recorded in `status()`.
   *
   * @param {string} sessionId a valid DSH Session id.
   * @param {string} message the user-role text to queue.
   * @returns {Promise<{ok: boolean, sessionId?: string, deduped?: boolean, code?: string,
   *   error?: string}>} a structured delivery report.
   */
  const wakeResearcher = async (sessionId, message) => {
    if (state.disposed) return { ok: false, sessionId, code: 'disposed', error: 'the pool was disposed' }
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
      return {
        ok: false,
        sessionId,
        code: 'invalid-session-id',
        error: 'sessionId must be 1-128 characters matching /^[A-Za-z0-9][A-Za-z0-9._:-]*$/',
      }
    }
    if (typeof message !== 'string' || message.trim().length === 0) {
      return {
        ok: false,
        sessionId,
        code: 'invalid-message',
        error: 'message must be a non-empty string',
      }
    }

    let agent
    try {
      agent = await ensureResearcherSession(sessionId)
    } catch (error) {
      const entry = recordFailure(sessionId, 'session-failed', error)
      return { ok: false, sessionId, code: 'session-failed', error: entry.error }
    }
    if (state.disposed) return { ok: false, sessionId, code: 'disposed', error: 'the pool was disposed' }
    if (typeof agent?.followup !== 'function') {
      const entry = recordFailure(sessionId, 'agent/cannot-followup', 'the resolved Agent has no followup()')
      return { ok: false, sessionId, code: 'agent/cannot-followup', error: entry.error }
    }

    const now = settings.now()
    const key = createHash('sha256').update(message).digest('hex').slice(0, 32)
    const entries = liveWakes(sessionId, now)
    if (entries?.has(key) === true) {
      return { ok: true, sessionId, deduped: true }
    }
    if (entries !== undefined && entries.size >= settings.maxPendingWakesPerSession) {
      const entry = recordFailure(
        sessionId,
        'wake-limit',
        `more than ${settings.maxPendingWakesPerSession} wakes are still pending`,
      )
      return { ok: false, sessionId, code: 'wake-limit', error: entry.error }
    }
    if (entries === undefined && pendingWakes.size >= settings.maxTrackedWakeSessions) {
      // The map is insertion ordered: drop the oldest Session's dedupe state, not a
      // message that was just queued.
      const oldest = pendingWakes.keys().next().value
      if (oldest !== undefined) pendingWakes.delete(oldest)
    }

    try {
      agent.followup({
        id: `aleph-research:${randomUUID()}`,
        role: 'user',
        content: [{ type: 'text', text: message }],
        source: { kind: 'aleph-research' },
      })
    } catch (error) {
      const entry = recordFailure(sessionId, 'followup-failed', error)
      return { ok: false, sessionId, code: 'followup-failed', error: entry.error }
    }

    const live = pendingWakes.get(sessionId) ?? new Map()
    live.set(key, now + settings.wakeTtlMs)
    pendingWakes.set(sessionId, live)
    return { ok: true, sessionId, deduped: false }
  }

  const wakeImplementer = async (sessionId, message) => {
    if (state.disposed) return { ok: false, sessionId, code: 'disposed', error: 'the pool was disposed' }
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
      return {
        ok: false,
        sessionId,
        code: 'invalid-session-id',
        error: 'sessionId must be 1-128 characters matching /^[A-Za-z0-9][A-Za-z0-9._:-]*$/',
      }
    }
    if (typeof message !== 'string' || message.trim().length === 0) {
      return {
        ok: false,
        sessionId,
        code: 'invalid-message',
        error: 'message must be a non-empty string',
      }
    }
    let agent
    try {
      agent = await ensureSession(sessionId, IMPLEMENTER_PRESET)
    } catch (error) {
      const entry = recordFailure(sessionId, 'session-failed', error)
      return { ok: false, sessionId, code: 'session-failed', error: entry.error }
    }
    if (state.disposed) return { ok: false, sessionId, code: 'disposed', error: 'the pool was disposed' }
    if (typeof agent?.followup !== 'function') {
      const entry = recordFailure(sessionId, 'agent/cannot-followup', 'the resolved Agent has no followup()')
      return { ok: false, sessionId, code: 'agent/cannot-followup', error: entry.error }
    }
    try {
      await agent.followup({
        id: `aleph-research:${randomUUID()}`,
        role: 'user',
        content: [{ type: 'text', text: message }],
        source: { kind: 'aleph-research' },
      })
    } catch (error) {
      const entry = recordFailure(sessionId, 'followup-failed', error)
      return { ok: false, sessionId, code: 'followup-failed', error: entry.error }
    }
    return { ok: true, sessionId }
  }

  /**
   * Ensure `size` deterministic Researcher Sessions (`aleph-researcher-1..size`).
   *
   * No Issue is assigned and no message is sent; this only guarantees the pool exists.
   * One failed Session does not fail the call: the ids that were ensured are returned
   * and every failure is available through `status()`.
   *
   * @param {number} size pool size, from 0 through `MAX_POOL_SIZE`.
   * @returns {Promise<string[]>} the ids that were ensured successfully, in order.
   */
  const ensurePool = async (size) => {
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_POOL_SIZE) {
      throw new TypeError(
        `aleph-research-sessions: ensurePool(size) needs an integer between 0 and ${MAX_POOL_SIZE}`,
      )
    }
    if (state.disposed) return []
    const ids = []
    for (let index = FIRST_POOL_INDEX; index <= size; index += 1) {
      if (state.disposed) break
      const sessionId = researcherIdFor(index)
      try {
        await ensureResearcherSession(sessionId)
        ids.push(sessionId)
      } catch (error) {
        recordFailure(sessionId, 'session-failed', error)
      }
    }
    return ids
  }

  /** Read the pool's current bookkeeping without touching the runtime. */
  const status = () => {
    const now = settings.now()
    let pending = 0
    for (const sessionId of pendingWakes.keys()) {
      const entries = liveWakes(sessionId, now)
      pending += entries?.size ?? 0
    }
    return {
      name,
      disposed: state.disposed,
      hostAttached: state.hostAttached,
      configuredPoolSize: state.poolSize,
      workspaceId: state.workspaceId,
      operatorSessionId: state.operatorSessionId,
      researcherSessionIds: [...state.researchers],
      pendingWakes: pending,
      failures: state.failures.map((entry) => ({ ...entry })),
      lastError: state.lastError === null ? null : state.lastError.error,
    }
  }

  /** Clear every map/cache; idempotent, never throws, and makes later work inert. */
  const dispose = () => {
    if (state.disposed) return
    state.disposed = true
    workspacePromise = null
    inflight.clear()
    pendingWakes.clear()
    state.researchers.clear()
    state.operatorSessionId = null
    state.failures = []
    state.lastError = null
  }

  return {
    name,
    settings,
    ensureOperatorSession,
    ensureResearcherSession,
    ensureImplementer: ensureImplementerSession,
    startWorker: ensureImplementerSession,
    wakeImplementer,
    wakeResearcher,
    ensurePool,
    status,
    dispose,
    get disposed() {
      return state.disposed
    },
  }
}

/**
 * Cordis plugin entry: build the pool, publish it as `alephResearchSessions`, and own
 * its disposal through the fiber effect.
 *
 * A positive `config.poolSize` ensures that many Researcher Sessions during activation.
 * `ensurePool` reports per-Session failures instead of throwing, so an unavailable
 * workspace or Session cannot prevent the plugin from mounting; the failure stays
 * visible in the service's `status()` and in the host log.
 *
 * @param {object} ctx the Cordis plugin context.
 * @param {unknown} [config] optional `{ poolSize, workspaceId }`.
 * @returns {Promise<void>} resolution once the service is provided and the configured
 *   pool has been attempted.
 */
export async function apply(ctx, config) {
  const pool = createResearchSessionPool(ctx, config)
  ctx.effect(() => () => pool.dispose(), 'aleph-research-sessions: dispose the session pool')
  ctx.provide(SERVICE_NAME, pool)
  if (pool.settings.poolSize > 0) {
    const ids = await pool.ensurePool(pool.settings.poolSize)
    ctx.logger?.info?.('aleph-research-sessions ready: ensured %d researcher session(s)', ids.length)
    return
  }
  ctx.logger?.info?.('aleph-research-sessions ready: pool service provided (poolSize 0)')
}
