import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { DomainError, Result } from '../src/types/errors.ts'
import {
  artifactId,
  auditId,
  branchName,
  ciRunId,
  commentId,
  commitSha,
  durationMs,
  experimentId,
  explorationLevel,
  implementerSessionId,
  isoTimestamp,
  issueId,
  metricDirection,
  metricName,
  nonEmptyString,
  nonNegativeNumber,
  operatorSessionId,
  positiveInt,
  positiveNumber,
  programId,
  requestId,
  researcherSessionId,
  reviewId,
  routerSessionId,
  schema,
  ticketId,
  version,
  watchdogSessionId,
} from '../src/parsers.ts'

type AnyParser = (input: unknown) => Result<unknown, DomainError>

/** Assert that a parser accepted its input and returned the same value. */
function accepts(result: Result<unknown, DomainError>, expected: unknown): void {
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.value, expected)
}

/** Assert that a parser refused its input with a parser code and a non-empty message. */
function refuses(result: Result<unknown, DomainError>): void {
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'invalid-input')
    assert.ok(result.error.message.length > 0)
  }
}

const LONG_ID = 'a'.repeat(201)
const MAX_METRIC_NAME = 'm'.repeat(64)
const MAX_BRANCH = 'b'.repeat(255)
const NON_STRING_INPUTS: readonly unknown[] = [undefined, null, 42, {}, []]

describe('branded entity ids', () => {
  const parsers: readonly (readonly [string, AnyParser])[] = [
    ['programId', programId],
    ['issueId', issueId],
    ['experimentId', experimentId],
    ['ciRunId', ciRunId],
    ['commentId', commentId],
    ['reviewId', reviewId],
    ['artifactId', artifactId],
    ['auditId', auditId],
    ['ticketId', ticketId],
    ['requestId', requestId],
  ]

  for (const [name, parse] of parsers) {
    it(`${name} accepts printable id tokens`, () => {
      accepts(parse('prg_01JABCDEF'), 'prg_01JABCDEF')
      accepts(parse('program:42'), 'program:42')
      accepts(parse('a.b-c_d'), 'a.b-c_d')
    })

    it(`${name} refuses non-strings, empty strings, whitespace and oversized values`, () => {
      for (const input of [...NON_STRING_INPUTS, '', ' ', ' leading', 'trailing ', 'has space', 'a/b', LONG_ID]) {
        refuses(parse(input))
      }
    })
  }

  it('session ids are parsed with the same token rules', () => {
    accepts(researcherSessionId('sess-researcher'), 'sess-researcher')
    accepts(implementerSessionId('sess-implementer'), 'sess-implementer')
    accepts(operatorSessionId('sess-operator'), 'sess-operator')
    accepts(watchdogSessionId('sess-watchdog'), 'sess-watchdog')
    accepts(routerSessionId('sess-router'), 'sess-router')
    for (const parse of [
      researcherSessionId,
      implementerSessionId,
      operatorSessionId,
      watchdogSessionId,
      routerSessionId,
    ]) {
      refuses(parse(''))
      refuses(parse(7))
    }
  })
})

describe('commitSha', () => {
  it('accepts 40 and 64 hexadecimal characters in either case', () => {
    accepts(commitSha('a'.repeat(40)), 'a'.repeat(40))
    accepts(commitSha('A'.repeat(64)), 'A'.repeat(64))
    accepts(commitSha('0123456789abcdef'.repeat(4)), '0123456789abcdef'.repeat(4))
  })

  it('refuses short, long and non-hex values', () => {
    for (const input of ['a'.repeat(39), 'a'.repeat(65), 'g'.repeat(40), 'a'.repeat(40) + '\n', '', 42, null]) {
      refuses(commitSha(input))
    }
  })
})

describe('branchName', () => {
  it('accepts safe git reference names', () => {
    for (const input of ['main', 'feat/phase-1-runtime', 'exp/program/issue-1', 'sota-2026.11', MAX_BRANCH]) {
      accepts(branchName(input), input)
    }
  })

  it('refuses names git would reject', () => {
    for (const input of [
      '',
      'has space',
      '/leading',
      'trailing/',
      'trailing.',
      'trailing.lock',
      '.hidden',
      'a..b',
      'a//b',
      'a@{b}',
      'a~b',
      'a^b',
      'a:b',
      'a?b',
      'a*b',
      'a[b',
      'a\\b',
      'b'.repeat(256),
      42,
      null,
    ]) {
      refuses(branchName(input))
    }
  })
})

