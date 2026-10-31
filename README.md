# AlephResearch

AlephResearch is a DSH-native research project plugin. A researcher works in a
research repo; hardware-heavy work is packaged as an independent mission repo
branch, approved by the Leader, composed into a machine-bound batch by
MissionComposer, optimized and run by InfraOptimizer, and returned to the
researcher through the pre-batch mission branch.

## Running a case iteration

A case is prepared once and copied per iteration, so a plugin change is always
exercised against the same inputs.

```bash
# once: build the template and its shared runtime
./scripts/case-build.sh kunlungpt

# every iteration: copy the template into an isolated run
./scripts/case-run.sh iter7
```

`case-build.sh` copies the problem statement, the evaluator, the visible wells
and the hidden testsets out of the read-only source project, and installs a
shared Python with numpy, pandas, scipy, scikit-learn and lightgbm. `case-run.sh`
copies that template into a new run root with its own `DSH_HOME`, leader
workspace, port and credentials, then prints the panel URL and project id.

Once researchers have proposed missions, `scripts/case-drive.sh` replays the
rest headlessly:

```bash
./scripts/case-drive.sh /tmp/aleph-runs/iter7 scaffold
./scripts/case-drive.sh /tmp/aleph-runs/iter7 approve
./scripts/case-drive.sh /tmp/aleph-runs/iter7 batch
./scripts/case-drive.sh /tmp/aleph-runs/iter7 run
./scripts/case-drive.sh /tmp/aleph-runs/iter7 evaluate
```

The template and runtime live under `.case-templates/` and are not committed.

## Repositories and state

A DSH workspace/project contains:

- `research/`: the researcher's own git repo and branches.
- `missions/`: a separate mission repo initialized from `template`.
- MissionQueue, BatchQueue, Machine registry, agents and results in the
  `aleph_project` DSH storage domain.

Aleph itself carries no case-specific rules. Anything a researcher needs to
know about a project, such as a submission format or a metric, arrives as that
project's `conventions` and is written into the research scaffold and the
researcher prompt. A mission is only a unit of approved compute: its contents
are the researcher's business.

There is no campaign layer and no `~/.aleph` directory.

## Mission lifecycle

1. Researcher works in the research repo and commits research changes. The
   researcher can inspect the complete git history of both research and mission
   repositories with `git log --all`, `git branch -a` and `git show`.
2. Before proposing a mission, the researcher checks mission history and
   branches for an equivalent mission that already ran. Already-run missions
   must not be rerun; their result commits and envelopes are read instead.
3. For a hardware-heavy task, researcher creates a mission branch from
   `template`, adds `missions/<mission-id>/mission.json`, code, uv project and
   entrypoint, then calls `aleph_propose_mission`.
4. Leader calls `aleph_approve_mission`; approved missions enter the queue.
5. MissionComposer (`aleph_run_composer`) merges approved mission branches into
   a machine-bound batch branch and resolves merge conflicts.
6. InfraOptimizer (`aleph_run_infra`) optimizes the merged batch code for the
   target machine, commits the optimization and runs the single batch
   entrypoint.
7. Each mission receives a result envelope and a result commit. The Host
   cherry-picks that commit onto the mission's pre-batch branch.
8. The researcher waits only for its own missions, calls `aleph_evaluate`, and
   the Host evaluates the research branch and writes the report into the
   research commit message.

The project default researcher count is 4. Each researcher gets a separate
research branch and worktree.

## Tools

- `aleph_init_project`
- `aleph_status`
- `aleph_propose_mission`
- `aleph_approve_mission`
- `aleph_run_composer`
- `aleph_form_batch`
- `aleph_run_infra`
- `aleph_run_batch`
- `aleph_evaluate`
- `aleph_run_researcher`
- `aleph_run_researchers` (default count 4)

## Install

```bash
npm install --prefix dsh-plugin
dsh plugin --profile web add "$PWD/dsh-plugin"
```

Reload the Web UI, open the project workspace, and choose `Aleph Research`.
The `Aleph` sidebar entry shows the project, machines, agents, batches and
mission queues.

For an isolated test profile:

```bash
./scripts/dsh-lab.sh
```

## Result envelope

Each mission result is a fixed envelope with free-form payload:

```json
{
  "schema": 1,
  "mission_id": "m-test",
  "batch_id": "b-...",
  "machine_id": "local",
  "status": "done",
  "metrics": {},
  "artifacts": [],
  "logs": [],
  "resource": {},
  "error": null
}
```

Results are committed to `results/<mission-id>/result.json` on the mission
branch and cherry-picked back to the pre-batch branch.

## Status

The project/mission/batch core, Composer agent, InfraOptimizer batch run,
result cherry-pick and researcher evaluate path have been exercised in an
isolated DSH. Run the core integration test with:

```bash
cd dsh-plugin && npm test
```

See `docs/STATUS.md` and `docs/architecture.md`.
