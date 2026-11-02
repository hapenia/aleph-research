# AlephResearch type blueprint

Status: **proposed rewrite; implementation starts after review.** This document replaces
the frozen TypeScript blueprint. It covers the whole plugin: domain state, commands, the
research pipeline, DSH integration, tool and route surfaces, completion tracking and
verification.

## Goals

The plugin must be **complete by construction**, not by convention:

- every research step consumes the previous stage state and returns the next one;
- a pipeline cannot be started unless every step is wired;
- a command cannot reach the executor without a Host authorization proof;
- every concept the plugin needs is declared in Rust and implemented by the thin
  TypeScript adapter;
- an unimplemented path fails compilation or the release gate, never a silent no-op.

The type system is split by responsibility:

| Layer | Owns | Does not own |
| --- | --- | --- |
| Rust core (`wasm32`) | IDs, states, commands, authorization, pipeline order, validation, completeness traits | DSH/Cordis lifecycle, network, filesystem, sessions |
| TypeScript adapter | DSH/Cordis binding, concept implementations, HTTP/tool/session adapters, wasm loading | research decisions, state machines, stage order |
| Client panel | rendering and interaction | domain state transitions |

## Core purpose

The framework lets an agent research autonomously against an explicit, immutable
benchmark.

- The Operator creates a Program with a goal, a benchmark contract, a utility definition
  and a budget.
- The Researcher proposes and revises Experiments from recorded BenchmarkRecords.
- The Implementer works a Ticket and submits a commit; the Host runs the benchmark.
- The Host scheduler, not an unrestricted model loop, decides when to propose again, when
  to stop, and when the budget is exhausted.
- The benchmark belongs to the Operator. The agent cannot edit it, and every run pins its
  spec hash and environment digest.

Autonomy is therefore bounded and auditable: the agent chooses hypotheses and
implementations, while the benchmark and budget define success.

## Live validation boundary

The implementation is validated by a real DSH lab with the embedded wasm, the real
command bridge and a synthetic benchmark command. The actual 24-hour case run is out of
scope: it is an acceptance run for the framework, not an implementation step.

## Out of scope

The old Boltzmann sampler, quota, merge and best-result tracker are not part of this
design. Exploration remains Program metadata; the Researcher proposes hypotheses from
recorded BenchmarkRecords, and ResearchPolicy bounds the search. There is no separate
sampler to wire.

## Naming

Standard names only. Types describe states; functions describe actions; traits describe a
capability. Do not add a second vocabulary for the same idea: no `Receipt`, `Evidence`,
`Concept`, `FlowStep` or `Complete*` suffixes.

Rust and TypeScript use the same domain names. IDs are newtypes, never bare strings. A
state type has one successor operation; a wiring interface has one field per step.

## Architecture

```
Cordis plugin (TypeScript)
  webServer routes, tools, session pool, panel, settings
  concept adapters implementing the effect-backed Rust traits
  raw C ABI effect bridge
        |
        v
Rust core (wasm32-unknown-unknown)
  IDs, validation, command authorization
  domain states and transitions
  typestate pipeline and Plugin completeness
```

The dependency direction is one-way: TypeScript imports generated Rust declarations; Rust
does not import JavaScript. The adapter supplies concept implementations to the Rust
plugin at construction. The adapter performs effects and maps their results into the
concept methods; the Rust core decides what may happen next.

## Effect bridge

The wasm module has no JavaScript imports. Rust returns an effect frame
`{name, sequence, payload}`; TypeScript performs the effect, then calls `aleph_resume`
with the encoded result. Rust validates the pending effect kind and sequence, owns the
stage order, and advances only on a matching result. TypeScript never selects a stage.

The bridge exposes the six concepts the pipeline actually uses: storage, trigger,
executor, sessions, benchmark and clock. Rust's ten-trait `Plugin` remains the internal
composition; artifacts, tools, HTTP and surface are manifest/registry concerns rather
than pipeline effects.

## IDs and primitives

All identifiers are newtypes validated at the boundary:

