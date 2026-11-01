/**
 * Runtime tests for the command parser table.
 *
 * Every command gets one valid body and representative invalid bodies; the type-level
 * helpers prove that the Host-injected `assignment`/`binding` fields are absent from the
 * parsed command type, and the runtime tests prove that a body cannot smuggle them in by
 * adding extra properties.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { CommandOf, CommandType } from '../src/types/commands.ts'
import type { DomainError, Result } from '../src/types/errors.ts'
import type { WriteRoutes } from '../src/runtime/executor.ts'
import type { ModelCommandOf } from '../src/parsers-commands.ts'
import { COMMAND_PARSERS, parseCommand } from '../src/parsers-commands.ts'

// ---------------------------------------------------------------------------
// Compile-level coverage: the parsed value must not expose a Host field.
// ---------------------------------------------------------------------------

type Expect<T extends true> = T
type HostFieldKey<T> = Extract<keyof T, 'assignment' | 'binding'>
type HasNoHostField<T> = [HostFieldKey<T>] extends [never] ? true : false
type ParsedValue<R> = R extends Result<infer Value, DomainError> ? Value : never

type _ProposeCommandHasAssignment = Expect<
  'assignment' extends keyof CommandOf<'experiment.propose'> ? true : false
>
type _SubmitCommandHasBinding = Expect<
  'binding' extends keyof CommandOf<'ticket.submit'> ? true : false
>

type _ProposeModelHasNoAssignment = Expect<HasNoHostField<ModelCommandOf<'experiment.propose'>>>
type _ReviewModelHasNoAssignment = Expect<HasNoHostField<ModelCommandOf<'experiment.review'>>>
type _CloseModelHasNoAssignment = Expect<HasNoHostField<ModelCommandOf<'experiment.close'>>>
type _SubmitModelHasNoBinding = Expect<HasNoHostField<ModelCommandOf<'ticket.submit'>>>
type _PauseModelHasNoHostField = Expect<HasNoHostField<ModelCommandOf<'program.pause'>>>

type _ProposeParserHasNoAssignment = Expect<
  HasNoHostField<ParsedValue<ReturnType<(typeof COMMAND_PARSERS)['experiment.propose']>>>
>
type _SubmitParserHasNoBinding = Expect<
  HasNoHostField<ParsedValue<ReturnType<(typeof COMMAND_PARSERS)['ticket.submit']>>>
>

const COMMAND_TYPES: readonly CommandType[] = [
  'program.create',
  'program.pause',
  'program.resume',
  'program.stop',
  'program.set-goal',
  'program.set-methodology',
  'program.set-exploration',
  'issue.create',
  'issue.claim',
  'issue.comment',
  'issue.close',
  'experiment.propose',
  'experiment.review',
  'experiment.close',
  'ci.request',
  'ticket.submit',
]

const HEAD = '0123456789abcdef0123456789abcdef01234567'
const OTHER_HEAD = 'f'.repeat(64)
const PROGRAM = 'program-1'
const ISSUE = 'issue-1'
const EXPERIMENT = 'experiment-1'
const ARTIFACT = 'artifact-1'

/** Valid model-supplied bodies, one per command. */
const VALID_BODIES = {
  'program.create': {
    name: 'protein folding',
    goal: 'find a better folding heuristic',
    methodology: 'one change per experiment',
    contract: {
      ciEntry: 'uv run python -m ci',
      timeoutMs: 600_000,
      requiredMetrics: ['accuracy', 'latency'],
    },
    utility: {
      metrics: [
        { name: 'accuracy', direction: 'higher', weight: 1, required: true },
        { name: 'latency', direction: 'lower', weight: 0.5, required: false },
      ],
    },
    exploration: 'normal',
    budget: { maxExperiments: 12, maxComputeMinutes: 240, maxTokens: 1_000_000 },
  },
  'program.pause': { programId: PROGRAM },
  'program.resume': { programId: PROGRAM },
  'program.stop': { programId: PROGRAM, reason: 'budget exhausted' },
  'program.set-goal': { programId: PROGRAM, goal: 'a sharper goal' },
  'program.set-methodology': { programId: PROGRAM, methodology: 'a new method' },
  'program.set-exploration': { programId: PROGRAM, level: 'high' },
  'issue.create': {
    programId: PROGRAM,
    title: 'Sparse attention',
    body: 'Does sparse attention keep accuracy?',
    labels: ['research', 'experiment'],
  },
  'issue.claim': { programId: PROGRAM, issueId: ISSUE },
  'issue.comment': {
    programId: PROGRAM,
    issueId: ISSUE,
    body: 'The plan is attached.',
    kind: 'plan',
  },
  'issue.close': {
    programId: PROGRAM,
    issueId: ISSUE,
    resolution: 'accepted',
    summary: 'the hypothesis held',
  },
  'experiment.propose': {
    programId: PROGRAM,
    issueId: ISSUE,
    plan: {
      hypothesis: 'a wider window improves accuracy',
      steps: ['widen the window', 'rerun the benchmark'],
      expected: { direction: 'higher', rationale: 'more context is available' },
      environment: { kind: 'uv-lock', lockFile: 'uv.lock', pythonVersion: '3.12' },
      inputs: [{ artifactId: ARTIFACT, mountAs: 'data/previous-run' }],
    },
  },
  'experiment.review': {
    programId: PROGRAM,
    experimentId: EXPERIMENT,
    body: 'The plan is sound.',
    verdict: 'approve',
  },
  'experiment.close': {
    programId: PROGRAM,
    experimentId: EXPERIMENT,
    reason: 'the result is conclusive',
  },
  'ci.request': { programId: PROGRAM, experimentId: EXPERIMENT },
  'ticket.submit': {
    head: HEAD,
    environment: {
      kind: 'requirements',
      requirementsFile: 'requirements.txt',
      pythonVersion: '3.11',
    },
  },
} satisfies Readonly<Record<CommandType, object>>

