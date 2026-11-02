import type { Principal } from '../types/actors.js'
import type { DomainError, Result } from '../types/errors.js'
import type { NonEmptyString } from '../types/ids.js'
import { nonEmptyString as parseNonEmptyString } from '../parsers.js'

export type SessionRole = 'operator' | 'researcher' | 'implementer' | 'watchdog'
export type HttpMethod = 'GET' | 'POST'
export type SettingKind = 'boolean' | 'list' | 'number' | 'string'

export type RouteName =
  | 'program.create'
  | 'program.pause'
  | 'program.resume'
  | 'program.stop'
  | 'program.goal'
  | 'program.methodology'
  | 'program.exploration'
  | 'issue.create'
  | 'issue.claim'
  | 'issue.comment'
  | 'issue.close'
  | 'experiment.propose'
  | 'experiment.review'
  | 'experiment.close'
  | 'benchmark.request'
  | 'ticket.submit'

export type ToolName =
  | 'aleph_research_create_program'
  | 'aleph_research_pause_program'
  | 'aleph_research_resume_program'
  | 'aleph_research_stop_program'
  | 'aleph_research_set_goal'
  | 'aleph_research_set_methodology'
  | 'aleph_research_set_exploration'
  | 'aleph_research_create_issue'
  | 'aleph_research_claim_issue'
  | 'aleph_research_comment_issue'
  | 'aleph_research_close_issue'
  | 'aleph_research_propose_experiment'
  | 'aleph_research_review_experiment'
  | 'aleph_research_close_experiment'
  | 'aleph_research_request_benchmark'
  | 'aleph_research_submit_ticket'
  | 'aleph_research_read_program'
  | 'aleph_research_read_benchmarks'
  | 'aleph_research_read_experiment'

export type PresetName =
  | 'aleph-operator'
  | 'aleph-researcher'
  | 'aleph-implementer'
  | 'aleph-watchdog'

export type SettingName =
  | 'actorKinds'
  | 'maxBodyBytes'
  | 'storageDomain'
  | 'wasmSource'

export type SurfaceName = RouteName | ToolName | PresetName | SettingName
export type SurfaceKind = 'route' | 'tool' | 'preset' | 'setting'

export interface RouteDeclaration<N extends RouteName = RouteName> {
  readonly name: N
  readonly method: HttpMethod
  readonly path: string
}

export interface ToolDeclaration<N extends ToolName = ToolName> {
  readonly name: N
  readonly description: string
  readonly role: SessionRole
}

export interface PresetDeclaration<N extends PresetName = PresetName> {
  readonly name: N
  readonly description: string
}

export interface SettingDeclaration<N extends SettingName = SettingName> {
  readonly name: N
  readonly description: string
  readonly kind: SettingKind
}

export const ROUTES: { readonly [N in RouteName]: RouteDeclaration<N> } = {
  'program.create': {
    name: 'program.create',
    method: 'POST',
    path: '/aleph/api/research/programs',
  },
  'program.pause': {
    name: 'program.pause',
    method: 'POST',
    path: '/aleph/api/research/programs/:programId/pause',
  },
  'program.resume': {
    name: 'program.resume',
    method: 'POST',
    path: '/aleph/api/research/programs/:programId/resume',
  },
  'program.stop': {
    name: 'program.stop',
    method: 'POST',
    path: '/aleph/api/research/programs/:programId/stop',
  },
  'program.goal': {
    name: 'program.goal',
    method: 'POST',
    path: '/aleph/api/research/programs/:programId/goal',
  },
  'program.methodology': {
    name: 'program.methodology',
    method: 'POST',
    path: '/aleph/api/research/programs/:programId/methodology',
  },
  'program.exploration': {
    name: 'program.exploration',
    method: 'POST',
    path: '/aleph/api/research/programs/:programId/exploration',
  },
  'issue.create': {
    name: 'issue.create',
    method: 'POST',
    path: '/aleph/api/research/programs/:programId/issues',
  },
  'issue.claim': {
    name: 'issue.claim',
    method: 'POST',
    path: '/aleph/api/research/programs/:programId/issues/:issueId/claim',
  },
  'issue.comment': {
    name: 'issue.comment',
    method: 'POST',
    path: '/aleph/api/research/programs/:programId/issues/:issueId/comments',
  },
  'issue.close': {
    name: 'issue.close',
    method: 'POST',
    path: '/aleph/api/research/programs/:programId/issues/:issueId/close',
  },
  'experiment.propose': {
    name: 'experiment.propose',
    method: 'POST',
    path: '/aleph/api/research/programs/:programId/issues/:issueId/experiments',
  },
  'experiment.review': {
    name: 'experiment.review',
    method: 'POST',
    path: '/aleph/api/research/programs/:programId/experiments/:experimentId/reviews',
  },
  'experiment.close': {
    name: 'experiment.close',
    method: 'POST',
    path: '/aleph/api/research/programs/:programId/experiments/:experimentId/close',
  },
  'benchmark.request': {
    name: 'benchmark.request',
    method: 'POST',
    path: '/aleph/api/research/programs/:programId/experiments/:experimentId/benchmarks',
  },
  'ticket.submit': {
    name: 'ticket.submit',
    method: 'POST',
    path: '/aleph/api/research/tickets/submit',
  },
}

