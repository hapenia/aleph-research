# Type blueprint v2: nominal research domain in TypeScript

Status: **review first, implementation later.** `research-core/src/types/` is the
blueprint; the package contains types plus compile-time negative tests only. The
JavaScript extension stays the runtime until the phased rewrite reaches parity.

This version replaces the first blueprint after an independent adversarial review. The
review is responded to item by item below. The research mechanism it implements is
`docs/research-mechanism.md` (v5): Boltzmann base sampling, raw multi-metric records, no
best record, no merge semantics, iterative Experiments, explicit CI requests.

## Why type-driven, and why nominal classes

The first version used interfaces and discriminated unions. The adversarial review showed
that structural typing defeats exact-state claims: spreading a running object with a stop
field still assigns to the running type, wrong pairs in flat unions typecheck, free
generics let a caller choose any result, and repository parameters typed `string` erase
nominal ids.

v2 therefore uses **nominal classes with private constructors and private brand fields**:
an object of one state cannot be produced by object literal or spread, variants cannot be
assigned to each other, and the only way to obtain a state is the factory or the
transition method that is allowed to produce it. On top of that:

- a command's actor, capability and result are mapped from its literal at compile time;
- the executor is generic only over the command literal, so the result cannot be chosen;
- repositories take branded ids and versioned writes;
- every claim in this document has a `@ts-expect-error` negative test in
  `research-core/src/type-tests.ts`, compiled by `tsc`.

## Mechanism in one paragraph

An Operator creates a Program with a goal, methodology, evaluation contract, metric
definitions, budget and exploration level. Researchers claim Issues and propose typed
Experiment plans. The Host picks each new Experiment's base by Boltzmann sampling over
all Experiments with a valid CI record (weight `exp(utility / temperature)`), or a fresh
start from the scaffold with a fixed probability; the level's temperature and
fresh-start probability are fixed (`low` 0.2/2%, `normal` 1.0/10%, `high` 3.0/25%).
An Implementer writes the experiment on a branch, declares a uv environment, commits and
marks it ready. The Researcher requests CI explicitly; the Host builds the environment,
runs the Program's CI entry, stores raw metric records and artifacts, and wakes the
Researcher. Iteration reuses the same Experiment. There is no best score: quality is the
queryable raw metric table. There is no merge: Experiments are snapshots, and a later
Experiment starts from a sampled commit or the scaffold.

## Package layout

```text
research-core/
  src/types/
    ids.ts            branded ids, sessions, timestamps, versions, refinements
    actors.ts         nominal Principals (operator/researcher/implementer/watchdog/host/router)
    errors.ts         Result, per-code DomainError union, HTTP mapping, DomainFailure
    metrics.ts        MetricDefinition, raw CIRecord, metric queries
    sampling.ts       fixed exploration presets, SampleInput, BaseChoice, Sampler port
    program.ts        RunningProgram/PausedProgram/StoppedProgram classes with transitions
    issue.ts          OpenIssue/AssignedIssue/InReviewIssue/ClosedIssue classes
    environment.ts    uv-only environment declaration, snapshot, built environment
    artifacts.ts      nominal ArtifactRef, retention, ArtifactStore port
    ci.ts             Requested/Running/Passed/Failed CI classes with transitions
    experiment.ts     six Experiment state classes, nominal lineage, plan and review
    attention.ts      attention subjects and severities
    audit.ts          action-to-actor-to-subject mapped union, command audit map
    commands.ts       user command union, capability/actor/result maps, context
    executor.ts       CommandHandlers map and typed CommandExecutor
    storage.ts        nominal, versioned repositories; unit of work; read model
    services.ts       EnvironmentBuilder, RepositoryService, CIRunner, RunCanceller,
                      SessionPool, AttentionSink, ArtifactStore, Sampler ports
    tools.ts          Schema class, command-derived tool contracts per role
    api.ts            raw DTOs, parsers, actor-typed routes, ProgramSnapshot
    triggers.ts       audit fact to SuperAgent Trigger seam
  src/type-tests.ts   compile-time positive and negative tests
  src/index.ts        exports
```

## State machines as classes

Each state class owns its fields and only its legal moves. For example:

