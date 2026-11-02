import type {
  BenchmarkRecord,
  BenchmarkSpec,
  ResearcherDecision,
  ResearchPolicy,
} from '../../src/benchmark.js'
import type { DomainError, Err, Result } from '../../src/types/errors.js'
import type { CommitSha, ExperimentId, IssueId, NonEmptyString, ProgramId, TicketId } from '../../src/types/ids.js'
import type {
  BenchmarkFailed,
  BenchmarkPassed,
  BenchmarkRetryable,
  CommitSubmitted,
  EnvironmentBuilt,
  ExperimentProposed,
  ResearchCompleted,
  ResearchPipeline,
  ResultRecorded,
  ReviewRecorded,
  StepName,
  TicketOpened,
  TriggerAccepted,
  WorkerStarted,
} from '../../src/pipeline.js'
import {
  createBenchmarkFailed,
  createBenchmarkPassed,
  createBenchmarkRetryable,
  createCommitSubmitted,
  createEnvironmentBuilt,
  createExperimentProposed,
  createResearchCompleted,
  createResultRecorded,
  createReviewRecorded,
  createTicketOpened,
  createTriggerAccepted,
  createWorkerStarted,
} from './stages.js'
import type {
  BenchmarkAttempt,
  BenchmarkContract,
  BenchmarkFiles,
  BenchmarkOutcome,
  FakeBenchmark,
  LabBenchmarkRecord,
} from './benchmark.js'
import { createBenchmarkRecord, createFakeBenchmark } from './benchmark.js'
import type {
  CommitSubmission,
  DecisionSource,
  EnvironmentBuild,
  FakeArtifacts,
  FakeClock,
  FakeEnvironmentBuilder,
  FakeSessions,
  FakeStorage,
  FakeTicketExecutor,
  FakeTriggerSource,
  TicketOpen,
  TriggerDelivery,
  WorkerStart,
} from './fakes.js'
import {
  createDecisionSource,
  createFakeArtifacts,
  createFakeClock,
  createFakeEnvironmentBuilder,
  createFakeSessions,
  createFakeStorage,
  createFakeTicketExecutor,
  createFakeTriggerSource,
} from './fakes.js'
import {
  createUsage,
  nextAttemptAllowed,
  type ProgramStopReason,
  type Usage,
  type UsageDelta,
} from './policy.js'

export interface LabOptions {
  readonly programId: ProgramId
  readonly issueId: IssueId
  readonly experimentId: ExperimentId
  readonly spec: BenchmarkSpec
  readonly contract: BenchmarkContract
  readonly policy: ResearchPolicy
  readonly files: BenchmarkFiles
  readonly outcomes: readonly BenchmarkOutcome[]
  readonly decisions: readonly ResearcherDecision[]
  readonly environmentDigest: string
  readonly usagePerAttempt: UsageDelta
  readonly start: string
}

export interface Lab {
  readonly pipeline: ResearchPipeline
  readonly trigger: FakeTriggerSource
  readonly executor: FakeTicketExecutor
  readonly sessions: FakeSessions
  readonly environment: FakeEnvironmentBuilder
  readonly benchmark: FakeBenchmark
  readonly storage: FakeStorage
  readonly artifacts: FakeArtifacts
  readonly clock: FakeClock
  readonly decisions: DecisionSource
  readonly usage: Usage
  readonly usagePerAttempt: UsageDelta
  readonly policy: ResearchPolicy
  readonly spec: BenchmarkSpec
  readonly contract: BenchmarkContract
  readonly programId: ProgramId
  readonly issueId: IssueId
  readonly trace: StepName[]
  readonly records: LabBenchmarkRecord[]
  readonly experimentIdFor: (index: number) => ExperimentId
}

export type ExperimentOutcome =
  | {
      readonly status: 'completed'
      readonly completion: ResearchCompleted
      readonly review: ReviewRecorded
      readonly record: BenchmarkRecord
      readonly attempts: number
    }
  | {
      readonly status: 'failed'
      readonly completion: ResearchCompleted
      readonly record: BenchmarkRecord | undefined
      readonly attempts: number
      readonly reason: string
    }
  | {
      readonly status: 'cancelled'
      readonly completion: ResearchCompleted
      readonly attempts: number
      readonly reason: string
    }
  | {
      readonly status: 'refused'
      readonly stage: StepName
      readonly error: DomainError
      readonly attempts: number
    }

