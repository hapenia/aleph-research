# aleph-research-core (Rust spike)

Typestate proof for the research flow. See `../docs/rust-wasm-core.md`.

```bash
cargo test
cargo test --doc
rustup target add wasm32-unknown-unknown
cargo build --release --target wasm32-unknown-unknown
```

The crate has no I/O and no DSH dependency. The TypeScript adapter owns effects.