```
ProgramId, IssueId, ExperimentId, TicketId, BenchmarkRunId, CommitSha, ArtifactId, AuditId
```

`CommitSha` accepts a 40-character hex SHA or the documented zero value for a fresh
experiment. Timestamps are ISO-8601 UTC at the boundary and typed timestamps internally.
Versions are monotonic integers used by storage compare-and-swap.

Errors are typed enums. A domain refusal is not a panic; a contract violation may panic
only in a test or a `todo!()` stub.

## Durable state

Durable state is separate from pipeline stage state. It is stored in the `aleph_research`
DSH domain as versioned envelopes with CAS.

### Program

```
id, name, goal, methodology
benchmark: BenchmarkSpec
utility: metrics[name, direction, weight]
exploration: low | normal | high
policy: ResearchPolicy
usage: experiments, computeMinutes, tokens
status: running | paused | stopped
createdAt, version
```

### Issue

```
id, programId, title, body, labels
author, createdAt
status: open | assigned | closed
assignee: researcher session id
experimentIds
```

### Experiment

```
id, programId, issueId
branch, head
environment: requirements | uv-lock
lineage: strategy, baseCommit, freshStartProbability
planCommentId
createdBy, createdAt
status: open | concluded | failed | cancelled
```

### Ticket

```
id, experimentId, assignment
status: open | running | succeeded | failed | abandoned
commit, workerSessionId
```

### BenchmarkRecord

```
id, experimentId, ticketId, commit
specHash, environmentDigest
metrics: raw named values, no aggregate score
status: passed | failed | retryable
attempt, maxAttempts
stdout, stderr, artifacts
createdAt
```

### PipelineRun

```
id, experimentId, stage, attempt
benchmarkRunId?
stateVersion, updatedAt
```

`PipelineRun` persists progress, not the nominal stage token. On resume the Host reads the
stage name and ids, rebuilds the stage state after checking the durable aggregate, and
continues. This survives a Host restart without making stage types serialisable.

### Audit

Every command appends an audit entry with actor, action, subject, detail and request id.
The audit log is append-only and is the source of truth for replay and evidence.

## Benchmark contract

```
BenchmarkSpec {
  id, entry, timeoutMs
  metrics: [{ name, direction, required, tolerance? }]
  maxRetries
  baseline?: { [metric: string]: number }
  dataset?: string
}
```

The spec is read-only input to the Host. The benchmark adapter hashes it, builds the
declared environment, runs the entry and records raw metrics. The agent never writes
benchmark files, tests or expected values. A run whose spec hash or environment digest
does not match the Program contract is invalid and cannot be recorded as passed.

`BenchmarkRecord` holds the raw metrics and artifacts. It has no aggregate score; the
Program utility, not the adapter, defines how metrics are weighted.

`BenchmarkSpec.maxRetries` is advisory. `ResearchPolicy.maxAttemptsPerExperiment` is the
authoritative retry bound; the policy wins when they disagree.

## Commands and authorization

A model-facing command is a draft:

```
CommandDraft =
  program.create | program.pause | program.resume | program.stop
  | program.goal | program.methodology | program.exploration
  | issue.create | issue.claim | issue.comment | issue.close
  | experiment.propose | experiment.review | experiment.close
  | benchmark.request | ticket.submit
```

The Host gate checks principal, capability, ownership and current state, then returns:

```
AuthorizedCommand<K> {
  command: CommandOf<K>
  actor: ActorOf<K>
  authorization: AuthorizationProof<K>
}
```

`CommandExecutor` accepts only `AuthorizedCommand<K>`. A route, tool or session cannot
call the executor with a bare command. `AuthorizationProof` is minted by the gate; it is
not constructible by the adapter.

## Autonomy

A Program-level loop drives repeated Experiments:

```
Program running
  -> Issue assigned
  -> Experiment proposed
  -> Trigger accepted
  -> Ticket opened
  -> Worker started and commit submitted
  -> Environment built
  -> Benchmark passed | failed | retryable
  -> Result recorded
  -> Review recorded: propose | revise | stop
       propose / revise -> new Experiment proposed
       stop             -> Research completed
```

