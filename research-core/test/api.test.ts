/**
 * Runtime tests for the typed HTTP boundary.
 *
 * They prove what the type surface cannot: paths are mapped to command literals, an
 * unknown path is a 404 without an exception, a parser failure is audited and never
 * reaches the executor, a Host resolver failure is a 403 before execution, Host-owned
 * fields cannot be smuggled in through the body, and a success/refusal outcome is
 * translated to the documented status and body.
 *
 * `research-core` is still declaration-only, so the nominal values the Host mints
 * (principals, ownership tokens, branded ids) have no runtime constructors. As in the
 * other runtime tests, `forged` stands in for them inside fixtures; it is the only
 * assertion in this file and is stripped together with every other type.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { AuditEntry, AuditEntryOf } from '../src/types/audit.js'
import type {
  ImplementerPrincipal,
  IssueAssignment,
  OperatorPrincipal,
  Principal,
  ResearcherPrincipal,
  TicketBinding,
} from '../src/types/actors.js'
import type { CommandOutcome, CommandType } from '../src/types/commands.js'
import type { DomainError, DomainErrorCode, Result } from '../src/types/errors.js'
import type { CommandExecutor } from '../src/types/executor.js'
import type {
  CommitSha,
  ExperimentId,
  ImplementerSessionId,
  IsoTimestamp,
  IssueId,
  NonEmptyString,
  OperatorSessionId,
  ProgramId,
  RequestId,
  ResearcherSessionId,
  TicketId,
} from '../src/types/ids.js'
import type { Clock } from '../src/types/services.js'
import type { RefusedCommandFacts } from '../src/runtime/executor.js'
import {
  createApi,
  httpStatusForError,
  ROUTE_TABLE,
  toDomainFailure,
  type Api,
  type HostContextFields,
  type HostContextRequest,
  type HostContextResolvers,
  type HttpRequest,
  type RequestIdSource,
  type RouteParameter,
} from '../src/runtime/api.js'
import { COMMAND_PARSERS } from '../src/parsers-commands.js'

/** Stand-in for a value the Host mints through its factory/hydration boundary. */
function forged<T>(value: unknown): T {
  return value as T
}

const AT = forged<IsoTimestamp>('2026-11-02T00:00:00.000Z')
const REQUEST_1 = forged<RequestId>('request-1')
const REQUEST_2 = forged<RequestId>('request-2')
const PROGRAM_ID = forged<ProgramId>('program-1')
const ISSUE_ID = forged<IssueId>('issue-1')
const EXPERIMENT_ID = forged<ExperimentId>('experiment-1')
const TICKET_ID = forged<TicketId>('ticket-1')
const IMPLEMENTER_SESSION = forged<ImplementerSessionId>('implementer-session')
const HEAD = forged<CommitSha>('0123456789abcdef0123456789abcdef01234567')
const MESSAGE = forged<NonEmptyString>('refused by the test double')

const operator = forged<OperatorPrincipal>({
  kind: 'operator',
  sessionId: forged<OperatorSessionId>('operator-session'),
})
const researcher = forged<ResearcherPrincipal>({
  kind: 'researcher',
  sessionId: forged<ResearcherSessionId>('researcher-session'),
})
const implementer = forged<ImplementerPrincipal>({
  kind: 'implementer',
  sessionId: IMPLEMENTER_SESSION,
  ticketId: TICKET_ID,
})

const ASSIGNMENT = forged<IssueAssignment>({ issueId: ISSUE_ID, assignee: researcher })
const BINDING = forged<TicketBinding>({
  ticketId: TICKET_ID,
  experimentId: EXPERIMENT_ID,
  sessionId: IMPLEMENTER_SESSION,
})

