import type { Result } from '../types/errors.js'
import type {
  CoreEnvironmentDeclaration,
  CoreMetricWeight,
  CoreProgram,
  CoreResearchPolicy,
  CoreUsage,
} from './boundary.js'
import {
  Decoder,
  Encoder,
  decodeDirection,
  decodeEnvironment,
  decodeSpec,
  decodeTimestamp,
  direction,
  encodeEnvironment,
  encodeSpec,
  encodeTimestamp,
} from './wasm-codec.js'
import type {
  CommandEffect,
  CommandEffectName,
  CommandEffectResult,
  CommandFrame,
  CoreAuditEntry,
  CoreCommandActor,
  CoreCommandDraft,
  CoreCommandError,
  CoreCommandErrorKind,
  CoreCommandOutcome,
  CoreCommandRole,
  CoreExperiment,
  CoreExperimentStatus,
  CoreIssue,
  CoreIssueStatus,
  CoreLineage,
  CoreLineageStrategy,
  CoreResearcherDecision,
  CoreTicket,
  CoreTicketStatus,
  CoreVersioned,
} from './command-boundary.js'
import type { IsoTimestamp } from '../types/ids.js'
import { isoTimestamp as parseIsoTimestamp, programId as parseProgramId } from '../parsers.js'

const COMMAND_CODES: Readonly<Record<CoreCommandDraft['name'], number>> = {
  'program.create': 0,
  'program.pause': 1,
  'program.resume': 2,
  'program.stop': 3,
  'program.goal': 4,
  'program.methodology': 5,
  'program.exploration': 6,
  'issue.create': 7,
  'issue.claim': 8,
  'issue.comment': 9,
  'issue.close': 10,
  'experiment.propose': 11,
  'experiment.review': 12,
  'experiment.close': 13,
  'benchmark.request': 14,
  'ticket.submit': 15,
}

const EFFECT_CODES: Readonly<Record<CommandEffectName, number>> = {
  'storage.loadProgram': 0,
  'storage.saveProgram': 11,
  'storage.loadIssue': 12,
  'storage.saveIssue': 13,
  'storage.loadExperiment': 14,
  'storage.saveExperiment': 15,
  'storage.loadTicket': 16,
  'storage.saveTicket': 17,
  'storage.appendAudit': 18,
  'clock.now': 10,
}

const EFFECT_NAMES: readonly CommandEffectName[] = [
  'storage.loadProgram',
  'storage.saveProgram',
  'storage.loadIssue',
  'storage.saveIssue',
  'storage.loadExperiment',
  'storage.saveExperiment',
  'storage.loadTicket',
  'storage.saveTicket',
  'storage.appendAudit',
  'clock.now',
]

const ERROR_KINDS: readonly CoreCommandErrorKind[] = [
  'invalid-draft',
  'unauthorized',
  'forbidden',
  'ownership',
  'state-conflict',
  'storage',
  'clock',
]

const FAILURE_KINDS: readonly ('rejected' | 'unavailable' | 'not-found' | 'conflict')[] = [
  'rejected',
  'unavailable',
  'not-found',
  'conflict',
]

class ProtocolFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProtocolFailure'
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : 'the command protocol failed'
}

function protocolError(error: unknown): CoreCommandError {
  return { kind: 'protocol', message: messageOf(error) }
}

function commandCode(draft: CoreCommandDraft): number {
  return COMMAND_CODES[draft.name]
}

function effectCode(effect: CommandEffectName): number {
  return EFFECT_CODES[effect]
}

function effectName(code: number): CommandEffectName {
  const name = EFFECT_NAMES.find((candidate) => EFFECT_CODES[candidate] === code)
  if (name === undefined) throw new ProtocolFailure('the command frame names an unknown effect')
  return name
}

function decodeRole(value: number): CoreCommandRole {
  if (value === 0) return 'operator'
  if (value === 1) return 'researcher'
  if (value === 2) return 'implementer'
  throw new ProtocolFailure('the command frame names an unknown role')
}

function encodeRole(role: CoreCommandRole): number {
  if (role === 'operator') return 0
  if (role === 'researcher') return 1
  return 2
}

function decodeIssueStatus(value: number): CoreIssueStatus {
  if (value === 0) return 'open'
  if (value === 1) return 'assigned'
  if (value === 2) return 'closed'
  throw new ProtocolFailure('the command frame names an unknown issue status')
}

function encodeIssueStatus(status: CoreIssueStatus): number {
  if (status === 'open') return 0
  if (status === 'assigned') return 1
  return 2
}

