#!/usr/bin/env bash
# Unattended soak of a superagent case lab.
#
#   scripts/superagent-soak.sh <run-name> [hours]
#   ALEPH_SOAK_RUN=/tmp/aleph-runs/existing scripts/superagent-soak.sh existing 1
#
# Samples health every ALEPH_SOAK_INTERVAL seconds into <run>/soak.jsonl and sends a
# follow-up research request every ALEPH_SOAK_REQUEST_EVERY seconds while a ticket is
# not already running. Designed for the 24-hour acceptance run; ALEPH_SOAK_MINUTES
# overrides the duration for a quick dry run.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
run_name="$1"
hours="${2:-${ALEPH_SOAK_HOURS:-24}}"
run_root="${ALEPH_SOAK_RUN:-${ALEPH_RUN_ROOT:-/tmp/aleph-runs}/$run_name}"
interval="${ALEPH_SOAK_INTERVAL:-300}"
request_every="${ALEPH_SOAK_REQUEST_EVERY:-1800}"

if [ "${ALEPH_SOAK_MINUTES:-}" != "" ]; then
  deadline=$((SECONDS + ALEPH_SOAK_MINUTES * 60))
else
  deadline=$((SECONDS + hours * 3600))
fi

if [ ! -f "$run_root/run.json" ]; then
  echo "no run at $run_root; start one with scripts/superagent-case.sh first" >&2
  exit 1
fi

port="$(jq -r '.port' "$run_root/run.json")"
api="http://127.0.0.1:$port"
log="$run_root/soak.jsonl"
echo "soaking $run_root on port $port until $deadline (log: $log)"
started=$(date +%s)
requests=0
last_request=0
failures=0

while [ "$SECONDS" -lt "$deadline" ]; do
  now=$(date +%s)
  state="$(curl -sS -m 5 -H 'x-orchestrator-request: 1' "$api/orchestrator/api/state" 2>/dev/null || true)"
  aleph="$(curl -sS -m 5 "$api/aleph/api/state" 2>/dev/null || true)"
  results="$(curl -sS -m 5 "$api/aleph/api/results" 2>/dev/null || true)"
  alive=1
  [ -n "$state" ] || alive=0
  [ -z "$results" ] && results='{"count":0}'
  record="$(jq -n \
    --arg at "$(date -Is)" \
    --argjson elapsed "$((now - started))" \
    --argjson alive "$alive" \
    --arg load "$(printf '%s' "$state" | jq -c '.load // {}' 2>/dev/null || echo '{}')" \
    --argjson open "$(printf '%s' "$aleph" | jq -r '.openTickets // 0' 2>/dev/null || echo 0)" \
    --argjson results "$(printf '%s' "$results" | jq -r '.count // 0' 2>/dev/null || echo 0)" \
    --arg best "$(printf '%s' "$results" | jq -cr '.best.score // null' 2>/dev/null || echo null)" \
    '{at:$at, elapsedSeconds:$elapsed, hostAlive:($alive==1), load:$load, openTickets:$open, evaluations:$results, bestScore:($best|tonumber? // null)}' 2>/dev/null || true)"
  [ -n "$record" ] && printf '%s\n' "$record" >> "$log"
  [ "$alive" = 0 ] && failures=$((failures + 1))

  # Keep the loop fed: one new concrete ticket at a time, only when nothing runs.
  if [ -n "$state" ] && [ "$((now - last_request))" -ge "$request_every" ]; then
    running="$(printf '%s' "$state" | jq -r '.load.running // 0' 2>/dev/null || echo 0)"
    if [ "${running:-0}" = "0" ] && [ "$(printf '%s' "$aleph" | jq -r '.openTickets // 0' 2>/dev/null || echo 0)" = "0" ]; then
      requests=$((requests + 1))
      last_request=$now
      slug="soak-$requests"
      body="$(jq -n --arg slug "$slug" '{project:"kunlungpt",ticket:("case-soak-"+$slug),requestId:("soak-"+$slug),confirmed:true,text:"Continue improving the kunlungpt submission: inspect the latest evaluation and the research history, make one concrete improvement to predict.py, verify it with the project runtime, commit, then call aleph_submit_result (required before reporting) and report the new score."}')"
      curl -sS -m 10 -X POST -H 'content-type: application/json' -d "$body" "$api/aleph/api/trigger" >/dev/null 2>&1 || true
      echo "sent request $slug"
    fi
  fi

  sleep "$interval"
done

summary="$(jq -s '{samples:length, failures:([.[]|select(.hostAlive==false)]|length), best:([.[].bestScore]|max), evaluations:([.[].evaluations]|max)}' "$log" 2>/dev/null || echo '{}')"
echo "soak finished after $((SECONDS))s: $summary"
echo "log kept at $log"
