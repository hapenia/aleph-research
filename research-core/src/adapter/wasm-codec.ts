import {
  branchName as parseBranchName,
  commitSha as parseCommitSha,
  experimentId as parseExperimentId,
  implementerSessionId as parseImplementerSessionId,
  isoTimestamp as parseIsoTimestamp,
  issueId as parseIssueId,
  programId as parseProgramId,
  ticketId as parseTicketId,
} from '../parsers.js'
import type { Result } from '../types/errors.js'
import type {
  BranchName,
  CommitSha,
  ExperimentId,
  ImplementerSessionId,
  IsoTimestamp,
  IssueId,
  ProgramId,
  TicketId,
} from '../types/ids.js'
import type {
  CoreBenchmarkMetric,
  CoreBenchmarkRecord,
  CoreBenchmarkSpec,
  CoreBridgeError,
  CoreEffect,
  CoreEffectFrame,
  CoreEffectName,
  CoreEffectResume,
  CoreEnvironmentDeclaration,
  CoreFrame,
  CoreMetric,
  CoreMetricDirection,
  CoreOutcome,
  CoreProgram,
  CoreResearcherDecision,
  CoreStageName,
  CoreStartInput,
  CoreStopReason,
} from './boundary.js'

declare class TextEncoder {
  encode(input: string): Uint8Array
}

declare class TextDecoder {
  constructor(label?: string, options?: { readonly fatal?: boolean })
  decode(input: Uint8Array): string
}

const UTF8_ENCODER = new TextEncoder()
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

const STAGE_NAMES: readonly CoreStageName[] = [
  'IssueAssigned',
  'ExperimentProposed',
  'TriggerAccepted',
  'TicketOpened',
  'WorkerStarted',
  'CommitSubmitted',
  'EnvironmentBuilt',
  'BenchmarkPassed',
  'BenchmarkFailed',
  'BenchmarkRetryable',
  'ResultRecorded',
  'ReviewRecorded',
  'ResearchCompleted',
]

const EFFECT_NAMES: readonly CoreEffectName[] = [
  'storage.loadProgram',
  'trigger.deliver',
  'executor.open',
  'sessions.startWorker',
  'sessions.submitCommit',
  'benchmark.buildEnvironment',
  'benchmark.specHash',
  'benchmark.run',
  'storage.appendBenchmarkRecord',
  'sessions.review',
  'clock.now',
]

const EFFECT_CODES: Readonly<Record<CoreEffectName, number>> = {
  'storage.loadProgram': 0,
  'trigger.deliver': 1,
  'executor.open': 2,
  'sessions.startWorker': 3,
  'sessions.submitCommit': 4,
  'benchmark.buildEnvironment': 5,
  'benchmark.specHash': 6,
  'benchmark.run': 7,
  'storage.appendBenchmarkRecord': 8,
  'sessions.review': 9,
  'clock.now': 10,
}

const OUTCOMES: readonly CoreOutcome[] = ['concluded', 'failed', 'cancelled']

class ProtocolFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProtocolFailure'
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : 'the core protocol failed'
}

function base64Value(code: number): number {
  if (code >= 65 && code <= 90) return code - 65
  if (code >= 97 && code <= 122) return code - 71
  if (code >= 48 && code <= 57) return code + 4
  if (code === 43) return 62
  if (code === 47) return 63
  throw new ProtocolFailure('the bundled core is not valid base64')
}

export function decodeBase64(text: string): Uint8Array {
  const compact = text.replace(/\s+/gu, '')
  if (compact.length % 4 !== 0) {
    throw new ProtocolFailure('the bundled core is not valid base64')
  }
  const output: number[] = []
  for (let index = 0; index < compact.length; index += 4) {
    const first = compact.charCodeAt(index)
    const second = compact.charCodeAt(index + 1)
    const third = compact.charCodeAt(index + 2)
    const fourth = compact.charCodeAt(index + 3)
    const a = base64Value(first)
    const b = base64Value(second)
    const padding = third === 61 ? 2 : fourth === 61 ? 1 : 0
    const c = padding === 2 ? 0 : base64Value(third)
    const d = padding === 0 ? base64Value(fourth) : 0
    output.push((a << 2) | (b >> 4))
    if (padding < 2) output.push(((b & 15) << 4) | (c >> 2))
    if (padding < 1) output.push(((c & 3) << 6) | d)
  }
  return Uint8Array.from(output)
}