export interface ProgramOutcome {
  readonly completion: ResearchCompleted
  readonly experiments: readonly ExperimentOutcome[]
  readonly usage: Usage
  readonly stop: ProgramStopReason
}

function invalid(message: string): Err<DomainError> {
  return {
    ok: false,
    error: { code: 'invalid-input', message: message as NonEmptyString },
  }
}

function budget(message: string): Err<DomainError> {
  return {
    ok: false,
    error: { code: 'budget-exhausted', message: message as NonEmptyString },
  }
}

function refused(stage: StepName, error: DomainError, attempts: number): ExperimentOutcome {
  return { status: 'refused', stage, error, attempts }
}

function cancelled(
  proposed: ExperimentProposed,
  reason: string,
  attempts: number,
): ExperimentOutcome {
  return {
    status: 'cancelled',
    completion: createResearchCompleted({
      experimentId: proposed.experimentId,
      issueId: proposed.issueId,
      outcome: 'cancelled',
    }),
    attempts,
    reason,
  }
}

export function createLab(options: LabOptions): Lab {
  const usage = createUsage()
  const clock = createFakeClock(options.start)
  const trigger = createFakeTriggerSource()
  const executor = createFakeTicketExecutor()
  const sessions = createFakeSessions()
  const environment = createFakeEnvironmentBuilder(options.environmentDigest)
  const storage = createFakeStorage()
  const artifacts = createFakeArtifacts()
  const decisions = createDecisionSource(options.decisions)
  const trace: StepName[] = []
  const records: LabBenchmarkRecord[] = []
  const experimentByTicket = new Map<TicketId, ExperimentId>()
  const attemptsByTicket = new Map<TicketId, number>()
  const retryContexts = new Map<
    string,
    { readonly ticketId: TicketId; readonly commit: CommitSha; readonly environmentDigest: string }
  >()
  let benchmarkRunIndex = 0
  let recordIndex = 0

  const benchmark = createFakeBenchmark({
    spec: options.spec,
    contract: options.contract,
    files: options.files,
    outcomes: options.outcomes,
    policy: options.policy,
    usage,
    perAttempt: options.usagePerAttempt,
  })

  const experimentIdFor = (index: number): ExperimentId => {
    const base = String(options.experimentId)
    return (index === 0 ? base : `${base}-${index + 1}`) as ExperimentId
  }

  const pipeline: ResearchPipeline = {
    deliverTrigger: {
      async run(input: ExperimentProposed): Promise<Result<TriggerAccepted, DomainError>> {
        trace.push('deliverTrigger')
        const delivered = await trigger.deliver(input)
        if (!delivered.ok) {
          return delivered
        }
        const delivery: TriggerDelivery = delivered.value
        return {
          ok: true,
          value: createTriggerAccepted({
            programId: input.programId,
            experimentId: input.experimentId,
            triggerId: delivery.triggerId,
            threadId: delivery.threadId,
          }),
        }
      },
    },
    openTicket: {
      async run(input: TriggerAccepted): Promise<Result<TicketOpened, DomainError>> {
        trace.push('openTicket')
        const opened = await executor.open(input)
        if (!opened.ok) {
          return opened
        }
        const ticket: TicketOpen = opened.value
        experimentByTicket.set(ticket.ticketId, input.experimentId)
        return {
          ok: true,
          value: createTicketOpened({
            programId: input.programId,
            experimentId: input.experimentId,
            ticketId: ticket.ticketId,
          }),
        }
      },
    },
    startWorker: {
      async run(input: TicketOpened): Promise<Result<WorkerStarted, DomainError>> {
        trace.push('startWorker')
        const started = await sessions.start(input)
        if (!started.ok) {
          return started
        }
        const worker: WorkerStart = started.value
        return {
          ok: true,
          value: createWorkerStarted({
            ticketId: input.ticketId,
            workerSessionId: worker.workerSessionId,
          }),
        }
      },
    },
    submitCommit: {
      async run(input: WorkerStarted): Promise<Result<CommitSubmitted, DomainError>> {
        trace.push('submitCommit')
        const submitted = await sessions.submit(input)
        if (!submitted.ok) {
          return submitted
        }
        const submission: CommitSubmission = submitted.value
        return {
          ok: true,
          value: createCommitSubmitted({
            ticketId: input.ticketId,
            commit: submission.commit,
          }),
        }
      },
    },
    buildEnvironment: {
      async run(input: CommitSubmitted): Promise<Result<EnvironmentBuilt, DomainError>> {
        trace.push('buildEnvironment')
        const built = await environment.build(input)
        if (!built.ok) {
          return built
        }
        const build: EnvironmentBuild = built.value
        return {
          ok: true,
          value: createEnvironmentBuilt({
            ticketId: input.ticketId,
            commit: input.commit,
            environmentDigest: build.environmentDigest,
          }),
        }
      },
    },
    runBenchmark: {
      async run(
        input: EnvironmentBuilt,
      ): Promise<Result<BenchmarkPassed | BenchmarkFailed | BenchmarkRetryable, DomainError>> {
        trace.push('runBenchmark')
        const experimentId = experimentByTicket.get(input.ticketId)
        if (experimentId === undefined) {
          return invalid(`benchmark has no experiment for ticket: ${input.ticketId}`)
        }
        const attempt = (attemptsByTicket.get(input.ticketId) ?? 0) + 1
        attemptsByTicket.set(input.ticketId, attempt)
        const maxAttempts = options.policy.maxAttemptsPerExperiment
        const attemptInput: BenchmarkAttempt = {
          spec: options.spec,
          specHash: options.contract.specHash,
          environmentDigest: input.environmentDigest,
          experimentId,
          ticketId: input.ticketId,
          commit: input.commit,
          attempt,
          maxAttempts,
        }
        const ran = await benchmark.run(attemptInput)
        if (!ran.ok) {
          return ran
        }
        const outcome = ran.value
        if (outcome.status === 'retryable') {
          benchmarkRunIndex += 1
          const benchmarkRunId = `benchmark-run-${benchmarkRunIndex}`
          retryContexts.set(benchmarkRunId, {
            ticketId: input.ticketId,
            commit: input.commit,
            environmentDigest: input.environmentDigest,
          })
          return {
            ok: true,
            value: createBenchmarkRetryable({
              benchmarkRunId,
              attempt,
              maxAttempts,
              reason: outcome.reason ?? 'retryable benchmark',
            }),
          }
        }
        recordIndex += 1
        const record = createBenchmarkRecord({
          id: `benchmark-record-${recordIndex}`,
          attempt: attemptInput,
          outcome,
          now: clock.now(),
        })
        records.push(record)
        if (outcome.status === 'passed') {
          return { ok: true, value: createBenchmarkPassed({ record }) }
        }
        return {
          ok: true,
          value: createBenchmarkFailed({
            record,
            reason: outcome.reason ?? 'benchmark failed',
          }),
        }
      },
    },
    retryBenchmark: {
      async run(input: BenchmarkRetryable): Promise<Result<EnvironmentBuilt, DomainError>> {
        trace.push('retryBenchmark')
        const context = retryContexts.get(input.benchmarkRunId)
        if (context === undefined) {
          return invalid(`retry has no benchmark run: ${input.benchmarkRunId}`)
        }
        if (!nextAttemptAllowed(options.policy, input.attempt)) {
          return budget(`attempt budget exhausted at attempt ${input.attempt}`)
        }
        return {
          ok: true,
          value: createEnvironmentBuilt({
            ticketId: context.ticketId,
            commit: context.commit,
            environmentDigest: context.environmentDigest,
          }),
        }
      },
    },
    recordResult: {
      async run(input: BenchmarkPassed): Promise<Result<ResultRecorded, DomainError>> {
        trace.push('recordResult')
        const saved = await storage.save(input.record)
        if (!saved.ok) {
          return saved
        }
        await artifacts.store(input.record.artifacts)
        return { ok: true, value: createResultRecorded({ record: input.record }) }
      },
    },
    reviewResult: {
      async run(input: ResultRecorded): Promise<Result<ReviewRecorded, DomainError>> {
        trace.push('reviewResult')
        const decision = decisions.next({
          record: input.record,
          experimentId: input.record.experimentId,
          issueId: options.issueId,
        })
        return {
          ok: true,
          value: createReviewRecorded({
            experimentId: input.record.experimentId,
            issueId: options.issueId,
            decision,
          }),
        }
      },
    },
    closePassed: {
      async run(input: ReviewRecorded): Promise<Result<ResearchCompleted, DomainError>> {
        trace.push('closePassed')
        return {
          ok: true,
          value: createResearchCompleted({
            experimentId: input.experimentId,
            issueId: input.issueId,
            outcome: 'concluded',
          }),
        }
      },
    },
    closeFailed: {
      async run(
        input: BenchmarkFailed | BenchmarkRetryable,
      ): Promise<Result<ResearchCompleted, DomainError>> {
        trace.push('closeFailed')
        if ('record' in input) {
          return {
            ok: true,
            value: createResearchCompleted({
              experimentId: input.record.experimentId,
              issueId: options.issueId,
              outcome: input.reason === 'budget-exhausted' ? 'cancelled' : 'failed',
            }),
          }
        }
        const context = retryContexts.get(input.benchmarkRunId)
        const experimentId =
          context === undefined
            ? options.experimentId
            : (experimentByTicket.get(context.ticketId) ?? options.experimentId)
        return {
          ok: true,
          value: createResearchCompleted({
            experimentId,
            issueId: options.issueId,
            outcome: input.reason === 'budget-exhausted' ? 'cancelled' : 'failed',
          }),
        }
      },
    },
  }

  return {
    pipeline,
    trigger,
    executor,
    sessions,
    environment,
    benchmark,
    storage,
    artifacts,
    clock,
    decisions,
    usage,
    usagePerAttempt: options.usagePerAttempt,
    policy: options.policy,
    spec: options.spec,
    contract: options.contract,
    programId: options.programId,
    issueId: options.issueId,
    trace,
    records,
    experimentIdFor,
  }
}