```ts
RunningProgram.pause(actor: OperatorPrincipal, at): PausedProgram
RunningProgram.stop(actor: OperatorPrincipal, reason, at): StoppedProgram
OpenIssue.claim(actor: ResearcherPrincipal, at): AssignedIssue
AssignedIssue.attachExperiment(actor: ResearcherPrincipal, experimentId, head, at): InReviewIssue
OpenExperiment.requestCI(actor: ResearcherPrincipal, ciRunId, at): CIPendingExperiment
CIPendingExperiment.startCI(actor: HostPrincipal, digest, at): CIRunningExperiment
CIRunningExperiment.passCI(actor: HostPrincipal, run, metrics, artifacts, at): CIPassedExperiment
CIRunningExperiment.failCI(actor: HostPrincipal, reason, detail, at): CIFailedExperiment
CIFailedExperiment.revise(actor: ImplementerPrincipal, head, environment, at): OpenExperiment
```

Notable consequences:

- A merged state does not exist; an Experiment closes with a reason.
- A failed CI result cannot be turned into a passed Experiment: `failCI` returns
  `CIFailedExperiment`, which has no metrics or artifacts.
- Lineage is a nominal pair: `DerivedLineage` (sampled base Experiment) or `FreshLineage`
  (scaffold); there is no "fresh from a sampled base" or "derived from nothing".
- A stopped Program must carry `stoppedAt` and `stopReason`; running and paused Programs
  cannot carry them.

## Command surface, actors and results

- `UserCommand` is a tagged union; `CommandOf<'program.pause'>` etc. extracts one payload.
- `CapabilityForCommand`, `ActorForCommand` and `CommandResultMap` are compile-time maps:
  the actor that may issue a command and the value it returns follow from the literal.
- `CommandContext<K>` requires `ActorForCommand[K]`; the executor is
  `execute<K extends CommandType>(command: CommandOf<K>, context: CommandContext<K>)`,
  so a Researcher cannot execute an operator command, a host principal cannot execute a
  user command, and the result type cannot be chosen by the caller.
- `Decision<T>` carries a non-empty audit array; a command cannot silently produce no
  audit record.
- Host-internal work (open Experiment, start/finish CI, store artifact) is not a user
  command; the Host performs it through services and writes `experiment.opened`,
  `ci.started/passed/failed`, `artifact.stored` audit entries.

## Audit

`AuditEntry` is a mapped union over actions: each action fixes the allowed actor kinds
and a typed subject (`ProgramId`, `IssueId`, `ExperimentId`, `CIRunId`, `ArtifactId`).
`CommandAuditMap` maps each user command to its action, and `AuditActionOf<T>` derives it.
An `issue.claimed` entry cannot be written by the Host or point at a CI run.

## Storage

- Repositories take branded ids: `get(id: IssueId)`, `listAssignedTo(ResearcherSessionId)`;
  a ProgramId cannot be passed to an Issue query.
- Writes are versioned: `save(expected: Version, next: T)` returns
  `Result<Version, StoreError>`; the version conflict path is typed.
- `UnitOfWork` covers programs, issues, experiments, raw CI records, artifacts, attention
  and the audit log, with comments and reviews as append operations on their aggregates.
- `ReadModel.snapshot(programId)` produces the panel DTO from current-state records; no
  replay engine exists.

## Sampling and metrics

- `Sampler.sample(SampleInput): Result<BaseChoice, DomainError>` takes the level, metric
  definitions and the population of Experiments with valid CI records.
- `EXPLORATION_PRESETS` is a fixed table; there is no per-Program override.
- Raw records only: `CIRecord` rows are stored; latest/average/sorted views are computed
  by `MetricQuery`, never persisted. There is no best record to forge.

## Tools and API

- Tools carry a nominal `Schema<T>` with `parse` and `toJsonSchema`, matching how DSH
  registers tools (`parameters` JSON schema), and a command literal for command tools.
- Implementer submit input is `Omit<CommandOf<'ticket.submit'>, 'ticketId' | 'experimentId'>`:
  the Host injects both, and `Schema<T>` nominality prevents substituting a wider input.
- API routes are actor-typed methods on `ManagementApi`; every response is either the
  typed value or a `DomainFailure` whose HTTP status follows from the refusal code.
- Raw DTOs and `RequestParsers` are separate from commands: boundary refinement
  (`NonEmptyString`, `PositiveInt`, `DurationMs`) happens in parsers.

## DSH and dsh-superagent integration

- `research-core` is a DSH-independent TypeScript library.
- `superagent-extension` becomes the TypeScript adapter with the same bundle name,
  bootstrap/hot reload and profile composition; it maps DSH services to the ports:
  `webServer` routes, `tools` registration, `sessions`/`agentPresets` for the Researcher
  pool, `ctx.orchestrator` for the Trigger seam, DSH storage domain `aleph_research` for
  state, subprocess/shell for uv and CI, filesystem for artifacts, `effects` for
  attention, `fiber` for reload.
