/**
 * Typed HTTP boundary over the command parsers and the single write executor.
 *
 * The boundary owns routing, request identity, actor admission and the translation of a
 * command outcome into an HTTP response. It owns no command semantics: every body is
 * parsed by the injected parser table, every command runs through `executeRoute` (the
 * single write path), and the ownership proofs (`assignment`, `binding`, a future
 * `ciRequestToken`) come only from the injected Host resolve step, never from the body.
 *
 * Two failure modes are handled before a command can run:
 *
 * - an unknown path is a `not-found` response, not an exception;
 * - an actor that cannot issue the route's command, or a Host that cannot resolve the
 *   ownership context, is a `forbidden` response.
 *
 * A parser failure is not handled here: `executeRoute` records it through the injected
 * refusal-audit port and returns it, so a refused body is audited even though no
 * executor slot runs. `toDomainFailure` is the total `DomainErrorCode` -> status map;
 * it contains no assertion and no default branch, so a new code is a compile error.
 */
import type { Principal } from '../types/actors.js'
import type {
  ActorOfCommand,
  CommandContext,
  CommandOutcome,
  CommandType,
} from '../types/commands.js'
import type {
  DomainError,
  DomainErrorCode,
  DomainFailure,
  HttpStatusForError,
  Result,
} from '../types/errors.js'
import type { CommandExecutor } from '../types/executor.js'
import type { NonEmptyString, ProgramId, RequestId } from '../types/ids.js'
import type { Clock } from '../types/services.js'
import type { CommandParsers } from '../parsers-commands.js'
import {
  executeRoute,
  type AuditSubjectParsers,
  type HostContext,
  type HostInjectedFields,
  type RefusalAuditPort,
} from './executor.js'

/** One request as the web adapter hands it to the boundary. */
export interface HttpRequest {
  readonly method: 'POST'
  readonly path: string
  readonly body: unknown
  readonly actor: Principal
}

/** The transport-neutral response the adapter writes back. */
export interface HttpResponse {
  readonly status: number
  readonly body: unknown
}

/** The identifiers a route takes from its path rather than from the request body. */
export type RouteParameterName = 'programId' | 'issueId' | 'experimentId'

/** One path segment captured from a matched route. */
export interface RouteParameter {
  readonly name: RouteParameterName
  readonly value: string
}

/** One write route: the command it runs and the status a success produces. */
export interface RouteSpec<K extends CommandType> {
  readonly command: K
  readonly path: string
  readonly successStatus: 200 | 201
}

/**
 * The complete write route table.
 *
 * The mapped type is the completeness proof: a new `CommandType` without a route does
 * not compile. Paths are matched literally except for `:name` segments, which the
 * boundary merges into the parsed body (and only there) so a body cannot name a
 * different Program or Issue than the path it was sent to.
 */
