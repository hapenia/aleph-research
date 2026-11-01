# Type blueprint: AlephResearch rewrite in TypeScript

Status: **review first, implementation later.** `research-core/src/types/` is the agreed
starting point; the package contains types only. The JavaScript extension stays the
runtime until the phased rewrite reaches parity.

## Why type-driven

The research mechanism has several actors, one authoritative writer (the Host), external
effects (uv environments, CI, repository snapshots, Sessions) and untrusted input from
HTTP and models. The rewrite fixes the shape before writing behaviour:

- **Parse, do not validate later.** Boundary parsers turn untrusted bodies into branded
  ids, timestamps and commands; inside the domain every value satisfies its invariants.
- **Branded identities.** A `ProgramId` cannot be passed where an `IssueId` is expected.
  Humans read an Issue's title; ids stay opaque generated strings.
- **Discriminated state machines.** Issue, Experiment and CI run are unions where
  only-state fields exist only in that state.
- **Results, not exceptions.** Command execution returns `Result<Decision<R>, DomainError>`
  with a closed error-code set.
- **Current state plus an audit log.** The review rejected event replay: state lives in
  repositories and is updated in place; an append-only audit log records who changed
  what, why and what the Host checked. The log is for people, not for rebuilding states.
- **Capabilities.** Each Session role has an explicit `Capability[]`; Researcher commands
  are additionally checked against the Issue assignee.
- **Ports for effects.** uv environment building, CI execution, repository snapshots,
  artifact storage, Session wake-up, attention and cancellation are interfaces
  implemented in later phases.

## Package layout

```text
research-core/
  src/types/
    ids.ts            branded ids, timestamps, versions, scores
    errors.ts         Result, DomainError, StoreError
    program.ts        Program, Budget, EvaluationContract, methodology, exploration, BestResult
    issue.ts          Issue state machine, IssueComment, labels
    experiment.ts     Experiment state machine, lineage, strategy, reviews
    ci.ts             CI run state machine, checks, request
    environment.ts    uv environment declaration, built environment, snapshot
    artifacts.ts      stored results (model weights, reports), retention, ArtifactStore
    audit.ts          AuditEntry, AuditLog
    transitions.ts    legal transition tables for Issue, Experiment, CI
    roles.ts          SessionRole, Capability, identities
    session.ts        Researcher pool config, wake reasons, assignments
    attention.ts      Attention and its subjects
    commands.ts       command unions per role, ExperimentPlan, Decision
    tools.ts          typed tool contracts per role
    storage.ts        repositories, audit log, unit of work, command executor
    services.ts       Clock, CIRunner, EnvironmentBuilder, RepositoryService,
                      RunCanceller, SessionPool, AttentionSink
    api.ts            management API and read-only panel DTOs
    trigger.ts        audit fact plus snapshot to SuperAgent Trigger
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
  methodology: string               // per-Program research instructions
  exploration: 'low' | 'normal' | 'high'
  budget: Budget
  status: 'running' | 'paused' | 'stopped'
  best: BestResult | null
  createdAt: IsoTimestamp
}
```

Issue and Experiment states: an Issue is `open | assigned | in-review | closed`; an
Experiment is `open | ci-requested | ci-running | ci-passed | ci-failed | closed`.
An Experiment is a snapshot of one attempt, not a branch to merge into a mainline:
research does not copy software-engineering merge semantics. It ends by closing with a
reason; the best result is tracked on the Program and points at the artifacts it produced.

An Experiment carries its lineage, because diversity is a first-class concern:

```ts
interface ExperimentLineage {
  base: { kind: 'best' } | { kind: 'experiment'; experimentId: ExperimentId } | { kind: 'mainline' }
  baseCommit: CommitSha
  strategy: 'exploit' | 'explore'
  chosenBy: 'host-policy' | 'researcher'
  rationale: string
}
```

The Agent design started with an exploration degree for a reason: a genetic-algorithm
style diversity pressure keeps Researchers from locking onto one method. The blueprint
keeps `exploration` on the Program, `strategy` and `base` on each Experiment, and lets
the Host choose the base when the Researcher does not (or must override it to satisfy the
exploration balance). How the level maps to a required diversity ratio is an open
question below.

CI runs are `requested | running | passed | failed`; a passed run carries checks, a
score, stored artifacts and the log.

Commands and decisions:

```ts
type Decision<R> = { result: R; audit: readonly AuditEntry[] }
```

Command execution is a Host service (`CommandExecutor`) that applies the transition,
writes the audit entries in one transaction and returns a `Result`.

## Invariants

Encoded in types:

- identities are nominal; timestamps and scores are branded;
- Issue/Experiment/CI states carry only their own fields;
- a passed CI run carries checks, score, artifacts and log;
- an Issue assignee is a `SessionId` (a Researcher is its Session);
- an Experiment always has a lineage, strategy and rationale;
- an Experiment plan may reference earlier artifacts by typed `ArtifactInputRef`;
- every audit entry names the Program, actor, action, subject and the facts checked;
- every Trigger draft names its Thread kind and the actor Policy will see.

Checked at runtime in the phases that follow:

- transition legality (tables in `transitions.ts`) and one assignee per Issue;
- CI only on explicit request and only for the current head commit;
- every Experiment declares a uv environment that the Host can build;
- exploration balance across recent Experiments;
- pause/stop cancels in-flight Implementer work;
- artifact retention and budget limits.

## Roles

`capabilitiesOf` is a data table. Operator creates the Program, Issues, sets the
exploration level, pauses, stops and handles anomalies; Researcher claims, comments,
proposes Experiments, requests CI and closes Issues; Implementer only implements and
submits; Watchdog raises attention; the Main Session routes attention. A Researcher is
its Session: a restart is a new Researcher, and the Issue assignee is that Session.

## Environment and CI

uv is a fixed capability of the extension image, not per-Program configuration. Every
Experiment declares `environment/uv.lock` or `environment/requirements.txt` and the
Program contract names the CI entry and score field. The Host builds the environment
with uv, runs the entry inside it with `ALEPH_SUBMISSION_PYTHON`, and stores the artifacts
the entry produced. Research methodology text is per Program so rules can change
without a deploy.

## Artifacts

Model weights, reports, figures and datasets are persisted instead of discarded: a
passed CI run returns `ArtifactCandidate`s, the Host copies them into an
`ArtifactStore` on its filesystem and records `ArtifactRef`s; the best result points at
its artifacts. Later Experiments consume earlier results through typed
`ArtifactInputRef`s in their plan. Retention is
`keep-best | keep-forever | discard-after-merge | temporary`; only artifacts whose
retention allows it are pruned.

## API

The panel is read-only: `GET /aleph/api/programs` and
`GET /aleph/api/programs/:id` return a `ProgramSnapshot` (program, issues, comments,
Experiments, reviews, CI runs, artifacts, audit). Operator routes create programs and
issues; Researcher capabilities are Session tools.

## Phases

1. **Domain**: branded parsers, transition tables, command handlers, repositories in
   memory and SQLite, audit log, `CommandExecutor`, management routes; tests for every
   transition and refusal.
2. **Researcher pool**: preset, pool, assignee claiming, Researcher tools, wake-ups from
   Issue and CI facts; pause/stop cancellation of Implementer work.
3. **Implementer flow**: Experiment Tickets, uv environment declaration and build,
   on-demand CI, artifact storage, review comments, exploration-aware base selection.
4. **Panel**: read-only Program view.
5. **Case migration**: kunlungpt as a Program with Issues and Experiment snapshots;
   24-hour run; retirement of the superseded soak loop and the old extension.

## Deliberate non-goals

No missions, machine registry, batch composition or InfraOptimizer; no compute
scheduling; no GitHub issue/PR mirroring; no merge-to-mainline semantics; no panel
controls in version 1; no event replay; no second source of truth outside Host storage.

## Resolved in review

- Keep an audit log; do not build a replay engine.
- Remove the acceptance-rule language and auto-merge; research is not software
  engineering and does not copy merge semantics.
- Rename the experiment object from Pull request to **Experiment**; no merge state.
- A Researcher is identified by its Session; Issue assignee is a SessionId.
- Experiment plans live in Issue comments.
- Every Experiment builds its own uv environment; no shared runtime fallback.
- Pause/stop cancel in-flight Implementer work.
- Artifacts are stored on the Host with retention, and later Experiments reference them
  through typed artifact inputs.
- uv is fixed in the extension image; methodology text is per Program.
- Exploration degree from the original design is kept as Program `exploration`, with a
  strategy and lineage on every Experiment.

## Open questions for review

1. **Exploration mechanics.** How should the Host turn `exploration` into diversity?
   Options: a fixed quota (for example every third Experiment must be `explore` and start
   from a non-best base); a soft target the Host enforces only when a Researcher proposes
   another exploit; or full Researcher freedom with the Host only recording the strategy.
   Recommended: a quota per level (`low` = exploit only, `normal` = every third explore,
   `high` = every other explore), with the Host choosing the diverse base from recent
   Experiments.
2. **Diverse base choice.** When the Host must force an explore base, how is it picked:
   a random earlier Experiment, the most different earlier Experiment by score/lineage,
   the research mainline, or a pool the Researcher nominates in the Issue? Recommended:
   random among Experiments whose result is valid, so no method becomes the default.
3. **Exploration level authority.** May a Researcher change the strategy for a single
   Experiment (within the Host quota), or is the level entirely the Operator's control?
