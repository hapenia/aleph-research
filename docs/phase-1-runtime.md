# Phase 1 runtime: implemented and lab-verified

Branch `feat/phase-1-runtime`. The TypeScript runtime is real code now, not only a
blueprint. This note records what exists, how it is verified, and what is deliberately
left for Phase 1b / Phase 2.

## Runtime modules (`research-core/src`)

| Module | Purpose | Tests |
| --- | --- | --- |
| `parsers.ts` | branded ids, commits, branches, timestamps, metric names, refinements | 43 |
| `parsers-commands.ts` | 16 command body parsers with Host fields omitted | 73 |
| `runtime/domain.ts` | pure Program/Issue/Ticket/Experiment/CI transitions + ownership checks | 24 |
| `runtime/storage.ts` | in-memory versioned repositories, read model, audit | 10 |
| `runtime/handlers.ts` | 16 command handlers, atomic writes, refusals, audit | 35 |
| `runtime/executor.ts` | parse → Host proof injection → one executor slot | 8 |
| `runtime/api.ts` | 16-route table, status mapping, refusal audit | 10 |
| `runtime/triggers.ts` | audit fact → typed trigger report/draft | 12 |
| `runtime/tools.ts` | 23 role tools with real schemas | 65 |
| `runtime/sampler.ts` | exact presets, weighted utility, Boltzmann draw | 14 |
| `runtime/composition.ts` (adapter) | `createResearchHost` end-to-end composition | 9 |
| `adapter/storage-domain.ts` | persistent UnitOfWork over an injected DomainStore | 11 |
| `adapter/dsh-domain-store.ts` | DSH table envelopes, CAS, serialized writes | 18 |
| `factories.ts` / `hydration.ts` | trust boundary construction + row validation | 30 |

All runtime tests: **362** (324 core + 38 adapter/integration at the time of the first
phase-1 run; the current suite is larger). `npm run typecheck`, `npm run lint`,
`npm run test:mutation` (13/13 mutations killed) and `bash scripts/build-check.sh` pass.

## DSH integration (`superagent-extension`)

- `research-host.js`: `/aleph/api/research/health`, `POST /requests`, `GET /programs`,
  `GET /programs/:id` snapshot, `GET /attention/:id`; persistent when
  `alephResearchStore` is present, in-memory otherwise; missing dist degrades to a 503
  health route instead of breaking the fiber.
- `research-storage.js`: declares `aleph_research` with ten envelope tables and provides
  `alephResearchStore`.
- `research-tools.js`: registers all 23 runtime tools with role gating and JSON-Schema
  conversion. YAML-only mounting provides no handlers and no research presets exist yet,
  so the tools are registered but not reachable from a session.
- `cordis.patch.yml`: mounts all three plugins after the existing extension rows.

## Lab evidence (2026-11-02)

Command: `ALEPH_SMOKE_KEEP=1 timeout 1500 ./scripts/superagent-smoke.sh team-integration-0615 40340`

- `GET /aleph/api/research/health` → `{"ok":true,"version":"research-host/1","persistent":true}`
- `GET /aleph/api/research/programs` → `{"ok":true,"count":0,"programs":[]}`
- host log has zero "did not activate", no error/warn lines; all three new fibers active
- smoke: **11/11 PASS**, worker evaluation score 80, three worker commits, channel present
- timings: lab startup 15.0 s, worker turn 44.2 s, total 63.3 s

The first integration run exposed a startup race: the host read `alephResearchStore`
before storage finished `open`, silently falling back to memory. The lab profile now
declares `inject: ['alephResearchStore']` for the host row, which makes ordering
deterministic and turns a storage failure into a loud activation/health failure.

## Deliberately not done in Phase 1

- Research presets (`aleph-operator`, `aleph-researcher`, `aleph-implementer`) and the
  session pool that creates/wakes them; the tools are registered but invisible.
- Tool handlers: a YAML mount injects no handler, so calls fail with the documented
  "no injected handler" error. A bridge from DSH tool execution to the research host is
  Phase 1b.
- A panel view of Programs/Issues/Experiments; the existing client still shows the old
  research loop.
- The prototype Eval/Ticket loop is not yet driven by the new runtime (TriggerPort is
  implemented and lab-mounted, but the main Session still uses the old extension path).
- A 24-hour run and case migration.

These are tracked in `docs/runtime-safety-contract.md` and the mechanism document.