function decodeExperimentStatus(value: number): CoreExperimentStatus {
  if (value === 0) return 'open'
  if (value === 1) return 'concluded'
  if (value === 2) return 'failed'
  if (value === 3) return 'cancelled'
  throw new ProtocolFailure('the command frame names an unknown experiment status')
}

function encodeExperimentStatus(status: CoreExperimentStatus): number {
  if (status === 'open') return 0
  if (status === 'concluded') return 1
  if (status === 'failed') return 2
  return 3
}

function decodeTicketStatus(value: number): CoreTicketStatus {
  if (value === 0) return 'open'
  if (value === 1) return 'running'
  if (value === 2) return 'succeeded'
  if (value === 3) return 'failed'
  if (value === 4) return 'abandoned'
  throw new ProtocolFailure('the command frame names an unknown ticket status')
}

function encodeTicketStatus(status: CoreTicketStatus): number {
  if (status === 'open') return 0
  if (status === 'running') return 1
  if (status === 'succeeded') return 2
  if (status === 'failed') return 3
  return 4
}

function decodeLineageStrategy(value: number): CoreLineageStrategy {
  if (value === 0) return 'continue'
  if (value === 1) return 'branch'
  if (value === 2) return 'fresh'
  throw new ProtocolFailure('the command frame names an unknown lineage strategy')
}

function encodeLineageStrategy(strategy: CoreLineageStrategy): number {
  if (strategy === 'continue') return 0
  if (strategy === 'branch') return 1
  return 2
}

function decodeExploration(value: number): 'low' | 'normal' | 'high' {
  if (value === 0) return 'low'
  if (value === 1) return 'normal'
  if (value === 2) return 'high'
  throw new ProtocolFailure('the command frame names an unknown exploration level')
}

function encodeExploration(value: 'low' | 'normal' | 'high'): number {
  if (value === 'low') return 0
  if (value === 'normal') return 1
  return 2
}

function decodeProgramStatus(value: number): CoreProgram['status'] {
  if (value === 0) return 'running'
  if (value === 1) return 'paused'
  if (value === 2) return 'stopped'
  throw new ProtocolFailure('the command frame names an unknown program status')
}

function encodeProgramStatus(status: CoreProgram['status']): number {
  if (status === 'running') return 0
  if (status === 'paused') return 1
  return 2
}

function decodeDecision(decoder: Decoder): CoreResearcherDecision {
  const kind = decoder.u8()
  if (kind === 0) return { kind: 'propose' }
  if (kind === 1) return { kind: 'revise' }
  if (kind !== 2) throw new ProtocolFailure('the command frame names an unknown decision')
  const reason = decoder.u8()
  if (reason === 0) return { kind: 'stop', reason: 'goal-met' }
  if (reason === 1) return { kind: 'stop', reason: 'policy-exhausted' }
  if (reason === 2) return { kind: 'stop', reason: 'no-hypothesis' }
  if (reason === 3) return { kind: 'stop', reason: 'cancelled' }
  throw new ProtocolFailure('the command frame names an unknown stop reason')
}

function encodeDecision(encoder: Encoder, decision: CoreResearcherDecision): void {
  if (decision.kind === 'propose') {
    encoder.u8(0)
    return
  }
  if (decision.kind === 'revise') {
    encoder.u8(1)
    return
  }
  encoder.u8(2)
  if (decision.reason === 'goal-met') encoder.u8(0)
  else if (decision.reason === 'policy-exhausted') encoder.u8(1)
  else if (decision.reason === 'no-hypothesis') encoder.u8(2)
  else encoder.u8(3)
}

function encodeOptionalText(encoder: Encoder, value: string | undefined): void {
  if (value === undefined) {
    encoder.u8(0)
    return
  }
  encoder.u8(1)
  encoder.text(value)
}

function decodeOptionalText(decoder: Decoder): string | undefined {
  const present = decoder.u8()
  if (present === 0) return undefined
  if (present === 1) return decoder.text()
  throw new ProtocolFailure('the command frame has an invalid optional value')
}

function decodeOptionalVersion(decoder: Decoder): number | undefined {
  const present = decoder.u8()
  if (present === 0) return undefined
  if (present === 1) return decoder.u64()
  throw new ProtocolFailure('the command frame has an invalid optional version')
}

function encodePolicy(encoder: Encoder, policy: CoreResearchPolicy): void {
  encoder.u32(policy.maxExperiments)
  encoder.u64(policy.maxComputeMinutes)
  encoder.u64(policy.maxTokens)
  encoder.u32(policy.maxAttemptsPerExperiment)
}