`ResearchPolicy` bounds the loop: maximum experiments, compute minutes, tokens and
attempts per experiment. A retryable benchmark failure returns to `EnvironmentBuilt` only
while the attempt budget allows it; otherwise it becomes terminal. The Researcher chooses
the next hypothesis from recorded results; the Host enforces the policy and owns the stop
condition.

## Stage states

The pipeline is a sequence of nominal states. Each state carries only the ids and facts
the next step needs. Durable state lives in storage.

```
IssueAssigned
ExperimentProposed
TriggerAccepted
TicketOpened
WorkerStarted
CommitSubmitted
EnvironmentBuilt
BenchmarkPassed | BenchmarkFailed | BenchmarkRetryable
ResultRecorded
ReviewRecorded
ResearchCompleted
```

Invariants:

- `TriggerAccepted` exists only after the Source Eval accepted the trigger.
- `TicketOpened` exists only with a real Ticket id from the Executor.
- `WorkerStarted` exists only with a started Worker session.
- `CommitSubmitted` exists only with a commit reachable by the benchmark.
- `EnvironmentBuilt` exists only after the declared environment was built.
- `BenchmarkPassed`, `BenchmarkFailed` and `BenchmarkRetryable` carry the raw
  BenchmarkRecord; no aggregate score hides metrics.
- `ReviewRecorded` carries the Researcher decision: propose, revise or stop.
- `ResearchCompleted` is terminal and carries the outcome.

Constructors are private. A single factory creates each state after the real effect, or in
the in-memory implementation used by tests. The factory is the trust boundary: it makes
the call site explicit and testable, but it does not prove that a network call happened.

## Pipeline

```
Step<In, Out> = (input: In) => Promise<Result<Out, DomainError>>

interface Pipeline {
  deliverTrigger: Step<ExperimentProposed, TriggerAccepted>
  openTicket: Step<TriggerAccepted, TicketOpened>
  startWorker: Step<TicketOpened, WorkerStarted>
  submitCommit: Step<WorkerStarted, CommitSubmitted>
  buildEnvironment: Step<CommitSubmitted, EnvironmentBuilt>
  runBenchmark: Step<EnvironmentBuilt, BenchmarkPassed | BenchmarkFailed | BenchmarkRetryable>
  retryBenchmark: Step<BenchmarkRetryable, EnvironmentBuilt>
  recordResult: Step<BenchmarkPassed, ResultRecorded>
  reviewResult: Step<ResultRecorded, ReviewRecorded>
  closePassed: Step<ReviewRecorded, ResearchCompleted>
  closeFailed: Step<BenchmarkFailed | BenchmarkRetryable, ResearchCompleted>
}
```

`runBenchmark` returns a union; every branch must be consumed. `retryBenchmark` is allowed
only while `ResearchPolicy.maxAttemptsPerExperiment` permits it; otherwise the state is
terminal and goes to `closeFailed`. `runPipeline` chains the steps in order and cannot
skip one. The production `Pipeline` has no optional step and no `any`.

## Typestate public API

The public API is typestate. Each state exposes only its successor:

```
ExperimentProposed.deliverTrigger(): Result<TriggerAccepted, DomainError>
TriggerAccepted.openTicket(): Result<TicketOpened, DomainError>
TicketOpened.startWorker(): Result<WorkerStarted, DomainError>
WorkerStarted.submitCommit(): Result<CommitSubmitted, DomainError>
CommitSubmitted.buildEnvironment(): Result<EnvironmentBuilt, DomainError>
EnvironmentBuilt.runBenchmark(): Result<BenchmarkPassed | BenchmarkFailed | BenchmarkRetryable, DomainError>
BenchmarkRetryable.retryBenchmark(): Result<EnvironmentBuilt, DomainError>
BenchmarkPassed.recordResult(): Result<ResultRecorded, DomainError>
BenchmarkFailed.closeFailed(): Result<ResearchCompleted, DomainError>
ResultRecorded.reviewResult(): Result<ReviewRecorded, DomainError>
ReviewRecorded.closePassed(): Result<ResearchCompleted, DomainError>
ResearchCompleted.outcome: concluded | failed | cancelled
```

