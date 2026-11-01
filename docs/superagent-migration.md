# Migrating onto dsh-superagent

This repository is moving its orchestration from the in-repo
Leader / Composer / Researcher / Batch plugin onto the DeepSeek Harness
Super-agent architecture. The design is recorded in the approved migration plan;
this document tracks what is actually in the tree.

## Reference

- Prototype: `vendor/dsh-superagent` (pinned snapshot, see `vendor/dsh-superagent/VENDOR.md`)
- Upstream: <https://github.com/deepseek-ai/dsh-superagent-prototype>
- Concept model: `docs/001-domain.md` (Source, Trigger, Thread, Eval, Mandate, Ticket,
  Assignment, Subscription), `docs/003-execution.md` (Executor), `docs/004-prompts.md`
  (hot prompt versions), `docs/007-architecture.md` (Engine, Outbox).

## Why

The old plugin's wake-ups depended on a live parent session, so a cold browser
session parked notices and stalled the loop; the Composer forked owners, polled, and
needed fallbacks to keep dispatching. The prototype owns a resident main Session
inside the plugin, treats work as Tickets with explicit authorization, and stores
external work in an Outbox that retries, which removes those failure modes.

## Composition

A dedicated profile mounts the prototype bundle alone first:

```text
dsh-base + dsh-web-app + dsh-superagent (vendored)
```

`scripts/superagent-lab.sh` builds the vendored copy when needed, creates an isolated
`DSH_HOME` and `stateDir`, configures the deployment check, starts the host and waits
until the main Session exists. It writes `<run>/run.json` with the panel URL.

The deployment check needs a GitHub account and repository even while the GitHub
Source stays off, because workers receive `gh`/`git` shims. The lab points it at a
repository the agent account can push to and keeps the Source disabled:
`source:github = {enabled: false, config: {repository, cli: "gh"}}`.

`gh` keeps its login in the operator keyring, so the lab passes `GH_CONFIG_DIR`; a
`GH_TOKEN` environment variable would be scrubbed from child processes by the
harness (`KEY|PASSWORD|SECRET|TOKEN` names).

## Verified on this tree

2026-11-01, lab `sa2` (port 40203):

- the bundle loads with zero "did not activate" entries;
- the deployment check resolves to account `hapenia` and repository
  `hapenia/aleph-research`;
- the main Session (`orchestrator-…`) exists and `runtime` reports ready;
- after a full host restart the same main Session id returns, setup stays resolved,
  and `runtime` is ready again — the resident loop does not need a browser;
- the panel serves the application shell and references `dsh-superagent`.

### Phase 1: the `aleph` Source

`superagent-extension` mounts on top of the prototype bundle and registers a local
research Source through the supported seam (`ctx.orchestrator.sources.register`):

- kind `aleph`, one project per Source instance, config field `project`;
- Threads `research:<project>:ticket:<ticket>`;
- Triggers: `request`, `result`, `timer`, `note`, with stable ids
  `aleph:<kind>:<requestId>`; a Channel reference points at the same Thread;
- Policy part: an operator allowlist, defaulting to `operator`, so a local request can
  originate work while other senders cannot;
- management routes `POST /aleph/api/trigger` and `GET /aleph/api/state`, enough to
  inject a local research request and inspect open Tickets.

Verified in lab `sa5` (port 40206): after the policy granted one enabled research
rule and `eval.mode = auto`, a request produced a Ticket with an **explicit** Mandate
(`sender: operator`), the assignment launched a Worker Session, and the ticket
directory `state/work/well-data-profile-…` appeared. The Source reports `ready` and
one `received` event.

### Phase 1: prepared ticket worktrees

`scripts/superagent-prepare.sh` is the Executor prepare command. It creates one worktree
from the research repository's template branch (`ticket/<name>`), copies only the data
directory named by the Source configuration, and writes `AGENTS.md` with the data
policy, the runtime and the project conventions. `ALEPH_*` execution variables come
from the Source kind, so the panel edits them and no restart is needed.

Verified in lab `sa7` (port 40208) with a fixture repository and a two-row CSV:

- a request produced a Ticket, an Assignment and a prepared worktree
  `state/work/count-well-por-floor-…` on branch `ticket/count-well-por-floor-…`;
- the worktree contains `AGENTS.md`, the copied `data/labels.csv`, and a prepare commit;
- the Worker read the data, wrote `analyze.py` and `findings.md`, ran the analysis and
  committed the result, staying inside the worktree.

### Phase 1: read confinement with bwrap

DSH's stock sandbox governs writes only, and the prototype pins its sessions to
`danger-full-access`, so a Worker could read the host filesystem. Three pieces fix that:

