import type { Result } from '../types/errors.js'
import type {
  CoreBenchmarkMetric,
  CoreBenchmarkSpec,
  CoreEnvironmentDeclaration,
  CoreMetricWeight,
  CoreResearchPolicy,
} from './boundary.js'
import type {
  CommandBridge,
  CoreCommandActor,
  CoreCommandDraft,
  CoreCommandError,
  CoreCommandOutcome,
  CoreLineage,
  CoreResearcherDecision,
} from './command-boundary.js'
import type { RouteName, SessionRole } from './surface.js'

export interface CommandSurfaceError {
  readonly code: string
  readonly message: string
  readonly status: number
}

export interface CommandSurfaceExecution {
  readonly command: CoreCommandOutcome
  readonly id: string
}

export interface CommandSurface {
  handles(name: string): boolean
  execute(
    name: string,
    input: unknown,
    actor: { readonly kind: SessionRole; readonly sessionId: string },
  ): Promise<Result<CommandSurfaceExecution, CommandSurfaceError>>
}

const ROUTE_BY_TOOL: Readonly<Record<string, RouteName>> = {
  aleph_research_create_program: 'program.create',
  aleph_research_pause_program: 'program.pause',
  aleph_research_resume_program: 'program.resume',
  aleph_research_stop_program: 'program.stop',
  aleph_research_set_goal: 'program.goal',
  aleph_research_set_methodology: 'program.methodology',
  aleph_research_set_exploration: 'program.exploration',
  aleph_research_create_issue: 'issue.create',
  aleph_research_claim_issue: 'issue.claim',
  aleph_research_comment_issue: 'issue.comment',
  aleph_research_close_issue: 'issue.close',
  aleph_research_propose_experiment: 'experiment.propose',
  aleph_research_review_experiment: 'experiment.review',
  aleph_research_close_experiment: 'experiment.close',
}

const COMMAND_NAMES: readonly RouteName[] = [
  'program.create',
  'program.pause',
  'program.resume',
  'program.stop',
  'program.goal',
  'program.methodology',
  'program.exploration',
  'issue.create',
  'issue.claim',
  'issue.comment',
  'issue.close',
  'experiment.propose',
  'experiment.review',
  'experiment.close',
]

const PROGRAM_COMMANDS: readonly RouteName[] = [
  'program.pause',
  'program.resume',
  'program.stop',
  'program.goal',
  'program.methodology',
  'program.exploration',
]

type UnknownRecord = Readonly<Record<string, unknown>>

function recordOf(value: unknown): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const output: Record<string, unknown> = {}
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') continue
    output[key] = Reflect.get(value, key)
  }
  return output
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function stringsOf(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  const strings: string[] = []
  for (const item of value) {
    if (typeof item === 'string') strings.push(item)
  }
  return strings
}

function routeOf(name: string): RouteName | undefined {
  const aliased = ROUTE_BY_TOOL[name]
  if (aliased !== undefined) return aliased
  return COMMAND_NAMES.find((candidate) => candidate === name)
}

function roleOf(kind: SessionRole): 'operator' | 'researcher' | 'implementer' | undefined {
  if (kind === 'operator') return 'operator'
  if (kind === 'researcher') return 'researcher'
  if (kind === 'implementer') return 'implementer'
  return undefined
}

function actorFor(
  route: RouteName,
  actor: { readonly kind: SessionRole; readonly sessionId: string },
  programId: string,
): CoreCommandActor | undefined {
  const role = roleOf(actor.kind)
  if (role === undefined) return undefined
  if (route === 'program.create') {
    return { id: programId, role, sessionId: actor.sessionId }
  }
  if (PROGRAM_COMMANDS.includes(route)) {
    return { id: programId, role, sessionId: actor.sessionId }
  }
  if (actor.sessionId.length === 0) return undefined
  return { id: actor.sessionId, role, sessionId: actor.sessionId }
}