function decodePolicy(decoder: Decoder): CoreResearchPolicy {
  return {
    maxExperiments: decoder.u32(),
    maxComputeMinutes: decoder.u64(),
    maxTokens: decoder.u64(),
    maxAttemptsPerExperiment: decoder.u32(),
  }
}

function encodeUsage(encoder: Encoder, usage: CoreUsage): void {
  encoder.u32(usage.experiments)
  encoder.u64(usage.computeMinutes)
  encoder.u64(usage.tokens)
}

function decodeUsage(decoder: Decoder): CoreUsage {
  return {
    experiments: decoder.u32(),
    computeMinutes: decoder.u64(),
    tokens: decoder.u64(),
  }
}

function encodeUtility(encoder: Encoder, utility: readonly CoreMetricWeight[]): void {
  encoder.u32(utility.length)
  for (const metric of utility) {
    encoder.text(metric.name)
    encoder.u8(direction(metric.direction))
    encoder.f64(metric.weight)
  }
}

function decodeUtility(decoder: Decoder): readonly CoreMetricWeight[] {
  const count = decoder.u32()
  const utility: CoreMetricWeight[] = []
  for (let index = 0; index < count; index += 1) {
    utility.push({
      name: decoder.text(),
      direction: decodeDirection(decoder.u8()),
      weight: decoder.f64(),
    })
  }
  return utility
}

function encodeProgramBody(encoder: Encoder, program: CoreProgram): void {
  encoder.text(program.id)
  encoder.text(program.owner)
  encoder.text(program.name)
  encoder.text(program.goal)
  encoder.text(program.methodology)
  encodeSpec(encoder, program.benchmark)
  encodeUtility(encoder, program.utility)
  encoder.u8(encodeExploration(program.exploration))
  encodePolicy(encoder, program.policy)
  encodeUsage(encoder, program.usage)
  encoder.u8(encodeProgramStatus(program.status))
  encodeTimestamp(encoder, program.createdAt)
}

function decodeProgramBody(decoder: Decoder): CoreProgram {
  const id = parseId(parseProgramId(decoder.text()), 'program id')
  const owner = decoder.text()
  const name = decoder.text()
  const goal = decoder.text()
  const methodology = decoder.text()
  const benchmark = decodeSpec(decoder)
  const utility = decodeUtility(decoder)
  const exploration = decodeExploration(decoder.u8())
  const policy = decodePolicy(decoder)
  const usage = decodeUsage(decoder)
  const status = decodeProgramStatus(decoder.u8())
  const createdAt = parseTimestamp(decodeTimestamp(decoder.text()))
  return {
    id,
    owner,
    name,
    goal,
    methodology,
    benchmark,
    utility,
    exploration,
    policy,
    usage,
    status,
    createdAt,
  }
}

function parseId<T>(result: Result<T, { readonly message: string }>, label: string): T {
  if (result.ok) return result.value
  throw new ProtocolFailure(`${label}: ${result.error.message}`)
}

function parseTimestamp(value: string): IsoTimestamp {
  const parsed = parseIsoTimestamp(value)
  if (parsed.ok) return parsed.value
  throw new ProtocolFailure(parsed.error.message)
}

function encodeEnvironmentDeclaration(
  encoder: Encoder,
  environment: CoreEnvironmentDeclaration,
): void {
  encodeEnvironment(encoder, environment)
}

function encodeLineage(encoder: Encoder, lineage: CoreLineage): void {
  encoder.u8(encodeLineageStrategy(lineage.strategy))
  encoder.text(lineage.baseCommit)
  encoder.f64(lineage.freshStartProbability)
}

function decodeLineage(decoder: Decoder): CoreLineage {
  return {
    strategy: decodeLineageStrategy(decoder.u8()),
    baseCommit: decoder.text(),
    freshStartProbability: decoder.f64(),
  }
}

function encodeIssueBody(encoder: Encoder, issue: CoreIssue): void {
  encoder.text(issue.id)
  encoder.text(issue.programId)
  encoder.text(issue.title)
  encoder.text(issue.body)
  encoder.u32(issue.labels.length)
  for (const label of issue.labels) encoder.text(label)
  encoder.text(issue.author)
  encodeTimestamp(encoder, issue.createdAt)
  encoder.u8(encodeIssueStatus(issue.status))
  encodeOptionalText(encoder, issue.assignee)
  encoder.u32(issue.experiments.length)
  for (const experiment of issue.experiments) encoder.text(experiment)
}

