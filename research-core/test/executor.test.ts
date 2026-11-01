/**
 * Runtime tests for the single write path.
 *
 * These tests prove the properties the type surface cannot: a route parses only the
 * model-supplied fields, the Host proofs are merged in afterwards, a parser failure is
 * audited as `command.refused` and never reaches an executor slot, and exactly one slot
 * runs per route.
 *
 * `research-core` is still a declaration-only blueprint, so the nominal values the Host
 * mints (principals, ownership tokens, branded ids) have no runtime constructors. The
 * fixtures below stand in for them; `forged` is the only assertion in this file, it is
 * confined to test fixtures and it is stripped together with every other type.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { AuditEntryOf } from '../src/types/audit.js'
import type {
  ImplementerPrincipal,
  IssueAssignment,
  OperatorPrincipal,
  ResearcherPrincipal,
  TicketBinding,
} from '../src/types/actors.js'
import type { CommandContext, CommandOutcome, CommandType } from '../src/types/commands.js'
import type { EnvironmentDeclaration } from '../src/types/environment.js'
import type { DomainError, Err } from '../src/types/errors.js'
import type { CommandExecutor } from '../src/types/executor.js'
import type { ExperimentPlan, OpenExperiment, ReadyExperiment } from '../src/types/experiment.js'
import type {
  CommitSha,
  ExperimentId,
  ImplementerSessionId,
  IsoTimestamp,
  IssueId,
  NonEmptyString,
  ProgramId,
  RequestId,
  TicketId,
} from '../src/types/ids.js'
import type { PausedProgram } from '../src/types/program.js'
import type { Clock } from '../src/types/services.js'
import {
  executeRoute,
  type AuditSubjectParsers,
  type HostContext,
  type ModelCommandOf,
  type RefusalAuditPort,
  type RefusedCommandFacts,
  type WriteRoutes,
} from '../src/runtime/executor.js'

/** Stand-in for a value the Host mints through its factory/hydration boundary. */
function forged<T>(value: unknown): T {
  return value as T
}

const AT = forged<IsoTimestamp>('2026-11-02T00:00:00.000Z')
const REQUEST_ID = forged<RequestId>('request-1')
const PROGRAM_ID = forged<ProgramId>('program-1')
const OTHER_PROGRAM_ID = forged<ProgramId>('program-9')
const ISSUE_ID = forged<IssueId>('issue-1')
const TICKET_ID = forged<TicketId>('ticket-1')
const EXPERIMENT_ID = forged<ExperimentId>('experiment-1')
const IMPLEMENTER_SESSION = forged<ImplementerSessionId>('implementer-session')
const HEAD = forged<CommitSha>('0123456789abcdef0123456789abcdef01234567')

const operator = forged<OperatorPrincipal>({ kind: 'operator', sessionId: 'operator-session' })
const researcher = forged<ResearcherPrincipal>({ kind: 'researcher', sessionId: 'researcher-session' })
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
const PLAN = forged<ExperimentPlan>({ hypothesis: 'a wider clipping window is better' })
const ENVIRONMENT = forged<EnvironmentDeclaration>({ python: '3.12' })

const clock: Clock = { now: () => AT }

const pauseContext: CommandContext<'program.pause'> = { actor: operator, at: AT, requestId: REQUEST_ID }
const resumeContext: CommandContext<'program.resume'> = { actor: operator, at: AT, requestId: REQUEST_ID }
const createContext: CommandContext<'program.create'> = { actor: operator, at: AT, requestId: REQUEST_ID }
const proposeContext: CommandContext<'experiment.propose'> = { actor: researcher, at: AT, requestId: REQUEST_ID }
const submitContext: CommandContext<'ticket.submit'> = { actor: implementer, at: AT, requestId: REQUEST_ID }

