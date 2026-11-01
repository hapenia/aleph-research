/**
 * AlephResearch extension for dsh-superagent.
 *
 * The prototype owns the Engine, the Tickets and the Executor; this plugin adds the
 * research side. Phase 1 registers the `aleph` Source kind and a small management
 * API used to ingest a local research trigger, so a research request can enter the
 * same domain as GitHub or Feishu events without a remote service.
 */
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { promisify } from 'node:util'
import { z } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { evaluateSubmission } from './evaluation.js'
import { createResearchChannel } from './research-channel.js'
import { admitRequest, admissionText } from './admission.js'
import { parseBudget } from './budget.js'
import { ConfigStore } from './config-store.js'
import { findStalledTickets, summarizeTickets, watchdogBrief } from './watchdog.js'
import { retryTicket, stopTicket } from './watchdog-actions.js'
import { applySourceSettings } from './hot-config.js'
import { bestResult, readResults, recordResult, resultsBrief } from './results.js'
import { findTicketForDirectory, resultTrigger } from './submit-result.js'

/** Reported through /aleph/api/version so a hot reload can be observed. */
export const VERSION = 'research-extension/1'

const disposers = []

/** Keep a registration disposable so a fiber restart can release it before re-registering. */
const keep = (disposer) => {
  if (typeof disposer === 'function') disposers.push(disposer)
  return disposer
}

/** Release timers and other host resources; called when the fiber is disposed. */
export async function dispose() {
  while (disposers.length) {
    try { disposers.pop()() } catch { /* the host is going away */ }
  }
}

/** Where evaluation records live; the lab points this at the run state directory. */
const resultsDir = () => process.env.ALEPH_RESULTS_DIR ?? `${process.cwd()}/.aleph-results`

/** Versioned research configuration; changes are applied to the live Source. */
const configStore = () => new ConfigStore({
  dir: process.env.ALEPH_CONFIG_DIR ?? `${process.cwd()}/.aleph-config`,
  validate: (value) => { AlephConfigSchema.parse(value) },
})

/** Prototype management API root, used to apply configuration changes without a restart. */
const managementBase = () => process.env.ALEPH_MANAGEMENT_API ?? ''

/** Budget-tiered admission: cheap research auto-accepts, expensive work needs a person. */
const budgetStore = () => new ConfigStore({
  dir: process.env.ALEPH_CONFIG_DIR ?? `${process.cwd()}/.aleph-config`,
  name: 'aleph-budget',
  validate: (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('budget must be an object')
  },
})

/** Requests accepted (evaluated) in the last hour, used by the hourly cap. */
const autoAcceptedLastHour = async () => {
  const cutoff = Date.now() - 60 * 60 * 1000
  const records = await readResults(resultsDir())
  return records.filter((record) => {
    const at = Date.parse(record?.at ?? '')
    return Number.isFinite(at) && at >= cutoff && Number.isFinite(record?.score)
  }).length
}

/** Source configuration: one research project per Source instance. */
const AlephConfigSchema = z.object({
  project: z.string().trim().min(1).default('default'),
  /** Git repository that holds the research branches and worktrees. */
  repository: z.string().trim().default(''),
  /** Branch every ticket worktree starts from. */
  templateBranch: z.string().trim().min(1).default('main'),
  /** Directory whose contents are the data a Worker may read. */
  dataDir: z.string().trim().default(''),
  /** Interpreter with the project runtime installed. */
  python: z.string().trim().default(''),
  /** Submission contract and data notes, written into each ticket. */
  conventions: z.string().trim().default(''),
  /** Command that prints the score JSON; run by the Worker's result submission. */
  evalCommand: z.string().trim().default(''),
  /** Evaluation timeout in milliseconds. */
  evalTimeoutMs: z.number().int().default(600000),
}).strict()

