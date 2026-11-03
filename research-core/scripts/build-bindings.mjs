import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const workspaceRoot = path.resolve(packageRoot, '..')
const manifestPath = path.join(workspaceRoot, 'rust-core', 'Cargo.toml')
const bindingsDirectory = path.join(packageRoot, 'src', 'adapter', 'bindings')
const check = process.argv.includes('--check')

function filesIn(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort()
}

function generate(directory) {
  execFileSync(
    'cargo',
    ['test', '--locked', '--manifest-path', manifestPath, 'export_bindings'],
    {
      cwd: packageRoot,
      env: { ...process.env, TS_RS_EXPORT_DIR: directory },
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  )
}

if (check) {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'aleph-bindings-'))
  try {
    generate(temporary)
    const expected = filesIn(temporary)
    const actual = filesIn(bindingsDirectory)
    if (expected.join('\n') !== actual.join('\n')) {
      throw new Error(
        `generated binding set changed\nbuilt: ${expected.join(', ')}\ntracked: ${actual.join(', ')}`,
      )
    }
    for (const file of expected) {
      const built = readFileSync(path.join(temporary, file))
      const tracked = readFileSync(path.join(bindingsDirectory, file))
      if (!built.equals(tracked)) {
        throw new Error(`binding is stale: src/adapter/bindings/${file}`)
      }
    }
    console.log(`bindings: ${expected.length} files, up to date`)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
} else {
  generate(bindingsDirectory)
  console.log(`bindings: wrote ${filesIn(bindingsDirectory).length} files`)
}