- Researcher Sessions are ordinary DSH sessions with a research preset; Implementer work
  stays a prototype Ticket/Worker with the existing sandbox and prepare command.
- The submit tool no longer scores inline: it asks the Host CI runner, which builds the
  Experiment's uv environment and records raw metrics and artifacts.
- The prototype Eval keeps per-Ticket authorization; the Main Session keeps routing
  attention only.

## Compile-time guarantees and negative tests

`research-core/src/type-tests.ts` contains `@ts-expect-error` cases for:

- forging a Program/Issue/Experiment variant with an object spread;
- assigning one variant to another;
- turning a failed CI Experiment into a passed one;
- executing an operator-only command as a Researcher or as the Host;
- passing a ProgramId where an IssueId is expected;
- constructing a `DomainFailure` with a status that contradicts its code;
- recording an audit action with the wrong actor;
- producing a `Decision` with an empty audit array;
- substituting a full submit command (with Host-injected ids) for the submit tool input;
- treating a FreshLineage as DerivedLineage and vice versa.

If a type becomes more permissive these tests fail with an unused `@ts-expect-error`.

What remains a runtime check (it depends on the world, not on data shape): the real
Session behind a principal, uv environment build success, the CI entry result, branch and
commit existence, metric completeness, artifact bytes and retention, budget counters,
cancellation reaching the executor, and the sampler's randomness.

## Adversarial review response

| Review finding | Resolution in v2 |
| --- | --- |
| B1 `DomainFailure` uninhabitable | `DomainError` is a per-code union; `DomainFailure` maps status from code; type test constructs a valid failure and rejects a wrong status. |
| B2 `failCI` could return a passed Experiment | `failCI` returns `CIFailedExperiment`; `passCI` returns `CIPassedExperiment`; type test rejects the wrong target. |
| B3 free generic executor | `CommandExecutor.execute<K extends CommandType>(CommandOf<K>, CommandContext<K>)`; result from `CommandResultMap[K]`; no free `R`. |
| B4 flat lineage union | Nominal `DerivedLineage | FreshLineage` classes; Host factory takes `BaseChoice`; wrong pairs cannot be constructed. |
| B5 Program boundary incomplete | `CreateProgramCommand` carries name, goal, methodology, contract, utility, exploration, budget; refined types; raw DTOs parsed by `RequestParsers`. |
| B6 host identity impossible | `HostPrincipal` is a principal class; host work is not a user command, so no command context needs a host principal. |
| B7 storage erased ids | Repositories take branded ids; writes versioned; `UnitOfWork` covers comments, reviews, CI records, artifacts, attention, audit. |
| B8 tools cannot be registered / role scoping | `Schema<T>` with `toJsonSchema`; command tools carry the command literal; implementer input omits Host-injected ids. |
| Structural width forges states | Nominal classes with private constructors/brands; negative tests for spread forging. |
| Reviewer cast holes | `attachExperiment`, closes and reviews take the exact principal class. |
| Best/evidence forgery | No best exists; `CIRecord` rows are raw; `PassedCIRun`/`CIPassedExperiment` carry their evidence. |
| Empty decisions | `Decision.audit` is `NonEmptyArray`. |
| Program state machine missing | Program classes own pause/resume/stop/goal/methodology/exploration transitions. |
| Review flow missing | `ReviewExperimentCommand`, `ExperimentReview`, `reviewExperiment` route and `experiment:review` capability. |
| Merge leftovers | Removed: no merged state, no merge-conflict, no discard-after-merge, no runtime fallback. |
| Boundary refinements missing | `NonEmptyString`, `PositiveInt`, `DurationMs`, branded ids, nominal `Schema`. |

## Phases

1. Domain implementation: factories for the nominal classes, command handlers and audit
   writing, DSH storage-domain repositories, management routes, and the negative tests
   kept green.
2. Host services: uv environment builder, CI runner, artifact store, sampler with a
   seeded RNG, Researcher pool and attention sink, pause/stop cancellation.
3. Adapter: tool registration, Trigger seam to the prototype, Researcher preset, panel.
4. Case migration: kunlungpt as a Program with Issues and Experiments; then the 24-hour
   run.

## Deliberate non-goals

No missions, machines, batches or merge/mainline semantics; no scheduling; no GitHub
integration; no stored best or aggregate; no event replay; no panel controls in v1.

## Review request

The blueprint now answers the adversarial review item by item and has executable negative
tests. Please review `research-core/src/type-tests.ts` first, then the state classes and
the command/executor maps. Implementation starts after approval.