/** The `aleph` Source kind: local research threads and triggers. */
export const alephKind = {
  kind: 'aleph',
  title: { zh: 'Aleph 研究', en: 'Aleph research' },
  description: {
    zh: '接收本地研究请求，把评测结果与探索节奏作为触发器送进 Realm。',
    en: 'Receives local research requests and feeds evaluation results and exploration ticks into the domain.',
  },
  schema: AlephConfigSchema,
  fields: [
    { key: 'project', type: 'text', label: { zh: '项目标识', en: 'Project id' },
      hint: { zh: '同一个项目里的线程共享此前缀。', en: 'Threads of one project share this prefix.' } },
    { key: 'repository', type: 'text', label: { zh: '研究仓库路径', en: 'Research repository path' },
      hint: { zh: '每个工单从这里的一个模板分支创建 worktree。', en: 'Each ticket creates a worktree from the template branch of this repository.' } },
    { key: 'templateBranch', type: 'text', label: { zh: '模板分支', en: 'Template branch' } },
    { key: 'dataDir', type: 'text', label: { zh: '可提供的数据目录', en: 'Data directory to provide' },
      hint: { zh: '只把这一目录放进工单；其他路径不提供。', en: 'Only this directory is placed in a ticket; no other path is provided.' } },
    { key: 'python', type: 'text', label: { zh: '运行时解释器', en: 'Runtime interpreter' } },
    { key: 'conventions', type: 'text', label: { zh: '项目约定', en: 'Project conventions' },
      hint: { zh: '提交契约、数据格式与评测口径。', en: 'Submission contract, data format and scoring notes.' } },
    { key: 'evalCommand', type: 'text', label: { zh: '评测命令', en: 'Evaluation command' },
      hint: { zh: '在工单目录运行，打印含 score 的 JSON 行。', en: 'Run in the ticket directory; prints a JSON line carrying score.' } },
  ],
  environment: {
    variables: [
      { key: 'ALEPH_RESEARCH_REPO', description: { zh: '研究仓库；工单 worktree 从模板分支创建。', en: 'Research repository; the ticket worktree starts from its template branch.' } },
      { key: 'ALEPH_TEMPLATE_BRANCH', description: { zh: 'worktree 的起始分支。', en: 'Branch the ticket worktree starts from.' } },
      { key: 'ALEPH_DATA_DIR', description: { zh: '只应提供给工单的数据目录。', en: 'The only data directory a ticket should receive.' } },
      { key: 'ALEPH_PYTHON', description: { zh: '项目运行时解释器。', en: 'Project runtime interpreter.' } },
      { key: 'ALEPH_CONVENTIONS', description: { zh: '项目约定文件的内容。', en: 'Project conventions text.' } },
    ],
    values: ({ config }) => ({
      ALEPH_RESEARCH_REPO: config.repository ?? '',
      ALEPH_TEMPLATE_BRANCH: config.templateBranch ?? 'main',
      ALEPH_DATA_DIR: config.dataDir ?? '',
      ALEPH_PYTHON: config.python ?? '',
      ALEPH_CONVENTIONS: config.conventions ?? '',
    }),
  },
  health: ['aleph'],
  channel: createResearchChannel({
    dir: process.env.ALEPH_CHANNEL_DIR ?? `${process.cwd()}/.aleph-channel`,
  }),
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/), name: z.string().optional() }).strict())
        .default([{ id: 'operator', name: 'operator' }]),
    }).strict(),
    fields: [
      {
        key: 'allowed',
        type: 'rows',
        label: { zh: '能发起研究工作的操作者', en: 'Operators who may originate research work' },
        columns: [{ key: 'id', type: 'text', label: { zh: '操作者', en: 'Operator' }, pattern: '[A-Za-z0-9_.-]+' }],
      },
    ],
    explicit: {
      zh: '名单里的操作者通过本地研究接口提出的请求。',
      en: 'A request those operators make through the local research endpoint.',
    },
  },
}

/** Thread ids belong to one project and one ticket chain. */
const threadId = (project, ticket) => `research:${project}:ticket:${ticket || 'main'}`

/** Build the Trigger of one local research request. Ids are stable per request id. */
export function alephTrigger({ project, ticket = 'main', requestId, text, actor = 'operator', kind = 'request', score = null }) {
  const thread = threadId(project, ticket)
  const id = `aleph:${kind}:${requestId}`
  return {
    id,
    source: 'aleph',
    threads: [{ source: 'aleph', id: thread }],
    actor: { source: 'aleph', id: actor },
    human: true,
    addressed: 'mention',
    at: new Date().toISOString(),
    text,
    channel: { source: 'aleph', thread: `aleph:${thread}`, address: { project, ticket } },
    meta: { project, ticket, kind, ...(score === null ? {} : { score }) },
  }
}

