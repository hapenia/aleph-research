/**
 * Budget-tiered acceptance for Aleph research requests.
 *
 * Acceptance is currently all-or-nothing (`eval.mode = auto`). The migration to
 * budget-tiered acceptance wants cheap, well-scoped research work to be accepted
 * automatically and expensive or ambiguous work to become an issue for a person
 * instead of starting a Worker. This module holds that policy: it classifies a
 * request into a cost tier and turns the tier plus the configured budget and the
 * recent usage counters into an acceptance decision.
 *
 * Everything here is pure and deterministic; the caller supplies the text, the
 * ticket history and the usage counters. `classifyRequest` only reads the clock
 * to bound "the last 24 hours" and accepts an explicit `now` for reproducibility.
 */

export const TIERS = ['explore', 'analysis', 'training', 'design']

const HOUR_MS = 60 * 60 * 1000
const HISTORY_WINDOW_MS = 24 * HOUR_MS
const DEFAULT_AUTO_TIERS = ['explore', 'analysis']
const DEFAULT_ATTENTION_TIERS = ['training', 'design']

// Most expensive tier first: a request that mentions a GPU sweep and an API
// surface is still a training request. Design outranks analysis so that an
// ambiguous "analyse the API" becomes an issue rather than an automatic Worker.
const TIER_KEYWORDS = [
  [
    'training',
    [
      'train', 'trains', 'trained', 'training',
      'sweep', 'sweeps', 'swept', 'sweeping',
      'hyperparameter', 'hyperparameters',
      'gpu', 'gpus',
      'finetune', 'finetunes', 'finetuned', 'finetuning',
      'fine-tune', 'fine-tunes', 'fine-tuned', 'fine-tuning',
    ],
  ],
  [
    'design',
    [
      'design', 'designs', 'designed', 'designing',
      'spec', 'specs', 'specification', 'specifications',
      'architecture', 'architectures',
      'api', 'apis',
      'proposal', 'proposals',
    ],
  ],
  [
    'analysis',
    [
      'profile', 'profiles', 'profiled', 'profiling',
      'measure', 'measures', 'measured', 'measuring', 'measurement', 'measurements',
      'count', 'counts', 'counted', 'counting',
      'visualise', 'visualises', 'visualised', 'visualising',
      'visualize', 'visualizes', 'visualized', 'visualizing',
      'visualisation', 'visualization',
      'analyse', 'analyses', 'analysed', 'analysing',
      'analyze', 'analyzes', 'analyzed', 'analyzing',
      'analysis',
    ],
  ],
]

const TIER_PATTERNS = TIER_KEYWORDS.map(([tier, keywords]) => [
  tier,
  new RegExp(`\\b(?:${keywords.join('|')})\\b`),
])

/**
 * Normalize a raw budget settings object.
 *
 * Unknown fields are ignored, missing or malformed fields fall back to the
 * defaults, and tier names are trimmed, lowercased and filtered to `TIERS`.
 * An explicitly provided list is kept even when it sanitizes down to nothing
 * (that is a deliberate policy), while a non-array falls back to the default.
 *
 * @param {unknown} raw
 * @returns {{ autoTiers: string[], attentionTiers: string[], maxAutoPerHour: number | null }}
 */
export function parseBudget(raw) {
  const settings = isRecord(raw) ? raw : {}
  return {
    autoTiers: normalizeTiers(settings.autoTiers, DEFAULT_AUTO_TIERS),
    attentionTiers: normalizeTiers(settings.attentionTiers, DEFAULT_ATTENTION_TIERS),
    maxAutoPerHour: normalizeHourlyCap(settings.maxAutoPerHour),
  }
}

/**
 * Classify a request from its text plus the optional ticket history.
 *
 * Text is trimmed and lowercased, then matched against the tier keyword sets in
 * `TIER_KEYWORDS` order. A history entry is `{ tier, at }`, where `at` may be a
 * `Date`, an epoch-millisecond number or a date string (or be named `createdAt`,
 * `timestamp` or `updatedAt`); entries without a usable timestamp are ignored.
 * When at least two tickets of the classified tier fall inside the last 24
 * hours, the reason says so, which lets the policy layer surface tier pressure.
 *
 * `now` is the clock used for that 24-hour window (a `Date`, an
 * epoch-millisecond number or a date string); it defaults to the current clock,
 * so pass it when the wiring layer needs a reproducible classification.
 *
 * @param {{ text?: string, history?: object[], now?: Date | number | string }} options
 * @returns {{ tier: string, reason: string }}
 */