export const TOOLS: { readonly [N in ToolName]: ToolDeclaration<N> } = {
  aleph_research_create_program: {
    name: 'aleph_research_create_program',
    description: 'Create a Program with a benchmark contract, utility and budget.',
    role: 'operator',
  },
  aleph_research_pause_program: {
    name: 'aleph_research_pause_program',
    description: 'Pause a running Program.',
    role: 'operator',
  },
  aleph_research_resume_program: {
    name: 'aleph_research_resume_program',
    description: 'Resume a paused Program.',
    role: 'operator',
  },
  aleph_research_stop_program: {
    name: 'aleph_research_stop_program',
    description: 'Stop a Program.',
    role: 'operator',
  },
  aleph_research_set_goal: {
    name: 'aleph_research_set_goal',
    description: 'Replace the goal of a Program.',
    role: 'operator',
  },
  aleph_research_set_methodology: {
    name: 'aleph_research_set_methodology',
    description: 'Replace the methodology of a Program.',
    role: 'operator',
  },
  aleph_research_set_exploration: {
    name: 'aleph_research_set_exploration',
    description: 'Set the exploration level of a Program.',
    role: 'operator',
  },
  aleph_research_create_issue: {
    name: 'aleph_research_create_issue',
    description: 'Create an Issue in a Program.',
    role: 'operator',
  },
  aleph_research_claim_issue: {
    name: 'aleph_research_claim_issue',
    description: 'Claim an open Issue for the acting Researcher.',
    role: 'researcher',
  },
  aleph_research_comment_issue: {
    name: 'aleph_research_comment_issue',
    description: 'Add a comment or plan to an Issue.',
    role: 'researcher',
  },
  aleph_research_close_issue: {
    name: 'aleph_research_close_issue',
    description: 'Close an Issue with a resolution.',
    role: 'researcher',
  },
  aleph_research_propose_experiment: {
    name: 'aleph_research_propose_experiment',
    description: 'Propose an Experiment for an assigned Issue.',
    role: 'researcher',
  },
  aleph_research_review_experiment: {
    name: 'aleph_research_review_experiment',
    description: 'Record a review of an Experiment.',
    role: 'researcher',
  },
  aleph_research_close_experiment: {
    name: 'aleph_research_close_experiment',
    description: 'Close an Experiment with a reason.',
    role: 'researcher',
  },
  aleph_research_request_benchmark: {
    name: 'aleph_research_request_benchmark',
    description: 'Request a benchmark run for an Experiment.',
    role: 'researcher',
  },
  aleph_research_submit_ticket: {
    name: 'aleph_research_submit_ticket',
    description: 'Submit the Implementer commit for the bound Ticket.',
    role: 'implementer',
  },
  aleph_research_read_program: {
    name: 'aleph_research_read_program',
    description: 'Read a Program and its recorded benchmark rows.',
    role: 'operator',
  },
  aleph_research_read_benchmarks: {
    name: 'aleph_research_read_benchmarks',
    description: 'Read the raw benchmark rows of a Program.',
    role: 'researcher',
  },
  aleph_research_read_experiment: {
    name: 'aleph_research_read_experiment',
    description: 'Read the Experiment bound to the acting Ticket.',
    role: 'implementer',
  },
}

