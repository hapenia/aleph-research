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
    issue.ts          Issue variants (open/assigned/in-review/closed), comment, labels
    experiment.ts     Experiment variants, lineage, strategy, reviews
    ci.ts             CI run variants, checks, request
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
  base: { kind: 'best' } | { kind: 'mainline' }
  baseCommit: CommitSha
  strategy: 'exploit' | 'explore'
  chosenBy: 'host-policy'
  rationale: string
}
```

The original design had an exploration degree for a reason: a genetic-algorithm style
diversity pressure keeps Researchers from locking onto one method. The Operator owns the
level; the Researcher never chooses a strategy. Fixed quota (review decision):

| level | quota | base |
| --- | --- | --- |
| `low` | exploit only | best result |
| `normal` | one explore in every three Experiments | research mainline |
| `high` | one explore in every two Experiments | research mainline |

The Host assigns the strategy and base when it opens an Experiment; the Researcher only
proposes the plan (hypothesis, steps, expected outcome, environment, artifact inputs).

CI runs are `requested | running | passed | failed`; a passed run carries checks, a
score, stored artifacts and the log.

Commands and decisions:

```ts
type Decision<R> = { result: R; audit: readonly AuditEntry[] }
```

Command execution is a Host service (`CommandExecutor`) that applies the transition,
writes the audit entries in one transaction and returns a `Result`.

## Compile-time guarantees

The review asked to move statically verifiable rules out of runtime checks. These are
the guarantees the blueprint now encodes; the table below maps every rule to its type
mechanism and the mistake it prevents.

| Guarantee | Type mechanism | Mistake prevented |
| --- | --- | --- |
| Only legal Issue/Experiment/CI moves compile | named variants (`OpenIssue`, `AssignedIssue`, ...) plus `Transition<From, Command, To, Actor>` in `transitions.ts` | calling `claim` on an already assigned Issue, closing a CI run, moving a passed Experiment back to `ci-requested` |
| A transition returns exactly its target state | `Transition` return type `Result<TransitionOutcome<To>, DomainError>` | a handler returning a state that the next step cannot consume |
| Only an authorized role can issue a command | `CapabilityForCommand` map plus `CapabilityOfCommand<T>`; role tool sets only expose their own command literals | a Researcher calling an operator-only command, a Watchdog proposing an Experiment |
| The Host injects fields the model must not choose | `ImplementerTools.submitImplementation` input is `Omit<CommandOf<'implementation.submit'>, 'ticketId'>` | submitting a result for another ticket |
| Audit action follows from the command | `AuditActionForCommand` map, `AuditActionOf<T>` | writing a decision without its required audit record, or mislabelling it |
| HTTP status follows from the refusal code | `HttpStatusForError`, `DomainFailure` | inventing a status in a route handler |
| Boundary values are refined | `NonEmptyString`, `PositiveInt`, `NonNegativeInt`, `DurationMs`, branded ids and timestamps | empty goals, zero budgets, negative usage, raw strings where ids belong |
| Tool payloads are command payloads | `ToolForCommand<K, Output, Input = CommandOf<K>>` | a tool that accepts a shape no command can execute |
| Closed unions are handled exhaustively | per-variant interfaces and the `Never` helper | forgotten states after a union grows |
| A merged/experiment result carries evidence | state variants carry their own fields only (`PassedCIRun` carries score, checks, artifacts) | a best result without artifacts or a passed CI run without a score |

What stays a runtime check, because it depends on the world rather than the shape of the
data:

- the calling Session really has the claimed role, and the Issue assignee matches it;
- the declared uv environment actually builds, and the CI entry actually passes;
- git branches and commits exist as referenced;
- counters and the exploration quota over real history;
- artifact bytes, retention and disk space;
- pause/stop cancellation reaching the relays and executor.

## Unrepresentable error states

The review asked that wrong states be impossible to construct rather than rejected at
runtime. The following states have no type in the blueprint:

| Wrong state | Why it cannot be written |
| --- | --- |
| a stopped Program without a reason, or a running Program carrying stop fields | `Program` is `RunningProgram | PausedProgram | StoppedProgram`; each variant owns its fields (`pausedAt`, `stopReason`, `stoppedAt`) |
| an open Issue with an assignee, an assigned Issue without one, a closed Issue without resolution | `OpenIssue`, `AssignedIssue`, `InReviewIssue`, `ClosedIssue` are distinct interfaces |
| an Experiment merged into a mainline, or a review requesting a merge | the state union has no `merged`; review kinds are `review | ci-request` |
| "explore" starting from the best result, or "exploit" starting from the mainline | `ExperimentLineage` is a discriminated union: `{strategy:'exploit'; base:{kind:'best'}}` or `{strategy:'explore'; base:{kind:'mainline'}}` |
| a passed CI run without a score, digest or artifact list; a running CI run without a digest | `PassedCIRun`/`RunningCIRun` carry those fields; `RequestedCIRun` has none of them |
| merging after a failed CI run | no merge state exists; a best result is only updated from a `PassedCIRun` |
| an Implementer submitting a result for a ticket it does not own | the tool input is `Omit<CommandOf<'implementation.submit'>, 'ticketId'>`; the Host injects the ticket id |
| a CI pass recorded by a Researcher, or an issue claim whose subject is a CI run | `AuditEntry` is a mapped union: the action fixes both the allowed actor kinds and the subject kind |
| a decision with no audit record | `Decision.audit` is `NonEmptyArray<AuditEntry>` |
| a best result without stored artifacts | `BestResult.artifacts` is `NonEmptyArray<ArtifactRef>` |
| empty goals, commands, score fields; zero budgets or timeouts; negative usage | `NonEmptyString`, `PositiveInt`, `NonNegativeInt`, `DurationMs` at boundaries |
| a raw string where an id, commit or timestamp is required | branded ids and timestamps |
| a command from a role that does not hold its capability | `CapabilityForCommand`/`CapabilityOfCommand<T>`; each role's tool set only exposes its own command literals |
| a tool payload no command can execute | `ToolForCommand<K, Output, Input = CommandOf<K>>` |

States that still depend on the world and therefore stay runtime checks: whether a real
Session exists and holds the claimed role, whether the uv environment builds, whether the
CI entry passes, whether branches and commits exist, the exploration quota over real
history, artifact bytes and disk space, and whether pause/stop cancellation reaches the
executor.

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

## Integration with DSH and dsh-superagent

The rewrite does not replace DeepSeek Harness or the Super-agent prototype. It becomes
another Cordis plugin in the same composition: the prototype keeps the domain it owns
(Source, Trigger, Eval, Mandate, Policy, Ticket, Assignment, Executor, Router, Outbox),
and the new TypeScript core is the research application on top of it.

```text
DSH host process
  dsh-base, dsh-web-app                 (harness services)
  dsh-superagent                         (vendored prototype bundle)
      ctx.orchestrator  ───────────────────────────┐
      Sources / Eval / Tickets / Executor / Router │  service seam
  @local/dsh-aleph-superagent (rewritten)           │
      bootstrap (hot reload)                        │
      adapter (TS) ── imports ── research-core (TS domain)
      client.js (TS panel)
