/**
 * The chat-to-request bridge for the routing Session.
 *
 * The prototype gives the main Session routing tools only: a person talking to it in
 * chat has no direct way to start research. This plugin registers one tool that turns
 * such a request into a Trigger on the `aleph` Source, so the normal admission, Eval
 * and routing path applies. It is a separate plugin because the routing Session's tool
 * restriction runs while the prototype starts, and a tool registered later would be
 * rejected as unknown.
 */
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { admitRequest } from './admission.js'
import { alephKind, alephTrigger } from './research-extension.js'
import { parseBudget } from './budget.js'

export const name = 'dsh-aleph-request-tool'
export const inject = ['tools']

export function apply(ctx) {
  const source = () => ctx.get('orchestrator')?.context(alephKind)

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'aleph_request_work',
    description: "Turn a person's research request from chat into a request in the aleph Source. Use it when the operator asks for research or an experiment; the request comes back as a candidate you route.",
    parameters: {
      text: { type: 'string', description: "The request in the person's own words, with the concrete goal.", required: true },
      ticket: { type: 'string', description: 'Optional short ticket name; defaults to chat.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    execute: async (args, exec) => {
      if (exec?.agent?.session?.header?.agentPreset !== 'dsh-superagent-router') {
        return { ok: false, error: 'aleph_request_work is only available to the routing Session' }
      }
      if (typeof args?.text !== 'string' || args.text.trim().length === 0) {
        return { ok: false, error: 'the request text is required' }
      }
      const host = source()
      if (!host) return { ok: false, error: 'the orchestrator is not ready yet' }
      const project = String(host.config('aleph')?.project ?? 'default')
      const admission = admitRequest({ text: args.text, confirmed: true, budget: parseBudget({}), usage: {} })
      if (!admission.accepted) return { ok: false, admission, error: admission.reason }
      const trigger = alephTrigger({
        project,
        ticket: typeof args.ticket === 'string' && args.ticket.trim() ? args.ticket.trim() : 'chat',
        requestId: `chat-${randomUUID()}`,
        text: args.text,
        actor: 'operator',
      })
      const result = await host.receive(trigger)
      return { ok: true, trigger: trigger.id, thread: trigger.threads[0].id, result, admission }
    },
  })), 'aleph: request tool')
}
