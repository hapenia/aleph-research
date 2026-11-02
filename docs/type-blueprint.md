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
  concept adapters implementing the Rust traits
  wasm-bindgen generated bindings
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

## IDs and primitives

All identifiers are newtypes validated at the boundary:

```
ProgramId, IssueId, ExperimentId, TicketId, CIRunId, CommitSha, ArtifactId, AuditId
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
contract: ciEntry, timeoutMs, requiredMetrics
utility: metrics[name, direction, weight]
exploration: low | normal | high
budget: maxExperiments, maxComputeMinutes, maxTokens
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

### CIRecord

```
id, experimentId, ticketId, commit
environmentDigest
metrics: raw named values, no aggregate score
status: passed | failed
stdout, stderr, artifacts
createdAt
```

### Audit

Every command appends an audit entry with actor, action, subject, detail and request id.
The audit log is append-only and is the source of truth for replay and evidence.

## Commands and authorization

A model-facing command is a draft:

```
CommandDraft =
  program.create | program.pause | program.resume | program.stop
  | program.goal | program.methodology | program.exploration
  | issue.create | issue.claim | issue.comment | issue.close
  | experiment.propose | experiment.review | experiment.close
  | ci.request | ticket.submit
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
CIPassed | CIFailed
ResultRecorded
ReviewRecorded
ResearchCompleted
```

Invariants:

- `TriggerAccepted` exists only after the Source Eval accepted the trigger.
- `TicketOpened` exists only with a real Ticket id from the Executor.
- `WorkerStarted` exists only with a started Worker session.
- `CommitSubmitted` exists only with a commit reachable by CI.
- `EnvironmentBuilt` exists only after the declared environment was built.
- `CIPassed` and `CIFailed` carry the raw CIRecord; no aggregate score hides metrics.
- `ResearchCompleted` is terminal and carries the outcome.

Constructors are private. A single factory creates each state after the real effect, or in
the in-memory implementation used by tests. The factory is the trust boundary: it makes
the call site explicit and testable, but it does not prove that a network call happened.

## Pipeline

```
Step<In, Out> = (input: In, ctx: Context) => Promise<Result<Out, DomainError>>

interface Pipeline {
  deliverTrigger: Step<ExperimentProposed, TriggerAccepted>
  openTicket: Step<TriggerAccepted, TicketOpened>
  startWorker: Step<TicketOpened, WorkerStarted>
  submitCommit: Step<WorkerStarted, CommitSubmitted>
  buildEnvironment: Step<CommitSubmitted, EnvironmentBuilt>
  runCI: Step<EnvironmentBuilt, CIPassed | CIFailed>
  recordResult: Step<CIPassed, ResultRecorded>
  reviewResult: Step<ResultRecorded, ReviewRecorded>
  closePassed: Step<ReviewRecorded, ResearchCompleted>
  closeFailed: Step<CIFailed, ResearchCompleted>
}
```

`runCI` returns a union; both branches must be consumed. `runPipeline` chains the steps in
order and cannot skip one. The production `Pipeline` has no optional step and no `any`.

## Typestate public API

The public API is typestate. Each state exposes only its successor:

```
ExperimentProposed.deliverTrigger(): Result<TriggerAccepted, DomainError>
TriggerAccepted.openTicket(): Result<TicketOpened, DomainError>
TicketOpened.startWorker(): Result<WorkerStarted, DomainError>
WorkerStarted.submitCommit(): Result<CommitSubmitted, DomainError>
CommitSubmitted.buildEnvironment(): Result<EnvironmentBuilt, DomainError>
EnvironmentBuilt.runCI(): Result<CIPassed | CIFailed, DomainError>
CIPassed.recordResult(): Result<ResultRecorded, DomainError>
CIFailed.closeFailed(): Result<ResearchCompleted, DomainError>
ResultRecorded.reviewResult(): Result<ReviewRecorded, DomainError>
ReviewRecorded.closePassed(): Result<ResearchCompleted, DomainError>
ResearchCompleted.outcome: concluded | failed | cancelled
```

`openTicket` does not exist on `ExperimentProposed`; the trigger step cannot be skipped
even when the caller holds a state value. `CIPassed` and `CIFailed` are distinct types.
`ResearchCompleted` has no successor. `startPipeline(pipeline, initial)` is the only entry.

TypeScript has no move semantics: a previous object still exists after a transition. It
has no successor method, so the only way forward is the current state. Rust consumes
`self`, so the old value cannot be used at all.

## Wiring

Wiring is a typestate builder:

```
type Capability =
  trigger | ticket | worker | commit | environment | ci | result | review | close

