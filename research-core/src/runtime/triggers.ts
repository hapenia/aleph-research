/**
 * Audit facts to trigger drafts: the research-core half of the prototype Trigger seam.
 *
 * Every audit action maps to exactly one trigger kind through the compile-time
 * `TriggerKindForAction` table. This module turns each entry into a `TriggerReportFor<A>`
 * whose `kind` is that literal, and (except for a refused command) into a draft on the
 * threads the fact belongs to:
 *
 * - every fact stays on the Program Thread `research:<programId>`;
 * - an Issue fact also goes to `research:<programId>:issue:<issueId>`;
 * - an Experiment fact also goes to
 *   `research:<programId>:experiment:<experimentId>`;
 * - a CI or Artifact fact is resolved to its Experiment and also goes to that Experiment
 *   Thread (`ResearchThreadRef` has no separate ci-run or artifact thread kind);
 * - `attention.raised` stays on the Program Thread;
 * - `command.refused` produces no draft at all, because a refusal must not wake anyone.
 *
 * The entry is validated against the `ProgramSnapshot` before a specific thread is used.
 * A subject that is not in the snapshot is not an exception: the draft falls back to the
 * Program Thread with `meta.stale === true`, so delivery can decide to drop it while the
 * report still matches the action/kind table.
 *
 * The mapper is data-driven and total: `BUILD_REPORT` and `ACTION_TEXT` are mapped over
 * every `AuditAction`, and the contextual return type pins each builder's kind literal to
 * `TriggerKindForAction`. Adding an action therefore forces a kind, text and draft
 * decision. This module never asserts a type, reads a clock or parses JSON.
 */
import type { ProgramSnapshot } from '../types/api.js'
import type { AuditAction, AuditEntry, AuditEntryOf } from '../types/audit.js'
import type { Principal } from '../types/actors.js'
import type { Experiment } from '../types/experiment.js'
import type { ExperimentId, NonEmptyArray, ProgramId, TicketId } from '../types/ids.js'
import type {
  ResearchThreadRef,
  ResearchTriggerDraft,
  ResearchTriggerKind,
  TriggerFactory,
  TriggerReportFor,
} from '../types/triggers.js'

/**
 * The text of every action: one deterministic sentence with no timestamp and no id.
 * Structured facts (action and subject ids) live in the draft `meta`, not in the prose.
 */
const ACTION_TEXT: { readonly [A in AuditAction]: string } = {
  'program.created': 'program created',
  'program.paused': 'program paused',
  'program.budget-paused': 'program paused for budget',
  'program.resumed': 'program resumed',
  'program.stopped': 'program stopped',
  'program.goal-changed': 'program goal changed',
  'program.methodology-changed': 'program methodology changed',
  'program.exploration-changed': 'program exploration changed',
  'program.completed': 'program completed',
  'usage.recorded': 'program usage recorded',
  'issue.created': 'issue created',
  'issue.claimed': 'issue claimed',
  'issue.commented': 'issue commented',
  'issue.closed': 'issue closed',
  'experiment.proposed': 'experiment proposed',
  'experiment.opened': 'experiment opened',
  'experiment.revised': 'experiment revised',
  'experiment.reviewed': 'experiment reviewed',
  'experiment.ready': 'experiment ready for review',
  'experiment.cancelled': 'experiment cancelled',
  'experiment.closed': 'experiment closed',
  'ci.requested': 'CI requested',
  'ci.started': 'CI started',
  'ci.passed': 'CI passed',
  'ci.failed': 'CI failed',
  'artifact.stored': 'artifact stored',
  'attention.raised': 'attention raised',
  'command.refused': 'command refused',
}

/** One report builder per action; the snapshot supplies the thread-validation facts. */
type ReportBuilder<A extends AuditAction> = (
  entry: AuditEntryOf<A>,
  snapshot: ProgramSnapshot,
) => TriggerReportFor<A>

/**
 * The per-action table. The contextual return type is `TriggerReportFor<A>`, so a builder
 * that returns another action's kind is a compile error, and the mapped type above makes
 * a missing action a compile error as well.
 */
