/**
 * Helpers for the Worker-side result submission.
 *
 * The Worker reports that its branch is ready, the Host evaluates the ticket
 * directory, and the score is fed back into the domain as a `result` Trigger on the
 * ticket's own Thread. These pure helpers keep the DSH wiring in `index.js` small and
 * make the trigger shape testable.
 */

/** Thread reference of a ticket, derived from its Channel addresses. */
export function threadOfTicket(ticket) {
  const channel = (ticket?.channels ?? []).find((entry) => entry?.source === 'aleph' && typeof entry.thread === 'string')
  if (!channel) return null
  const prefix = 'aleph:'
  const id = channel.thread.startsWith(prefix) ? channel.thread.slice(prefix.length) : channel.thread
  return { source: 'aleph', id }
}

/** The open ticket whose execution directory is `cwd`. */
export function findTicketForDirectory(tickets, cwd) {
  const wanted = typeof cwd === 'string' ? cwd.replace(/\/+$/, '') : ''
  if (!wanted) return null
  return (tickets ?? []).find((ticket) => {
    const directory = ticket?.execution?.directory
    return typeof directory === 'string' && directory.replace(/\/+$/, '') === wanted
  }) ?? null
}

/** A `result` Trigger carrying the score on the ticket's Thread. */
export function resultTrigger({ project, ticket, score, evaluationId, text, at = new Date().toISOString() }) {
  const thread = threadOfTicket(ticket)
  const requestId = String(evaluationId ?? 'result')
  const body = typeof text === 'string' && text.trim() ? text : `Evaluation finished: ${score ?? 'no score'}`
  const address = (ticket?.channels ?? []).find((entry) => entry?.source === 'aleph')?.address ?? { project, ticket: ticket?.execution?.name ?? 'main' }
  return {
    id: `aleph:result:${requestId}`,
    source: 'aleph',
    threads: [thread ?? { source: 'aleph', id: `research:${project}:ticket:${ticket?.execution?.name ?? 'main'}` }],
    actor: { source: 'aleph', id: 'evaluator' },
    human: false,
    at,
    text: body,
    channel: { source: 'aleph', thread: `aleph:${(thread ?? { id: `research:${project}:ticket:main` }).id}`, address },
    meta: { project, ticket: ticket?.id ?? null, kind: 'result', score: score ?? null, evaluationId },
  }
}
