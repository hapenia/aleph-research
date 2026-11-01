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

Not yet done in Phase 1: shell-level read confinement (the bwrap provider that hides
host paths), the evaluation tool, the reply Channel, and retirement of the old plugin's
roles.

## Next phases

1. `aleph` Source kind: local Threads, `result` / `timer` / `note` Triggers, Channel
   writes to the research panel, Policy part.
2. prepare command and Worker preset patch: worktree per Ticket, case conventions,
   `ALEPH_*` environment, research tools.
3. Authoritative evaluation service and `aleph_submit_result`.
4. Watchdog session with stop/retry.
5. Research panel, hot configuration with versions and rollback, and retirement of
   the old plugin's roles and batch model.
