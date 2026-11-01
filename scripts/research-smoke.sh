#!/usr/bin/env bash
# Prove the research runtime through the real mounted DSH host and its persistent
# `aleph_research` domain.
#
#   scripts/research-smoke.sh [run-name] [port]
#
# The script builds research-core, starts the composition lab without its worker smoke
# request, waits for GET /aleph/api/research/health, creates a Program and an Issue
# through POST /aleph/api/research/requests, reads the Program snapshot, finds the
# storage medium the JSON backend wrote under <run>/dsh/storages, then stops the host and
# removes the run directory once the evidence has been captured.
#
# Optional environment:
#   ALEPH_RUN_ROOT                 run directory parent (default /tmp/aleph-runs)
#   ALEPH_RESEARCH_LAB_TIMEOUT     seconds allowed for lab startup (default 300)
#   ALEPH_RESEARCH_START_TIMEOUT   seconds allowed for the health route (default 90)
#   ALEPH_REAL_HOME                forwarded to the lab for credentials (default /home/hapenia)
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
run_name="${1:-research-api-$(date +%Y%m%d-%H%M%S)}"
run_root="${ALEPH_RUN_ROOT:-/tmp/aleph-runs}/$run_name"

if [ -e "$run_root" ]; then
  echo "run already exists: $run_root" >&2
  exit 1
fi

lab_timeout="${ALEPH_RESEARCH_LAB_TIMEOUT:-300}"
health_timeout="${ALEPH_RESEARCH_START_TIMEOUT:-90}"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/research-api-smoke.XXXXXX")"
host_pid=""
failures=0
checks=0
evidence_complete=0
cleanup_done=0
cleanup_ok=0
run_root_removed=0

check() {
  local name="$1" ok="$2" observed="$3"
  checks=$((checks + 1))
  if [ "$ok" = "1" ]; then
    printf 'PASS  %-34s %s\n' "$name" "$observed"
  else
    printf 'FAIL  %-34s %s\n' "$name" "$observed"
    failures=$((failures + 1))
  fi
}

json_query() {
  # json_query <file> <jq-filter> [jq-options...]; an unreadable response yields empty.
  local file="$1" filter="$2"
  shift 2
  jq -r "$@" "$filter" "$file" 2>/dev/null || true
}

# True only for a live process; a zombie still answers kill -0 but is already gone.
process_alive() {
  local pid="$1" state
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  state="$(awk '{print $3}' "/proc/$pid/stat" 2>/dev/null || true)"
  [ "$state" != "Z" ] || return 1
  return 0
}

