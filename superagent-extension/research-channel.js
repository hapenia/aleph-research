/**
 * The local research Channel of the `aleph` Source kind.
 *
 * A research thread is `aleph:research:<project>:ticket:<ticket>` and its Channel
 * address is `{ project, ticket }`. Outbound messages are appended to
 * `<dir>/channel.jsonl`, one JSON object per line, so the file is an append-only
 * log that survives crashes and can be replayed; a repeated message id is not
 * written twice.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const VERSION = 1

/** Human-readable name of the local research panel, used as the Channel link label. */
const LABEL = { zh: '本地研究面板', en: 'Local research panel' }

/** Path of the append-only log under the Channel directory. */
const logPath = (dir) => join(dir, 'channel.jsonl')

/** Parse one log line, or `null` when the line is not a research record. */
const parseRecord = (line) => {
  const text = line.trim()
  if (!text) return null
  try {
    const record = JSON.parse(text)
    return record && typeof record === 'object' && !Array.isArray(record) ? record : null
  } catch {
    return null
  }
}

/**
 * Read every valid record of the Channel log, in file order.
 * Malformed lines are skipped; a missing file reads as an empty log.
 */
export async function readResearchChannel(dir) {
  let raw
  try {
    raw = await readFile(logPath(dir), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const records = []
  for (const line of raw.split('\n')) {
    const record = parseRecord(line)
    if (record) records.push(record)
  }
  return records
}

/**
 * Build the local research Channel.
 *
 * @param {{ dir: string, linkUrl?: string }} options
 *   `dir` holds `channel.jsonl`; `linkUrl` is the address of the research panel.
 */
export function createResearchChannel({ dir, linkUrl = '' } = {}) {
  return {
    /** The local research channel always accepts the thread it belongs to. */
    allowed() {
      return true
    },

    /**
     * Append one outbound message to the Channel log and return `'sent'`.
     * A message whose id is already in the log is not appended again.
     */
    async send(host, message) {
      const id = message?.id ?? null
      const record = {
        version: VERSION,
        id,
        at: message?.at ?? null,
        thread: message?.thread ?? null,
        address: message?.address ?? null,
        text: message?.text ?? null,
        source: 'aleph',
      }

      await mkdir(dir, { recursive: true })
      const existing = await readResearchChannel(dir)
      if (existing.some((entry) => entry.id === id)) return 'sent'

      await appendFile(logPath(dir), `${JSON.stringify(record)}\n`, 'utf8')
      return 'sent'
    },

    /** The link back to the research panel for one Channel address. */
    link() {
      return { url: linkUrl, label: { ...LABEL } }
    },
  }
}
