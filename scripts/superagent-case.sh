#!/usr/bin/env bash
# Start a full research case on the dsh-superagent composition.
#
#   scripts/superagent-case.sh [case-name] [run-name] [port]
#
# Builds a run directory with a fresh research repository, an evaluation wrapper that
# implements the case contract, and a project.json the lab seeds from. The initial
# research request is sent as a confirmed operator request, so the budget gate does
# not turn it into an attention item.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
case_name="${1:-${ALEPH_CASE:-kunlungpt}}"
run_name="${2:-case-$(date +%Y%m%d-%H%M%S)}"
port="${3:-}"
store="${ALEPH_CASE_STORE:-$repo/.case-templates}"
template="$store/$case_name/template"
runtime="$store/$case_name/runtime"
run_root="${ALEPH_RUN_ROOT:-/tmp/aleph-runs}/$run_name"

[ -d "$template" ] || { echo "no case template at $template; run scripts/case-build.sh $case_name" >&2; exit 1; }
[ -x "$runtime/bin/python" ] || { echo "no case runtime at $runtime" >&2; exit 1; }
[ -e "$run_root" ] && { echo "run already exists: $run_root" >&2; exit 1; }
mkdir -p "$run_root"

brief="$(jq -r .brief "$template/case.json")"
conventions="$(jq -r .conventions "$template/case.json")"
title="$(jq -r .title "$template/case.json")"

# The research repository the ticket worktrees start from. The Worker adds predict.py
# and its experiments here; prepare copies it into each ticket.
git init -q -b main "$run_root/research"
cat > "$run_root/research/README.md" <<EOF
# $title

$brief

## Submission contract

$conventions
EOF
git -C "$run_root/research" -c user.name=AlephResearch -c user.email=aleph@localhost add -A
git -C "$run_root/research" -c user.name=AlephResearch -c user.email=aleph@localhost commit -qm "case: research scaffold for $case_name"

# The evaluator has to run from the case root with the case environment, not from the
# ticket directory, so the submitted command is this wrapper.
cat > "$run_root/case-eval.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
# The case evaluator makes its scratch directory under \$ALEPH_WORKSPACE/.aleph.
mkdir -p "$template/.aleph"
export ALEPH_WORKSPACE="$template"
export ALEPH_TESTSET="$template/testsets"
export ALEPH_VISIBLE_DATA="$template/visible-data"
export ALEPH_SUBMISSION_PYTHON="$runtime/bin/python"
exec "$runtime/bin/python" "$template/eval/run_eval.py"
EOF
chmod +x "$run_root/case-eval.sh"

jq -n \
  --arg project "$case_name" \
  --arg repository "$run_root/research" \
  --arg data "$template/visible-data" \
  --arg python "$runtime/bin/python" \
  --arg conventions "$conventions" \
  --arg eval "sh $run_root/case-eval.sh" \
  --arg brief "$brief" \
  --arg ticket "case-$case_name" \
  '{
    config: {
      project: $project,
      repository: $repository,
      templateBranch: "main",
      dataDir: $data,
      python: $python,
      conventions: $conventions,
      evalCommand: $eval,
      evalTimeoutMs: 900000
    },
    request: {
      project: $project,
      ticket: $ticket,
      requestId: ("case-" + $project + "-1"),
      confirmed: true,
      text: ("Research task for " + $project + ": " + $brief + " Work in this ticket worktree: data/ holds the visible data. The project conventions in AGENTS.md define the submission contract and the scoring. Analyse the data, build the submission, verify it with the project runtime, commit your work, then call aleph_submit_result (required before reporting) and report the score and what you learned.")
    }
  }' > "$run_root/project.json"

echo "case run prepared at $run_root"
ALEPH_SUPERAGENT_PROJECT="$run_root/project.json" \
ALEPH_SUPERAGENT_REUSE=1 \
ALEPH_SUPERAGENT_SMOKE=1 \
ALEPH_READ_ROOTS="${ALEPH_READ_ROOTS:-/usr:/bin:/sbin:/lib:/lib64:/etc:/opt:/run:$runtime}" \
  "$repo/scripts/superagent-lab.sh" "$run_name" ${port:+"$port"} | tee "$run_root/lab.out"