export const ROUTE_TABLE: { readonly [K in CommandType]: RouteSpec<K> } = {
  'program.create': { command: 'program.create', path: '/aleph/api/programs', successStatus: 201 },
  'program.pause': {
    command: 'program.pause',
    path: '/aleph/api/programs/:programId/pause',
    successStatus: 200,
  },
  'program.resume': {
    command: 'program.resume',
    path: '/aleph/api/programs/:programId/resume',
    successStatus: 200,
  },
  'program.stop': {
    command: 'program.stop',
    path: '/aleph/api/programs/:programId/stop',
    successStatus: 200,
  },
  'program.set-goal': {
    command: 'program.set-goal',
    path: '/aleph/api/programs/:programId/goal',
    successStatus: 200,
  },
  'program.set-methodology': {
    command: 'program.set-methodology',
    path: '/aleph/api/programs/:programId/methodology',
    successStatus: 200,
  },
  'program.set-exploration': {
    command: 'program.set-exploration',
    path: '/aleph/api/programs/:programId/exploration',
    successStatus: 200,
  },
  'issue.create': {
    command: 'issue.create',
    path: '/aleph/api/programs/:programId/issues',
    successStatus: 201,
  },
  'issue.claim': {
    command: 'issue.claim',
    path: '/aleph/api/programs/:programId/issues/:issueId/claim',
    successStatus: 200,
  },
  'issue.comment': {
    command: 'issue.comment',
    path: '/aleph/api/programs/:programId/issues/:issueId/comments',
    successStatus: 200,
  },
  'issue.close': {
    command: 'issue.close',
    path: '/aleph/api/programs/:programId/issues/:issueId/close',
    successStatus: 200,
  },
  'experiment.propose': {
    command: 'experiment.propose',
    path: '/aleph/api/programs/:programId/issues/:issueId/experiments',
    successStatus: 201,
  },
  'experiment.review': {
    command: 'experiment.review',
    path: '/aleph/api/programs/:programId/experiments/:experimentId/reviews',
    successStatus: 200,
  },
  'experiment.close': {
    command: 'experiment.close',
    path: '/aleph/api/programs/:programId/experiments/:experimentId/close',
    successStatus: 200,
  },
  'ci.request': {
    command: 'ci.request',
    path: '/aleph/api/programs/:programId/experiments/:experimentId/ci',
    successStatus: 200,
  },
  'ticket.submit': {
    command: 'ticket.submit',
    path: '/aleph/api/tickets/submit',
    successStatus: 200,
  },
}

/** A matched route and the path parameters it captured, in pattern order. */
export interface RouteMatch {
  readonly route: RouteSpec<CommandType>
  readonly params: readonly RouteParameter[]
}

/** The injected request-id allocator; one id is recorded per accepted route. */
export interface RequestIdSource {
  next(): RequestId
}

/**
 * What the Host resolver sees for one request. `body` is the raw untrusted body and is
 * deliberately not merged with the path parameters: the resolver decides ownership from
 * the actor and the route, and the boundary uses the parameters only for parsing.
 */
export interface HostContextRequest<K extends CommandType> {
  readonly route: K
  readonly context: CommandContext<K>
  readonly body: unknown
  readonly params: readonly RouteParameter[]
}

/** What only the Host may supply for a command: the audited Program and its proofs. */
export type HostContextFields<K extends CommandType> = {
  readonly programId: ProgramId
} & HostInjectedFields<K>

/** One per-command Host resolve step; it returns only the Host-owned fields. */
export type HostContextResolver<K extends CommandType> = (
  request: HostContextRequest<K>,
) => Result<HostContextFields<K>, DomainError>

/**
 * The Host resolver table, total over every command. A command that requires an
 * ownership proof cannot be routed without a resolver that produces it.
 */
export type HostContextResolvers = {
  readonly [K in CommandType]: HostContextResolver<K>
}

/** The ports and tables the boundary composes; all are supplied by the adapter. */
export interface ApiDependencies {
  readonly parsers: CommandParsers
  readonly executor: CommandExecutor
  readonly clock: Clock
  readonly requestIds: RequestIdSource
  readonly hostContexts: HostContextResolvers
  readonly refusalAudit: RefusalAuditPort
}

/** The composed boundary. */
export interface Api {
  handle(request: HttpRequest): Promise<HttpResponse>
}

/**
 * The one HTTP status table. `HttpStatusForError` makes it total over
 * `DomainErrorCode`, and each property keeps its literal status type.
 */