const pauseHost: HostContext<'program.pause'> = { context: pauseContext, programId: PROGRAM_ID }
const resumeHost: HostContext<'program.resume'> = { context: resumeContext, programId: PROGRAM_ID }
const createHost: HostContext<'program.create'> = { context: createContext, programId: PROGRAM_ID }
const proposeHost: HostContext<'experiment.propose'> = {
  context: proposeContext,
  programId: PROGRAM_ID,
  assignment: ASSIGNMENT,
}
const submitHost: HostContext<'ticket.submit'> = {
  context: submitContext,
  programId: PROGRAM_ID,
  binding: BINDING,
}

const PAUSE_MODEL: ModelCommandOf<'program.pause'> = { type: 'program.pause', programId: PROGRAM_ID }
const RESUME_MODEL: ModelCommandOf<'program.resume'> = { type: 'program.resume', programId: PROGRAM_ID }
const PROPOSE_MODEL: ModelCommandOf<'experiment.propose'> = {
  type: 'experiment.propose',
  programId: PROGRAM_ID,
  issueId: ISSUE_ID,
  plan: PLAN,
}
const SUBMIT_MODEL: ModelCommandOf<'ticket.submit'> = {
  type: 'ticket.submit',
  head: HEAD,
  environment: ENVIRONMENT,
}

const PARSE_FAILURE: DomainError = {
  code: 'invalid-input',
  message: forged<NonEmptyString>('the body is not a program.create command'),
}
const NOT_ROUTED: Err<DomainError> = { ok: false, error: PARSE_FAILURE }

const REFUSAL_ENTRY = forged<AuditEntryOf<'command.refused'>>({ action: 'command.refused' })
const PAUSE_OUTCOME: CommandOutcome<'program.pause'> = {
  ok: true,
  value: forged<PausedProgram>({ status: 'paused' }),
  audit: [forged<AuditEntryOf<'program.paused'>>({ action: 'program.paused' })],
}
const PROPOSE_OUTCOME: CommandOutcome<'experiment.propose'> = {
  ok: true,
  value: forged<OpenExperiment>({ status: 'open' }),
  audit: [forged<AuditEntryOf<'experiment.proposed'>>({ action: 'experiment.proposed' })],
}
const SUBMIT_OUTCOME: CommandOutcome<'ticket.submit'> = {
  ok: true,
  value: forged<ReadyExperiment>({ status: 'ready' }),
  audit: [forged<AuditEntryOf<'experiment.ready'>>({ action: 'experiment.ready' })],
}
const RESUME_OUTCOME: CommandOutcome<'program.resume'> = {
  ok: false,
  error: forged<DomainError>({ code: 'invalid-state', message: forged<NonEmptyString>('the program is not paused') }),
  audit: [REFUSAL_ENTRY],
}

/** The boundary parser the executor injects: it only reads the Program named by a body. */
const parsers: AuditSubjectParsers = {
  programId: (input) => {
    if (typeof input !== 'object' || input === null) return NOT_ROUTED
    if (!('programId' in input)) return NOT_ROUTED
    const value = input.programId
    if (typeof value !== 'string' || value.length === 0) return NOT_ROUTED
    return { ok: true, value: forged<ProgramId>(value) }
  },
}

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