export class Encoder {
  private readonly buffer: number[] = []

  u8(value: number): void {
    this.buffer.push(value & 0xff)
  }

  u32(value: number): void {
    this.buffer.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff)
  }

  u64(value: number): void {
    this.u32(value >>> 0)
    this.u32(Math.floor(value / 0x1_0000_0000) >>> 0)
  }

  f64(value: number): void {
    const buffer = new ArrayBuffer(8)
    new DataView(buffer).setFloat64(0, value, true)
    for (const byte of new Uint8Array(buffer)) this.buffer.push(byte)
  }

  text(value: string): void {
    this.blob(UTF8_ENCODER.encode(value))
  }

  blob(value: Uint8Array): void {
    this.u32(value.length)
    for (const byte of value) this.buffer.push(byte)
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.buffer)
  }
}

export class Decoder {
  private readonly bytes: Uint8Array
  private readonly view: DataView
  private position = 0

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  u8(): number {
    const value = this.view.getUint8(this.position)
    this.position += 1
    return value
  }

  u32(): number {
    const value = this.view.getUint32(this.position, true)
    this.position += 4
    return value
  }

  u64(): number {
    const low = this.u32()
    const high = this.u32()
    return high * 0x1_0000_0000 + low
  }

  f64(): number {
    const value = this.view.getFloat64(this.position, true)
    this.position += 8
    return value
  }

  text(): string {
    return UTF8_DECODER.decode(this.blob())
  }

  blob(): Uint8Array {
    const length = this.u32()
    const end = this.position + length
    if (end > this.bytes.length) throw new ProtocolFailure('the protocol frame is truncated')
    const value = this.bytes.subarray(this.position, end)
    this.position = end
    return value
  }

  finish(): void {
    if (this.position !== this.bytes.length) {
      throw new ProtocolFailure('the protocol frame has trailing bytes')
    }
  }
}

function stageName(code: number): CoreStageName {
  const name = STAGE_NAMES[code]
  if (name === undefined) throw new ProtocolFailure('the protocol frame names an unknown stage')
  return name
}

function effectName(code: number): CoreEffectName {
  const name = EFFECT_NAMES[code]
  if (name === undefined) throw new ProtocolFailure('the protocol frame names an unknown effect')
  return name
}

export function direction(value: CoreMetricDirection): number {
  return value === 'maximize' ? 0 : 1
}

export function decodeDirection(value: number): CoreMetricDirection {
  if (value === 0) return 'maximize'
  if (value === 1) return 'minimize'
  throw new ProtocolFailure('the protocol frame names an unknown metric direction')
}

function decodeStatus(value: number): CoreBenchmarkRecord['status'] {
  if (value === 0) return 'passed'
  if (value === 1) return 'failed'
  if (value === 2) return 'retryable'
  throw new ProtocolFailure('the protocol frame names an unknown benchmark status')
}

function decodeProgramId(value: string): ProgramId {
  const parsed = parseProgramId(value)
  if (!parsed.ok) throw new ProtocolFailure(parsed.error.message)
  return parsed.value
}

function decodeIssueId(value: string): IssueId {
  const parsed = parseIssueId(value)
  if (!parsed.ok) throw new ProtocolFailure(parsed.error.message)
  return parsed.value
}

function decodeExperimentId(value: string): ExperimentId {
  const parsed = parseExperimentId(value)
  if (!parsed.ok) throw new ProtocolFailure(parsed.error.message)
  return parsed.value
}

function decodeTicketId(value: string): TicketId {
  const parsed = parseTicketId(value)
  if (!parsed.ok) throw new ProtocolFailure(parsed.error.message)
  return parsed.value
}

function decodeSessionId(value: string): ImplementerSessionId {
  const parsed = parseImplementerSessionId(value)
  if (!parsed.ok) throw new ProtocolFailure(parsed.error.message)
  return parsed.value
}

function decodeCommit(value: string): CommitSha {
  const parsed = parseCommitSha(value)
  if (!parsed.ok) throw new ProtocolFailure(parsed.error.message)
  return parsed.value
}

function decodeBranch(value: string): BranchName {
  const parsed = parseBranchName(value)
  if (!parsed.ok) throw new ProtocolFailure(parsed.error.message)
  return parsed.value
}

export function decodeTimestamp(value: string): IsoTimestamp {
  const parsed = parseIsoTimestamp(value)
  if (!parsed.ok) throw new ProtocolFailure(parsed.error.message)
  return parsed.value
}