const BUILD_REPORT: { readonly [A in AuditAction]: ReportBuilder<A> } = {
  'program.created': (entry, snapshot) => draftReport(entry, snapshot, 'program-created'),
  'program.paused': (entry, snapshot) => draftReport(entry, snapshot, 'program-paused'),
  'program.budget-paused': (entry, snapshot) => draftReport(entry, snapshot, 'program-budget-paused'),
  'program.resumed': (entry, snapshot) => draftReport(entry, snapshot, 'program-resumed'),
  'program.stopped': (entry, snapshot) => draftReport(entry, snapshot, 'program-stopped'),
  'program.goal-changed': (entry, snapshot) => draftReport(entry, snapshot, 'program-goal-changed'),
  'program.methodology-changed': (entry, snapshot) =>
    draftReport(entry, snapshot, 'program-methodology-changed'),
  'program.exploration-changed': (entry, snapshot) =>
    draftReport(entry, snapshot, 'program-exploration-changed'),
  'program.completed': (entry, snapshot) => draftReport(entry, snapshot, 'program-completed'),
  'usage.recorded': (entry, snapshot) => draftReport(entry, snapshot, 'usage-recorded'),
  'issue.created': (entry, snapshot) => draftReport(entry, snapshot, 'issue-created'),
  'issue.claimed': (entry, snapshot) => draftReport(entry, snapshot, 'issue-claimed'),
  'issue.commented': (entry, snapshot) => draftReport(entry, snapshot, 'issue-commented'),
  'issue.closed': (entry, snapshot) => draftReport(entry, snapshot, 'issue-closed'),
  'experiment.proposed': (entry, snapshot) => draftReport(entry, snapshot, 'experiment-proposed'),
  'experiment.opened': (entry, snapshot) => draftReport(entry, snapshot, 'experiment-opened'),
  'experiment.revised': (entry, snapshot) => draftReport(entry, snapshot, 'experiment-revised'),
  'experiment.ready': (entry, snapshot) => draftReport(entry, snapshot, 'experiment-ready'),
  'experiment.reviewed': (entry, snapshot) => draftReport(entry, snapshot, 'experiment-reviewed'),
  'experiment.cancelled': (entry, snapshot) => draftReport(entry, snapshot, 'experiment-cancelled'),
  'experiment.closed': (entry, snapshot) => draftReport(entry, snapshot, 'experiment-closed'),
  'ci.requested': (entry, snapshot) => draftReport(entry, snapshot, 'ci-requested'),
  'ci.started': (entry, snapshot) => draftReport(entry, snapshot, 'ci-started'),
  'ci.passed': (entry, snapshot) => draftReport(entry, snapshot, 'ci-passed'),
  'ci.failed': (entry, snapshot) => draftReport(entry, snapshot, 'ci-failed'),
  'artifact.stored': (entry, snapshot) => draftReport(entry, snapshot, 'artifact-stored'),
  'attention.raised': (entry, snapshot) => draftReport(entry, snapshot, 'attention-raised'),
  'command.refused': (entry) => ({ action: entry.action, kind: null, draft: null }),
}

/**
 * Create the mapper the delivery seam calls. The returned object implements
 * `TriggerFactory`; `make` reads exactly one builder slot for the entry's action.
 */
export function createTriggerFactory(): TriggerFactory {
  return {
    make<A extends AuditAction>(
      entry: AuditEntryOf<A>,
      snapshot: ProgramSnapshot,
    ): TriggerReportFor<A> {
      return BUILD_REPORT[entry.action](entry, snapshot)
    },
  }
}

/** The thread the fact starts on: the Program Thread always comes first. */
interface ThreadSelection {
  readonly threads: NonEmptyArray<ResearchThreadRef>
  readonly stale: boolean
  /** The subject Experiment when the snapshot resolved one; never invented. */
  readonly experiment: Experiment | undefined
}

/** The report plus the exact kind literal the builder chose. */
interface DraftReport<A extends AuditAction, K extends ResearchTriggerKind> {
  readonly action: A
  readonly kind: K
  readonly draft: ResearchTriggerDraft
}

/**
 * Build one waking report.
 *
 * The kind is a second type parameter so the returned literal is preserved: the builder
 * table's contextual type then checks it against `TriggerKindForAction[action]`.
 */
function draftReport<A extends AuditAction, K extends ResearchTriggerKind>(
  entry: AuditEntryOf<A>,
  snapshot: ProgramSnapshot,
  kind: K,
): DraftReport<A, K> {
  const selection = selectThreads(entry, snapshot)
  return {
    action: entry.action,
    kind,
    draft: {
      kind,
      programId: entry.programId,
      threads: selection.threads,
      actor: entry.actor,
      human: isHumanActor(entry.actor),
      at: entry.at,
      text: ACTION_TEXT[entry.action],
      ...ticketField(selection.experiment),
      meta: buildMeta(entry, selection.stale),
    },
  }
}

/**
 * Resolve the subject against the snapshot and pick the thread(s) the draft starts on.
 *
 * A snapshot for another Program, or a subject aggregate that is absent, is stale: the
 * selection falls back to the Program Thread instead of throwing, and the caller marks
 * the draft `stale`. Every subject kind is handled explicitly, so a new
 * `AttentionSubject`/audit subject variant is a compile error.
 */
