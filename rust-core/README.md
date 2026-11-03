# aleph-research-core

No-I/O Rust core for AlephResearch. It owns identifiers, typed errors, durable
domain types, stage states, the typestate research pipeline and the `Plugin`
completeness trait.

The crate performs no I/O. DSH sessions, storage, networking, tools and web
routes are supplied by the thin TypeScript adapter through the `Plugin`
associated types. An incomplete `Plugin` does not compile, and `run_pipeline`
accepts only a complete `Plugin`.

## Layout

- `id`: newtype identifiers, commit SHAs, digests, versions and attempts.
- `error`: typed errors, including one error type per host boundary.
- `time`: millisecond timestamps with RFC 3339 formatting and parsing.
- `domain`: Program, Issue, Experiment, Ticket, BenchmarkSpec,
  BenchmarkRecord, ResearchPolicy, ResearcherDecision, AuditEntry and their
  value objects.
- `command`: command drafts, actor capabilities, the Host authorization
  gate, `AuthorizedCommand`, `AuthorizationProof` and the command executor.
- `stage`: the stage states and their consuming transitions.
- `plugin`: the ten host traits and `Plugin`.
- `pipeline`: `PipelineContext` and `run_pipeline`.
- `memory`: in-memory host implementations and `InMemoryPlugin`.
- `dto` and `wasm_bindgen`: the wasm-bindgen `Core` facade and its serde DTOs.

## Commands

`CommandDraft` covers every blueprint command. `HostGate::authorize` checks
capability, ownership and current aggregate state and mints an
`AuthorizedCommand<K>` with a private `AuthorizationProof<K>`.
`CommandExecutor::execute` accepts only `AuthorizedCommand<K>`; a bare draft
does not compile. Every executed command appends an audit entry, and every
mutation goes through versioned Storage CAS.

## Pipeline

```
ExperimentProposed -> TriggerAccepted -> TicketOpened -> WorkerStarted
-> CommitSubmitted -> EnvironmentBuilt -> BenchmarkOutcome
-> ResultRecorded -> ReviewRecorded -> ResearchCompleted
```

`BenchmarkOutcome` is a union of `BenchmarkPassed`, `BenchmarkFailed` and
`BenchmarkRetryable`; every branch is consumed. `BenchmarkRetryable` returns to
`EnvironmentBuilt` only while `ResearchPolicy::allows_retry` permits it, and
otherwise closes as failed. Every transition consumes `self`.

## Commands

```bash
cargo fmt --check
cargo clippy -- -D warnings
cargo test
cargo build --release --target wasm32-unknown-unknown
```

`tests/compile_fail` contains the compile-fail cases for reusing a consumed
stage, skipping a stage, an incomplete `Plugin`, passing a bare draft to the
command executor and minting an authorization proof outside the gate, driven
by `trybuild`.

## wasm32 ABI

The facade is a wasm-bindgen `Core` class. Arguments and frames cross the
boundary as `JsValue` objects described by the serde DTOs in `src/dto.rs` and
the generated TypeScript declarations in
`research-core/src/adapter/bindings/`.

- `new Core()`
- `boundary_version() -> u32`
- `start(input) -> frame`
- `resume(input) -> frame`
- `command_start(input) -> frame`
- `command_resume(input) -> frame`

The command entry points run `HostGate` and `CommandExecutor` inside wasm.
Draft validation, capability, ownership, aggregate-state checks and audit
writes stay in Rust. Storage load/save, audit append and clock reads are
effects the TypeScript adapter executes before resuming the command.