/** One isolated executor, route table and audit port per test. */
function makeHarness() {
  const calls: CommandType[] = []
  const seen: { readonly route: CommandType; readonly command: unknown; readonly context: unknown }[] = []
  const parsedModels: unknown[] = []
  const injected: unknown[] = []
  const refusals: RefusedCommandFacts[] = []

  const routes: WriteRoutes = {
    'program.create': () => NOT_ROUTED,
    'program.pause': () => {
      parsedModels.push(PAUSE_MODEL)
      return { ok: true, value: PAUSE_MODEL }
    },
    'program.resume': () => {
      parsedModels.push(RESUME_MODEL)
      return { ok: true, value: RESUME_MODEL }
    },
    'program.stop': () => NOT_ROUTED,
    'program.set-goal': () => NOT_ROUTED,
    'program.set-methodology': () => NOT_ROUTED,
    'program.set-exploration': () => NOT_ROUTED,
    'issue.create': () => NOT_ROUTED,
    'issue.claim': () => NOT_ROUTED,
    'issue.comment': () => NOT_ROUTED,
    'issue.close': () => NOT_ROUTED,
    'experiment.propose': () => {
      parsedModels.push(PROPOSE_MODEL)
      return { ok: true, value: PROPOSE_MODEL }
    },
    'experiment.review': () => NOT_ROUTED,
    'experiment.close': () => NOT_ROUTED,
    'ci.request': () => NOT_ROUTED,
    'ticket.submit': () => {
      parsedModels.push(SUBMIT_MODEL)
      return { ok: true, value: SUBMIT_MODEL }
    },
  }

  const unexpected = (slot: CommandType) => async (): Promise<never> => {
    calls.push(slot)
    throw new Error(`executor slot ${slot} must not run for this route`)
  }

  const executor: CommandExecutor = {
    'program.create': unexpected('program.create'),
    'program.pause': async (command, context) => {
      calls.push('program.pause')
      seen.push({ route: 'program.pause', command, context })
      return PAUSE_OUTCOME
    },
    'program.resume': async (command, context) => {
      calls.push('program.resume')
      seen.push({ route: 'program.resume', command, context })
      return RESUME_OUTCOME
    },
    'program.stop': unexpected('program.stop'),
    'program.set-goal': unexpected('program.set-goal'),
    'program.set-methodology': unexpected('program.set-methodology'),
    'program.set-exploration': unexpected('program.set-exploration'),
    'issue.create': unexpected('issue.create'),
    'issue.claim': unexpected('issue.claim'),
    'issue.comment': unexpected('issue.comment'),
    'issue.close': unexpected('issue.close'),
    'experiment.propose': async (command, context) => {
      calls.push('experiment.propose')
      seen.push({ route: 'experiment.propose', command, context })
      injected.push(command.assignment)
      return PROPOSE_OUTCOME
    },
    'experiment.review': unexpected('experiment.review'),
    'experiment.close': unexpected('experiment.close'),
    'ci.request': unexpected('ci.request'),
    'ticket.submit': async (command, context) => {
      calls.push('ticket.submit')
      seen.push({ route: 'ticket.submit', command, context })
      injected.push(command.binding)
      return SUBMIT_OUTCOME
    },
  }

  const refuse: RefusalAuditPort = {
    record: (facts) => {
      refusals.push(facts)
      return REFUSAL_ENTRY
    },
  }

  return { calls, seen, parsedModels, injected, refusals, routes, executor, refuse }
}

test('the route table and the executor cover every command literal', () => {
  const harness = makeHarness()
  assert.deepEqual(Object.keys(harness.routes).sort(), [...COMMAND_TYPES].sort())
  assert.deepEqual(Object.keys(harness.executor).sort(), [...COMMAND_TYPES].sort())
})

test('a parser failure is audited as command.refused and never reaches the executor', async () => {
  const harness = makeHarness()
  const outcome = await executeRoute(
    harness.routes,
    parsers,
    harness.executor,
    operator,
    'program.create',
    {},
    createHost,
    clock,
    REQUEST_ID,
    harness.refuse,
  )

  assert.equal(outcome.ok, false)
  if (outcome.ok) throw new Error('the route should have refused')
  assert.strictEqual(outcome.error, PARSE_FAILURE, 'the parser refusal is passed through unchanged')
  assert.deepEqual(outcome.audit, [REFUSAL_ENTRY])
  assert.deepEqual(harness.calls, [], 'no executor slot may run after a parse failure')
  assert.deepEqual(harness.seen, [])
  assert.equal(harness.refusals.length, 1)
  assert.deepEqual(harness.refusals[0], {
    actor: operator,
    route: 'program.create',
    programId: PROGRAM_ID,
    at: AT,
    requestId: REQUEST_ID,
    reason: PARSE_FAILURE.message,
  })
})

test('a refusal is audited against the Program named by the body', async () => {
  const harness = makeHarness()
  const outcome = await executeRoute(
    harness.routes,
    parsers,
    harness.executor,
    operator,
    'program.create',
    { programId: 'program-9' },
    createHost,
    clock,
    REQUEST_ID,
    harness.refuse,
  )

  assert.equal(outcome.ok, false)
  assert.equal(harness.refusals.length, 1)
  assert.equal(harness.refusals[0].programId, OTHER_PROGRAM_ID)
})

