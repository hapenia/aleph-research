/**
 * Pure view-model helpers for the research panel.
 *
 * The orchestrator health map has one entry per responsibility; the panel must show
 * the runtime's own state, not "paused" just because an optional Source (such as the
 * disabled GitHub one) is off.
 */

/** Aggregate the prototype's health map into one badge state. */
export function healthState(health) {
  const entries = health && typeof health === 'object' && !Array.isArray(health)
    ? Object.values(health).filter((entry) => entry && typeof entry === 'object')
    : []
  if (entries.length === 0) return { state: 'none', errors: 0 }
  const errors = entries.filter((entry) => entry.state === 'error').length
  const runtime = health.runtime && typeof health.runtime === 'object' ? health.runtime.state : undefined
  let state = typeof runtime === 'string' ? runtime : 'ready'
  if (errors > 0) state = 'error'
  else if (typeof runtime !== 'string') {
    if (entries.some((entry) => entry.state === 'starting')) state = 'starting'
    else if (entries.some((entry) => entry.state === 'paused')) state = 'paused'
  }
  return { state, errors }
}
