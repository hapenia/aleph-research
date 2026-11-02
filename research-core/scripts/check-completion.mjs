#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const source = await readFile(join(root, 'src/completion.ts'), 'utf8')
const pending = [...source.matchAll(/'([a-z0-9-]+)':\s*'todo'/g)].map((match) => match[1])

if (pending.length === 0) {
  console.log('check-completion: no pending features')
} else {
  console.log(`check-completion: ${pending.length} pending feature(s): ${pending.join(', ')}`)
}