function decodeIssueBody(decoder: Decoder): CoreIssue {
  const id = decoder.text()
  const programId = decoder.text()
  const title = decoder.text()
  const body = decoder.text()
  const labelCount = decoder.u32()
  const labels: string[] = []
  for (let index = 0; index < labelCount; index += 1) labels.push(decoder.text())
  const author = decoder.text()
  const createdAt = parseTimestamp(decodeTimestamp(decoder.text()))
  const status = decodeIssueStatus(decoder.u8())
  const assignee = decodeOptionalText(decoder)
  const experimentCount = decoder.u32()
  const experiments: string[] = []
  for (let index = 0; index < experimentCount; index += 1) {
    experiments.push(decoder.text())
  }
  return assignee === undefined
    ? { id, programId, title, body, labels, author, createdAt, status, experiments }
    : { id, programId, title, body, labels, author, createdAt, status, assignee, experiments }
}

function encodeExperimentBody(encoder: Encoder, experiment: CoreExperiment): void {
  encoder.text(experiment.id)
  encoder.text(experiment.programId)
  encoder.text(experiment.issueId)
  encoder.text(experiment.branch)
  encoder.text(experiment.head)
  encodeEnvironmentDeclaration(encoder, experiment.environment)
  encodeLineage(encoder, experiment.lineage)
  encodeOptionalText(encoder, experiment.planCommentId)
  encoder.text(experiment.createdBy)
  encodeTimestamp(encoder, experiment.createdAt)
  encoder.u8(encodeExperimentStatus(experiment.status))
}

function decodeExperimentBody(decoder: Decoder): CoreExperiment {
  const id = decoder.text()
  const programId = decoder.text()
  const issueId = decoder.text()
  const branch = decoder.text()
  const head = decoder.text()
  const environment = decodeEnvironment(decoder)
  const lineage = decodeLineage(decoder)
  const planCommentId = decodeOptionalText(decoder)
  const createdBy = decoder.text()
  const createdAt = parseTimestamp(decodeTimestamp(decoder.text()))
  const status = decodeExperimentStatus(decoder.u8())
  return planCommentId === undefined
    ? {
        id,
        programId,
        issueId,
        branch,
        head,
        environment,
        lineage,
        createdBy,
        createdAt,
        status,
      }
    : {
        id,
        programId,
        issueId,
        branch,
        head,
        environment,
        lineage,
        planCommentId,
        createdBy,
        createdAt,
        status,
      }
}

function encodeTicketBody(encoder: Encoder, ticket: CoreTicket): void {
  encoder.text(ticket.id)
  encoder.text(ticket.experimentId)
  encoder.text(ticket.branch)
  encoder.text(ticket.baseCommit)
  encoder.u8(encodeTicketStatus(ticket.status))
  encodeOptionalText(encoder, ticket.commit)
  encodeOptionalText(encoder, ticket.workerSessionId)
}

function decodeTicketBody(decoder: Decoder): CoreTicket {
  const id = decoder.text()
  const experimentId = decoder.text()
  const branch = decoder.text()
  const baseCommit = decoder.text()
  const status = decodeTicketStatus(decoder.u8())
  const commit = decodeOptionalText(decoder)
  const workerSessionId = decodeOptionalText(decoder)
  const base = { id, experimentId, branch, baseCommit, status }
  if (commit === undefined) {
    return workerSessionId === undefined ? base : { ...base, workerSessionId }
  }
  return workerSessionId === undefined
    ? { ...base, commit }
    : { ...base, commit, workerSessionId }
}

function decodeAuditEntry(decoder: Decoder): CoreAuditEntry {
  return {
    id: decoder.text(),
    actor: decoder.text(),
    action: decoder.text(),
    subject: decoder.text(),
    detail: decoder.text(),
    requestId: decoder.text(),
    createdAt: parseTimestamp(decodeTimestamp(decoder.text())),
  }
}

