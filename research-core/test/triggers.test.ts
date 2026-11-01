/**
 * Runtime evidence for the trigger mapper: the action -> kind table, thread selection,
 * human classification, stale subjects, the optional ticket id and the refusal/no-draft
 * rule.
 *
 * `research-core` is still a declaration-only blueprint, so nominal ids, principals,
 * aggregate records and the snapshot are fixtures forged from plain values. `forged` is
 * the only assertion in this file and it is confined to fixtures.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { ProgramSnapshot } from '../src/types/api.js'
import type { ArtifactRef } from '../src/types/artifacts.js'
import type { AuditAction, AuditEntryOf, SubjectForAction } from '../src/types/audit.js'
import type {
  HostPrincipal,
  ImplementerPrincipal,
  OperatorPrincipal,
  Principal,
  ResearcherPrincipal,
  WatchdogPrincipal,
} from '../src/types/actors.js'
import type { Experiment } from '../src/types/experiment.js'
import type {
  ArtifactId,
  CIRunId,
  ExperimentId,
  IsoTimestamp,
  IssueId,
  ProgramId,
  TicketId,
} from '../src/types/ids.js'
import type { Issue } from '../src/types/issue.js'
import type { CIRecord } from '../src/types/metrics.js'
import type { Program } from '../src/types/program.js'
import type {
  ResearchThreadRef,
  ResearchTriggerDraft,
  ResearchTriggerKind,
  TriggerReportFor,
} from '../src/types/triggers.js'
import { createTriggerFactory } from '../src/runtime/triggers.js'

/** Stand-in for a value the Host mints through its factory/hydration boundary. */
function forged<T>(value: unknown): T {
  return value as T
}

const AT = forged<IsoTimestamp>('2026-11-02T00:00:00.000Z')
const PROGRAM_ID = forged<ProgramId>('program-1')
const OTHER_PROGRAM = forged<ProgramId>('program-9')
const ISSUE_ID = forged<IssueId>('issue-1')
const EXPERIMENT_ID = forged<ExperimentId>('experiment-1')
const CI_RUN_ID = forged<CIRunId>('ci-run-1')
const ARTIFACT_ID = forged<ArtifactId>('artifact-1')
const TICKET_ID = forged<TicketId>('ticket-1')

const operator = forged<OperatorPrincipal>({ kind: 'operator', sessionId: 'operator-session' })
const researcher = forged<ResearcherPrincipal>({ kind: 'researcher', sessionId: 'researcher-session' })
const implementer = forged<ImplementerPrincipal>({
  kind: 'implementer',
  sessionId: 'implementer-session',
  ticketId: TICKET_ID,
})
const host = forged<HostPrincipal>({ kind: 'host' })
const watchdog = forged<WatchdogPrincipal>({ kind: 'watchdog', sessionId: 'watchdog-session' })

const PROGRAM_THREAD: ResearchThreadRef = { kind: 'program', id: 'research:program-1' }
const ISSUE_THREAD: ResearchThreadRef = { kind: 'issue', id: 'research:program-1:issue:issue-1' }
const EXPERIMENT_THREAD: ResearchThreadRef = {
  kind: 'experiment',
  id: 'research:program-1:experiment:experiment-1',
}

const triggers = createTriggerFactory()

function issue(options: { programId?: ProgramId } = {}): Issue {
  return forged<Issue>({
    id: ISSUE_ID,
    programId: options.programId ?? PROGRAM_ID,
    status: 'open',
  })
}

function experiment(options: { programId?: ProgramId; ticketId?: TicketId } = {}): Experiment {
  const base = {
    id: EXPERIMENT_ID,
    programId: options.programId ?? PROGRAM_ID,
    issueId: ISSUE_ID,
    status: 'ready',
  }
  return options.ticketId === undefined
    ? forged<Experiment>(base)
    : forged<Experiment>({ ...base, ticketId: options.ticketId })
}

function ciRecord(options: { programId?: ProgramId; experimentId?: ExperimentId } = {}): CIRecord {
  return forged<CIRecord>({
    id: CI_RUN_ID,
    programId: options.programId ?? PROGRAM_ID,
    experimentId: options.experimentId ?? EXPERIMENT_ID,
    status: 'requested',
    commit: '0123456789abcdef0123456789abcdef01234567',
    requestedBy: 'researcher-session',
    requestedAt: AT,
  })
}

