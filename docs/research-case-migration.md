# Research case migration: Program / Issue / Experiment

This is Phase 1 migration tooling, not a research run. The tool creates a Program and
its Issues, verifies the Host snapshot and audit trail, and stops there. It never
proposes an Experiment, requests CI, starts a Worker, runs an evaluation, or deletes a
legacy file or branch. No 24-hour case is involved.

The executable is [research-case-migrate.sh](../scripts/research-case-migrate.sh).
`--dry-run` is the default and makes no HTTP request.

## Object mapping

| Legacy case object | New object | Migration note |
| --- | --- | --- |
| Project: `project.json`, case research repository, visible data, evaluator, conventions | **Program** | One goal, methodology, evaluation contract, utility config, exploration level and budget. Host-owned persistent state. |
| Mission: a coarse research direction, compute batch or grouped work branch | **Issue** | One research question with acceptance criteria. A mission that contains several independent questions becomes several Issues. |
| Ticket: one work item or attempt | **Experiment** | One attempt at an Issue, with lineage, base commit, branch, environment declaration, CI records and artifacts. It is a snapshot, never merged. |
| Case run, `results.jsonl`, `soak.jsonl`, `.aleph` evidence, best-score notes | **CI runs, raw metrics, artifacts, audit** | Host-owned records after cutover. Archive the legacy evidence separately; the migration script does not import it. |

The mapping is not a mechanical one-ticket-to-one-Issue conversion. A legacy ticket is
usually an **Experiment**, not an Issue. Tickets that were really distinct research
questions become Issues; tickets that were attempts at one question stay as Experiments
under the Issue. This is why the script creates only Program + Issues.

The design reason is the runtime-safety contract: `experiment.propose` requires a
Host-injected `IssueAssignment`, and a ready Experiment requires an Implementer
`TicketBinding`. An HTTP caller cannot supply either proof. A migration tool that forged
them would bypass the ownership checks. Experiment migration therefore stays manual.

Programs are not merge targets. Closing the last Issue ends a Program, or the Operator
stops it when the budget is exhausted.

## What the script does

Preflight, in both modes:

1. Checks that `research-core/dist/adapter/composition.js` and `dist/runtime/api.js`
   exist, and warns when `dist/` looks stale. With `--start-lab`, a missing `dist/` is a
   warning because the lab builds it first.
2. Requires a Host URL (`--url` or `ALEPH_RESEARCH_URL`). `--start-lab` is only accepted
   with `--apply`.
3. Detects legacy markers: branches matching `(^|/)research/r-*` and directories named
   `.aleph` (the repository is always scanned; add roots via `ALEPH_LEGACY_SCAN_ROOTS`).
4. Loads and validates the case config, including required fields, metric names,
   exploration level, positive budget counters, allowed Issue labels and unique Issue
   titles.

`--dry-run` then prints the exact request envelope, the transport route, the inner
command route and every Issue request with a `<programId>` placeholder. It does not
contact the URL.

`--apply` then:

1. Starts a lab only when `--start-lab` was given, with
   `ALEPH_SUPERAGENT_SMOKE=0` so no research request is sent. The lab is stopped on exit;
   its run directory and log are kept.
2. Waits for `GET /aleph/api/research/health` with a bounded deadline.
3. Refuses a host whose health reports `persistent:false` unless `--allow-ephemeral` is
   explicit, because migrated state must survive a host restart.
4. Refuses a duplicate Program name unless `--allow-duplicate` is explicit. A Host that
   cannot list Programs only produces a warning.
5. Creates the Program through `POST /aleph/api/research/requests` with
   `path: /aleph/api/programs` and `actorKind: operator`.
6. Creates one Issue per configured Issue through the same transport with
   `path: /aleph/api/programs/<programId>/issues`.
7. Reads `GET /aleph/api/research/programs/<programId>` and verifies the Program is
   `running`, every created Issue is `open`, `program.created` and `issue.created` are in
   the audit, and the response-level audit matches the snapshot-level audit.
8. Prints every created id. A partial failure prints the Program and Issue ids created
   before the failure; there is no write retry and no rollback.

Every HTTP call has `--connect-timeout` and `--max-time`. Health waiting is a bounded
loop, not an unbounded poll. No write is retried, because Program/Issue creation is not
idempotent.

## Case config

