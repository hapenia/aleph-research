/**
 * Runtime tests for the composition root.
 *
 * The root is exercised through its public surface only: HTTP requests go through the
 * real boundary, parser table, handlers and in-memory store; snapshots come from the real
 * read model; sampler candidates come from real `listPassed` rows; trigger reports come
 * from the real audit log and mapper. The only test doubles are the ports the root
 * accepts (clock, request-id counter, RNG, delivery sink) and the seeded aggregates the
 * frozen command surface cannot create (a running Ticket and a passed CI record).
 *
 * The nominal classes the Host minted are created through the factory/parser boundary,
 * exactly as an adapter would; this file therefore needs no type assertion.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { ApiResponse, ProgramSnapshot } from '../src/types/api.js'
import type { Attention } from '../src/types/attention.js'
import type { Principal } from '../src/types/actors.js'
import type { DomainError, Result } from '../src/types/errors.js'
import type {
  ExperimentId,
  IsoTimestamp,
  IssueId,
  MetricName,
  ProgramId,
  TicketId,
} from '../src/types/ids.js'
import type { MetricMap, PassedCIRecord } from '../src/types/metrics.js'
import type { BaseChoice, SampleInput, Sampler } from '../src/types/sampling.js'
import type { Clock } from '../src/types/services.js'
import type { HostContextResolvers } from '../src/runtime/api.js'
import {
  createCounterRequestIds,
  createRecordingTriggerPort,
  createResearchHost,
  type RecordingTriggerPort,
  type ResearchHost,
  type TriggerReport,
} from '../src/adapter/composition.js'
import {
  createImplementerPrincipal,
  createOperatorPrincipal,
  createResearcherPrincipal,
  createRunningTicket,
} from '../src/factories.js'
import {
  ciRunId as parseCIRunId,
  commitSha as parseCommitSha,
  durationMs as parseDurationMs,
  experimentId as parseExperimentId,
  implementerSessionId as parseImplementerSessionId,
  isoTimestamp as parseIsoTimestamp,
  issueId as parseIssueId,
  metricName as parseMetricName,
  nonEmptyString as parseNonEmptyString,
  operatorSessionId as parseOperatorSessionId,
  programId as parseProgramId,
  researcherSessionId as parseResearcherSessionId,
  ticketId as parseTicketId,
} from '../src/parsers.js'
import { createSampler } from '../src/runtime/sampler.js'
import { createInMemoryStore, INITIAL_VERSION, type InMemoryStore } from '../src/runtime/storage.js'

// ---------------------------------------------------------------------------
// Fixtures, created through the parser/factory boundary
// ---------------------------------------------------------------------------

function must<T>(result: Result<T, DomainError>, context: string): T {
  if (!result.ok) {
    throw new Error(`${context} was refused: ${result.error.code} ${result.error.message}`)
  }
  return result.value
}

function parse<T>(
  parser: (input: unknown) => Result<T, DomainError>,
  value: unknown,
  context: string,
): T {
  return must(parser(value), context)
}

const AT: IsoTimestamp = parse(parseIsoTimestamp, '2026-11-02T00:00:00.000Z', 'clock')
const CLOCK: Clock = { now: () => AT }
const HEAD = parse(parseCommitSha, '0123456789abcdef0123456789abcdef01234567', 'commit')
const SCORE: MetricName = parse(parseMetricName, 'score', 'metric name')
const IMPLEMENTER_SESSION = parse(
  parseImplementerSessionId,
  'implementer-session',
  'implementer session',
)

const OPERATOR: Principal = createOperatorPrincipal(
  parse(parseOperatorSessionId, 'operator-session', 'operator session'),
)
const RESEARCHER: Principal = createResearcherPrincipal(
  parse(parseResearcherSessionId, 'researcher-session', 'researcher session'),
)

const PROGRAM_BODY = {
  name: 'clifford research',
  goal: 'find a better probe',
  methodology: 'controlled experiments',
  contract: { ciEntry: 'run.sh', timeoutMs: 1000, requiredMetrics: ['score'] },
  utility: { metrics: [{ name: 'score', direction: 'higher', weight: 1 }] },
  exploration: 'normal',
  budget: { maxExperiments: 3, maxComputeMinutes: 30, maxTokens: 1000 },
}

const ISSUE_BODY = {
  title: 'wider clipping window',
  body: 'test whether a wider window improves the score',
  labels: ['research'],
}

const PLAN_BODY = {
  hypothesis: 'a wider clipping window is better',
  steps: ['clip wider', 'measure'],
  expected: { direction: 'higher', rationale: 'more signal' },
  environment: { kind: 'uv-lock', lockFile: 'uv.lock', pythonVersion: '3.12' },
  inputs: [],
}

const ENVIRONMENT_BODY = {
  kind: 'requirements',
  requirementsFile: 'requirements.txt',
  pythonVersion: '3.12',
}

/**
 * A total resolver table that refuses every route. Injecting it proves the composition
 * seam: the boundary must use it instead of the store-backed default.
 */