function artifact(options: { programId?: ProgramId; experimentId?: ExperimentId } = {}): ArtifactRef {
  return forged<ArtifactRef>({
    id: ARTIFACT_ID,
    programId: options.programId ?? PROGRAM_ID,
    experimentId: options.experimentId ?? EXPERIMENT_ID,
  })
}

interface SnapshotOptions {
  readonly programId?: ProgramId
  readonly issues?: readonly Issue[]
  readonly experiments?: readonly Experiment[]
  readonly ciRecords?: readonly CIRecord[]
  readonly artifacts?: readonly ArtifactRef[]
}

function snapshot(options: SnapshotOptions = {}): ProgramSnapshot {
  return forged<ProgramSnapshot>({
    program: forged<Program>({ id: options.programId ?? PROGRAM_ID, status: 'running' }),
    issues: options.issues ?? [issue()],
    comments: [],
    experiments: options.experiments ?? [experiment()],
    ciRecords: options.ciRecords ?? [ciRecord()],
    artifacts: options.artifacts ?? [artifact()],
    attention: [],
    audit: [],
  })
}

function entry<A extends AuditAction>(
  action: A,
  subject: SubjectForAction[A],
  actor: Principal,
  programId: ProgramId = PROGRAM_ID,
): AuditEntryOf<A> {
  return forged<AuditEntryOf<A>>({
    id: 'audit-1',
    at: AT,
    programId,
    action,
    subject,
    actor,
    detail: {},
  })
}

function draftOf<A extends AuditAction>(report: TriggerReportFor<A>): ResearchTriggerDraft {
  const draft = report.draft
  if (draft === null) throw new Error(`expected a draft for ${report.action}`)
  return draft
}

/** Every action literal, so the kind table below is checked in full. */
const ALL_ACTIONS: readonly AuditAction[] = [
  'program.created',
  'program.paused',
  'program.budget-paused',
  'program.resumed',
  'program.stopped',
  'program.goal-changed',
  'program.methodology-changed',
  'program.exploration-changed',
  'program.completed',
  'usage.recorded',
  'issue.created',
  'issue.claimed',
  'issue.commented',
  'issue.closed',
  'experiment.proposed',
  'experiment.opened',
  'experiment.revised',
  'experiment.ready',
  'experiment.reviewed',
  'experiment.cancelled',
  'experiment.closed',
  'ci.requested',
  'ci.started',
  'ci.passed',
  'ci.failed',
  'artifact.stored',
  'attention.raised',
  'command.refused',
]

const SUBJECT_FOR: { readonly [A in AuditAction]: SubjectForAction[A] } = {
  'program.created': { kind: 'program', id: PROGRAM_ID },
  'program.paused': { kind: 'program', id: PROGRAM_ID },
  'program.budget-paused': { kind: 'program', id: PROGRAM_ID },
  'program.resumed': { kind: 'program', id: PROGRAM_ID },
  'program.stopped': { kind: 'program', id: PROGRAM_ID },
  'program.goal-changed': { kind: 'program', id: PROGRAM_ID },
  'program.methodology-changed': { kind: 'program', id: PROGRAM_ID },
  'program.exploration-changed': { kind: 'program', id: PROGRAM_ID },
  'program.completed': { kind: 'program', id: PROGRAM_ID },
  'usage.recorded': { kind: 'program', id: PROGRAM_ID },
  'issue.created': { kind: 'issue', id: ISSUE_ID },
  'issue.claimed': { kind: 'issue', id: ISSUE_ID },
  'issue.commented': { kind: 'issue', id: ISSUE_ID },
  'issue.closed': { kind: 'issue', id: ISSUE_ID },
  'experiment.proposed': { kind: 'issue', id: ISSUE_ID },
  'experiment.opened': { kind: 'experiment', id: EXPERIMENT_ID },
  'experiment.revised': { kind: 'experiment', id: EXPERIMENT_ID },
  'experiment.reviewed': { kind: 'experiment', id: EXPERIMENT_ID },
  'experiment.ready': { kind: 'experiment', id: EXPERIMENT_ID },
  'experiment.cancelled': { kind: 'experiment', id: EXPERIMENT_ID },
  'experiment.closed': { kind: 'experiment', id: EXPERIMENT_ID },
  'ci.requested': { kind: 'ci-run', id: CI_RUN_ID },
  'ci.started': { kind: 'ci-run', id: CI_RUN_ID },
  'ci.passed': { kind: 'ci-run', id: CI_RUN_ID },
  'ci.failed': { kind: 'ci-run', id: CI_RUN_ID },
  'artifact.stored': { kind: 'artifact', id: ARTIFACT_ID },
  'attention.raised': { kind: 'program', id: PROGRAM_ID },
  'command.refused': { kind: 'program', id: PROGRAM_ID },
}

