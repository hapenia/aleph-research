#!/usr/bin/env bash
# Drive one case run through the operator API: scaffold, approve, batch, run and
# evaluate. Researcher turns still come from the Aleph panel, because starting
# them needs a live Leader agent.
#
# Usage: scripts/case-drive.sh <run-root> [step]
#   step: scaffold | batch | run | retry | evaluate | all (default all)
set -euo pipefail
run_root="${1:?usage: case-drive.sh <run-root> [step]}"
step="${2:-all}"
info="$run_root/run.json"
[ -f "$info" ] || { echo "no run.json in $run_root" >&2; exit 1; }

python="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["runtime"])' "$info")/bin/python"
project="$("$python" -c 'import json,sys; print(json.load(open(sys.argv[1]))["project_id"])' "$info")"
port="$("$python" -c 'import json,sys; print(json.load(open(sys.argv[1]))["port"])' "$info")"
url="$("$python" -c 'import json,sys; print(json.load(open(sys.argv[1]))["url"])' "$info")"
visible="$("$python" -c 'import json,sys; print(json.load(open(sys.argv[1]))["visible_data"])' "$info")"
runtime_python="$("$python" -c 'import json,sys; print(json.load(open(sys.argv[1]))["runtime"])' "$info")/bin/python"
cookie="$run_root/cookie.txt"
base="http://127.0.0.1:$port"

post() {
  local path="$1" payload="$2"
  curl -sS -m 1800 -b "$cookie" -X POST -H 'content-type: application/json' -d "$payload" "$base$path"
}

session_id="${ALEPH_SESSION_ID:-}"

case "$step" in
  scaffold)
    post /api/aleph/scaffold "{\"project_id\":\"$project\",\"title\":\"$project\",\"data\":[\"$visible\"],\"python\":\"$runtime_python\"}"
    ;;
  batch)
    post /api/aleph/batch "{\"project_id\":\"$project\"}" | tee "$run_root/batch.json"
    ;;
  run)
    batch_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["batch"]["id"])' "$run_root/batch.json")"
    post /api/aleph/run "{\"project_id\":\"$project\",\"batch_id\":\"$batch_id\"}" | tee "$run_root/run-result.json"
    ;;
  retry)
    batch_id="${ALEPH_BATCH_ID:-$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$run_root/batch.json" 2>/dev/null || true)}"
    post /api/aleph/retry "{\"project_id\":\"$project\",\"batch_id\":\"$batch_id\"}" | tee "$run_root/retry.json"
    ;;
  evaluate)
    # ALEPH_BRANCH evaluates a named research branch; otherwise the owner session worktree is used.
    branch="${ALEPH_BRANCH:-}"
    if [ -n "$branch" ]; then
      post /api/aleph/evaluate "{\"project_id\":\"$project\",\"branch\":\"$branch\"}" | tee "$run_root/eval.json"
    else
      post /api/aleph/evaluate "{\"project_id\":\"$project\",\"session_id\":\"$session_id\"}" | tee "$run_root/eval.json"
    fi
    ;;
  all)
    post /api/aleph/scaffold "{\"project_id\":\"$project\",\"title\":\"$project\",\"data\":[\"$visible\"],\"python\":\"$runtime_python\"}"
    echo
    post /api/aleph/batch "{\"project_id\":\"$project\"}" | tee "$run_root/batch.json"
    echo
    batch_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["batch"]["id"])' "$run_root/batch.json")"
    post /api/aleph/run "{\"project_id\":\"$project\",\"batch_id\":\"$batch_id\"}" | tee "$run_root/run-result.json"
    ;;
  *)
    echo "unknown step: $step" >&2
    exit 1
    ;;
esac
echo
