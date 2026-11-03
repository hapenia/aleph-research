import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI_VERSION = '0.2.130'
const BUDGET_BYTES = 320 * 1024
const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const workspaceRoot = path.resolve(packageRoot, '..')
const manifestPath = path.join(workspaceRoot, 'rust-core', 'Cargo.toml')
const targetWasm = path.join(
  workspaceRoot,
  'rust-core',
  'target',
  'wasm32-unknown-unknown',
  'release',
  'aleph_research_core.wasm',
)
const generatedDirectory = path.join(packageRoot, 'src', 'adapter', 'wasm-bindgen')
const generatedModule = path.join(generatedDirectory, 'core.js')
const generatedWasm = path.join(generatedDirectory, 'core_bg.wasm')
const wasmCorePath = path.join(packageRoot, 'src', 'adapter', 'wasm-core.ts')
const check = process.argv.includes('--check')

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}

function checkCli() {
  const version = run('wasm-bindgen', ['--version']).trim()
  if (version !== `wasm-bindgen ${CLI_VERSION}`) {
    throw new Error(
      `wasm-bindgen ${CLI_VERSION} is required; found ${version || 'nothing'}`,
    )
  }
}

function runWasmBindgen(directory) {
  rmSync(directory, { recursive: true, force: true })
  mkdirSync(directory, { recursive: true })
  run('wasm-bindgen', [
    '--target',
    'web',
    '--remove-name-section',
    '--out-dir',
    directory,
    '--out-name',
    'core',
    targetWasm,
  ])
}

function generatedFiles(directory) {
  const files = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile()) files.push(path.relative(directory, absolute))
    }
  }
  walk(directory)
  files.sort()
  return files
}

function compareDirectories(expected, actual) {
  const expectedFiles = generatedFiles(expected)
  const actualFiles = generatedFiles(actual)
  if (expectedFiles.join('\n') !== actualFiles.join('\n')) {
    throw new Error(
      `wasm-bindgen file set changed\nbuilt: ${expectedFiles.join(', ')}\ntracked: ${actualFiles.join(', ')}`,
    )
  }
  for (const file of expectedFiles) {
    const built = readFileSync(path.join(expected, file))
    const tracked = readFileSync(path.join(actual, file))
    if (!built.equals(tracked)) {
      throw new Error(`wasm-bindgen output is stale: src/adapter/wasm-bindgen/${file}`)
    }
  }
}

function sourceFor(wasm) {
  const base64 = wasm.toString('base64')
  return `import { decodeBase64 } from './base64.js'
import { initSync } from './wasm-bindgen/core.js'

export const WASM_CORE_BASE64 = '${base64}'

let initialized = false

export function initCore(): void {
  if (initialized) return
  initSync({ module: decodeBase64(WASM_CORE_BASE64) })
  initialized = true
}
`
}

checkCli()
run('cargo', [
  'build',
  '--locked',
  '--release',
  '--target',
  'wasm32-unknown-unknown',
  '--manifest-path',
  manifestPath,
])
if (!existsSync(targetWasm)) {
  throw new Error(`cargo did not produce ${targetWasm}`)
}

if (check) {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'aleph-wasm-'))
  try {
    runWasmBindgen(temporary)
    if (!existsSync(generatedDirectory)) {
      throw new Error('src/adapter/wasm-bindgen is missing; run npm run build:wasm')
    }
    compareDirectories(temporary, generatedDirectory)
    const wasm = readFileSync(path.join(temporary, 'core_bg.wasm'))
    const source = sourceFor(wasm)
    if (readFileSync(wasmCorePath, 'utf8') !== source) {
      throw new Error('src/adapter/wasm-core.ts is stale; run npm run build:wasm')
    }
    if (wasm.length > BUDGET_BYTES) {
      throw new Error(`wasm size ${wasm.length} exceeds the ${BUDGET_BYTES} byte budget`)
    }
    console.log(`wasm: ${wasm.length} bytes, up to date`)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
} else {
  runWasmBindgen(generatedDirectory)
  const wasm = readFileSync(generatedWasm)
  writeFileSync(wasmCorePath, sourceFor(wasm))
  const files = generatedFiles(generatedDirectory)
  if (!files.includes('core.js') || !files.includes('core.d.ts')) {
    throw new Error(`wasm-bindgen produced an unexpected file set: ${files.join(', ')}`)
  }
  console.log(`wasm: wrote ${wasm.length} bytes (${files.length} generated files)`)
  if (wasm.length > BUDGET_BYTES) {
    throw new Error(`wasm size ${wasm.length} exceeds the ${BUDGET_BYTES} byte budget`)
  }
}
