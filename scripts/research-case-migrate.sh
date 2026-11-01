#!/usr/bin/env bash
# Migrate a legacy case workflow to the Phase 1 Program/Issue path.
#
#   scripts/research-case-migrate.sh --config case.json --url http://127.0.0.1:40201
#   scripts/research-case-migrate.sh --apply --config case.json --url ...
#   scripts/research-case-migrate.sh --apply --start-lab --config case.json
#
# Default is --dry-run: validate the build and the case config, detect legacy markers,
# and print the exact request envelopes that --apply would send. A dry-run sends no HTTP
# request and starts no lab.
#
# --apply creates one Program and one Issue per configured Issue through
# POST /aleph/api/research/requests, then reads the Program snapshot and verifies the
# audit trail. It never proposes an Experiment, never requests CI, never starts a
# worker or evaluation, and never deletes a file or a branch.
#
# Legacy markers (`research/r-*` branches and `.aleph` directories) are reported with a
# migration checklist. --apply refuses to write when any marker is present; a dry-run
# still prints the plan so the blockers and the intended requests are visible together.
#
# Exit codes: 0 success or dry-run, 1 configuration/transport failure, 2 --apply refused
# because legacy markers were found.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

mode="dry-run"
mode_set=0
config_path="${ALEPH_CASE_CONFIG:-}"
host_url="${ALEPH_RESEARCH_URL:-}"
start_lab=0
lab_run_name=""
allow_ephemeral=0
allow_duplicate=0
connect_timeout="${ALEPH_MIGRATE_CONNECT_TIMEOUT:-5}"
http_timeout="${ALEPH_MIGRATE_HTTP_TIMEOUT:-20}"
health_timeout="${ALEPH_MIGRATE_HEALTH_TIMEOUT:-60}"
lab_timeout="${ALEPH_MIGRATE_LAB_TIMEOUT:-600}"
work_dir=""
lab_started=0
lab_run_root=""
lab_log=""
program_id=""
issue_ids=()
legacy_found=0

usage() {
  cat <<'EOF'
Usage: scripts/research-case-migrate.sh [options]

Modes:
  --dry-run                 Validate and print the exact requests (default).
  --apply                   Create the Program and its Issues, then verify the snapshot.
                            Requires --url, or --start-lab to start a disposable lab.

Configuration:
  --config FILE             Case config JSON. Defaults to $ALEPH_CASE_CONFIG.
  --url URL                 Research host base URL, for example http://127.0.0.1:40201.
                            Defaults to $ALEPH_RESEARCH_URL.
  --start-lab               Start scripts/superagent-lab.sh (only with --apply), use its
                            URL, and stop the lab on exit. Never sends a research request.
  --lab-run-name NAME       Run directory name for --start-lab.
  --allow-ephemeral         Permit --apply against a host whose health reports
                            persistent:false. For disposable test hosts only.
  --allow-duplicate         Permit a second Program with the same name.
  --print-sample-config     Print a minimal case config and exit.
  -h, --help                Show this help.

Environment:
  ALEPH_CASE_CONFIG, ALEPH_RESEARCH_URL
  ALEPH_PROGRAM_NAME, ALEPH_PROGRAM_GOAL, ALEPH_PROGRAM_METHODOLOGY
  ALEPH_CI_ENTRY, ALEPH_CI_TIMEOUT_MS, ALEPH_REQUIRED_METRICS (comma separated)
  ALEPH_UTILITY_METRICS (JSON array), ALEPH_EXPLORATION
  ALEPH_MAX_EXPERIMENTS, ALEPH_MAX_COMPUTE_MINUTES, ALEPH_MAX_TOKENS
  ALEPH_ISSUES_JSON (JSON array of {title, body, labels})
  ALEPH_LEGACY_SCAN_ROOTS (additional colon separated roots; the repository is always scanned)
  ALEPH_MIGRATE_CONNECT_TIMEOUT, ALEPH_MIGRATE_HTTP_TIMEOUT
  ALEPH_MIGRATE_HEALTH_TIMEOUT, ALEPH_MIGRATE_LAB_TIMEOUT
  ALEPH_RUN_ROOT (lab run directory parent; default /tmp/aleph-runs)

This tool does not implement Experiment migration. Experiment proposals need a
Host-injected Issue assignment and an Implementer ticket, so they stay a manual step.
EOF
}

