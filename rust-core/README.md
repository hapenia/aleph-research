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
- `stage`: the stage states and their consuming transitions.
- `plugin`: the ten host traits and `Plugin`.
- `pipeline`: `PipelineContext` and `run_pipeline`.
- `memory`: in-memory host implementations and `InMemoryPlugin`.
- `wasm`: the wasm32 C ABI facade.

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
stage and for an incomplete `Plugin`, driven by `trybuild`.

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

The async host boundary is implemented by the adapter; the crate cannot call
JavaScript from a synchronous C ABI and does not embed an executor.