function affordStopReason(lab: Lab): ProgramStopReason | undefined {
  if (lab.usage.computeMinutes + lab.usagePerAttempt.computeMinutes > lab.policy.maxComputeMinutes) {
    return 'compute-limit'
  }
  if (lab.usage.tokens + lab.usagePerAttempt.tokens > lab.policy.maxTokens) {
    return 'token-limit'
  }
  return undefined
}

export async function runExperiment(
  lab: Lab,
  proposed: ExperimentProposed,
): Promise<ExperimentOutcome> {
  if (lab.usage.experiments >= lab.policy.maxExperiments) {
    return cancelled(proposed, 'experiment-limit', 0)
  }
  const blocked = affordStopReason(lab)
  if (blocked !== undefined) {
    return cancelled(proposed, blocked, 0)
  }
  lab.usage.experiments += 1
  let attempts = 0

  const accepted = await lab.pipeline.deliverTrigger.run(proposed)
  if (!accepted.ok) {
    return refused('deliverTrigger', accepted.error, attempts)
  }
  const opened = await lab.pipeline.openTicket.run(accepted.value)
  if (!opened.ok) {
    return refused('openTicket', opened.error, attempts)
  }
  const started = await lab.pipeline.startWorker.run(opened.value)
  if (!started.ok) {
    return refused('startWorker', started.error, attempts)
  }
  const submitted = await lab.pipeline.submitCommit.run(started.value)
  if (!submitted.ok) {
    return refused('submitCommit', submitted.error, attempts)
  }
  const built = await lab.pipeline.buildEnvironment.run(submitted.value)
  if (!built.ok) {
    return refused('buildEnvironment', built.error, attempts)
  }

  let environment: EnvironmentBuilt = built.value
  while (true) {
    attempts += 1
    const ran = await lab.pipeline.runBenchmark.run(environment)
    if (!ran.ok) {
      if (ran.error.code === 'budget-exhausted') {
        return cancelled(proposed, 'budget-exhausted', attempts)
      }
      return refused('runBenchmark', ran.error, attempts)
    }
    const state = ran.value
    if ('benchmarkRunId' in state) {
      if (!nextAttemptAllowed(lab.policy, state.attempt)) {
        const closed = await lab.pipeline.closeFailed.run(state)
        if (!closed.ok) {
          return refused('closeFailed', closed.error, attempts)
        }
        return {
          status: 'failed',
          completion: closed.value,
          record: undefined,
          attempts,
          reason: 'attempt-limit',
        }
      }
      const retried = await lab.pipeline.retryBenchmark.run(state)
      if (!retried.ok) {
        if (retried.error.code === 'budget-exhausted') {
          return cancelled(proposed, 'budget-exhausted', attempts)
        }
        return refused('retryBenchmark', retried.error, attempts)
      }
      environment = retried.value
      continue
    }
    if ('reason' in state) {
      const closed = await lab.pipeline.closeFailed.run(state)
      if (!closed.ok) {
        return refused('closeFailed', closed.error, attempts)
      }
      return {
        status: 'failed',
        completion: closed.value,
        record: state.record,
        attempts,
        reason: state.reason,
      }
    }
    const recorded = await lab.pipeline.recordResult.run(state)
    if (!recorded.ok) {
      return refused('recordResult', recorded.error, attempts)
    }
    const reviewed = await lab.pipeline.reviewResult.run(recorded.value)
    if (!reviewed.ok) {
      return refused('reviewResult', reviewed.error, attempts)
    }
    const closed = await lab.pipeline.closePassed.run(reviewed.value)
    if (!closed.ok) {
      return refused('closePassed', closed.error, attempts)
    }
    return {
      status: 'completed',
      completion: closed.value,
      review: reviewed.value,
      record: state.record,
      attempts,
    }
  }
}

