# Type blueprint: AlephResearch rewrite in TypeScript

Status: **review first, implementation later.** This document and
`research-core/src/types/` are the agreed starting point; no runtime code exists in the
new package. The existing JavaScript extension stays in place until the phased rewrite
reaches parity.

## Why type-driven

The research mechanism is a state machine with several actors, a Host that is the only
writer, external effects (git, CI, Sessions) and untrusted input from HTTP and models.
The rewrite puts the illegal states into the type system before writing behaviour:

- **Parse, do not validate later.** Boundary parsers turn untrusted bodies into branded
  ids, timestamps and commands; inside the domain every value already satisfies its
  invariants.
- **Branded identities.** A `ProgramId` cannot be passed where an `IssueId` is expected.
  Humans read an Issue's title, not its id; ids stay opaque generated strings.
- **Discriminated state machines.** An Issue is `open | assigned | in-review | closed`;
  a Pull request is `open | ci-requested | ci-running | ci-passed | ci-failed | merged |
  closed`. Fields that only make sense in one state exist only in that variant, so
  "merged without a CI run" or "reviewing without a Pull request" cannot be constructed.
- **Results, not exceptions.** Command deciders return `Result<Event[], DomainError>`;
  refusals are values with closed codes mapped to HTTP statuses.
- **Event sourcing with a pure decider and reducer.** `Decider<C>` and `Reducer` are
  total functions; the Host appends events with an expected version and folds read
  models from the same stream. Whether the system keeps the full event history or only
  a current-state record is a review question (see the end).
- **Capabilities.** Each Session role has an explicit `Capability[]`; commands are
  authorized against the role and, for Researchers, against the Issue assignee.
- **Ports for effects.** git, CI execution, environment building, Session wake-up,
  attention and merge policy are interfaces implemented in later phases, so the domain
  stays testable without a Host.

## Package layout

```text
research-core/
  src/types/
    ids.ts            branded ids, timestamps, versions, scores
    errors.ts         Result and DomainError, StoreError
    program.ts        Program, Budget, EvaluationContract, AcceptanceRule, BestResult
    issue.ts          Issue state machine, IssueComment, labels
    pull-request.ts   Pull request state machine, ReviewComment, merge evidence
    ci.ts             CI run state machine, checks, request
    environment.ts    environment declaration, built environment, snapshot
    artifacts.ts      stored results: model weights, reports, retention
    roles.ts          SessionRole, Capability, identities
    session.ts        Researcher pool config, wake reasons, assignments
    attention.ts      Attention and its subjects
    events.ts         ProgramEvent, envelope, ProgramState, Decider, Reducer
    commands.ts       command unions per role, ExperimentPlan
    tools.ts          typed tool contracts for Researcher/Implementer/Operator/Watchdog
    storage.ts        repositories, event store, unit of work, executor, read model
    services.ts       Clock, CIRunner, EnvironmentBuilder, GitService, MergeGate, SessionPool
    api.ts            management API and read-only panel DTOs
    trigger.ts        research event to SuperAgent Trigger mapping
  src/index.ts        type re-exports only
```

## Core shapes

Program:

```ts
interface Program {
  id: ProgramId
  name: string
  goal: string                      // operator-owned
  contract: EvaluationContract      // CI entry and score field
  budget: Budget
  status: 'running' | 'paused' | 'stopped'
  best: BestResult | null
  autoMerge: AutoMergePolicy        // decided by the Host, never by a model
  createdAt: IsoTimestamp
}
```

The review rejected a general acceptance-rule language as meaningless. The blueprint
replaces it with one explicit `AutoMergePolicy` value on the Program
(`never | when-ci-passes | when-ci-passes-and-score-not-worse`); the exact value for the
first Program is a review question. `MergeGate` returns the evidence it checked, so the
Host decision is auditable without a rule engine.

Results are stored, not discarded: a passed CI run carries `ArtifactRef[]` (model
weights, reports, figures) and `BestResult` points at the artifacts of the best score.

Pull request merge evidence is part of the state, so the merge state cannot exist
without the CI run and score it was merged on:

```ts
PullRequest & { status: 'merged'; ciRunId: CIRunId; score: Score; mergeCommit: CommitSha }
```

Commands and events are unions; deciders are pure:

```ts
type Decider<Command> = (
  state: ProgramState,
  command: Command,
  context: DecisionContext,
) => Result<readonly ProgramEvent[], DomainError>
```

## Invariants

Encoded in types:

- identities are nominal; timestamp and score are branded;
- Issue and Pull request states carry only their own fields;
- merged Pull request carries CI run, score and merge commit;
- a passed CI run carries checks, score, log and duration;
- a command's payload names the Program; operational context (who, when) is separate;
- every event names its Program, sequence and time.

