import assert from 'node:assert/strict'
import test from 'node:test'

import { bindCoreSurface, createSurfaceHandlers } from '../research-core-surface.js'
import {
  PRESETS,
  ROUTES,
  SETTINGS,
  SURFACE_NAMES,
  TOOLS,
} from '../../research-core/dist/adapter/surface.js'

const NOW = '2026-01-01T00:00:00.000Z'
const HEAD = 'b'.repeat(40)

const completed = {
  status: 'completed',
  outcome: 'concluded',
  stages: ['ExperimentProposed', 'ResearchCompleted'],
}

function createFixture() {
  const calls = []
  const starts = []
  const reviews = []
  const commits = []
  let pending
  const experiment = {
    id: 'experiment-1',
    programId: 'program-1',
    issueId: 'issue-1',
    branch: 'experiment/one',
    head: HEAD,
    environment: { kind: 'uv-lock', lockFile: 'uv.lock', pythonVersion: '3.12' },
  }
  const store = {
    experiments: {
      get: async (id) => (id === 'experiment-1' ? { version: 1, value: experiment } : undefined),
    },
  }
  const runtime = {
    async start(input) {
      starts.push(input)
      return completed
    },
    pending() {
      return pending
    },
    async resumeReview(decision) {
      reviews.push(decision)
      pending = undefined
      return completed
    },
    async resumeCommit(commit) {
      commits.push(commit)
      pending = undefined
      return completed
    },
  }
  const executeTool = async (tool, input, context) => {
    calls.push({ tool, input, context })
    return { ok: true, value: { tool, input } }
  }
  const handlers = createSurfaceHandlers({
    executeTool,
    runtime,
    store,
    actorSession: 'aleph-researcher-1',
  })
  return {
    calls,
    starts,
    reviews,
    commits,
    runtime,
    handlers,
    setPending(value) {
      pending = value
    },
  }
}

const routeRequest = (name, params = {}, body = {}) => ({
  name,
  method: 'POST',
  path: ROUTES[name].path,
  params,
  body,
  actor: { kind: 'operator', sessionId: 'aleph-operator-1' },
})

const toolRequest = (name, input = {}) => ({
  name,
  input,
  actor: { kind: 'operator', sessionId: 'aleph-operator-1' },
})

test('every surface name has exactly one handler of its declared kind', () => {
  const fixture = createFixture()
  assert.equal(Object.keys(fixture.handlers).length, SURFACE_NAMES.length)
  for (const name of SURFACE_NAMES) {
    assert.ok(fixture.handlers[name], `missing handler for ${name}`)
  }
  for (const declaration of Object.values(ROUTES)) {
    assert.equal(fixture.handlers[declaration.name].kind, 'route')
  }
  for (const declaration of Object.values(TOOLS)) {
    assert.equal(fixture.handlers[declaration.name].kind, 'tool')
  }
  for (const declaration of Object.values(PRESETS)) {
    assert.equal(fixture.handlers[declaration.name].kind, 'preset')
  }
  for (const declaration of Object.values(SETTINGS)) {
    assert.equal(fixture.handlers[declaration.name].kind, 'setting')
  }
})

test('the binder registers every route, tool, preset and setting', async () => {
  const fixture = createFixture()
  const registered = { routes: [], tools: [], presets: [], settings: [] }
  const ok = async () => ({ ok: true, value: undefined })
  const result = await bindCoreSurface({
    handlers: fixture.handlers,
    registerRoute: async (route) => {
      registered.routes.push(route)
      return ok()
    },
    registerTool: async (tool) => {
      registered.tools.push(tool)
      return ok()
    },
    registerPreset: async (preset) => {
      registered.presets.push(preset)
      return ok()
    },
    registerSetting: async (setting) => {
      registered.settings.push(setting)
      return ok()
    },
  })

  assert.equal(result.bound.ok, true)
  assert.equal(registered.routes.length, Object.values(ROUTES).length)
  assert.equal(registered.tools.length, Object.values(TOOLS).length)
  assert.equal(registered.presets.length, Object.values(PRESETS).length)
  assert.equal(registered.settings.length, Object.values(SETTINGS).length)
  assert.ok(registered.routes.some((route) => route.path === ROUTES['program.create'].path))
  assert.ok(registered.tools.some((tool) => tool.name === 'aleph_research_create_program'))
})

test('a route maps to its legacy command and returns an HTTP response', async () => {
  const fixture = createFixture()
  const response = await fixture.handlers['program.create'].handle(
    routeRequest('program.create', {}, { name: 'Program', goal: 'Goal', methodology: 'Method' }),
  )

  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.equal(fixture.calls.length, 1)
  assert.equal(fixture.calls[0].tool, 'operator_create_program')
  assert.equal(fixture.calls[0].context.actorKind, 'operator')
  assert.equal(fixture.calls[0].input.name, 'Program')
})

