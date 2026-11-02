/**
 * Bridge from the research runtime's trigger stream to the prototype `aleph` Source.
 *
 * `research-host` maps every audited command into a `ResearchTriggerDraft` and hands it
 * to the sink registered on its `alephResearchHost` service. This plugin is that sink:
 * it converts each draft into the prototype `Trigger` shape the vendored superagent
 * Source accepts and calls `ctx.orchestrator.context({ kind: 'aleph', ... }).receive()`.
 *
 * ## DSH / Source API mapping
 *
 * | Here | Prototype seam | Notes |
 * | --- | --- | --- |
 * | `inject = ['orchestrator']` | `SourceHost` | The host service that owns every Source context. |
 * | `ctx.orchestrator.context({ kind: 'aleph', health: ['aleph'] })` | `SourceHost.context(kind)` | The same call `research-extension.js` makes; the health entries must match the Source kind. |
 * | `source.receive(trigger)` | `SourceContext.receive(trigger)` | Synchronous or async; awaited so a refused delivery is observed. |
 * | `ctx.get('alephResearchHost')` | ResearchHost service | Optional: a profile without the runtime keeps this plugin inert instead of failing activation. |
 * | `ctx.on('internal/service', ...)` | Cordis service event | Rebinds when the host plugin is provided after this fiber starts (load order is not guaranteed). |
 *
 * The conversion is the shape `alephTrigger()` in `research-extension.js` already uses:
 * `{ id, source, threads, actor, human, addressed, at, text, meta }`. The runtime's
 * `ResearchTriggerDraft` uses `ResearchThreadRef` (`{ kind, id }`) and a nominal
 * `Principal`; the prototype uses `ThreadRef`/`ActorRef` (`{ source, id }`). The
 * research `kind` is carried in `meta.kind` (the prototype `meta` is free-form), together
 * with `programId` and the structured facts the runtime already put there. `addressed`
 * is `mention`, as for every other local research wake-up.
 *
 * ## Failure policy
 *
 * Trigger delivery is an effect, never a command. A conversion error, an absent Source,
 * a Source refusal or a throwing `receive` is logged and swallowed: the originating tool
 * call must not fail because the prototype plane is unavailable. Cleanup unregisters the
 * sink and the service listener, so a disposed fiber stops receiving drafts.
 */

/** Cordis plugin identity, matching the other extension modules. */
export const name = 'aleph-research-trigger-bridge'
export const inject = ['orchestrator']

/** The service `research-host` provides; the literal avoids importing that transport. */
export const HOST_SERVICE_NAME = 'alephResearchHost'

/** The prototype Source prefix every converted trigger belongs to. */
export const ALEPH_SOURCE = 'aleph'

/** The Source kind passed to `orchestrator.context()`; must match the mounted Source. */
export const ALEPH_KIND = Object.freeze({ kind: ALEPH_SOURCE, health: [ALEPH_SOURCE] })

/** Read one own data property without invoking an untrusted accessor. */
const ownValue = (source, key) => Object.getOwnPropertyDescriptor(source, key)?.value

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Convert one `ResearchTriggerDraft` into the prototype `Trigger` shape.
 *
 * Pure: the result depends only on the draft (the generated id is deterministic), so the
 * bridge tests can assert the exact object and a replay of the same draft maps to the
 * same trigger id. Throws `TypeError` for a draft that cannot name a thread, because a
 * trigger without a primary thread cannot be admitted by the Source.
 *
 * @param {object} draft a runtime `ResearchTriggerDraft`.
 * @returns {object} the prototype `Trigger`.
 */
export function toPrototypeTrigger(draft) {
  if (!isRecord(draft)) throw new TypeError('toPrototypeTrigger expects a ResearchTriggerDraft')
  const kind = draft.kind
  if (typeof kind !== 'string' || kind.length === 0) {
    throw new TypeError('the research trigger draft must name its kind')
  }
  const programId = draft.programId
  if (typeof programId !== 'string' || programId.length === 0) {
    throw new TypeError('the research trigger draft must name its programId')
  }
  if (!Array.isArray(draft.threads) || draft.threads.length === 0) {
    throw new TypeError('the research trigger draft must name at least one thread')
  }
  const threads = []
  for (const thread of draft.threads) {
    const id = isRecord(thread) ? ownValue(thread, 'id') : undefined
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('every research thread reference must carry an id')
    }
    threads.push({ source: ALEPH_SOURCE, id })
  }

  const actor = isRecord(draft.actor) ? draft.actor : {}
  const actorSession = ownValue(actor, 'sessionId')
  const actorKind = ownValue(actor, 'kind')
  const actorId = typeof actorSession === 'string' && actorSession.length > 0
    ? actorSession
    : typeof actorKind === 'string' && actorKind.length > 0
      ? actorKind
      : 'host'

  const at = typeof draft.at === 'string' && draft.at.length > 0
    ? draft.at
    : new Date().toISOString()
  const text = typeof draft.text === 'string' ? draft.text : ''

  const meta = { kind, programId }
  if (isRecord(draft.meta)) {
    for (const key of Object.keys(draft.meta)) {
      if (key === 'kind' || key === 'programId') continue
      meta[key] = ownValue(draft.meta, key)
    }
  }
  if (typeof draft.ticketId === 'string' && draft.ticketId.length > 0) {
    meta.ticketId = draft.ticketId
  }

  const subject = typeof meta.subjectId === 'string' && meta.subjectId.length > 0 ? meta.subjectId : 'program'
  return {
    // Deterministic: replaying one audit fact yields one admitted Trigger, not a wake-up
    // storm. Two distinct facts differ by kind, subject, program or timestamp.
    id: `${ALEPH_SOURCE}:${kind}:${programId}:${subject}:${at}`,
    source: ALEPH_SOURCE,
    threads,
    actor: { source: ALEPH_SOURCE, id: actorId },
    human: draft.human === true,
    addressed: 'mention',
    at,
    text,
    meta,
  }
}

