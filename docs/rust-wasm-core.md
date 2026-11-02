# Rust + WASM core spike

Status: **spike only.** The current production path is still TypeScript. This branch
proves the toolchain and the ownership-based typestate that a Rust core would give us.

## Decision

Keep a **thin TypeScript shell** for DSH/Cordis and put the ordered research flow in a
Rust crate compiled to `wasm32-unknown-unknown`.

- Rust owns the flow typestate, receipts, ID validation and stage order.
- TypeScript owns every effect: webServer routes, tools, sessions, storage domain,
  orchestrator/Source delivery, CI subprocesses and the panel.
- The Rust core does no filesystem, network, environment or session access.

This is not a claim that WASM proves external effects. The TypeScript host still mints
the receipt after the effect; the Rust type system proves order and ownership, not that a
network call happened.

## What the spike contains

`rust-core/` (`aleph-research-core`):

- `ExperimentProposed -> TriggerAccepted -> TicketOpened` typestate.
- Each transition consumes `self`; the old value cannot be reused (compile-fail doctest).
- Empty IDs are refused at the stage boundary.
- A minimal exported symbol `aleph_flow_stage_count` proves the WASM artifact loads.
- `cargo test`: 2 unit tests; `cargo test --doc`: 1 compile-fail test.
- Release WASM builds to ~398 bytes for this probe and is loaded by Node's
  `WebAssembly.instantiate`.

Commands:

```bash
cd rust-core
cargo test
cargo test --doc
rustup target add wasm32-unknown-unknown   # once
cargo build --release --target wasm32-unknown-unknown
node -e "const b=require('fs').readFileSync('target/wasm32-unknown-unknown/release/aleph_research_core.wasm'); WebAssembly.instantiate(b).then(({instance})=>console.log(Object.keys(instance.exports)))"
```

## Proposed boundary

Next iteration replaces the probe with a `wasm-bindgen` facade that exposes one function
per stage (or a small JSON command) and generated TypeScript declarations:

```text
TS adapter (Cordis plugin)
  - parses HTTP/tool input into a typed command
  - performs storage/session/CI effects
  - calls wasm stage with IDs and facts
  - persists the returned receipt/state

Rust core
  - checks stage/ownership/ID invariants
  - returns the next receipt or an error
  - never performs I/O
```

The TypeScript wrapper remains thin: routing, effect calls and persistence only. It must
not reimplement stage order or receipt validity.

## Packaging constraints

- Ship the `.wasm` plus generated JS glue in the extension package; the current
  `research-host` cache-busting reload must recreate the wasm instance.
- Add Rust + wasm target to CI (currently only the spike commands are local).
- Pin the wasm-bindgen/rust toolchain in the package; a Rust toolchain is not present in
  the current CI image.
- The client panel stays TypeScript/React; no WASM there.
- DSH’s sandbox remains the enforcement for shell access; WASM is not a security boundary
  against the host.

## Typestate mapping

The Rust chain should grow to the same nodes as the v4 blueprint:

```
ExperimentProposed -> TriggerAccepted -> TicketOpened -> WorkerStarted
  -> CommitSubmitted -> EnvironmentBuilt -> CIPassed | CIFailed
  -> ResultRecorded -> ReviewRecorded -> ResearchCompleted
```

Each node is a Rust struct with the facts needed by the next; transitions consume `self`.
The TypeScript flow cannot hold a stale Rust node because the wasm call consumes it.

## Limits

- Rust does not replace the completion ledger: external stage wiring can still be absent
  and must be tracked as `TODO(@feature)` with the release gate.
- Async JS effects cannot live in the WASM core; the adapter remains async and must map
  errors explicitly.
- Serialization at the boundary must be versioned; generated TS types are required to
  avoid drift.
- A full rewrite of the existing 360-test TypeScript core is not part of this spike.

## Decision after the spike

If the wasm-bindgen facade is ergonomic and the generated types are usable, migrate the
flow/domain core incrementally. Otherwise keep TypeScript typestate and delete the spike.