test('a tool maps to its legacy command with the declared role', async () => {
  const fixture = createFixture()
  const result = await fixture.handlers['aleph_research_claim_issue'].handle(
    toolRequest('aleph_research_claim_issue', { programId: 'program-1', issueId: 'issue-1' }),
  )

  assert.equal(result.ok, true)
  assert.equal(fixture.calls[0].tool, 'researcher_claim_issue')
  assert.equal(fixture.calls[0].context.actorKind, 'researcher')
})

test('benchmark.request starts the embedded core after the command', async () => {
  const fixture = createFixture()
  const response = await fixture.handlers['benchmark.request'].handle(
    routeRequest('benchmark.request', { programId: 'program-1', experimentId: 'experiment-1' }, {}),
  )

  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.equal(fixture.calls.length, 0)
  assert.equal(fixture.starts.length, 1)
  assert.deepEqual(fixture.starts[0], {
    programId: 'program-1',
    issueId: 'issue-1',
    experimentId: 'experiment-1',
    branch: 'experiment/one',
    baseCommit: HEAD,
    environment: { kind: 'uv-lock', file: 'uv.lock' },
  })
  assert.equal(response.body.value.progress, completed)
})

test('experiment.review resumes a pending review with the verdict decision', async () => {
  const fixture = createFixture()
  fixture.setPending({ effect: 'sessions.review', sequence: 3, stage: 'ResultRecorded' })
  const response = await fixture.handlers['experiment.review'].handle(
    routeRequest(
      'experiment.review',
      { programId: 'program-1', experimentId: 'experiment-1' },
      { verdict: 'request-changes', body: 'try again' },
    ),
  )

  assert.equal(response.status, 200)
  assert.equal(fixture.reviews.length, 1)
  assert.deepEqual(fixture.reviews[0], { kind: 'revise' })
  assert.equal(fixture.calls[0].tool, 'researcher_review_experiment')
})

test('ticket.submit resumes a pending commit with the submitted head', async () => {
  const fixture = createFixture()
  fixture.setPending({ effect: 'sessions.submitCommit', sequence: 4, stage: 'WorkerStarted' })
  const response = await fixture.handlers['ticket.submit'].handle(
    routeRequest('ticket.submit', {}, { head: HEAD, environment: { kind: 'uv-lock' } }),
  )

  assert.equal(response.status, 200)
  assert.deepEqual(fixture.commits, [HEAD])
  assert.equal(fixture.calls[0].tool, 'implementer_submit_implementation')
  assert.equal(fixture.calls[0].context.actorKind, 'implementer')
})

test('a legacy refusal is returned as a typed error response', async () => {
  const store = { experiments: { get: async () => undefined } }
  const runtime = {
    async start() {
      return completed
    },
    pending() {
      return undefined
    },
  }
  const handlers = createSurfaceHandlers({
    executeTool: async () => ({
      ok: false,
      status: 403,
      error: { code: 'forbidden', message: 'the issue is assigned to another researcher' },
    }),
    runtime,
    store,
    actorSession: 'aleph-researcher-1',
  })
  const response = await handlers['program.pause'].handle(
    routeRequest('program.pause', { programId: 'program-1' }, {}),
  )

  assert.equal(response.status, 403)
  assert.equal(response.body.ok, false)
  assert.equal(response.body.error.code, 'forbidden')
})

test('implementer submit resolves the running ticket from the experiment', async () => {
  const calls = []
  const store = {
    experiments: { get: async () => undefined },
    tickets: {
      listByExperiment: async (experimentId) => (experimentId === 'experiment-1'
        ? [{ id: 'ticket:experiment-1', experimentId, status: 'running', sessionId: 'aleph-implementer-ticket:experiment-1' }]
        : []),
    },
  }
  const runtime = {
    async start() {
      return completed
    },
    pending() {
      return undefined
    },
  }
  const handlers = createSurfaceHandlers({
    executeTool: async (tool, input, context) => {
      calls.push({ tool, input, context })
      return { ok: true, value: { tool } }
    },
    runtime,
    store,
    actorSession: 'aleph-researcher-1',
  })

  const result = await handlers['aleph_research_submit_ticket'].handle({
    name: 'aleph_research_submit_ticket',
    input: { experimentId: 'experiment-1', head: HEAD },
    actor: { kind: 'operator', sessionId: 'aleph-operator-1' },
  })

  assert.equal(result.ok, true)
  assert.equal(calls[0].tool, 'implementer_submit_implementation')
  assert.equal(calls[0].context.ticketId, 'ticket:experiment-1')
  assert.equal(calls[0].context.sessionId, 'aleph-implementer-ticket:experiment-1')
})

