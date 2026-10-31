#!/usr/bin/env bash
# Copy the case template into a fresh run and start an isolated DSH lab on it.
# Each run gets its own DSH_HOME, leader workspace and port, so a plugin change
# can be exercised without inheriting earlier state.
#
# Usage: scripts/case-run.sh [run-name] [port]
# Writes <run>/run.json with the run root, project id, host URL and paths.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case_name="${ALEPH_CASE:-kunlungpt}"
store="${ALEPH_CASE_STORE:-$repo/.case-templates}"
run_name="${1:-case-$(date +%Y%m%d-%H%M%S)}"
run_root="${ALEPH_RUN_ROOT:-/tmp/aleph-runs}/$run_name"
template="$store/$case_name/template"
runtime="$store/$case_name/runtime"

[ -d "$template" ] || { echo "no template; run scripts/case-build.sh $case_name first" >&2; exit 1; }
[ -x "$runtime/bin/python" ] || { echo "no runtime; run scripts/case-build.sh $case_name first" >&2; exit 1; }
[ -e "$run_root" ] && { echo "run already exists: $run_root" >&2; exit 1; }

port="${2:-}"
if [ -z "$port" ]; then
  port=39873
  while ss -ltn 2>/dev/null | grep -q ":$port "; do port=$((port + 1)); done
fi

mkdir -p "$run_root/case" "$run_root/leader" "$run_root/dsh"
cp -a "$template/." "$run_root/case/"
python="$runtime/bin/python"
case_json="$run_root/case/case.json"

export DSH_HOME="$run_root/dsh"
export HOME="$run_root/dsh/home"
mkdir -p "$HOME"

# Plugin under test, linked from this checkout so a run always exercises the
# working tree rather than an installed copy.
dsh --profile aleph-lab --from-default-profile web --help >/dev/null
(cd "$repo/dsh-plugin" && npm install --no-save --silent)
dsh plugin --profile aleph-lab add "$repo/dsh-plugin" >/dev/null

patch="$DSH_HOME/profiles/aleph-lab/cordis.patch.yml"
# A freshly created profile ships an empty patch list; replace it, do not append past it.
if grep -qx '\[\]' "$patch"; then printf '' > "$patch"; fi

cat >> "$patch" <<'YAML'
- id: permission
  name: "@deepseek-ai/dsh-permission-presets"
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      workspace-write:
        sandbox: workspace-write
        approval: ask
      danger-full-access:
        sandbox: danger-full-access
        approval: never
    defaultPreset: danger-full-access
- id: agent-default-model
  config:
    provider: opencode-go
    model: deepseek-v4.1-flash
    reasoningEffort: max
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      opencode-go:
        apiKeyEnv: OPENCODE_GO_API_KEY
- id: subagent
  name: "@deepseek-ai/dsh-subagent"
  config:
    maxActiveSubagents: 16
    maxDepth: 3
YAML

# Ship this package's skills into the lab so its agents can load them.
if [ -d "$repo/skills" ]; then
  mkdir -p "$DSH_HOME/skills"
  cp -a "$repo/skills/." "$DSH_HOME/skills/"
  echo "skills installed:  $(ls "$DSH_HOME/skills" | tr '\n' ' ')"
fi

# Leader and researcher turns authenticate with the desktop credential store.
real_home="${ALEPH_REAL_HOME:-/home/hapenia}"
cp "$real_home/.dsh/.credentials.yaml" "$DSH_HOME/.credentials.yaml"
api_key="$(sed -n 's/.*OPENCODE_GO_API_KEY:[[:space:]]*\([^[:space:]]*\).*/\1/p' "$DSH_HOME/.credentials.yaml" | head -1)"

DSH_HOME="$DSH_HOME" HOME="$HOME" OPENCODE_GO_API_KEY="$api_key" \
  nohup dsh --profile aleph-lab --no-open --host 127.0.0.1 --port "$port" \
  > "$run_root/host.log" 2>&1 &
echo $! > "$run_root/host.pid"