PipelineBuilder<W extends Capability = never>
  withTrigger(...): PipelineBuilder<W | trigger>
  withTicket(...): PipelineBuilder<W | ticket>
  withWorker(...): PipelineBuilder<W | worker>
  withCommit(...): PipelineBuilder<W | commit>
  withEnvironment(...): PipelineBuilder<W | environment>
  withCI(...): PipelineBuilder<W | ci>
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
trait CI
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
  type CI: CI
  type Artifacts: Artifacts
  type Clock: Clock
  type Tools: Tools
  type Http: Http
  type Surface: Surface
  fn storage(&self) -> &Self::Storage
  fn trigger(&self) -> &Self::Trigger
  fn executor(&self) -> &Self::Executor
  fn sessions(&self) -> &Self::Sessions
  fn ci(&self) -> &Self::CI
  fn artifacts(&self) -> &Self::Artifacts
  fn clock(&self) -> &Self::Clock
  fn tools(&self) -> &Self::Tools
  fn http(&self) -> &Self::Http
  fn surface(&self) -> &Self::Surface
}
```

`runPipeline` accepts only `P: Plugin`. A plugin missing a concept does not satisfy the
trait, so the pipeline entry point is unreachable. The concept methods are the only host
boundary; they are async and implemented by the thin TypeScript adapter through
wasm-bindgen imports. The generated TypeScript declaration requires every method, so a
missing adapter method fails the TypeScript build as well.

`Surface` is the whole-plugin manifest: required HTTP routes, model-facing tools, session
presets and settings. The TypeScript layer binds every entry with a mapped
`Record<SurfaceName, Handler>`; a missing binding is a type error. This is how plugin
completeness covers more than the research pipeline.

## Storage contract

Repositories expose versioned reads and CAS writes. A transition that changes a durable
aggregate returns the new version; a concurrent write returns a conflict, never a lost
update. The storage domain has one envelope table per aggregate and an append-only audit
table. Stage states are ephemeral; CIRecords, Tickets, Experiments and audit entries are
persistent.

## DSH integration

The TypeScript adapter owns only the DSH/Cordis mechanics:

- `webServer` routes map requests to typed commands and `AuthorizedCommand` entries;
- tools expose the model-facing command schemas and call the same command layer;
- the session pool hosts the Operator/Researcher/Implementer presets;
- the executor starts Ticket work and reports Worker events;
- the CI adapter builds the declared environment, runs the entry and records raw results;
- the trigger adapter delivers the Experiment trigger to the prototype Source Eval;
- the client panel consumes generated DTOs and never derives domain transitions.

No adapter contains stage order, receipt validity or domain decisions.

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
- existing domain, parser, handler, storage and tool tests until parity.

End to end:

- a fixture lab drives `ExperimentProposed` through `ResearchCompleted` with fake
  concepts;
- a real DSH lab then repeats the same path with the concrete adapters;
- the completion ledger is empty before a test DSH is started.

## Migration

1. Add the Rust crate with IDs, errors, states and traits; generate wasm bindings.
2. Move validation and command authorization into Rust; keep the TS routes as adapters.
3. Implement the concept adapters against DSH storage, sessions, tools and CI.
4. Replace the TS pipeline with the typestate `Pipeline`; delete optional ports.
5. Add `Surface` and bind routes/tools/presets exhaustively.
6. Run the fixture lab, then the real DSH lab; empty the ledger; only then start a test DSH.

The legacy TypeScript core stays until the Rust path passes parity tests. `docs/rust-wasm-core.md`
records the spike commands and the wasm packaging constraints.

## Guarantees and limits

Compile time guarantees:

- stage order cannot be skipped or reordered;
- a later step cannot receive an earlier stage state;
- a CI failure branch must be handled;
- a command cannot reach the executor without an authorization proof;
- a missing concept, route, tool or preset binding is a type error;
- the release gate refuses incomplete features.

Runtime limits:

- the factory can still lie about an external effect; integration tests are required;
- WASM is not a security boundary and does not sandbox DSH;
- async JS effects must map errors explicitly;
- serialized boundary types must stay versioned and generated;
- TypeScript cannot enforce move semantics, only the absence of successor methods.

## Review questions

1. Keep stage states ephemeral, or persist them for audit in addition to the audit log?
2. Model only a terminal `CIFailed`, or add retryable failure states and retry edges?
3. Should `submitCommit` stay a separate step, or should the Worker step own prepare and
   commit and return `CommitSubmitted` directly?