function encodeDraft(encoder: Encoder, draft: CoreCommandDraft): void {
  encoder.u8(commandCode(draft))
  switch (draft.name) {
    case 'program.create':
      encoder.text(draft.id)
      encoder.text(draft.programName)
      encoder.text(draft.goal)
      encoder.text(draft.methodology)
      encodeSpec(encoder, draft.benchmark)
      encodeUtility(encoder, draft.utility)
      encoder.u8(encodeExploration(draft.exploration))
      encodePolicy(encoder, draft.policy)
      return
    case 'program.pause':
    case 'program.resume':
    case 'program.stop':
      encoder.text(draft.programId)
      return
    case 'program.goal':
      encoder.text(draft.programId)
      encoder.text(draft.goal)
      return
    case 'program.methodology':
      encoder.text(draft.programId)
      encoder.text(draft.methodology)
      return
    case 'program.exploration':
      encoder.text(draft.programId)
      encoder.u8(encodeExploration(draft.exploration))
      return
    case 'issue.create':
      encoder.text(draft.id)
      encoder.text(draft.programId)
      encoder.text(draft.title)
      encoder.text(draft.body)
      encoder.u32(draft.labels.length)
      for (const label of draft.labels) encoder.text(label)
      return
    case 'issue.claim':
    case 'issue.close':
      encoder.text(draft.issueId)
      return
    case 'issue.comment':
      encoder.text(draft.issueId)
      encoder.text(draft.body)
      return
    case 'experiment.propose':
      encoder.text(draft.id)
      encoder.text(draft.programId)
      encoder.text(draft.issueId)
      encoder.text(draft.branch)
      encoder.text(draft.head)
      encodeEnvironmentDeclaration(encoder, draft.environment)
      encodeLineage(encoder, draft.lineage)
      encodeOptionalText(encoder, draft.planCommentId)
      return
    case 'experiment.review':
      encoder.text(draft.experimentId)
      encodeDecision(encoder, draft.decision)
      return
    case 'experiment.close':
    case 'benchmark.request':
      encoder.text(draft.experimentId)
      return
    case 'ticket.submit':
      encoder.text(draft.ticketId)
      encoder.text(draft.commit)
      return
  }
}

export function encodeCommandRequest(
  actor: CoreCommandActor,
  requestId: string,
  draft: CoreCommandDraft,
): Uint8Array {
  const encoder = new Encoder()
  encoder.text(requestId)
  encoder.text(actor.id)
  encoder.u8(encodeRole(actor.role))
  encodeOptionalText(encoder, actor.sessionId)
  encodeDraft(encoder, draft)
  return encoder.finish()
}

export function encodeCommandResume(input: CommandEffectResult): Uint8Array {
  const encoder = new Encoder()
  encoder.u64(input.sequence)
  encoder.u8(effectCode(input.effect))
  if (!input.result.ok) {
    encoder.u8(1)
    const kindIndex = FAILURE_KINDS.indexOf(input.result.failure.kind)
    encoder.u8(kindIndex)
    encoder.text(input.result.failure.message)
    return encoder.finish()
  }
  encoder.u8(0)
  encoder.blob(input.result.value)
  return encoder.finish()
}

export function decodeCommandFrame(
  bytes: Uint8Array,
): Result<CommandFrame, CoreCommandError> {
  try {
    const decoder = new Decoder(bytes)
    const kind = decoder.u8()
    if (kind === 0) {
      const effect = effectName(decoder.u8())
      const sequence = decoder.u64()
      decoder.u8()
      const payload = decoder.blob()
      decoder.finish()
      return { ok: true, value: { kind: 'effect', effect, sequence, payload } }
    }
    if (kind === 1) {
      const outcome = decodeOutcome(decoder)
      decoder.finish()
      return { ok: true, value: { kind: 'completed', outcome } }
    }
    if (kind === 2) {
      const message = decoder.text()
      decoder.finish()
      return { ok: false, error: { kind: 'protocol', message } }
    }
    if (kind === 3) {
      const kindCode = decoder.u8()
      const kindName = decoder.text()
      const command = decoder.text()
      const message = decoder.text()
      decoder.finish()
      const named = ERROR_KINDS.find((candidate, index) => index === kindCode)
      const errorKind = named ?? 'protocol'
      if (kindName !== errorKind) throw new ProtocolFailure('the command error kind is inconsistent')
      return command.length === 0
        ? { ok: false, error: { kind: errorKind, message } }
        : { ok: false, error: { kind: errorKind, command, message } }
    }
    throw new ProtocolFailure('the command frame names an unknown kind')
  } catch (error) {
    return { ok: false, error: protocolError(error) }
  }
}

export function decodeCommandEffect(
  effect: CommandEffectName,
  payload: Uint8Array,
): Result<CommandEffect, CoreCommandError> {
  try {
    const decoder = new Decoder(payload)
    const value = decodeCommandEffectValue(effect, decoder)
    decoder.finish()
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: protocolError(error) }
  }
}

