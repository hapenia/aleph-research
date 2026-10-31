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

`aleph_propose_mission` validates the branch ancestry and manifest, records the
owner session, and puts the mission straight into the dispatch queue. There is no
approval step.

## Composer and machines

MissionComposer is created when the project is created, as a direct child of the
Leader session, and stays addressable for the whole project. It inspects the queued
queue and calls `aleph_form_batch`.

- One machine runs one batch at a time and the batch owns that machine.
- The batch branch is created from `template` and merges queued mission
  branches.
- Composer resolves merge conflicts and records each mission's pre-batch tip.
- A single merged entrypoint runs the missions and writes per-mission outputs.

## InfraOptimizer

InfraOptimizer is an `aleph-infra` DSH subagent. It receives the batch worktree,
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
