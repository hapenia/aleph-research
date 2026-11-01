/**
 * Composition root for the in-process runtime.
 *
 * This is the one module that wires the runtime pieces together: an in-memory
 * `UnitOfWork`/`ReadModel`, the Host clock, a request-id source, the command handlers, the
 * parser table, the HTTP boundary, the trigger mapper and the sampler. It also owns the
 * two runtime ports the boundary expects and no domain module may implement:
 *
 * - the refusal-audit port, which turns a refused body into a `command.refused` entry;
 * - the Host-context resolvers, which mint the ownership proofs (`IssueAssignment`,
 *   `TicketBinding`) that the model never supplies.
 *
 * ## Why `handleHttp` composes a request-scoped API
 *
 * `HostContextResolver` is synchronous by contract, while the ownership facts come from
 * asynchronous repositories. The root therefore resolves those facts before it calls the
 * boundary and gives the boundary a resolver table closed over exactly that request's
 * facts. A request-scoped table means no shared mutable state and no assumption about how
 * long the boundary waits before it calls a resolver: two concurrent requests cannot see
 * each other's proofs.
 *
 * ## Ownership resolution
 *
 * Every route gets a Program for the refusal audit. Routes with a `:programId` segment
 * take it from the path (through the parser boundary); `program.create` has no Program
 * yet and uses a documented sentinel, exactly as `runtime/handlers.ts` does for an unbound
 * submission. The proofs are resolved as follows:
 *
 * - `experiment.propose` names its Issue in the path. The default resolver reads that
 *   Issue and mints an `IssueAssignment` only when the acting Researcher is its assignee.
 * - `experiment.review` and `experiment.close` name an Experiment; its stored Issue is
 *   the anchor for the same assignment check.
 * - `ticket.submit` names no aggregate. The Implementer principal carries the Ticket id;
 *   the resolver reads the Ticket, checks that its Experiment belongs to the same Program
 *   and Issue, that the Ticket is session-bearing for this implementer, and then mints the
 *   `TicketBinding` through `createTicketBinding`.
 * - `ci.request` needs no injected proof on the frozen command surface: the token is
 *   minted inside the `ci.request` handler (`runtime/handlers.ts`), which also performs the
 *   final assignee check. The resolver still resolves the Experiment's Issue so a request
 *   without an owner is read consistently, but the proof itself stays in the handler.
 *
 * The `hostContexts` option replaces the whole default table. That is the test seam: a
 * test that wants to exercise the boundary or the handlers without repository lookups can
 * inject a resolver table and `handleHttp` will not compose a default one.
 *
 * ## Read-only Host surfaces
 *
 * `snapshot` wraps the store read model in an `ApiResponse` (the same audit-carrying shape
 * the panel uses). `sampleBase` reads a Program, builds sampler candidates from
 * `listPassed` (carrying each record's `ciRunId`), and delegates the mechanism to the
 * injected `Sampler`. `emitTriggers` is a pure mapping of the stored audit log through
 * `TriggerFactory`; it records nothing. `deliverTriggers` is the explicit side-effect
 * seam: it asks the `TriggerPort` to receive every report that has a draft and skips
 * `command.refused` reports, which carry `kind: null` and no draft.
 *
 * ## Boundary imports
 *
 * The composition root is allowlisted by the runtime safety contract to import the
 * factory and parser boundary (`src/factories.ts`, `src/parsers.ts`) because it mints the
 * Host-owned proofs and parses route parameters. `research-core`'s ESLint
 * `no-restricted-imports` rule has to exempt `src/adapter/**` for that to pass; the
 * exemption lives in the lint config, not in this module. This file uses no assertion,
 * `any`, predicate or JSON, so the rest of the boundary rules apply unchanged.
 */
