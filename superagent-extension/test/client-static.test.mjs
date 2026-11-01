/**
 * Static checks for the Web client bundle.
 *
 * The panel is a browser module: it needs the Host-injected `window.__ModuleLoader__`
 * and React, so this test never imports or executes it. Instead it proves the two
 * things a unit test can prove about the bundle: the file parses as JavaScript, and
 * the source still contains the contracts the panel is expected to serve.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const CLIENT_PATH = fileURLToPath(new URL('../client.js', import.meta.url))
const source = readFileSync(CLIENT_PATH, 'utf8')

/** Assert a source pattern without dumping the whole bundle on failure. */
function hasPattern(pattern, message) {
  assert.ok(pattern.test(source), message)
}

/** Assert a literal source fragment. */
function hasText(text, message = `missing source fragment: ${text}`) {
  assert.ok(source.includes(text), message)
}

test('client.js parses as JavaScript', () => {
  const output = execFileSync(process.execPath, ['--check', CLIENT_PATH], { encoding: 'utf8' })
  assert.equal(output, '')
})

test('the research tab polls both runtime routes while the legacy routes stay available', () => {
  for (const route of [
    '/aleph/api/research/health',
    '/aleph/api/research/programs',
    '/aleph/api/results',
    '/aleph/api/state',
    '/orchestrator/api/state',
  ]) {
    hasText(route, `missing route ${route}`)
  }
  hasPattern(/const POLL_MS = 10000;/)
  hasPattern(/setInterval\(\(\) => \{ void poll\(\); \}, POLL_MS\)/)
  hasPattern(/let timer = null;/)
  hasPattern(/clearInterval\(timer\)/)
})

test('the poll runs only while visible and never overlaps itself', () => {
  hasPattern(/document\.visibilityState !== 'hidden'/)
  hasPattern(/addEventListener\('visibilitychange'/)
  hasPattern(/removeEventListener\('visibilitychange'/)
  hasPattern(/if \(stopped \|\| inFlight\) return/)
  hasPattern(/detailInFlight\.current\.has\(programId\)/)
  hasPattern(/stopped = true;/)
  hasPattern(/pollRef\.current = null;/)
})

test('the Program detail is fetched on expand and shows the snapshot fields', () => {
  hasPattern(/RESEARCH_PROGRAMS_PATH \+ '\/' \+ encodeURIComponent\(programId\)/)
  for (const key of [
    'field.status',
    'field.exploration',
    'field.issues',
    'field.experiments',
    'section.audit',
    'section.attention',
    'state.detailLoading',
    'empty.audit',
    'empty.attention',
  ]) {
    hasText(`t('${key}')`, `missing localized field ${key}`)
  }
})

test('health shows persistence and the absent runtime states are explicit', () => {
  hasText('RESEARCH_HEALTH_PATH')
  hasText("'field.persistent'")
  hasPattern(/persistentBadge\(t, data\?\.persistent\)/)
  hasText("'research/build-missing'")
  hasPattern(/result\.status === status/)
  hasPattern(/buildMissing\(health\) \|\| buildMissing\(programs\)/)
  hasText("'runtime.buildMissing'")
  hasText("'runtime.notMounted'")
  hasText("'empty.programs'")
})

test('the panel keeps both tabs and the existing slot registrations', () => {
  hasText("'tab.research'")
  hasText("'tab.legacy'")
  hasPattern(/ctx\.slots\.inject\('main'/)
  hasPattern(/ctx\.slots\.register\(\{ name: 'main', key: PANEL_ID/)
  hasPattern(/ctx\.slots\.inject\('sidebar\.panellist'/)
  hasPattern(/name: 'sidebar\.panellist', id: PANEL_ID/)
  hasText('resultsCard(t, panel.results)')
  hasText('ticketsCard(t, panel.tickets)')
  hasText('orchestratorCard(t, panel.orchestrator)')
})

test('untrusted bodies go through response.json and no dynamic code is used', () => {
  hasText('response.json()')
  assert.equal(source.includes('JSON.parse('), false, 'JSON.parse must not be used in the client bundle')
  assert.equal(source.includes('dangerouslySetInnerHTML'), false, 'raw HTML injection must not be used')
  assert.equal(/(^|[^\w$.])eval\s*\(/.test(source), false, 'eval() must not appear in the client bundle')
  assert.equal(/new\s+Function\s*\(/.test(source), false, 'new Function() must not appear in the client bundle')
})
