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
import { promisify } from 'node:util'
import { z } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { evaluateSubmission } from './evaluation.js'
import { createResearchChannel } from './research-channel.js'
import { findTicketForDirectory, resultTrigger } from './submit-result.js'

export const name = 'dsh-aleph-superagent'
export const inject = ['orchestrator', 'tools', 'sessions', 'agentPresets']

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

  /** Whether this Agent runs the prototype's Worker preset. */
  const isWorker = (agent) => {
    const session = ctx.sessions?.get?.(agent?.id)
    const preset = session ? ctx.agentPresets?.presetForSession?.(session) : undefined
    return preset === 'dsh-superagent-worker'
  }

  const sourceContext = () => ctx.orchestrator.context(alephKind)

  ctx.tools.register(defineTool({
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
      if (!isWorker(agent)) return { ok: false, error: 'aleph_submit_result is only available to a Worker session' }
      const cwd = agent?.session?.header?.cwd
      if (!cwd) return { ok: false, error: 'the Worker session has no working directory' }

      const source = sourceContext()
      const config = source.config('aleph') ?? {}
      const project = String(config.project ?? 'default')
      const ticket = findTicketForDirectory(source.tickets.open(), cwd)
      if (!ticket) return { ok: false, error: `no open Aleph ticket owns ${cwd}` }

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
      return {
        ok: true,
        ticket: ticket.id,
        thread: trigger.threads[0].id,
        score: evaluation.score,
        exitCode: evaluation.exitCode,
        timedOut: evaluation.timedOut,
        commit,
        evaluationMarker: evaluation.marker,
        trigger: received,
        stdoutTail: evaluation.stdout.trim().split(/\r?\n/).slice(-8),
      }
    },
  }))

  ctx.logger.info('dsh-aleph-superagent ready: aleph Source registered')
}
