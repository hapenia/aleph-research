import type { Principal } from '../types/actors.js'
import type { AuditEntry } from '../types/audit.js'
import type { DomainError, Result, StoreError } from '../types/errors.js'
import type { Experiment, ExperimentLineage } from '../types/experiment.js'
import type { EnvironmentDeclaration } from '../types/environment.js'
import type { Issue, IssueLabel } from '../types/issue.js'
import type { Program } from '../types/program.js'
import type { Ticket } from '../types/ticket.js'
import type { UnitOfWork } from '../types/storage.js'
import type { Version } from '../types/ids.js'
import {
  createAssignedIssue,
  createClosedExperiment,
  createClosedIssue,
  createFreshLineage,
  createOpenExperiment,
  createOpenIssue,
  createOpenTicket,
  createOperatorPrincipal,
  createPausedProgram,
  createResearcherPrincipal,
  createRunningProgram,
  createRunningTicket,
  createStoppedProgram,
  createSubmittedTicket,
} from '../factories.js'
import { hydrateAuditEntry } from '../hydration.js'
import {
  commitSha as parseCommitSha,
  experimentId as parseExperimentId,
  issueId as parseIssueId,
  operatorSessionId as parseOperatorSessionId,
  programId as parseProgramId,
  researcherSessionId as parseResearcherSessionId,
  ticketId as parseTicketId,
  version as parseVersion,
} from '../parsers.js'
import type {
  CommandClock,
  CommandStore,
  CoreAuditEntry,
  CoreCommandEffectFailure,
  CoreCommandRole,
  CoreExperiment,
  CoreIssue,
  CoreTicket,
} from './command-boundary.js'
import type {
  CoreBenchmarkMetric,
  CoreEnvironmentDeclaration,
  CoreMetricWeight,
  CoreProgram,
} from './boundary.js'

const ISSUE_LABELS: readonly IssueLabel[] = ['research', 'experiment', 'analysis', 'bug', 'blocked']

const AUDIT_ACTIONS: Readonly<Record<string, string>> = {
  'program.create': 'program.created',
  'program.pause': 'program.paused',
  'program.resume': 'program.resumed',
  'program.stop': 'program.stopped',
  'program.goal': 'program.goal-changed',
  'program.methodology': 'program.methodology-changed',
  'program.exploration': 'program.exploration-changed',
  'issue.create': 'issue.created',
  'issue.claim': 'issue.claimed',
  'issue.comment': 'issue.commented',
  'issue.close': 'issue.closed',
  'experiment.propose': 'experiment.proposed',
  'experiment.review': 'experiment.reviewed',
  'experiment.close': 'experiment.closed',
}

function require<T>(result: Result<T, DomainError>): T {
  if (result.ok) return result.value
  throw new Error(result.error.message)
}

function factory<T>(result: Result<T, DomainError>): T {
  if (result.ok) return result.value
  throw new Error(result.error.message)
}

function failureOf(error: StoreError): CoreCommandEffectFailure {
  if (error.kind === 'version-conflict') {
    return {
      kind: 'conflict',
      message: `version conflict: expected ${error.expected}, actual ${error.actual}`,
    }
  }
  return { kind: 'unavailable', message: error.message }
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : 'the command store failed'
}

async function saveVersioned<T>(
  repository: { save(expected: Version, next: T): Promise<Result<Version, StoreError>> },
  expected: string | undefined,
  next: T,
): Promise<Result<string, CoreCommandEffectFailure>> {
  const parsed = expected === undefined ? 0 : Number(expected)
  const saved = await repository.save(require(parseVersion(parsed)), next)
  return saved.ok
    ? { ok: true, value: String(saved.value) }
    : { ok: false, error: failureOf(saved.error) }
}

function programStatusOf(program: Program): 'running' | 'paused' | 'stopped' {
  if (program.status === 'paused') return 'paused'
  if (program.status === 'stopped' || program.status === 'completed') return 'stopped'
  return 'running'
}