function cancelledCompletion(lab: Lab, experimentIndex: number): ResearchCompleted {
  return createResearchCompleted({
    experimentId: lab.experimentIdFor(experimentIndex),
    issueId: lab.issueId,
    outcome: 'cancelled',
  })
}

export async function runProgram(lab: Lab): Promise<ProgramOutcome> {
  const experiments: ExperimentOutcome[] = []
  while (true) {
    if (lab.usage.experiments >= lab.policy.maxExperiments) {
      return {
        completion: cancelledCompletion(lab, experiments.length),
        experiments,
        usage: { ...lab.usage },
        stop: 'experiment-limit',
      }
    }
    const blocked = affordStopReason(lab)
    if (blocked !== undefined) {
      return {
        completion: cancelledCompletion(lab, experiments.length),
        experiments,
        usage: { ...lab.usage },
        stop: blocked,
      }
    }
    const proposed = createExperimentProposed({
      programId: lab.programId,
      issueId: lab.issueId,
      experimentId: lab.experimentIdFor(experiments.length),
      planCommentId: `plan-${experiments.length + 1}`,
    })
    const outcome = await runExperiment(lab, proposed)
    experiments.push(outcome)
    if (outcome.status === 'refused') {
      return {
        completion: cancelledCompletion(lab, experiments.length),
        experiments,
        usage: { ...lab.usage },
        stop: 'failure',
      }
    }
    if (outcome.status === 'cancelled') {
      return {
        completion: outcome.completion,
        experiments,
        usage: { ...lab.usage },
        stop: 'budget-exhausted',
      }
    }
    if (outcome.status === 'failed') {
      return {
        completion: outcome.completion,
        experiments,
        usage: { ...lab.usage },
        stop: 'failure',
      }
    }
    if (outcome.review.decision === 'stop') {
      return {
        completion: outcome.completion,
        experiments,
        usage: { ...lab.usage },
        stop: 'review-stop',
      }
    }
  }
}