function decodeCommandEffectValue(effect: CommandEffectName, decoder: Decoder): CommandEffect {
  switch (effect) {
    case 'storage.loadProgram':
      return { name: effect, programId: decoder.text() }
    case 'storage.saveProgram': {
      const expected = decodeOptionalVersion(decoder)
      const program = decodeProgramBody(decoder)
      return expected === undefined
        ? { name: effect, program }
        : { name: effect, expected, program }
    }
    case 'storage.loadIssue':
      return { name: effect, issueId: decoder.text() }
    case 'storage.saveIssue': {
      const expected = decodeOptionalVersion(decoder)
      const issue = decodeIssueBody(decoder)
      return expected === undefined
        ? { name: effect, issue }
        : { name: effect, expected, issue }
    }
    case 'storage.loadExperiment':
      return { name: effect, experimentId: decoder.text() }
    case 'storage.saveExperiment': {
      const expected = decodeOptionalVersion(decoder)
      const experiment = decodeExperimentBody(decoder)
      return expected === undefined
        ? { name: effect, experiment }
        : { name: effect, expected, experiment }
    }
    case 'storage.loadTicket':
      return { name: effect, ticketId: decoder.text() }
    case 'storage.saveTicket': {
      const expected = decodeOptionalVersion(decoder)
      const ticket = decodeTicketBody(decoder)
      return expected === undefined
        ? { name: effect, ticket }
        : { name: effect, expected, ticket }
    }
    case 'storage.appendAudit': {
      const role = decodeRole(decoder.u8())
      return { name: effect, role, entry: decodeAuditEntry(decoder) }
    }
    case 'clock.now':
      return { name: effect }
  }
}

function decodeOutcome(decoder: Decoder): CoreCommandOutcome {
  const code = decoder.u8()
  if (code === 0) return { kind: 'program-created', program: decoder.text(), version: decoder.u64() }
  if (code === 1) return { kind: 'program-updated', program: decoder.text(), version: decoder.u64() }
  if (code === 2) return { kind: 'issue-created', issue: decoder.text(), version: decoder.u64() }
  if (code === 3) return { kind: 'issue-updated', issue: decoder.text(), version: decoder.u64() }
  if (code === 4) return { kind: 'issue-commented', issue: decoder.text() }
  if (code === 5) {
    return { kind: 'experiment-created', experiment: decoder.text(), version: decoder.u64() }
  }
  if (code === 6) {
    return { kind: 'experiment-updated', experiment: decoder.text(), version: decoder.u64() }
  }
  if (code === 7) {
    return {
      kind: 'experiment-reviewed',
      experiment: decoder.text(),
      decision: decodeDecision(decoder),
    }
  }
  if (code === 8) return { kind: 'benchmark-requested', experiment: decoder.text() }
  if (code === 9) {
    return {
      kind: 'ticket-submitted',
      ticket: decoder.text(),
      commit: decoder.text(),
      version: decoder.u64(),
    }
  }
  throw new ProtocolFailure('the command frame names an unknown outcome')
}

export function encodeLoadProgramValue(program: CoreVersioned<CoreProgram>): Uint8Array {
  const encoder = new Encoder()
  encoder.u64(program.version)
  encodeProgramBody(encoder, program.value)
  return encoder.finish()
}

export function encodeLoadIssueValue(issue: CoreVersioned<CoreIssue>): Uint8Array {
  const encoder = new Encoder()
  encoder.u64(issue.version)
  encodeIssueBody(encoder, issue.value)
  return encoder.finish()
}

export function encodeLoadExperimentValue(
  experiment: CoreVersioned<CoreExperiment>,
): Uint8Array {
  const encoder = new Encoder()
  encoder.u64(experiment.version)
  encodeExperimentBody(encoder, experiment.value)
  return encoder.finish()
}

export function encodeLoadTicketValue(ticket: CoreVersioned<CoreTicket>): Uint8Array {
  const encoder = new Encoder()
  encoder.u64(ticket.version)
  encodeTicketBody(encoder, ticket.value)
  return encoder.finish()
}

export function encodeVersionValue(version: number): Uint8Array {
  const encoder = new Encoder()
  encoder.u64(version)
  return encoder.finish()
}

export function encodeClockValue(value: IsoTimestamp): Uint8Array {
  const encoder = new Encoder()
  encodeTimestamp(encoder, value)
  return encoder.finish()
}

export function encodeEmptyValue(): Uint8Array {
  return new Uint8Array()
}

