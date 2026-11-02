import { createHash } from 'node:crypto'

import { createCoreRuntime } from '../research-core/dist/adapter/core-runtime.js'

const TICKET_PREFIX = 'ticket:'
const BENCHMARK_PREFIX = 'benchmark:'

const ok = (value) => ({ ok: true, value })
const failure = (message, kind = 'unavailable') => ({
  ok: false,
  error: { kind, message },
})

const messageOf = (error) => (error instanceof Error && error.message.length > 0
  ? error.message
  : String(error ?? 'the host operation failed'))

const digest = (parts) => createHash('sha256')
  .update(parts.filter((part) => typeof part === 'string').join('\u0000'))
  .digest('hex')

const directionOf = (direction) => (direction === 'lower' ? 'minimize' : 'maximize')

const statusOf = (status) => {
  if (status === 'paused') return 'paused'
  if (status === 'running') return 'running'
  return 'stopped'
}

const ticketIdOf = (experimentId) => {
  const suffix = String(experimentId).replace(/[^A-Za-z0-9._:-]/gu, '-')
  return `${TICKET_PREFIX}${suffix}`
}

const benchmarkIdOf = (programId) => {
  const suffix = String(programId).replace(/[^A-Za-z0-9._:-]/gu, '-')
  return `${BENCHMARK_PREFIX}${suffix}`
}

const metricsOf = (program) => {
  const required = program?.contract?.requiredMetrics
  const definitions = program?.utility?.metrics ?? []
  if (!Array.isArray(required) || required.length === 0) {
    return definitions.map((metric) => ({
      name: String(metric.name),
      direction: directionOf(metric.direction),
      required: true,
    }))
  }
  const byName = new Map(definitions.map((metric) => [String(metric.name), metric]))
  return required.map((name) => {
    const metric = byName.get(String(name))
    return {
      name: String(name),
      direction: directionOf(metric?.direction),
      required: true,
    }
  })
}

const utilityOf = (program) => (program?.utility?.metrics ?? []).map((metric) => ({
  name: String(metric.name),
  direction: directionOf(metric.direction),
  weight: Number(metric.weight),
}))

const usageOf = (program) => ({
  experiments: Number(program?.usage?.experiments ?? 0),
  computeMinutes: Number(program?.usage?.computeMinutes ?? 0),
  tokens: Number(program?.usage?.tokens ?? 0),
})

export function coreProgramOf(program) {
  return {
    id: program.id,
    owner: program.id,
    name: program.name,
    goal: program.goal,
    methodology: program.methodology,
    benchmark: {
      id: benchmarkIdOf(program.id),
      entry: program.contract.ciEntry,
      timeoutMs: Number(program.contract.timeoutMs),
      metrics: metricsOf(program),
      maxRetries: 0,
      baseline: {},
    },
    utility: utilityOf(program),
    exploration: program.exploration,
    policy: {
      maxExperiments: Number(program.budget.maxExperiments),
      maxComputeMinutes: Number(program.budget.maxComputeMinutes),
      maxTokens: Number(program.budget.maxTokens),
      maxAttemptsPerExperiment: 2,
    },
    usage: usageOf(program),
    status: statusOf(program.status),
    createdAt: program.createdAt,
  }
}

export function benchmarkRecordOf(record, experiment) {
  const metrics = {}
  for (const metric of record.metrics) metrics[metric.name] = metric.value
  const requestedBy = experiment?.createdBy?.sessionId ?? 'aleph-researcher-1'
  const base = {
    id: record.id,
    programId: experiment.programId,
    experimentId: record.experimentId,
    commit: record.commit,
    requestedBy,
    requestedAt: record.createdAt,
  }
  if (record.status === 'passed') {
    return {
      ...base,
      status: 'passed',
      startedAt: record.createdAt,
      finishedAt: record.createdAt,
      environmentDigest: record.environmentDigest,
      metrics,
      artifacts: [],
      durationMs: 0,
    }
  }
  return {
    ...base,
    status: 'failed',
    startedAt: record.createdAt,
    finishedAt: record.createdAt,
    environmentDigest: record.environmentDigest,
    reason: 'entry-failed',
    detail: record.stderr || record.stdout || 'the benchmark failed',
    durationMs: 0,
  }
}