import type { ApiResponse, ProgramSnapshot } from '../types/api.js'
import type { Attention } from '../types/attention.js'
import type { AuditAction, AuditEntryOf } from '../types/audit.js'
import type { IssueAssignment, Principal, TicketBinding } from '../types/actors.js'
import type { DomainError, Err, Ok, Result } from '../types/errors.js'
import type {
  AuditId,
  ExperimentId,
  IssueId,
  NonEmptyString,
  ProgramId,
  RequestId,
} from '../types/ids.js'
import type { BaseChoice, SampleCandidate, Sampler } from '../types/sampling.js'
import type { Clock } from '../types/services.js'
import type { TriggerReportFor } from '../types/triggers.js'
import {
  createClock,
  createIssueAssignment,
  createTicketBinding,
} from '../factories.js'
import {
  auditId as parseAuditId,
  experimentId as parseExperimentId,
  issueId as parseIssueId,
  programId as parseProgramId,
  requestId as parseRequestId,
} from '../parsers.js'
import { COMMAND_PARSERS } from '../parsers-commands.js'
import {
  createApi,
  ROUTE_TABLE,
  toDomainFailure,
  type Api,
  type ApiDependencies,
  type HostContextResolvers,
  type HttpRequest,
  type HttpResponse,
  type RequestIdSource,
  type RouteParameter,
  type RouteParameterName,
} from '../runtime/api.js'
import type { RefusedCommandFacts, RefusalAuditPort } from '../runtime/executor.js'
import { createCommandHandlers } from '../runtime/handlers.js'
import { createSampler } from '../runtime/sampler.js'
import { createInMemoryStore, type InMemoryStore } from '../runtime/storage.js'
import { createTriggerFactory } from '../runtime/triggers.js'

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * A mapped audit report. The mapper is generic per action; the composition root stores
 * reports in audit order, so the type is the report type for the action union.
 */
export type TriggerReport = TriggerReportFor<AuditAction>

/**
 * The delivery seam of the trigger layer: it receives one mapped report at a time. The
 * `receive` method is explicit about returning a `Result`, because delivery is a Host
 * effect and a refused delivery must be distinguishable from a successful one.
 */
export interface TriggerPort {
  receive(report: TriggerReport): Promise<Result<void, DomainError>>
}

/** A trigger port that records what it received; tests use it as the delivery sink. */
export interface RecordingTriggerPort extends TriggerPort {
  readonly deliveries: readonly TriggerReport[]
}

/** The in-process memory trigger sink; delivery is recorded in arrival order. */
export function createRecordingTriggerPort(): RecordingTriggerPort {
  const deliveries: TriggerReport[] = []
  return {
    deliveries,
    receive(report: TriggerReport): Promise<Result<void, DomainError>> {
      deliveries.push(report)
      return Promise.resolve({ ok: true, value: undefined })
    },
  }
}

/** Options for the composition root; every port has a deterministic in-process default. */
export interface ResearchHostOptions {
  /** An existing store, so tests can seed Tickets, CI records or attention entries. */
  readonly store?: InMemoryStore
  /** The Host clock; defaults to the adapter clock from the factory boundary. */
  readonly clock?: Clock
  /** Request-id source; defaults to a deterministic counter. */
  readonly requestIds?: RequestIdSource
  /** The ownership resolver table; defaults to the store-backed resolver below. */
  readonly hostContexts?: HostContextResolvers
  /** The Boltzmann sampler; defaults to the mechanism implementation. */
  readonly sampler?: Sampler
  /** The trigger delivery sink; defaults to a recording port. */
  readonly triggerPort?: TriggerPort
  /** Injected RNG for the sampler; defaults to `Math.random`. */
  readonly random?: () => number
}

/** The composed in-process runtime. */
export interface ResearchHost {
  readonly store: InMemoryStore
  readonly clock: Clock
  readonly requestIds: RequestIdSource
  readonly triggerPort: TriggerPort
  readonly sampler: Sampler
  /** Route one HTTP request through the boundary, parser table and single executor. */
  handleHttp(request: HttpRequest): Promise<HttpResponse>
  /** The panel read model, wrapped in the API response shape. */
  snapshot(programId: ProgramId): Promise<ApiResponse<ProgramSnapshot>>
  /** Sample the next Experiment's base from the Program's passed CI records. */
  sampleBase(programId: ProgramId): Promise<Result<BaseChoice, DomainError>>
  /** Map the stored audit log to trigger reports; this method has no side effects. */
  emitTriggers(programId: ProgramId): Promise<readonly TriggerReport[]>
  /**
   * Deliver every mapped report that carries a draft and return the delivered reports.
   * A `command.refused` report maps to `kind: null` and is deliberately not delivered.
   */
  deliverTriggers(programId: ProgramId): Promise<Result<readonly TriggerReport[], DomainError>>
  /** The attention entries attributed to one Program. */
  attention(programId: ProgramId): Promise<readonly Attention[]>
}

/**
 * Create the in-process research Host.
 *
 * The store, clock, request ids, sampler and trigger sink are ports, so the returned
 * object is the same composition in tests and in the adapter; only the injected values
 * differ.
 */