function coreProgramOf(program: Program): CoreProgram {
  const definitions = new Map(
    program.utility.metrics.map((metric) => [metric.name, metric]),
  )
  const metrics: CoreBenchmarkMetric[] = program.contract.requiredMetrics.map((name) => {
    const definition = definitions.get(name)
    return {
      name,
      direction: definition?.direction === 'lower' ? 'minimize' : 'maximize',
      required: true,
    }
  })
  const utility: CoreMetricWeight[] = program.utility.metrics.map((metric) => ({
    name: metric.name,
    direction: metric.direction === 'lower' ? 'minimize' : 'maximize',
    weight: metric.weight,
  }))
  return {
    id: program.id,
    owner: program.id,
    name: program.name,
    goal: program.goal,
    methodology: program.methodology,
    benchmark: {
      id: `benchmark-${program.id}`,
      entry: program.contract.ciEntry,
      timeoutMs: String(program.contract.timeoutMs),
      metrics,
      maxRetries: 0,
      baseline: {},
    },
    utility,
    exploration: program.exploration,
    policy: {
      maxExperiments: program.budget.maxExperiments,
      maxComputeMinutes: String(program.budget.maxComputeMinutes),
      maxTokens: String(program.budget.maxTokens),
      maxAttemptsPerExperiment: 2,
    },
    usage: {
      experiments: program.usage.experiments,
      computeMinutes: String(program.usage.computeMinutes),
      tokens: String(program.usage.tokens),
    },
    status: programStatusOf(program),
    createdAt: program.createdAt,
  }
}

function labelsOf(labels: readonly string[]): readonly IssueLabel[] {
  const values: IssueLabel[] = []
  for (const label of labels) {
    const known = ISSUE_LABELS.find((candidate) => candidate === label)
    if (known !== undefined) values.push(known)
  }
  return values.length > 0 ? values : ['research']
}

function environmentOf(environment: EnvironmentDeclaration): CoreEnvironmentDeclaration {
  return environment.kind === 'uv-lock'
    ? { kind: 'uv-lock', file: environment.lockFile }
    : { kind: 'requirements', file: environment.requirementsFile }
}

function environmentDeclarationOf(
  environment: CoreEnvironmentDeclaration,
  existing: Experiment | undefined,
): EnvironmentDeclaration {
  const pythonVersion = existing !== undefined && existing.environment.pythonVersion.length > 0
    ? existing.environment.pythonVersion
    : '3.12'
  return environment.kind === 'uv-lock'
    ? { kind: 'uv-lock', lockFile: environment.file, pythonVersion }
    : { kind: 'requirements', requirementsFile: environment.file, pythonVersion }
}

function lineageOf(
  lineage: CoreExperiment['lineage'],
  existing: Experiment | undefined,
): ExperimentLineage {
  if (lineage.strategy !== 'fresh' && existing?.lineage.strategy === 'derive') {
    return existing.lineage
  }
  return factory(createFreshLineage({
    strategy: 'fresh',
    baseCommit: require(parseCommitSha(lineage.baseCommit)),
    freshStartProbability: lineage.freshStartProbability,
  }))
}

function authorOf(author: string): Principal {
  return createOperatorPrincipal(require(parseOperatorSessionId(author)))
}

