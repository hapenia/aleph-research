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
- `wasm`: the wasm32 C ABI facade.

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

The facade is a plain C ABI so the adapter needs no generated glue. All
functions use UTF-8 pointer/length pairs into wasm linear memory.

- `aleph_core_version() -> u32`
- `aleph_<name>_is_valid(ptr, len) -> u32` for program, issue, experiment,
  ticket, benchmark_run, benchmark_spec, artifact, audit, trigger,
  pipeline_run, session, actor and request identifiers, plus commit SHA,
  spec hash and environment digest.
- `aleph_stage_code(ptr, len) -> i32` returns -1 for an unknown stage name.
- `aleph_stage_successor_mask(code) -> u32` returns a bitmask indexed by stage
  code.
- `aleph_stage_is_terminal(code) -> u32`
- `aleph_stage_name_len(code) -> u32` and
  `aleph_stage_name_write(code, ptr, capacity) -> u32`.
- `aleph_stage_count() -> u32`
- `aleph_policy_allows_retry(attempt, max_attempts) -> u32`
- `aleph_bridge_version() -> u32`
- `aleph_alloc(length) -> ptr` and `aleph_free(ptr, length)`
- `aleph_start(ptr, len) -> u32` and `aleph_resume(ptr, len) -> u32`
- `aleph_command_start(ptr, len) -> u32` and
  `aleph_command_resume(ptr, len) -> u32`
- `aleph_response_len() -> u32` and
  `aleph_response_write(ptr, capacity) -> u32`

The command entry points run `HostGate` and `CommandExecutor` inside wasm.
Draft validation, capability, ownership, aggregate-state checks and audit
writes stay in Rust. Storage load/save, audit append and clock reads are
effects the TypeScript adapter executes before resuming the command.