A small config has a `case` section and an `issues` array. `program` is accepted as an
alias for `case`. `--print-sample-config` prints a complete example.

```json
{
  "case": {
    "name": "kunlungpt-migration",
    "goal": "Predict porosity, permeability and water saturation for unseen wells.",
    "methodology": "Keep a reproducible baseline and iterate only through measurable Issues.",
    "contract": {
      "ciEntry": "sh eval/run_eval.sh",
      "timeoutMs": 900000,
      "requiredMetrics": ["score"]
    },
    "utility": {
      "metrics": [
        {"name": "score", "direction": "higher", "weight": 1.0, "required": true}
      ]
    },
    "exploration": "normal",
    "budget": {"maxExperiments": 12, "maxComputeMinutes": 120, "maxTokens": 200000}
  },
  "issues": [
    {
      "title": "Reproduce the legacy baseline",
      "body": "Recreate the baseline and let CI establish the first score.",
      "labels": ["research"]
    }
  ]
}
```

- `name`, `goal`, `methodology` and `contract.ciEntry` must be non-empty strings.
- `contract.requiredMetrics` and `utility.metrics` must be non-empty. Metric names are
  1-64 printable characters; directions are `higher` or `lower`; weights are positive.
  `required` is accepted and dropped by the runtime, which derives requiredness from
  `contract.requiredMetrics`.
- `exploration` is `low`, `normal` or `high`. The budget counters are positive integers.
  Budgets are fixed at creation: the Phase 1 runtime has no `setBudget` route yet.
- Each Issue needs a non-empty `title`, a non-empty `body`, and at least one label from
  `research`, `experiment`, `analysis`, `bug`, `blocked`. Titles must be unique.

Configuration can come from environment variables instead of `--config`:

| Variable | Meaning |
| --- | --- |
| `ALEPH_PROGRAM_NAME`, `ALEPH_PROGRAM_GOAL`, `ALEPH_PROGRAM_METHODOLOGY` | Program fields (required in env mode). |
| `ALEPH_CI_ENTRY`, `ALEPH_CI_TIMEOUT_MS` | Evaluation contract. |
| `ALEPH_REQUIRED_METRICS` | Comma-separated required metric names. |
| `ALEPH_UTILITY_METRICS` | JSON array of metric definitions. |
| `ALEPH_EXPLORATION` | `low`, `normal` or `high`. |
| `ALEPH_MAX_EXPERIMENTS`, `ALEPH_MAX_COMPUTE_MINUTES`, `ALEPH_MAX_TOKENS` | Budget counters. |
| `ALEPH_ISSUES_JSON` | JSON array of `{title, body, labels}`. |
| `ALEPH_RESEARCH_URL`, `ALEPH_CASE_CONFIG` | Host URL and config path. |
| `ALEPH_LEGACY_SCAN_ROOTS` | Colon-separated additional roots for the `.aleph` scan; the repository is always scanned. |

## Commands and exit codes

```bash
# Inspect the exact requests. No network, no lab.
scripts/research-case-migrate.sh --dry-run \
  --config /tmp/case.json --url http://127.0.0.1:40201

# Create against an already-running persistent Host.
scripts/research-case-migrate.sh --apply \
  --config /tmp/case.json --url http://127.0.0.1:40201

# Start a disposable lab, apply, and stop the lab on exit.
scripts/research-case-migrate.sh --apply --start-lab \
  --config /tmp/case.json

# Print a config skeleton.
scripts/research-case-migrate.sh --print-sample-config
```

Exit codes:

- `0`: dry-run completed, or apply completed and verified.
- `1`: configuration, build or transport failure. A failed apply may have created the
  Program and some Issues; the ids printed before the failure are the recovery set.
- `2`: `--apply` refused because legacy markers were found. Nothing was changed.

A dry-run with legacy markers still prints the plan (so the blockers and the intended
requests can be reviewed together), marks `--apply` as blocked, and exits `0`. The
write path is the one that refuses.

## Legacy marker checklist

The script reports markers but never deletes them. Its printed checklist is:

1. Freeze the legacy case workflow: stop case labs and send no new case/soak requests.
2. Preserve evidence before cleanup: copy run directories, `results.jsonl`,
   `soak.jsonl` and `.aleph` artifacts to an archive; keep more than one copy if the
   evidence matters.