export const HTTP_STATUS_FOR_ERROR: HttpStatusForError = {
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

/** Total status lookup; the returned type is the code's literal status. */
export function httpStatusForError(code: DomainErrorCode): HttpStatusForError[DomainErrorCode] {
  return HTTP_STATUS_FOR_ERROR[code]
}

/**
 * Map a refusal to its correlated `DomainFailure`. The switch narrows `error` per code,
 * so the literal status and the error code stay correlated without an assertion.
 */
export function toDomainFailure(error: DomainError): DomainFailure {
  switch (error.code) {
    case 'not-found':
      return { ok: false, status: HTTP_STATUS_FOR_ERROR['not-found'], error }
    case 'conflict':
      return { ok: false, status: HTTP_STATUS_FOR_ERROR.conflict, error }
    case 'version-conflict':
      return { ok: false, status: HTTP_STATUS_FOR_ERROR['version-conflict'], error }
    case 'forbidden':
      return { ok: false, status: HTTP_STATUS_FOR_ERROR.forbidden, error }
    case 'invalid-state':
      return { ok: false, status: HTTP_STATUS_FOR_ERROR['invalid-state'], error }
    case 'invalid-input':
      return { ok: false, status: HTTP_STATUS_FOR_ERROR['invalid-input'], error }
    case 'budget-exhausted':
      return { ok: false, status: HTTP_STATUS_FOR_ERROR['budget-exhausted'], error }
    case 'ci-not-passed':
      return { ok: false, status: HTTP_STATUS_FOR_ERROR['ci-not-passed'], error }
    case 'environment-invalid':
      return { ok: false, status: HTTP_STATUS_FOR_ERROR['environment-invalid'], error }
    case 'sampling-unavailable':
      return { ok: false, status: HTTP_STATUS_FOR_ERROR['sampling-unavailable'], error }
  }
}

/** The compile-time actor relation per route, enforced here at runtime as a 403. */
type ActorGate<K extends CommandType> = (actor: Principal) => ActorOfCommand<K> | undefined

const ACTOR_GATES: { readonly [K in CommandType]: ActorGate<K> } = {
  'program.create': (actor) => (actor.kind === 'operator' ? actor : undefined),
  'program.pause': (actor) => (actor.kind === 'operator' ? actor : undefined),
  'program.resume': (actor) => (actor.kind === 'operator' ? actor : undefined),
  'program.stop': (actor) => (actor.kind === 'operator' ? actor : undefined),
  'program.set-goal': (actor) => (actor.kind === 'operator' ? actor : undefined),
  'program.set-methodology': (actor) => (actor.kind === 'operator' ? actor : undefined),
  'program.set-exploration': (actor) => (actor.kind === 'operator' ? actor : undefined),
  'issue.create': (actor) =>
    actor.kind === 'operator' || actor.kind === 'researcher' ? actor : undefined,
  'issue.claim': (actor) => (actor.kind === 'researcher' ? actor : undefined),
  'issue.comment': (actor) =>
    actor.kind === 'operator' || actor.kind === 'researcher' ? actor : undefined,
  'issue.close': (actor) => (actor.kind === 'researcher' ? actor : undefined),
  'experiment.propose': (actor) => (actor.kind === 'researcher' ? actor : undefined),
  'experiment.review': (actor) => (actor.kind === 'researcher' ? actor : undefined),
  'experiment.close': (actor) => (actor.kind === 'researcher' ? actor : undefined),
  'ci.request': (actor) => (actor.kind === 'researcher' ? actor : undefined),
  'ticket.submit': (actor) => (actor.kind === 'implementer' ? actor : undefined),
}

/**
 * Attach the Host fields to the API-built `CommandContext`. This table is total, so a
 * command that adds a Host field also adds a builder here; the API can neither omit a
 * proof nor overwrite the request identity the Host resolved.
 */
type HostContextBuilder<K extends CommandType> = (
  context: CommandContext<K>,
  fields: HostContextFields<K>,
) => HostContext<K>

const BUILD_HOST_CONTEXT: { readonly [K in CommandType]: HostContextBuilder<K> } = {
  'program.create': (context, host) => ({ context, programId: host.programId }),
  'program.pause': (context, host) => ({ context, programId: host.programId }),
  'program.resume': (context, host) => ({ context, programId: host.programId }),
  'program.stop': (context, host) => ({ context, programId: host.programId }),
  'program.set-goal': (context, host) => ({ context, programId: host.programId }),
  'program.set-methodology': (context, host) => ({ context, programId: host.programId }),
  'program.set-exploration': (context, host) => ({ context, programId: host.programId }),
  'issue.create': (context, host) => ({ context, programId: host.programId }),
  'issue.claim': (context, host) => ({ context, programId: host.programId }),
  'issue.comment': (context, host) => ({ context, programId: host.programId }),
  'issue.close': (context, host) => ({ context, programId: host.programId }),
  'experiment.propose': (context, host) => ({
    context,
    programId: host.programId,
    assignment: host.assignment,
  }),
  'experiment.review': (context, host) => ({
    context,
    programId: host.programId,
    assignment: host.assignment,
  }),
  'experiment.close': (context, host) => ({
    context,
    programId: host.programId,
    assignment: host.assignment,
  }),
  'ci.request': (context, host) => ({ context, programId: host.programId }),
  'ticket.submit': (context, host) => ({
    context,
    programId: host.programId,
    binding: host.binding,
  }),
}

type RouteHandler = (request: HttpRequest, match: RouteMatch) => Promise<HttpResponse>

/**
 * Compose the HTTP boundary from the injected parser table, executor and Host ports.
 * Every handler delegates to `runRoute` with its own literal, so the executor slot and
 * the Host-context type are fixed by the matched route and cannot be widened.
 */
export function createApi(dependencies: ApiDependencies): Api {
  const handlers: { readonly [K in CommandType]: RouteHandler } = {
    'program.create': (request, match) => runRoute('program.create', request, match, dependencies),
    'program.pause': (request, match) => runRoute('program.pause', request, match, dependencies),
    'program.resume': (request, match) => runRoute('program.resume', request, match, dependencies),
    'program.stop': (request, match) => runRoute('program.stop', request, match, dependencies),
    'program.set-goal': (request, match) => runRoute('program.set-goal', request, match, dependencies),
    'program.set-methodology': (request, match) =>
      runRoute('program.set-methodology', request, match, dependencies),
    'program.set-exploration': (request, match) =>
      runRoute('program.set-exploration', request, match, dependencies),
    'issue.create': (request, match) => runRoute('issue.create', request, match, dependencies),
    'issue.claim': (request, match) => runRoute('issue.claim', request, match, dependencies),
    'issue.comment': (request, match) => runRoute('issue.comment', request, match, dependencies),
    'issue.close': (request, match) => runRoute('issue.close', request, match, dependencies),
    'experiment.propose': (request, match) =>
      runRoute('experiment.propose', request, match, dependencies),
    'experiment.review': (request, match) =>
      runRoute('experiment.review', request, match, dependencies),
    'experiment.close': (request, match) =>
      runRoute('experiment.close', request, match, dependencies),
    'ci.request': (request, match) => runRoute('ci.request', request, match, dependencies),
    'ticket.submit': (request, match) => runRoute('ticket.submit', request, match, dependencies),
  }

  return {
    async handle(request: HttpRequest): Promise<HttpResponse> {
      const match = findRoute(request.path)
      if (match === undefined) {
        return { status: 404, body: { ok: false, error: { code: 'not-found' } } }
      }
      return handlers[match.route.command](request, match)
    },
  }
}

/** Run one matched route through the single write path. */
async function runRoute<K extends CommandType>(
  route: K,
  request: HttpRequest,
  match: RouteMatch,
  dependencies: ApiDependencies,
): Promise<HttpResponse> {
  const actor = ACTOR_GATES[route](request.actor)
  if (actor === undefined) {
    return forbiddenResponse(nonEmpty(`actor is not allowed to issue ${route}`))
  }

  const at = dependencies.clock.now()
  const requestId = dependencies.requestIds.next()
  const context: CommandContext<K> = { actor, at, requestId }

  const resolvedHost = dependencies.hostContexts[route]({
    route,
    context,
    body: request.body,
    params: match.params,
  })
  if (!resolvedHost.ok) {
    // The resolver is an ownership check, not a lookup that may reveal whether an
    // aggregate exists: every failure is presented as forbidden.
    return forbiddenResponse(resolvedHost.error.message)
  }

  const host: HostContext<K> = BUILD_HOST_CONTEXT[route](context, resolvedHost.value)
  const input = withPathParameters(request.body, match.params)
  const outcome = await executeRoute(
    dependencies.parsers,
    hostProgramId(host.programId),
    dependencies.executor,
    actor,
    route,
    input,
    host,
    dependencies.clock,
    requestId,
    dependencies.refusalAudit,
  )
  return commandResponse(outcome, ROUTE_TABLE[route].successStatus)
}

/** Match a path against every route in table order; the first match wins. */
function findRoute(path: string): RouteMatch | undefined {
  for (const route of Object.values(ROUTE_TABLE)) {
    const params = matchPath(route.path, path)
    if (params !== undefined) return { route, params }
  }
  return undefined
}

/**
 * Match one path template. A `:name` segment captures one non-empty value; every other
 * segment must compare equal, so a path with an extra or missing segment is not a route.
 */
function matchPath(pattern: string, path: string): readonly RouteParameter[] | undefined {
  const patternSegments = pattern.split('/')
  const pathSegments = path.split('/')
  if (patternSegments.length !== pathSegments.length) return undefined

  const params: RouteParameter[] = []
  for (let index = 0; index < patternSegments.length; index += 1) {
    const expected = patternSegments[index]
    const actual = pathSegments[index]
    if (expected === undefined || actual === undefined) return undefined
    if (expected.startsWith(':')) {
      const name = pathParameterName(expected.slice(1))
      if (name === undefined || actual.length === 0) return undefined
      params.push({ name, value: actual })
    } else if (expected !== actual) {
      return undefined
    }
  }
  return params
}

/** Parse a route-template parameter name into the command field it feeds. */
function pathParameterName(name: string): RouteParameterName | undefined {
  switch (name) {
    case 'programId':
      return 'programId'
    case 'issueId':
      return 'issueId'
    case 'experimentId':
      return 'experimentId'
    default:
      return undefined
  }
}

/**
 * Build the parser input: the body's own data properties plus the path parameters last.
 * The path is authoritative, so a body cannot name another Program or Issue. A non-object
 * body is passed through unchanged and refused by the command parser.
 */
function withPathParameters(body: unknown, params: readonly RouteParameter[]): unknown {
  if (params.length === 0) return body
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body

  const merged: Record<string, unknown> = {}
  for (const key of Object.getOwnPropertyNames(body)) merged[key] = ownValue(body, key)
  for (const param of params) merged[param.name] = param.value
  return merged
}

/** Read an own data property without invoking an untrusted accessor. */
function ownValue(source: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(source, key)?.value
}

/**
 * The audited Program of a refusal is the one the Host resolved. A parser failure must
 * not choose its own audit subject from the untrusted body; the path and Host already
 * decided which Program the request belongs to.
 */
function hostProgramId(programId: ProgramId): AuditSubjectParsers {
  return { programId: () => ({ ok: true, value: programId }) }
}

/** Translate one command outcome into the response body and status. */
function commandResponse<K extends CommandType>(
  outcome: CommandOutcome<K>,
  successStatus: 200 | 201,
): HttpResponse {
  if (outcome.ok) {
    return {
      status: successStatus,
      body: { ok: true, value: outcome.value, audit: outcome.audit },
    }
  }
  const failure = toDomainFailure(outcome.error)
  return {
    status: failure.status,
    body: { ok: false, status: failure.status, error: failure.error, audit: outcome.audit },
  }
}

/** A 403 response; no command ran and therefore there is no audit to attach. */
function forbiddenResponse(message: NonEmptyString): HttpResponse {
  const failure = toDomainFailure({ code: 'forbidden', message })
  return { status: failure.status, body: failure }
}

/**
 * `NonEmptyString` is nominal and this module does not import the parser boundary. The
 * message is a literal or a Host-supplied `NonEmptyString`, so the fallback is
 * unreachable; it keeps the refinement honest without an assertion.
 */
function nonEmpty(value: string): NonEmptyString
function nonEmpty(value: string): string {
  return value.length === 0 ? 'refused' : value
}