- `vendor/patches/0001-configurable-session-permission.patch` lets a deployment choose
  the session permission preset (`ALEPH_SESSION_PERMISSION`); the lab sets
  `workspace-write`.
- `scripts/bwrap-restricted.sh` is a bwrap-compatible runner installed as the sandbox
  provider's `runnerCommand`. It drops the profile's read-only host root and binds only
  the allowed system roots, so `/home` and the source data stay invisible; the
  workspace and its build toolchain remain reachable.
- `scripts/superagent-prepare.sh` now creates a **self-contained repository** in the
  ticket directory (`git init` + fetch the template branch) instead of a linked
  worktree, so the Worker needs no access to the research repository itself.

Verified in lab `sa13` (port 40214) with a Worker-issued report:

```text
ls -d /home/hapenia                    -> No such file or directory
ls -d <run>/fixtures/data              -> No such file or directory   (source data hidden)
git status --short --branch             -> ## ticket/confinement-report-…
```

The same run's analysis Worker wrote `findings.md` and committed it inside the sandbox
(`Add porosity summary: rows per well and clipped floor`).

### Phase 1/2 building blocks

Three standalone modules landed so the remaining wiring is small:

- `superagent-extension/evaluation.js`: runs the project evaluator through
  `bash -lc` with a unique `ALEPH_EVALUATION_ID`, parses the last JSON line carrying a
  finite `score`, and on timeout kills every process that carries the marker before
  resolving with `timedOut: true`.
- `superagent-extension/config-store.js`: versioned configuration with atomic writes,
  a 50-entry history, `restore`/`rollbackLast`, and a validator hook; the basis for hot
  modification with versions and rollback.
- `superagent-extension/research-channel.js`: the local research Channel, an
  append-only JSONL log with idempotent sends and a link back to the research panel.

### Phase 2/3 building blocks from the agent team

Three modules were written by teammates in isolated worktrees and reviewed before merge:

- `superagent-extension/budget.js`: tier classification (`explore`, `analysis`,
  `training`, `design`) and budget-tiered acceptance, so cheap work auto-accepts while
  training or design work becomes an issue for a person.
- `superagent-extension/watchdog.js`: stall detection over open Tickets
  (45-minute default), counts, and a Markdown brief for a Watchdog Session that
  suggests stop, retry-or-check, or blocked-on-person.
- `superagent-extension/results.js`: append-only, idempotent evaluation log with
  best-result selection, trajectory, summary and a brief for the main Session.

All three are pure Node ESM with no dependencies; 98 extension tests pass in total.

### Phase 1 acceptance and Phase 2 start

An independent verification run on `main` 0a17b4a (real `gh`, no stub) observed the whole
path in 408 s:

- ticket worktree prepared from the fixture, `findings.md` committed (`bbc09e7`);
- `aleph_submit_result` visible in the Worker's tool list and called once; the result
  carried `ok: true`, `score: 80`, the committed SHA and an `evaluationMarker`;
- the fixture printed `{"score": 80.0}` and `.aleph-eval-ran` named the same commit;
- the Channel log held two records (acknowledgement and final report);
- the Host log had zero activation warnings; the ticket closed with `running: 0`.

The result submission now also appends to the results log (`ALEPH_RESULTS_DIR`) and
reports the best score and commit next to the new score; `GET /aleph/api/results`
returns the brief, the best record and the recent evaluations for the panel and the
Watchdog.

### Phase 4: the research panel

`superagent-extension/client.js` is a Web client plugin registered by the same bundle:
it adds an "AlephResearch" page and sidebar entry with the results summary (best score,
commit, trajectory), the open tickets with their worktrees, and the orchestrator load
and health. It polls the three routes every 10 s and disposes its timers with the page.

The panel's "reload research extension" button POSTs `/aleph/api/reload`. The Host
answers, then restarts the plugin fiber, so the Source kind, routes and settings are
registered from scratch; module code that changed on disk still needs a host restart,
configuration does not. `scripts/verify.sh` and CI now syntax-check both extension
files.

Not yet done: hot configuration versions and rollback, the Watchdog Session, budget
wiring into acceptance, and retirement of the old plugin's roles.

## Next phases

1. `aleph` Source kind: local Threads, `result` / `timer` / `note` Triggers, Channel
   writes to the research panel, Policy part.
2. prepare command and Worker preset patch: worktree per Ticket, case conventions,
   `ALEPH_*` environment, research tools.
3. Authoritative evaluation service and `aleph_submit_result`.
4. Watchdog session with stop/retry.
5. Research panel, hot configuration with versions and rollback, and retirement of
   the old plugin's roles and batch model.