3. Inventory the project, missions and tickets. Classify tickets as Experiments under
   an Issue, or as separate Issues when they were separate questions.
4. Keep `research/r-*` branches and `.aleph` directories read-only during the shadow
   period. Do not merge, push or delete them from the migration tool.
5. Re-run dry-run, then apply, only after a person has archived or explicitly retired
   the markers.
6. Enter the shadow phase below before switching researchers.

## What remains manual

- **Experiment implementation.** A Researcher claims an Issue, writes the plan as Issue
  comments and proposes an Experiment. The Host samples the base and opens the
  Implementer ticket. The Implementer branches from the assigned base commit, writes
  code, declares the environment, commits and marks the Experiment ready. A Researcher
  then requests CI explicitly; the Host runs the evaluation. None of this is done by
  this script.
- **CI and scoring.** The script creates no CI request and runs no evaluation. It only
  verifies the Program snapshot/audit after creation.
- **Repository, data and environment preparation.** The research scaffold branch,
  visible-data copy, evaluator entry point, runtime and `.aleph`-free package must be
  prepared and tested separately before the first Experiment.
- **Knowledge import.** Legacy notes, results tables and artifact locations need a
  human-curated mapping into Issue bodies or the Program methodology.
- **Retiring legacy artifacts.** Branch and directory deletion, if any, is a separate
  reviewed operation. This script does not do it.
- **Budget changes.** Choose the budget before apply; there is no Phase 1 `setBudget`
  route.

## Two-phase cutover

### Phase 1: shadow

Goal: prove the Program/Issue path while the legacy workflow remains the source of truth.

- Freeze new legacy case/soak requests; keep existing legacy runs and evidence
  read-only.
- Run the migration dry-run in CI or by hand and archive the printed payload.
- Apply against a **shadow** Host (a persistent lab, not the production Program).
- Verify `GET /aleph/api/research/programs/<programId>`: Program `running`, Issue count
  and statuses, `program.created`/`issue.created` audit, and response-level audit.
- Map every configured Issue back to its legacy mission/ticket. Record unmapped tickets
  and the decision to keep them as Experiments or new Issues.
- Optionally have one Researcher claim one shadow Issue and propose one Experiment
  manually, with a small budget, to exercise the rest of the lifecycle. This is a manual
  validation, not part of the migration script; skip it if no disposable Host is
  available.
- Rehearse rollback: stop the shadow Program and confirm no legacy file changed.

Exit criteria: snapshot/audit match, all Issues mapped, rollback understood, legacy
evidence archived, and no `research/r-*` or `.aleph` marker is still needed by an active
run.

### Phase 2: switch

- Freeze the legacy workflow completely. Take a final evidence copy.
- Apply the migration to the cutover Host (or promote the verified shadow Program if it
  is the same persistent Host).
- Point Researchers at the Program and its Issues. Disable instructions that start new
  legacy cases; keep the old run directories for reference.
- Archive or retire `research/r-*` branches and `.aleph` directories through the normal
  review process; leave the migration script out of deletion.
- Watch attention, budget counters and the first manual Experiment proposals. The Host
  owns state; the research repository holds code and environment declarations only.

### Rollback

The migration script never deletes, so rollback does not need data restoration for the
legacy side.

- **Before switch:** keep using the legacy workflow. Stop or pause the shadow Program
  with an operator request:
  `POST /aleph/api/research/requests` with
  `{"path":"/aleph/api/programs/<programId>/stop","actorKind":"operator","body":{"programId":"<programId>","reason":"shadow rollback"}}`.
- **After switch but before new Experiments:** stop the Program with the same request,
  re-enable the legacy instructions and keep the old runs read-only. No legacy file was
  modified.
- **After new Experiments:** stop or pause the Program, export the snapshot and audit,
  and return Researchers to the frozen legacy workflow. The Experiments stay in the
  Program as inspectable snapshots; do not delete them to force a rollback.
- **Partial apply:** the printed Program/Issue ids are the recovery set. Do not blindly
  rerun, because the duplicate-name guard will refuse. Inspect the snapshot, then create
  only the missing Issues through the same route, or stop the partial Program.

## Out of scope

This document and tool do not perform a real research case, a 24-hour soak, an
Experiment proposal, CI, evaluation, Worker startup, branch deletion or legacy data
deletion. They are the migration seam between the legacy case workflow and the Phase 1
runtime.
