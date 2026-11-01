/**
 * A small versioned configuration store for the AlephResearch extension.
 *
 * The store keeps the live configuration in `<dir>/<name>.json` and every write in
 * `<dir>/<name>.history.json`. A save never edits an old history record: restoring an
 * old revision appends a new revision carrying the old value, so the history stays a
 * faithful log of what the configuration was at each point in time.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Newest number of history records kept on disk. */
const HISTORY_LIMIT = 50

/** Distinguishes temp files created by different saves in the same millisecond. */
let tempSequence = 0

export class ConfigStore {
  /**
   * @param {object} options
   * @param {string} options.dir absolute directory that holds the store files
   * @param {string} [options.name] base name shared by the current and history files
   * @param {((value: unknown) => void) | null} [options.validate] throws for an invalid value
   */
  constructor({ dir, name = 'aleph-config', validate = null }) {
    if (!dir || typeof dir !== 'string' || !path.isAbsolute(dir)) {
      throw new Error('config store requires an absolute `dir`')
    }
    this.dir = dir
    this.name = name
    this.validate = typeof validate === 'function' ? validate : null
    this.path = path.join(dir, `${name}.json`)
    this.historyPath = path.join(dir, `${name}.history.json`)
    mkdirSync(this.dir, { recursive: true })
  }

  /** The live configuration, or revision 0 with a null value when nothing was saved. */
  current() {
    const entry = this.#readJson(this.path, { missing: null })
    if (entry === null) return { revision: 0, value: null, updatedAt: null }
    if (!isRecord(entry) || !Number.isFinite(entry.revision) || !('value' in entry) || !('updatedAt' in entry)) {
      throw new Error(`config store is corrupted: ${this.path}`)
    }
    return { revision: entry.revision, value: entry.value, updatedAt: entry.updatedAt }
  }

  /** Recorded versions, newest first. The file is optional and an empty file means no history. */
  history() {
    return this.#readHistory()
  }

  /**
   * Validate and append a new revision.
   * @returns {{ revision: number, value: unknown, updatedAt: string }}
   */
  save(value, { origin = 'api' } = {}) {
    this.#validate(value)
    return this.#commit(value, origin)
  }

  /**
   * Re-save an earlier revision's value as a new revision. History is never rewritten.
   */
  restore(revision, { origin = 'api' } = {}) {
    const entry = this.#readHistory().find((record) => record.revision === revision)
    if (!entry) throw new Error(`config store has no revision ${revision} to restore: ${this.historyPath}`)
    this.#validate(entry.value)
    return this.#commit(entry.value, origin)
  }

  /** Re-save the value of the revision just before the current one. */
  rollbackLast({ origin = 'api' } = {}) {
    const current = this.current()
    if (current.revision === 0) throw new Error(`config store has nothing to roll back: ${this.path}`)
    const entry = this.#readHistory().find((record) => record.revision === current.revision - 1)
    if (!entry) {
      throw new Error(`config store has no revision ${current.revision - 1} to roll back to: ${this.historyPath}`)
    }
    this.#validate(entry.value)
    return this.#commit(entry.value, origin)
  }

  /** One change marker per history record, newest first. */
  changes() {
    return this.#readHistory().map(({ revision, updatedAt, origin }) => ({
      revision,
      updatedAt,
      origin,
      changed: true,
    }))
  }

  #validate(value) {
    if (this.validate) this.validate(value)
  }

  /** Append a validated value as a new revision and return the new current entry. */
  #commit(value, origin) {
    const current = this.current()
    const revision = current.revision + 1
    const updatedAt = new Date().toISOString()
    const entry = { revision, value, updatedAt }
    const records = this.#readHistory()
    const history = [{ ...entry, origin }, ...records].slice(0, HISTORY_LIMIT)
    // Write both temp files before renaming so a failure leaves the live files untouched.
    const tempCurrent = this.#writeTemp(this.path, entry)
    let tempHistory
    try {
      tempHistory = this.#writeTemp(this.historyPath, history)
      renameSync(tempCurrent, this.path)
      renameSync(tempHistory, this.historyPath)
    } catch (error) {
      for (const temp of [tempCurrent, tempHistory]) {
        if (temp) removeIfPresent(temp)
      }
      throw error
    }
    return entry
  }

  #readHistory() {
    const records = this.#readJson(this.historyPath, { missing: [] })
    if (!Array.isArray(records)) throw new Error(`config store is corrupted: ${this.historyPath}`)
    for (const record of records) {
      if (!isRecord(record) || !Number.isFinite(record.revision) || !('value' in record) || !('updatedAt' in record)) {
        throw new Error(`config store is corrupted: ${this.historyPath}`)
      }
    }
    return records.map((record) => ({ ...record }))
  }

  /**
   * Read one JSON file. A missing file yields `fallback`; an empty file yields `fallback`
   * as well (an interrupted write must not look like a corrupt store). Anything else that
   * does not parse is reported with the path of the offending file.
   */
  #readJson(file, { missing }) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') return missing
      throw error
    }
    if (text.trim() === '') return missing
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`config store is corrupted: ${file}`)
    }
  }

  /** Write `data` to a temp file beside `target` and return the temp path. */
  #writeTemp(target, data) {
    tempSequence += 1
    const temp = path.join(
      path.dirname(target),
      `.${path.basename(target)}.${process.pid}.${Date.now()}.${tempSequence}.tmp`,
    )
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    return temp
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function removeIfPresent(file) {
  try {
    unlinkSync(file)
  } catch {
    // The temp file may already be gone; leaving it behind is harmless.
  }
}