function programRow(program: CoreProgram, clock: CommandClock, existing: Program | undefined): Program {
  const common: Record<string, unknown> = {
    id: program.id,
    name: program.name,
    goal: program.goal,
    methodology: program.methodology,
    contract: {
      ciEntry: program.benchmark.entry,
      timeoutMs: Number(program.benchmark.timeoutMs),
      requiredMetrics: program.benchmark.metrics.map((metric) => metric.name),
    },
    utility: {
      metrics: program.utility.map((metric) => ({
        name: metric.name,
        direction: metric.direction === 'maximize' ? 'higher' : 'lower',
        weight: Math.max(metric.weight, 0.0001),
      })),
    },
    exploration: program.exploration,
    budget: {
      maxExperiments: program.policy.maxExperiments,
      maxComputeMinutes: Number(program.policy.maxComputeMinutes),
      maxTokens: Number(program.policy.maxTokens),
    },
    usage: {
      experiments: program.usage.experiments,
      computeMinutes: Number(program.usage.computeMinutes),
      tokens: Number(program.usage.tokens),
    },
    createdAt: program.createdAt,
  }
  if (program.status === 'paused') {
    const pausedAt = existing?.status === 'paused' ? existing.pausedAt : clock.now()
    return factory(createPausedProgram({ ...common, status: 'paused', pausedAt }))
  }
  if (program.status === 'stopped') {
    const stoppedAt = existing?.status === 'stopped' ? existing.stoppedAt : clock.now()
    const stopReason = existing?.status === 'stopped' ? existing.stopReason : 'operator'
    return factory(createStoppedProgram({
      ...common,
      status: 'stopped',
      stoppedAt,
      stopReason,
    }))
  }
  return factory(createRunningProgram({ ...common, status: 'running' }))
}

function issueRow(issue: CoreIssue, clock: CommandClock): Issue {
  const common: Record<string, unknown> = {
    id: issue.id,
    programId: issue.programId,
    title: issue.title,
    body: issue.body,
    labels: labelsOf(issue.labels),
    author: authorOf(issue.author),
    createdAt: issue.createdAt,
  }
  if (issue.status === 'assigned') {
    return factory(createAssignedIssue({
      ...common,
      status: 'assigned',
      assignee: createResearcherPrincipal(
        require(parseResearcherSessionId(issue.assignee ?? 'researcher')),
      ),
      assignedAt: clock.now(),
      experimentIds: issue.experiments,
    }))
  }
  if (issue.status === 'closed') {
    return factory(createClosedIssue({
      ...common,
      status: 'closed',
      assigneeSessionId: issue.assignee ?? null,
      closedAt: clock.now(),
      resolution: 'accepted',
      summary: 'closed',
    }))
  }
  return factory(createOpenIssue({ ...common, status: 'open' }))
}

function experimentRow(
  experiment: CoreExperiment,
  clock: CommandClock,
  existing: Experiment | undefined,
): Experiment {
  const common: Record<string, unknown> = {
    id: experiment.id,
    programId: experiment.programId,
    issueId: experiment.issueId,
    branch: experiment.branch,
    head: experiment.head,
    environment: environmentDeclarationOf(experiment.environment, existing),
    lineage: lineageOf(experiment.lineage, existing),
    planCommentId: experiment.planCommentId ?? `plan-${experiment.id}`,
    createdBy: createResearcherPrincipal(
      require(parseResearcherSessionId(experiment.createdBy)),
    ),
    createdAt: experiment.createdAt,
  }
  if (experiment.status === 'open') {
    return factory(createOpenExperiment({ ...common, status: 'open' }))
  }
  const outcome = experiment.status === 'concluded'
    ? 'concluded'
    : experiment.status === 'failed'
      ? 'failed'
      : 'cancelled'
  return factory(createClosedExperiment({
    ...common,
    status: 'closed',
    closedAt: clock.now(),
    closeReason: 'closed',
    outcome,
  }))
}

function ticketRow(
  ticket: CoreTicket,
  clock: CommandClock,
  existing: Ticket | undefined,
): Ticket {
  if (existing === undefined) throw new Error('the ticket no longer exists')
  const common: Record<string, unknown> = {
    id: ticket.id,
    programId: existing.programId,
    issueId: existing.issueId,
    experimentId: ticket.experimentId,
    baseCommit: ticket.baseCommit,
    createdAt: existing.createdAt,
  }
  const sessionId = ticket.workerSessionId
    ?? ('sessionId' in existing && typeof existing.sessionId === 'string'
      ? existing.sessionId
      : 'implementer')
  if (ticket.status === 'succeeded') {
    return factory(createSubmittedTicket({
      ...common,
      status: 'submitted',
      sessionId,
      head: ticket.commit ?? existing.baseCommit,
      submittedAt: clock.now(),
    }))
  }
  if (ticket.status === 'running') {
    return factory(createRunningTicket({
      ...common,
      status: 'running',
      sessionId,
      startedAt: clock.now(),
    }))
  }
  return factory(createOpenTicket({ ...common, status: 'open' }))
}

