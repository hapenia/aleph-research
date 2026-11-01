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
- **Discriminated state machines.** An Issue is `open | assigned | in-review | closed`;
  a Pull request is `open | ci-requested | ci-running | ci-passed | ci-failed | merged |
  closed`. Fields that only make sense in one state exist only in that variant, so
  "merged without a CI run" or "reviewing without a Pull request" cannot be constructed.
- **Results, not exceptions.** Command deciders return `Result<Event[], DomainError>`;
  refusals are values with closed codes mapped to HTTP statuses.
- **Event sourcing with a pure decider and reducer.** `Decider<C>` and `Reducer` are
  total functions; the Host appends events with an expected version and folds read
  models from the same stream.
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
  contract: EvaluationContract      // CI entry, score field, acceptance rule
  budget: Budget
  status: 'running' | 'paused' | 'stopped'
  best: BestResult | null
  createdAt: IsoTimestamp
}
```

Acceptance is a closed union, evaluated by the Host (`MergeGate`), not by a model:

```ts
type AcceptanceRule =
  | { kind: 'ci-passed' }
  | { kind: 'score-improvement'; minDelta: number }
  | { kind: 'score-at-least'; minScore: number }
  | { kind: 'all'; rules: readonly AcceptanceRule[] }
  | { kind: 'any'; rules: readonly AcceptanceRule[] }
```

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

## Deliberate non-goals

No missions, machine registry, batch composition or InfraOptimizer; no scheduling of
compute (declarations stay descriptive); no GitHub issue/PR mirroring; no panel controls
in version 1; no second source of truth for research state outside Host storage.

## Review questions

1. Event sourcing versus a current-state repository: the blueprint chooses events for
   audit and replay. Is that the intended cost?
2. The acceptance rule union above: which rule kinds are actually needed for the first
   Program, and should the merge rule be part of the Program contract (as proposed) or
   of the Issue?
3. Issue ids: human-readable (`0001-slug`) versus generated opaque ids. The blueprint
   currently leaves `IssueId` as a branded string and stores titles separately.
4. Researcher pool size and how a Researcher is identified across restarts: a stable
   `ResearcherId` mapped to a Session, or the Session itself?
5. CI reuse: rerun on every request, or reuse a passed run for the same commit and
   environment digest?
6. Should `ExperimentPlan` live on the Issue comment only, or also as a typed record on
   the Pull request (the blueprint puts the plan in the command and the Issue comment)?
7. Environment scope: one environment per Pull request, or allow multiple named
   environments per repository for analysis versus training?
8. Does the operator need pause/stop in version 1, or is stopping the Program simply a
   status change with no in-flight cancellation?
9. The uv runtime and the methodology skill from the gap review: keep as prerequisites
   for CI and Worker instructions, or move methodology into the Program contract?