export function createResearchHost(options: ResearchHostOptions = {}): ResearchHost {
  const store = options.store ?? createInMemoryStore()
  const clock = options.clock ?? createClock()
  const requestIds = options.requestIds ?? createCounterRequestIds()
  const triggerPort = options.triggerPort ?? createRecordingTriggerPort()
  const sampler = options.sampler ?? createSampler()
  const random = options.random ?? defaultRandom
  const triggerFactory = createTriggerFactory()
  const refusalAudit = createRefusalAuditPort(store)

  const baseDependencies: Omit<ApiDependencies, 'hostContexts'> = {
    parsers: COMMAND_PARSERS,
    executor: createCommandHandlers(store, clock),
    clock,
    requestIds,
    refusalAudit: refusalAudit.port,
  }

  // An injected resolver table does not need store lookups, so the boundary can be
  // composed once. The default table is request-scoped (see the module comment).
  const fixedApi: Api | undefined = options.hostContexts === undefined
    ? undefined
    : createApi({ ...baseDependencies, hostContexts: options.hostContexts })

  async function emitTriggers(programId: ProgramId): Promise<readonly TriggerReport[]> {
    await refusalAudit.flush()
    const stored = await store.snapshot(programId)
    if (!stored.ok) return []
    const reports: TriggerReport[] = []
    for (const entry of stored.value.audit) {
      reports.push(triggerFactory.make(entry, stored.value))
    }
    return reports
  }

  async function handle(request: HttpRequest): Promise<HttpResponse> {
    if (fixedApi !== undefined) {
      const response = await fixedApi.handle(request)
      await refusalAudit.flush()
      return response
    }
    const ownership = await resolveOwnership(store, request)
    const response = await createApi({
      ...baseDependencies,
      hostContexts: hostContextsFor(ownership),
    }).handle(request)
    await refusalAudit.flush()
    return response
  }

  return {
    store,
    clock,
    requestIds,
    triggerPort,
    sampler,
    handleHttp: handle,
    async snapshot(programId: ProgramId): Promise<ApiResponse<ProgramSnapshot>> {
      await refusalAudit.flush()
      return snapshotResponse(await store.snapshot(programId))
    },
    async sampleBase(programId: ProgramId): Promise<Result<BaseChoice, DomainError>> {
      const program = await store.programs.get(programId)
      if (program === undefined) {
        return err(notFound(`program ${String(programId)} does not exist`))
      }
      const passed = await store.ciRecords.listPassed(programId)
      // The record's own run id is the sampling key: it is what a derived lineage points
      // at, and duplicates are rejected by the sampler by this id and the Experiment id.
      const population: readonly SampleCandidate[] = passed.map((record) => ({
        ciRunId: record.id,
        experimentId: record.experimentId,
        commit: record.commit,
        metrics: record.metrics,
      }))
      return sampler.sample({
        level: program.value.exploration,
        definitions: program.value.utility.metrics,
        random,
        population,
      })
    },
    emitTriggers,
    async deliverTriggers(
      programId: ProgramId,
    ): Promise<Result<readonly TriggerReport[], DomainError>> {
      const reports = await emitTriggers(programId)
      const delivered: TriggerReport[] = []
      for (const report of reports) {
        if (report.draft === null) continue
        const accepted = await triggerPort.receive(report)
        if (!accepted.ok) return err(accepted.error)
        delivered.push(report)
      }
      return ok(delivered)
    },
    async attention(programId: ProgramId): Promise<readonly Attention[]> {
      await refusalAudit.flush()
      return store.attention.listByProgram(programId)
    },
  }
}

/**
 * A deterministic request-id source. The adapter can substitute a UUID allocator later;
 * Phase 1 tests want the sequence stable so aggregate ids stay readable.
 */
export function createCounterRequestIds(prefix = 'request'): RequestIdSource {
  let issued = 0
  return {
    next(): RequestId {
      issued += 1
      return mintRequestId(`${prefix}-${issued}`)
    },
  }
}

// ---------------------------------------------------------------------------
// Ownership resolution and the default Host-context table
// ---------------------------------------------------------------------------

/**
 * The Host-owned facts resolved for one request. `assignment`/`binding` are the minted
 * proofs; the matching `*Error` is the refusal the resolver must return when a proof is
 * required but could not be minted. Only one of the pair is present.
 */
interface Ownership {
  readonly programId: ProgramId
  readonly assignment: IssueAssignment | undefined
  readonly binding: TicketBinding | undefined
  readonly assignmentError: DomainError | undefined
  readonly bindingError: DomainError | undefined
}

/** The Program a refusal is attributed to when the request names none (program.create). */
const UNBOUND_PROGRAM: ProgramId = hostProgramId('unbound-program')