Checked at runtime in the phases that follow:

- transition legality (deciders) and version monotonicity (event store);
- one assignee per Issue and only that Researcher may act on it;
- CI only runs on an explicit request and only for the current head commit;
- environment declarations are buildable with uv;
- the merge rule holds and the merge has no conflicts;
- budgets are not exceeded.

## Roles and capabilities

`capabilitiesOf` in `roles.ts` is a data table, not logic. Operator creates the Program,
issues and stops it; Researcher claims, comments, proposes experiments, requests CI,
reviews, merges by request; Implementer only submits; Watchdog only raises attention;
Router has no research capabilities.

A Researcher is identified by its Session (review decision): there is no separate
ResearcherId. A restart creates a new Session and therefore a new Researcher, and the
Issue assignee is a `SessionId`.

## From research events to SuperAgent Triggers

The rewrite does not reimplement Eval or execution. `trigger.ts` maps an appended event
plus the folded state to a Trigger draft (`issue-claimed`, `ci-completed`, ...); the
prototype's Eval, Mandate, Ticket and Worker machinery authorizes and runs the work.
`TriggerFactory` is pure and may return `null` (for example a CI result for a superseded
head must not wake anyone).

## Host services

`storage.ts` makes the Host the only writer: repositories, an append-only event store
with optimistic concurrency, a unit of work and a command executor. `services.ts`
declares the effect ports: CI runner, environment builder, git merge, merge gate,
Session pool and attention sink. Phase 1 implements the store and deciders in memory
with tests; phase 2 swaps in SQLite and wires the services.

## API

The panel is read-only in version 1: `GET /aleph/api/programs` and
`GET /aleph/api/programs/:id` return summaries and one `ProgramSnapshot` (program,
issues, comments, Pull requests, reviews, CI runs, attention). Operator routes create
programs and issues; Researcher capabilities are exposed as Session tools, not panel
buttons.

## Phases

1. **Store and domain**: tsconfig already in place; implement `ProgramState` fold,
   deciders, event store (in memory and SQLite), command executor, management routes;
   tests for every transition and refusal.
2. **Researcher pool**: preset, pool, assignee claiming, Researcher tools, wake-ups from
   issue and CI events; the router/session wiring stays on the prototype.
3. **Implementer flow**: Pull request Tickets, environment declaration, on-demand CI in
   the declared environment with uv, review comments.
4. **Merge and panel**: MergeGate, merge, best update, read-only Program view.
5. **Case migration**: kunlungpt as a Program with Issues and Pull requests; 24-hour run;
   retirement of the superseded soak loop and the old extension.

Artifact persistence (port plus filesystem store) belongs to phase 3; pause/stop
cancellation belongs to phase 2 with the Session pool and Ticket cancellation.

## Deliberate non-goals

No missions, machine registry, batch composition or InfraOptimizer; no scheduling of
compute (declarations stay descriptive); no GitHub issue/PR mirroring; no panel controls
in version 1; no second source of truth for research state outside Host storage.

## Review questions

Answered in this revision:

- Issue ids stay opaque; humans read the title.
- A Researcher is the Session; no separate ResearcherId, and an Issue assignee is a
  `SessionId`.
- Experiment plans live in Issue comments.
- Every Pull request builds its own uv environment; no Program-runtime fallback.
- Pause and stop cancel in-flight Implementer work.
- Artifacts (model weights, reports) are stored and referenced from CI runs and the best
  result.

Still open:

1. **State storage.** The blueprint currently describes both an event log and read
   models. Should the system permanently keep every change as an event history that can
   be replayed and audited (more storage and code), or only keep the current state of
   each record, overwritten in place (simpler, loses history)? Recommended: keep a small
   event history for Program-level decisions and current-state records for Issues and
   Pull requests.
2. **When does the Host auto-merge a passed Pull request?** The previous rule language
   was rejected. Options: merge as soon as CI passes; merge only when the score is at
   least the current best (never regress the mainline); never auto-merge (a Researcher
   must request the merge). Recommended: merge only when CI passes and the score is at
   least the best.
3. **Who owns the uv runtime and the methodology instructions?** Two separate things:
   the case runtime with uv (technical prerequisite for CI) and the research
   methodology text (how a Worker should work). Options: both fixed in the extension
   image; both declared per Program and editable; uv fixed but methodology per Program.
   Recommended: uv fixed, methodology per Program so the operating rules can change
   without a deploy.
4. **Artifact location and retention.** Model weights can be large. Options: Host
   filesystem store with references in Host state (recommended); inside the research
   repository (git history grows, needs LFS); keep only the best result's artifacts and
   discard the rest. Recommended: Host store, keep the best result and recent
   experiments, prune temporary artifacts.