function benchmarkOf(input: UnknownRecord): CoreBenchmarkSpec {
  const contract = recordOf(input['contract'])
  const utility = recordOf(input['utility'])
  const metrics = Array.isArray(utility['metrics']) ? utility['metrics'] : []
  const required = stringsOf(contract['requiredMetrics'])
  const names = required.length > 0
    ? required
    : metrics
        .map((metric) => textOf(recordOf(metric)['name']))
        .filter((name) => name.length > 0)
  const definitions = new Map<string, UnknownRecord>()
  for (const metric of metrics) {
    const definition = recordOf(metric)
    definitions.set(textOf(definition['name']), definition)
  }
  const benchmarkMetrics: CoreBenchmarkMetric[] = names.map((name) => {
    const definition = definitions.get(name)
    const direction = definition?.['direction'] === 'lower' ? 'minimize' : 'maximize'
    return { name, direction, required: true }
  })
  return {
    id: `benchmark-${textOf(input['programId']) || 'program'}`,
    entry: textOf(contract['ciEntry']),
    timeoutMs: String(numberOf(contract['timeoutMs'])),
    metrics: benchmarkMetrics,
    maxRetries: 0,
    baseline: {},
  }
}

function utilityOf(input: UnknownRecord): readonly CoreMetricWeight[] {
  const utility = recordOf(input['utility'])
  const metrics = Array.isArray(utility['metrics']) ? utility['metrics'] : []
  return metrics.map((value) => {
    const metric = recordOf(value)
    return {
      name: textOf(metric['name']),
      direction: metric['direction'] === 'lower' ? 'minimize' : 'maximize',
      weight: numberOf(metric['weight']),
    }
  })
}

function policyOf(input: UnknownRecord): CoreResearchPolicy {
  const budget = recordOf(input['budget'])
  return {
    maxExperiments: numberOf(budget['maxExperiments']),
    maxComputeMinutes: String(numberOf(budget['maxComputeMinutes'])),
    maxTokens: String(numberOf(budget['maxTokens'])),
    maxAttemptsPerExperiment: 2,
  }
}

function environmentOf(value: unknown): CoreEnvironmentDeclaration {
  const environment = recordOf(value)
  if (environment['kind'] === 'uv-lock') {
    return {
      kind: 'uv-lock',
      file: textOf(environment['lockFile']) || textOf(environment['file']) || 'uv.lock',
    }
  }
  return {
    kind: 'requirements',
    file: textOf(environment['requirementsFile'])
      || textOf(environment['file'])
      || 'requirements.txt',
  }
}

function explorationOf(value: unknown): 'low' | 'normal' | 'high' {
  if (value === 'low') return 'low'
  if (value === 'high') return 'high'
  return 'normal'
}

function decisionOf(value: unknown): CoreResearcherDecision {
  const input = recordOf(value)
  const decision = textOf(input['decision']) || textOf(input['verdict'])
  if (decision === 'revise' || decision === 'request-changes') return { kind: 'revise' }
  if (decision === 'stop') return { kind: 'stop', reason: 'goal-met' }
  return { kind: 'propose' }
}

function lineageOf(value: unknown, baseCommit: string): CoreLineage {
  const lineage = recordOf(value)
  const strategy = textOf(lineage['strategy'])
  const probability = numberOf(lineage['freshStartProbability'])
  return {
    strategy: strategy === 'continue' || strategy === 'branch' || strategy === 'fresh'
      ? strategy
      : 'fresh',
    baseCommit: textOf(lineage['baseCommit']) || baseCommit,
    freshStartProbability:
      probability >= 0 && probability <= 1 ? probability : 0,
  }
}