/** Resolve the synchronous Host fields for one request's prepared ownership facts. */
function hostContextsFor(ownership: Ownership): HostContextResolvers {
  return {
    'program.create': () => ok({ programId: ownership.programId }),
    'program.pause': () => ok({ programId: ownership.programId }),
    'program.resume': () => ok({ programId: ownership.programId }),
    'program.stop': () => ok({ programId: ownership.programId }),
    'program.set-goal': () => ok({ programId: ownership.programId }),
    'program.set-methodology': () => ok({ programId: ownership.programId }),
    'program.set-exploration': () => ok({ programId: ownership.programId }),
    'issue.create': () => ok({ programId: ownership.programId }),
    'issue.claim': () => ok({ programId: ownership.programId }),
    'issue.comment': () => ok({ programId: ownership.programId }),
    'issue.close': () => ok({ programId: ownership.programId }),
    'experiment.propose': () => assignmentContext(ownership),
    'experiment.review': () => assignmentContext(ownership),
    'experiment.close': () => assignmentContext(ownership),
    'ci.request': () => ok({ programId: ownership.programId }),
    'ticket.submit': () => bindingContext(ownership),
  }
}

/**
 * The assignment fields for one experiment command. The resolver returns a refusal, not a
 * bare Program, whenever the proof could not be minted, so the executor never receives an
 * undefined proof.
 */
function assignmentContext(
  ownership: Ownership,
): Result<
  { readonly programId: ProgramId; readonly assignment: IssueAssignment },
  DomainError
> {
  if (ownership.assignmentError !== undefined) return err(ownership.assignmentError)
  if (ownership.assignment === undefined) {
    return err(forbidden('the Host could not resolve an issue assignment for this request'))
  }
  return ok({ programId: ownership.programId, assignment: ownership.assignment })
}

/**
 * The binding fields for `ticket.submit`. As with the assignment, a failure is surfaced as
 * a resolver refusal (the boundary presents every resolver failure as forbidden).
 */
function bindingContext(
  ownership: Ownership,
): Result<
  { readonly programId: ProgramId; readonly binding: TicketBinding },
  DomainError
> {
  if (ownership.bindingError !== undefined) return err(ownership.bindingError)
  if (ownership.binding === undefined) {
    return err(forbidden('the Host could not resolve a ticket binding for this request'))
  }
  return ok({ programId: ownership.programId, binding: ownership.binding })
}

/**
 * Read the aggregates a request's ownership proofs need.
 *
 * The function is deliberately route-generic rather than a switch over all sixteen
 * commands: path parameters name the aggregates directly, and an Experiment or an
 * Implementer Ticket supplies the Issue the route did not name. A missing aggregate is
 * not thrown; it becomes a prepared `forbidden` for the proof-bearing routes.
 */
async function resolveOwnership(
  store: InMemoryStore,
  request: HttpRequest,
): Promise<Ownership> {
  const params = routeParameters(request.path)
  const actor = request.actor

  let programId = parseProgramParameter(parameter(params, 'programId'))
  const issueId = parseIssueParameter(parameter(params, 'issueId'))
  const experimentId = parseExperimentParameter(parameter(params, 'experimentId'))
  let resolvedIssueId = issueId

  // An Experiment route names its Experiment, not its Issue. Read the Experiment once and
  // reuse it for both the Program fallback and the issue anchor.
  let experimentProgramId: ProgramId | undefined
  if (experimentId !== undefined) {
    const experiment = await store.experiments.get(experimentId)
    if (experiment !== undefined) {
      experimentProgramId = experiment.value.programId
      if (resolvedIssueId === undefined) resolvedIssueId = experiment.value.issueId
    }
  }

  let assignment: IssueAssignment | undefined
  let assignmentError: DomainError | undefined
  if (actor.kind === 'researcher') {
    const minted = await mintIssueAssignment(store, actor, resolvedIssueId)
    if (minted.ok) assignment = minted.value
    else assignmentError = minted.error
  }

  let binding: TicketBinding | undefined
  let bindingError: DomainError | undefined
  if (actor.kind === 'implementer') {
    const ticket = await store.tickets.get(actor.ticketId)
    if (ticket === undefined) {
      bindingError = forbidden(`ticket ${String(actor.ticketId)} does not exist`)
    } else {
      const experiment = await store.experiments.get(ticket.value.experimentId)
      if (experiment === undefined) {
        bindingError = forbidden(
          `experiment ${String(ticket.value.experimentId)} does not exist`,
        )
      } else if (
        experiment.value.programId !== ticket.value.programId ||
        experiment.value.issueId !== ticket.value.issueId
      ) {
        bindingError = forbidden('the ticket and its experiment do not share a program and issue')
      } else {
        programId = programId ?? ticket.value.programId
        const minted = createTicketBinding({
          ticket: ticket.value,
          expected: {
            programId: ticket.value.programId,
            issueId: ticket.value.issueId,
            experimentId: ticket.value.experimentId,
            sessionId: actor.sessionId,
          },
        })
        if (minted.ok) binding = minted.value
        else bindingError = minted.error
      }
    }
  }

  // Prefer the path Program; an Experiment or Ticket supplies it when the path does not.
  // A malformed path parameter leaves the fallback in place; the command parser then
  // returns the original invalid-input refusal (the proof routes refuse earlier).
  if (programId === undefined && experimentProgramId !== undefined) {
    programId = experimentProgramId
  }

  return {
    programId: programId ?? UNBOUND_PROGRAM,
    assignment,
    binding,
    assignmentError,
    bindingError,
  }
}

