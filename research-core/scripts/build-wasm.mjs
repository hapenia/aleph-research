import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const workspaceRoot = path.resolve(packageRoot, '..')
const manifestPath = path.join(workspaceRoot, 'rust-core', 'Cargo.toml')
const wasmPath = path.join(
  workspaceRoot,
  'rust-core',
  'target',
  'wasm32-unknown-unknown',
  'release',
  'aleph_research_core.wasm',
)
const outputPath = path.join(packageRoot, 'src', 'adapter', 'wasm-core.ts')
const check = process.argv.includes('--check')

execFileSync(
  'cargo',
  [
    'build',
    '--locked',
    '--release',
    '--target',
    'wasm32-unknown-unknown',
    '--manifest-path',
    manifestPath,
  ],
  { stdio: 'inherit' },
)

const wasm = readFileSync(wasmPath)
const base64 = wasm.toString('base64')
const source = `export const WASM_CORE_BASE64 = '${base64}'\n`

if (check) {
  const current = readFileSync(outputPath, 'utf8')
  if (current !== source) {
    console.error(`wasm-core: ${outputPath} is stale; run npm run build:wasm`)
    process.exit(1)
  }
  console.log(`wasm-core: ${wasm.length} bytes, up to date`)
} else {
  writeFileSync(outputPath, source)
  console.log(`wasm-core: wrote ${wasm.length} bytes (${base64.length} base64 characters)`)
}
