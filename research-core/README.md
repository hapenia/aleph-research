# AlephResearch core: type blueprint v3.1

Types only, with compile-time negative tests, ESLint/ast-grep boundary rules and a
mutation harness. No runtime implementation lives here yet.

```bash
npm install
npm run typecheck
npm run lint
npm run test:mutation
```

The design, the mechanism and the review responses are in `docs/type-blueprint.md`; the
research mechanism is `docs/research-mechanism.md`.