const REFUSAL_ENTRY = forged<AuditEntryOf<'command.refused'>>({ action: 'command.refused' })
const CREATED_AUDIT = forged<AuditEntryOf<'program.created'>>({ action: 'program.created' })
const PAUSED_AUDIT = forged<AuditEntryOf<'program.paused'>>({ action: 'program.paused' })
const CLAIMED_AUDIT = forged<AuditEntryOf<'issue.claimed'>>({ action: 'issue.claimed' })
const REVIEWED_AUDIT = forged<AuditEntryOf<'experiment.reviewed'>>({ action: 'experiment.reviewed' })
const CI_REQUESTED_AUDIT = forged<AuditEntryOf<'ci.requested'>>({ action: 'ci.requested' })
const READY_AUDIT = forged<AuditEntryOf<'experiment.ready'>>({ action: 'experiment.ready' })

const HOST_FAILURE: DomainError = {
  code: 'forbidden',
  message: forged<NonEmptyString>('the Host could not resolve the ownership proof'),
}

const CREATE_PROGRAM_BODY = {
  name: 'clifford research',
  goal: 'find a better probe',
  methodology: 'controlled experiments',
  contract: { ciEntry: 'run.sh', timeoutMs: 1000, requiredMetrics: ['score'] },
  utility: { metrics: [{ name: 'score', direction: 'higher', weight: 1 }] },
  exploration: 'normal',
  budget: { maxExperiments: 3, maxComputeMinutes: 30, maxTokens: 1000 },
}

const ENVIRONMENT = {
  kind: 'requirements',
  requirementsFile: 'requirements.txt',
  pythonVersion: '3.12',
}

const PLAN_BODY = {
  hypothesis: 'a wider clipping window is better',
  steps: ['clip wider', 'measure'],
  expected: { direction: 'higher', rationale: 'more signal' },
  environment: { kind: 'uv-lock', lockFile: 'uv.lock', pythonVersion: '3.12' },
  inputs: [],
}

const SUBMIT_BODY = { head: HEAD, environment: ENVIRONMENT }

const COMMAND_TYPES: readonly CommandType[] = [
  'program.create',
  'program.pause',
  'program.resume',
  'program.stop',
  'program.set-goal',
  'program.set-methodology',
  'program.set-exploration',
  'issue.create',
  'issue.claim',
  'issue.comment',
  'issue.close',
  'experiment.propose',
  'experiment.review',
  'experiment.close',
  'ci.request',
  'ticket.submit',
]

// ---------------------------------------------------------------------------
// Harness: one isolated API, executor and audit port per test.
// ---------------------------------------------------------------------------

interface SuccessBehavior {
  readonly route: CommandType
  readonly kind: 'success'
  readonly value: unknown
  readonly audit: AuditEntry
}

interface RefusalBehavior {
  readonly route: CommandType
  readonly kind: 'refusal'
  readonly error: DomainError
  readonly audit: AuditEntry
}

type Behavior = SuccessBehavior | RefusalBehavior

interface SeenCall {
  readonly route: CommandType
  readonly command: unknown
  readonly context: unknown
}

interface HostCall {
  readonly route: CommandType
  readonly body: unknown
  readonly params: readonly RouteParameter[]
  readonly context: {
    readonly actor: Principal
    readonly at: IsoTimestamp
    readonly requestId: RequestId
  }
}

interface HarnessOptions {
  readonly behaviors?: readonly Behavior[]
  readonly hostFailures?: readonly CommandType[]
}

interface Harness {
  readonly api: Api
  readonly calls: CommandType[]
  readonly seen: SeenCall[]
  readonly refusals: RefusedCommandFacts[]
  readonly hostCalls: HostCall[]
  readonly requestIds: RequestId[]
}