/** The exact model command each valid body must produce. */
const EXPECTED_COMMANDS = {
  'program.create': {
    type: 'program.create',
    name: 'protein folding',
    goal: 'find a better folding heuristic',
    methodology: 'one change per experiment',
    contract: {
      ciEntry: 'uv run python -m ci',
      timeoutMs: 600_000,
      requiredMetrics: ['accuracy', 'latency'],
    },
    utility: {
      metrics: [
        { name: 'accuracy', direction: 'higher', weight: 1 },
        { name: 'latency', direction: 'lower', weight: 0.5 },
      ],
    },
    exploration: 'normal',
    budget: { maxExperiments: 12, maxComputeMinutes: 240, maxTokens: 1_000_000 },
  },
  'program.pause': { type: 'program.pause', programId: PROGRAM },
  'program.resume': { type: 'program.resume', programId: PROGRAM },
  'program.stop': { type: 'program.stop', programId: PROGRAM, reason: 'budget exhausted' },
  'program.set-goal': { type: 'program.set-goal', programId: PROGRAM, goal: 'a sharper goal' },
  'program.set-methodology': {
    type: 'program.set-methodology',
    programId: PROGRAM,
    methodology: 'a new method',
  },
  'program.set-exploration': {
    type: 'program.set-exploration',
    programId: PROGRAM,
    level: 'high',
  },
  'issue.create': {
    type: 'issue.create',
    programId: PROGRAM,
    title: 'Sparse attention',
    body: 'Does sparse attention keep accuracy?',
    labels: ['research', 'experiment'],
  },
  'issue.claim': { type: 'issue.claim', programId: PROGRAM, issueId: ISSUE },
  'issue.comment': {
    type: 'issue.comment',
    programId: PROGRAM,
    issueId: ISSUE,
    body: 'The plan is attached.',
    kind: 'plan',
  },
  'issue.close': {
    type: 'issue.close',
    programId: PROGRAM,
    issueId: ISSUE,
    resolution: 'accepted',
    summary: 'the hypothesis held',
  },
  'experiment.propose': {
    type: 'experiment.propose',
    programId: PROGRAM,
    issueId: ISSUE,
    plan: {
      hypothesis: 'a wider window improves accuracy',
      steps: ['widen the window', 'rerun the benchmark'],
      expected: { direction: 'higher', rationale: 'more context is available' },
      environment: { kind: 'uv-lock', lockFile: 'uv.lock', pythonVersion: '3.12' },
      inputs: [{ artifactId: ARTIFACT, mountAs: 'data/previous-run' }],
    },
  },
  'experiment.review': {
    type: 'experiment.review',
    programId: PROGRAM,
    experimentId: EXPERIMENT,
    body: 'The plan is sound.',
    verdict: 'approve',
  },
  'experiment.close': {
    type: 'experiment.close',
    programId: PROGRAM,
    experimentId: EXPERIMENT,
    reason: 'the result is conclusive',
  },
  'ci.request': { type: 'ci.request', programId: PROGRAM, experimentId: EXPERIMENT },
  'ticket.submit': {
    type: 'ticket.submit',
    head: HEAD,
    environment: {
      kind: 'requirements',
      requirementsFile: 'requirements.txt',
      pythonVersion: '3.11',
    },
  },
} satisfies Readonly<Record<CommandType, object>>

