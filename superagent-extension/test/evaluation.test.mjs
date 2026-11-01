import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { evaluateSubmission, killEvaluationProcesses } from '../evaluation.js'

/** PIDs whose command line matches the pattern, or '' when pgrep finds none. */
function pgrep(pattern) {
  try {
    return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

test('reads the score printed on a JSON line', async () => {
  const result = await evaluateSubmission({
    python: '',
    command: `printf '%s\\n' '{"score": 87.5, "note": "ok"}'`,
    cwd: process.cwd(),
    timeoutMs: 5_000,
  })

  assert.equal(result.score, 87.5)
  assert.equal(result.exitCode, 0)
  assert.equal(result.timedOut, false)
  assert.equal(result.stderr, '')
  assert.match(result.stdout, /"score": 87\.5/)
  assert.equal(typeof result.marker, 'string')
  assert.ok(result.marker.length > 0)
  assert.ok(result.durationMs >= 0)
})

test('returns a null score when the output holds no scored JSON object', async () => {
  const result = await evaluateSubmission({
    python: '',
    command: `printf '%s\\n' 'evaluation finished without a score' '{"score": "high"}'`,
    cwd: process.cwd(),
    timeoutMs: 5_000,
  })

  assert.equal(result.score, null)
  assert.equal(result.exitCode, 0)
  assert.equal(result.timedOut, false)
})

test('times out, reports it, and kills the whole process tree', async () => {
  const token = `aleph-eval-${randomUUID()}`
  const result = await evaluateSubmission({
    python: '',
    // The inner shell keeps the token on its command line and waits on sleep,
    // so both the shell and its sleep child must be stopped by the marker scan.
    command: `bash -c 'sleep 5; echo ${token}'`,
    cwd: process.cwd(),
    timeoutMs: 300,
  })

  assert.equal(result.timedOut, true)
  assert.equal(result.exitCode, null)
  assert.ok(result.durationMs < 2_000, `the timeout took ${result.durationMs}ms`)

  let remaining = pgrep(token)
  for (let attempt = 0; attempt < 20 && remaining !== ''; attempt += 1) {
    await delay(50)
    remaining = pgrep(token)
  }
  assert.equal(remaining, '', `leftover evaluation process(es): ${remaining}`)
})

test('killEvaluationProcesses returns a number and never throws', () => {
  let killed = -1
  assert.doesNotThrow(() => {
    killed = killEvaluationProcesses(`unknown-${randomUUID()}`)
  })
  assert.equal(killed, 0)
  assert.equal(typeof killed, 'number')
  assert.equal(killEvaluationProcesses(''), 0)
  assert.equal(killEvaluationProcesses('a-marker-that-matches-nothing'), 0)
})