# Process ids whose working directory is inside the run directory. A host child can
# outlive the server pid, so cleanup checks both.
run_processes() {
  local proc cwd
  for proc in /proc/[0-9]*; do
    [ -d "$proc" ] || continue
    cwd="$(readlink "$proc/cwd" 2>/dev/null || true)"
    cwd="${cwd% (deleted)}"
    case "$cwd" in
      "$run_root" | "$run_root"/*) printf '%s\n' "${proc#/proc/}" ;;
    esac
  done
}

cleanup_now() {
  local alive pids leftover waited
  if [ "$cleanup_done" = "1" ]; then
    return 0
  fi
  cleanup_done=1
  cleanup_ok=1

  if [ -z "$host_pid" ] && [ -f "$run_root/host.pid" ]; then
    host_pid="$(cat "$run_root/host.pid" 2>/dev/null || true)"
  fi

  if process_alive "$host_pid"; then
    kill -TERM "$host_pid" 2>/dev/null || true
  fi

  # Give the server and its children a bounded grace period. Every loop is at least 2 s
  # between signals; no fast polling.
  waited=0
  while [ "$waited" -lt 10 ]; do
    alive=0
    if process_alive "$host_pid"; then alive=1; fi
    pids="$(run_processes)"
    if [ "$alive" = "0" ] && [ -z "$pids" ]; then break; fi
    for pids in $(run_processes); do kill -TERM "$pids" 2>/dev/null || true; done
    sleep 2
    waited=$((waited + 1))
  done

  # Anything that ignored SIGTERM is killed, still bounded.
  if process_alive "$host_pid"; then
    kill -KILL "$host_pid" 2>/dev/null || true
  fi
  for pids in $(run_processes); do kill -KILL "$pids" 2>/dev/null || true; done
  sleep 2

  leftover="$(run_processes | tr '\n' ' ')"
  if process_alive "$host_pid"; then
    check "cleanup host stopped" 0 "pid $host_pid still alive"
    cleanup_ok=0
  else
    check "cleanup host stopped" 1 "pid ${host_pid:-none}"
  fi
  if [ -z "$leftover" ]; then
    check "cleanup no lab processes" 1 "none under $run_root"
  else
    check "cleanup no lab processes" 0 "still alive: $leftover"
    cleanup_ok=0
  fi

  rm -rf "$work_dir"
  if [ "$evidence_complete" = "1" ] && [ "$cleanup_ok" = "1" ]; then
    rm -rf "$run_root" "$run_root.lab.log"
    if [ -e "$run_root" ] || [ -e "$run_root.lab.log" ]; then
      check "cleanup run dir removed" 0 "could not remove $run_root"
      run_root_removed=0
    else
      check "cleanup run dir removed" 1 "$run_root"
      run_root_removed=1
    fi
  else
    check "cleanup run dir kept" 1 "$run_root (evidence incomplete or processes remain)"
  fi
  return 0
}

on_exit() {
  local status=$?
  trap - EXIT INT TERM
  cleanup_now
  exit "$status"
}

trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "run:       $run_name"
echo "run root:  $run_root"

# Build before the lab so a stale or absent dist/ is a build failure here, not a silent
# 503 health route from the host. The lab builds again as part of its own contract.
echo "building research-core"
if ! (
  cd "$repo/research-core"
  if [ ! -d node_modules ]; then npm install --no-audit --no-fund --silent; fi
  npm run build
) > "$work_dir/build.log" 2>&1; then
  check "research-core build" 0 "see build log"
  tail -20 "$work_dir/build.log" 2>/dev/null || true
  exit 1
fi
check "research-core build" 1 "npm run build"

# The lab chooses a free port when none is passed, but the smoke needs the port before
# the host starts so it can wait on the health route. Bind a socket to let the kernel
# pick one, then pass it to the lab.
port="${2:-}"
if [ -z "$port" ]; then
  port="$(python3 - <<'PY'
import socket
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)"
fi
echo "port:      $port"

mkdir -p "$(dirname "$run_root")"
# Non-smoke mode: the lab must start the host and seed settings, but must not send the
# worker research request. The smoke itself exercises only the research HTTP runtime.
echo "starting lab"
if ! ALEPH_SUPERAGENT_SMOKE=0 ALEPH_SUPERAGENT_PROJECT= ALEPH_SUPERAGENT_REUSE=0 \
  timeout "$lab_timeout" "$repo/scripts/superagent-lab.sh" "$run_name" "$port" \
  > "$run_root.lab.log" 2>&1; then
  host_pid="$(cat "$run_root/host.pid" 2>/dev/null || true)"
  check "lab startup" 0 "see $run_root.lab.log"
  tail -20 "$run_root.lab.log" 2>/dev/null || true
  exit 1
fi
host_pid="$(cat "$run_root/host.pid" 2>/dev/null || true)"

if [ ! -f "$run_root/run.json" ]; then
  check "lab startup" 0 "lab did not write run.json"
  exit 1
fi
actual_port="$(json_query "$run_root/run.json" '.port // empty')"
if [ -n "$actual_port" ]; then port="$actual_port"; fi
check "lab startup" 1 "run.json at $run_root/run.json, port $port"

base="http://127.0.0.1:$port"
health_file="$work_dir/health.json"
health_code=""
health_body=""
health_ok=0
waited=0
while [ "$waited" -lt "$health_timeout" ]; do
  health_code="$(curl -sS --max-time 5 -o "$health_file" -w '%{http_code}' \
    "$base/aleph/api/research/health" 2>/dev/null || true)"
  health_body="$(cat "$health_file" 2>/dev/null || true)"
  if [ "$health_code" = "200" ] \
    && [ "$(printf '%s' "$health_body" | jq -r 'if .ok == true and .persistent == true then 1 else 0 end' 2>/dev/null || echo 0)" = "1" ]; then
    health_ok=1
    break
  fi
  sleep 2
  waited=$((waited + 2))
done
check "research health" "$health_ok" "http=$health_code body=${health_body:-no response}"
if [ "$health_ok" != "1" ]; then
  echo "health route did not report ok:true persistent:true within ${health_timeout}s" >&2
  exit 1
fi

# POST /requests is the only write surface. The compiled runtime owns route matching and
# returns the same ApiResponse shape the panel reads, so the program id is response.value.id.
cat > "$work_dir/program-request.json" <<'JSON'
{
  "path": "/aleph/api/programs",
  "actorKind": "operator",
  "body": {
    "name": "Research API smoke",
    "goal": "Prove the mounted research runtime creates and persists a Program",
    "methodology": "Create one Program and one Issue through the HTTP runtime, then read the snapshot.",
    "contract": {
      "ciEntry": "python3 -c 'print(1)'",
      "timeoutMs": 60000,
      "requiredMetrics": ["score"]
    },
    "utility": {
      "metrics": [
        {"name": "score", "direction": "higher", "weight": 1.0, "required": true}
      ]
    },
    "exploration": "normal",
    "budget": {
      "maxExperiments": 3,
      "maxComputeMinutes": 10,
      "maxTokens": 1000
    }
  }
}
JSON
program_file="$work_dir/program-response.json"
program_code="$(curl -sS --max-time 15 -o "$program_file" -w '%{http_code}' \
  -X POST -H 'content-type: application/json' --data-binary @"$work_dir/program-request.json" \
  "$base/aleph/api/research/requests" 2>/dev/null || true)"
program_id="$(json_query "$program_file" '.value.id // empty')"
program_ok=0
if [ "$program_code" = "201" ] && [ -n "$program_id" ] && [ "$(json_query "$program_file" '.ok')" = "true" ]; then
  program_ok=1
fi
check "program created" "$program_ok" "http=$program_code id=${program_id:-none} status=$(json_query "$program_file" '.value.status')"
if [ "$program_ok" != "1" ]; then
  echo "program response: $(cat "$program_file" 2>/dev/null || true)" >&2
  exit 1
fi

cat > "$work_dir/issue-request.json" <<JSON
{
  "path": "/aleph/api/programs/$program_id/issues",
  "actorKind": "operator",
  "body": {
    "programId": "$program_id",
    "title": "Research API smoke issue",
    "body": "Created through the mounted research runtime to prove the Issue path persists.",
    "labels": ["research"]
  }
}
JSON
issue_file="$work_dir/issue-response.json"
issue_code="$(curl -sS --max-time 15 -o "$issue_file" -w '%{http_code}' \
  -X POST -H 'content-type: application/json' --data-binary @"$work_dir/issue-request.json" \
  "$base/aleph/api/research/requests" 2>/dev/null || true)"
issue_id="$(json_query "$issue_file" '.value.id // empty')"
issue_ok=0
if [ "$issue_code" = "201" ] && [ -n "$issue_id" ] && [ "$(json_query "$issue_file" '.ok')" = "true" ]; then
  issue_ok=1
fi
check "issue created" "$issue_ok" "http=$issue_code id=${issue_id:-none} status=$(json_query "$issue_file" '.value.status')"
if [ "$issue_ok" != "1" ]; then
  echo "issue response: $(cat "$issue_file" 2>/dev/null || true)" >&2
  exit 1
fi

snapshot_file="$work_dir/snapshot.json"
snapshot_code="$(curl -sS --max-time 15 -o "$snapshot_file" -w '%{http_code}' \
  "$base/aleph/api/research/programs/$program_id" 2>/dev/null || true)"
snapshot_summary="$(json_query "$snapshot_file" '
  "program=" + ((.value.program.status // "?") | tostring)
  + " issues=" + (((.value.issues // []) | length) | tostring)
  + " issueStatus=" + (((.value.issues // []) | map(select(.id == $iid)) | if length > 0 then .[0].status else "?" end))
  + " audit=" + (((.value.audit // []) | length) | tostring)
  + " actions=" + (((.value.audit // []) | map(.action)) | join(","))
' --arg iid "$issue_id")"
snapshot_ok=0
if [ "$snapshot_code" = "200" ] && [ "$(json_query "$snapshot_file" '.ok')" = "true" ]; then
  snapshot_ok="$(jq -r --arg pid "$program_id" --arg iid "$issue_id" '
    if .ok == true
      and .value.program.id == $pid
      and .value.program.status == "running"
      and ((.value.issues // []) | map(select(.id == $iid and .status == "open")) | length) == 1
      and ((.value.audit // []) | map(.action) | index("program.created")) != null
      and ((.value.audit // []) | map(.action) | index("issue.created")) != null
      and ((.audit // []) | length) == ((.value.audit // []) | length)
    then 1 else 0 end
  ' "$snapshot_file" 2>/dev/null || echo 0)"
fi
check "program snapshot" "$snapshot_ok" "http=$snapshot_code ${snapshot_summary:-unreadable}"

# The JSON backend writes one medium per opened unit under the storage root. The layout is
# not assumed: find the medium by name, then record its path and size. The program id is
# also looked up in the medium to prove the row is on disk, not only in the host process.
storage_root="$run_root/dsh/storages"
storage_path=""
waited=0
while [ "$waited" -lt 30 ]; do
  storage_path="$(find "$storage_root" -maxdepth 4 -name 'aleph_research*' -print -quit 2>/dev/null || true)"
  [ -n "$storage_path" ] && break
  sleep 2
  waited=$((waited + 2))
done

storage_bytes=""
storage_files=0
storage_contains=0
if [ -n "$storage_path" ]; then
  if [ -d "$storage_path" ]; then
    storage_bytes="$(du -sb "$storage_path" 2>/dev/null | cut -f1 || true)"
    storage_files="$(find "$storage_path" -type f 2>/dev/null | wc -l | tr -d ' ' || true)"
    if grep -rqF -- "$program_id" "$storage_path" 2>/dev/null \
      && grep -rqF -- "$issue_id" "$storage_path" 2>/dev/null; then
      storage_contains=1
    fi
  else
    storage_bytes="$(stat -c %s "$storage_path" 2>/dev/null || true)"
    storage_files=1
    if grep -qF -- "$program_id" "$storage_path" 2>/dev/null \
      && grep -qF -- "$issue_id" "$storage_path" 2>/dev/null; then
      storage_contains=1
    fi
  fi
fi
if [ -n "$storage_path" ] && [ -n "$storage_bytes" ]; then
  evidence_complete=1
fi
storage_size_ok=0
case "$storage_bytes" in
  '' | *[!0-9]*) storage_size_ok=0 ;;
  *) [ "$storage_bytes" -gt 0 ] && storage_size_ok=1 ;;
esac
check "storage medium" "$([ -n "$storage_path" ] && echo 1 || echo 0)" "${storage_path:-none under $storage_root}"
check "storage size" "$storage_size_ok" "bytes=${storage_bytes:-?} files=$storage_files"
check "storage contains ids" "$storage_contains" "program=$program_id issue=$issue_id"

echo "snapshot:  ${snapshot_summary:-unreadable}"

cleanup_now
if [ "$failures" -ne 0 ]; then
  echo "research api smoke FAILED ($failures of $checks checks)"
  exit 1
fi
echo "research api smoke PASSED ($checks checks)"
if [ "$run_root_removed" = "1" ]; then
  echo "run directory removed after evidence capture"
fi