/**
 * Mint the Issue assignment when the acting Researcher is the stored Issue's assignee.
 *
 * The Issue is the anchor the runtime contract names: minting is refused for an open,
 * closed or another researcher's Issue, so the executor's later `assignmentMatches` check
 * is a second line of defence rather than the only one.
 */
async function mintIssueAssignment(
  store: InMemoryStore,
  actor: Extract<Principal, { readonly kind: 'researcher' }>,
  issueId: IssueId | undefined,
): Promise<Result<IssueAssignment, DomainError>> {
  if (issueId === undefined) {
    return err(forbidden('the request names no issue whose assignment the Host can resolve'))
  }
  const issue = await store.issues.get(issueId)
  if (issue === undefined) {
    return err(forbidden(`issue ${String(issueId)} does not exist`))
  }
  if (issue.value.status !== 'assigned') {
    return err(forbidden('the issue is not assigned, so it authorizes no experiment work'))
  }
  if (issue.value.assignee.sessionId !== actor.sessionId) {
    return err(forbidden('the issue is assigned to another researcher'))
  }
  return createIssueAssignment(issueId, actor)
}

// ---------------------------------------------------------------------------
// Refusal audit
// ---------------------------------------------------------------------------

/**
 * The port the executor calls when a body fails its parser, plus the flush the Host uses
 * before it answers the request or reads the audit log.
 *
 * `RefusalAuditPort.record` is synchronous, while `AuditLog.append` is a `Promise`. The
 * port therefore starts the append and records the promise; `flush` awaits every pending
 * append before a response is returned, so the refusal is in the store (and in the next
 * snapshot) even when a future store adapter performs a real asynchronous write.
 */
function createRefusalAuditPort(store: InMemoryStore): RefusalAudit {
  const pending: Promise<void>[] = []
  return {
    port: {
      record(facts: RefusedCommandFacts): AuditEntryOf<'command.refused'> {
        const entry: AuditEntryOf<'command.refused'> = {
          id: mintAuditId(`audit-${String(facts.requestId)}-command.refused`),
          at: facts.at,
          programId: facts.programId,
          action: 'command.refused',
          subject: { kind: 'program', id: facts.programId },
          actor: auditableActor(facts.actor),
          detail: {
            route: facts.route,
            reason: facts.reason,
            requestId: facts.requestId,
          },
        }
        pending.push(store.audit.append([entry]))
        return entry
      },
    },
    async flush(): Promise<void> {
      // Await the current batch, then loop: an append started while flushing must also be
      // awaited before the caller reads.
      while (pending.length > 0) {
        const batch = pending.splice(0)
        await Promise.all(batch)
      }
    },
  }
}

/** The refusal port and the flush that makes its append visible to a reader. */
interface RefusalAudit {
  readonly port: RefusalAuditPort
  flush(): Promise<void>
}

/** The principals the audit map admits for `command.refused` (all except Router). */
type AuditableActor = Extract<
  Principal,
  { readonly kind: 'operator' | 'researcher' | 'implementer' | 'watchdog' | 'host' }
>

/**
 * Narrow a refusal actor to the audit map's actor kinds. A Router can never reach a write
 * route (every route's actor gate excludes it), so the final branch is unreachable and
 * throws rather than fabricating a principal in an audit fact.
 */