export function encodeTimestamp(encoder: Encoder, value: IsoTimestamp): void {
  encoder.text(value)
}

export function encodeEnvironment(encoder: Encoder, environment: CoreEnvironmentDeclaration): void {
  encoder.u8(environment.kind === 'requirements' ? 0 : 1)
  encoder.text(environment.file)
}

export function decodeEnvironment(decoder: Decoder): CoreEnvironmentDeclaration {
  const kind = decoder.u8()
  const file = decoder.text()
  if (kind === 0) return { kind: 'requirements', file }
  if (kind === 1) return { kind: 'uv-lock', file }
  throw new ProtocolFailure('the protocol frame names an unknown environment')
}

export function encodeSpec(encoder: Encoder, spec: CoreBenchmarkSpec): void {
  encoder.text(spec.id)
  encoder.text(spec.entry)
  encoder.u64(spec.timeoutMs)
  encoder.u32(spec.metrics.length)
  for (const metric of spec.metrics) {
    encoder.text(metric.name)
    encoder.u8(direction(metric.direction))
    encoder.u8(metric.required ? 1 : 0)
    if (metric.tolerance === undefined) {
      encoder.u8(0)
    } else {
      encoder.u8(1)
      encoder.f64(metric.tolerance)
    }
  }
  encoder.u32(spec.maxRetries)
  const baseline = Object.entries(spec.baseline)
  encoder.u32(baseline.length)
  for (const [name, value] of baseline) {
    encoder.text(name)
    encoder.f64(value)
  }
  if (spec.dataset === undefined) {
    encoder.u8(0)
  } else {
    encoder.u8(1)
    encoder.text(spec.dataset)
  }
}

export function decodeSpec(decoder: Decoder): CoreBenchmarkSpec {
  const id = decoder.text()
  const entry = decoder.text()
  const timeoutMs = decoder.u64()
  const metricCount = decoder.u32()
  const metrics: CoreBenchmarkMetric[] = []
  for (let index = 0; index < metricCount; index += 1) {
    const name = decoder.text()
    const metricDirection = decodeDirection(decoder.u8())
    const required = decoder.u8() === 1
    const present = decoder.u8()
    if (present === 0) {
      metrics.push({ name, direction: metricDirection, required })
    } else {
      metrics.push({
        name,
        direction: metricDirection,
        required,
        tolerance: decoder.f64(),
      })
    }
  }
  const maxRetries = decoder.u32()
  const baselineCount = decoder.u32()
  const baseline: Record<string, number> = {}
  for (let index = 0; index < baselineCount; index += 1) {
    const name = decoder.text()
    baseline[name] = decoder.f64()
  }
  const present = decoder.u8()
  const dataset = present === 1 ? decoder.text() : undefined
  return dataset === undefined
    ? { id, entry, timeoutMs, metrics, maxRetries, baseline }
    : { id, entry, timeoutMs, metrics, maxRetries, baseline, dataset }
}

function encodeMetric(encoder: Encoder, metric: CoreMetric): void {
  encoder.text(metric.name)
  encoder.f64(metric.value)
}

function decodeMetric(decoder: Decoder): CoreMetric {
  return { name: decoder.text(), value: decoder.f64() }
}

function encodeRecord(encoder: Encoder, record: CoreBenchmarkRecord): void {
  encoder.text(record.id)
  encoder.text(record.experimentId)
  encoder.text(record.ticketId)
  encoder.text(record.commit)
  encoder.text(record.specHash)
  encoder.text(record.environmentDigest)
  encoder.u32(record.metrics.length)
  for (const metric of record.metrics) encodeMetric(encoder, metric)
  encoder.u8(record.status === 'passed' ? 0 : record.status === 'failed' ? 1 : 2)
  encoder.u32(record.attempt)
  encoder.u32(record.maxAttempts)
  encoder.text(record.stdout)
  encoder.text(record.stderr)
  encoder.u32(record.artifacts.length)
  for (const artifact of record.artifacts) encoder.text(artifact)
  encodeTimestamp(encoder, record.createdAt)
}