/** Parse and assert acceptance, returning the parsed command. */
function accept<K extends CommandType>(command: K, input: unknown): ModelCommandOf<K> {
  const result = COMMAND_PARSERS[command](input)
  assert.equal(result.ok, true, `${command} should accept the body`)
  if (!result.ok) throw new Error(`${command}: ${result.error.message}`)
  return result.value
}

/** Parse and assert an `invalid-input` refusal with a non-empty message. */
function refuse<K extends CommandType>(command: K, input: unknown): DomainError {
  const result = COMMAND_PARSERS[command](input)
  assert.equal(result.ok, false, `${command} should refuse the body`)
  if (result.ok) throw new Error(`${command} accepted a body it should refuse`)
  assert.equal(result.error.code, 'invalid-input')
  assert.ok(result.error.message.length > 0, 'a refusal message is never empty')
  return result.error
}

/** Shallow-copy a body with a replacement field, without mutating the fixture. */
function withField(source: object, key: string, value: unknown): Readonly<Record<string, unknown>> {
  return { ...source, [key]: value }
}

/** Shallow-copy a nested object, replacing one of its fields. */
function nested(source: object, key: string, patch: object): Readonly<Record<string, unknown>> {
  return withField(source, key, patch)
}

const CREATE_BODY = VALID_BODIES['program.create']
const CREATE_CONTRACT = CREATE_BODY.contract
const CREATE_UTILITY = CREATE_BODY.utility
const CREATE_BUDGET = CREATE_BODY.budget
const PROPOSE_BODY = VALID_BODIES['experiment.propose']
const PROPOSE_PLAN = PROPOSE_BODY.plan
const SUBMIT_BODY = VALID_BODIES['ticket.submit']
const STOP_BODY = VALID_BODIES['program.stop']
const REVIEW_BODY = VALID_BODIES['experiment.review']
const COMMENT_BODY = VALID_BODIES['issue.comment']
const CLOSE_ISSUE_BODY = VALID_BODIES['issue.close']
const CREATE_ISSUE_BODY = VALID_BODIES['issue.create']
const SET_GOAL_BODY = VALID_BODIES['program.set-goal']
const SET_METHODOLOGY_BODY = VALID_BODIES['program.set-methodology']
const SET_EXPLORATION_BODY = VALID_BODIES['program.set-exploration']
const ENVIRONMENT_BODY = SUBMIT_BODY.environment

// ---------------------------------------------------------------------------
// Coverage and contract.
// ---------------------------------------------------------------------------

describe('parser table coverage', () => {
  it('covers all 16 command types exactly once', () => {
    assert.equal(COMMAND_TYPES.length, 16)
    assert.deepEqual(Object.keys(COMMAND_PARSERS).sort(), [...COMMAND_TYPES].sort())
    for (const command of COMMAND_TYPES) {
      assert.equal(typeof COMMAND_PARSERS[command], 'function')
    }
  })

  it('satisfies the executor write-route contract', () => {
    const routes: WriteRoutes = COMMAND_PARSERS
    assert.equal(typeof routes['ticket.submit'], 'function')
  })

  it('parseCommand selects the parser named by the command literal', () => {
    const parsed = parseCommand('program.pause', VALID_BODIES['program.pause'])
    assert.deepEqual(parsed, { ok: true, value: EXPECTED_COMMANDS['program.pause'] })
  })

  it('accepts a body that repeats the matching type literal', () => {
    const parsed = accept('program.pause', {
      type: 'program.pause',
      programId: PROGRAM,
    })
    assert.deepEqual(parsed, EXPECTED_COMMANDS['program.pause'])
  })

  it('refuses a body whose type literal names another command', () => {
    refuse('program.pause', { type: 'program.resume', programId: PROGRAM })
    refuse('ci.request', { type: 'ticket.submit', programId: PROGRAM, experimentId: EXPERIMENT })
  })
})

