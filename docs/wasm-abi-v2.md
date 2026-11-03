# wasm-bindgen ABI v2

## Shape

`rust-core` exports a single wasm-bindgen `Core` class. It owns `RefCell<CoreState>` and
exposes `new`, `boundary_version`, `start`, `resume`, `command_start` and `command_resume`.
Inputs and outputs are `JsValue` DTOs serialized with `serde-wasm-bindgen`; `ts-rs` exports
the TypeScript types under `research-core/src/adapter/bindings/`.

The effect protocol is unchanged: Rust owns stage order, effect sequence, policy/retry and
command authorization; TypeScript executes one effect and resumes with the result.

## Removed code

- `rust-core/src/wire.rs` (1,156 lines)
- `rust-core/src/wasm.rs` (208 lines)
- `research-core/src/adapter/wasm-codec.ts` (704 lines)
- `research-core/src/adapter/command-codec.ts` (829 lines)

ABI version is 2. The old C `aleph_*` functions and manual alloc/free buffers are gone.

## Size decision

The raw release wasm is 623,037 bytes; gzip is 159,399 bytes. The original plan budget was
320 KiB. The user approved a revised budget of 640 KiB after these measurements:

| Serialization | Release wasm |
| --- | --- |
| wasm-bindgen + serde-wasm-bindgen (adopted) | 623,037 |
| wasm-bindgen + serde_json strings | 618,949 |
| wasm-bindgen + bincode | 277,853 |
| wasm-bindgen + postcard | 256,399 |
| wasm-bindgen + ciborium CBOR | 706,054 |
| wasm-bindgen + rmp-serde MessagePack | 746,565 |

The binary alternatives meet the old budget but have no mature JavaScript decoder; they
would require a generated TypeScript decoder and more protocol machinery. The structured
DTO path removes the hand-written codecs and keeps generated types, so the revised
640 KiB budget is accepted.

## Build

`npm run generate` writes the ignored wasm-bindgen JS/wasm and ts-rs DTO files; it must
run before typecheck or build on a fresh checkout. `npm run build:wasm` runs:

1. `cargo build --locked --release --target wasm32-unknown-unknown`
2. `wasm-bindgen 0.2.130 --target web --remove-name-section`
3. embeds the wasm bytes in `wasm-core.ts` and calls `initSync({ module })`

`npm run check:wasm` verifies the artifact and budget; `npm run check:bindings` verifies
the 75 generated TypeScript files.

## Verification

- 93 Rust tests, 421 research-core tests, 239 superagent-extension tests
- Real embedded wasm pipeline: passed, failed, retryable, tamper/sequence rejection,
  isolated Core instances, ABI version mismatch
- Live DSH smoke completed all ten stages through the wasm-bindgen ABI
- No DSH was left running
