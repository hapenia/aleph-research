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
export function admitRequest({ text, confirmed = false, budget = parseBudget(), usage = {}, history = [] } = {}) {
  const { tier, reason } = classifyRequest({ text, history })
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