token=""
for _ in $(seq 1 60); do
  token="$(grep -o 'token=[A-Za-z0-9_-]*' "$run_root/host.log" 2>/dev/null | head -1 | cut -d= -f2 || true)"
  [ -n "$token" ] && break
  sleep 0.5
done
[ -n "$token" ] || { echo "host did not start; see $run_root/host.log" >&2; exit 1; }

url="http://127.0.0.1:$port/?token=$token"
cookie="$run_root/cookie.txt"
curl -sS -m 10 -c "$cookie" "$url" >/dev/null
curl -sS -m 10 -b "$cookie" -X POST -H 'content-type: application/json' \
  -d "{\"path\":\"$run_root/leader\"}" "http://127.0.0.1:$port/api/aleph/workspace" >/dev/null

init_payload="$("$python" - "$run_root" "$case_json" "$runtime" <<'PY'
import json, os, sys
run_root, case_path, runtime = sys.argv[1], sys.argv[2], sys.argv[3]
case = json.load(open(case_path))
print(json.dumps({
    "workspace": os.path.join(run_root, "leader"),
    "eval_command": case["eval_command"],
    "eval_root": os.path.join(run_root, "case"),
    "testset": os.path.join(run_root, "case", "testsets"),
    "submission_python": os.path.join(runtime, "bin", "python"),
    "researchers": case["researcher_count"],
    "visible_data": os.path.join(run_root, "case", "visible-data"),
    "brief": case["brief"],
    "conventions": case.get("conventions", ""),
}))
PY
)"

init_response="$(curl -sS -m 20 -b "$cookie" -X POST -H 'content-type: application/json' \
  -d "$init_payload" "http://127.0.0.1:$port/api/aleph/init")"
project_id="$("$python" -c 'import json,sys; print(json.loads(sys.argv[1])["project"]["id"])' "$init_response")"

"$python" - "$run_root" "$port" "$token" "$url" "$project_id" "$runtime" <<'PY'
import json, sys
run_root, port, token, url, project_id, runtime = sys.argv[1:7]
info = {
    "run_root": run_root,
    "port": int(port),
    "url": url,
    "project_id": project_id,
    "workspace": f"{run_root}/leader",
    "case_root": f"{run_root}/case",
    "visible_data": f"{run_root}/case/visible-data",
    "testset": f"{run_root}/case/testsets",
    "problem": f"{run_root}/case/problem",
    "runtime": runtime,
    "dsh_home": f"{run_root}/dsh",
}
json.dump(info, open(f"{run_root}/run.json", "w"), indent=2)
print(json.dumps(info, indent=2))
PY

# Open the panel so the run can be watched while it proceeds.
if [ "${ALEPH_NO_OPEN:-0}" != "1" ] && command -v google-chrome-stable >/dev/null 2>&1; then
  nohup google-chrome-stable --new-tab "$url" >/dev/null 2>&1 &
fi

# Keep only the newest run alive; older runs are stopped and removed.
for stale in "${ALEPH_RUN_ROOT:-/tmp/aleph-runs}"/*; do
  [ -d "$stale" ] || continue
  [ "$stale" = "$run_root" ] && continue
  if [ -f "$stale/host.pid" ]; then
    kill -TERM "$(cat "$stale/host.pid")" 2>/dev/null || true
  fi
  if [ -f "$stale/run.json" ]; then
    port="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["port"])' "$stale/run.json" 2>/dev/null || true)"
    if [ -n "$port" ]; then
      for pid in $(ss -ltnp 2>/dev/null | grep ":$port " | grep -o 'pid=[0-9]*' | cut -d= -f2); do kill -TERM "$pid" 2>/dev/null || true; done
    fi
  fi
  sleep 1
  chmod -R u+w "$stale" 2>/dev/null || true
  rm -rf "$stale"
done

cat <<EOF

case run ready

  project   $project_id
  url       $url
  run root  $run_root

next, from the Aleph Research panel:

  aleph_create_research_scaffold with data ["$run_root/case/visible-data"]
  aleph_run_researchers
  POST /api/aleph/batch -> /api/aleph/run -> /api/aleph/evaluate
EOF