test('implementer submit resolves the ticket from the started worker session', async () => {
  const calls = []
  const store = { experiments: { get: async () => undefined } }
  const runtime = {
    async start() {
      return completed
    },
    pending() {
      return undefined
    },
  }
  const handlers = createSurfaceHandlers({
    executeTool: async (tool, input, context) => {
      calls.push({ tool, input, context })
      return { ok: true, value: { tool } }
    },
    runtime,
    store,
    actorSession: 'aleph-researcher-1',
    ticketOfSession: (sessionId) => (sessionId === 'session-1' ? 'ticket:experiment-1' : undefined),
  })

  const result = await handlers['aleph_research_submit_ticket'].handle({
    name: 'aleph_research_submit_ticket',
    input: { head: HEAD },
    actor: { kind: 'implementer', sessionId: 'session-1' },
  })

  assert.equal(result.ok, true)
  assert.equal(calls[0].context.ticketId, 'ticket:experiment-1')
  assert.equal(calls[0].context.sessionId, 'session-1')
})

test('program and issue routes call the rust command bridge instead of the legacy tool', async () => {
  const calls = []
  const commands = []
  const runtime = {
    async start() {
      return completed
    },
    pending() {
      return undefined
    },
  }
  const handlers = createSurfaceHandlers({
    executeTool: async (tool, input, context) => {
      calls.push({ tool, input, context })
      return { ok: true, value: { legacy: true } }
    },
    executeCommand: async (name, input, actor) => {
      commands.push({ name, input, actor })
      return { ok: true, value: { command: { kind: 'program-created', program: 'program-1', version: 1 } } }
    },
    runtime,
    store: { experiments: { get: async () => undefined } },
    actorSession: 'aleph-researcher-1',
  })

  const response = await handlers['program.create'].handle(
    routeRequest('program.create', {}, { name: 'Program', goal: 'Goal', methodology: 'Method' }),
  )
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.equal(response.body.value.command.kind, 'program-created')
  assert.equal(calls.length, 0)
  assert.equal(commands.length, 1)
  assert.equal(commands[0].name, 'program.create')
  assert.equal(commands[0].actor.kind, 'operator')

  const claimed = await handlers['aleph_research_claim_issue'].handle(
    toolRequest('aleph_research_claim_issue', { programId: 'program-1', issueId: 'issue-1' }),
  )
  assert.equal(claimed.ok, true)
  assert.equal(calls.length, 0)
  assert.equal(commands[1].name, 'aleph_research_claim_issue')
  assert.equal(commands[1].actor.kind, 'researcher')
})

test('a rust command refusal is returned as a typed error response', async () => {
  const calls = []
  const handlers = createSurfaceHandlers({
    executeTool: async (tool, input, context) => {
      calls.push({ tool, input, context })
      return { ok: true, value: undefined }
    },
    executeCommand: async () => ({
      ok: false,
      error: { code: 'forbidden', message: 'the actor lacks program.manage', status: 403 },
    }),
    runtime: { async start() { return completed }, pending() { return undefined } },
    store: { experiments: { get: async () => undefined } },
  })

  const response = await handlers['program.pause'].handle(
    routeRequest('program.pause', { programId: 'program-1' }, {}),
  )
  assert.equal(response.status, 403)
  assert.equal(response.body.ok, false)
  assert.equal(response.body.error.code, 'forbidden')
  assert.equal(calls.length, 0)
})

test('ticket.submit stays on the legacy path when the command bridge declines', async () => {
  const calls = []
  const commits = []
  const runtime = {
    async start() {
      return completed
    },
    pending() {
      return { effect: 'sessions.submitCommit', sequence: 7, stage: 'WorkerStarted' }
    },
    async resumeCommit(commit) {
      commits.push(commit)
      return completed
    },
  }
  const handlers = createSurfaceHandlers({
    executeTool: async (tool, input, context) => {
      calls.push({ tool, input, context })
      return { ok: true, value: { tool } }
    },
    executeCommand: async () => undefined,
    runtime,
    store: { experiments: { get: async () => undefined } },
  })

  const response = await handlers['ticket.submit'].handle(
    routeRequest('ticket.submit', {}, { head: HEAD }),
  )
  assert.equal(response.status, 200)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].tool, 'implementer_submit_implementation')
  assert.deepEqual(commits, [HEAD])
})
