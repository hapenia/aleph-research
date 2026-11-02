#!/usr/bin/env node
/** Check TODO(@feature) markers against the completion ledger. */
import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const completionSource = await readFile(join(root, 'src/completion.ts'), 'utf8')
const features = new Set(
  [...completionSource.matchAll(/'([a-z0-9-]+)':\s*'(done|todo)'/g)].map((m) => m[1]),
)
if (features.size === 0) {
  console.error('check-completion: no ledger entries found in src/completion.ts')
  process.exit(1)
}

const scanRoots = [join(root, 'src'), join(root, '..', 'superagent-extension')]
const skip = new Set(['node_modules', 'dist', '.git', 'test'])
const problems = []
const pending = []
const seen = new Set()

async function walk(dir) {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || skip.has(entry.name)) continue
    if (entry.name === 'completion.ts' || entry.name === 'release-gate.ts') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) { await walk(path); continue }
    if (!/\.(js|mjs|ts)$/.test(entry.name)) continue
    const text = await readFile(path, 'utf8')
    for (const match of text.matchAll(/TODO\(@([a-z0-9-]+)\)/g)) {
      const feature = match[1]
      seen.add(feature)
      if (!features.has(feature)) problems.push(`${relative(root, path)}: unknown feature ${feature}`)
    }
    if (/TODO(?!\(@)/.test(text)) problems.push(`${relative(root, path)}: TODO must be TODO(@feature)`)
    if (/FIXME/.test(text)) problems.push(`${relative(root, path)}: use TODO(@feature), not FIXME`)
  }
}
for (const dir of scanRoots) await walk(dir)

for (const feature of features) {
  const state = completionSource.match(new RegExp(`'${feature}':\\s*'(done|todo)'`))?.[1]
  if (state === 'todo') {
    pending.push(feature)
    if (!seen.has(feature)) problems.push(`pending feature ${feature} has no TODO(@${feature}) marker`)
  }
}

if (problems.length) {
  console.error('check-completion: failed')
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
console.log(`check-completion: ${pending.length} pending feature(s): ${pending.join(', ') || 'none'}`)
