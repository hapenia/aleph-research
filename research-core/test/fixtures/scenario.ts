import type { ResearchPolicy, ResearcherDecision } from '../../src/benchmark.js'
import type { DomainError, Result } from '../../src/types/errors.js'
import type { ExperimentId, IssueId, ProgramId } from '../../src/types/ids.js'
import type { ExperimentProposed } from '../../src/pipeline.js'
import type {
  BenchmarkContract,
  BenchmarkFiles,
  BenchmarkOutcome,
  BenchmarkSpecInput,
} from './benchmark.js'
import {
  createBenchmarkSpec,
  createReadOnlyBenchmarkFiles,
  hashBenchmarkSpec,
} from './benchmark.js'
import { createLab, type Lab } from './lab.js'
import type { UsageDelta } from './policy.js'
import { createExperimentProposed } from './stages.js'

export interface ScenarioOptions {
  readonly spec?: BenchmarkSpecInput
  readonly contract?: BenchmarkContract
  readonly policy?: Partial<ResearchPolicy>
  readonly outcomes?: readonly BenchmarkOutcome[]
  readonly decisions?: readonly ResearcherDecision[]
  readonly files?: BenchmarkFiles
  readonly environmentDigest?: string
  readonly usagePerAttempt?: UsageDelta
  readonly start?: string
}

function unwrap<T>(result: Result<T, DomainError>): T {
  if (!result.ok) {
    throw new Error(result.error.message)
  }
  return result.value
}

export function defaultSpecInput(): BenchmarkSpecInput {
  return {
    id: 'benchmark-1',
    entry: 'entry.py',
    timeoutMs: 60000,
    maxRetries: 10,
    metrics: [
      { name: 'accuracy', direction: 'higher', required: true },
      { name: 'loss', direction: 'lower', required: false },
    ],
  }
}

export function defaultPolicy(): ResearchPolicy {
  return {
    maxExperiments: 3,
    maxComputeMinutes: 30,
    maxTokens: 1000,
    maxAttemptsPerExperiment: 3,
  }
}

export function defaultFiles(): BenchmarkFiles {
  return createReadOnlyBenchmarkFiles('/benchmark', {
    'entry.py': 'print("benchmark")',
    'spec.json': '{"id":"benchmark-1"}',
  })
}

export function passedMetrics(spec: BenchmarkSpecInput): Readonly<Record<string, number>> {
  const metrics: Record<string, number> = {}
  for (const metric of spec.metrics) {
    metrics[metric.name] = metric.direction === 'higher' ? 0.8 : 0.2
  }
  return metrics
}

export function outcome(
  status: BenchmarkOutcome['status'],
  metrics: Readonly<Record<string, number>>,
  reason?: string,
): BenchmarkOutcome {
  return {
    status,
    metrics,
    artifacts: ['artifact.log'],
    stdout: `${status} stdout`,
    stderr: '',
    ...(reason === undefined ? {} : { reason }),
  }
}

export function createScenario(options: ScenarioOptions = {}): Lab {
  const specInput = options.spec ?? defaultSpecInput()
  const spec = unwrap(createBenchmarkSpec(specInput))
  const contract: BenchmarkContract = options.contract ?? {
    specHash: hashBenchmarkSpec(spec),
    environmentDigest: 'sha256:environment-1',
  }
  const policy: ResearchPolicy = { ...defaultPolicy(), ...options.policy }
  return createLab({
    programId: 'program-1' as ProgramId,
    issueId: 'issue-1' as IssueId,
    experimentId: 'experiment-1' as ExperimentId,
    spec,
    contract,
    policy,
    files: options.files ?? defaultFiles(),
    outcomes: options.outcomes ?? [outcome('passed', passedMetrics(specInput))],
    decisions: options.decisions ?? ['stop'],
    environmentDigest: options.environmentDigest ?? contract.environmentDigest,
    usagePerAttempt: options.usagePerAttempt ?? { computeMinutes: 1, tokens: 10 },
    start: options.start ?? '2026-01-01T00:00:00.000Z',
  })
}

export function proposed(lab: Lab, index = 0): ExperimentProposed {
  return createExperimentProposed({
    programId: lab.programId,
    issueId: lab.issueId,
    experimentId: lab.experimentIdFor(index),
    planCommentId: `plan-${index + 1}`,
  })
}
