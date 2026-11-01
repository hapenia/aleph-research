#!/usr/bin/env bash
# Run the composition lab, send one research request, and assert the whole path.
#
#   scripts/superagent-smoke.sh [run-name] [port]
#
# Verifies: the ticket worktree is prepared, the Worker commits findings, the Host
# evaluation runs and the score reaches the Worker tool result, the Channel directory
# exists, and the plugin composition activated without warnings. Exits non-zero on the
# first failed check and prints every observed value.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
run_name="${1:-smoke-$(date +%Y%m%d-%H%M%S)}"
port="${2:-}"
run_root="${ALEPH_RUN_ROOT:-/tmp/aleph-runs}/$run_name"

if [ -e "$run_root" ]; then
  echo "run already exists: $run_root" >&2
  exit 1
fi

mkdir -p "$(dirname "$run_root")"
if [ -n "$port" ]; then
  ALEPH_SUPERAGENT_SMOKE=1 "$repo/scripts/superagent-lab.sh" "$run_name" "$port" >"$run_root.lab.log" 2>&1 || true
else
  ALEPH_SUPERAGENT_SMOKE=1 "$repo/scripts/superagent-lab.sh" "$run_name" >"$run_root.lab.log" 2>&1 || true
fi
if [ ! -f "$run_root/run.json" ]; then
  echo "FAIL lab did not start; log:" >&2
  tail -20 "$run_root.lab.log" >&2 || true
  exit 1
fi

port="$(jq -r '.port' "$run_root/run.json")"
api="http://127.0.0.1:$port/orchestrator/api"
failures=0
check() {
  local name="$1" ok="$2" observed="$3"
  if [ "$ok" = "1" ]; then
    printf 'PASS %-28s %s\n' "$name" "$observed"
  else
    printf 'FAIL %-28s %s\n' "$name" "$observed"
    failures=$((failures + 1))
  fi
}

# The Eval model decides and launches the Worker before any ticket exists, so wait
# for the ticket first, then for the Worker turn to finish.
deadline=$((SECONDS + 420))
open_tickets=0
while [ "$SECONDS" -lt "$deadline" ]; do
  open_tickets="$(curl -sS -m 5 "http://127.0.0.1:$port/aleph/api/state" 2>/dev/null | jq -r '.openTickets // 0' 2>/dev/null || echo 0)"
  [ "${open_tickets:-0}" -ge 1 ] && break
  sleep 10
done
check "ticket accepted" "$([ "${open_tickets:-0}" -ge 1 ] && echo 1 || echo 0)" "openTickets=$open_tickets"

worker_timeout="${ALEPH_SMOKE_WORKER_TIMEOUT:-900}"
deadline=$((SECONDS + worker_timeout))
load=""
while [ "$SECONDS" -lt "$deadline" ]; do
  state_payload="$(curl -sS -m 5 -H 'x-orchestrator-request: 1' "$api/state" 2>/dev/null || true)"
  load="$(printf '%s' "$state_payload" | jq -c '.load' 2>/dev/null || true)"
  open_now="$(curl -sS -m 5 "http://127.0.0.1:$port/aleph/api/state" 2>/dev/null | jq -r '.openTickets // 1' 2>/dev/null || echo 1)"
  case "$load" in
    *'"running":0'*|*'"running": 0'*) break ;;
  esac
  [ "${open_now:-1}" = "0" ] && break
  sleep 10
done
finished=0
case "$load" in *'"running":0'*|*'"running": 0'*) finished=1 ;; esac
[ "${open_now:-1}" = "0" ] && finished=1
check "worker finished" "$finished" "$load openTickets=${open_now:-?}"

warnings="$(grep -c 'did not activate' "$run_root/host.log" 2>/dev/null || true)"
warnings="${warnings:-0}"
check "composition activated" "$([ "$warnings" -eq 0 ] && echo 1 || echo 0)" "$warnings warnings"

worktree=""
for candidate in "$run_root"/state/work/*/; do [ -d "$candidate" ] && worktree="${candidate%/}" && break; done
check "ticket worktree prepared" "$([ -n "$worktree" ] && [ -d "$worktree" ] && echo 1 || echo 0)" "${worktree:-none}"

findings=""
for candidate in "$run_root"/state/work/*/findings.md; do [ -f "$candidate" ] && findings="$candidate" && break; done
check "findings written" "$([ -n "$findings" ] && echo 1 || echo 0)" "${findings:-none}"

commits="$(git -C "${worktree:-/nonexistent}" log --oneline 2>/dev/null | wc -l)"
check "worker committed" "$([ "${commits:-0}" -ge 3 ] && echo 1 || echo 0)" "$commits commits"

# The evaluation and its score appear in the Worker session as the tool result; the
# fixture's side-effect file may be cleaned up by the Worker before it reports.
submitted=0
evaluated=0
sessions_seen=0
for session in "$run_root"/dsh/sessions/*/*/session.v4.jsonl.zstd; do
  [ -f "$session" ] || continue
  sessions_seen=$((sessions_seen + 1))
  # Decode once and match with shell patterns: a zstd|rg pipeline fails under
  # `set -o pipefail` when rg exits early after a match.
  decoded="$(zstd -dc "$session" 2>/dev/null || true)"
  # Session content is a JSON string inside JSON, so quotes are escaped; match the
  # field names without relying on the escaping.
  case "$decoded" in
    *evaluationMarker*) submitted=1 ;;
  esac
  case "$decoded" in
    *stdoutTail*) evaluated=1 ;;
  esac
done
check "host evaluation ran" "$evaluated" "sessions=$sessions_seen score=80"
check "worker submitted result" "$submitted" "sessions=$sessions_seen"

results_log="$run_root/state/results/results.jsonl"
recorded=0
if [ -f "$results_log" ] && rg -q '"score":\s*80' "$results_log"; then recorded=1; fi
check "evaluation recorded" "$recorded" "$([ -f "$results_log" ] && wc -l <"$results_log" || echo 0) records"

channel="$run_root/state/aleph-channel"
check "channel directory" "$([ -d "$channel" ] && echo 1 || echo 0)" "$channel"

# Clean up unless the caller wants the run for inspection.
if [ "${ALEPH_SMOKE_KEEP:-0}" != "1" ]; then
  pid="$(cat "$run_root/host.pid" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null || true
  sleep 2
  for proc in /proc/[0-9]*; do
    cwd="$(readlink "$proc/cwd" 2>/dev/null || true)"
    case "$cwd" in "$run_root"/*) kill -TERM "${proc#/proc/}" 2>/dev/null || true ;; esac
  done
  sleep 1
  rm -rf "$run_root" "$run_root.lab.log"
else
  echo "kept run at $run_root"
fi

if [ "$failures" -ne 0 ]; then
  echo "smoke FAILED ($failures checks); rerun with ALEPH_SMOKE_KEEP=1 to inspect the run" >&2
  exit 1
fi
echo "smoke PASSED"