function auditableActor(actor: Principal): AuditableActor {
  switch (actor.kind) {
    case 'operator':
    case 'researcher':
    case 'implementer':
    case 'watchdog':
    case 'host':
      return actor
    case 'router':
      throw new Error('a router principal cannot reach a write route; the actor gate is broken')
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/** The panel's API response wrapper: a successful read carries the audit it observed. */
function snapshotResponse(
  result: Result<ProgramSnapshot, DomainError>,
): ApiResponse<ProgramSnapshot> {
  if (result.ok) {
    return { ok: true, value: result.value, audit: result.value.audit }
  }
  return { ...toDomainFailure(result.error), audit: [] }
}

/**
 * Match a path against the write route table and return its captured parameters.
 *
 * The composition root only needs the names and values; the boundary does its own match
 * for execution. An unknown path returns no parameters and is refused by the boundary.
 */
function routeParameters(path: string): readonly RouteParameter[] {
  for (const route of Object.values(ROUTE_TABLE)) {
    const params = matchPath(route.path, path)
    if (params !== undefined) return params
  }
  return []
}

function matchPath(
  pattern: string,
  path: string,
): readonly RouteParameter[] | undefined {
  const patternSegments = pattern.split('/')
  const pathSegments = path.split('/')
  if (patternSegments.length !== pathSegments.length) return undefined
  const params: RouteParameter[] = []
  for (let index = 0; index < patternSegments.length; index += 1) {
    const expected = patternSegments[index]
    const actual = pathSegments[index]
    if (expected === undefined || actual === undefined) return undefined
    if (expected.startsWith(':')) {
      const name = parameterName(expected.slice(1))
      if (name === undefined || actual.length === 0) return undefined
      params.push({ name, value: actual })
    } else if (expected !== actual) {
      return undefined
    }
  }
  return params
}

function parameterName(name: string): RouteParameterName | undefined {
  if (name === 'programId') return 'programId'
  if (name === 'issueId') return 'issueId'
  if (name === 'experimentId') return 'experimentId'
  return undefined
}

function parameter(
  params: readonly RouteParameter[],
  name: RouteParameterName,
): string | undefined {
  for (const param of params) {
    if (param.name === name) return param.value
  }
  return undefined
}

function parseProgramParameter(value: string | undefined): ProgramId | undefined {
  if (value === undefined) return undefined
  const parsed = parseProgramId(value)
  return parsed.ok ? parsed.value : undefined
}

function parseIssueParameter(value: string | undefined): IssueId | undefined {
  if (value === undefined) return undefined
  const parsed = parseIssueId(value)
  return parsed.ok ? parsed.value : undefined
}

function parseExperimentParameter(value: string | undefined): ExperimentId | undefined {
  if (value === undefined) return undefined
  const parsed = parseExperimentId(value)
  return parsed.ok ? parsed.value : undefined
}

// ---------------------------------------------------------------------------
// Result, refusal and refinement helpers
// ---------------------------------------------------------------------------

function ok<T>(value: T): Ok<T> {
  return { ok: true, value }
}

function err<E>(error: E): Err<E> {
  return { ok: false, error }
}

function notFound(message: string): DomainError {
  return { code: 'not-found', message: nonEmpty(message) }
}

function forbidden(message: string): DomainError {
  return { code: 'forbidden', message: nonEmpty(message) }
}

/**
 * `NonEmptyString` is nominal and the parser boundary normally mints it. Every message
 * here is a literal or an interpolation of Host-held ids, so the refinement is declared
 * once with a fallback; no untrusted string reaches this helper.
 */
function nonEmpty(value: string): NonEmptyString
function nonEmpty(value: string): string {
  return value.length === 0 ? 'refused' : value
}

/** A Host-minted Program id (the `program.create` sentinel); parsed to stay honest. */
function hostProgramId(value: string): ProgramId {
  const parsed = parseProgramId(value)
  if (parsed.ok) return parsed.value
  throw new Error('the composition root generated an invalid program id')
}

/** A Host-minted request id; the counter only produces entity-id-shaped tokens. */
function mintRequestId(value: string): RequestId {
  const parsed = parseRequestId(value)
  if (parsed.ok) return parsed.value
  throw new Error('the composition root generated an invalid request id')
}

/** A Host-minted audit id; the executor's refusal port only produces this shape. */
function mintAuditId(value: string): AuditId {
  const parsed = parseAuditId(value)
  if (parsed.ok) return parsed.value
  throw new Error('the composition root generated an invalid audit id')
}

/** The production RNG; tests inject a deterministic function instead. */
function defaultRandom(): number {
  return Math.random()
}
