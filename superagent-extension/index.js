/**
 * Bootstrap of the AlephResearch extension.
 *
 * The real implementation lives in `research-extension.js`, imported with a fresh
 * cache-busting query on every plugin activation. That is what makes the panel's
 * "reload research extension" action hot: the fiber restarts, this bootstrap
 * re-imports the module from disk, and the new code takes over without a host restart.
 */

export const name = 'dsh-aleph-superagent'
export const inject = ['orchestrator', 'tools', 'sessionController', 'workspaceRegistry']

/** The active implementation module, so a disposed fiber can stop its timers. */
let active = null

export async function apply(ctx, config) {
  if (active?.dispose) await active.dispose()
  const module = await import(`./research-extension.js?reload=${Date.now()}`)
  active = module
  globalThis.__alephExtensionApplied = { at: Date.now(), count: (globalThis.__alephExtensionApplied?.count ?? 0) + 1 }
  ctx.effect(() => () => {
    Promise.resolve(active?.dispose?.()).catch(() => {})
  })
  return module.apply(ctx, config)
}
