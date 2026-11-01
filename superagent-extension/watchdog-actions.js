/**
 * Host actions a Watchdog Session can take on a Ticket.
 *
 * The prototype exposes stop and retry through its management API, which the panel
 * uses too. These helpers build and send those requests with an injectable fetch so
 * the action surface is testable without a running prototype.
 */

/** POST one management action for a ticket; returns the prototype's JSON answer. */
export async function ticketAction(baseUrl, ticketId, action, { fetchImpl = fetch } = {}) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) throw new Error('no management API is configured')
  if (typeof ticketId !== 'string' || ticketId.trim().length === 0) throw new Error('a ticket id is required')
  if (action !== 'stop' && action !== 'retry') throw new Error(`unknown ticket action: ${action}`)
  const url = `${baseUrl.replace(/\/+$/, '')}/tickets/${encodeURIComponent(ticketId)}/${action}`
  const response = await fetchImpl(url, { method: 'POST', headers: { 'x-orchestrator-request': '1' } })
  const answer = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(answer.error ?? `ticket ${action} failed with ${response.status}`)
  return answer
}

/** Stop a Ticket whose Worker is stuck. */
export const stopTicket = (baseUrl, ticketId, options) => ticketAction(baseUrl, ticketId, 'stop', options)

/** Retry a Ticket whose assignment ended without progress. */
export const retryTicket = (baseUrl, ticketId, options) => ticketAction(baseUrl, ticketId, 'retry', options)