function decodeRecord(decoder: Decoder): CoreBenchmarkRecord {
  const id = decoder.text()
  const experimentId = decodeExperimentId(decoder.text())
  const ticketId = decodeTicketId(decoder.text())
  const commit = decodeCommit(decoder.text())
  const specHash = decoder.text()
  const environmentDigest = decoder.text()
  const metricCount = decoder.u32()
  const metrics: CoreMetric[] = []
  for (let index = 0; index < metricCount; index += 1) metrics.push(decodeMetric(decoder))
  const status = decodeStatus(decoder.u8())
  const attempt = decoder.u32()
  const maxAttempts = decoder.u32()
  const stdout = decoder.text()
  const stderr = decoder.text()
  const artifactCount = decoder.u32()
  const artifacts: string[] = []
  for (let index = 0; index < artifactCount; index += 1) artifacts.push(decoder.text())
  const createdAt = decodeTimestamp(decoder.text())
  return {
    id,
    experimentId,
    ticketId,
    commit,
    specHash,
    environmentDigest,
    metrics,
    status,
    attempt,
    maxAttempts,
    stdout,
    stderr,
    artifacts,
    createdAt,
  }
}

function encodeProgram(encoder: Encoder, program: CoreProgram): void {
  encoder.u64(1)
  encoder.text(program.id)
  encoder.text(program.owner)
  encoder.text(program.name)
  encoder.text(program.goal)
  encoder.text(program.methodology)
  encodeSpec(encoder, program.benchmark)
  encoder.u32(program.utility.length)
  for (const metric of program.utility) {
    encoder.text(metric.name)
    encoder.u8(direction(metric.direction))
    encoder.f64(metric.weight)
  }
  encoder.u8(program.exploration === 'low' ? 0 : program.exploration === 'normal' ? 1 : 2)
  encoder.u32(program.policy.maxExperiments)
  encoder.u64(program.policy.maxComputeMinutes)
  encoder.u64(program.policy.maxTokens)
  encoder.u32(program.policy.maxAttemptsPerExperiment)
  encoder.u32(program.usage.experiments)
  encoder.u64(program.usage.computeMinutes)
  encoder.u64(program.usage.tokens)
  encoder.u8(program.status === 'running' ? 0 : program.status === 'paused' ? 1 : 2)
  encodeTimestamp(encoder, program.createdAt)
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
  encoder.u8(stopReason(decision.reason))
}

function stopReason(reason: CoreStopReason): number {
  if (reason === 'goal-met') return 0
  if (reason === 'policy-exhausted') return 1
  if (reason === 'no-hypothesis') return 2
  return 3
}

export function encodeStart(input: CoreStartInput): Uint8Array {
  const encoder = new Encoder()
  encoder.text(input.programId)
  encoder.text(input.issueId)
  encoder.text(input.experimentId)
  encoder.text(input.branch)
  encoder.text(input.baseCommit)
  encodeEnvironment(encoder, input.environment)
  return encoder.finish()
}

function encodeFailure(encoder: Encoder, failure: CoreEffectResume['result']): void {
  if (failure.ok) throw new ProtocolFailure('an ok result cannot be encoded as a failure')
  encoder.u8(failure.failure.kind === 'rejected' ? 0 : 1)
  encoder.text(failure.failure.message)
}

export function encodeResume(input: CoreEffectResume): Uint8Array {
  const encoder = new Encoder()
  encoder.u64(input.sequence)
  encoder.u8(EFFECT_CODES[input.effect])
  if (!input.result.ok) {
    encoder.u8(1)
    encodeFailure(encoder, input.result)
    return encoder.finish()
  }
  encoder.u8(0)
  switch (input.effect) {
    case 'storage.loadProgram':
      encoder.blob(encodeProgramValue(input.result.value))
      break
    case 'trigger.deliver':
      encodeTextPayload(encoder, input.result.value)
      break
    case 'executor.open':
      encodeTextPayload(encoder, input.result.value)
      break
    case 'sessions.startWorker':
      encodeTextPayload(encoder, input.result.value)
      break
    case 'sessions.submitCommit':
      encodeTextPayload(encoder, input.result.value)
      break
    case 'benchmark.buildEnvironment':
      encodeTextPayload(encoder, input.result.value)
      break
    case 'benchmark.specHash':
      encodeTextPayload(encoder, input.result.value)
      break
    case 'benchmark.run': {
      const record = new Encoder()
      encodeRecord(record, input.result.value)
      encoder.blob(record.finish())
      break
    }
    case 'storage.appendBenchmarkRecord':
      encoder.blob(new Uint8Array())
      break
    case 'sessions.review': {
      const decision = new Encoder()
      encodeDecision(decision, input.result.value)
      encoder.blob(decision.finish())
      break
    }
    case 'clock.now':
      encodeTextPayload(encoder, input.result.value)
      break
  }
  return encoder.finish()
}

