# 状态

## 已完成

- 顶层状态改为 DSH workspace/project，使用 `aleph_project` storage domain。
- research repo 与 mission repo 分离；mission repo 从 `template` 初始化。
- Mission 提案、Leader 审批、approved queue 已实现。
- MissionComposer 已作为 `aleph-composer` 子代理接入，创建机器绑定的 batch
  并合并 mission 分支。
- InfraOptimizer 已作为 `aleph-infra` 子代理接入，在 batch worktree 中优化
  合并代码，然后运行 batch entrypoint。
- 单一 batch entrypoint 会为每个 mission 写 result envelope。
- 每 mission 的 result commit 会 cherry-pick 回 pre-batch mission branch。
- researcher 由 `aleph_run_researcher` 启动，只等待自有 mission，调用
  `aleph_evaluate`，Host 将报告写入 research commit。
- 控制台显示项目、研究仓库、mission 仓库、机器、编排 agent、batch 与 mission
  结果提交。

## 隔离 DSH 验证

项目 `p-5e07aced`：

- mission `mission/test2` 经历 propose、approve、batch、run。
- batch `b-b034c9fc` 状态 done。
- 结果文件 `results/m-test2/result.json` 写入 mission branch。
- researcher evaluate 返回 score `1`，research commit `982b6cf` 写入报告。

项目 `p-1877e11f`：

- MissionComposer 创建 batch `b-9c817dea` 并绑定 local 机器。
- InfraOptimizer 完成 batch 优化与运行；batch 状态 done，机器恢复 idle。
- mission `m-79a0a937` 结果写入 `results/m-test4/result.json`，结果提交
  `eacf7b6` cherry-pick 回 `mission/test4`。
- researcher 子会话 `f4fce692` 完成研究、evaluate，并写入 research commit
  `7fe854e`。

## 测试

`dsh-plugin/test/project.test.mjs` 使用临时 git repo 与 mock storage table 覆盖：

- project 初始化与 template branch
- mission 提案、自有 mission 等待、其他 researcher 不阻塞
- Leader 审批
- Composer 合并 batch
- batch 运行与 per-mission result envelope
- 结果 cherry-pick 回 pre-batch mission branch
- research evaluate 与报告写入 research commit

运行方式：`cd dsh-plugin && npm test`。

## 待完成

- 多机接口。
- 更完整的 Composer 冲突解决与结果归因。
- 旧 client 中未使用代码清理。


## 2026-10-31 测试案例重建

旧测试案例目录 `/tmp/aleph-dsh-lab2` 已删除，新案例位于：

- `DSH_HOME=/tmp/aleph-case-lab`
- 项目工作区：`/tmp/aleph-case-lab/leader`
- 项目 id：`p-b2073163`

只复制了 `problem/`；`data/` 中的内容全部是从 `problem/data.zip` 派生出来的，
未复制到案例中。`.venv`、notebooks、outputs、catboost_info、aleph-case 等工程
产物也未复制。原工程 `/home/hapenia/Projects/kunlungpt-comp` 未写入。

项目初始化创建了 `research/` 与 `missions/` 仓库，以及模板分支；`problem/` 位于项目根目录。项目默认 researcher 数量为 4。

## End-to-end run

The rebuilt case project completed the full pipeline for the first time.

| Stage | Evidence |
| --- | --- |
| Research | researcher branches with `predict.py` and notes |
| Mission | proposed branches with manifest, entrypoint and uv project |
| Batch | `b-8b68c816` with three approved missions |
| Result | per-mission `result.json`, `metrics.json`, `run.log` and model bundles committed back |
| Evaluate | hidden-testset score `79.72` written into research commit `afb9633` |

Mission scores on the hidden-holdout split, with the floor baseline as reference:

| Mission | Score | Floor |
| --- | --- | --- |
| atom-cv-plus | 80.24 | 70.18 |
| atom-seq-blend-cv | 80.18 | 70.18 |
| atom-oof-ensemble | 79.79 | 70.69 |
| atom-snap-hgb | 70.84 | 70.69 |

The operator API (`/api/aleph/approve`, `/api/aleph/batch`, `/api/aleph/run`,
`/api/aleph/evaluate`) replays this pipeline without spending a model turn.

## Upstream review

The open issues and pull requests were reviewed against the current project
model. Pull requests were not merged because their base predates the project
refactor; the accepted behaviour was reimplemented and covered by tests.

Adopted:

| Upstream | Behaviour now in the tree |
| --- | --- |
| PR #18 / issue #16 | one activation only settles its own record; a missing identity is refused |
| PR #20 / issue #19 | evaluation reports pin the scored commit and keep an independent ref |
| PR #21 / issue #7 | result delivery advances the mission branch by compare-and-swap |
| PR #2 / issue #1 | console shows the empty state instead of a snapshot failure |
| issue #6 | startup reconciles interrupted batches and frees the machine |
| issues #11, #12 | evaluation history and best-score tracking with a select route |
| issue #14 | single Composer and InfraOptimizer activation per project |

Deliberately left open: #3, #4, #5 describe concurrency and budget limits that
belong to a multi-machine model, #8 asks for strategy text that the mission
prompt already carries, #9 is covered by the persistent Composer, and #10
(pause, resume, cancel, finish) an operation surface that is still missing.

## Machine load

A machine is no longer a boolean. Each machine carries:

- `telemetry`: Host-sampled cores, one/five/fifteen minute load average, CPU
  utilisation, memory available and total, and per-GPU utilisation and memory.
- `loads`: the list of work the Composer believes is running, replaced as a whole
  by `aleph_machine_load` the way a todo tool replaces a todo list.

The batch runner adds its own entry when a batch starts and removes it when the
batch ends, so the list stays truthful even if the Composer is idle. A prepared
batch does not claim the machine; only execution does. The console shows both the
declared load and the sampled telemetry.

## Iteration four

A clean run of the whole loop on a fresh project (`p-9f9dcb04`) exercised the
new orchestration without any manual batch step.

- Approving two missions started the persistent Composer by itself, which then
  formed `b-74cb40bc` and started it while the machine was idle.
- The machine reported live telemetry (24 cores, load average, 16.5 of 33.4 GB
  free, GPU utilisation) and a load list holding the running batch at 16 threads.
- The batch finished 1 of 2 missions. The done mission persisted its report,
  model bundle, OOF predictions and metrics (OOF score 79.54); the failed one
  left a readable `KeyError: 'PERM'` traceback in its run log.
- The machine returned to idle with an empty load list.

Evaluation attribution held on the same run: the report commit's parent is the
scored commit, each evaluation kept its own `refs/aleph/evaluations` entry, and a
later weaker score (68.94) did not displace the best result (69.85).