const ACTOR_FOR: { readonly [A in AuditAction]: Principal } = {
  'program.created': operator,
  'program.paused': operator,
  'program.budget-paused': host,
  'program.resumed': operator,
  'program.stopped': operator,
  'program.goal-changed': operator,
  'program.methodology-changed': operator,
  'program.exploration-changed': operator,
  'program.completed': host,
  'usage.recorded': host,
  'issue.created': operator,
  'issue.claimed': researcher,
  'issue.commented': researcher,
  'issue.closed': researcher,
  'experiment.proposed': researcher,
  'experiment.opened': host,
  'experiment.revised': implementer,
  'experiment.ready': implementer,
  'experiment.reviewed': researcher,
  'experiment.cancelled': host,
  'experiment.closed': researcher,
  'ci.requested': researcher,
  'ci.started': host,
  'ci.passed': host,
  'ci.failed': host,
  'artifact.stored': host,
  'attention.raised': watchdog,
  'command.refused': host,
}

const EXPECTED_KIND_FOR: { readonly [A in AuditAction]: ResearchTriggerKind | null } = {
  'program.created': 'program-created',
  'program.paused': 'program-paused',
  'program.budget-paused': 'program-budget-paused',
  'program.resumed': 'program-resumed',
  'program.stopped': 'program-stopped',
  'program.goal-changed': 'program-goal-changed',
  'program.methodology-changed': 'program-methodology-changed',
  'program.exploration-changed': 'program-exploration-changed',
  'program.completed': 'program-completed',
  'usage.recorded': 'usage-recorded',
  'issue.created': 'issue-created',
  'issue.claimed': 'issue-claimed',
  'issue.commented': 'issue-commented',
  'issue.closed': 'issue-closed',
  'experiment.proposed': 'experiment-proposed',
  'experiment.opened': 'experiment-opened',
  'experiment.revised': 'experiment-revised',
  'experiment.ready': 'experiment-ready',
  'experiment.reviewed': 'experiment-reviewed',
  'experiment.cancelled': 'experiment-cancelled',
  'experiment.closed': 'experiment-closed',
  'ci.requested': 'ci-requested',
  'ci.started': 'ci-started',
  'ci.passed': 'ci-passed',
  'ci.failed': 'ci-failed',
  'artifact.stored': 'artifact-stored',
  'attention.raised': 'attention-raised',
  'command.refused': null,
}

test('every audit action reports its mapped trigger kind', () => {
  const fixture = snapshot()
  for (const action of ALL_ACTIONS) {
    const report = triggers.make(entry(action, SUBJECT_FOR[action], ACTOR_FOR[action]), fixture)
    assert.equal(report.action, action)
    assert.equal(report.kind, EXPECTED_KIND_FOR[action], action)

    if (action === 'command.refused') {
      assert.equal(report.draft, null)
    } else {
      assert.equal(draftOf(report).kind, EXPECTED_KIND_FOR[action], action)
    }
  }
})

test('program facts stay on the program thread and copy their actor and timestamp', () => {
  const paused = entry('program.paused', { kind: 'program', id: PROGRAM_ID }, operator)
  const report = triggers.make(paused, snapshot())

  assert.equal(report.action, 'program.paused')
  assert.equal(report.kind, 'program-paused')
  const draft = draftOf(report)
  assert.equal(draft.kind, 'program-paused')
  assert.equal(draft.programId, PROGRAM_ID)
  assert.deepEqual(draft.threads, [PROGRAM_THREAD])
  assert.equal(draft.actor, operator)
  assert.equal(draft.human, true)
  assert.equal(draft.at, AT)
  assert.equal(draft.text, 'program paused')
  assert.equal(draft.ticketId, undefined)
  assert.deepEqual(draft.meta, {
    action: 'program.paused',
    subjectKind: 'program',
    subjectId: 'program-1',
  })

  // Host facts are automated, not human.
  const budget = triggers.make(
    entry('program.budget-paused', { kind: 'program', id: PROGRAM_ID }, host),
    snapshot(),
  )
  assert.equal(budget.kind, 'program-budget-paused')
  assert.equal(draftOf(budget).human, false)
  assert.equal(draftOf(budget).text, 'program paused for budget')
})