// ---------------------------------------------------------------------------
// Valid bodies and invalid non-objects.
// ---------------------------------------------------------------------------

describe('valid command bodies', () => {
  for (const command of COMMAND_TYPES) {
    it(`parses ${command}`, () => {
      const parsed = accept(command, VALID_BODIES[command])
      assert.deepEqual(parsed, EXPECTED_COMMANDS[command])
      assert.equal(Object.hasOwn(parsed, 'assignment'), false)
      assert.equal(Object.hasOwn(parsed, 'binding'), false)
    })
  }
})

describe('non-object bodies', () => {
  for (const command of COMMAND_TYPES) {
    it(`${command} refuses primitives, arrays and functions`, () => {
      for (const input of [undefined, null, 0, 1, 'body', true, [], () => undefined]) {
        refuse(command, input)
      }
    })
  }
})

// ---------------------------------------------------------------------------
// Host fields cannot be smuggled in.
// ---------------------------------------------------------------------------

describe('Host-injected fields never come from the body', () => {
  for (const command of ['experiment.propose', 'experiment.review', 'experiment.close'] as const) {
    it(`${command} refuses an assignment field`, () => {
      refuse(command, withField(VALID_BODIES[command], 'assignment', { issueId: ISSUE }))
    })
  }

  it('ticket.submit refuses a binding field', () => {
    refuse('ticket.submit', withField(SUBMIT_BODY, 'binding', { ticketId: 'ticket-1' }))
  })

  it('other commands refuse assignment and binding extras too', () => {
    for (const command of ['program.pause', 'issue.claim', 'ci.request'] as const) {
      refuse(command, withField(VALID_BODIES[command], 'assignment', {}))
      refuse(command, withField(VALID_BODIES[command], 'binding', {}))
    }
  })

  it('a valid parse exposes neither host field at runtime', () => {
    for (const command of ['experiment.propose', 'experiment.review', 'experiment.close'] as const) {
      const parsed = accept(command, VALID_BODIES[command])
      assert.equal(Object.hasOwn(parsed, 'assignment'), false)
    }
    const submitted = accept('ticket.submit', SUBMIT_BODY)
    assert.equal(Object.hasOwn(submitted, 'binding'), false)
  })
})

// ---------------------------------------------------------------------------
// program.create: nested contract, utility, exploration and budget.
// ---------------------------------------------------------------------------

