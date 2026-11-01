/**
 * Budget-tiered admission of new research work.
 *
 * The Host, not a model, decides whether a local research request may start a
 * Worker: cheap tiers auto-accept, expensive or underspecified tiers wait for a
 * person to confirm. The pure decision lives here so the route stays thin and the
 * rule is testable.
 */
import { classifyRequest, decideAcceptance, parseBudget } from './budget.js'

/**
 * @param {{ text: string, confirmed?: boolean, budget?: object, usage?: object, history?: object[] }} input
 * @returns {{ accepted: boolean, auto: boolean, tier: string, confirmationRequired: boolean, reason: string }}
 */
/** A declared GPU or a large CPU/memory request needs a person, whatever the text says. */
export function tierForResources(resources) {
  if (!resources || typeof resources !== 'object') return null
  if (resources.gpu === true) return 'training'
  const cpus = Number(resources.cpu ?? 0)
  const memory = Number(resources.memoryGb ?? 0)
  if (Number.isFinite(cpus) && cpus >= 8) return 'training'
  if (Number.isFinite(memory) && memory >= 64) return 'training'
  return null
}

export function admitRequest({ text, confirmed = false, resources = null, budget = parseBudget(), usage = {}, history = [] } = {}) {
  const classified = classifyRequest({ text, history })
  const resourceTier = tierForResources(resources)
  const tier = resourceTier ?? classified.tier
  const reason = resourceTier
    ? `declared resources ${JSON.stringify(resources)} need a person`
    : classified.reason
  const decision = decideAcceptance({ tier, usage, budget })
  const auto = decision.decision === 'auto'
  const accepted = auto || confirmed === true
  return {
    accepted,
    auto,
    tier,
    confirmationRequired: !accepted,
    reason: accepted
      ? (auto ? reason : `confirmed by a person; ${reason}`)
      : `${decision.reason}; confirm to start it`,
  }
}

/** Human-readable one-liner for the route response and the panel. */
export function admissionText(result) {
  if (result.accepted) return `accepted (${result.tier})${result.auto ? ' automatically' : ' by confirmation'}`
  return `waiting for a person (${result.tier}): ${result.reason}`
}