sample_config() {
  cat <<'JSON'
{
  "case": {
    "name": "kunlungpt-migration",
    "goal": "Predict porosity, permeability and water saturation for unseen wells and improve the official total score.",
    "methodology": "Inspect the visible data, keep a reproducible baseline, and iterate only through Issues whose acceptance criteria are measurable by CI.",
    "contract": {
      "ciEntry": "sh eval/run_eval.sh",
      "timeoutMs": 900000,
      "requiredMetrics": ["score", "rmse"]
    },
    "utility": {
      "metrics": [
        {"name": "score", "direction": "higher", "weight": 1.0, "required": true},
        {"name": "rmse", "direction": "lower", "weight": 0.25, "required": true}
      ]
    },
    "exploration": "normal",
    "budget": {
      "maxExperiments": 12,
      "maxComputeMinutes": 120,
      "maxTokens": 200000
    }
  },
  "issues": [
    {
      "title": "Reproduce the legacy baseline",
      "body": "Recreate the current case baseline in the research scaffold, record the exact environment, and let CI establish the first score.",
      "labels": ["research"]
    },
    {
      "title": "Improve porosity prediction",
      "body": "Test one clearly stated change to the porosity model against the baseline. Acceptance is a higher score with no required metric missing.",
      "labels": ["experiment"]
    }
  ]
}
JSON
}

die() {
  echo "error: $*" >&2
  exit 1
}

warn() {
  echo "warning: $*" >&2
}

set_mode() {
  if [ "$mode_set" = "1" ] && [ "$mode" != "$1" ]; then
    die "--dry-run and --apply cannot be used together"
  fi
  mode="$1"
  mode_set=1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      set_mode dry-run
      shift
      ;;
    --apply)
      set_mode apply
      shift
      ;;
    --config)
      [ "$#" -ge 2 ] || die "--config requires a file"
      config_path="$2"
      shift 2
      ;;
    --config=*)
      config_path="${1#*=}"
      shift
      ;;
    --url)
      [ "$#" -ge 2 ] || die "--url requires a value"
      host_url="$2"
      shift 2
      ;;
    --url=*)
      host_url="${1#*=}"
      shift
      ;;
    --start-lab)
      start_lab=1
      shift
      ;;
    --lab-run-name)
      [ "$#" -ge 2 ] || die "--lab-run-name requires a value"
      lab_run_name="$2"
      shift 2
      ;;
    --lab-run-name=*)
      lab_run_name="${1#*=}"
      shift
      ;;
    --allow-ephemeral)
      allow_ephemeral=1
      shift
      ;;
    --allow-duplicate)
      allow_duplicate=1
      shift
      ;;
    --print-sample-config)
      sample_config
      exit 0
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1 (use --help)"
      ;;
  esac
done

if [ "$start_lab" = "1" ] && [ "$mode" != "apply" ]; then
  die "--start-lab requires --apply; a dry-run never starts a lab"
fi
if [ "$start_lab" = "1" ] && [ -n "$host_url" ]; then
  die "use --url or --start-lab, not both"
fi
if [ -n "$lab_run_name" ] && [ "$start_lab" != "1" ]; then
  die "--lab-run-name requires --start-lab"
fi
if [ -n "$lab_run_name" ]; then
  case "$lab_run_name" in
    *[!A-Za-z0-9._-]*)
      die "--lab-run-name may use only letters, digits, dot, underscore and dash"
      ;;
  esac
fi
if [ "$start_lab" != "1" ] && [ -z "$host_url" ]; then
  die "provide --url (or ALEPH_RESEARCH_URL), or use --start-lab with --apply"
fi
if [ -n "$host_url" ]; then
  case "$host_url" in
    *' '* | *$'\t'*)
      die "--url must not contain whitespace"
      ;;
    *[?#]*)
      die "--url must be a base URL without a query or fragment"
      ;;
    http://* | https://*)
      host_url="${host_url%/}"
      ;;
    *)
      die "--url must start with http:// or https://"
      ;;
  esac
fi

command -v jq >/dev/null 2>&1 || die "jq is required"
command -v git >/dev/null 2>&1 || die "git is required"
if [ "$mode" = "apply" ]; then
  command -v curl >/dev/null 2>&1 || die "curl is required for --apply"