function encodeProgramValue(program: CoreProgram): Uint8Array {
  const encoder = new Encoder()
  encodeProgram(encoder, program)
  return encoder.finish()
}

function encodeTextPayload(encoder: Encoder, value: string): void {
  const inner = new Encoder()
  inner.text(value)
  encoder.blob(inner.finish())
}

export function decodeFrame(bytes: Uint8Array): Result<CoreFrame, CoreBridgeError> {
  try {
    const decoder = new Decoder(bytes)
    const kind = decoder.u8()
    if (kind === 0) {
      const effect = effectName(decoder.u8())
      const sequence = decoder.u64()
      const stage = stageName(decoder.u8())
      const payload = decoder.blob()
      decoder.finish()
      const frame: CoreEffectFrame = { kind: 'effect', effect, sequence, stage, payload }
      return { ok: true, value: frame }
    }
    if (kind === 1) {
      const outcomeCode = decoder.u8()
      const outcome = OUTCOMES[outcomeCode]
      if (outcome === undefined) throw new ProtocolFailure('the protocol frame names an unknown outcome')
      const count = decoder.u32()
      const stages: CoreStageName[] = []
      for (let index = 0; index < count; index += 1) stages.push(stageName(decoder.u8()))
      decoder.finish()
      return { ok: true, value: { kind: 'completed', outcome, stages } }
    }
    if (kind === 2) {
      const message = decoder.text()
      decoder.finish()
      return { ok: false, error: { kind: 'protocol', message } }
    }
    if (kind === 3) {
      const message = decoder.text()
      decoder.finish()
      return { ok: false, error: { kind: 'domain', message } }
    }
    throw new ProtocolFailure('the protocol frame names an unknown kind')
  } catch (error) {
    return { ok: false, error: { kind: 'protocol', message: errorMessage(error) } }
  }
}

export function decodeEffect(
  effect: CoreEffectName,
  payload: Uint8Array,
): Result<CoreEffect, CoreBridgeError> {
  try {
    const decoder = new Decoder(payload)
    const value = decodeEffectValue(effect, decoder)
    decoder.finish()
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: { kind: 'protocol', message: errorMessage(error) } }
  }
}

function decodeEffectValue(effect: CoreEffectName, decoder: Decoder): CoreEffect {
  switch (effect) {
    case 'storage.loadProgram':
      return { name: effect, programId: decodeProgramId(decoder.text()) }
    case 'trigger.deliver':
      return {
        name: effect,
        experimentId: decodeExperimentId(decoder.text()),
        branch: decodeBranch(decoder.text()),
        baseCommit: decodeCommit(decoder.text()),
      }
    case 'executor.open':
      return {
        name: effect,
        programId: decodeProgramId(decoder.text()),
        issueId: decodeIssueId(decoder.text()),
        experimentId: decodeExperimentId(decoder.text()),
      }
    case 'sessions.startWorker':
      return {
        name: effect,
        ticketId: decodeTicketId(decoder.text()),
        experimentId: decodeExperimentId(decoder.text()),
      }
    case 'sessions.submitCommit':
      return {
        name: effect,
        ticketId: decodeTicketId(decoder.text()),
        workerSessionId: decodeSessionId(decoder.text()),
      }
    case 'benchmark.buildEnvironment':
      return {
        name: effect,
        commit: decodeCommit(decoder.text()),
        environment: decodeEnvironment(decoder),
      }
    case 'benchmark.specHash':
      return { name: effect, spec: decodeSpec(decoder) }
    case 'benchmark.run':
      return {
        name: effect,
        experimentId: decodeExperimentId(decoder.text()),
        ticketId: decodeTicketId(decoder.text()),
        spec: decodeSpec(decoder),
        commit: decodeCommit(decoder.text()),
        environmentDigest: decoder.text(),
        attempt: decoder.u32(),
        maxAttempts: decoder.u32(),
      }
    case 'storage.appendBenchmarkRecord':
      return { name: effect, record: decodeRecord(decoder) }
    case 'sessions.review':
      return {
        name: effect,
        experimentId: decodeExperimentId(decoder.text()),
        benchmark: decodeRecord(decoder),
      }
    case 'clock.now':
      return { name: effect }
  }
}