test('a valid route calls exactly one executor slot and returns its outcome unchanged', async () => {
  const harness = makeHarness()
  const outcome = await executeRoute(
    harness.routes,
    parsers,
    harness.executor,
    operator,
    'program.pause',
    {},
    pauseHost,
    clock,
    REQUEST_ID,
    harness.refuse,
  )

  assert.strictEqual(outcome, PAUSE_OUTCOME, 'the executor outcome is returned unchanged')
  assert.deepEqual(harness.calls, ['program.pause'])
  assert.deepEqual(harness.refusals, [])
  assert.equal(harness.seen.length, 1)
  assert.equal(harness.seen[0].route, 'program.pause')
  assert.deepEqual(harness.seen[0].command, PAUSE_MODEL)
  assert.strictEqual(harness.seen[0].context, pauseHost.context, 'the Host context is passed through')
})

test('the Host assignment is merged into the proposed command only', async () => {
  const harness = makeHarness()
  const outcome = await executeRoute(
    harness.routes,
    parsers,
    harness.executor,
    researcher,
    'experiment.propose',
    {},
    proposeHost,
    clock,
    REQUEST_ID,
    harness.refuse,
  )

  assert.strictEqual(outcome, PROPOSE_OUTCOME)
  assert.deepEqual(harness.calls, ['experiment.propose'])
  assert.deepEqual(harness.parsedModels, [PROPOSE_MODEL], 'the route returned the model fields only')
  assert.deepEqual(harness.seen[0].command, { ...PROPOSE_MODEL, assignment: ASSIGNMENT })
  assert.notStrictEqual(harness.seen[0].command, harness.parsedModels[0], 'the merge does not mutate the model command')
  assert.strictEqual(harness.injected[0], ASSIGNMENT, 'the Host minted the exact proof it passed')
})

test('the Host binding is merged into the submitted command only', async () => {
  const harness = makeHarness()
  const outcome = await executeRoute(
    harness.routes,
    parsers,
    harness.executor,
    implementer,
    'ticket.submit',
    {},
    submitHost,
    clock,
    REQUEST_ID,
    harness.refuse,
  )

  assert.strictEqual(outcome, SUBMIT_OUTCOME)
  assert.deepEqual(harness.calls, ['ticket.submit'])
  assert.deepEqual(harness.parsedModels, [SUBMIT_MODEL])
  assert.deepEqual(harness.seen[0].command, { ...SUBMIT_MODEL, binding: BINDING })
  assert.notStrictEqual(harness.seen[0].command, harness.parsedModels[0])
  assert.strictEqual(harness.injected[0], BINDING)
})

test('consecutive routes reach only their own executor slot', async () => {
  const harness = makeHarness()
  await executeRoute(
    harness.routes,
    parsers,
    harness.executor,
    operator,
    'program.pause',
    {},
    pauseHost,
    clock,
    REQUEST_ID,
    harness.refuse,
  )
  const outcome = await executeRoute(
    harness.routes,
    parsers,
    harness.executor,
    operator,
    'program.resume',
    {},
    resumeHost,
    clock,
    REQUEST_ID,
    harness.refuse,
  )

  assert.strictEqual(outcome, RESUME_OUTCOME)
  assert.deepEqual(harness.calls, ['program.pause', 'program.resume'])
  assert.deepEqual(harness.seen.map((entry) => entry.route), ['program.pause', 'program.resume'])
})

test('an executor refusal is returned unchanged and not re-audited by the write path', async () => {
  const harness = makeHarness()
  const outcome = await executeRoute(
    harness.routes,
    parsers,
    harness.executor,
    operator,
    'program.resume',
    {},
    resumeHost,
    clock,
    REQUEST_ID,
    harness.refuse,
  )

  assert.strictEqual(outcome, RESUME_OUTCOME)
  assert.deepEqual(harness.refusals, [], 'the executor owns its audit; the write path only audits parse failures')
})