/** A response must run only the routes a test configured; any other slot fails loudly. */
function makeExecutor(
  behaviors: readonly Behavior[],
  calls: CommandType[],
  seen: SeenCall[],
): CommandExecutor {
  const handler = <K extends CommandType>(route: K): CommandExecutor[K] => {
    return async (command, context) => {
      calls.push(route)
      seen.push({ route, command, context })
      const behavior = behaviors.find((candidate) => candidate.route === route)
      if (behavior === undefined) {
        throw new Error(`executor slot ${route} must not run for this test`)
      }
      if (behavior.kind === 'success') {
        return forged<CommandOutcome<K>>({
          ok: true,
          value: behavior.value,
          audit: [behavior.audit],
        })
      }
      return forged<CommandOutcome<K>>({
        ok: false,
        error: behavior.error,
        audit: [behavior.audit],
      })
    }
  }

  return {
    'program.create': handler('program.create'),
    'program.pause': handler('program.pause'),
    'program.resume': handler('program.resume'),
    'program.stop': handler('program.stop'),
    'program.set-goal': handler('program.set-goal'),
    'program.set-methodology': handler('program.set-methodology'),
    'program.set-exploration': handler('program.set-exploration'),
    'issue.create': handler('issue.create'),
    'issue.claim': handler('issue.claim'),
    'issue.comment': handler('issue.comment'),
    'issue.close': handler('issue.close'),
    'experiment.propose': handler('experiment.propose'),
    'experiment.review': handler('experiment.review'),
    'experiment.close': handler('experiment.close'),
    'ci.request': handler('ci.request'),
    'ticket.submit': handler('ticket.submit'),
  }
}

/**
 * A total Host resolver table. The base fields are always present; only the commands
 * whose type declares a proof receive one, so a test cannot accidentally omit it for a
 * route that needs it.
 */
function makeHostContexts(
  failures: readonly CommandType[],
  calls: HostCall[],
): HostContextResolvers {
  const resolve = <K extends CommandType>(
    request: HostContextRequest<K>,
    fields: HostContextFields<K>,
  ): Result<HostContextFields<K>, DomainError> => {
    calls.push({
      route: request.route,
      body: request.body,
      params: request.params,
      context: request.context,
    })
    if (failures.includes(request.route)) return { ok: false, error: HOST_FAILURE }
    return { ok: true, value: fields }
  }

  return {
    'program.create': (request) => resolve(request, { programId: PROGRAM_ID }),
    'program.pause': (request) => resolve(request, { programId: PROGRAM_ID }),
    'program.resume': (request) => resolve(request, { programId: PROGRAM_ID }),
    'program.stop': (request) => resolve(request, { programId: PROGRAM_ID }),
    'program.set-goal': (request) => resolve(request, { programId: PROGRAM_ID }),
    'program.set-methodology': (request) => resolve(request, { programId: PROGRAM_ID }),
    'program.set-exploration': (request) => resolve(request, { programId: PROGRAM_ID }),
    'issue.create': (request) => resolve(request, { programId: PROGRAM_ID }),
    'issue.claim': (request) => resolve(request, { programId: PROGRAM_ID }),
    'issue.comment': (request) => resolve(request, { programId: PROGRAM_ID }),
    'issue.close': (request) => resolve(request, { programId: PROGRAM_ID }),
    'experiment.propose': (request) =>
      resolve(request, { programId: PROGRAM_ID, assignment: ASSIGNMENT }),
    'experiment.review': (request) =>
      resolve(request, { programId: PROGRAM_ID, assignment: ASSIGNMENT }),
    'experiment.close': (request) =>
      resolve(request, { programId: PROGRAM_ID, assignment: ASSIGNMENT }),
    'ci.request': (request) => resolve(request, { programId: PROGRAM_ID }),
    'ticket.submit': (request) => resolve(request, { programId: PROGRAM_ID, binding: BINDING }),
  }
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const calls: CommandType[] = []
  const seen: SeenCall[] = []
  const refusals: RefusedCommandFacts[] = []
  const hostCalls: HostCall[] = []
  const issued: RequestId[] = []

  const requestIds: RequestIdSource = {
    next: () => {
      const id = forged<RequestId>(`request-${issued.length + 1}`)
      issued.push(id)
      return id
    },
  }
  const clock: Clock = { now: () => AT }

  const api = createApi({
    parsers: COMMAND_PARSERS,
    executor: makeExecutor(options.behaviors ?? [], calls, seen),
    clock,
    requestIds,
    hostContexts: makeHostContexts(options.hostFailures ?? [], hostCalls),
    refusalAudit: {
      record: (facts) => {
        refusals.push(facts)
        return REFUSAL_ENTRY
      },
    },
  })

  return { api, calls, seen, refusals, hostCalls, requestIds: issued }
}

