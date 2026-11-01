/**
 * AlephResearch extension for dsh-superagent.
 *
 * The prototype owns the Engine, the Tickets and the Executor; this plugin adds the
 * research side. Phase 1 registers the `aleph` Source kind and a small management
 * API used to ingest a local research trigger, so a research request can enter the
 * same domain as GitHub or Feishu events without a remote service.
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

export const name = 'dsh-aleph-superagent'
export const inject = ['orchestrator']

/** Source configuration: one Aleph project per Source instance. */
const AlephConfigSchema = z.object({
  project: z.string().trim().min(1).default('default'),
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
    {
      key: 'project',
      type: 'text',
      label: { zh: '项目标识', en: 'Project id' },
      hint: { zh: '同一个项目里的线程共享此前缀。', en: 'Threads of one project share this prefix.' },
    },
  ],
  health: ['aleph'],
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
    child.webServer.register({
      kind: 'exact',
      path: '/aleph/api/trigger',
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false })
        try {
          const input = TriggerBody.parse(await readBody(req))
          const requestId = input.requestId ?? randomUUID()
          const trigger = alephTrigger({ ...input, requestId })
          const result = await ctx.orchestrator.context(alephKind).receive(trigger)
          return sendJson(res, 200, { ok: true, trigger: trigger.id, thread: trigger.threads[0].id, result })
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      },
    })
    child.webServer.register({
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
    })
  })

  ctx.logger.info('dsh-aleph-superagent ready: aleph Source registered')
}
