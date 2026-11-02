import type { BenchmarkRecord, ResearcherDecision } from '../../src/benchmark.js'
import type { DomainError, Result } from '../../src/types/errors.js'
import type {
  CommitSha,
  ExperimentId,
  IssueId,
  TicketId,
} from '../../src/types/ids.js'
import type {
  CommitSubmitted,
  ExperimentProposed,
  TicketOpened,
  TriggerAccepted,
  WorkerStarted,
} from '../../src/pipeline.js'

export interface TriggerDelivery {
  readonly triggerId: string
  readonly threadId: string
}

export interface FakeTriggerSource {
  deliver(input: ExperimentProposed): Promise<Result<TriggerDelivery, DomainError>>
  readonly deliveries: readonly TriggerDelivery[]
}

export interface TicketOpen {
  readonly ticketId: TicketId
}

export interface FakeTicketExecutor {
  open(input: TriggerAccepted): Promise<Result<TicketOpen, DomainError>>
  readonly tickets: readonly TicketId[]
}

export interface WorkerStart {
  readonly workerSessionId: string
}

export interface CommitSubmission {
  readonly commit: CommitSha
}

export interface FakeSessions {
  start(input: TicketOpened): Promise<Result<WorkerStart, DomainError>>
  submit(input: WorkerStarted): Promise<Result<CommitSubmission, DomainError>>
  readonly workers: readonly string[]
  readonly commits: readonly CommitSha[]
}

export interface EnvironmentBuild {
  readonly environmentDigest: string
}

export interface FakeEnvironmentBuilder {
  build(input: CommitSubmitted): Promise<Result<EnvironmentBuild, DomainError>>
  readonly builds: readonly string[]
}

export interface StoredBenchmarkRecord {
  readonly version: number
  readonly record: BenchmarkRecord
}

export interface FakeStorage {
  save(record: BenchmarkRecord): Promise<Result<number, DomainError>>
  get(id: string): Promise<BenchmarkRecord | undefined>
  readonly saves: readonly string[]
}

export interface FakeArtifacts {
  store(paths: readonly string[]): Promise<void>
  readonly stored: readonly string[]
}

export interface FakeClock {
  now(): string
  advance(milliseconds: number): string
}

export interface DecisionInput {
  readonly record: BenchmarkRecord
  readonly experimentId: ExperimentId
  readonly issueId: IssueId
}

export interface DecisionSource {
  next(input: DecisionInput): ResearcherDecision
}

function ticketId(value: string): TicketId {
  return value as TicketId
}

function commitSha(value: number): CommitSha {
  return value.toString(16).padStart(40, '0') as CommitSha
}

export function createFakeClock(start: string): FakeClock {
  let current = Date.parse(start)
  return {
    now: (): string => new Date(current).toISOString(),
    advance: (milliseconds: number): string => {
      current += milliseconds
      return new Date(current).toISOString()
    },
  }
}

export function createFakeTriggerSource(): FakeTriggerSource {
  const deliveries: TriggerDelivery[] = []
  let index = 0
  return {
    deliveries,
    async deliver(input: ExperimentProposed): Promise<Result<TriggerDelivery, DomainError>> {
      index += 1
      const delivery: TriggerDelivery = {
        triggerId: `trigger-${index}`,
        threadId: `thread-${input.experimentId}`,
      }
      deliveries.push(delivery)
      return { ok: true, value: delivery }
    },
  }
}

export function createFakeTicketExecutor(): FakeTicketExecutor {
  const tickets: TicketId[] = []
  let index = 0
  return {
    tickets,
    async open(input: TriggerAccepted): Promise<Result<TicketOpen, DomainError>> {
      index += 1
      const opened = ticketId(`ticket-${index}-${input.experimentId}`)
      tickets.push(opened)
      return { ok: true, value: { ticketId: opened } }
    },
  }
}

export function createFakeSessions(): FakeSessions {
  const workers: string[] = []
  const commits: CommitSha[] = []
  let workerIndex = 0
  let commitIndex = 0
  return {
    workers,
    commits,
    async start(input: TicketOpened): Promise<Result<WorkerStart, DomainError>> {
      workerIndex += 1
      const workerSessionId = `worker-${workerIndex}-${input.ticketId}`
      workers.push(workerSessionId)
      return { ok: true, value: { workerSessionId } }
    },
    async submit(): Promise<Result<CommitSubmission, DomainError>> {
      commitIndex += 1
      const commit = commitSha(commitIndex)
      commits.push(commit)
      return { ok: true, value: { commit } }
    },
  }
}

export function createFakeEnvironmentBuilder(digest: string): FakeEnvironmentBuilder {
  const builds: string[] = []
  return {
    builds,
    async build(input: CommitSubmitted): Promise<Result<EnvironmentBuild, DomainError>> {
      builds.push(input.commit)
      return { ok: true, value: { environmentDigest: digest } }
    },
  }
}

export function createFakeStorage(): FakeStorage {
  const records = new Map<string, StoredBenchmarkRecord>()
  const saves: string[] = []
  return {
    saves,
    async save(record: BenchmarkRecord): Promise<Result<number, DomainError>> {
      const current = records.get(record.id)
      const version = (current?.version ?? 0) + 1
      records.set(record.id, { version, record })
      saves.push(record.id)
      return { ok: true, value: version }
    },
    async get(id: string): Promise<BenchmarkRecord | undefined> {
      return records.get(id)?.record
    },
  }
}

export function createFakeArtifacts(): FakeArtifacts {
  const stored: string[] = []
  return {
    stored,
    async store(paths: readonly string[]): Promise<void> {
      stored.push(...paths)
    },
  }
}

export function createDecisionSource(decisions: readonly ResearcherDecision[]): DecisionSource {
  const queue = [...decisions]
  return {
    next(): ResearcherDecision {
      return queue.shift() ?? 'stop'
    },
  }
}