`openTicket` does not exist on `ExperimentProposed`; the trigger step cannot be skipped
even when the caller holds a state value. `BenchmarkPassed`, `BenchmarkFailed` and
`BenchmarkRetryable` are distinct types. `ResearchCompleted` has no successor.
`startPipeline(pipeline, initial)` is the only entry.

TypeScript has no move semantics: a previous object still exists after a transition. It
has no successor method, so the only way forward is the current state. Rust consumes
`self`, so the old value cannot be used at all.

## Wiring

Wiring is a typestate builder:

```
type Capability =
  trigger | ticket | worker | commit | environment | benchmark | retry | result | review | close

PipelineBuilder<W extends Capability = never>
  withTrigger(...): PipelineBuilder<W | trigger>
  withTicket(...): PipelineBuilder<W | ticket>
  withWorker(...): PipelineBuilder<W | worker>
  withCommit(...): PipelineBuilder<W | commit>
  withEnvironment(...): PipelineBuilder<W | environment>
  withBenchmark(...): PipelineBuilder<W | benchmark>
  withRetry(...): PipelineBuilder<W | retry>
  withResult(...): PipelineBuilder<W | result>
  withReview(...): PipelineBuilder<W | review>
  withClose(...): PipelineBuilder<W | close>
  build(this: PipelineBuilder<Capability>): Pipeline
```

A partial builder has no `build()`. There is no default production wiring and no factory
that returns a complete-looking pipeline whose steps throw.

Tests implement a `FakePipeline` with real in-memory behavior. A specific unimplemented
seam may throw `unimplemented(feature)`, but it cannot be wrapped into a whole pipeline.

## Plugin completeness

Rust declares the concepts the adapter must supply:

```
trait Storage
trait TriggerSource
trait TicketExecutor
trait Sessions
trait BenchmarkRunner
trait Artifacts
trait Clock
trait Tools
trait Http
trait Surface
```

`Plugin` has one associated type per concept:

```
trait Plugin {
  type Storage: Storage
  type Trigger: TriggerSource
  type Executor: TicketExecutor
  type Sessions: Sessions
  type Benchmark: BenchmarkRunner
  type Artifacts: Artifacts
  type Clock: Clock
  type Tools: Tools
  type Http: Http
  type Surface: Surface
  fn storage(&self) -> &Self::Storage
  fn trigger(&self) -> &Self::Trigger
  fn executor(&self) -> &Self::Executor
  fn sessions(&self) -> &Self::Sessions
  fn benchmark(&self) -> &Self::Benchmark
  fn artifacts(&self) -> &Self::Artifacts
  fn clock(&self) -> &Self::Clock
  fn tools(&self) -> &Self::Tools
  fn http(&self) -> &Self::Http
  fn surface(&self) -> &Self::Surface
}
```

`runPipeline` accepts only `P: Plugin`. A plugin missing a concept does not satisfy the
trait, so the pipeline entry point is unreachable. The concept methods are the only host
boundary; the wasm effect bridge surfaces the six pipeline concepts, while the remaining
traits are manifest/registry contracts. A missing concept implementation fails the Rust
trait bound; a missing effect handler fails the TypeScript union exhaustive check.

`Surface` is the whole-plugin manifest: required HTTP routes, model-facing tools, session
presets and settings. The TypeScript layer binds every entry with a mapped
`Record<SurfaceName, Handler>`; a missing binding is a type error. This is how plugin
completeness covers more than the research pipeline.

## Storage contract

Repositories expose versioned reads and CAS writes. A transition that changes a durable
aggregate returns the new version; a concurrent write returns a conflict, never a lost
update. The storage domain has one envelope table per aggregate and an append-only audit
table. Stage states are ephemeral; PipelineRuns, BenchmarkRecords, Tickets, Experiments and
audit entries are persistent.

## DSH integration

