import {
  PRESETS,
  ROUTES,
  SETTINGS,
  SURFACE_NAMES,
  TOOLS,
  bindSurface,
} from '../research-core/dist/adapter/surface.js'

const ok = (value) => ({ ok: true, value })
const error = (code, message) => ({ ok: false, error: { code, message } })

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

const LEGACY_TOOL = Object.freeze({
  'program.create': 'operator_create_program',
  'program.pause': 'operator_pause_program',
  'program.resume': 'operator_resume_program',
  'program.stop': 'operator_stop_program',
  'program.goal': 'operator_set_goal',
  'program.methodology': 'operator_set_methodology',
  'program.exploration': 'operator_set_exploration',
  'issue.create': 'operator_create_issue',
  'issue.claim': 'researcher_claim_issue',
  'issue.comment': 'researcher_comment_issue',
  'issue.close': 'researcher_close_issue',
  'experiment.propose': 'researcher_propose_experiment',
  'experiment.review': 'researcher_review_experiment',
  'experiment.close': 'researcher_close_experiment',
  'benchmark.request': 'researcher_request_ci',
  'ticket.submit': 'implementer_submit_implementation',
  aleph_research_create_program: 'operator_create_program',
  aleph_research_pause_program: 'operator_pause_program',
  aleph_research_resume_program: 'operator_resume_program',
  aleph_research_stop_program: 'operator_stop_program',
  aleph_research_set_goal: 'operator_set_goal',
  aleph_research_set_methodology: 'operator_set_methodology',
  aleph_research_set_exploration: 'operator_set_exploration',
  aleph_research_create_issue: 'operator_create_issue',
  aleph_research_claim_issue: 'researcher_claim_issue',
  aleph_research_comment_issue: 'researcher_comment_issue',
  aleph_research_close_issue: 'researcher_close_issue',
  aleph_research_propose_experiment: 'researcher_propose_experiment',
  aleph_research_review_experiment: 'researcher_review_experiment',
  aleph_research_close_experiment: 'researcher_close_experiment',
  aleph_research_request_benchmark: 'researcher_request_ci',
  aleph_research_submit_ticket: 'implementer_submit_implementation',
  aleph_research_read_program: 'researcher_read_program',
  aleph_research_read_benchmarks: 'researcher_read_metrics',
  aleph_research_read_experiment: 'implementer_read_experiment',
})

const COMMAND_TYPE = Object.freeze({
  operator_create_program: 'program.create',
  operator_pause_program: 'program.pause',
  operator_resume_program: 'program.resume',
  operator_stop_program: 'program.stop',
  operator_set_goal: 'program.set-goal',
  operator_set_methodology: 'program.set-methodology',
  operator_set_exploration: 'program.set-exploration',
  operator_create_issue: 'issue.create',
  researcher_claim_issue: 'issue.claim',
  researcher_comment_issue: 'issue.comment',
  researcher_close_issue: 'issue.close',
  researcher_propose_experiment: 'experiment.propose',
  researcher_review_experiment: 'experiment.review',
  researcher_close_experiment: 'experiment.close',
  researcher_request_ci: 'ci.request',
  implementer_submit_implementation: 'ticket.submit',
})

const ROLE = Object.freeze({
  'program.create': 'operator',
  'program.pause': 'operator',
  'program.resume': 'operator',
  'program.stop': 'operator',
  'program.goal': 'operator',
  'program.methodology': 'operator',
  'program.exploration': 'operator',
  'issue.create': 'operator',
  'issue.claim': 'researcher',
  'issue.comment': 'researcher',
  'issue.close': 'researcher',
  'experiment.propose': 'researcher',
  'experiment.review': 'researcher',
  'experiment.close': 'researcher',
  'benchmark.request': 'researcher',
  'ticket.submit': 'implementer',
})

const roleFor = (name) => ROLE[name]
  ?? TOOLS[name]?.role
  ?? PRESETS[name]?.role
  ?? 'operator'

const inputOf = (request) => {
  const body = isRecord(request.body) ? request.body : {}
  return { ...body, ...(isRecord(request.params) ? request.params : {}) }
}