export const PRESETS: { readonly [N in PresetName]: PresetDeclaration<N> } = {
  'aleph-operator': {
    name: 'aleph-operator',
    description: 'AlephResearch Operator session.',
  },
  'aleph-researcher': {
    name: 'aleph-researcher',
    description: 'AlephResearch Researcher session.',
  },
  'aleph-implementer': {
    name: 'aleph-implementer',
    description: 'AlephResearch Implementer session.',
  },
  'aleph-watchdog': {
    name: 'aleph-watchdog',
    description: 'AlephResearch Watchdog session.',
  },
}

export const SETTINGS: { readonly [N in SettingName]: SettingDeclaration<N> } = {
  actorKinds: {
    name: 'actorKinds',
    description: 'Principal kinds the HTTP routes accept.',
    kind: 'list',
  },
  maxBodyBytes: {
    name: 'maxBodyBytes',
    description: 'Maximum accepted request body size.',
    kind: 'number',
  },
  storageDomain: {
    name: 'storageDomain',
    description: 'DSH storage domain that holds the research tables.',
    kind: 'string',
  },
  wasmSource: {
    name: 'wasmSource',
    description: 'Path of the Rust core wasm module.',
    kind: 'string',
  },
}

export interface Surface {
  readonly routes: Readonly<Record<RouteName, RouteDeclaration>>
  readonly tools: Readonly<Record<ToolName, ToolDeclaration>>
  readonly presets: Readonly<Record<PresetName, PresetDeclaration>>
  readonly settings: Readonly<Record<SettingName, SettingDeclaration>>
}

export const SURFACE: Surface = {
  routes: ROUTES,
  tools: TOOLS,
  presets: PRESETS,
  settings: SETTINGS,
}

export const SURFACE_NAMES: readonly SurfaceName[] = [
  ...Object.values(ROUTES).map((declaration) => declaration.name),
  ...Object.values(TOOLS).map((declaration) => declaration.name),
  ...Object.values(PRESETS).map((declaration) => declaration.name),
  ...Object.values(SETTINGS).map((declaration) => declaration.name),
]

export interface RouteRequest {
  readonly name: RouteName
  readonly method: HttpMethod
  readonly path: string
  readonly params: Readonly<Record<string, string>>
  readonly body: unknown
  readonly actor: Principal
}

export interface RouteResponse {
  readonly status: number
  readonly body: unknown
}

export type RouteHandler = (request: RouteRequest) => Promise<RouteResponse>

export interface ToolRequest {
  readonly name: ToolName
  readonly input: unknown
  readonly actor: Principal
}

export type ToolHandler = (request: ToolRequest) => Promise<Result<unknown, DomainError>>

export interface PresetRequest {
  readonly name: PresetName
  readonly workspaceId: string
  readonly sessionId?: string
}

export type PresetHandler = (request: PresetRequest) => Promise<Result<string, DomainError>>

export interface SettingRequest {
  readonly name: SettingName
  readonly value: unknown
}

export type SettingHandler = (request: SettingRequest) => Promise<Result<void, DomainError>>

export interface RouteHandlerEntry {
  readonly kind: 'route'
  readonly handle: RouteHandler
}

export interface ToolHandlerEntry {
  readonly kind: 'tool'
  readonly handle: ToolHandler
}

export interface PresetHandlerEntry {
  readonly kind: 'preset'
  readonly handle: PresetHandler
}

export interface SettingHandlerEntry {
  readonly kind: 'setting'
  readonly handle: SettingHandler
}

export type Handler = RouteHandlerEntry | ToolHandlerEntry | PresetHandlerEntry | SettingHandlerEntry