The TypeScript adapter owns only the DSH/Cordis mechanics:

- `webServer` routes map requests to typed commands and `AuthorizedCommand` entries;
- tools expose the model-facing command schemas and call the same command layer;
- the session pool hosts the Operator/Researcher/Implementer presets;
- the executor starts Ticket work and reports Worker events;
- the benchmark adapter builds the declared environment, runs the entry and records raw results;
- the trigger adapter delivers the Experiment trigger to the prototype Source Eval;
- the client panel consumes generated DTOs and never derives domain transitions.

No adapter contains stage order, stage-state validity or domain decisions.

## Completion and release gate

`completion.ts` is a checked ledger: every feature that is not verified end to end is
`'todo'`. `check:completion` prints the pending list; `check:release` fails compilation
while any entry is `'todo'`. Rust stubs use the standard `todo!()` macro. There are no
explanatory TODO comments and no comment-scanning gate.

The release gate is the deployment gate. Health reports the ledger, but health is not a
completion claim.

## Verification

Rust:

- unit tests for IDs, transitions and invariants;
- compile-fail tests for consumed typestate values;
- integration tests with in-memory `Storage`, `TriggerSource` and `TicketExecutor`;
- `cargo clippy`, `cargo fmt --check`, release wasm build.

TypeScript:

- typecheck of generated wasm bindings and the adapter;
- negative type tests for wrong stage values and partial wiring;
- route/tool/surface completeness tests against `Surface`;
- benchmark integrity tests: spec hash, environment digest, read-only benchmark files;
- policy tests: experiment, compute, token and attempt limits;
- existing domain, parser, handler, storage and tool tests until parity.

End to end:

- a fixture lab drives `ExperimentProposed` through `ResearchCompleted` with fake
  concepts, including a retryable benchmark failure and policy-bounded retry;
- a real DSH lab then repeats the same path with the concrete adapters;
- the completion ledger is empty before a test DSH is started.

## Migration

1. Add the Rust crate with IDs, errors, states and traits; generate wasm bindings.
2. Move validation and command authorization into Rust; keep the TS routes as adapters.
3. Implement the concept adapters against DSH storage, sessions, tools and the benchmark runner.
4. Replace the TS pipeline with the typestate `Pipeline`; delete optional ports.
5. Add `Surface` and bind routes/tools/presets exhaustively.
6. Run the fixture lab, then the real DSH lab; empty the ledger; only then start a test DSH.

The legacy TypeScript core stays until the Rust path passes parity tests. `docs/rust-wasm-core.md`
records the spike commands and the wasm packaging constraints.

## Guarantees and limits

Compile time guarantees:

- stage order cannot be skipped or reordered;
- a later step cannot receive an earlier stage state;
- a benchmark failure or retryable branch must be handled;
- a command cannot reach the executor without an authorization proof;
- a missing concept, route, tool or preset binding is a type error;
- the release gate refuses incomplete features.

Runtime limits:

- the factory can still lie about an external effect; integration tests are required;
- WASM is not a security boundary and does not sandbox DSH;
- async JS effects must map errors explicitly;
- serialized boundary types must stay versioned and generated;
- TypeScript cannot enforce move semantics, only the absence of successor methods.

## Decisions

1. **Stage-state persistence.** Persist a `PipelineRun` (stage, attempt, ids, benchmark
   run id, state version) plus the durable aggregate and audit log. Stage states stay
   ephemeral and are rebuilt on resume. This gives restart recovery without serialising
   nominal tokens.
2. **Failure branches.** `BenchmarkRetryable` is explicit. It returns to
   `EnvironmentBuilt` only while `ResearchPolicy.maxAttemptsPerExperiment` allows it;
   otherwise it goes to `closeFailed`. `BenchmarkFailed` is always terminal.
3. **Step granularity.** Keep `startWorker` and `submitCommit` separate. A Worker can start
   without committing, and the two failures need different remediation; merging them
   would hide a partial progress state.

These choices favour autonomous operation with bounded policy over an unrestricted retry
loop.
