# DSH-native project architecture

## Top-level state

One DSH workspace/project owns:

- `research/` git repository for researcher work.
- `missions/` git repository initialized from a fixed `template` commit.
- MissionQueue, BatchQueue, machine registry, agents and result records in the
  `aleph_project` storage domain.

No campaign layer, external daemon, SQLite sidecar or `~/.aleph` directory is
used.

## Mission packaging

A mission branch is created from `template` by the researcher. It contains:

- `missions/<mission-id>/mission.json` with id, entrypoint, output declaration
  and resource hints.
- mission code and an uv project.
- a single batch entrypoint contribution.

`aleph_create_mission` returns a branch and worktree that are already a valid mission:
manifest with kind, title and summary, an executable entrypoint, a code stub and a
pyproject. `aleph_propose_mission` validates the branch ancestry and manifest, records the
owner session, and puts the mission straight into the dispatch queue. There is no
approval step.

## Opening phase

Preparing a project starts exactly one researcher. It takes the first experimental
pass and evaluates a method; a completed evaluation, or the researcher settling,
hands the project over: the Host reclaims that session and starts the configured
researcher cohort. The opening instruction is the ordinary researcher prompt, so
the phase is a scheduling rule rather than a special task.

## Composer and machines

MissionComposer is created when the project is created, as a direct child of the
Leader session, and stays addressable for the whole project. It inspects the queued
queue and calls `aleph_form_batch`.

- One machine runs one batch at a time and the batch owns that machine.
- The batch branch is created from `template` and merges queued mission
  branches.
- Composer resolves merge conflicts and records each mission's pre-batch tip.
- A single merged entrypoint runs the missions and writes per-mission outputs.
- Starting a batch returns immediately; compute runs in the background so the Composer keeps
  managing the queue while the machine works.

## InfraOptimizer

InfraOptimizer is an `aleph-infra` DSH subagent. It never executes code: it edits
the batch worktree while the machine is serving another batch, because a
benchmark beside a full batch both steals capacity and measures the wrong thing.
Its handoff states the change, the reasoning and the expected impact, marked as
unmeasured. A stray process under its worktree is killed by the watchdog.

There is one InfraOptimizer per machine, started once and kept for the project so
its knowledge of the machine accumulates across batches. `aleph_run_infra` hands it
a prepared batch and returns immediately; the optimizer calls `aleph_finish_infra`
when its edits are ready, and the Host then commits, removes the worktree and
returns the batch to the queue.

It receives the batch worktree,
profiles the target machine, optimizes the merged code for CPU/GPU/memory/IO,
commits the optimization to the batch branch, and runs the batch entrypoint.
It does not set project budget, queue or scheduling constraints.

## Result delivery

The batch runner writes each mission result to
`results/<mission-id>/result.json` and artifacts. Host creates a per-mission
result commit and cherry-picks it onto the pre-batch mission branch. The result
envelope has fixed routing fields and free-form metrics/artifacts.

## Researcher lifecycle

The project default researcher count is 4. `aleph_run_researchers` starts that
many researcher subagents; each receives a separate research branch and
worktree. A researcher may propose several missions over its lifetime.

Researcher prompts require inspecting the complete git history of both research
and mission repositories with `git log --all`, `git branch -a`, `git show` and
`git diff`. Before proposing a mission, the researcher must check mission
branches and result commits for an equivalent mission. Already-run missions must
not be rerun; their result commits and envelopes are read instead.

The researcher waits only for missions owned by its session. When those missions
are done, `aleph_evaluate` evaluates the research branch; the Host writes the
evaluation report into the research commit message and the researcher finishes.

## Current boundaries

- One local machine; multi-machine is an interface extension.
- Composer conflict handling is one merge attempt and fails to the operator.
- Batch optimization is agent-driven and bounded by prompt.
- The core project/mission/batch/result/evaluate path has an automated
  integration test in `dsh-plugin/test`; multi-machine and richer conflict
  handling remain future work.