test('issue facts also go to the issue thread and researcher facts are human', () => {
  const claimed = entry('issue.claimed', { kind: 'issue', id: ISSUE_ID }, researcher)
  const report = triggers.make(claimed, snapshot())

  assert.equal(report.kind, 'issue-claimed')
  const draft = draftOf(report)
  assert.equal(draft.kind, 'issue-claimed')
  assert.deepEqual(draft.threads, [PROGRAM_THREAD, ISSUE_THREAD])
  assert.equal(draft.actor, researcher)
  assert.equal(draft.human, true)
  assert.equal(draft.text, 'issue claimed')
  assert.deepEqual(draft.meta, {
    action: 'issue.claimed',
    subjectKind: 'issue',
    subjectId: 'issue-1',
  })

  // A proposed Experiment is audited against its Issue, so it starts on the Issue Thread.
  const proposed = triggers.make(
    entry('experiment.proposed', { kind: 'issue', id: ISSUE_ID }, researcher),
    snapshot(),
  )
  assert.equal(proposed.kind, 'experiment-proposed')
  assert.deepEqual(draftOf(proposed).threads, [PROGRAM_THREAD, ISSUE_THREAD])
  assert.equal(draftOf(proposed).human, true)
})

test('experiment facts go to the experiment thread and implementer facts are not human', () => {
  const report = triggers.make(
    entry('experiment.ready', { kind: 'experiment', id: EXPERIMENT_ID }, implementer),
    snapshot(),
  )

  assert.equal(report.kind, 'experiment-ready')
  const draft = draftOf(report)
  assert.equal(draft.kind, 'experiment-ready')
  assert.deepEqual(draft.threads, [PROGRAM_THREAD, EXPERIMENT_THREAD])
  assert.equal(draft.actor, implementer)
  assert.equal(draft.human, false)
  assert.equal(draft.text, 'experiment ready for review')
  assert.equal(draft.ticketId, undefined)
  assert.deepEqual(draft.meta, {
    action: 'experiment.ready',
    subjectKind: 'experiment',
    subjectId: 'experiment-1',
  })
})

test('CI facts resolve their experiment and use no ci-run thread ref', () => {
  const report = triggers.make(
    entry('ci.passed', { kind: 'ci-run', id: CI_RUN_ID }, host),
    snapshot(),
  )

  assert.equal(report.kind, 'ci-passed')
  const draft = draftOf(report)
  assert.equal(draft.kind, 'ci-passed')
  // `ResearchThreadRef` has no `ci-run` variant: the run is reported on the Program and
  // its Experiment Thread. The run id stays in `meta.subjectId`.
  assert.deepEqual(draft.threads, [PROGRAM_THREAD, EXPERIMENT_THREAD])
  assert.equal(draft.human, false)
  assert.equal(draft.text, 'CI passed')
  assert.deepEqual(draft.meta, {
    action: 'ci.passed',
    subjectKind: 'ci-run',
    subjectId: 'ci-run-1',
  })
})

test('artifact facts resolve their experiment thread and host facts are not human', () => {
  const report = triggers.make(
    entry('artifact.stored', { kind: 'artifact', id: ARTIFACT_ID }, host),
    snapshot(),
  )

  assert.equal(report.kind, 'artifact-stored')
  const draft = draftOf(report)
  assert.deepEqual(draft.threads, [PROGRAM_THREAD, EXPERIMENT_THREAD])
  assert.equal(draft.human, false)
  assert.equal(draft.text, 'artifact stored')
  assert.equal(draft.meta.subjectKind, 'artifact')
  assert.equal(draft.meta.subjectId, 'artifact-1')
})

test('a ticket id is forwarded only when the snapshot experiment carries one', () => {
  const ready = entry('experiment.ready', { kind: 'experiment', id: EXPERIMENT_ID }, implementer)

  const withoutTicket = triggers.make(ready, snapshot())
  assert.equal(draftOf(withoutTicket).ticketId, undefined)

  const withTicket = snapshot({ experiments: [experiment({ ticketId: TICKET_ID })] })
  assert.equal(draftOf(triggers.make(ready, withTicket)).ticketId, TICKET_ID)

  // A CI fact resolves the same Experiment record, so it observes the same optional field.
  const ci = triggers.make(entry('ci.passed', { kind: 'ci-run', id: CI_RUN_ID }, host), withTicket)
  assert.equal(draftOf(ci).ticketId, TICKET_ID)
})

