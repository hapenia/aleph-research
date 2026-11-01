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

## Phase 1b: presets, sessions, tool and trigger bridges

Implemented after the first runtime milestone:

- **Presets and session pool** (`research-sessions.js`): `aleph-operator` and
  `aleph-researcher` presets, deterministic operator/researcher Session ids,
  resolve-or-create with preset/workspace checks, bounded and deduplicated
  `followup` wake-ups, pool sizing and failure tolerance; provided as
  `alephResearchSessions` and disposed with the fiber. 22 tests.
- **Tool execution bridge**: `research-host.js` provides `alephResearchHost` with
  `executeTool`, mapping the 23 runtime tools to HTTP writes/reads with role-derived
  actors; `research-tools.js` consumes it and no longer fails with "no injected
  handler" when the host is present.
- **Trigger bridge** (`research-trigger-bridge.js`): converts `ResearchTriggerDraft` to
  the prototype Trigger shape and delivers it to `ctx.orchestrator.context('aleph')`,
  with failures logged and isolated. Unit-tested; the live prototype Eval path remains
  for the case run.
- **Research panel**: the client defaults to a Research runtime tab with health,
  programs, snapshot details, audit and attention; the legacy loop stays under a second
  tab. 7 static tests.
- **Case migration dry run** (`research-case-migrate.sh`): validates build/config/legacy
  markers, prints the exact Program/Issue envelopes, and with `--apply` creates them and
  verifies the snapshot. It intentionally refuses `--apply` while the archived legacy
  `.aleph` marker exists; no Experiment, worker or evaluation starts.

Extension tests are **206**; the focused host/tool/trigger/session suites are 52.
The latest lab smoke (`team-final2-0652`, port 40392) passed **11/11** with
`persistent:true`, zero activation warnings, evaluation score 80, three worker commits and
clean teardown (startup 15.5 s, worker turn 32.1 s, total 55.8 s). The harness now waits
for `running=0` **and** `queued=0`; the earlier 22 s failures were a smoke race, not a
runtime regression.

## What remains (excluded from this completion)

- The actual 24-hour case run and its evidence; the legacy case is frozen and the
  migration script is dry-run-only until the marker is retired by a person.
- Live prototype Eval/Ticket-driven research loop: the trigger bridge is unit-tested and
  mounted, but no real case has exercised the new Program/Issue/Experiment loop yet.
- Production packaging of `research-core/dist` inside the installed extension is handled
  by the lab build step; a published package layout is still a deployment concern.