/** Read the optional research host service; its absence is a normal state. */
const hostServiceOf = (ctx) => {
  if (typeof ctx?.get !== 'function') return undefined
  try {
    const service = ctx.get(HOST_SERVICE_NAME)
    return isRecord(service) ? service : undefined
  } catch {
    return undefined
  }
}

/**
 * Cordis plugin: register a trigger sink on the research host service.
 *
 * @param {object} ctx a Cordis context providing `orchestrator`, `get` and `effect`.
 * @param {object} [config] reserved; the bridge needs no deployment configuration.
 * @returns {{ dispose: Function }} a cleanup function (also owned by `ctx.effect`).
 */
export function apply(ctx, config) {
  void config
  let disposed = false
  let detached = false
  let detach = null
  let boundHost = null
  let offService

  const deliver = async (draft) => {
    let trigger
    try {
      trigger = toPrototypeTrigger(draft)
    } catch (error) {
      ctx.logger?.warn?.(
        'aleph-research-trigger-bridge: cannot convert a research draft: %s',
        String(error?.message ?? error),
      )
      return
    }
    try {
      const source = ctx.orchestrator?.context(ALEPH_KIND)
      if (source === null || typeof source !== 'object') {
        ctx.logger?.warn?.(
          'aleph-research-trigger-bridge: the aleph Source is not available; dropping %s',
          trigger.id,
        )
        return
      }
      if (typeof source.receive !== 'function') {
        ctx.logger?.warn?.(
          'aleph-research-trigger-bridge: the aleph Source cannot receive; dropping %s',
          trigger.id,
        )
        return
      }
      const received = await source.receive(trigger)
      if (isRecord(received) && received.ok === false) {
        ctx.logger?.warn?.(
          'aleph-research-trigger-bridge: the aleph Source refused %s (%s)',
          trigger.id,
          String(received.error?.code ?? received.error ?? 'refused'),
        )
      }
    } catch (error) {
      // Delivery is an effect: a throwing Source must not break the tool path.
      ctx.logger?.warn?.(
        'aleph-research-trigger-bridge: delivering %s failed: %s',
        trigger.id,
        String(error?.message ?? error),
      )
    }
  }

  const releaseSink = () => {
    detached = true
    boundHost = null
    if (typeof detach === 'function') {
      try {
        detach()
      } catch { /* the host is going away */ }
    }
    detach = null
  }

  /** Bind the current service, or unbind when it went away; safe to call repeatedly. */
  const attach = () => {
    if (disposed) return
    const host = hostServiceOf(ctx)
    if (host === boundHost) return
    if (detach !== null) releaseSink()
    boundHost = host ?? null
    if (host === undefined || typeof host.onTrigger !== 'function') return
    try {
      const release = host.onTrigger(deliver)
      // The real service returns a disposer; a small host double may not, so fall back to
      // the service's explicit unset method rather than leaving a dangling sink.
      detach = typeof release === 'function'
        ? release
        : () => {
            try {
              host.setTriggerSink?.(null)
            } catch { /* the service is going away */ }
          }
      detached = false
    } catch (error) {
      ctx.logger?.warn?.(
        'aleph-research-trigger-bridge: cannot register the trigger sink: %s',
        String(error?.message ?? error),
      )
    }
  }

  attach()
  if (typeof ctx.on === 'function') {
    offService = ctx.on('internal/service', (serviceName) => {
      if (serviceName === HOST_SERVICE_NAME) attach()
    })
  }

  const cleanup = () => {
    disposed = true
    if (typeof offService === 'function') {
      try {
        offService()
      } catch { /* the event bus is going away */ }
    }
    offService = undefined
    releaseSink()
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => () => cleanup())

  return {
    dispose: cleanup,
    /** True while a sink is registered on a live service; tests use it as evidence. */
    get attached() {
      return detached === false && detach !== null
    },
  }
}
