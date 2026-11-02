/**
 * End-to-end test for the packaged build.
 *
 * The other tests import `../src/*.ts` through tsx. This one deliberately imports
 * `dist/*.js` so it fails whenever the published artefacts drift from the source: the
 * build must run first, then every entry point the JS adapter consumes is loaded from
 * the emitted JavaScript.
 *
 * `npm run build` is part of the test, not a precondition, so a stale `dist/` can never
 * make the suite pass against old output.
 *
 * The package self-reference below is checked as well. Node resolves
 * `@local/aleph-research-core/...` through this package's own `exports` map, the same map
 * a dependent package resolves against; the test asserts the mapped namespace is the same
 * module instance as the direct `dist/` import. The subpaths are written without a `.js`
 * suffix because the map's pattern target supplies the extension. (If a future Node
 * release stops honouring self-reference, only this last test needs replacing with a
 * direct `dist/` import; the other imports are already direct paths.)
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const DIST_ROOT = path.join(PACKAGE_ROOT, 'dist')

/** Absolute path of one emitted file, as an importable file URL. */
function distUrl(relativePath) {
  return pathToFileURL(path.join(DIST_ROOT, relativePath)).href
}

/** Import one emitted JavaScript module by its direct `dist/` path. */
function importDist(relativePath) {
  return import(distUrl(relativePath))
}

let buildPromise

/**
 * Run `npm run build` exactly once for the whole file. The promise is memoized so a
 * failure is reported to the first test and every later test sees the same error.
 */
function buildOnce() {
  buildPromise ??= Promise.resolve().then(() => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    try {
      const stdout = execFileSync(npm, ['run', 'build'], {
        cwd: PACKAGE_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return stdout
    } catch (error) {
      const stdout = typeof error.stdout === 'string' ? error.stdout : ''
      const stderr = typeof error.stderr === 'string' ? error.stderr : String(error)
      throw new Error(`npm run build failed in ${PACKAGE_ROOT}\n${stdout}\n${stderr}`)
    }
  })
  return buildPromise
}

/** Reject symlinks and non-files so the assertions describe the real tree. */
function assertEmitted(relativePath) {
  const absolute = path.join(DIST_ROOT, relativePath)
  const stats = statSync(absolute, { throwIfNoEntry: false })
  assert.ok(stats?.isFile() === true, `expected the build to emit dist/${relativePath}`)
}

/** Every file below `dist/`, as POSIX-style paths relative to `dist/`. */
function distFiles() {
  const files = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile()) files.push(path.relative(DIST_ROOT, absolute).split(path.sep).join('/'))
    }
  }
  walk(DIST_ROOT)
  return files
}

const OPERATOR_SESSION = 'operator-session'
const PROGRAM_BODY = {
  name: 'clifford research',
  goal: 'find a better probe',
  methodology: 'controlled experiments',
  contract: { ciEntry: 'run.sh', timeoutMs: 1000, requiredMetrics: ['score'] },
  utility: { metrics: [{ name: 'score', direction: 'higher', weight: 1 }] },
  exploration: 'normal',
  budget: { maxExperiments: 3, maxComputeMinutes: 30, maxTokens: 1000 },
}

test('npm run build emits the packaged JavaScript and declarations', async () => {
  await buildOnce()

  // The package root, the adapter composition root the JS adapter calls, the in-memory
  // runtime store and the DSH storage adapter must all compile to runnable JavaScript.
  for (const entry of [
    'index.js',
    'index.d.ts',
    'runtime/storage.js',
    'runtime/storage.d.ts',
    'adapter/composition.js',
    'adapter/composition.d.ts',
    'adapter/storage-domain.js',
    'adapter/storage-domain.d.ts',
    'adapter/boundary.js',
    'adapter/boundary.d.ts',
    'adapter/plugin.js',
    'adapter/plugin.d.ts',
    'adapter/runtime.js',
    'adapter/runtime.d.ts',
    'adapter/surface.js',
    'adapter/surface.d.ts',
    'adapter/wasm.js',
    'adapter/wasm.d.ts',
    'adapter/wasm-codec.js',
    'adapter/wasm-codec.d.ts',
    'adapter/wasm-core.js',
    'adapter/wasm-core.d.ts',
  ]) {
    assertEmitted(entry)
  }

  // Nothing that exists only to typecheck or to test may ship. `noEmit` sources are
  // excluded in tsconfig.build.json; this catches a regression in that config.
  const shipped = distFiles()
  assert.ok(shipped.length > 0, 'the build emitted no files')
  for (const file of shipped) {
    const segments = file.split('/')
    assert.ok(!segments.includes('test'), `dist must not contain test files, found ${file}`)
    assert.ok(!/\.test\.[^/]+$/.test(file), `dist must not contain test files, found ${file}`)
    assert.ok(!file.startsWith('type-tests'), `dist must not contain type-tests, found ${file}`)
    assert.ok(!file.includes('__'), `dist must not contain internal fixtures, found ${file}`)
  }
})