```

### Packages and build

- `research-core/` stays a pure TypeScript library: domain types, command handlers,
  repositories and ports. It has no DSH dependency and is unit-tested alone.
- `superagent-extension/` becomes the adapter and is rewritten in TypeScript. It keeps
  the **same package name** (`@local/dsh-aleph-superagent`) and the same bundle patch
  shape, so profiles and lab scripts do not change. Its entry keeps the existing
  bootstrap (cache-busting re-import plus disposers) for hot reload.
- `index.ts` in the adapter exports the thin Cordis plugin: it opens storage, registers
  management routes and tools, ensures Researcher Sessions, then wires the prototype.
- `vendor/dsh-superagent` stays pinned and patched as today; the worker tool allowlist
  patch still admits the submit tool.
- CI builds both packages with `tsc` (plus the client bundle step) before tests.

### Service mapping

| DSH / prototype service | Adapter use | Blueprint port |
| --- | --- | --- |
| `ctx.webServer` | mount `/aleph/api/programs*`, operator routes, panel | `ManagementRoutes` |
| `ctx.tools` | register Operator/Researcher/Implementer tools, guarded by preset | `tools.ts` contracts |
| `ctx.sessions`, `sessionController`, `agents` | ensure/wake Researcher Sessions, attach tool scopes | `SessionPool` |
| `ctx.agentPresets` | select the `aleph-researcher` preset for Researcher Sessions | `session.ts` |
| `ctx.orchestrator` | register the `aleph` Source; `context(alephKind).receive(trigger)`; read tickets | `TriggerFactory` to `SourceContext.receive` |
| prototype settings | executor `prepare`, blocked commands, executor model | ticket lifecycle (unchanged) |
| DSH storage domain (`aleph_research`, chosen) | Programs, Issues, Experiments, CI runs, artifacts metadata, audit | `storage.ts` repositories |
| `ctx.subprocess` / shell | uv environment build and CI entry execution | `EnvironmentBuilder`, `CIRunner` |
| `ctx.effects` / notify | attention to the Main Session | `AttentionSink` |
| filesystem + git | artifact bytes and repository snapshots | `ArtifactStore`, `RepositoryService` |
| `ctx.fiber` | restart on panel reload | bootstrap |

Storage is a DSH storage domain (registering `aleph_research`), as agreed in review, so
it lives with the rest of the harness state and is backed up the same way; artifact
bytes stay on the filesystem. The exact domain tables are an adapter-phase decision,
hidden behind the repository interfaces.

### End-to-end flow across the seam

1. Operator creates a Program and an Issue through `/aleph/api`; the adapter writes the
   records and the audit log.
2. A Researcher Session calls `claim_issue` and `propose_experiment` (its tools are
   registered by the adapter, guarded by the `aleph-researcher` preset). The adapter
   assigns the exploration strategy and base from the Program's level and quota.
3. The adapter builds a Trigger draft (`experiment-proposed`) and calls
   `ctx.orchestrator.context(alephKind).receive(trigger)`; the Trigger lands on the
   Program Thread.
4. The prototype's Eval authorizes the Trigger against the Policy (per-ticket
   authorization); the prototype Router hands the accepted candidate to the Executor,
   which starts a Worker Session for the Experiment Ticket.
5. The prototype `prepare` command creates the ticket workspace from the Experiment's
   branch, copies artifact inputs, writes `AGENTS.md` with the plan, methodology and
   environment declaration.
6. The Worker implements and calls `aleph_submit_result`. In the rewrite this tool no
   longer scores inline: it calls `CIRunner`, which builds the uv environment from the
   declaration, runs the Program's `ciEntry` inside it, parses the score and collects
   artifacts. The adapter stores the `CIRun`, artifacts and audit entries.
7. The adapter emits a `ci-completed` Trigger into the same Source; the assigned
   Researcher Session is woken with the CI result and reads the Program snapshot through
   its tools.
8. The Researcher closes the Issue or proposes the next Experiment; the Main Session only
   sees attention Triggers, never research decisions.

### Researcher Sessions and presets

- The profile patch gains one preset, `aleph-researcher`, with the research tools, a
  persona that forbids implementation, and read-only file access at most. The prototype's
  router and worker presets are untouched.
- The adapter ensures a small pool of Researcher Sessions with stable Session ids, maps
  Issues to their assignee Session, and wakes only the assignee (or an idle Session for an
  unassigned Issue) using the same `agent.followup` mechanism the current watchdog uses.
- Implementer work continues to use the prototype's Worker preset and Executor; the
  Experiment Ticket's assignment text is generated by the adapter from the plan.

### Prototype evaluation versus the new CI

The prototype's Eval authorizes work; it does not score results. Scoring moves to the
adapter's `CIRunner` (uv environment + `ciEntry`), and the result enters the domain as an
audit fact plus a Trigger. The old extension's inline evaluation module is replaced by the
`CIRunner` implementation; the prototype's `aleph_submit_result` tool name and worker
allowlist stay, so worker prompts and the sandbox composition do not change.

### Panel and hot reload

The client entry is rewritten in TypeScript and keeps the same slot keys. It reads
`/aleph/api/programs*` only; it never calls prototype routes directly. The Host-side
bootstrap keeps the cache-busting import and the disposer discipline, so a reload replaces
the adapter and core modules while storage connections are reopened; Researcher Sessions
keep running and their tool calls resolve against the new registration.

### What stays untouched

- Vendored prototype, its domain, Executor, worker preset, sandbox and permission setup.
- Profile composition and lab scripts, apart from the new Researcher preset and the
  tool-allowlist environment variables.
- The case fixture and the runtime layout; the preparation script gains an Experiment-plan
  section but keeps its existing contract.

### Integration risks

- A hot reload with live Researcher Sessions can race tool re-registration; the adapter
  must re-register before waking any Session and the reload route must drain in-flight
  commands.
- Two writers must never exist: if the old JS extension is mounted at the same time as
  the adapter during migration, state and tools collide. The migration keeps only one
  entry mounted per profile.
- Storage domain migrations must be additive; artifacts on disk need a digest index so a
  moved state file does not orphan model weights.

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
- Fixed quota by level: `low` exploits only; `normal` requires one explore in three;
  `high` requires one in two.
- Explore Experiments branch from the research mainline; exploit Experiments from the
  best result.
- The Operator owns the exploration level and every strategy decision; a Researcher only
  proposes a plan and cannot choose exploit versus explore.

## Status

After the fourth review round the blueprint targets unrepresentable error states:
status variants own their fields, lineage pairs strategy with its only legal base, CI
evidence exists only on the runs that have it, audit actor and subject follow from the
action, decisions always carry audit and best results always carry artifacts. Approve the
blueprint to start phase 1 (domain, storage, audit and management routes with tests).
