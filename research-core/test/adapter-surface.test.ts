import assert from 'node:assert/strict'
import test from 'node:test'
import {
  bindSurface,
  PRESETS,
  ROUTES,
  SETTINGS,
  SURFACE_NAMES,
  TOOLS,
} from '../src/adapter/surface.js'
import type { RouteRegistrar, SurfaceHandlers } from '../src/adapter/surface.js'
import {
  createCorrectHandlers,
  createSurfaceFixture,
  message,
  ok,
  surfacePortsOf,
} from './adapter-fixture.js'

test('the surface names cover every declaration without duplicates', () => {
  const routeCount = Object.values(ROUTES).length
  const toolCount = Object.values(TOOLS).length
  const presetCount = Object.values(PRESETS).length
  const settingCount = Object.values(SETTINGS).length

  assert.equal(SURFACE_NAMES.length, routeCount + toolCount + presetCount + settingCount)
  assert.equal(new Set(SURFACE_NAMES).size, SURFACE_NAMES.length)

  for (const declaration of Object.values(ROUTES)) assert.ok(SURFACE_NAMES.includes(declaration.name))
  for (const declaration of Object.values(TOOLS)) assert.ok(SURFACE_NAMES.includes(declaration.name))
  for (const declaration of Object.values(PRESETS)) assert.ok(SURFACE_NAMES.includes(declaration.name))
  for (const declaration of Object.values(SETTINGS)) assert.ok(SURFACE_NAMES.includes(declaration.name))
})

test('the binder registers every route, tool, preset and setting', async () => {
  const fixture = createSurfaceFixture()
  const result = await bindSurface(createCorrectHandlers(), surfacePortsOf(fixture))

  assert.equal(result.ok, true)
  assert.equal(result.bindings.length, SURFACE_NAMES.length)
  assert.equal(fixture.calls.routes.length, Object.values(ROUTES).length)
  assert.equal(fixture.calls.tools.length, Object.values(TOOLS).length)
  assert.equal(fixture.calls.presets.length, Object.values(PRESETS).length)
  assert.equal(fixture.calls.settings.length, Object.values(SETTINGS).length)

  const routes = fixture.calls.routes as readonly { readonly path: string }[]
  assert.ok(routes.some((route) => route.path === ROUTES['program.create'].path))
  assert.ok(result.bindings.every((binding) => binding.result.ok))
})

test('a handler of the wrong kind is refused without registering it', async () => {
  const fixture = createSurfaceFixture()
  const handlers: SurfaceHandlers = {
    ...createCorrectHandlers(),
    'program.create': {
      kind: 'tool',
      handle: async () => ok(null),
    },
  }

  const result = await bindSurface(handlers, surfacePortsOf(fixture))
  const binding = result.bindings.find((entry) => entry.name === 'program.create')

  assert.equal(result.ok, false)
  assert.ok(binding !== undefined)
  assert.equal(binding.result.ok, false)
  if (!binding.result.ok) assert.equal(binding.result.error.code, 'invalid-input')
  assert.equal(fixture.calls.routes.length, Object.values(ROUTES).length - 1)
  assert.equal(fixture.calls.tools.length, Object.values(TOOLS).length)
})

test('a registrar failure is reported while the other categories still bind', async () => {
  const fixture = createSurfaceFixture()
  const failingRoutes: RouteRegistrar = {
    register: async () => ({
      ok: false,
      error: { code: 'conflict', message: message('the route is already registered') },
    }),
  }

  const result = await bindSurface(createCorrectHandlers(), {
    ...surfacePortsOf(fixture),
    http: failingRoutes,
  })

  assert.equal(result.ok, false)
  assert.equal(
    result.bindings.filter((binding) => !binding.result.ok).length,
    Object.values(ROUTES).length,
  )
  assert.equal(fixture.calls.routes.length, 0)
  assert.equal(fixture.calls.tools.length, Object.values(TOOLS).length)
  assert.equal(fixture.calls.presets.length, Object.values(PRESETS).length)
  assert.equal(fixture.calls.settings.length, Object.values(SETTINGS).length)
})
