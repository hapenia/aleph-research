import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const DEFAULT_TIMEOUT_MS = 600_000
const MARKER_ENV = 'ALEPH_EVALUATION_ID'

/**
 * Run the project evaluator in a directory and read the score it prints.
 *
 * The command always runs through `bash -lc`, so it may be any shell command.
 * A non-empty `python` is exported as `ALEPH_PYTHON` for the evaluator to use;
 * the command itself is never rewritten.
 *
 * @param {{
 *   python: string,
 *   command: string,
 *   cwd: string,
 *   timeoutMs?: number,
 *   marker?: string,
 *   env?: Record<string, string>,
 * }} options
 * @returns {Promise<{
 *   score: number | null,
 *   stdout: string,
 *   stderr: string,
 *   exitCode: number | null,
 *   timedOut: boolean,
 *   marker: string,
 *   durationMs: number,
 * }>}
 */
export async function evaluateSubmission(options) {
  const settings = options ?? {}
  const {
    python = '',
    command,
    cwd,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    marker = randomUUID(),
    env: extraEnv,
  } = settings

  if (typeof command !== 'string' || command.length === 0) {
    throw new TypeError('evaluation command must be a non-empty string')
  }

  const env = { ...process.env, [MARKER_ENV]: marker }
  const interpreter = typeof python === 'string' ? python.trim() : ''
  if (interpreter) env.ALEPH_PYTHON = interpreter
  if (extraEnv) Object.assign(env, extraEnv)

  const startedAt = Date.now()
  let stdout = ''
  let stderr = ''
  let timedOut = false
  let settled = false

  return await new Promise((resolve) => {
    let timer = null
    let child = null

    const finish = (exitCode) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({
        score: parseScore(stdout),
        stdout,
        stderr,
        exitCode,
        timedOut,
        marker,
        durationMs: Date.now() - startedAt,
      })
    }

    try {
      child = spawn('bash', ['-lc', command], {
        cwd,
        env,
        // The evaluator must not block on inherited stdin; stdout/stderr are pipes.
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      stderr += `${error instanceof Error ? error.message : String(error)}\n`
      finish(null)
      return
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })

    child.on('error', (error) => {
      stderr += `${error instanceof Error ? error.message : String(error)}\n`
      finish(null)
    })

    child.on('close', (code) => {
      finish(typeof code === 'number' ? code : null)
    })

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        // Every process the command started inherits the marker, so the whole
        // tree is stopped, not just the entry shell.
        killEvaluationProcesses(marker)
        try { child?.kill('SIGKILL') } catch { /* already gone */ }
      }, timeoutMs)
      timer.unref?.()
    }
  })
}

/**
 * Kill every process whose environment carries `ALEPH_EVALUATION_ID=<marker>`.
 * Linux-only (reads `/proc`); never throws.
 *
 * @param {string} marker
 * @returns {number} number of processes signalled
 */
export function killEvaluationProcesses(marker) {
  try {
    if (typeof marker !== 'string' || marker.length === 0) return 0
    const expected = `${MARKER_ENV}=${marker}`
    let killed = 0
    let entries = []
    try {
      entries = readdirSync('/proc')
    } catch {
      return 0
    }
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue
      const pid = Number(entry)
      if (!Number.isInteger(pid) || pid === process.pid) continue
      let environ = ''
      try {
        environ = readFileSync(path.join('/proc', entry, 'environ'), 'utf8')
      } catch {
        continue
      }
      // Match the exact variable, never a marker that is only a prefix of another one.
      if (!environ.split('\0').includes(expected)) continue
      try {
        process.kill(pid, 'SIGKILL')
        killed += 1
      } catch {
        // The process exited between the scan and the signal.
      }
    }
    return killed
  } catch {
    return 0
  }
}

/** The last stdout line that is a JSON object with a finite numeric `score`, or null. */
function parseScore(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const text = lines[index].trim()
    if (!text.startsWith('{')) continue
    try {
      const value = JSON.parse(text)
      if (value && typeof value === 'object' && typeof value.score === 'number' && Number.isFinite(value.score)) {
        return value.score
      }
    } catch {
      // Not a JSON line; keep scanning upwards.
    }
  }
  return null
}