describe('program.create', () => {
  it('drops the DTO required flag and uses contract.requiredMetrics', () => {
    const parsed = accept('program.create', CREATE_BODY)
    assert.deepEqual(parsed, EXPECTED_COMMANDS['program.create'])
    const [first] = parsed.utility.metrics
    assert.notEqual(first, undefined)
    if (first === undefined) return
    assert.equal(Object.hasOwn(first, 'required'), false)
  })

  it('refuses missing or empty name, goal and methodology', () => {
    for (const key of ['name', 'goal', 'methodology'] as const) {
      refuse('program.create', withField(CREATE_BODY, key, ''))
      refuse('program.create', withField(CREATE_BODY, key, '   '))
      refuse('program.create', withField(CREATE_BODY, key, 42))
      const without: Record<string, unknown> = { ...CREATE_BODY }
      delete without[key]
      refuse('program.create', without)
    }
  })

  it('refuses an invalid contract', () => {
    refuse('program.create', nested(CREATE_BODY, 'contract', withField(CREATE_CONTRACT, 'ciEntry', '')))
    refuse(
      'program.create',
      nested(CREATE_BODY, 'contract', withField(CREATE_CONTRACT, 'timeoutMs', -1)),
    )
    refuse(
      'program.create',
      nested(CREATE_BODY, 'contract', withField(CREATE_CONTRACT, 'timeoutMs', Number.NaN)),
    )
    refuse(
      'program.create',
      nested(CREATE_BODY, 'contract', withField(CREATE_CONTRACT, 'requiredMetrics', [])),
    )
    refuse(
      'program.create',
      nested(CREATE_BODY, 'contract', withField(CREATE_CONTRACT, 'requiredMetrics', 'accuracy')),
    )
    refuse(
      'program.create',
      nested(
        CREATE_BODY,
        'contract',
        withField(CREATE_CONTRACT, 'requiredMetrics', ['accuracy', '']),
      ),
    )
    refuse(
      'program.create',
      nested(CREATE_BODY, 'contract', withField(CREATE_CONTRACT, 'requiredMetrics', ['a\nb'])),
    )
    refuse(
      'program.create',
      nested(CREATE_BODY, 'contract', withField(CREATE_CONTRACT, 'unexpected', true)),
    )
    refuse('program.create', nested(CREATE_BODY, 'contract', {}))
    refuse('program.create', nested(CREATE_BODY, 'contract', 'contract'))
  })

  it('refuses an invalid utility configuration', () => {
    refuse('program.create', nested(CREATE_BODY, 'utility', { metrics: [] }))
    refuse('program.create', nested(CREATE_BODY, 'utility', { metrics: 'accuracy' }))
    refuse('program.create', nested(CREATE_BODY, 'utility', { metrics: [{}] }))
    refuse(
      'program.create',
      nested(CREATE_BODY, 'utility', {
        metrics: [{ name: 'accuracy', direction: 'up', weight: 1 }],
      }),
    )
    refuse(
      'program.create',
      nested(CREATE_BODY, 'utility', {
        metrics: [{ name: 'accuracy', direction: 'higher', weight: 0 }],
      }),
    )
    refuse(
      'program.create',
      nested(CREATE_BODY, 'utility', {
        metrics: [{ name: 'accuracy', direction: 'higher', weight: -1 }],
      }),
    )
    refuse(
      'program.create',
      nested(CREATE_BODY, 'utility', {
        metrics: [{ name: 'accuracy', direction: 'higher', weight: Number.POSITIVE_INFINITY }],
      }),
    )
    refuse(
      'program.create',
      nested(CREATE_BODY, 'utility', {
        metrics: [{ name: 'accuracy', direction: 'higher', weight: 1, required: 'yes' }],
      }),
    )
    refuse(
      'program.create',
      nested(CREATE_BODY, 'utility', {
        metrics: [{ name: 'accuracy', direction: 'higher', weight: 1, extra: true }],
      }),
    )
    refuse(
      'program.create',
      nested(CREATE_BODY, 'utility', {
        metrics: [{ name: '', direction: 'higher', weight: 1 }],
      }),
    )
    refuse('program.create', nested(CREATE_BODY, 'utility', { metrics: [], extra: 1 }))
    refuse('program.create', nested(CREATE_BODY, 'utility', { metrics: [{}], another: 1 }))
    refuse('program.create', nested(CREATE_BODY, 'utility', null))
  })

  it('refuses an unknown exploration level', () => {
    for (const level of ['medium', 'LOW', '', 1, null]) {
      refuse('program.create', withField(CREATE_BODY, 'exploration', level))
    }
  })

  it('refuses budget counters that are not positive integers', () => {
    for (const key of ['maxExperiments', 'maxComputeMinutes', 'maxTokens'] as const) {
      for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3', null]) {
        refuse('program.create', nested(CREATE_BODY, 'budget', withField(CREATE_BUDGET, key, value)))
      }
    }
    refuse('program.create', nested(CREATE_BODY, 'budget', { maxExperiments: 1 }))
    refuse('program.create', nested(CREATE_BODY, 'budget', withField(CREATE_BUDGET, 'extra', 1)))
  })

  it('refuses unknown top-level fields, including command-owned ids', () => {
    for (const key of ['id', 'programId', 'status', 'usage', 'createdAt', 'extra']) {
      refuse('program.create', withField(CREATE_BODY, key, 'value'))
    }
  })
})

// ---------------------------------------------------------------------------
// program pause/resume/stop/set-goal/set-methodology/set-exploration.
// ---------------------------------------------------------------------------