export type SurfaceHandlers = Readonly<Record<SurfaceName, Handler>>

export interface RouteRegistration {
  readonly name: RouteName
  readonly method: HttpMethod
  readonly path: string
  readonly handle: RouteHandler
}

export interface ToolRegistration {
  readonly name: ToolName
  readonly description: string
  readonly role: SessionRole
  readonly handle: ToolHandler
}

export interface PresetRegistration {
  readonly name: PresetName
  readonly description: string
  readonly handle: PresetHandler
}

export interface SettingRegistration {
  readonly name: SettingName
  readonly description: string
  readonly kind: SettingKind
  readonly handle: SettingHandler
}

export interface RouteRegistrar {
  register(route: RouteRegistration): Promise<Result<void, DomainError>>
}

export interface ToolRegistrar {
  register(tool: ToolRegistration): Promise<Result<void, DomainError>>
}

export interface PresetRegistrar {
  register(preset: PresetRegistration): Promise<Result<void, DomainError>>
}

export interface SettingRegistrar {
  register(setting: SettingRegistration): Promise<Result<void, DomainError>>
}

export interface SurfacePorts {
  readonly http: RouteRegistrar
  readonly tools: ToolRegistrar
  readonly sessions: PresetRegistrar
  readonly settings: SettingRegistrar
}

export interface SurfaceBinding {
  readonly name: SurfaceName
  readonly result: Result<void, DomainError>
}

export interface SurfaceBindResult {
  readonly bindings: readonly SurfaceBinding[]
  readonly ok: boolean
}

const INVALID_HANDLER_MESSAGE = requiredMessage('the surface handler kind does not match the surface declaration')

function requiredMessage(value: string): NonEmptyString {
  const parsed = parseNonEmptyString(value)
  if (!parsed.ok) throw new Error('the adapter generated an empty surface message')
  return parsed.value
}

function kindFailure(): Result<void, DomainError> {
  return {
    ok: false,
    error: { code: 'invalid-input', message: INVALID_HANDLER_MESSAGE },
  }
}

export async function bindSurface(
  handlers: SurfaceHandlers,
  ports: SurfacePorts,
): Promise<SurfaceBindResult> {
  const bindings: SurfaceBinding[] = []

  for (const declaration of Object.values(ROUTES)) {
    const handler = handlers[declaration.name]
    if (handler.kind !== 'route') {
      bindings.push({ name: declaration.name, result: kindFailure() })
      continue
    }
    const result = await ports.http.register({
      name: declaration.name,
      method: declaration.method,
      path: declaration.path,
      handle: handler.handle,
    })
    bindings.push({ name: declaration.name, result })
  }

  for (const declaration of Object.values(TOOLS)) {
    const handler = handlers[declaration.name]
    if (handler.kind !== 'tool') {
      bindings.push({ name: declaration.name, result: kindFailure() })
      continue
    }
    const result = await ports.tools.register({
      name: declaration.name,
      description: declaration.description,
      role: declaration.role,
      handle: handler.handle,
    })
    bindings.push({ name: declaration.name, result })
  }

  for (const declaration of Object.values(PRESETS)) {
    const handler = handlers[declaration.name]
    if (handler.kind !== 'preset') {
      bindings.push({ name: declaration.name, result: kindFailure() })
      continue
    }
    const result = await ports.sessions.register({
      name: declaration.name,
      description: declaration.description,
      handle: handler.handle,
    })
    bindings.push({ name: declaration.name, result })
  }

  for (const declaration of Object.values(SETTINGS)) {
    const handler = handlers[declaration.name]
    if (handler.kind !== 'setting') {
      bindings.push({ name: declaration.name, result: kindFailure() })
      continue
    }
    const result = await ports.settings.register({
      name: declaration.name,
      description: declaration.description,
      kind: declaration.kind,
      handle: handler.handle,
    })
    bindings.push({ name: declaration.name, result })
  }

  return {
    bindings,
    ok: bindings.every((binding) => binding.result.ok),
  }
}