export function classifyRequest(options = {}) {
  const { text, history = [], now } = isRecord(options) ? options : {}
  const normalizedText = typeof text === 'string' ? text.trim().toLowerCase() : ''

  let tier = 'explore'
  let reason = 'no tier keywords matched'
  for (const [candidate, pattern] of TIER_PATTERNS) {
    const match = pattern.exec(normalizedText)
    if (match) {
      tier = candidate
      reason = `matched ${candidate} keyword "${match[0]}"`
      break
    }
  }

  const recent = countRecentTier(Array.isArray(history) ? history : [], tier, normalizeNow(now))
  if (recent >= 2) reason += `; ${recent} ${tier} tickets in the last 24h`

  return { tier, reason }
}

/**
 * Decide whether a request may be accepted automatically or needs a person.
 *
 * The hourly cap is a gate on automatic acceptance: while
 * `usage.autoAcceptedLastHour` is at or above `budget.maxAutoPerHour`, every
 * request becomes an issue with reason `hourly budget exhausted`. A tier that
 * is neither configured for automatic nor for attention acceptance is not
 * accepted automatically. Malformed usage counters count as zero.
 *
 * @param {unknown} options
 * @returns {{ decision: 'auto' | 'attention', tier: string | null, reason: string, escalate: boolean }}
 */
export function decideAcceptance(options = {}) {
  const { tier: rawTier, usage = {}, budget = parseBudget() } = isRecord(options) ? options : {}
  const tier = normalizeTier(rawTier)
  const normalizedBudget = parseBudget(budget)
  const usageCounters = isRecord(usage) ? usage : {}
  const autoAccepted = normalizeUsageCounter(usageCounters.autoAcceptedLastHour)
  const hourlyBudgetExhausted =
    normalizedBudget.maxAutoPerHour !== null && autoAccepted >= normalizedBudget.maxAutoPerHour

  if (tier === null || !TIERS.includes(tier)) {
    return { decision: 'attention', tier, reason: 'unknown tier', escalate: true }
  }
  if (hourlyBudgetExhausted) {
    return { decision: 'attention', tier, reason: 'hourly budget exhausted', escalate: true }
  }
  if (normalizedBudget.autoTiers.includes(tier)) {
    return { decision: 'auto', tier, reason: `tier "${tier}" is auto-accepted`, escalate: false }
  }
  if (normalizedBudget.attentionTiers.includes(tier)) {
    return { decision: 'attention', tier, reason: `tier "${tier}" requires attention`, escalate: true }
  }
  return { decision: 'attention', tier, reason: `tier "${tier}" is not auto-accepted`, escalate: true }
}

/** Whether `value` is a plain object (not null, not an array). */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Trim and lowercase a tier name; `null` for anything that is not a string. */
function normalizeTier(value) {
  if (typeof value !== 'string') return null
  const tier = value.trim().toLowerCase()
  return tier.length === 0 ? null : tier
}

/** Sanitize a configured tier list; a non-array means "use the default". */
function normalizeTiers(value, fallback) {
  if (!Array.isArray(value)) return [...fallback]
  const tiers = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const tier = entry.trim().toLowerCase()
    if (!TIERS.includes(tier) || tiers.includes(tier)) continue
    tiers.push(tier)
  }
  return tiers
}

/** Accept a non-negative finite number of requests per hour; otherwise no cap. */
function normalizeHourlyCap(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.floor(value)
}

/** Malformed or negative usage counters count as zero accepted requests. */
function normalizeUsageCounter(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

/** Turn `now` into epoch milliseconds, falling back to the current clock. */
function normalizeNow(value) {
  const timestamp = timestampOf(value)
  return timestamp === null ? Date.now() : timestamp
}

/** Read a timestamp from a `Date`, an epoch-millisecond number or a date string. */
function timestampOf(value) {
  if (value instanceof Date) {
    const timestamp = value.getTime()
    return Number.isFinite(timestamp) ? timestamp : null
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) ? timestamp : null
  }
  return null
}

/** The timestamp of a history entry, trying the field names used by tickets. */
function ticketTimestamp(ticket) {
  for (const field of ['at', 'createdAt', 'timestamp', 'updatedAt']) {
    if (!(field in ticket)) continue
    const timestamp = timestampOf(ticket[field])
    if (timestamp !== null) return timestamp
  }
  return null
}

/** Count tickets of `tier` that fall inside the 24 hours before `now`. */
function countRecentTier(history, tier, now) {
  let count = 0
  for (const entry of history) {
    if (!isRecord(entry)) continue
    if (normalizeTier(entry.tier) !== tier) continue
    const timestamp = ticketTimestamp(entry)
    if (timestamp === null || timestamp > now || now - timestamp > HISTORY_WINDOW_MS) continue
    count += 1
  }
  return count
}