const TriggerBody = z.object({
  project: z.string().trim().min(1),
  ticket: z.string().trim().min(1).default('main'),
  requestId: z.string().trim().min(1).optional(),
  text: z.string().trim().min(1),
  actor: z.string().trim().min(1).default('operator'),
  kind: z.enum(['request', 'result', 'timer', 'note']).default('request'),
  score: z.number().nullable().optional(),
  /** The operator already confirmed work the budget gate would otherwise hold. */
  confirmed: z.boolean().optional(),
}).strict()

const readBody = async (req) => {
  let body = ''
  for await (const chunk of req) body += chunk
  if (body.length > 256 * 1024) throw new Error('request body is too large')
  return body ? JSON.parse(body) : {}
}

const sendJson = (res, status, value) => {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(value))
}

export function apply(ctx) {
  ctx.effect(() => ctx.orchestrator.sources.register(alephKind), 'aleph: source kind')
  const source = ctx.orchestrator.context(alephKind)
  source.report('aleph', { state: 'ready', detail: 'Local research requests are accepted', at: new Date().toISOString() })

  // The management API: a research request or an evaluation result enters the domain
  // exactly as a Source event would, so Eval, Tickets and Subscriptions work unchanged.
  ctx.inject(['webServer'], (child) => {
    keep(child.webServer.register({
      kind: 'exact',
      path: '/aleph/api/version',
      async handler(req, res) {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false })
        return sendJson(res, 200, {
          ok: true,
          version: VERSION,
          applied: globalThis.__alephExtensionApplied ?? null,
          reload: globalThis.__alephLastReload ?? null,
        })
      },
    }))
    keep(child.webServer.register({
      kind: 'exact',
      path: '/aleph/api/budget',
      async handler(req, res) {
        try {
          const store = budgetStore()
          if (req.method === 'GET') {
            const current = store.current()
            return sendJson(res, 200, {
              ok: true,
              current,
              effective: parseBudget(current.value ?? {}),
              usage: { autoAcceptedLastHour: await autoAcceptedLastHour() },
            })
          }
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false })
          const body = await readBody(req)
          const saved = store.save(body?.value, { origin: body?.origin ?? 'panel' })
          return sendJson(res, 200, { ok: true, current: saved })
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }))
    keep(child.webServer.register({
      kind: 'exact',
      path: '/aleph/api/trigger',
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false })
        try {
          const body = await readBody(req)
          const input = TriggerBody.parse(body)
          const budget = parseBudget(budgetStore().current().value ?? {})
          const admission = admitRequest({
            text: input.text,
            confirmed: body?.confirmed === true,
            budget,
            usage: { autoAcceptedLastHour: await autoAcceptedLastHour() },
          })
          if (!admission.accepted) {
            return sendJson(res, 202, {
              ok: true,
              accepted: false,
              admission,
              message: admissionText(admission),
            })
          }
          const requestId = input.requestId ?? randomUUID()
          const trigger = alephTrigger({ ...input, requestId })
          const result = await ctx.orchestrator.context(alephKind).receive(trigger)
          return sendJson(res, 200, { ok: true, accepted: true, admission, trigger: trigger.id, thread: trigger.threads[0].id, result })
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }))
    keep(child.webServer.register({
      kind: 'exact',
      path: '/aleph/api/results',
      async handler(req, res) {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false })
        try {
          const records = await readResults(resultsDir())
          const project = new URL(req.url ?? '/', 'http://localhost').searchParams.get('project') ?? undefined
          const filter = project ? { project } : {}
          const best = bestResult(records, filter)
          return sendJson(res, 200, {
            ok: true,
            count: records.length,
            best,
            brief: resultsBrief(records, filter),
            recent: records.slice(-20),
          })
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }))
    // Research configuration with versions, an audit trail and rollback. A save is
    // applied to the running Source through the prototype's own settings API, so the
    // change is hot; the versioned store keeps what changed and lets the panel undo it.
    keep(child.webServer.register({
      kind: 'exact',
      path: '/aleph/api/config',
      async handler(req, res) {
        try {
          const store = configStore()
          if (req.method === 'GET') {
            return sendJson(res, 200, { ok: true, current: store.current(), history: store.history(), changes: store.changes() })
          }
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false })
          const body = await readBody(req)
          const saved = store.save(body?.value, { origin: body?.origin ?? 'panel' })
          const base = managementBase()
          const applied = base ? await applySourceSettings(base, 'aleph', saved.value) : null
          return sendJson(res, 200, { ok: true, current: saved, applied })
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }))
    keep(child.webServer.register({
      kind: 'exact',
      path: '/aleph/api/config/rollback',
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false })
        try {
          const body = await readBody(req)
          const store = configStore()
          const saved = body?.revision === undefined
            ? store.rollbackLast({ origin: body?.origin ?? 'panel' })
            : store.restore(Number(body.revision), { origin: body?.origin ?? 'panel' })
          const base = managementBase()
          const applied = base ? await applySourceSettings(base, 'aleph', saved.value) : null
          return sendJson(res, 200, { ok: true, current: saved, applied })
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }))
    // The panel's "reload research extension": answer first, then restart the plugin
    // fiber so the Source kind, routes and settings are registered from scratch. Module
    // code that changed on disk still needs a host restart; configuration and route
    // registration are hot.
    keep(child.webServer.register({
      kind: 'exact',
      path: '/aleph/api/reload',
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false })
        const at = new Date().toISOString()
        sendJson(res, 200, { ok: true, reloaded: true, at })
        setTimeout(() => {
          const state = { attemptedAt: new Date().toISOString(), kind: typeof ctx.fiber?.restart }
          globalThis.__alephLastReload = state
          Promise.resolve(ctx.fiber?.restart?.()).then(() => {
            globalThis.__alephLastReload = { ...state, ok: true, doneAt: new Date().toISOString() }
          }).catch((error) => {
            globalThis.__alephLastReload = { ...state, ok: false, error: String(error?.message ?? error) }
            ctx.logger.warn('dsh-aleph-superagent reload failed: %s', String(error?.message ?? error))
          })
        }, 50)
      },
    }))
    keep(child.webServer.register({
      kind: 'exact',
      path: '/aleph/api/state',
      async handler(req, res) {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false })
        try {
          const tickets = ctx.orchestrator.context(alephKind).tickets.open()
          return sendJson(res, 200, { ok: true, openTickets: tickets.length, tickets: tickets.slice(0, 20) })
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }))
  })

  const sourceContext = () => ctx.orchestrator.context(alephKind)

  keep(ctx.tools.register(defineTool({
    name: 'aleph_submit_result',
    description: 'Run the project evaluation on this ticket directory and report the score back into the domain. Commit first; uncommitted changes are refused.',
    parameters: {
      summary: { type: 'string', description: 'One line describing what you changed and what you measured.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async (args, exec) => {
      const agent = exec?.agent
      const cwd = agent?.session?.header?.cwd
      if (!cwd) return { ok: false, error: 'the Worker session has no working directory' }

      const source = sourceContext()
      const config = source.config('aleph') ?? {}
      const project = String(config.project ?? 'default')
      // The ticket directory is the authorization: only an open ticket's Worker runs
      // there, so a preset lookup (unreliable before the first turn) is unnecessary.
      const ticket = findTicketForDirectory(source.tickets.open(), cwd)
      if (!ticket) return { ok: false, error: `aleph_submit_result is only available inside an open ticket worktree; nothing owns ${cwd}` }

      const git = promisify(execFile)
      let status = ''
      try {
        status = (await git('git', ['-C', cwd, 'status', '--porcelain'])).stdout.trim()
      } catch (error) {
        return { ok: false, error: `git status failed: ${String(error?.message ?? error)}` }
      }
      if (status) {
        return { ok: false, error: 'uncommitted changes: commit the ticket work before submitting the result', details: status.split(/\r?\n/).slice(0, 20) }
      }
      const commit = (await git('git', ['-C', cwd, 'rev-parse', 'HEAD'])).stdout.trim()

      const command = String(config.evalCommand ?? '')
      if (!command) return { ok: false, error: 'the aleph Source has no evalCommand configured' }
      const evaluation = await evaluateSubmission({
        command,
        cwd,
        python: String(config.python ?? ''),
        timeoutMs: Number(config.evalTimeoutMs) || 600000,
        env: { ALEPH_PROJECT: project, ALEPH_TICKET: ticket.id, ALEPH_SOLUTION_DIR: cwd, ALEPH_COMMIT: commit },
      })

      const trigger = resultTrigger({
        project,
        ticket,
        score: evaluation.score,
        evaluationId: evaluation.marker,
        text: [`Evaluation finished: ${evaluation.score ?? 'no score'}.`, `Commit: ${commit}.`, args?.summary ?? ''].join(' ').trim(),
      })
      const received = await source.receive(trigger)
      const record = await recordResult(resultsDir(), {
        evaluationId: evaluation.marker,
        project,
        ticketId: ticket.id,
        thread: trigger.threads[0].id,
        score: evaluation.score,
        commit,
        at: new Date().toISOString(),
      })
      const history = await readResults(resultsDir())
      const best = bestResult(history, { project })
      return {
        ok: true,
        ticket: ticket.id,
        thread: trigger.threads[0].id,
        score: evaluation.score,
        best: best?.score ?? evaluation.score,
        bestCommit: best?.commit ?? commit,
        evaluated: record.evaluationId,
        exitCode: evaluation.exitCode,
        timedOut: evaluation.timedOut,
        commit,
        evaluationMarker: evaluation.marker,
        trigger: received,
        stdoutTail: evaluation.stdout.trim().split(/\r?\n/).slice(-8),
      }
    },
  })))

  const isWatchdog = (agent) => agent?.session?.header?.agentPreset === 'aleph-watchdog'
  const openTickets = () => sourceContext().tickets.open()

  /** Everything a watchdog turn needs: what is open, what is stuck, and the scores. */
  const watchdogState = async () => {
    const tickets = openTickets()
    const stalled = findStalledTickets(tickets)
    const summary = summarizeTickets(tickets)
    const records = await readResults(resultsDir())
    const project = String(sourceContext().config('aleph')?.project ?? 'default')
    return {
      openTickets: tickets.length,
      stalled,
      summary,
      brief: watchdogBrief({ stalled, summary }),
      scores: resultsBrief(records, { project }),
    }
  }

  keep(ctx.tools.register(defineTool({
    name: 'aleph_watchdog_brief',
    description: 'Read the current open tickets, stalled tickets and evaluation scores. Only the Watchdog session may call it.',
    parameters: {},
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    execute: async (_args, exec) => {
      if (!isWatchdog(exec?.agent)) return { ok: false, error: 'aleph_watchdog_brief is only available to the Watchdog session' }
      return { ok: true, ...(await watchdogState()) }
    },
  })))

  const ticketTool = (name, description, action) => defineTool({
    name,
    description,
    parameters: {
      ticketId: { type: 'string', description: 'The Ticket id from the brief.', required: true },
      reason: { type: 'string', description: 'One line on why this action is needed.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    execute: async (args, exec) => {
      if (!isWatchdog(exec?.agent)) return { ok: false, error: `${name} is only available to the Watchdog session` }
      const base = managementBase()
      if (!base) return { ok: false, error: 'no management API is configured (ALEPH_MANAGEMENT_API)' }
      try {
        const answer = action(base, args?.ticketId)
        return { ok: true, ticketId: args?.ticketId, reason: args?.reason ?? null, answer: await answer }
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
    },
  })
  keep(ctx.tools.register(ticketTool('aleph_watchdog_stop', 'Stop a stalled ticket. Only the Watchdog session may call it.', stopTicket)))
  keep(ctx.tools.register(ticketTool('aleph_watchdog_retry', 'Retry a stalled ticket. Only the Watchdog session may call it.', retryTicket)))

  const watchdogStatus = { enabled: false, intervalMs: 0, sessionId: null, lastTickAt: null, lastError: null, lastBriefAt: null }
  {
    ctx.inject(['webServer'], (child) => {
      keep(child.webServer.register({
        kind: 'exact',
        path: '/aleph/api/watchdog/status',
        async handler(req, res) {
          if (req.method !== 'GET') return sendJson(res, 405, { ok: false })
          return sendJson(res, 200, { ok: true, ...watchdogStatus })
        },
      }))
    })
  }

  // The resident Watchdog: one DSH session that receives a brief on an interval and
  // acts through the tools above. Disabled unless ALEPH_WATCHDOG_INTERVAL_MS is set,
  // so a composition without a watchdog deployment never grows an extra session.
  const watchdogInterval = Number(process.env.ALEPH_WATCHDOG_INTERVAL_MS ?? 0)
  if (Number.isFinite(watchdogInterval) && watchdogInterval >= 1000) {
    const watchdogDir = process.env.ALEPH_WATCHDOG_DIR ?? `${process.cwd()}/.aleph-watchdog`
    const watchdogSessionId = `aleph-watchdog-${Buffer.from(watchdogDir).toString('hex').slice(0, 16)}`
    Object.assign(watchdogStatus, { enabled: true, intervalMs: watchdogInterval, sessionId: watchdogSessionId })
    let ticking = false
    // A Watchdog that wakes the model for an unchanged, empty state just burns tokens:
    // wake it when something is stalled, or when the state signature changed since the
    // last brief.
    let lastSignature = null

    const ensureSession = async () => {
      let resolved = await ctx.sessionController.resolveAgent(watchdogSessionId)
      if ('error' in resolved && resolved.error?.code === 'session/not-found') {
        // The workspace registry resolves a real path, so the directory must exist first.
        await mkdir(watchdogDir, { recursive: true })
        const workspace = await ctx.workspaceRegistry.create(watchdogDir)
        await ctx.sessionController.create({ sessionId: watchdogSessionId, workspaceId: workspace.id, agentPreset: 'aleph-watchdog' })
        resolved = await ctx.sessionController.resolveAgent(watchdogSessionId)
      }
      if ('error' in resolved) throw resolved.error
      return resolved.agent
    }

    let tickCount = 0
    const tick = async () => {
      watchdogStatus.tickCount = (watchdogStatus.tickCount ?? 0) + 1
      watchdogStatus.enteredAt = new Date().toISOString()
      if (ticking) return
      ticking = true
      tickCount += 1
      watchdogStatus.startedTicks = tickCount
      try {
        await sourceContext().ready
        const agent = await ensureSession()
        watchdogStatus.lastTickAt = new Date().toISOString()
        watchdogStatus.lastError = null
        if (agent.status === 'running' || agent.status === 'starting') return
        const state = await watchdogState()
        const signature = JSON.stringify([state.stalled.map((entry) => entry.ticketId), state.openTickets, state.scores.length])
        if (signature === lastSignature && state.stalled.length === 0) {
          watchdogStatus.lastSkippedAt = new Date().toISOString()
          return
        }
        lastSignature = signature
        watchdogStatus.lastBriefAt = new Date().toISOString()
        agent.followup({
          id: `watchdog-${Date.now()}`,
          role: 'user',
          content: [{ type: 'text', text: [`Watchdog brief (${new Date().toISOString()}).`, '', state.brief, '', state.scores].join('\n') }],
          source: { kind: 'aleph-watchdog' },
        })
      } catch (error) {
        watchdogStatus.lastError = String(error?.message ?? error)
        ctx.logger.warn('dsh-aleph-superagent watchdog tick failed: %s', watchdogStatus.lastError)
      } finally {
        ticking = false
      }
    }

    // A recursive timeout keeps one wake-up in flight at a time and avoids timers
    // that a long model turn would pile up behind. The timer lives as long as the
    // plugin fiber; the host process ends it.
    let timer = null
    const schedule = () => {
      timer = setTimeout(async () => {
        await tick()
        schedule()
      }, watchdogInterval)
      timer.unref?.()
    }
    disposers.push(() => { if (timer) clearTimeout(timer) })
    tick().finally(schedule)
  }

  ctx.logger.info('dsh-aleph-superagent ready: aleph Source registered')
}
