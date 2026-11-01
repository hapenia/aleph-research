/**
 * Runtime tests for the model-facing tool definitions.
 *
 * The type surface already fixes each tool's input, output and command literal. These
 * tests prove the runtime half: every tool accepts a valid sample, refuses an invalid
 * one, command tools carry the matching literal, the Host-injected fields are rejected
 * and the tool-set keys match the role interfaces.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { CommandType } from '../src/types/commands.ts'
import type { DomainError, Result } from '../src/types/errors.ts'
import {
  IMPLEMENTER_TOOLS,
  OPERATOR_TOOLS,
  RESEARCHER_TOOLS,
  TOOL_REGISTRY,
  WATCHDOG_TOOLS,
} from '../src/runtime/tools.ts'

interface ParseSchema {
  readonly parse: (input: unknown) => Result<unknown, DomainError>
  readonly toJsonSchema: () => unknown
}

interface TestTool {
  readonly name: string
  readonly description: string
  readonly parameters: ParseSchema
  readonly output: ParseSchema
}

interface ToolCase {
  readonly tool: TestTool
  readonly input: unknown
  readonly output: unknown
  readonly invalidInput: unknown
  readonly invalidOutput: unknown
}

interface CommandCase {
  readonly tool: TestTool & { readonly command: CommandType }
  readonly expected: CommandType
  readonly input: Record<string, unknown>
}

const PROGRAM_ID = 'program-1'
const ISSUE_ID = 'issue-1'
const EXPERIMENT_ID = 'experiment-1'
const CI_RUN_ID = 'ci-run-1'
const HEAD = '0123456789abcdef0123456789abcdef01234567'
const AT = '2026-11-02T04:08:22Z'

const ENVIRONMENT = { kind: 'uv-lock', lockFile: 'uv.lock', pythonVersion: '3.12' }
const CONTRACT = { ciEntry: 'python -m eval', timeoutMs: 60_000, requiredMetrics: ['accuracy'] }
const UTILITY = { metrics: [{ name: 'accuracy', direction: 'higher', weight: 1 }] }
const BUDGET = { maxExperiments: 10, maxComputeMinutes: 60, maxTokens: 1_000 }
const PRINCIPAL = { kind: 'researcher', sessionId: 'sess-1' }

const ARTIFACT = {
  id: 'artifact-1',
  kind: 'report',
  digest: 'sha256:abc',
  bytes: 1_024,
  programId: PROGRAM_ID,
  experimentId: EXPERIMENT_ID,
  commit: HEAD,
  ciRunId: CI_RUN_ID,
  retention: 'keep',
  createdAt: AT,
}

const PLAN = {
  hypothesis: 'a wider window is better',
  steps: ['collect a sample', 'fit the model'],
  expected: { direction: 'higher', rationale: 'the baseline is underfit' },
  environment: ENVIRONMENT,
  inputs: [ARTIFACT],
}

const READ_PROGRAM_INPUT = { programId: PROGRAM_ID }
const READ_METRICS_INPUT = {
  programId: PROGRAM_ID,
  experimentId: EXPERIMENT_ID,
  sort: [{ metric: 'accuracy', direction: 'higher' }],
  aggregate: 'latest',
  limit: 10,
}
const CREATE_ISSUE_INPUT = {
  type: 'issue.create',
  programId: PROGRAM_ID,
  title: 'a wider window',
  body: 'the baseline underfits',
  labels: ['research'],
}
const CLAIM_ISSUE_INPUT = { type: 'issue.claim', programId: PROGRAM_ID, issueId: ISSUE_ID }
const COMMENT_INPUT = {
  type: 'issue.comment',
  programId: PROGRAM_ID,
  issueId: ISSUE_ID,
  body: 'a plan',
  kind: 'plan',
}
const PROPOSE_INPUT = {
  type: 'experiment.propose',
  programId: PROGRAM_ID,
  issueId: ISSUE_ID,
  plan: PLAN,
}
const REVIEW_INPUT = {
  type: 'experiment.review',
  programId: PROGRAM_ID,
  experimentId: EXPERIMENT_ID,
  body: 'looks sound',
  verdict: 'approve',
}
const REQUEST_CI_INPUT = {
  type: 'ci.request',
  programId: PROGRAM_ID,
  experimentId: EXPERIMENT_ID,
}
const CLOSE_ISSUE_INPUT = {
  type: 'issue.close',
  programId: PROGRAM_ID,
  issueId: ISSUE_ID,
  resolution: 'accepted',
  summary: 'answered by experiment 1',
}
const CLOSE_EXPERIMENT_INPUT = {
  type: 'experiment.close',
  programId: PROGRAM_ID,
  experimentId: EXPERIMENT_ID,
  reason: 'concluded',
}
const SUBMIT_INPUT = { type: 'ticket.submit', head: HEAD, environment: ENVIRONMENT }
const CREATE_PROGRAM_INPUT = {
  type: 'program.create',
  name: 'wider windows',
  goal: 'improve accuracy',
  methodology: 'controlled experiments',
  contract: CONTRACT,
  utility: UTILITY,
  exploration: 'normal',
  budget: BUDGET,
}
const PAUSE_INPUT = { type: 'program.pause', programId: PROGRAM_ID }
const RESUME_INPUT = { type: 'program.resume', programId: PROGRAM_ID }
const STOP_INPUT = { type: 'program.stop', programId: PROGRAM_ID, reason: 'budget spent' }
const SET_GOAL_INPUT = { type: 'program.set-goal', programId: PROGRAM_ID, goal: 'new goal' }
const SET_METHODOLOGY_INPUT = {
  type: 'program.set-methodology',
  programId: PROGRAM_ID,
  methodology: 'new methodology',
}
const SET_EXPLORATION_INPUT = { type: 'program.set-exploration', programId: PROGRAM_ID, level: 'high' }
const READ_EXPERIMENT_INPUT = { experimentId: EXPERIMENT_ID }
const RAISE_ATTENTION_INPUT = {
  reason: 'the issue is stalled',
  subject: { kind: 'issue', id: ISSUE_ID },
}

const PROGRAM_BASE = {
  id: PROGRAM_ID,
  name: 'wider windows',
  goal: 'improve accuracy',
  methodology: 'controlled experiments',
  contract: CONTRACT,
  utility: UTILITY,
  exploration: 'normal',
  budget: BUDGET,
  usage: { experiments: 0, computeMinutes: 0, tokens: 0 },
  createdAt: AT,
}
const RUNNING_PROGRAM = { ...PROGRAM_BASE, status: 'running' }
const PAUSED_PROGRAM = { ...PROGRAM_BASE, status: 'paused', pausedAt: AT }
const STOPPED_PROGRAM = { ...PROGRAM_BASE, status: 'stopped', stoppedAt: AT, stopReason: 'budget spent' }

const ISSUE_BASE = {
  id: ISSUE_ID,
  programId: PROGRAM_ID,
  title: 'a wider window',
  body: 'the baseline underfits',
  labels: ['research'],
  author: { kind: 'operator', sessionId: 'sess-operator' },
  createdAt: AT,
}
const OPEN_ISSUE = { ...ISSUE_BASE, status: 'open' }
const ASSIGNED_ISSUE = {
  ...ISSUE_BASE,
  status: 'assigned',
  assignee: PRINCIPAL,
  assignedAt: AT,
  experimentIds: [EXPERIMENT_ID],
}
const CLOSED_ISSUE = {
  ...ISSUE_BASE,
  status: 'closed',
  assigneeSessionId: null,
  closedAt: AT,
  resolution: 'accepted',
  summary: 'answered',
}

const EXPERIMENT_BASE = {
  id: EXPERIMENT_ID,
  programId: PROGRAM_ID,
  issueId: ISSUE_ID,
  branch: 'exp/program-1/issue-1',
  head: HEAD,
  environment: ENVIRONMENT,
  lineage: { strategy: 'fresh', baseCommit: HEAD, freshStartProbability: 0.1 },
  planCommentId: 'comment-1',
  createdBy: PRINCIPAL,
  createdAt: AT,
}
const OPEN_EXPERIMENT = { ...EXPERIMENT_BASE, status: 'open' }
const READY_EXPERIMENT = { ...EXPERIMENT_BASE, status: 'ready', readyAt: AT }
const PENDING_EXPERIMENT = {
  ...EXPERIMENT_BASE,
  status: 'ci-pending',
  ciRunId: CI_RUN_ID,
  requestedAt: AT,
}
const CLOSED_EXPERIMENT = {
  ...EXPERIMENT_BASE,
  status: 'closed',
  closedAt: AT,
  closeReason: 'concluded',
  outcome: 'concluded',
}

const ISSUE_COMMENT = {
  id: 'comment-1',
  issueId: ISSUE_ID,
  authorSessionId: 'sess-1',
  body: 'a plan',
  at: AT,
  kind: 'plan',
}
const EXPERIMENT_REVIEW = {
  id: 'review-1',
  experimentId: EXPERIMENT_ID,
  author: PRINCIPAL,
  body: 'looks sound',
  at: AT,
  kind: 'review',
  verdict: 'approve',
}
const ATTENTION = {
  id: 'attention-1',
  subject: { kind: 'issue', id: ISSUE_ID },
  severity: 'warning',
  reason: 'the issue is stalled',
  detail: 'no activity',
  at: AT,
}
const PASSED_CI = {
  id: CI_RUN_ID,
  programId: PROGRAM_ID,
  experimentId: EXPERIMENT_ID,
  commit: HEAD,
  requestedBy: 'sess-1',
  requestedAt: AT,
  status: 'passed',
  startedAt: AT,
  finishedAt: AT,
  environmentDigest: 'sha256:env',
  metrics: { accuracy: 0.9 },
  artifacts: [ARTIFACT],
  durationMs: 1_200,
}
const METRIC_RESULT = { rows: [PASSED_CI], summaries: [{ metric: 'accuracy', value: 0.9 }] }
const AUDIT_ENTRY = {
  id: 'audit-1',
  at: AT,
  programId: PROGRAM_ID,
  action: 'issue.created',
  subject: { kind: 'issue', id: ISSUE_ID },
  actor: { kind: 'operator', sessionId: 'sess-operator' },
  detail: {},
}
const SNAPSHOT = {
  program: RUNNING_PROGRAM,
  issues: [OPEN_ISSUE],
  comments: [ISSUE_COMMENT],
  experiments: [OPEN_EXPERIMENT],
  ciRecords: [PASSED_CI],
  artifacts: [ARTIFACT],
  attention: [ATTENTION],
  audit: [AUDIT_ENTRY],
}

function accepts(result: Result<unknown, DomainError>): void {
  if (!result.ok) {
    assert.fail(`expected acceptance, got ${result.error.code}: ${result.error.message}`)
  }
  assert.equal(result.ok, true)
}

function refuses(result: Result<unknown, DomainError>): void {
  if (result.ok) assert.fail('expected a refusal')
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'invalid-input')
  assert.ok(result.error.message.length > 0)
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return Object.fromEntries(Object.entries(value))
}

function assertToolMetadata(tool: TestTool): void {
  assert.ok(tool.name.length > 0)
  assert.ok(tool.description.length > 0)
  assert.equal(typeof tool.parameters.parse, 'function')
  assert.equal(typeof tool.parameters.toJsonSchema, 'function')
  assert.equal(typeof tool.output.parse, 'function')
  assert.equal(typeof tool.output.toJsonSchema, 'function')
  assert.equal(typeof tool.parameters.toJsonSchema(), 'object')
  assert.equal(typeof tool.output.toJsonSchema(), 'object')
}

function runCases(cases: readonly ToolCase[], expectedCount: number): void {
  assert.equal(cases.length, expectedCount, 'every interface key needs a case')

  it('declares metadata for every tool', () => {
    for (const current of cases) assertToolMetadata(current.tool)
  })

  for (const current of cases) {
    it(`${current.tool.name} parses a valid input and output`, () => {
      accepts(current.tool.parameters.parse(current.input))
      accepts(current.tool.output.parse(current.output))
    })

    it(`${current.tool.name} refuses an invalid input and output`, () => {
      refuses(current.tool.parameters.parse(current.invalidInput))
      refuses(current.tool.output.parse(current.invalidOutput))
    })
  }
}

describe('researcher tools', () => {
  const cases: readonly ToolCase[] = [
    {
      tool: RESEARCHER_TOOLS.readProgram,
      input: READ_PROGRAM_INPUT,
      output: SNAPSHOT,
      invalidInput: { programId: 42 },
      invalidOutput: { ...SNAPSHOT, program: null },
    },
    {
      tool: RESEARCHER_TOOLS.readMetrics,
      input: READ_METRICS_INPUT,
      output: METRIC_RESULT,
      invalidInput: { programId: PROGRAM_ID, aggregate: 'median' },
      invalidOutput: { rows: [], summaries: [{ metric: 'accuracy', value: 'high' }] },
    },
    {
      tool: RESEARCHER_TOOLS.createIssue,
      input: CREATE_ISSUE_INPUT,
      output: OPEN_ISSUE,
      invalidInput: { ...CREATE_ISSUE_INPUT, labels: [] },
      invalidOutput: { ...OPEN_ISSUE, status: 'assigned' },
    },
    {
      tool: RESEARCHER_TOOLS.claimIssue,
      input: CLAIM_ISSUE_INPUT,
      output: ASSIGNED_ISSUE,
      invalidInput: { type: 'issue.claim', programId: PROGRAM_ID },
      invalidOutput: { ...ASSIGNED_ISSUE, assignee: null },
    },
    {
      tool: RESEARCHER_TOOLS.commentOnIssue,
      input: COMMENT_INPUT,
      output: ISSUE_COMMENT,
      invalidInput: { ...COMMENT_INPUT, kind: 'review' },
      invalidOutput: { ...ISSUE_COMMENT, kind: 'review' },
    },
    {
      tool: RESEARCHER_TOOLS.proposeExperiment,
      input: PROPOSE_INPUT,
      output: OPEN_EXPERIMENT,
      invalidInput: { ...PROPOSE_INPUT, assignment: { issueId: ISSUE_ID } },
      invalidOutput: { ...OPEN_EXPERIMENT, status: 'ready' },
    },
    {
      tool: RESEARCHER_TOOLS.reviewExperiment,
      input: REVIEW_INPUT,
      output: EXPERIMENT_REVIEW,
      invalidInput: { ...REVIEW_INPUT, assignment: { issueId: ISSUE_ID } },
      invalidOutput: { ...EXPERIMENT_REVIEW, verdict: 'reject' },
    },
    {
      tool: RESEARCHER_TOOLS.requestCI,
      input: REQUEST_CI_INPUT,
      output: PENDING_EXPERIMENT,
      invalidInput: { ...REQUEST_CI_INPUT, experimentId: 'not an id' },
      invalidOutput: { ...PENDING_EXPERIMENT, ciRunId: '' },
    },
    {
      tool: RESEARCHER_TOOLS.closeIssue,
      input: CLOSE_ISSUE_INPUT,
      output: CLOSED_ISSUE,
      invalidInput: { ...CLOSE_ISSUE_INPUT, resolution: 'done' },
      invalidOutput: { ...CLOSED_ISSUE, resolution: 'done' },
    },
    {
      tool: RESEARCHER_TOOLS.closeExperiment,
      input: CLOSE_EXPERIMENT_INPUT,
      output: CLOSED_EXPERIMENT,
      invalidInput: { ...CLOSE_EXPERIMENT_INPUT, reason: '' },
      invalidOutput: { ...CLOSED_EXPERIMENT, outcome: 'passed' },
    },
  ]

  runCases(cases, 10)
})

describe('implementer tools', () => {
  const cases: readonly ToolCase[] = [
    {
      tool: IMPLEMENTER_TOOLS.submitImplementation,
      input: SUBMIT_INPUT,
      output: READY_EXPERIMENT,
      invalidInput: { ...SUBMIT_INPUT, binding: { ticketId: 'ticket-1' } },
      invalidOutput: { ...READY_EXPERIMENT, readyAt: 'not-a-timestamp' },
    },
    {
      tool: IMPLEMENTER_TOOLS.readExperiment,
      input: READ_EXPERIMENT_INPUT,
      output: OPEN_EXPERIMENT,
      invalidInput: { experimentId: 7 },
      invalidOutput: { ...OPEN_EXPERIMENT, status: 'unknown' },
    },
  ]

  runCases(cases, 2)
})

describe('operator tools', () => {
  const cases: readonly ToolCase[] = [
    {
      tool: OPERATOR_TOOLS.createProgram,
      input: CREATE_PROGRAM_INPUT,
      output: RUNNING_PROGRAM,
      invalidInput: { ...CREATE_PROGRAM_INPUT, budget: { ...BUDGET, maxExperiments: 0 } },
      invalidOutput: { ...RUNNING_PROGRAM, status: 'paused' },
    },
    {
      tool: OPERATOR_TOOLS.pauseProgram,
      input: PAUSE_INPUT,
      output: PAUSED_PROGRAM,
      invalidInput: { ...PAUSE_INPUT, type: 'program.resume' },
      invalidOutput: { ...PAUSED_PROGRAM, status: 'running' },
    },
    {
      tool: OPERATOR_TOOLS.resumeProgram,
      input: RESUME_INPUT,
      output: RUNNING_PROGRAM,
      invalidInput: { type: 'program.resume' },
      invalidOutput: { ...RUNNING_PROGRAM, status: 'paused' },
    },
    {
      tool: OPERATOR_TOOLS.stopProgram,
      input: STOP_INPUT,
      output: STOPPED_PROGRAM,
      invalidInput: { ...STOP_INPUT, reason: '' },
      invalidOutput: { ...STOPPED_PROGRAM, status: 'running' },
    },
    {
      tool: OPERATOR_TOOLS.setGoal,
      input: SET_GOAL_INPUT,
      output: RUNNING_PROGRAM,
      invalidInput: { ...SET_GOAL_INPUT, goal: '   ' },
      invalidOutput: { ...RUNNING_PROGRAM, status: 'stopped' },
    },
    {
      tool: OPERATOR_TOOLS.setMethodology,
      input: SET_METHODOLOGY_INPUT,
      output: RUNNING_PROGRAM,
      invalidInput: { ...SET_METHODOLOGY_INPUT, methodology: 42 },
      invalidOutput: { ...RUNNING_PROGRAM, status: 'completed' },
    },
    {
      tool: OPERATOR_TOOLS.setExploration,
      input: SET_EXPLORATION_INPUT,
      output: RUNNING_PROGRAM,
      invalidInput: { ...SET_EXPLORATION_INPUT, level: 'medium' },
      invalidOutput: { ...RUNNING_PROGRAM, exploration: 'medium' },
    },
    {
      tool: OPERATOR_TOOLS.createIssue,
      input: CREATE_ISSUE_INPUT,
      output: OPEN_ISSUE,
      invalidInput: { ...CREATE_ISSUE_INPUT, labels: ['unknown-label'] },
      invalidOutput: { ...OPEN_ISSUE, labels: ['unknown-label'] },
    },
  ]

  runCases(cases, 8)
})

describe('watchdog tools', () => {
  const cases: readonly ToolCase[] = [
    {
      tool: WATCHDOG_TOOLS.listStalled,
      input: {},
      output: [OPEN_ISSUE, ASSIGNED_ISSUE],
      invalidInput: { programId: PROGRAM_ID },
      invalidOutput: { issues: [OPEN_ISSUE] },
    },
    {
      tool: WATCHDOG_TOOLS.raiseAttention,
      input: RAISE_ATTENTION_INPUT,
      output: ATTENTION,
      invalidInput: { ...RAISE_ATTENTION_INPUT, subject: { kind: 'artifact', id: ISSUE_ID } },
      invalidOutput: { ...ATTENTION, severity: 'fatal' },
    },
    {
      tool: WATCHDOG_TOOLS.readMetrics,
      input: { programId: PROGRAM_ID },
      output: METRIC_RESULT,
      invalidInput: { programId: PROGRAM_ID, sort: [{ metric: 'accuracy', direction: 'sideways' }] },
      invalidOutput: { rows: [], summaries: 'none' },
    },
  ]

  runCases(cases, 3)
})

describe('tool set keys', () => {
  const expected = {
    researcher: [
      'readProgram',
      'readMetrics',
      'createIssue',
      'claimIssue',
      'commentOnIssue',
      'proposeExperiment',
      'reviewExperiment',
      'requestCI',
      'closeIssue',
      'closeExperiment',
    ],
    implementer: ['submitImplementation', 'readExperiment'],
    operator: [
      'createProgram',
      'pauseProgram',
      'resumeProgram',
      'stopProgram',
      'setGoal',
      'setMethodology',
      'setExploration',
      'createIssue',
    ],
    watchdog: ['listStalled', 'raiseAttention', 'readMetrics'],
  }

  const roles: readonly (keyof typeof TOOL_REGISTRY)[] = ['researcher', 'implementer', 'operator', 'watchdog']
  for (const role of roles) {
    it(`${role} exposes exactly the interface keys`, () => {
      assert.deepEqual(Object.keys(TOOL_REGISTRY[role]).sort(), [...expected[role]].sort())
    })
  }

  it('gives every registered tool a unique name', () => {
    const names = [
      ...Object.values(RESEARCHER_TOOLS).map((tool) => tool.name),
      ...Object.values(IMPLEMENTER_TOOLS).map((tool) => tool.name),
      ...Object.values(OPERATOR_TOOLS).map((tool) => tool.name),
      ...Object.values(WATCHDOG_TOOLS).map((tool) => tool.name),
    ]
    assert.equal(new Set(names).size, names.length)
  })
})

describe('command tools', () => {
  const commandCases: readonly CommandCase[] = [
    { tool: RESEARCHER_TOOLS.createIssue, expected: 'issue.create', input: CREATE_ISSUE_INPUT },
    { tool: RESEARCHER_TOOLS.claimIssue, expected: 'issue.claim', input: CLAIM_ISSUE_INPUT },
    { tool: RESEARCHER_TOOLS.commentOnIssue, expected: 'issue.comment', input: COMMENT_INPUT },
    { tool: RESEARCHER_TOOLS.proposeExperiment, expected: 'experiment.propose', input: PROPOSE_INPUT },
    { tool: RESEARCHER_TOOLS.reviewExperiment, expected: 'experiment.review', input: REVIEW_INPUT },
    { tool: RESEARCHER_TOOLS.requestCI, expected: 'ci.request', input: REQUEST_CI_INPUT },
    { tool: RESEARCHER_TOOLS.closeIssue, expected: 'issue.close', input: CLOSE_ISSUE_INPUT },
    { tool: RESEARCHER_TOOLS.closeExperiment, expected: 'experiment.close', input: CLOSE_EXPERIMENT_INPUT },
    { tool: IMPLEMENTER_TOOLS.submitImplementation, expected: 'ticket.submit', input: SUBMIT_INPUT },
    { tool: OPERATOR_TOOLS.createProgram, expected: 'program.create', input: CREATE_PROGRAM_INPUT },
    { tool: OPERATOR_TOOLS.pauseProgram, expected: 'program.pause', input: PAUSE_INPUT },
    { tool: OPERATOR_TOOLS.resumeProgram, expected: 'program.resume', input: RESUME_INPUT },
    { tool: OPERATOR_TOOLS.stopProgram, expected: 'program.stop', input: STOP_INPUT },
    { tool: OPERATOR_TOOLS.setGoal, expected: 'program.set-goal', input: SET_GOAL_INPUT },
    { tool: OPERATOR_TOOLS.setMethodology, expected: 'program.set-methodology', input: SET_METHODOLOGY_INPUT },
    { tool: OPERATOR_TOOLS.setExploration, expected: 'program.set-exploration', input: SET_EXPLORATION_INPUT },
    { tool: OPERATOR_TOOLS.createIssue, expected: 'issue.create', input: CREATE_ISSUE_INPUT },
  ]

  it('carries the command literal of its input type', () => {
    assert.equal(commandCases.length, 17)
    for (const current of commandCases) {
      assert.equal(current.tool.command, current.expected)
    }
  })

  it('accepts the matching type field and refuses a different one', () => {
    for (const current of commandCases) {
      accepts(current.tool.parameters.parse(current.input))
      const wrongType = current.expected === 'program.pause' ? 'program.resume' : 'program.pause'
      refuses(current.tool.parameters.parse({ ...current.input, type: wrongType }))
    }
  })
})

describe('Host-injected fields', () => {
  it('implementer submit refuses a binding field', () => {
    const result = IMPLEMENTER_TOOLS.submitImplementation.parameters.parse({
      ...SUBMIT_INPUT,
      binding: { ticketId: 'ticket-1', experimentId: EXPERIMENT_ID, sessionId: 'sess-1' },
    })
    refuses(result)
  })

  it('implementer submit refuses an assignment field', () => {
    refuses(
      IMPLEMENTER_TOOLS.submitImplementation.parameters.parse({
        ...SUBMIT_INPUT,
        assignment: { issueId: ISSUE_ID },
      }),
    )
  })

  it('researcher ownership commands refuse an assignment field', () => {
    const ownershipCommands: readonly (readonly [TestTool, Record<string, unknown>])[] = [
      [RESEARCHER_TOOLS.proposeExperiment, PROPOSE_INPUT],
      [RESEARCHER_TOOLS.reviewExperiment, REVIEW_INPUT],
      [RESEARCHER_TOOLS.closeExperiment, CLOSE_EXPERIMENT_INPUT],
    ]
    for (const [tool, input] of ownershipCommands) {
      refuses(tool.parameters.parse({ ...input, assignment: { issueId: ISSUE_ID } }))
    }
  })

  it('advertises no Host-injected field in the submit schema', () => {
    const json = asRecord(IMPLEMENTER_TOOLS.submitImplementation.parameters.toJsonSchema())
    assert.ok(json !== null)
    const properties = asRecord(json.properties)
    assert.ok(properties !== null)
    assert.equal('binding' in properties, false)
    assert.equal('assignment' in properties, false)
    assert.equal(json.additionalProperties, false)
  })
})

describe('attention subjects', () => {
  const subjects = [
    { kind: 'program', id: PROGRAM_ID },
    { kind: 'issue', id: ISSUE_ID },
    { kind: 'experiment', id: EXPERIMENT_ID },
    { kind: 'ci-run', id: CI_RUN_ID },
  ]

  it('accepts each typed subject kind', () => {
    for (const subject of subjects) {
      accepts(WATCHDOG_TOOLS.raiseAttention.parameters.parse({ ...RAISE_ATTENTION_INPUT, subject }))
    }
  })

  it('refuses an unknown subject kind or a mismatched id shape', () => {
    for (const subject of [
      { kind: 'artifact', id: PROGRAM_ID },
      { kind: 'program', id: 'not an id' },
      { kind: 'program' },
    ]) {
      refuses(WATCHDOG_TOOLS.raiseAttention.parameters.parse({ ...RAISE_ATTENTION_INPUT, subject }))
    }
  })
})

describe('input schemas are strict', () => {
  it('refuses an unexpected top-level field on every tool', () => {
    const cases: readonly (readonly [TestTool, unknown])[] = [
      [RESEARCHER_TOOLS.readProgram, READ_PROGRAM_INPUT],
      [RESEARCHER_TOOLS.readMetrics, READ_METRICS_INPUT],
      [RESEARCHER_TOOLS.createIssue, CREATE_ISSUE_INPUT],
      [RESEARCHER_TOOLS.claimIssue, CLAIM_ISSUE_INPUT],
      [RESEARCHER_TOOLS.commentOnIssue, COMMENT_INPUT],
      [RESEARCHER_TOOLS.proposeExperiment, PROPOSE_INPUT],
      [RESEARCHER_TOOLS.reviewExperiment, REVIEW_INPUT],
      [RESEARCHER_TOOLS.requestCI, REQUEST_CI_INPUT],
      [RESEARCHER_TOOLS.closeIssue, CLOSE_ISSUE_INPUT],
      [RESEARCHER_TOOLS.closeExperiment, CLOSE_EXPERIMENT_INPUT],
      [IMPLEMENTER_TOOLS.submitImplementation, SUBMIT_INPUT],
      [IMPLEMENTER_TOOLS.readExperiment, READ_EXPERIMENT_INPUT],
      [OPERATOR_TOOLS.createProgram, CREATE_PROGRAM_INPUT],
      [OPERATOR_TOOLS.pauseProgram, PAUSE_INPUT],
      [OPERATOR_TOOLS.resumeProgram, RESUME_INPUT],
      [OPERATOR_TOOLS.stopProgram, STOP_INPUT],
      [OPERATOR_TOOLS.setGoal, SET_GOAL_INPUT],
      [OPERATOR_TOOLS.setMethodology, SET_METHODOLOGY_INPUT],
      [OPERATOR_TOOLS.setExploration, SET_EXPLORATION_INPUT],
      [WATCHDOG_TOOLS.listStalled, {}],
      [WATCHDOG_TOOLS.raiseAttention, RAISE_ATTENTION_INPUT],
      [WATCHDOG_TOOLS.readMetrics, { programId: PROGRAM_ID }],
    ]

    for (const [tool, input] of cases) {
      const record = asRecord(input)
      assert.ok(record !== null)
      refuses(tool.parameters.parse({ ...record, unexpected: true }))
    }
  })

  it('listStalled accepts only an empty object', () => {
    accepts(WATCHDOG_TOOLS.listStalled.parameters.parse({}))
    refuses(WATCHDOG_TOOLS.listStalled.parameters.parse({ filter: 'all' }))
    refuses(WATCHDOG_TOOLS.listStalled.parameters.parse(null))
  })
})