test('attention.raised is a program wake-up and watchdog facts are not human', () => {
  const report = triggers.make(
    entry('attention.raised', { kind: 'program', id: PROGRAM_ID }, watchdog),
    snapshot(),
  )

  assert.equal(report.kind, 'attention-raised')
  const draft = draftOf(report)
  assert.equal(draft.kind, 'attention-raised')
  assert.deepEqual(draft.threads, [PROGRAM_THREAD])
  assert.equal(draft.actor, watchdog)
  assert.equal(draft.human, false)
  assert.equal(draft.text, 'attention raised')
  assert.deepEqual(draft.meta, {
    action: 'attention.raised',
    subjectKind: 'program',
    subjectId: 'program-1',
  })

  // A Host-raised attention is still a program-level, non-human fact.
  const hostReport = triggers.make(
    entry('attention.raised', { kind: 'program', id: PROGRAM_ID }, host),
    snapshot(),
  )
  assert.equal(draftOf(hostReport).human, false)
})

test('command.refused is a valid report with no wake-up draft', () => {
  const report = triggers.make(
    entry('command.refused', { kind: 'program', id: PROGRAM_ID }, researcher),
    snapshot(),
  )

  assert.equal(report.action, 'command.refused')
  assert.equal(report.kind, null)
  assert.equal(report.draft, null)
})

test('a subject missing from the snapshot falls back to a stale program draft', () => {
  const empty = snapshot({ issues: [], experiments: [], ciRecords: [], artifacts: [] })

  const issueReport = triggers.make(
    entry('issue.closed', { kind: 'issue', id: ISSUE_ID }, researcher),
    empty,
  )
  assert.equal(issueReport.kind, 'issue-closed')
  const issueDraft = draftOf(issueReport)
  assert.equal(issueDraft.kind, 'issue-closed')
  assert.deepEqual(issueDraft.threads, [PROGRAM_THREAD])
  assert.equal(issueDraft.meta.stale, true)
  assert.equal(issueDraft.meta.subjectKind, 'issue')
  assert.equal(issueDraft.meta.subjectId, 'issue-1')

  const experimentReport = triggers.make(
    entry('experiment.closed', { kind: 'experiment', id: EXPERIMENT_ID }, researcher),
    empty,
  )
  assert.equal(experimentReport.kind, 'experiment-closed')
  const experimentDraft = draftOf(experimentReport)
  assert.deepEqual(experimentDraft.threads, [PROGRAM_THREAD])
  assert.equal(experimentDraft.meta.stale, true)
  assert.equal(experimentDraft.meta.subjectId, 'experiment-1')

  const ciReport = triggers.make(
    entry('ci.failed', { kind: 'ci-run', id: CI_RUN_ID }, host),
    empty,
  )
  assert.equal(ciReport.kind, 'ci-failed')
  const ciDraft = draftOf(ciReport)
  assert.deepEqual(ciDraft.threads, [PROGRAM_THREAD])
  assert.equal(ciDraft.meta.stale, true)
  assert.equal(ciDraft.meta.subjectId, 'ci-run-1')

  // A CI record that points at an Experiment absent from the snapshot is stale too.
  const orphanRun = snapshot({ experiments: [], ciRecords: [ciRecord()] })
  const orphanDraft = draftOf(
    triggers.make(entry('ci.failed', { kind: 'ci-run', id: CI_RUN_ID }, host), orphanRun),
  )
  assert.deepEqual(orphanDraft.threads, [PROGRAM_THREAD])
  assert.equal(orphanDraft.meta.stale, true)
})

test('a snapshot for another program is stale and keeps the entry program thread', () => {
  const report = triggers.make(
    entry('program.resumed', { kind: 'program', id: OTHER_PROGRAM }, operator, OTHER_PROGRAM),
    snapshot(),
  )

  assert.equal(report.kind, 'program-resumed')
  const draft = draftOf(report)
  assert.equal(draft.programId, OTHER_PROGRAM)
  assert.deepEqual(draft.threads, [{ kind: 'program', id: 'research:program-9' }])
  assert.equal(draft.meta.stale, true)
})

test('the mapper is deterministic and its text carries no timestamp', () => {
  const paused = entry('program.paused', { kind: 'program', id: PROGRAM_ID }, operator)
  const first = triggers.make(paused, snapshot())
  const second = triggers.make(paused, snapshot())

  assert.deepEqual(first, second)
  assert.equal(draftOf(first).text.includes(AT), false)
})