function selectThreads(entry: AuditEntry, snapshot: ProgramSnapshot): ThreadSelection {
  const programThread = programThreadRef(entry.programId)
  if (entry.programId !== snapshot.program.id) {
    return staleSelection(programThread)
  }

  const subject = entry.subject
  switch (subject.kind) {
    case 'program':
      if (subject.id === snapshot.program.id) {
        return { threads: [programThread], stale: false, experiment: undefined }
      }
      return staleSelection(programThread)

    case 'issue': {
      const issue = snapshot.issues.find((candidate) => candidate.id === subject.id)
      if (issue === undefined || issue.programId !== entry.programId) {
        return staleSelection(programThread)
      }
      return {
        threads: [
          programThread,
          { kind: 'issue', id: `research:${entry.programId}:issue:${subject.id}` },
        ],
        stale: false,
        experiment: undefined,
      }
    }

    case 'experiment': {
      const experiment = snapshot.experiments.find((candidate) => candidate.id === subject.id)
      if (experiment === undefined || experiment.programId !== entry.programId) {
        return staleSelection(programThread)
      }
      return {
        threads: [programThread, experimentThreadRef(entry.programId, experiment.id)],
        stale: false,
        experiment,
      }
    }

    case 'ci-run': {
      // A CI record carries no thread of its own in ResearchThreadRef; it is reported on
      // the Program and Experiment Threads after the snapshot resolves its Experiment.
      const record = snapshot.ciRecords.find((candidate) => candidate.id === subject.id)
      if (record === undefined || record.programId !== entry.programId) {
        return staleSelection(programThread)
      }
      const experiment = snapshot.experiments.find(
        (candidate) => candidate.id === record.experimentId,
      )
      if (experiment === undefined || experiment.programId !== entry.programId) {
        return staleSelection(programThread)
      }
      return {
        threads: [programThread, experimentThreadRef(entry.programId, experiment.id)],
        stale: false,
        experiment,
      }
    }

    case 'artifact': {
      const artifact = snapshot.artifacts.find((candidate) => candidate.id === subject.id)
      if (artifact === undefined || artifact.programId !== entry.programId) {
        return staleSelection(programThread)
      }
      const experiment = snapshot.experiments.find(
        (candidate) => candidate.id === artifact.experimentId,
      )
      if (experiment === undefined || experiment.programId !== entry.programId) {
        return staleSelection(programThread)
      }
      return {
        threads: [programThread, experimentThreadRef(entry.programId, experiment.id)],
        stale: false,
        experiment,
      }
    }
  }
}

/** A subject the snapshot does not contain: Program Thread only, marked stale. */
function staleSelection(programThread: ResearchThreadRef): ThreadSelection {
  return { threads: [programThread], stale: true, experiment: undefined }
}

function programThreadRef(programId: ProgramId): ResearchThreadRef {
  return { kind: 'program', id: `research:${programId}` }
}

function experimentThreadRef(
  programId: ProgramId,
  experimentId: ExperimentId,
): ResearchThreadRef {
  return { kind: 'experiment', id: `research:${programId}:experiment:${experimentId}` }
}

/**
 * Copy a ticket id out of the snapshot Experiment when, and only when, the hydrated record
 * actually carries one. The nominal `Experiment` class has no `ticketId` field and
 * `ProgramSnapshot` has no Ticket rows, so nothing is ever synthesized here.
 */
function ticketField(experiment: Experiment | undefined): { readonly ticketId?: TicketId } {
  if (experiment === undefined) return {}
  if (!('ticketId' in experiment)) return {}
  const value: unknown = experiment.ticketId
  if (typeof value !== 'string' || value.length === 0) return {}
  return { ticketId: toTicketId(value) }
}

/**
 * `TicketId` is nominal and is normally minted by the parser/factory boundary. The value
 * read above already lives in the Host snapshot and is only forwarded to delivery, never
 * used for an authorization decision; this refinement declares that invariant once.
 */
function toTicketId(value: string): TicketId
function toTicketId(value: string): string {
  return value
}

/** Operator and Researcher facts are human; Host, Implementer and Watchdog facts are not. */
function isHumanActor(actor: Principal): boolean {
  switch (actor.kind) {
    case 'operator':
    case 'researcher':
      return true
    case 'implementer':
    case 'host':
    case 'watchdog':
    case 'router':
      return false
  }
}

/** Structured facts of the entry; `stale` is present only when the snapshot missed it. */
function buildMeta(
  entry: AuditEntry,
  stale: boolean,
): Readonly<Record<string, string | number | boolean | null>> {
  const meta: Record<string, string | number | boolean | null> = {
    action: entry.action,
    subjectKind: entry.subject.kind,
    subjectId: entry.subject.id,
  }
  if (stale) meta['stale'] = true
  return meta
}
