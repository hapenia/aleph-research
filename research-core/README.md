# AlephResearch core

The typed research runtime, the wasm effect bridge and the thin adapter over the
DSH storage domain. The TypeScript adapter owns DSH mechanics; the wasm core
owns commands, authorization, pipeline order and stage transitions.

```bash
npm install
npm run build:wasm
npm run typecheck
npm run lint
npm test
npm run check:wasm
```

The design, the mechanism and the review responses are in `docs/type-blueprint.md`; the
research mechanism is `docs/research-mechanism.md`.