const INJECTED_REFUSAL: DomainError = {
  code: 'forbidden',
  message: parse(parseNonEmptyString, 'the injected Host resolver refused', 'refusal message'),
}

const INJECTED_HOST_CONTEXTS: HostContextResolvers = {
  'program.create': () => ({ ok: false, error: INJECTED_REFUSAL }),
  'program.pause': () => ({ ok: false, error: INJECTED_REFUSAL }),
  'program.resume': () => ({ ok: false, error: INJECTED_REFUSAL }),
  'program.stop': () => ({ ok: false, error: INJECTED_REFUSAL }),
  'program.set-goal': () => ({ ok: false, error: INJECTED_REFUSAL }),
  'program.set-methodology': () => ({ ok: false, error: INJECTED_REFUSAL }),
  'program.set-exploration': () => ({ ok: false, error: INJECTED_REFUSAL }),
  'issue.create': () => ({ ok: false, error: INJECTED_REFUSAL }),
  'issue.claim': () => ({ ok: false, error: INJECTED_REFUSAL }),
  'issue.comment': () => ({ ok: false, error: INJECTED_REFUSAL }),
  'issue.close': () => ({ ok: false, error: INJECTED_REFUSAL }),
  'experiment.propose': () => ({ ok: false, error: INJECTED_REFUSAL }),
  'experiment.review': () => ({ ok: false, error: INJECTED_REFUSAL }),
  'experiment.close': () => ({ ok: false, error: INJECTED_REFUSAL }),
  'ci.request': () => ({ ok: false, error: INJECTED_REFUSAL }),
  'ticket.submit': () => ({ ok: false, error: INJECTED_REFUSAL }),
}

interface Harness {
  readonly host: ResearchHost
  readonly store: InMemoryStore
  readonly triggerPort: RecordingTriggerPort
  readonly samples: SampleInput[]
}

interface HarnessOptions {
  readonly sampler?: Sampler
  readonly random?: () => number
}

function makeHost(options: HarnessOptions = {}): Harness {
  const store = createInMemoryStore()
  const triggerPort = createRecordingTriggerPort()
  const samples: SampleInput[] = []
  const mechanism = createSampler()
  const sampler: Sampler = {
    presets: (level) => mechanism.presets(level),
    sample(input: SampleInput): Result<BaseChoice, DomainError> {
      samples.push(input)
      return mechanism.sample(input)
    },
  }
  const host = createResearchHost({
    store,
    clock: CLOCK,
    requestIds: createCounterRequestIds('test'),
    triggerPort,
    sampler: options.sampler ?? sampler,
    random: options.random ?? (() => 0.5),
  })
  return { host, store, triggerPort, samples }
}

