# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
semantic versioning: `0.x` minor versions carry behaviour, patch versions carry fixes.

## [Unreleased]

### Added

- Migration to the DeepSeek Harness Super-agent composition: the `aleph` Source,
  prepare-generated ticket repositories, bwrap read confinement, Host-authoritative
  evaluation with a results log, budget-tiered admission, a resident Watchdog
  Session, an AlephResearch Web panel, versioned hot configuration and extension
  code hot reload.
- `scripts/superagent-*.sh`: lab, case, smoke, soak, prepare and case stop.
- 108 extension tests, run locally by `scripts/verify.sh` and in CI.
- uv bundled in the case runtime plus ticket-level dependency guidance (`ALEPH_UV`),
  declared compute resources on requests (GPU/heavy CPU escalates to a person), and a
  versioned research methodology appended to every ticket AGENTS.md.

### Removed

- The old Leader / Composer / Researcher / Batch plugin, its operator skills and its
  driving scripts; they are archived under `archive/` and no longer part of the
  runtime, configuration or CI.

- Operator skills for the Leader, researchers, the Composer and InfraOptimizer.
- Web search and fetch for the Leader and for researchers, through the account-backed
  DeepSeek search and fetch providers.
- A single opening researcher that starts a project; the Host reclaims it after the
  first evaluation and starts the configured cohort.
- Leader-written researcher assignments: `instruction` for a shared assignment and
  `instructions` for one per researcher.
- Pause, resume and cancel operations for a project and for a single batch, with
  operator routes and a console flag.
- An evaluation table in the console: time, branch, score, scored commit, report
  commit and report ref.
- `scripts/github-watch.sh`, `scripts/verify.sh` and repository git hooks.
- Project conventions as a per-project field, so case-specific rules never live in
  the plugin.

### Changed

- A machine is described by sampled telemetry plus a declared load list instead of a
  boolean, and a prepared batch no longer claims the machine before it runs.
- Missions declare `kind`, `title` and `summary`, so later researchers can find and
  reuse their results.
- The researcher contract lives in the preset persona; the Host message carries only
  session coordinates and the Leader's assignment.
- InfraOptimizer is one long-lived agent per machine, edits only, and is dispatched
  without blocking the Composer.
- Starting a batch returns immediately instead of holding the Composer's turn.

### Fixed

- A researcher creating a mission no longer overwrites the project's orchestrator
  session, which used to drain the cohort permanently.
- Evaluation scores committed code only, refuses a dirty worktree, and stops its whole
  process tree before removing the input directory.
- Mission environments the shared runtime already satisfies are no longer rebuilt,
  which removes the `ModuleNotFoundError` failures for `lightgbm` and `sklearn`.
- Batch failures carry the runner's output, and a batch whose runner died is settled by
  the watchdog.
- The console reads agent records from the snapshot and shows commit refs without a
  stray parenthesis.
- A Host restart resumes interrupted batches and researcher sessions instead of
  starting replacements.

## [0.3.0]

Initial public shape of the Host plugin: project and mission repositories, machine
bound batches, result cherry-picks, evaluation reports, the operator API and the
console.