function principalOf(role: CoreCommandRole, actor: string): Principal {
  if (role === 'researcher') {
    return createResearcherPrincipal(require(parseResearcherSessionId(actor)))
  }
  if (role === 'implementer') {
    throw new Error('implementer audit actions are not supported')
  }
  return createOperatorPrincipal(require(parseOperatorSessionId(actor)))
}

function subjectOf(entry: CoreAuditEntry): { readonly kind: string; readonly id: string } {
  const separator = entry.subject.indexOf(':')
  if (separator <= 0) throw new Error(`audit subject ${entry.subject} is malformed`)
  return {
    kind: entry.subject.slice(0, separator),
    id: entry.subject.slice(separator + 1),
  }
}

export function createDshCommandStore(options: {
  readonly store: UnitOfWork
  readonly clock: CommandClock
}): CommandStore {
  const store = options.store
  const clock = options.clock

  const auditEntryOf = async (
    entry: CoreAuditEntry,
    role: CoreCommandRole,
  ): Promise<AuditEntry> => {
    const action = AUDIT_ACTIONS[entry.action]
    if (action === undefined) throw new Error(`audit action ${entry.action} is not supported`)
    const subject = subjectOf(entry)
    let programId: string | undefined
    let auditSubject: { readonly kind: string; readonly id: string } = subject
    if (subject.kind === 'program') {
      programId = subject.id
    } else if (subject.kind === 'issue') {
      const stored = await store.issues.get(require(parseIssueId(subject.id)))
      programId = stored?.value.programId
    } else if (subject.kind === 'experiment') {
      const stored = await store.experiments.get(require(parseExperimentId(subject.id)))
      programId = stored?.value.programId
      if (entry.action === 'experiment.propose') {
        const issue = stored?.value.issueId
        if (issue !== undefined) auditSubject = { kind: 'issue', id: issue }
      }
    } else {
      throw new Error(`audit subject ${entry.subject} is not supported`)
    }
    if (programId === undefined) throw new Error('the audit subject has no program')
    const row = {
      id: entry.id,
      at: entry.createdAt,
      programId,
      action,
      subject: auditSubject,
      detail: entry.detail.length > 0 ? { detail: entry.detail } : {},
      actor: principalOf(role, entry.actor),
    }
    const decoded = hydrateAuditEntry(row)
    if (!decoded.ok) throw new Error(failureOf(decoded.error).message)
    return decoded.value
  }

  return {
    async loadProgram(programId) {
      const stored = await store.programs.get(require(parseProgramId(programId)))
      if (stored === undefined) return undefined
      return { value: coreProgramOf(stored.value), version: String(stored.version) }
    },
    async saveProgram(program, expected) {
      try {
        const existing = (await store.programs.get(require(parseProgramId(program.id))))?.value
        return await saveVersioned(
          store.programs,
          expected,
          programRow(program, clock, existing),
        )
      } catch (error) {
        return { ok: false, error: { kind: 'unavailable', message: messageOf(error) } }
      }
    },
    async loadIssue(issueId) {
      const stored = await store.issues.get(require(parseIssueId(issueId)))
      if (stored === undefined) return undefined
      const issue = stored.value
      const assignee = issue.status === 'assigned'
        ? issue.assignee.sessionId
        : issue.status === 'closed'
          ? issue.assigneeSessionId ?? undefined
          : undefined
      const experiments = issue.status === 'assigned' ? issue.experimentIds : []
      const base: CoreIssue = {
        id: issue.id,
        programId: issue.programId,
        title: issue.title,
        body: issue.body,
        labels: [...issue.labels],
        author: issue.author.sessionId,
        createdAt: issue.createdAt,
        status: issue.status,
        experiments: [...experiments],
      }
      const value: CoreIssue = assignee === undefined ? base : { ...base, assignee }
      return { value, version: String(stored.version) }
    },
    async saveIssue(issue, expected) {
      try {
        return await saveVersioned(store.issues, expected, issueRow(issue, clock))
      } catch (error) {
        return { ok: false, error: { kind: 'unavailable', message: messageOf(error) } }
      }
    },
    async loadExperiment(experimentId) {
      const stored = await store.experiments.get(require(parseExperimentId(experimentId)))
      if (stored === undefined) return undefined
      const experiment = stored.value
      const status: CoreExperiment['status'] = experiment.status === 'closed'
        ? experiment.outcome === 'failed'
          ? 'failed'
          : experiment.outcome === 'cancelled'
            ? 'cancelled'
            : 'concluded'
        : 'open'
      const value: CoreExperiment = {
        id: experiment.id,
        programId: experiment.programId,
        issueId: experiment.issueId,
        branch: experiment.branch,
        head: experiment.head,
        environment: environmentOf(experiment.environment),
        lineage: experiment.lineage.strategy === 'derive'
          ? {
              strategy: 'branch',
              baseCommit: experiment.lineage.baseCommit,
              freshStartProbability: 0,
            }
          : {
              strategy: 'fresh',
              baseCommit: experiment.lineage.baseCommit,
              freshStartProbability: experiment.lineage.freshStartProbability,
            },
        planCommentId: experiment.planCommentId,
        createdBy: experiment.createdBy.sessionId,
        createdAt: experiment.createdAt,
        status,
      }
      return { value, version: String(stored.version) }
    },
    async saveExperiment(experiment, expected) {
      try {
        const existing = (
          await store.experiments.get(require(parseExperimentId(experiment.id)))
        )?.value
        return await saveVersioned(
          store.experiments,
          expected,
          experimentRow(experiment, clock, existing),
        )
      } catch (error) {
        return { ok: false, error: { kind: 'unavailable', message: messageOf(error) } }
      }
    },
    async loadTicket(ticketId) {
      const stored = await store.tickets.get(require(parseTicketId(ticketId)))
      if (stored === undefined) return undefined
      const ticket = stored.value
      const status: CoreTicket['status'] = ticket.status === 'running'
        ? 'running'
        : ticket.status === 'submitted'
          ? 'succeeded'
          : ticket.status === 'open'
            ? 'open'
            : ticket.status === 'failed'
              ? 'failed'
              : 'abandoned'
      const base: CoreTicket = {
        id: ticket.id,
        experimentId: ticket.experimentId,
        branch: `ticket/${ticket.id}`,
        baseCommit: ticket.baseCommit,
        status,
      }
      const withSession = 'sessionId' in ticket && typeof ticket.sessionId === 'string'
        ? { ...base, workerSessionId: ticket.sessionId }
        : base
      const value: CoreTicket = ticket.status === 'submitted'
        ? { ...withSession, commit: ticket.head }
        : withSession
      return { value, version: String(stored.version) }
    },
    async saveTicket(ticket, expected) {
      try {
        const existing = (await store.tickets.get(require(parseTicketId(ticket.id))))?.value
        return await saveVersioned(store.tickets, expected, ticketRow(ticket, clock, existing))
      } catch (error) {
        return { ok: false, error: { kind: 'unavailable', message: messageOf(error) } }
      }
    },
    async appendAudit(entry, role) {
      try {
        const row = await auditEntryOf(entry, role)
        await store.audit.append([row])
        return { ok: true, value: undefined }
      } catch (error) {
        return { ok: false, error: { kind: 'unavailable', message: messageOf(error) } }
      }
    },
  }
}