const environmentOf = (environment) => {
  if (!isRecord(environment)) return undefined
  if (environment.kind === 'uv-lock') {
    return { kind: 'uv-lock', file: String(environment.lockFile) }
  }
  if (environment.kind === 'requirements') {
    return { kind: 'requirements', file: String(environment.requirementsFile) }
  }
  return undefined
}

const decisionOf = (input) => {
  if (input?.decision === 'revise') return { kind: 'revise' }
  if (input?.decision === 'stop') return { kind: 'stop', reason: 'goal-met' }
  if (input?.verdict === 'request-changes') return { kind: 'revise' }
  return { kind: 'propose' }
}

const failureOf = (result) => {
  const failure = result?.error
  return {
    ...error(
      typeof failure?.code === 'string' ? failure.code : 'invalid-input',
      typeof failure?.message === 'string' ? failure.message : 'the research command was refused',
    ),
    status: Number.isInteger(result?.status) ? result.status : 400,
  }
}

export function createSurfaceHandlers(options) {
  const settings = options ?? {}
  const executeTool = settings.executeTool
  const runtime = settings.runtime
  const store = settings.store
  const logger = settings.logger
  const actorSession = settings.actorSession ?? 'aleph-researcher-1'

  if (typeof executeTool !== 'function') {
    throw new TypeError('createSurfaceHandlers requires executeTool(tool, input, context)')
  }
  if (runtime === undefined || typeof runtime.start !== 'function') {
    throw new TypeError('createSurfaceHandlers requires the core runtime')
  }
  if (store === undefined || typeof store.experiments?.get !== 'function') {
    throw new TypeError('createSurfaceHandlers requires the versioned research store')
  }

  const ticketOfExperiment = async (experimentId) => {
    if (typeof experimentId !== 'string') return undefined
    if (typeof store.tickets?.listByExperiment !== 'function') return undefined
    const tickets = await store.tickets.listByExperiment(experimentId)
    return tickets.find((ticket) => ticket.status === 'running' || ticket.status === 'submitted')
  }

  const contextOf = async (name, request, input) => {
    const role = roleFor(name)
    const actor = isRecord(request.actor) ? request.actor : {}
    const actorSessionId = typeof actor.sessionId === 'string' && actor.sessionId.length > 0
      ? actor.sessionId
      : undefined
    let sessionId = actor.kind === role && actorSessionId !== undefined
      ? actorSessionId
      : actorSession
    const context = { actorKind: role, sessionId }
    if (typeof input.ticketId === 'string') {
      context.ticketId = input.ticketId
    } else if (typeof actor.ticketId === 'string') {
      context.ticketId = actor.ticketId
    } else if (role === 'implementer') {
      const ticket = await ticketOfExperiment(input.experimentId)
      if (ticket !== undefined) {
        context.ticketId = ticket.id
        if (typeof ticket.sessionId === 'string' && ticket.sessionId.length > 0) {
          sessionId = ticket.sessionId
          context.sessionId = sessionId
        }
      } else if (typeof settings.ticketOfSession === 'function') {
        const known = settings.ticketOfSession(sessionId)
        if (typeof known === 'string') context.ticketId = known
      }
    }
    return context
  }

  const startBenchmark = async (input) => {
    const experimentId = input.experimentId
    if (typeof experimentId !== 'string') {
      return error('invalid-input', 'benchmark.request needs an experimentId')
    }
    const stored = await store.experiments.get(experimentId)
    if (stored === undefined) {
      return error('not-found', `experiment ${experimentId} does not exist`)
    }
    const experiment = stored.value
    const environment = environmentOf(experiment.environment)
    if (environment === undefined) {
      return error('invalid-input', 'the experiment has no declared environment')
    }
    const progress = await runtime.start({
      programId: experiment.programId,
      issueId: experiment.issueId,
      experimentId,
      branch: experiment.branch,
      baseCommit: experiment.head,
      environment,
    })
    if (progress.status === 'failed') {
      return error(progress.error.kind, progress.error.message)
    }
    return ok({ experimentId, progress })
  }

  const resumeReview = async (input) => {
    const pending = runtime.pending()
    if (pending === undefined || pending.effect !== 'sessions.review') return undefined
    const progress = await runtime.resumeReview(decisionOf(input))
    if (progress.status === 'failed') {
      return error(progress.error.kind, progress.error.message)
    }
    return ok(progress)
  }

  const resumeCommit = async (input) => {
    const pending = runtime.pending()
    if (pending === undefined || pending.effect !== 'sessions.submitCommit') return undefined
    const commit = input.head
    if (typeof commit !== 'string') return error('invalid-input', 'ticket.submit needs a head commit')
    const progress = await runtime.resumeCommit(commit)
    if (progress.status === 'failed') {
      return error(progress.error.kind, progress.error.message)
    }
    return ok(progress)
  }

  const command = async (name, input, request) => {
    if (name === 'benchmark.request' || name === 'aleph_research_request_benchmark') {
      const started = await startBenchmark(input)
      if (!started.ok) return started
      return ok({ progress: started.value.progress })
    }
    const legacy = LEGACY_TOOL[name]
    if (legacy === undefined) return error('not-found', `no tool is bound to ${name}`)
    const context = await contextOf(name, request, input)
    const clean = { ...input }
    if (legacy === 'implementer_submit_implementation') {
      delete clean.experimentId
      delete clean.ticketId
    }
    const commandType = COMMAND_TYPE[legacy]
    const payload = commandType === undefined ? clean : { ...clean, type: commandType }
    const result = await executeTool(legacy, payload, context)
    if (result?.ok !== true) return failureOf(result)

    if (name === 'experiment.review' || name === 'aleph_research_review_experiment') {
      const resumed = await resumeReview(input)
      if (resumed === undefined) return ok({ command: result.value })
      if (!resumed.ok) return resumed
      return ok({ command: result.value, progress: resumed.value })
    }
    if (name === 'ticket.submit' || name === 'aleph_research_submit_ticket') {
      const resumed = await resumeCommit(input)
      if (resumed === undefined) return ok({ command: result.value })
      if (!resumed.ok) return resumed
      return ok({ command: result.value, progress: resumed.value })
    }
    return ok(result.value)
  }

  const handlers = {}

  for (const declaration of Object.values(ROUTES)) {
    handlers[declaration.name] = {
      kind: 'route',
      async handle(request) {
        try {
          const input = inputOf(request)
          const result = await command(declaration.name, input, request)
          if (result.ok) return { status: 200, body: { ok: true, value: result.value } }
          return {
            status: Number.isInteger(result.status) ? result.status : 400,
            body: { ok: false, error: result.error },
          }
        } catch (cause) {
          logger?.warn?.('aleph-research-core: route %s failed: %s', declaration.name, String(cause?.message ?? cause))
          return {
            status: 500,
            body: { ok: false, error: { code: 'internal', message: 'the core surface route failed' } },
          }
        }
      },
    }
  }

  for (const declaration of Object.values(TOOLS)) {
    handlers[declaration.name] = {
      kind: 'tool',
      async handle(request) {
        try {
          return await command(declaration.name, isRecord(request.input) ? request.input : {}, request)
        } catch (cause) {
          logger?.warn?.('aleph-research-core: tool %s failed: %s', declaration.name, String(cause?.message ?? cause))
          return error('internal', 'the core surface tool failed')
        }
      },
    }
  }

  for (const declaration of Object.values(PRESETS)) {
    handlers[declaration.name] = {
      kind: 'preset',
      async handle(request) {
        return ok(request.sessionId ?? declaration.name)
      },
    }
  }

  for (const declaration of Object.values(SETTINGS)) {
    handlers[declaration.name] = {
      kind: 'setting',
      async handle() {
        return ok(undefined)
      },
    }
  }

  for (const name of SURFACE_NAMES) {
    if (handlers[name] === undefined) {
      throw new Error(`the core surface has no handler for ${name}`)
    }
  }

  return handlers
}

const resultOf = () => ok(undefined)

export async function bindCoreSurface(options) {
  const settings = options ?? {}
  const handlers = settings.handlers ?? createSurfaceHandlers(settings)
  const ports = {
    http: {
      register: settings.registerRoute ?? (async () => resultOf()),
    },
    tools: {
      register: settings.registerTool ?? (async () => resultOf()),
    },
    sessions: {
      register: settings.registerPreset ?? (async () => resultOf()),
    },
    settings: {
      register: settings.registerSetting ?? (async () => resultOf()),
    },
  }
  const bound = await bindSurface(handlers, ports)
  return { handlers, bound }
}
