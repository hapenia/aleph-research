# AlephResearch

AlephResearch is an automated research system built on DeepSeek Harness and the
Super-agent architecture (`dsh-superagent`). A research request becomes a Trigger,
the Host evaluates and authorizes it, and a Worker Session researches in its own
ticket repository while the Host scores the committed result.

The migration from the earlier Leader / Composer / Researcher / Batch plugin is
complete in code; `archive/legacy-plugin` keeps that implementation for history and
`docs/superagent-migration.md` records what each phase proved.

## Quick start

```bash
# once: build the case template and its runtime
./scripts/case-build.sh kunlungpt

# start a full case on the superagent composition
./scripts/superagent-case.sh kunlungpt case-1

# exercise the whole path on a tiny fixture (about 3 minutes)
./scripts/superagent-smoke.sh smoke-1

# sample an existing case lab unattended (24 h by default)
ALEPH_SOAK_RUN=/tmp/aleph-runs/case-1 ./scripts/superagent-soak.sh case-1 24

# stop and remove a case lab
./scripts/superagent-case-stop.sh case-1
```

`superagent-case.sh` prints the panel URL and token. Open the AlephResearch panel
to watch results, open tickets and the orchestrator load; the same data is served
by `GET /aleph/api/results`, `GET /aleph/api/state` and the prototype's
`GET /orchestrator/api/state`.

## How it works

- **Source**: the `aleph` Source accepts local research requests as Triggers on
  Threads `research:<project>:ticket:<ticket>`.
- **Admission**: the Host classifies each request into budget tiers; cheap work
  auto-accepts, `training`/`design` waits for an operator confirmation, and an
  optional hourly cap bounds automation (`POST /aleph/api/budget`).
- **Ticket**: accepted work becomes a Ticket with an explicit Mandate. The Executor
  create a repository per ticket: the prepare script starts it from the research
  repository's template branch, copies only the configured data directory and writes
  `AGENTS.md` with the data policy, runtime and project conventions.
- **Worker**: a Worker Session runs in that ticket repository. Shell reads are
  confined by a bwrap runner that binds only system roots and the ticket workspace,
  so the operator home, other projects and the source data stay invisible.
- **Evaluation**: `aleph_submit_result` refuses uncommitted work, runs the project
  evaluator with a marker that lets the Host kill the whole process tree, and feeds
  the score back as a `result` Trigger; the results log keeps the history and best
  score (`GET /aleph/api/results`).
- **Watchdog**: an optional resident Session (`ALEPH_WATCHDOG_INTERVAL_MS`) receives
  stall briefs and can stop or retry tickets.
- **Configuration**: research settings are versioned and applied hot
  (`/aleph/api/config`, rollback included); extension code reloads from the panel
  through `POST /aleph/api/reload`.

See `docs/architecture.md` for the full picture and `docs/superagent-migration.md`
for the phase-by-phase evidence.

## Repository layout

- `superagent-extension/`: the AlephResearch plugin (Source kind, tools, routes,
  panel, tests). This is the only runtime plugin now.
- `vendor/dsh-superagent`: pinned snapshot of the prototype, built locally with
  `scripts/build-superagent-vendor.sh` and the patch series in `vendor/patches`.
- `scripts/`: lab, case, smoke, soak and verification entry points.
- `docs/`: architecture, migration record, status and git workflow.
- `archive/`: the retired plugin, its operator skills and the scripts that drove it.

## Verification

`scripts/verify.sh` is the local gate: extension syntax, shell syntax, and the
extension test suite (108 tests). CI runs the same checks on every pull request,
and `main` is protected: every change lands through a pull request with a squash
merge.

## License

See `LICENSE`.
