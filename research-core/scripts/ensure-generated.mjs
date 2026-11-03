import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const required = [
  'src/adapter/wasm-bindgen/core.js',
  'src/adapter/wasm-bindgen/core.d.ts',
  'src/adapter/wasm-core.ts',
  'src/adapter/bindings/CoreFrame.ts',
]

const missing = required.filter((relative) => !existsSync(path.join(root, relative)))
if (missing.length > 0) {
  console.error('generated wasm-bindgen output is missing:')
  for (const relative of missing) console.error(`  ${relative}`)
  console.error('run `npm run generate` in research-core first')
  process.exit(1)
}
