# Rust + WASM core spike

Status: **spike only.** The current production path is still TypeScript. This branch
proves the toolchain and the ownership-based typestate that a Rust core would give us.

## Decision

Keep a **thin TypeScript concept layer** for DSH/Cordis and put the plugin's concepts and
ordered research flow in a Rust crate compiled to `wasm32-unknown-unknown`.

- Rust defines the **concepts** (Storage, Trigger, Ticket, Session, CI, Clock, Tools,
  HTTP, Artifacts), the flow typestate, receipts, ID validation and stage order.
- TypeScript only **encapsulates those concepts as adapters**: it maps DSH/Cordis
  services onto the Rust-defined concept methods and owns the actual external I/O.
- The Rust `CompletePlugin` trait requires every concept type; a plugin missing a concept
  cannot be started. wasm-bindgen-generated TypeScript declarations make a missing host
  method a TypeScript compile error too.
- Rust owns completeness of the composition; TypeScript owns transport and effects, not
  domain decisions.

This is not a claim that WASM proves external effects. The concept adapter still performs
the effect and returns its result; Rust proves the complete concept surface and the order
of steps, not that a network call happened.

## What the spike contains

`rust-core/` (`aleph-research-core`):

- `ExperimentProposed -> TriggerAccepted -> TicketOpened` typestate.
- Each transition consumes `self`; the old value cannot be reused (compile-fail doctest).
- Empty IDs are refused at the stage boundary.
- `CompletePlugin` concept traits with Storage/Trigger/Ticket associated types and a
  `run_research_chain` entry point; a `FakePlugin` drives the chain in tests.
- A minimal exported symbol `aleph_flow_stage_count` proves the WASM artifact loads.
- `cargo test`: 3 unit tests; `cargo test --doc`: 1 compile-fail test.
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

## Concepts own completeness

Rust declares the plugin concepts as traits and requires a complete bundle:

```rust
pub trait StorageConcept { /* save_program, save_ticket, ... */ }
pub trait TriggerConcept { /* deliver_experiment -> TriggerId */ }
pub trait TicketConcept  { /* open_ticket -> TicketId */ }

pub trait CompletePlugin {
    type Storage: StorageConcept;
    type Trigger: TriggerConcept;
    type Ticket: TicketConcept;
    fn storage(&self) -> &Self::Storage;
    fn trigger(&self) -> &Self::Trigger;
    fn ticket(&self) -> &Self::Ticket;
}

pub fn run_research_chain<C: CompletePlugin>(plugin: &C, proposed: ExperimentProposed)
    -> Result<TicketOpened, ConceptError>
```

A plugin with a missing concept does not satisfy `CompletePlugin`, so the entry point is
unreachable. The spike includes a `FakePlugin` implementing all three concepts and a full
chain test; the remaining concepts follow the same pattern.

The TypeScript layer is generated/handwritten to implement exactly these concepts:

```text
TS concept adapters (thin)
  ResearchStore      -> StorageConcept
  ResearchTrigger    -> TriggerConcept
  ResearchTickets    -> TicketConcept
  ResearchSessions   -> SessionConcept
  ResearchCI         -> CIConcept
  ResearchTools      -> ToolConcept
  ResearchHttp       -> HttpConcept
  ...
        |
        v
Rust plugin composition (CompletePlugin)
  - owns flow order, typestate and validation
  - calls concept methods through wasm-bindgen
  - returns receipts/errors
```

No TypeScript adapter contains stage order or receipt validity; it only maps a concept
method to a DSH/Cordis operation and returns the result. The Rust side cannot be built
with a missing concept, and generated TS declarations cannot be satisfied with a missing
adapter method.

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

The Rust concepts and chain should grow to the same nodes as the v4 blueprint:

```
ExperimentProposed -> TriggerAccepted -> TicketOpened -> WorkerStarted
  -> CommitSubmitted -> EnvironmentBuilt -> CIPassed | CIFailed
  -> ResultRecorded -> ReviewRecorded -> ResearchCompleted
```

Each node is a Rust struct with the facts needed by the next; transitions consume `self`.
The TypeScript flow cannot hold a stale Rust node because the wasm call consumes it.

## Limits

- Rust does not replace the completion ledger: the concept surface can be complete while
  a stage's real implementation is still a stub; those are tracked as `TODO(@feature)`
  with the release gate.
- Async JS effects cannot live in the WASM core; the adapter remains async and must map
  errors explicitly.
- Serialization at the boundary must be versioned; generated TS types are required to
  avoid drift.
- A full rewrite of the existing 360-test TypeScript core is not part of this spike.

## Decision after the spike

If the wasm-bindgen facade is ergonomic and the generated types are usable, migrate the
flow/domain core incrementally. Otherwise keep TypeScript typestate and delete the spike.