fi

process_alive() {
  local pid="$1" state
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  state="$(awk '{print $3}' "/proc/$pid/stat" 2>/dev/null || true)"
  [ "$state" != "Z" ] || return 1
  return 0
}

stop_lab() {
  local pid waited
  [ -n "$lab_run_root" ] || return 0
  pid="$(cat "$lab_run_root/host.pid" 2>/dev/null || true)"
  if [ -z "$pid" ]; then
    echo "lab: no host.pid under $lab_run_root; left for inspection" >&2
    return 0
  fi
  if process_alive "$pid"; then
    kill -TERM "$pid" 2>/dev/null || true
  fi
  waited=0
  while process_alive "$pid" && [ "$waited" -lt 10 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  if process_alive "$pid"; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
  echo "lab stopped: $lab_run_root (logs kept)"
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [ "$lab_started" = "1" ]; then
    stop_lab
  fi
  if [ -n "$work_dir" ] && [ -d "$work_dir" ]; then
    rm -rf "$work_dir"
  fi
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

check_build() {
  local dist="$repo/research-core/dist" newer
  if [ ! -f "$dist/adapter/composition.js" ] || [ ! -f "$dist/runtime/api.js" ]; then
    if [ "$start_lab" = "1" ] && [ "$mode" = "apply" ]; then
      warn "research-core dist/ is missing; the lab will build it before starting"
    else
      die "research-core is not built (missing $dist/adapter/composition.js). Run: (cd research-core && npm run build)"
    fi
  else
    newer="$(find "$repo/research-core/src" "$repo/research-core/package.json" \
      -newer "$dist/adapter/composition.js" -print -quit 2>/dev/null || true)"
    if [ -n "$newer" ]; then
      warn "research-core/dist may be stale ($newer is newer than the build); run (cd research-core && npm run build)"
    fi
  fi
}

print_checklist() {
  cat <<'EOF'
Migration checklist (no marker was deleted or modified):
  1. Freeze the legacy case workflow: stop case labs and send no new case/soak requests.
  2. Preserve evidence before cleanup: copy run directories, results.jsonl, soak.jsonl
     and `.aleph` artifacts to an archive; do not delete the only copy.
  3. Inventory the legacy project, missions and tickets. Decide which tickets were
     attempts at one question (they become Experiments) and which were distinct
     questions (they become Issues).
  4. Keep `research/r-*` branches and `.aleph` directories read-only during the shadow
     period. Do not merge, push or delete them from this tool.
  5. Re-run this script with --dry-run, then --apply, only after the markers are archived
     or explicitly retired by a person.
  6. Enter the shadow phase (see docs/research-case-migration.md) before switching
     researchers from the legacy workflow to the Program.
EOF
}

detect_legacy() {
  local roots root found
  legacy_branches="$(git -C "$repo" for-each-ref \
    --format='%(refname:short)' refs/heads refs/remotes 2>/dev/null \
    | grep -E '(^|/)research/r-' | sort -u || true)"

  roots="$repo${ALEPH_LEGACY_SCAN_ROOTS:+:$ALEPH_LEGACY_SCAN_ROOTS}"
  found="$(
    old_ifs="$IFS"
    IFS=':'
    for root in $roots; do
      [ -d "$root" ] || continue
      find "$root" \
        \( -path "$root/.git" -o -path '*/node_modules' -o -path '*/dist' \) -prune \
        -o -type d -name '.aleph' -print 2>/dev/null || true
    done
    IFS="$old_ifs"
  )"
  legacy_dirs="$(printf '%s\n' "$found" | sed '/^$/d' | sort -u)"

  if [ -n "$legacy_branches" ] || [ -n "$legacy_dirs" ]; then
    legacy_found=1
    echo "legacy markers detected:"
    if [ -n "$legacy_branches" ]; then
      printf '%s\n' "$legacy_branches" | sed 's/^/  branch: /'
    fi
    if [ -n "$legacy_dirs" ]; then
      printf '%s\n' "$legacy_dirs" | sed 's/^/  .aleph: /'
    fi
    echo
    print_checklist
    echo
  fi
}

build_env_config() {
  local issues_json utility_json required_json
  issues_json="${ALEPH_ISSUES_JSON:-[]}"
  if ! jq -e 'type == "array"' >/dev/null 2>&1 <<< "$issues_json"; then
    die "ALEPH_ISSUES_JSON must be a JSON array"
  fi
  utility_json="${ALEPH_UTILITY_METRICS:-}"
  if [ -z "$utility_json" ]; then
    utility_json='[{"name":"score","direction":"higher","weight":1}]'
  fi
  if ! jq -e 'type == "array"' >/dev/null 2>&1 <<< "$utility_json"; then
    die "ALEPH_UTILITY_METRICS must be a JSON array"
  fi
  required_json="$(printf '%s' "${ALEPH_REQUIRED_METRICS:-score}" \
    | tr ',' '\n' | jq -R . | jq -s 'map(select(length > 0))')"

  jq -n \
    --arg name "${ALEPH_PROGRAM_NAME:-}" \
    --arg goal "${ALEPH_PROGRAM_GOAL:-}" \
    --arg methodology "${ALEPH_PROGRAM_METHODOLOGY:-}" \
    --arg ciEntry "${ALEPH_CI_ENTRY:-}" \
    --argjson timeoutMs "${ALEPH_CI_TIMEOUT_MS:-900000}" \
    --argjson requiredMetrics "$required_json" \
    --argjson utilityMetrics "$utility_json" \
    --arg exploration "${ALEPH_EXPLORATION:-normal}" \
    --argjson maxExperiments "${ALEPH_MAX_EXPERIMENTS:-3}" \
    --argjson maxComputeMinutes "${ALEPH_MAX_COMPUTE_MINUTES:-10}" \
    --argjson maxTokens "${ALEPH_MAX_TOKENS:-1000}" \
    --argjson issues "$issues_json" \
    '{
      case: {
        name: $name,
        goal: $goal,
        methodology: $methodology,
        contract: {
          ciEntry: $ciEntry,
          timeoutMs: $timeoutMs,
          requiredMetrics: $requiredMetrics
        },
        utility: {metrics: $utilityMetrics},
        exploration: $exploration,
        budget: {
          maxExperiments: $maxExperiments,
          maxComputeMinutes: $maxComputeMinutes,
          maxTokens: $maxTokens
        }
      },
      issues: $issues
    }'
}

