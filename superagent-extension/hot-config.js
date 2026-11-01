/**
 * Hot research configuration: versioned settings that are applied to the running
 * prototype without a host restart.
 *
 * The protoSettings file is the only source of truth for the live Source; the
 * ConfigStore keeps the research-owned history and is what the panel edits. Applying
 * a version means merging it into the Source's settings block through the
 * management API, which the prototype treats as a hot change.
 */

/** Merge a research configuration into one Source's current settings entry. */
export function sourceSettingsValue(current, config) {
  const entry = current && typeof current === 'object' ? current : {}
  const existing = entry.config && typeof entry.config === 'object' && !Array.isArray(entry.config) ? entry.config : {}
  return { enabled: entry.enabled !== false, config: { ...existing, ...(config ?? {}) } }
}

/**
 * Apply a research configuration to the running prototype by PUTting the Source's
 * settings block. Returns the prototype's answer (`saved`, `revision`, …).
 *
 * `baseUrl` is the prototype management API root, such as
 * `http://127.0.0.1:40202/orchestrator/api`; the caller reads it from the deployment.
 */
export async function applySourceSettings(baseUrl, kind, config, { fetchImpl = fetch } = {}) {
  const list = await (await fetchImpl(`${baseUrl}/settings`, { headers: { 'x-orchestrator-request': '1' } })).json()
  const source = (list.sources ?? []).find((entry) => entry.id === kind)
  if (!source) throw new Error(`the prototype has no ${kind} Source to configure`)
  const body = { value: sourceSettingsValue(source.value, config), revision: source.revision }
  const response = await fetchImpl(`${baseUrl}/settings/source:${kind}`, {
    method: 'PUT',
    headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const answer = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(answer.error ?? `settings update failed with ${response.status}`)
  return answer
}