describe('program commands', () => {
  it('pause and resume require a valid program id', () => {
    for (const command of ['program.pause', 'program.resume'] as const) {
      refuse(command, { programId: '' })
      refuse(command, { programId: 'has space' })
      refuse(command, { programId: 42 })
      refuse(command, {})
      refuse(command, { programId: PROGRAM, reason: 'extra' })
    }
  })

  it('stop requires a non-empty reason', () => {
    for (const reason of ['', '   ', 42, null, undefined]) {
      refuse('program.stop', withField(STOP_BODY, 'reason', reason))
    }
    refuse('program.stop', { programId: PROGRAM })
  })

  it('set-goal and set-methodology require non-empty text', () => {
    refuse('program.set-goal', withField(SET_GOAL_BODY, 'goal', ''))
    refuse('program.set-goal', withField(SET_GOAL_BODY, 'goal', '   '))
    refuse('program.set-goal', { programId: PROGRAM })
    refuse('program.set-methodology', withField(SET_METHODOLOGY_BODY, 'methodology', ''))
    refuse('program.set-methodology', withField(SET_METHODOLOGY_BODY, 'methodology', '   '))
    refuse('program.set-methodology', { programId: PROGRAM })
  })

  it('set-exploration accepts only the three levels', () => {
    for (const level of ['medium', 'LOW', '', 1, null]) {
      refuse('program.set-exploration', withField(SET_EXPLORATION_BODY, 'level', level))
    }
    refuse('program.set-exploration', { programId: PROGRAM })
  })
})

// ---------------------------------------------------------------------------
// Issue commands.
// ---------------------------------------------------------------------------

describe('issue commands', () => {
  it('create requires a valid label list and non-empty text', () => {
    refuse('issue.create', withField(CREATE_ISSUE_BODY, 'labels', []))
    refuse('issue.create', withField(CREATE_ISSUE_BODY, 'labels', ['nope']))
    refuse('issue.create', withField(CREATE_ISSUE_BODY, 'labels', 'research'))
    refuse('issue.create', withField(CREATE_ISSUE_BODY, 'labels', ['research', 42]))
    refuse('issue.create', withField(CREATE_ISSUE_BODY, 'title', '   '))
    refuse('issue.create', withField(CREATE_ISSUE_BODY, 'body', ''))
    refuse('issue.create', { programId: PROGRAM })
  })

  it('claim, comment and close require valid issue ids', () => {
    for (const command of ['issue.claim', 'issue.comment', 'issue.close'] as const) {
      refuse(command, withField(VALID_BODIES[command], 'issueId', 'has space'))
      refuse(command, withField(VALID_BODIES[command], 'issueId', 42))
    }
  })

  it('comment accepts only comment and plan kinds', () => {
    for (const kind of ['note', 'PLAN', '', 1]) {
      refuse('issue.comment', withField(COMMENT_BODY, 'kind', kind))
    }
    refuse('issue.comment', withField(COMMENT_BODY, 'body', ''))
  })

  it('close accepts only the three resolutions', () => {
    for (const resolution of ['done', 'ACCEPTED', '', null]) {
      refuse('issue.close', withField(CLOSE_ISSUE_BODY, 'resolution', resolution))
    }
    refuse('issue.close', withField(CLOSE_ISSUE_BODY, 'summary', ''))
  })
})

// ---------------------------------------------------------------------------
// experiment.propose/review/close.
// ---------------------------------------------------------------------------