normalize_config() {
  local raw="$1" out="$2"
  if ! jq -c '
    . as $root
    | if ($root | type) != "object" then error("config must be a JSON object") else $root end
    | if has("issues") and (.issues | type) != "array" then error("issues must be an array") else . end
    | (if has("case") then .case elif has("program") then .program else . end) as $p
    | if ($p | type) != "object" then error("case must be an object") else . end
    | if ($p.contract != null) and ($p.contract | type) != "object" then error("case.contract must be an object") else . end
    | if ($p.utility != null) and ($p.utility | type) != "object" then error("case.utility must be an object") else . end
    | if ($p.budget != null) and ($p.budget | type) != "object" then error("case.budget must be an object") else . end
    | {
        program: {
          name: ($p.name // ""),
          goal: ($p.goal // ""),
          methodology: ($p.methodology // ""),
          contract: {
            ciEntry: ($p.contract.ciEntry // ""),
            timeoutMs: ($p.contract.timeoutMs // 900000),
            requiredMetrics: ($p.contract.requiredMetrics // [])
          },
          utility: {
            metrics: ($p.utility.metrics // [])
          },
          exploration: ($p.exploration // "normal"),
          budget: {
            maxExperiments: ($p.budget.maxExperiments // 3),
            maxComputeMinutes: ($p.budget.maxComputeMinutes // 10),
            maxTokens: ($p.budget.maxTokens // 1000)
          }
        },
        issues: [
          (.issues // [])[]
          | if (type != "object") then error("each issue must be an object") else . end
          | {
              title: (.title // ""),
              body: (.body // ""),
              labels: (.labels // ["research"])
            }
        ]
      }
  ' "$raw" > "$out" 2> "$work_dir/config.err"; then
    die "invalid case config: $(cat "$work_dir/config.err")"
  fi
}

validate_config() {
  local norm="$1" errors
  errors="$(jq -r '
    def nonempty_string:
      if type == "string" then (gsub("\\s"; "") | length > 0) else false end;
    def metric_name:
      if type == "string" then
        length > 0 and length <= 64
        and ((test("[[:cntrl:]]")) | not)
        and (gsub("\\s"; "") | length > 0)
      else false end;
    def positive_int: if type == "number" then (. > 0 and . == floor) else false end;
    def positive_number: if type == "number" then . > 0 else false end;
    def nonnegative_number: if type == "number" then . >= 0 else false end;
    def valid_label:
      . == "research" or . == "experiment" or . == "analysis" or . == "bug" or . == "blocked";
    def valid_metric_array:
      if type == "array" then (length > 0 and all(.[]; metric_name)) else false end;
    def valid_label_array:
      if type == "array" then (length > 0 and all(.[]; valid_label)) else false end;
    def valid_metric_defs:
      if type == "array" then
        length > 0 and all(.[];
          (type == "object")
          and (.name | metric_name)
          and (.direction == "higher" or .direction == "lower")
          and (.weight | positive_number)
          and ((.required == null) or (.required | type == "boolean")))
      else false end;
    . as $c
    | [
        if ($c.program.name | nonempty_string) then empty else "program.name must be a non-empty string" end,
        if ($c.program.goal | nonempty_string) then empty else "program.goal must be a non-empty string" end,
        if ($c.program.methodology | nonempty_string) then empty else "program.methodology must be a non-empty string" end,
        if ($c.program.contract.ciEntry | nonempty_string) then empty else "program.contract.ciEntry must be a non-empty string" end,
        if ($c.program.contract.timeoutMs | nonnegative_number) then empty else "program.contract.timeoutMs must be a non-negative number" end,
        if ($c.program.contract.requiredMetrics | valid_metric_array) then empty else "program.contract.requiredMetrics must be a non-empty array of 1-64 printable metric names" end,
        if ($c.program.utility.metrics | valid_metric_defs) then empty else "program.utility.metrics must be a non-empty array of {name, direction, weight[, required]}" end,
        if ($c.program.exploration == "low" or $c.program.exploration == "normal" or $c.program.exploration == "high") then empty else "program.exploration must be low, normal or high" end,
        if ($c.program.budget.maxExperiments | positive_int) then empty else "program.budget.maxExperiments must be a positive integer" end,
        if ($c.program.budget.maxComputeMinutes | positive_int) then empty else "program.budget.maxComputeMinutes must be a positive integer" end,
        if ($c.program.budget.maxTokens | positive_int) then empty else "program.budget.maxTokens must be a positive integer" end,
        if (($c.issues | type) == "array" and ($c.issues | length) > 0) then empty else "issues must be a non-empty array" end,
        ($c.issues[]?
          | if (type == "object")
              and (.title | nonempty_string)
              and (.body | nonempty_string)
              and (.labels | valid_label_array)
            then empty
            else "each issue needs a non-empty title, a non-empty body, and a non-empty labels array using research, experiment, analysis, bug or blocked"
            end),
        if (($c.issues | map(.title) | length) == ($c.issues | map(.title) | unique | length)) then empty else "issue titles must be unique" end
      ]
    | .[]
  ' "$norm")"
  if [ -n "$errors" ]; then
    echo "error: invalid case config:" >&2
    printf '%s\n' "$errors" | sed 's/^/  - /' >&2
    exit 1
  fi
}

load_config() {
  local raw="$work_dir/config.raw.json" norm="$work_dir/config.normalized.json"
  if [ -n "$config_path" ]; then
    [ -f "$config_path" ] || die "case config not found: $config_path"
    cp "$config_path" "$raw"
  else
    build_env_config > "$raw"
  fi
  normalize_config "$raw" "$norm"
  validate_config "$norm"
}

http_get() {
  local url="$1" out="$2" code
  : > "$work_dir/http.err"
  code="$(curl -sS --connect-timeout "$connect_timeout" --max-time "$http_timeout" \
    -o "$out" -w '%{http_code}' "$url" 2> "$work_dir/http.err" || true)"
  if [ -z "$code" ] || [ "$code" = "000" ]; then
    printf '000'
  else
    printf '%s' "$code"
  fi
}

http_post() {
  local url="$1" body="$2" out="$3" code
  : > "$work_dir/http.err"
  code="$(curl -sS --connect-timeout "$connect_timeout" --max-time "$http_timeout" \
    -X POST -H 'content-type: application/json' --data-binary @"$body" \
    -o "$out" -w '%{http_code}' "$url" 2> "$work_dir/http.err" || true)"
  if [ -z "$code" ] || [ "$code" = "000" ]; then
    printf '000'
  else
    printf '%s' "$code"
  fi
}

show_http_error() {
  if [ -s "$work_dir/http.err" ]; then
    echo "curl:     $(sed -n '1,3p' "$work_dir/http.err" | tr '\n' ' ')" >&2
  fi
}

show_body() {
  local file="$1"
  if [ -s "$file" ] && jq -e . "$file" >/dev/null 2>&1; then
    jq . "$file"
  elif [ -s "$file" ]; then
    sed -n '1,120p' "$file"
  else
    echo "(empty response body)"
  fi
}

write_program_request() {
  local out="$1"
  jq -n --arg path "/aleph/api/programs" --arg actor "operator" \
    --slurpfile body "$work_dir/program.json" \
    '{path: $path, actorKind: $actor, body: $body[0]}' > "$out"
}

write_issue_request() {
  local program="$1" index="$2" out="$3" issue
  issue="$(jq -c --argjson i "$index" '.issues[$i]' "$work_dir/config.normalized.json")"
  jq -n --arg path "/aleph/api/programs/$program/issues" --arg actor "operator" \
    --arg program "$program" --argjson issue "$issue" \
    '{
      path: $path,
      actorKind: $actor,
      body: {
        programId: $program,
        title: $issue.title,
        body: $issue.body,
        labels: $issue.labels
      }
    }' > "$out"
}

print_plan() {
  local count i title
  count="$(jq -r '.issues | length' "$work_dir/config.normalized.json")"
  echo "endpoint:    POST $host_url/aleph/api/research/requests"
  echo "program:     POST /aleph/api/programs (program.create, actorKind=operator)"
  echo "issues:      $count (one POST /aleph/api/programs/:programId/issues each)"
  echo
  echo "== Program request =="
  write_program_request "$work_dir/program-request.json"
  jq . "$work_dir/program-request.json"
  echo
  echo "== Issue requests ($count) =="
  for ((i = 0; i < count; i += 1)); do
    title="$(jq -r --argjson i "$i" '.issues[$i].title' "$work_dir/config.normalized.json")"
    write_issue_request "<programId>" "$i" "$work_dir/issue-$i-request.json"
    echo "-- issue $((i + 1)): $title"
    jq . "$work_dir/issue-$i-request.json"
    echo
  done
  echo "After creation (--apply only): GET $host_url/aleph/api/research/programs/<programId>"
  echo "and verify the Program status, every Issue status, and the audit actions."
  echo "No Experiment is proposed: that needs a Host-injected Issue assignment and an"
  echo "Implementer ticket, so it remains a manual step after cutover."
}

wait_for_health() {
  local deadline=$((SECONDS + health_timeout)) code body persistent
  while [ "$SECONDS" -le "$deadline" ]; do
    code="$(http_get "$host_url/aleph/api/research/health" "$work_dir/health.json")"
    if [ "$code" = "200" ] && jq -e '.ok == true' "$work_dir/health.json" >/dev/null 2>&1; then
      persistent="$(jq -r '.persistent // false' "$work_dir/health.json")"
      if [ "$persistent" != "true" ] && [ "$allow_ephemeral" != "1" ]; then
        die "host reports persistent:false; refusing to create migration state that would be lost. Pass --allow-ephemeral only for a disposable test host"
      fi
      echo "health:      ok (persistent=$persistent)"
      return 0
    fi
    if [ "$code" = "503" ] && jq -e '.error.code == "research/build-missing"' \
      "$work_dir/health.json" >/dev/null 2>&1; then
      die "host has no compiled research runtime: $(jq -c '.error' "$work_dir/health.json")"
    fi
    sleep 2
  done
  body="$(cat "$work_dir/health.json" 2>/dev/null || true)"
  die "research health did not become ready within ${health_timeout}s (last http=${code:-none} body=${body:-no response})"
}

start_lab_if_needed() {
  local port
  lab_run_name="${lab_run_name:-migrate-$(date +%Y%m%d-%H%M%S)-$$}"
  lab_run_root="${ALEPH_RUN_ROOT:-/tmp/aleph-runs}/$lab_run_name"
  lab_log="$lab_run_root.lab.log"
  [ ! -e "$lab_run_root" ] || die "lab run already exists: $lab_run_root"
  mkdir -p "$(dirname "$lab_run_root")"
  echo "starting lab: $lab_run_root (ALEPH_SUPERAGENT_SMOKE=0; no research request)"
  lab_started=1
  if ! ALEPH_SUPERAGENT_SMOKE=0 ALEPH_SUPERAGENT_PROJECT= ALEPH_SUPERAGENT_REUSE=0 \
    timeout "$lab_timeout" "$repo/scripts/superagent-lab.sh" "$lab_run_name" \
    > "$lab_log" 2>&1; then
    echo "lab failed to start; see $lab_log" >&2
    tail -30 "$lab_log" >&2 || true
    exit 1
  fi
  [ -f "$lab_run_root/run.json" ] || die "lab did not write $lab_run_root/run.json"
  port="$(jq -r '.port // empty' "$lab_run_root/run.json")"
  if ! [[ "$port" =~ ^[0-9]+$ ]]; then
    die "lab run.json has no numeric port: $lab_run_root/run.json"
  fi
  host_url="http://127.0.0.1:$port"
  echo "lab:         $lab_run_root"
  echo "url:         $host_url"
}

check_duplicate() {
  local name code existing
  name="$(jq -r '.program.name' "$work_dir/config.normalized.json")"
  code="$(http_get "$host_url/aleph/api/research/programs" "$work_dir/programs.json")"
  if [ "$code" = "200" ] && jq -e '.ok == true' "$work_dir/programs.json" >/dev/null 2>&1; then
    existing="$(jq -r --arg name "$name" \
      '(.programs // [])[] | select(.name == $name) | .id' \
      "$work_dir/programs.json" | head -n 1)"
    if [ -n "$existing" ]; then
      if [ "$allow_duplicate" = "1" ]; then
        warn "a Program named '$name' already exists ($existing); --allow-duplicate is set"
      else
        die "a Program named '$name' already exists ($existing). Use another name, or pass --allow-duplicate for an intentional duplicate"
      fi
    fi
  elif [ "$code" = "404" ]; then
    warn "host cannot list Programs; duplicate-name check skipped"
  else
    warn "Program list check returned http=${code:-none}; duplicate-name check skipped"
  fi
}

create_program() {
  local code
  write_program_request "$work_dir/program-request.json"
  echo "POST $host_url/aleph/api/research/requests -> POST /aleph/api/programs"
  code="$(http_post "$host_url/aleph/api/research/requests" \
    "$work_dir/program-request.json" "$work_dir/program-response.json")"
  if [ "$code" != "201" ]; then
    echo "program request failed: http=${code:-none}" >&2
    show_http_error
    show_body "$work_dir/program-response.json" >&2
    exit 1
  fi
  if ! jq -e '
    .ok == true
    and (.value | type == "object")
    and (.value.id | type == "string" and length > 0)
    and (.value.status == "running")
  ' "$work_dir/program-response.json" >/dev/null 2>&1; then
    echo "program response was not a running Program:" >&2
    show_body "$work_dir/program-response.json" >&2
    exit 1
  fi
  program_id="$(jq -r '.value.id' "$work_dir/program-response.json")"
  echo "program:     $program_id"
}

create_issues() {
  local count i title code id
  count="$(jq -r '.issues | length' "$work_dir/config.normalized.json")"
  for ((i = 0; i < count; i += 1)); do
    title="$(jq -r --argjson i "$i" '.issues[$i].title' "$work_dir/config.normalized.json")"
    write_issue_request "$program_id" "$i" "$work_dir/issue-$i-request.json"
    echo "POST $host_url/aleph/api/research/requests -> POST /aleph/api/programs/$program_id/issues"
    echo "issue $((i + 1))/$count: $title"
    code="$(http_post "$host_url/aleph/api/research/requests" \
      "$work_dir/issue-$i-request.json" "$work_dir/issue-$i-response.json")"
    if [ "$code" != "201" ]; then
      echo "issue request failed: http=${code:-none}" >&2
      show_http_error
      show_body "$work_dir/issue-$i-response.json" >&2
      echo "partial migration: program $program_id exists; ${#issue_ids[@]} issue(s) created before this failure" >&2
      exit 1
    fi
    if ! jq -e '
      .ok == true
      and (.value | type == "object")
      and (.value.id | type == "string" and length > 0)
      and (.value.status == "open")
    ' "$work_dir/issue-$i-response.json" >/dev/null 2>&1; then
      echo "issue response was not an open Issue:" >&2
      show_body "$work_dir/issue-$i-response.json" >&2
      echo "partial migration: program $program_id exists; ${#issue_ids[@]} issue(s) created before this failure" >&2
      exit 1
    fi
    id="$(jq -r '.value.id' "$work_dir/issue-$i-response.json")"
    issue_ids+=("$id")
    echo "issue:       $id"
  done
}

verify_snapshot() {
  local code ids_json
  ids_json="$(jq -n --args '$ARGS.positional' "${issue_ids[@]}")"
  code="$(http_get "$host_url/aleph/api/research/programs/$program_id" "$work_dir/snapshot.json")"
  if [ "$code" != "200" ]; then
    echo "snapshot request failed: http=${code:-none}" >&2
    show_http_error
    show_body "$work_dir/snapshot.json" >&2
    exit 1
  fi
  if ! jq -e --arg pid "$program_id" --argjson ids "$ids_json" '
    . as $s
    | ($s.ok == true)
      and ($s.value | type == "object")
      and ($s.value.program.id == $pid)
      and ($s.value.program.status == "running")
      and (((($s.value.audit // []) | map(.action)) | index("program.created")) != null)
      and (([($s.value.audit // [])[] | select(.action == "issue.created")] | length) >= ($ids | length))
      and (($ids | all(. as $iid | ([($s.value.issues // [])[] | select(.id == $iid and .status == "open")] | length) == 1)))
      and (((($s.audit // []) | length) == (($s.value.audit // []) | length)))
  ' "$work_dir/snapshot.json" >/dev/null 2>&1; then
    echo "snapshot/audit verification failed:" >&2
    show_body "$work_dir/snapshot.json" >&2
    exit 1
  fi
  jq -r '
    "snapshot verified: program \(.value.program.id) status=\(.value.program.status) issues=\(.value.issues | length) audit=\(.value.audit | length)",
    "audit actions: \([.value.audit[].action] | unique | join(", "))"
  ' "$work_dir/snapshot.json"
}

check_build
detect_legacy

if [ "$mode" = "apply" ] && [ "$legacy_found" = "1" ]; then
  echo "refusing --apply: archive or retire the legacy markers first (nothing was changed)" >&2
  exit 2
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/aleph-case-migrate.XXXXXX")"
load_config
jq '.program' "$work_dir/config.normalized.json" > "$work_dir/program.json"

if [ "$mode" = "dry-run" ]; then
  echo "mode:        dry-run (no HTTP request, no lab, no experiment)"
  echo "host:        $host_url (not contacted)"
  echo "research-core: built"
  echo
  print_plan
  echo
  if [ "$legacy_found" = "1" ]; then
    echo "DRY-RUN: --apply would be refused until the legacy markers above are archived or retired."
  else
    echo "DRY-RUN: no legacy markers found; --apply would create the Program and Issues above."
  fi
  echo "No file, branch, Program, Issue, Experiment, ticket, worker or evaluation was created."
  exit 0
fi

if [ "$start_lab" = "1" ]; then
  start_lab_if_needed
fi

wait_for_health
check_duplicate
create_program
create_issues
verify_snapshot

echo
echo "migration applied: program $program_id with ${#issue_ids[@]} issue(s)"
for ((i = 0; i < ${#issue_ids[@]}; i += 1)); do
  echo "  issue[$((i + 1))]: ${issue_ids[$i]}"
done
echo "created: Program + Issues only"
echo "not created: Experiments, CI requests, Implementer tickets, workers, evaluations"
echo "next (manual): a Researcher claims each Issue and proposes an Experiment; the Host"
echo "injects the assignment, samples the base and opens the Implementer ticket."
if [ "$start_lab" = "1" ]; then
  echo "the lab is stopped on exit; its run directory and log are kept under $lab_run_root"
fi