function request(path: string, actor: Principal, body: unknown): HttpRequest {
  return { method: 'POST', path, body, actor }
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

test('ROUTE_TABLE covers every command with one unambiguous path', () => {
  assert.deepEqual(Object.keys(ROUTE_TABLE).sort(), [...COMMAND_TYPES].sort())

  const paths = new Set<string>()
  for (const command of COMMAND_TYPES) {
    const route = ROUTE_TABLE[command]
    assert.equal(route.command, command)
    assert.match(route.path, /^\/aleph\/api\//)
    assert.equal(paths.has(route.path), false, `duplicate route path ${route.path}`)
    paths.add(route.path)
  }
  assert.equal(paths.size, COMMAND_TYPES.length)
  assert.equal(ROUTE_TABLE['program.create'].successStatus, 201)
  assert.equal(ROUTE_TABLE['program.pause'].successStatus, 200)
})

test('an unknown path is a 404 and runs nothing', async () => {
  const harness = makeHarness()
  const response = await harness.api.handle(
    request('/aleph/api/programs/program-1/unknown', operator, {}),
  )

  assert.equal(response.status, 404)
  assert.deepEqual(response.body, { ok: false, error: { code: 'not-found' } })
  assert.deepEqual(harness.calls, [])
  assert.deepEqual(harness.refusals, [])
  assert.deepEqual(harness.hostCalls, [])
  assert.deepEqual(harness.requestIds, [])
})

// ---------------------------------------------------------------------------
// Parser refusal
// ---------------------------------------------------------------------------

test('a parser failure is audited and never reaches the executor', async () => {
  const parsed = COMMAND_PARSERS['program.create']({})
  assert.equal(parsed.ok, false)
  if (parsed.ok) throw new Error('the empty body must not parse')

  const harness = makeHarness()
  const response = await harness.api.handle(request('/aleph/api/programs', operator, {}))

  assert.equal(response.status, 400)
  assert.deepEqual(response.body, {
    ok: false,
    status: 400,
    error: parsed.error,
    audit: [REFUSAL_ENTRY],
  })
  assert.deepEqual(harness.calls, [], 'no executor slot may run after a parse failure')
  assert.deepEqual(harness.seen, [])
  assert.deepEqual(harness.refusals, [
    {
      actor: operator,
      route: 'program.create',
      programId: PROGRAM_ID,
      at: AT,
      requestId: REQUEST_1,
      reason: parsed.error.message,
    },
  ])
})

// ---------------------------------------------------------------------------
// Host resolver refusal
// ---------------------------------------------------------------------------

test('a Host resolver failure is a 403 before parsing or execution', async () => {
  const harness = makeHarness({ hostFailures: ['program.pause'] })
  const response = await harness.api.handle(
    request('/aleph/api/programs/program-1/pause', operator, {}),
  )

  assert.equal(response.status, 403)
  assert.deepEqual(response.body, {
    ok: false,
    status: 403,
    error: { code: 'forbidden', message: HOST_FAILURE.message },
  })
  assert.equal(harness.hostCalls.length, 1)
  assert.deepEqual(harness.calls, [])
  assert.deepEqual(harness.refusals, [], 'the resolver failure is not a parsed command refusal')
})

test('an actor that cannot issue the route is a 403 before the Host resolve', async () => {
  const harness = makeHarness()
  const response = await harness.api.handle(
    request('/aleph/api/programs/program-1/pause', researcher, {}),
  )

  assert.equal(response.status, 403)
  assert.deepEqual(response.body, {
    ok: false,
    status: 403,
    error: { code: 'forbidden', message: 'actor is not allowed to issue program.pause' },
  })
  assert.deepEqual(harness.hostCalls, [])
  assert.deepEqual(harness.calls, [])
  assert.deepEqual(harness.requestIds, [])
})

// ---------------------------------------------------------------------------
// Success and refusal translation
// ---------------------------------------------------------------------------

test('a successful create is 201 with value and audit; an action is 200', async () => {
  const harness = makeHarness({
    behaviors: [
      { route: 'program.create', kind: 'success', value: { status: 'running' }, audit: CREATED_AUDIT },
      { route: 'program.pause', kind: 'success', value: { status: 'paused' }, audit: PAUSED_AUDIT },
    ],
  })

  const created = await harness.api.handle(
    request('/aleph/api/programs', operator, CREATE_PROGRAM_BODY),
  )
  assert.equal(created.status, 201)
  assert.deepEqual(created.body, {
    ok: true,
    value: { status: 'running' },
    audit: [CREATED_AUDIT],
  })

  const paused = await harness.api.handle(
    request('/aleph/api/programs/program-1/pause', operator, {}),
  )
  assert.equal(paused.status, 200)
  assert.deepEqual(paused.body, {
    ok: true,
    value: { status: 'paused' },
    audit: [PAUSED_AUDIT],
  })

  assert.deepEqual(harness.calls, ['program.create', 'program.pause'])
  assert.deepEqual(harness.seen[0]?.command, {
    type: 'program.create',
    ...CREATE_PROGRAM_BODY,
  })
  assert.deepEqual(harness.seen[0]?.context, {
    actor: operator,
    at: AT,
    requestId: REQUEST_1,
  })
  assert.deepEqual(harness.seen[1]?.command, {
    type: 'program.pause',
    programId: PROGRAM_ID,
  })
  assert.deepEqual(harness.seen[1]?.context, {
    actor: operator,
    at: AT,
    requestId: REQUEST_2,
  })
})

const ERRORS: readonly DomainError[] = [
  { code: 'not-found', message: MESSAGE },
  { code: 'conflict', message: MESSAGE },
  { code: 'version-conflict', message: MESSAGE },
  { code: 'forbidden', message: MESSAGE },
  { code: 'invalid-state', message: MESSAGE },
  { code: 'invalid-input', message: MESSAGE },
  { code: 'budget-exhausted', message: MESSAGE },
  { code: 'ci-not-passed', message: MESSAGE },
  { code: 'environment-invalid', message: MESSAGE },
  { code: 'sampling-unavailable', message: MESSAGE },
]

const EXPECTED_STATUS: { readonly [C in DomainErrorCode]: number } = {
  'not-found': 404,
  conflict: 409,
  'version-conflict': 409,
  forbidden: 403,
  'invalid-state': 409,
  'invalid-input': 400,
  'budget-exhausted': 422,
  'ci-not-passed': 422,
  'environment-invalid': 422,
  'sampling-unavailable': 422,
}

test('every DomainErrorCode maps to its status through an execution refusal', async () => {
  for (const error of ERRORS) {
    const harness = makeHarness({
      behaviors: [{ route: 'program.pause', kind: 'refusal', error, audit: REFUSAL_ENTRY }],
    })
    const response = await harness.api.handle(
      request('/aleph/api/programs/program-1/pause', operator, {}),
    )
    const expected = EXPECTED_STATUS[error.code]
    const failure = toDomainFailure(error)

    assert.equal(httpStatusForError(error.code), expected)
    assert.equal(failure.status, expected)
    assert.strictEqual(failure.error, error)
    assert.equal(response.status, expected)
    assert.deepEqual(response.body, {
      ok: false,
      status: expected,
      error,
      audit: [REFUSAL_ENTRY],
    })
    assert.deepEqual(harness.refusals, [], 'the executor owns its refusal audit')
  }
})

// ---------------------------------------------------------------------------
// Coverage across command families
// ---------------------------------------------------------------------------

test('one route per command family reaches exactly its executor slot', async () => {
  const harness = makeHarness({
    behaviors: [
      { route: 'program.pause', kind: 'success', value: { status: 'paused' }, audit: PAUSED_AUDIT },
      { route: 'issue.claim', kind: 'success', value: { status: 'assigned' }, audit: CLAIMED_AUDIT },
      {
        route: 'experiment.review',
        kind: 'success',
        value: { verdict: 'approve' },
        audit: REVIEWED_AUDIT,
      },
      {
        route: 'ci.request',
        kind: 'success',
        value: { status: 'ci-pending' },
        audit: CI_REQUESTED_AUDIT,
      },
      { route: 'ticket.submit', kind: 'success', value: { status: 'ready' }, audit: READY_AUDIT },
    ],
  })

  const responses = [
    await harness.api.handle(request('/aleph/api/programs/program-1/pause', operator, {})),
    await harness.api.handle(
      request('/aleph/api/programs/program-1/issues/issue-1/claim', researcher, {}),
    ),
    await harness.api.handle(
      request('/aleph/api/programs/program-1/experiments/experiment-1/reviews', researcher, {
        body: 'solid method',
        verdict: 'approve',
      }),
    ),
    await harness.api.handle(
      request('/aleph/api/programs/program-1/experiments/experiment-1/ci', researcher, {}),
    ),
    await harness.api.handle(request('/aleph/api/tickets/submit', implementer, SUBMIT_BODY)),
  ]

  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200, 200, 200, 200],
  )
  assert.deepEqual(harness.calls, [
    'program.pause',
    'issue.claim',
    'experiment.review',
    'ci.request',
    'ticket.submit',
  ])
  assert.deepEqual(
    harness.hostCalls.map((call) => call.route),
    ['program.pause', 'issue.claim', 'experiment.review', 'ci.request', 'ticket.submit'],
  )
  assert.deepEqual(harness.seen[0]?.command, {
    type: 'program.pause',
    programId: PROGRAM_ID,
  })
  assert.deepEqual(harness.seen[1]?.command, {
    type: 'issue.claim',
    programId: PROGRAM_ID,
    issueId: ISSUE_ID,
  })
  assert.deepEqual(harness.seen[2]?.command, {
    type: 'experiment.review',
    programId: PROGRAM_ID,
    experimentId: EXPERIMENT_ID,
    assignment: ASSIGNMENT,
    body: 'solid method',
    verdict: 'approve',
  })
  assert.deepEqual(harness.seen[3]?.command, {
    type: 'ci.request',
    programId: PROGRAM_ID,
    experimentId: EXPERIMENT_ID,
  })
  assert.deepEqual(harness.seen[4]?.command, {
    type: 'ticket.submit',
    binding: BINDING,
    head: HEAD,
    environment: ENVIRONMENT,
  })
})

