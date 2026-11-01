# AlephResearch core: type blueprint

This package holds the TypeScript type blueprint for the rewrite of the research
mechanism. There is no runtime implementation here yet: it is reviewed first, then the
phases in `docs/type-blueprint.md` implement it.

```bash
npm install
npm run typecheck
```

`src/types/*.ts` declares the domain (Program, Issue, Pull request, CI run, events,
commands, roles, tools, storage and service ports); `src/index.ts` re-exports the
types only.