test('the built modules expose the adapter entry points', async () => {
  await buildOnce()

  const adapterComposition = await importDist('adapter/composition.js')
  const runtimeStorage = await importDist('runtime/storage.js')
  const adapterStorageDomain = await importDist('adapter/storage-domain.js')
  const adapterRuntime = await importDist('adapter/runtime.js')
  const adapterSurface = await importDist('adapter/surface.js')
  const adapterWasm = await importDist('adapter/wasm.js')
  const adapterCoreRuntime = await importDist('adapter/core-runtime.js')

  assert.equal(typeof adapterComposition.createResearchHost, 'function')
  assert.equal(typeof runtimeStorage.createInMemoryStore, 'function')
  assert.equal(typeof adapterStorageDomain.createStorageDomainUnitOfWork, 'function')
  assert.equal(typeof adapterRuntime.createPlugin, 'function')
  assert.equal(typeof adapterSurface.bindSurface, 'function')
  assert.equal(typeof adapterWasm.loadResearchCore, 'function')
  assert.equal(typeof adapterCoreRuntime.createCoreRuntime, 'function')
})

test('createResearchHost from dist creates a Program over the HTTP route and snapshots it', async () => {
  await buildOnce()

  const adapterComposition = await importDist('adapter/composition.js')
  const runtimeStorage = await importDist('runtime/storage.js')
  const parsers = await importDist('parsers.js')
  const factories = await importDist('factories.js')

  // Parse the branded principal through the emitted parser boundary. `parsers.js` and
  // `factories.js` are direct `dist/` paths rather than exported subpaths: they are not
  // part of the map the JS adapter consumes yet, and the test lives inside the package.
  const parsedSession = parsers.operatorSessionId(OPERATOR_SESSION)
  assert.equal(parsedSession.ok, true, 'the operator session id must parse')
  const operator = factories.createOperatorPrincipal(parsedSession.value)

  const host = adapterComposition.createResearchHost({ store: runtimeStorage.createInMemoryStore() })

  const response = await host.handleHttp({
    method: 'POST',
    path: '/aleph/api/programs',
    body: PROGRAM_BODY,
    actor: operator,
  })
  assert.equal(response.status, 201)
  assert.equal(response.body.ok, true)
  const program = response.body.value
  assert.equal(typeof program.id, 'string')

  const snapshot = await host.snapshot(program.id)
  assert.equal(snapshot.ok, true, 'the snapshot must be readable')
  assert.equal(snapshot.value.program.id, program.id)
  assert.equal(snapshot.value.program.status, 'running')
  assert.deepEqual(
    snapshot.value.audit.map((entry) => entry.action),
    ['program.created'],
  )
})

test('package self-reference resolves the exported subpaths to dist modules', async () => {
  await buildOnce()

  // Extensionless: the `./runtime/*` and `./adapter/*` export patterns append `.js`.
  const selfReferencedStorage = await import('@local/aleph-research-core/runtime/storage')
  const selfReferencedComposition = await import('@local/aleph-research-core/adapter/composition')
  const packageRoot = await import('@local/aleph-research-core')

  const directStorage = await importDist('runtime/storage.js')
  const directComposition = await importDist('adapter/composition.js')

  // Same module instance means the exports map points at the emitted file, not at a
  // different copy or at the TypeScript source.
  assert.equal(selfReferencedStorage, directStorage)
  assert.equal(selfReferencedComposition, directComposition)
  assert.equal(typeof selfReferencedStorage.createInMemoryStore, 'function')
  assert.equal(typeof selfReferencedComposition.createResearchHost, 'function')
  assert.equal(typeof packageRoot, 'object')
})