export function createDshCoreConcepts(options) {
  const settings = options ?? {}
  const store = settings.store
  const sessions = settings.sessions
  const trigger = settings.trigger
  const benchmark = settings.benchmark
  const clock = settings.clock
  const logger = settings.logger

  const ticketsBySession = new Map()
  const now = () => (typeof clock?.now === 'function' ? clock.now() : new Date().toISOString())

  const experimentOf = async (experimentId) => {
    const stored = await store.experiments.get(experimentId)
    return stored?.value
  }

  const programOf = async (programId) => {
    const stored = await store.programs.get(programId)
    return stored?.value
  }

  const ticketOf = async (ticketId) => {
    const stored = await store.tickets.get(ticketId)
    return stored?.value
  }

  const saveTicket = async (expected, ticket) => {
    const saved = await store.tickets.save(expected, ticket)
    if (saved?.ok !== true) {
      throw new Error(`the ticket store refused the write: ${saved?.error?.kind ?? 'unknown'}`)
    }
    return saved.value
  }

  return {
    storage: {
      async loadProgram(programId) {
        try {
          const program = await programOf(programId)
          if (program === undefined) return failure(`program ${programId} does not exist`, 'rejected')
          return ok(coreProgramOf(program))
        } catch (error) {
          return failure(messageOf(error))
        }
      },
      async appendBenchmarkRecord(record) {
        try {
          const experiment = await experimentOf(record.experimentId)
          if (experiment === undefined) {
            return failure(`experiment ${record.experimentId} does not exist`, 'rejected')
          }
          const stored = await store.ciRecords.append(benchmarkRecordOf(record, experiment))
          if (stored?.ok !== true) {
            return failure(`the benchmark store refused the record: ${stored?.error?.kind ?? 'unknown'}`)
          }
          return ok(undefined)
        } catch (error) {
          return failure(messageOf(error))
        }
      },
    },
    trigger: {
      async deliver(request) {
        try {
          const experiment = await experimentOf(request.experimentId)
          if (experiment === undefined) {
            return failure(`experiment ${request.experimentId} does not exist`, 'rejected')
          }
          const at = now()
          const draft = {
            kind: 'experiment-proposed',
            programId: experiment.programId,
            threads: [
              { kind: 'experiment', id: request.experimentId },
              { kind: 'program', id: experiment.programId },
            ],
            actor: { kind: 'host' },
            human: false,
            at,
            text: `Experiment ${request.experimentId} accepted a trigger on ${request.branch}`,
            meta: { experimentId: request.experimentId, branch: request.branch },
          }
          await trigger.deliver(draft)
          return ok(`trigger:${request.experimentId}:${at}`)
        } catch (error) {
          return failure(messageOf(error))
        }
      },
    },
    executor: {
      async open(request) {
        try {
          const experiment = await experimentOf(request.experimentId)
          if (experiment === undefined) {
            return failure(`experiment ${request.experimentId} does not exist`, 'rejected')
          }
          const ticketId = ticketIdOf(request.experimentId)
          const createdAt = now()
          const ticket = {
            id: ticketId,
            programId: request.programId,
            issueId: request.issueId,
            experimentId: request.experimentId,
            baseCommit: experiment.head,
            createdAt,
            status: 'open',
          }
          await saveTicket(0, ticket)
          return ok(ticketId)
        } catch (error) {
          return failure(messageOf(error))
        }
      },
    },
    sessions: {
      async startWorker(request) {
        try {
          const ticket = await ticketOf(request.ticketId)
          if (ticket === undefined) {
            return failure(`ticket ${request.ticketId} does not exist`, 'rejected')
          }
          const sessionId = await sessions.ensureImplementer(request.ticketId)
          ticketsBySession.set(sessionId, request.ticketId)
          await saveTicket(1, {
            ...ticket,
            status: 'running',
            sessionId,
            startedAt: now(),
          })
          return ok(sessionId)
        } catch (error) {
          return failure(messageOf(error))
        }
      },
      async submitCommit(request) {
        try {
          const ticket = await ticketOf(request.ticketId)
          if (ticket === undefined) {
            return failure(`ticket ${request.ticketId} does not exist`, 'rejected')
          }
          if (ticket.status !== 'submitted') {
            return failure(`ticket ${request.ticketId} has no submitted commit`, 'rejected')
          }
          return ok(ticket.head)
        } catch (error) {
          return failure(messageOf(error))
        }
      },
      async review() {
        return failure('the review decision is supplied by the Researcher command', 'rejected')
      },
    },
    benchmark: {
      async specHash(spec) {
        try {
          if (typeof benchmark?.specHash === 'function') return await benchmark.specHash(spec)
          return ok(digest([spec.id, spec.entry, String(spec.timeoutMs), JSON.stringify(spec.metrics)]))
        } catch (error) {
          return failure(messageOf(error))
        }
      },
      async buildEnvironment(request) {
        try {
          if (typeof benchmark?.buildEnvironment === 'function') {
            return await benchmark.buildEnvironment(request)
          }
          return ok(digest([request.commit, request.environment.kind, request.environment.file]))
        } catch (error) {
          return failure(messageOf(error))
        }
      },
      async run(request) {
        try {
          if (typeof benchmark?.run !== 'function') {
            return failure('no benchmark runner is configured')
          }
          return await benchmark.run(request)
        } catch (error) {
          logger?.warn?.('aleph-research-core: the benchmark runner failed: %s', messageOf(error))
          return failure(messageOf(error))
        }
      },
    },
    clock: {
      now,
    },
    ticketsBySession,
  }
}

export async function createDshCoreRuntime(options) {
  const settings = options ?? {}
  const store = settings.store
  const concepts = createDshCoreConcepts(settings)
  const hooks = {
    async canSubmitCommit(ticketId) {
      const ticket = await store.tickets.get(ticketId)
      return ticket?.value?.status === 'submitted'
    },
  }
  const loaded = await createCoreRuntime({ concepts, hooks })
  if (!loaded.ok) return loaded
  return { ok: true, value: { runtime: loaded.value, concepts, ticketsBySession: concepts.ticketsBySession } }
}