describe('isoTimestamp', () => {
  it('accepts RFC 3339 timestamps', () => {
    for (const input of [
      '2026-11-02T04:08:22Z',
      '2026-11-02t04:08:22z',
      '2026-11-02T04:08:22+08:00',
      '2026-11-02T04:08:22.123456-05:30',
      '2024-02-29T23:59:59Z',
    ]) {
      accepts(isoTimestamp(input), input)
    }
  })

  it('refuses malformed or impossible timestamps', () => {
    for (const input of [
      '2026-11-02',
      '2026-11-02T04:08:22',
      '2026-11-02 04:08:22Z',
      '2026-13-02T04:08:22Z',
      '2026-00-02T04:08:22Z',
      '2023-02-29T00:00:00Z',
      '2026-11-31T00:00:00Z',
      '2026-11-02T24:00:00Z',
      '2026-11-02T04:60:00Z',
      '2026-11-02T04:08:61Z',
      '2026-11-02T04:08:22+0800',
      '2026-11-02T04:08:22+24:00',
      42,
      null,
    ]) {
      refuses(isoTimestamp(input))
    }
  })
})

describe('version', () => {
  it('accepts non-negative integers', () => {
    for (const input of [0, 1, 42, -0]) accepts(version(input), input)
  })

  it('refuses negative, fractional and non-numeric values', () => {
    for (const input of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', null, undefined]) {
      refuses(version(input))
    }
  })
})

describe('metricName', () => {
  it('accepts 1-64 printable characters', () => {
    for (const input of ['accuracy', 'latency_ms', MAX_METRIC_NAME]) accepts(metricName(input), input)
  })

  it('refuses empty, whitespace-only, oversized and non-string values', () => {
    for (const input of ['', '   ', MAX_METRIC_NAME + 'x', 'a\nb', 42, null, undefined]) refuses(metricName(input))
  })
})

describe('nonEmptyString', () => {
  it('accepts strings with non-whitespace content', () => {
    for (const input of ['a', ' a ', 'multi\nline']) accepts(nonEmptyString(input), input)
  })

  it('refuses empty, whitespace-only and non-string values', () => {
    for (const input of ['', '   ', 42, null, undefined, {}]) refuses(nonEmptyString(input))
  })
})

describe('numeric refinements', () => {
  it('positiveInt accepts positive integers only', () => {
    for (const input of [1, 42]) accepts(positiveInt(input), input)
    for (const input of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '2', null]) refuses(positiveInt(input))
  })

  it('positiveNumber accepts positive finite numbers only', () => {
    for (const input of [0.5, 1, 42.25]) accepts(positiveNumber(input), input)
    for (const input of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1', null]) refuses(positiveNumber(input))
  })

  it('nonNegativeNumber accepts zero and positive finite numbers only', () => {
    for (const input of [0, 0.5, 42]) accepts(nonNegativeNumber(input), input)
    for (const input of [-1, Number.NaN, Number.NEGATIVE_INFINITY, '0', null]) refuses(nonNegativeNumber(input))
  })

  it('durationMs accepts non-negative finite milliseconds only', () => {
    for (const input of [0, 12.5, 60_000]) accepts(durationMs(input), input)
    for (const input of [-1, Number.NaN, Number.POSITIVE_INFINITY, '10', null]) refuses(durationMs(input))
  })
})

describe('enumerations', () => {
  it('metricDirection accepts higher/lower only', () => {
    for (const input of ['higher', 'lower']) accepts(metricDirection(input), input)
    for (const input of ['max', 'min', '', 1, null]) refuses(metricDirection(input))
  })

  it('explorationLevel accepts low/normal/high only', () => {
    for (const input of ['low', 'normal', 'high']) accepts(explorationLevel(input), input)
    for (const input of ['medium', 'LOW', '', 1, null]) refuses(explorationLevel(input))
  })
})

describe('schema', () => {
  const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

  it('constructs from a validator plus JSON Schema and parses through it', () => {
    const built = schema<string>({ validator: isString, jsonSchema: { type: 'string', minLength: 1 } })
    assert.equal(built.ok, true)
    if (!built.ok) return
    assert.deepEqual(built.value.toJsonSchema(), { type: 'string', minLength: 1 })
    accepts(built.value.parse('ok'), 'ok')
    refuses(built.value.parse(''))
    refuses(built.value.parse(42))
  })

  it('constructs from a bare validator function with an empty JSON Schema', () => {
    const built = schema<string>(isString)
    assert.equal(built.ok, true)
    if (!built.ok) return
    assert.deepEqual(built.value.toJsonSchema(), {})
    accepts(built.value.parse('ok'), 'ok')
    refuses(built.value.parse(7))
  })

  it('accepts and returns an already-built schema unchanged', () => {
    const built = schema<number>({
      validator: (value: unknown): value is number => typeof value === 'number',
      jsonSchema: { type: 'number' },
    })
    assert.equal(built.ok, true)
    if (!built.ok) return
    const again = schema<number>(built.value)
    assert.equal(again.ok, true)
    if (!again.ok) return
    assert.equal(again.value, built.value)
    assert.deepEqual(again.value.toJsonSchema(), { type: 'number' })
  })

  it('refuses unknown shapes', () => {
    for (const input of [undefined, null, 42, 'schema', {}, { validator: 'nope', jsonSchema: {} }, { parse: 1, toJsonSchema: 2 }]) {
      refuses(schema(input))
    }
  })
})