// ---------------------------------------------------------------------------
// Host-owned fields and path authority
// ---------------------------------------------------------------------------

test('Host-injected fields cannot be supplied by the request body', async () => {
  const harness = makeHarness()

  const proposed = await harness.api.handle(
    request('/aleph/api/programs/program-1/issues/issue-1/experiments', researcher, {
      ...PLAN_BODY,
      assignment: { issueId: ISSUE_ID, assignee: researcher },
    }),
  )
  assert.equal(proposed.status, 400)

  const submitted = await harness.api.handle(
    request('/aleph/api/tickets/submit', implementer, {
      ...SUBMIT_BODY,
      binding: BINDING,
    }),
  )
  assert.equal(submitted.status, 400)

  assert.deepEqual(harness.calls, [], 'a body that tries to inject a proof never executes')
  assert.equal(harness.refusals.length, 2)
  assert.deepEqual(
    harness.refusals.map((facts) => facts.route),
    ['experiment.propose', 'ticket.submit'],
  )
})

test('the path program id overrides a conflicting body field', async () => {
  const harness = makeHarness({
    behaviors: [
      { route: 'program.pause', kind: 'success', value: { status: 'paused' }, audit: PAUSED_AUDIT },
    ],
  })
  const response = await harness.api.handle(
    request('/aleph/api/programs/path-program/pause', operator, { programId: 'body-program' }),
  )

  assert.equal(response.status, 200)
  assert.deepEqual(harness.seen[0]?.command, {
    type: 'program.pause',
    programId: forged<ProgramId>('path-program'),
  })
})