describe('experiment.propose', () => {
  it('requires a non-empty hypothesis and step list', () => {
    refuse('experiment.propose', nested(PROPOSE_BODY, 'plan', withField(PROPOSE_PLAN, 'hypothesis', '')))
    refuse(
      'experiment.propose',
      nested(PROPOSE_BODY, 'plan', withField(PROPOSE_PLAN, 'hypothesis', '   ')),
    )
    refuse('experiment.propose', nested(PROPOSE_BODY, 'plan', withField(PROPOSE_PLAN, 'steps', [])))
    refuse(
      'experiment.propose',
      nested(PROPOSE_BODY, 'plan', withField(PROPOSE_PLAN, 'steps', ['ok', ''])),
    )
    refuse(
      'experiment.propose',
      nested(PROPOSE_BODY, 'plan', withField(PROPOSE_PLAN, 'steps', 'one step')),
    )
  })

  it('requires a valid expected direction and rationale', () => {
    const expected = PROPOSE_PLAN.expected
    refuse(
      'experiment.propose',
      nested(
        PROPOSE_BODY,
        'plan',
        nested(PROPOSE_PLAN, 'expected', withField(expected, 'direction', 'up')),
      ),
    )
    refuse(
      'experiment.propose',
      nested(
        PROPOSE_BODY,
        'plan',
        nested(PROPOSE_PLAN, 'expected', withField(expected, 'rationale', '')),
      ),
    )
    refuse(
      'experiment.propose',
      nested(PROPOSE_BODY, 'plan', nested(PROPOSE_PLAN, 'expected', { direction: 'higher' })),
    )
    refuse(
      'experiment.propose',
      nested(
        PROPOSE_BODY,
        'plan',
        nested(PROPOSE_PLAN, 'expected', withField(expected, 'extra', true)),
      ),
    )
  })

  it('parses both environment declaration variants', () => {
    const plan = PROPOSE_PLAN
    const requirements = nested(
      PROPOSE_BODY,
      'plan',
      nested(plan, 'environment', {
        kind: 'requirements',
        requirementsFile: 'requirements.txt',
        pythonVersion: '3.12',
      }),
    )
    const parsed = accept('experiment.propose', requirements)
    assert.deepEqual(parsed.plan.environment, {
      kind: 'requirements',
      requirementsFile: 'requirements.txt',
      pythonVersion: '3.12',
    })
  })

  it('refuses malformed environment declarations', () => {
    const environment = PROPOSE_PLAN.environment
    refuse(
      'experiment.propose',
      nested(PROPOSE_BODY, 'plan', nested(PROPOSE_PLAN, 'environment', withField(environment, 'kind', 'conda'))),
    )
    refuse(
      'experiment.propose',
      nested(
        PROPOSE_BODY,
        'plan',
        nested(PROPOSE_PLAN, 'environment', withField(environment, 'lockFile', '')),
      ),
    )
    refuse(
      'experiment.propose',
      nested(
        PROPOSE_BODY,
        'plan',
        nested(PROPOSE_PLAN, 'environment', withField(environment, 'pythonVersion', '')),
      ),
    )
    refuse(
      'experiment.propose',
      nested(
        PROPOSE_BODY,
        'plan',
        nested(
          PROPOSE_PLAN,
          'environment',
          withField(environment, 'requirementsFile', 'requirements.txt'),
        ),
      ),
    )
    refuse(
      'experiment.propose',
      nested(PROPOSE_BODY, 'plan', nested(PROPOSE_PLAN, 'environment', { kind: 'uv-lock' })),
    )
    refuse('experiment.propose', nested(PROPOSE_BODY, 'plan', nested(PROPOSE_PLAN, 'environment', {})))
  })

  it('parses artifact inputs by artifactId and mountAs', () => {
    const inputs = [{ artifactId: ARTIFACT, mountAs: 'data/artifacts' }]
    const parsed = accept(
      'experiment.propose',
      nested(PROPOSE_BODY, 'plan', withField(PROPOSE_PLAN, 'inputs', inputs)),
    )
    assert.deepEqual(parsed.plan.inputs, inputs)

    const empty = accept(
      'experiment.propose',
      nested(PROPOSE_BODY, 'plan', withField(PROPOSE_PLAN, 'inputs', [])),
    )
    assert.deepEqual(empty.plan.inputs, [])
  })

  it('refuses malformed artifact inputs', () => {
    refuse(
      'experiment.propose',
      nested(PROPOSE_BODY, 'plan', withField(PROPOSE_PLAN, 'inputs', 'artifact-1')),
    )
    refuse(
      'experiment.propose',
      nested(PROPOSE_BODY, 'plan', withField(PROPOSE_PLAN, 'inputs', [{}])),
    )
    refuse(
      'experiment.propose',
      nested(
        PROPOSE_BODY,
        'plan',
        withField(PROPOSE_PLAN, 'inputs', [{ artifactId: ARTIFACT }]),
      ),
    )
    refuse(
      'experiment.propose',
      nested(
        PROPOSE_BODY,
        'plan',
        withField(PROPOSE_PLAN, 'inputs', [{ artifactId: ARTIFACT, mountAs: '' }]),
      ),
    )
    refuse(
      'experiment.propose',
      nested(
        PROPOSE_BODY,
        'plan',
        withField(PROPOSE_PLAN, 'inputs', [{ artifactId: '', mountAs: 'data' }]),
      ),
    )
    refuse(
      'experiment.propose',
      nested(
        PROPOSE_BODY,
        'plan',
        withField(PROPOSE_PLAN, 'inputs', [
          { artifactId: ARTIFACT, mountAs: 'data', extra: true },
        ]),
      ),
    )
  })

  it('refuses unknown plan fields and a malformed plan', () => {
    refuse('experiment.propose', nested(PROPOSE_BODY, 'plan', withField(PROPOSE_PLAN, 'extra', 1)))
    refuse('experiment.propose', nested(PROPOSE_BODY, 'plan', {}))
    refuse('experiment.propose', nested(PROPOSE_BODY, 'plan', 'plan'))
    refuse('experiment.propose', { programId: PROGRAM, issueId: ISSUE })
  })
})

