#!/usr/bin/env bash
# Seed the new research runtime with a Program, Issues and one Experiment plan.
# This is the test-case entry point that replaces the legacy chat request.
set -euo pipefail
url="${ALEPH_RESEARCH_URL:-http://127.0.0.1:40201}"
program_name="${ALEPH_PROGRAM_NAME:-kunlungpt-research}"
program_goal="${ALEPH_PROGRAM_GOAL:-Predict POR, PERM and SW for unseen kunlungpt wells and maximise the official score.}"
methodology="${ALEPH_PROGRAM_METHODOLOGY:-Inspect the visible data, keep a reproducible baseline, and iterate only through Issues whose acceptance is measurable by CI.}"
ci_entry="${ALEPH_CI_ENTRY:-sh eval/run_eval.sh}"

post() {
  local path="$1" actor="$2" body="$3"
  jq -n --arg path "$path" --arg actor "$actor" --argjson body "$body" \
    '{path:$path, actorKind:$actor, body:$body}' |
    curl -sS -m 30 -X POST "$url/aleph/api/research/requests" \
      -H 'content-type: application/json' --data-binary @- |
    jq -c .
}

check_ok() {
  local label="$1" response="$2"
  if [ "$(printf '%s' "$response" | jq -r '.ok')" != "true" ]; then
    echo "$label failed: $response" >&2
    exit 1
  fi
}

program_body="$(jq -n \
  --arg name "$program_name" --arg goal "$program_goal" \
  --arg methodology "$methodology" --arg ci "$ci_entry" \
  '{name:$name, goal:$goal, methodology:$methodology,
    contract:{ciEntry:$ci, timeoutMs:900000, requiredMetrics:["score"]},
    utility:{metrics:[{name:"score", direction:"higher", weight:1, required:true}]},
    exploration:"normal",
    budget:{maxExperiments:12, maxComputeMinutes:120, maxTokens:200000}}')"
response="$(post /aleph/api/programs operator "$program_body")"
check_ok "program.create" "$response"
program_id="$(printf '%s' "$response" | jq -r '.value.id')"

issue_ids=()
create_issue() {
  local title="$1" body="$2" label="$3"
  local payload response id
  payload="$(jq -n --arg pid "$program_id" --arg title "$title" --arg body "$body" --arg label "$label" \
    '{programId:$pid, title:$title, body:$body, labels:[$label]}')"
  response="$(post "/aleph/api/programs/$program_id/issues" operator "$payload")"
  check_ok "issue.create ($title)" "$response"
  id="$(printf '%s' "$response" | jq -r '.value.id')"
  issue_ids+=("$id")
  echo "issue $id: $title"
}
create_issue "Reproduce the legacy baseline" "Recreate the case baseline in the research scaffold, record the exact environment, and let CI establish the first score." research
create_issue "Improve porosity prediction" "Test one clearly stated change to the porosity model against the baseline. Acceptance is a higher total score with no required metric missing." experiment

claim_payload='{}'
response="$(post "/aleph/api/programs/$program_id/issues/${issue_ids[0]}/claim" researcher "$claim_payload")"
check_ok "issue.claim" "$response"

plan="$(jq -n '{hypothesis:"A reproducible LightGBM baseline using density/neutron/sonic features establishes a valid score and exposes the strongest signal for POR.",
  steps:["Load the visible wells by column name and treat any value <= -9999 as missing.",
         "Build density/neutron/sonic porosity and basic log-normalised features.",
         "Train per-target LightGBM regressors with GroupKFold by well.",
         "Write predict.py and requirements.txt, commit, and submit the commit for CI."],
  expected:{direction:"higher", rationale:"The baseline should score above the constant floor prediction and provide a trustworthy starting point."},
  environment:{kind:"requirements", requirementsFile:"requirements.txt", pythonVersion:"3.14"},
  inputs:[]}')"
experiment_body="$(jq -n --arg pid "$program_id" --arg iid "${issue_ids[0]}" --argjson plan "$plan" \
  '{programId:$pid, issueId:$iid, plan:$plan}')"
response="$(post "/aleph/api/programs/$program_id/issues/${issue_ids[0]}/experiments" researcher "$experiment_body")"
check_ok "experiment.propose" "$response"
experiment_id="$(printf '%s' "$response" | jq -r '.value.id')"

echo "program: $program_id"
echo "issues: ${issue_ids[*]}"
echo "experiment: $experiment_id"
echo "snapshot:"
curl -sS -m 30 "$url/aleph/api/research/programs/$program_id" |
  jq -c '{program:.value.program.status,
           issues:[.value.issues[]|{id,status,experimentIds}],
           experiments:[.value.experiments[]|{id,status,lineage:.lineage.strategy}],
           audit:[.value.audit[]|.action]}'