function draftOf(
  route: RouteName,
  input: UnknownRecord,
  programId: string,
  issueId: string,
  experimentId: string,
): CoreCommandDraft | undefined {
  switch (route) {
    case 'program.create':
      return {
        name: route,
        id: programId,
        programName: textOf(input['name']),
        goal: textOf(input['goal']),
        methodology: textOf(input['methodology']),
        benchmark: benchmarkOf(input),
        utility: [...utilityOf(input)],
        exploration: explorationOf(input['exploration']),
        policy: policyOf(input),
      }
    case 'program.pause':
    case 'program.resume':
    case 'program.stop':
      return { name: route, programId }
    case 'program.goal':
      return { name: route, programId, goal: textOf(input['goal']) }
    case 'program.methodology':
      return { name: route, programId, methodology: textOf(input['methodology']) }
    case 'program.exploration':
      return {
        name: route,
        programId,
        exploration: explorationOf(input['exploration'] ?? input['level']),
      }
    case 'issue.create':
      return {
        name: route,
        id: issueId,
        programId,
        title: textOf(input['title']),
        body: textOf(input['body']),
        labels: [...stringsOf(input['labels'])],
      }
    case 'issue.claim':
    case 'issue.close':
      return { name: route, issueId }
    case 'issue.comment':
      return { name: route, issueId, body: textOf(input['body']) }
    case 'experiment.propose': {
      const plan = recordOf(input['plan'])
      const head = textOf(input['head']) || textOf(input['baseCommit']) || '0'.repeat(40)
      const planCommentId = textOf(input['planCommentId'])
      const draft: CoreCommandDraft = {
        name: route,
        id: experimentId,
        programId,
        issueId,
        branch: textOf(input['branch'])
          || `experiment/${experimentId.replace(/[^A-Za-z0-9._-]/gu, '-')}`,
        head,
        environment: environmentOf(
          input['environment'] !== undefined ? input['environment'] : plan['environment'],
        ),
        lineage: lineageOf(input['lineage'], head),
      }
      if (planCommentId.length === 0) return draft
      return { ...draft, planCommentId }
    }
    case 'experiment.review':
      return {
        name: route,
        experimentId,
        decision: decisionOf(input),
      }
    case 'experiment.close':
      return { name: route, experimentId }
    case 'benchmark.request':
    case 'ticket.submit':
      return undefined
  }
}

function errorOf(error: CoreCommandError): CommandSurfaceError {
  switch (error.kind) {
    case 'invalid-draft':
      return { code: 'invalid-input', message: error.message, status: 400 }
    case 'unauthorized':
    case 'forbidden':
    case 'ownership':
      return { code: 'forbidden', message: error.message, status: 403 }
    case 'state-conflict':
      return { code: 'invalid-state', message: error.message, status: 409 }
    case 'storage':
      return { code: 'conflict', message: error.message, status: 409 }
    case 'clock':
    case 'protocol':
    case 'transport':
      return { code: 'internal', message: error.message, status: 500 }
  }
}

function outcomeId(outcome: CoreCommandOutcome): string {
  switch (outcome.kind) {
    case 'program-created':
    case 'program-updated':
      return outcome.program
    case 'issue-created':
    case 'issue-updated':
    case 'issue-commented':
      return outcome.issue
    case 'experiment-created':
    case 'experiment-updated':
    case 'experiment-reviewed':
    case 'benchmark-requested':
      return outcome.experiment
    case 'ticket-submitted':
      return outcome.ticket
  }
}

function idOf(input: UnknownRecord, keys: readonly string[], fallback: string): string {
  for (const key of keys) {
    const value = textOf(input[key])
    if (value.length > 0) return value
  }
  return fallback
}

export function createCommandSurface(options: {
  readonly bridge: CommandBridge
  readonly newId?: (prefix: string) => string
}): CommandSurface {
  let sequence = 0
  const newId = options.newId ?? ((prefix: string) => {
    sequence += 1
    return `${prefix}-${sequence}`
  })
  const handles = (name: string): boolean => routeOf(name) !== undefined
  return {
    handles,
    async execute(name, input, actor) {
      const route = routeOf(name)
      if (route === undefined) {
        return {
          ok: false,
          error: { code: 'not-found', message: `no command is bound to ${name}`, status: 404 },
        }
      }
      const body = recordOf(input)
      const generatedProgram = newId('program')
      const generatedIssue = newId('issue')
      const generatedExperiment = newId('experiment')
      const programId = idOf(body, ['programId', 'id'], generatedProgram)
      const issueId = idOf(body, ['issueId', 'id'], generatedIssue)
      const experimentId = idOf(body, ['experimentId', 'id'], generatedExperiment)
      const commandActor = actorFor(route, actor, programId)
      if (commandActor === undefined) {
        return {
          ok: false,
          error: { code: 'forbidden', message: 'the actor cannot issue this command', status: 403 },
        }
      }
      const draft = draftOf(route, body, programId, issueId, experimentId)
      if (draft === undefined) {
        return {
          ok: false,
          error: { code: 'not-found', message: `no command is bound to ${name}`, status: 404 },
        }
      }
      const executed = await options.bridge.execute(commandActor, draft)
      if (!executed.ok) return { ok: false, error: errorOf(executed.error) }
      return {
        ok: true,
        value: { command: executed.value, id: outcomeId(executed.value) },
      }
    },
  }
}