describe('experiment.review and experiment.close', () => {
  it('review accepts only the three verdicts', () => {
    for (const verdict of ['reject', 'APPROVE', '', 1]) {
      refuse('experiment.review', withField(REVIEW_BODY, 'verdict', verdict))
    }
    refuse('experiment.review', withField(REVIEW_BODY, 'body', ''))
  })

  it('review and close require a valid experiment id', () => {
    for (const command of ['experiment.review', 'experiment.close'] as const) {
      refuse(command, withField(VALID_BODIES[command], 'experimentId', 'has space'))
      refuse(command, withField(VALID_BODIES[command], 'experimentId', 7))
    }
  })

  it('close requires a non-empty reason', () => {
    for (const reason of ['', '   ', 42, null]) {
      refuse('experiment.close', withField(VALID_BODIES['experiment.close'], 'reason', reason))
    }
  })
})

// ---------------------------------------------------------------------------
// ci.request and ticket.submit.
// ---------------------------------------------------------------------------

describe('ci.request', () => {
  it('requires both ids', () => {
    refuse('ci.request', { programId: PROGRAM })
    refuse('ci.request', { experimentId: EXPERIMENT })
    refuse('ci.request', { programId: '', experimentId: EXPERIMENT })
    refuse('ci.request', { programId: PROGRAM, experimentId: 'has space' })
  })
})

describe('ticket.submit', () => {
  it('accepts 40- and 64-character commit shas', () => {
    for (const head of [HEAD, OTHER_HEAD]) {
      const parsed = accept('ticket.submit', withField(SUBMIT_BODY, 'head', head))
      assert.equal(parsed.head, head)
    }
  })

  it('refuses short, long and non-hex commit shas', () => {
    for (const head of ['a'.repeat(39), 'a'.repeat(65), 'g'.repeat(40), '', 42, null]) {
      refuse('ticket.submit', withField(SUBMIT_BODY, 'head', head))
    }
  })

  it('refuses malformed environments', () => {
    refuse(
      'ticket.submit',
      nested(SUBMIT_BODY, 'environment', withField(ENVIRONMENT_BODY, 'kind', 'conda')),
    )
    refuse(
      'ticket.submit',
      nested(SUBMIT_BODY, 'environment', withField(ENVIRONMENT_BODY, 'requirementsFile', '')),
    )
    refuse(
      'ticket.submit',
      nested(SUBMIT_BODY, 'environment', withField(ENVIRONMENT_BODY, 'pythonVersion', '')),
    )
    refuse(
      'ticket.submit',
      nested(SUBMIT_BODY, 'environment', withField(ENVIRONMENT_BODY, 'lockFile', 'uv.lock')),
    )
    refuse('ticket.submit', nested(SUBMIT_BODY, 'environment', { kind: 'requirements' }))
  })

  it('refuses a body without head or environment', () => {
    refuse('ticket.submit', {})
    refuse('ticket.submit', { head: HEAD })
    refuse('ticket.submit', { environment: ENVIRONMENT_BODY })
  })
})