// ---------------------------------------------------------------------------
// Response helpers. A response body is untrusted `unknown`; read it by property
// descriptor so the test never invents a shape.
// ---------------------------------------------------------------------------

function ownField(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

function text(value: unknown, context: string): string {
  if (typeof value !== 'string') throw new Error(`${context} must be a string`)
  return value
}

function responseValue(response: { readonly status: number; readonly body: unknown }, context: string): unknown {
  if (response.status >= 400) throw new Error(`${context} failed with status ${response.status}`)
  const body = response.body
  if (ownField(body, 'ok') !== true) throw new Error(`${context} did not return ok`)
  return ownField(body, 'value')
}

function responseId(response: { readonly status: number; readonly body: unknown }, context: string): string {
  return text(ownField(responseValue(response, context), 'id'), `${context}.id`)
}

function snapshotValue(response: ApiResponse<ProgramSnapshot>): ProgramSnapshot {
  if (!response.ok) throw new Error(`snapshot was refused: ${response.error.code}`)
  return response.value
}

async function post(
  host: ResearchHost,
  path: string,
  actor: Principal,
  body: unknown,
): Promise<{ readonly status: number; readonly body: unknown }> {
  return host.handleHttp({ method: 'POST', path, body, actor })
}

// ---------------------------------------------------------------------------
// Lifecycle helpers: the writes the model may issue, with the Host resolver minting
// the ownership proof for the proposal.
// ---------------------------------------------------------------------------

async function createProgram(host: ResearchHost): Promise<ProgramId> {
  const response = await post(host, '/aleph/api/programs', OPERATOR, PROGRAM_BODY)
  assert.equal(response.status, 201)
  return parse(parseProgramId, responseId(response, 'program.create'), 'program id')
}

async function createIssue(host: ResearchHost, programId: ProgramId): Promise<IssueId> {
  const path = `/aleph/api/programs/${programId}/issues`
  const response = await post(host, path, OPERATOR, ISSUE_BODY)
  assert.equal(response.status, 201)
  return parse(parseIssueId, responseId(response, 'issue.create'), 'issue id')
}

async function claimIssue(host: ResearchHost, programId: ProgramId, issueId: IssueId): Promise<void> {
  const path = `/aleph/api/programs/${programId}/issues/${issueId}/claim`
  const response = await post(host, path, RESEARCHER, {})
  assert.equal(response.status, 200)
}

async function proposeExperiment(
  host: ResearchHost,
  programId: ProgramId,
  issueId: IssueId,
): Promise<ExperimentId> {
  const path = `/aleph/api/programs/${programId}/issues/${issueId}/experiments`
  const response = await post(host, path, RESEARCHER, { plan: PLAN_BODY })
  assert.equal(response.status, 201)
  return parse(parseExperimentId, responseId(response, 'experiment.propose'), 'experiment id')
}

/**
 * Seed and submit a running Ticket. The frozen command surface has no Ticket-creation
 * command, so the test seeds the aggregate through the store port exactly as the future
 * Ticket service will.
 */
async function submitTicket(
  host: ResearchHost,
  store: InMemoryStore,
  programId: ProgramId,
  issueId: IssueId,
  experimentId: ExperimentId,
): Promise<TicketId> {
  const id = parse(parseTicketId, 'ticket-1', 'ticket id')
  const running = must(
    createRunningTicket({
      id,
      programId,
      issueId,
      experimentId,
      baseCommit: HEAD,
      createdAt: AT,
      status: 'running',
      sessionId: IMPLEMENTER_SESSION,
      startedAt: AT,
    }),
    'running ticket',
  )
  const saved = await store.tickets.save(INITIAL_VERSION, running)
  if (!saved.ok) throw new Error(`ticket seed failed: ${saved.error.kind}`)

  const implementer = createImplementerPrincipal(IMPLEMENTER_SESSION, id)
  const response = await post(host, '/aleph/api/tickets/submit', implementer, {
    head: HEAD,
    environment: ENVIRONMENT_BODY,
  })
  assert.equal(response.status, 200)
  return id
}

async function requestCI(
  host: ResearchHost,
  programId: ProgramId,
  experimentId: ExperimentId,
): Promise<void> {
  const path = `/aleph/api/programs/${programId}/experiments/${experimentId}/ci`
  const response = await post(host, path, RESEARCHER, {})
  assert.equal(response.status, 200)
}

interface Lifecycle {
  readonly program: ProgramId
  readonly issue: IssueId
  readonly experiment: ExperimentId
}

/** Program -> Issue -> claim -> proposed Experiment, with the Host-injected assignment. */
async function runProposalLifecycle(harness: Harness): Promise<Lifecycle> {
  const program = await createProgram(harness.host)
  const issue = await createIssue(harness.host, program)
  await claimIssue(harness.host, program, issue)
  const experiment = await proposeExperiment(harness.host, program, issue)
  return { program, issue, experiment }
}

/** The same lifecycle plus a submitted Ticket and a requested CI run. */
async function runCILifecycle(harness: Harness): Promise<Lifecycle> {
  const lifecycle = await runProposalLifecycle(harness)
  await submitTicket(
    harness.host,
    harness.store,
    lifecycle.program,
    lifecycle.issue,
    lifecycle.experiment,
  )
  await requestCI(harness.host, lifecycle.program, lifecycle.experiment)
  return lifecycle
}

function reportOf(reports: readonly TriggerReport[], action: string): TriggerReport | undefined {
  return reports.find((report) => report.action === action)
}

// ---------------------------------------------------------------------------
// HTTP lifecycle and the panel snapshot
// ---------------------------------------------------------------------------

test('HTTP lifecycle writes through the root and the snapshot shows records and audit', async () => {
  const harness = makeHost()
  const lifecycle = await runProposalLifecycle(harness)

  const snapshot = snapshotValue(await harness.host.snapshot(lifecycle.program))
  assert.equal(snapshot.program.id, lifecycle.program)
  assert.equal(snapshot.program.status, 'running')
  assert.equal(snapshot.issues.length, 1)
  assert.equal(snapshot.issues[0]?.id, lifecycle.issue)
  assert.equal(snapshot.issues[0]?.status, 'assigned')
  assert.equal(snapshot.experiments.length, 1)
  assert.equal(snapshot.experiments[0]?.id, lifecycle.experiment)
  assert.equal(snapshot.experiments[0]?.status, 'open')
  assert.equal(snapshot.comments.length, 1)
  assert.equal(snapshot.comments[0]?.kind, 'plan')
  assert.deepEqual(
    snapshot.audit.map((entry) => entry.action),
    ['program.created', 'issue.created', 'issue.claimed', 'experiment.proposed'],
  )

  // The proposal only succeeds when the default resolver injected the assignment; the
  // issue now links the Experiment as well.
  if (snapshot.issues[0]?.status !== 'assigned') throw new Error('the issue must stay assigned')
  assert.deepEqual(snapshot.issues[0].experimentIds, [lifecycle.experiment])
  assert.equal(snapshot.issues[0].assignee.sessionId, 'researcher-session')
})

test('a snapshot for an unknown program is a not-found ApiResponse', async () => {
  const harness = makeHost()
  const missing = parse(parseProgramId, 'program-missing', 'missing program id')
  const response = await harness.host.snapshot(missing)
  assert.equal(response.ok, false)
  if (response.ok) throw new Error('the snapshot must be refused')
  assert.equal(response.status, 404)
  assert.equal(response.error.code, 'not-found')
  assert.deepEqual(response.audit, [])
})

// ---------------------------------------------------------------------------
// Host-context resolution: injectability and the assignee check
// ---------------------------------------------------------------------------

test('an injected Host-context table replaces the store-backed resolver', async () => {
  const store = createInMemoryStore()
  const triggerPort = createRecordingTriggerPort()
  const host = createResearchHost({
    store,
    clock: CLOCK,
    requestIds: createCounterRequestIds('injected'),
    hostContexts: INJECTED_HOST_CONTEXTS,
    triggerPort,
  })

  const path = '/aleph/api/programs/program-1/pause'
  const response = await post(host, path, OPERATOR, {})
  assert.equal(response.status, 403)
  assert.deepEqual(response.body, {
    ok: false,
    status: 403,
    error: INJECTED_REFUSAL,
  })
  // The default resolver would have let the request reach the handler (404 for the
  // missing program); a refusal here proves the injected table ran.
  assert.deepEqual(await host.emitTriggers(parse(parseProgramId, 'program-1', 'program id')), [])
  assert.equal(triggerPort.deliveries.length, 0)
})

test('the default resolver refuses a proposal for another researcher issue', async () => {
  const harness = makeHost()
  const program = await createProgram(harness.host)
  const issue = await createIssue(harness.host, program)
  const other = createResearcherPrincipal(
    parse(parseResearcherSessionId, 'other-researcher', 'other researcher session'),
  )
  const claim = await post(
    harness.host,
    `/aleph/api/programs/${program}/issues/${issue}/claim`,
    other,
    {},
  )
  assert.equal(claim.status, 200)

  const proposal = await post(
    harness.host,
    `/aleph/api/programs/${program}/issues/${issue}/experiments`,
    RESEARCHER,
    { plan: PLAN_BODY },
  )
  assert.equal(proposal.status, 403)

  const snapshot = snapshotValue(await harness.host.snapshot(program))
  assert.deepEqual(snapshot.experiments, [])
})

// ---------------------------------------------------------------------------
// Sampler: bootstrap fresh start and CI-run candidates
// ---------------------------------------------------------------------------

test('sampleBase takes a fresh start on an empty population', async () => {
  const harness = makeHost()
  const program = await createProgram(harness.host)

  const choice = must(await harness.host.sampleBase(program), 'sampleBase')
  assert.deepEqual(choice, { kind: 'fresh' })
  assert.equal(harness.samples.length, 1)
  assert.deepEqual(harness.samples[0]?.population, [])
})

test('sampleBase builds candidates with the passed record run id and commit', async () => {
  const harness = makeHost({ random: () => 0.5 })
  const program = await createProgram(harness.host)
  const experiment = parse(parseExperimentId, 'experiment-sampled', 'sampled experiment id')
  const runId = parse(parseCIRunId, 'ci-run-1', 'CI run id')

  const metrics: MetricMap = { [SCORE]: 0.9 }
  const record: PassedCIRecord = {
    id: runId,
    programId: program,
    experimentId: experiment,
    commit: HEAD,
    requestedBy: parse(parseResearcherSessionId, 'researcher-session', 'requesting session'),
    requestedAt: AT,
    status: 'passed',
    startedAt: AT,
    finishedAt: AT,
    environmentDigest: 'sha256:environment',
    metrics,
    artifacts: [],
    durationMs: parse(parseDurationMs, 1200, 'CI duration'),
  }
  const appended = await harness.store.ciRecords.append(record)
  if (!appended.ok) throw new Error(`CI seed failed: ${appended.error.kind}`)

  const choice = must(await harness.host.sampleBase(program), 'sampleBase')
  assert.equal(harness.samples.length, 1)
  const population = harness.samples[0]?.population ?? []
  assert.equal(population.length, 1)
  assert.equal(population[0]?.ciRunId, runId)
  assert.equal(population[0]?.experimentId, experiment)
  assert.equal(population[0]?.commit, HEAD)
  assert.deepEqual(population[0]?.metrics, metrics)

  assert.equal(choice.kind, 'derived')
  if (choice.kind !== 'derived') throw new Error('the sampler must choose the only candidate')
  assert.equal(choice.experimentId, experiment)
  assert.equal(choice.commit, HEAD)
})

// ---------------------------------------------------------------------------
// Triggers: mapped delivery and the refusal rule
// ---------------------------------------------------------------------------

test('program, issue, experiment and CI facts deliver the mapped triggers', async () => {
  const harness = makeHost()
  const lifecycle = await runCILifecycle(harness)

  const delivered = must(await harness.host.deliverTriggers(lifecycle.program), 'deliver triggers')
  assert.deepEqual(
    delivered.map((report) => report.action),
    [
      'program.created',
      'issue.created',
      'issue.claimed',
      'experiment.proposed',
      'experiment.ready',
      'ci.requested',
    ],
  )
  assert.deepEqual(
    delivered.map((report) => report.kind),
    [
      'program-created',
      'issue-created',
      'issue-claimed',
      'experiment-proposed',
      'experiment-ready',
      'ci-requested',
    ],
  )

  const issueReport = reportOf(delivered, 'issue.created')
  if (issueReport === undefined || issueReport.draft === null) {
    throw new Error('the issue fact must carry a draft')
  }
  assert.deepEqual(
    issueReport.draft.threads.map((thread) => thread.kind),
    ['program', 'issue'],
  )
  assert.equal(issueReport.draft.human, true)

  const proposed = reportOf(delivered, 'experiment.proposed')
  if (proposed === undefined || proposed.draft === null) {
    throw new Error('the experiment proposal must carry a draft')
  }
  assert.deepEqual(
    proposed.draft.threads.map((thread) => thread.kind),
    ['program', 'issue'],
  )

  const ready = reportOf(delivered, 'experiment.ready')
  if (ready === undefined || ready.draft === null) {
    throw new Error('the ready experiment must carry a draft')
  }
  assert.deepEqual(
    ready.draft.threads.map((thread) => thread.kind),
    ['program', 'experiment'],
  )

  const ci = reportOf(delivered, 'ci.requested')
  if (ci === undefined || ci.draft === null) {
    throw new Error('the CI request must carry a draft')
  }
  assert.deepEqual(
    ci.draft.threads.map((thread) => thread.kind),
    ['program', 'experiment'],
  )
  assert.equal(ci.draft.meta['subjectKind'], 'ci-run')

  assert.equal(harness.triggerPort.deliveries.length, delivered.length)
})

test('a parser refusal is audited as command.refused and is never delivered', async () => {
  const harness = makeHost()
  const program = await createProgram(harness.host)
  const path = `/aleph/api/programs/${program}/issues`
  const response = await post(harness.host, path, OPERATOR, { title: 'missing body and labels' })
  assert.equal(response.status, 400)

  const reports = await harness.host.emitTriggers(program)
  const refusal = reportOf(reports, 'command.refused')
  if (refusal === undefined) throw new Error('the refusal must be in the audit log')
  assert.equal(refusal.kind, null)
  assert.equal(refusal.draft, null)

  const delivered = must(await harness.host.deliverTriggers(program), 'deliver triggers')
  assert.deepEqual(
    delivered.map((report) => report.action),
    ['program.created'],
  )
  assert.deepEqual(
    harness.triggerPort.deliveries.map((report) => report.action),
    ['program.created'],
  )
})

// ---------------------------------------------------------------------------
// Attention read
// ---------------------------------------------------------------------------

test('attention returns the entries attributed to the program', async () => {
  const harness = makeHost()
  const program = await createProgram(harness.host)
  const entry: Attention = {
    id: 'attention-1',
    subject: { kind: 'program', id: program },
    severity: 'warning',
    reason: 'budget is close',
    detail: 'two experiments remain',
    at: AT,
  }
  const appended = await harness.store.attention.append(entry)
  if (!appended.ok) throw new Error(`attention seed failed: ${appended.error.kind}`)

  assert.deepEqual(await harness.host.attention(program), [entry])
})
