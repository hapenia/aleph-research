#!/usr/bin/env bash
# Start an isolated DSH lab on the dsh-superagent composition.
#
#   scripts/superagent-lab.sh [run-name] [port]
#
# Builds the vendored prototype if needed, creates a dedicated profile that mounts
# only the superagent bundle, configures the GitHub account check, and waits until
# the main Session exists. Writes <run>/run.json with the panel URL.
#
# Iteration knobs (all optional):
#   ALEPH_REBUILD_VENDOR=1        rebuild the vendored prototype even when current
#   ALEPH_SUPERAGENT_PROFILE_FROM=<dsh-home>
#                                 copy a previously built profile from that DSH home
#                                 before creating one; it is then reused as-is
#   ALEPH_REBUILD_PROFILE=1       create the profile afresh even if it already exists
#   ALEPH_FORCE_INSTALL=1         run npm install for the extension even when current
#   ALEPH_ROLE_EFFORT=<effort>    reasoning effort for the eval and executor roles
#                                 (default low; the agent default keeps max)
#   ALEPH_AGENT_EFFORT=<effort>   reasoning effort of the agent default model
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
vendor="$repo/vendor/dsh-superagent"
run_name="${1:-sa-$(date +%Y%m%d-%H%M%S)}"
run_root="${ALEPH_RUN_ROOT:-/tmp/aleph-runs}/$run_name"
profile="${ALEPH_SUPERAGENT_PROFILE:-aleph-superagent}"
github_repository="${ALEPH_SUPERAGENT_REPOSITORY:-hapenia/aleph-research}"

# The Eval decision and the Worker turn are seeded with an explicit role model:
# inheriting the agent default would spend minutes of max-effort thinking on the
# one-line smoke ticket. Same provider and model as the default, lower effort.
role_provider="${ALEPH_ROLE_PROVIDER:-opencode-go}"
role_model="${ALEPH_ROLE_MODEL:-deepseek-v4.1-flash}"
role_effort="${ALEPH_ROLE_EFFORT:-low}"
agent_effort="${ALEPH_AGENT_EFFORT:-max}"

[ -d "$vendor" ] || { echo "no vendored prototype at $vendor" >&2; exit 1; }
[ -e "$run_root" ] && { echo "run already exists: $run_root" >&2; exit 1; }

# shellcheck source=phase-timing.sh
source "$repo/scripts/phase-timing.sh"

port="${2:-}"
if [ -z "$port" ]; then
  port=40201
  while ss -ltn 2>/dev/null | grep -q ":$port "; do port=$((port + 1)); done
fi

# A tiny research fixture: one repository with a template branch plus a data
# directory, so a ticket can create a worktree and analyse something real.
fixtures="$run_root/fixtures"
if [ ! -d "$fixtures/research/.git" ]; then
  mkdir -p "$fixtures/research" "$fixtures/data"
  git -C "$fixtures/research" init -q -b main
  printf '# Research repository\n\nTicket worktrees start from this branch.\n' > "$fixtures/research/README.md"
  git -C "$fixtures/research" -c user.name=AlephResearch -c user.email=aleph@localhost add -A >/dev/null 2>&1
  git -C "$fixtures/research" -c user.name=AlephResearch -c user.email=aleph@localhost commit -qm "research fixture" >/dev/null 2>&1
  printf 'well,por,perm,sw\nw1,0.10,0.01,99.9\nw1,0.18,12.5,45.2\nw2,0.10,0.01,99.9\nw2,0.22,88.0,31.7\n' > "$fixtures/data/labels.csv"
  cat > "$fixtures/eval.sh" <<'EVAL'
#!/usr/bin/env bash
# Fixture evaluation: record that it ran, then print the score JSON the Host reads.
set -euo pipefail
printf 'ran %s commit %s ticket %s\n' "$(date -Is)" "${ALEPH_COMMIT:-none}" "${ALEPH_TICKET:-none}" > .aleph-eval-ran
python3 -c 'import json; print(json.dumps({"score": 80.0}))'
EVAL
fi

# Rebuild only when the build output is missing or older than any source, package
# manifest or local patch. A stale check beats rebuilding the prototype every run.
vendor_is_current() {
  local ref="$vendor/lib/.build-stamp" stale
  # The patch series is reversed after the build, which rewrites source mtimes, so
  # the stamp written once the build script has fully returned is the real boundary.
  [ -f "$ref" ] || ref="$vendor/lib/index.js"
  [ -f "$ref" ] || return 1
  stale="$(find "$vendor/src" "$vendor/package.json" "$vendor/tsdown.config.ts" \
    "$repo/vendor/patches" -newer "$ref" -print -quit 2>/dev/null || true)"
  [ -z "$stale" ]
}
if [ -n "${ALEPH_REBUILD_VENDOR:-}" ] || ! vendor_is_current; then
  echo "building vendored prototype"
  "$repo/scripts/build-superagent-vendor.sh" >/dev/null
  # The build script's EXIT trap reverses the patches, so source files end up newer
  # than lib/; stamp the finished, restored tree for the next run to compare against.
  touch "$vendor/lib/.build-stamp"
fi
phase "vendored prototype"

mkdir -p "$run_root/dsh/home" "$run_root/work"
export DSH_HOME="$run_root/dsh"
export HOME="$run_root/dsh/home"

# Reuse a built profile: creating it installs the bundle into the profile, which is
# fixed cost on every run. A copy keeps the relative links into vendor/ and
# superagent-extension/ intact because the profile sits at the same depth.
profile_dir="$DSH_HOME/profiles/$profile"
if [ -n "${ALEPH_SUPERAGENT_PROFILE_FROM:-}" ] && [ ! -d "$profile_dir" ]; then
  from="$ALEPH_SUPERAGENT_PROFILE_FROM"
  if [ -d "$from/profiles/$profile" ]; then
    mkdir -p "$DSH_HOME/profiles"
    cp -a "$from/profiles/." "$DSH_HOME/profiles/"
    echo "copied built profile from $from"
  fi
fi
profile_reused=0
if [ -d "$profile_dir" ] && [ -z "${ALEPH_REBUILD_PROFILE:-}" ]; then
  echo "reusing built profile at $profile_dir"
  profile_reused=1
else
  # A dedicated profile: the prototype changes process-wide PATH and git settings,
  # so it must not share a profile with the default agent tooling.
  dsh --profile "$profile" --from-default-profile web --help >/dev/null
  dsh plugin --profile "$profile" add "$vendor" >/dev/null

  # AlephResearch extension: mounts the aleph Source, evaluation and (later) the
  # research panel on top of the prototype bundle.
  extension="$repo/superagent-extension"
  if [ -d "$extension" ]; then
    # A linked plugin keeps its own dependencies. npm records the install in
    # node_modules/.package-lock.json, so a newer lock there means the tree
    # already matches package.json.
    if [ -n "${ALEPH_FORCE_INSTALL:-}" ] || [ ! -d "$extension/node_modules" ] \
      || [ ! -f "$extension/node_modules/.package-lock.json" ] \
      || [ "$extension/package.json" -nt "$extension/node_modules/.package-lock.json" ] \
      || { [ -f "$extension/package-lock.json" ] && [ "$extension/package-lock.json" -nt "$extension/node_modules/.package-lock.json" ]; }; then
      (cd "$extension" && npm install --no-audit --no-fund --silent)
    else
      echo "extension dependencies are current"
    fi
    dsh plugin --profile "$profile" add "$extension" >/dev/null
  fi
fi
phase "profile/plugin install"

patch="$DSH_HOME/profiles/$profile/cordis.patch.yml"
# A reused profile carries the previous run's port and state directory, and the
# patch file holds only the blocks appended below, so it is regenerated.
if [ "$profile_reused" = 1 ]; then printf '' > "$patch"
elif grep -qx '\[\]' "$patch"; then printf '' > "$patch"; fi
cat >> "$patch" <<YAML
- id: webserver
  config:
    host: 127.0.0.1
    port: $port
- id: dsh-superagent
  config:
    stateDir: $run_root/state
# Confine every shell to workspace-write with no approval prompt: the lab runs
# unattended, and the restricted runner is the enforcement point.
- id: permission
  config:
    defaultPreset: workspace-write
    presets:
      read-only:
        sandbox: read-only
        approval: never
      workspace-write:
        sandbox: workspace-write
        approval: never
      danger-full-access:
        sandbox: danger-full-access
        approval: never
- id: sandbox
  config:
    runnerCommand: ["bash", "$repo/scripts/bwrap-restricted.sh"]
    runnerFailureSignatures: ["aleph-sandbox:"]
# The sandbox must also expose the run directory, because the ticket worktree's
# gitdir points at the research repository next to the state directory.
- id: sandbox-policy
  config:
    mode: workspace-write
    workspaceRoot: $run_root/state
    # The ticket worktrees live under the state directory; their gitdir points into
    # the fixture repository. The fixture data directory stays outside both, so a
    # Worker cannot read the source data it was only meant to receive a copy of.
    additionalWritableRoots: ["$run_root/state", "$run_root/fixtures/research"]
- id: agent-default-model
  config:
    provider: $role_provider
    model: $role_model
    reasoningEffort: $agent_effort
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      opencode-go:
        apiKeyEnv: OPENCODE_GO_API_KEY
YAML

real_home="${ALEPH_REAL_HOME:-/home/hapenia}"
cp "$real_home/.dsh/.credentials.yaml" "$DSH_HOME/.credentials.yaml"
api_key="$(sed -n 's/.*OPENCODE_GO_API_KEY:[[:space:]]*\([^[:space:]]*\).*/\1/p' "$DSH_HOME/.credentials.yaml" | head -1)"
# gh keeps its login in the operator's keyring; point the isolated HOME at the
# operator's gh config so the deployment check can read the account. A token in an
# environment variable is scrubbed from child processes by the harness.
gh_config_dir="${GH_CONFIG_DIR:-$real_home/.config/gh}"

# Only these roots are readable by sandboxed commands; the case runtime is added by
# the case lab when it points at one.
aleph_read_roots="${ALEPH_READ_ROOTS:-/usr:/bin:/sbin:/lib:/lib64:/etc:/opt:/run}"

# Sessions keep the prototype's danger-full-access unless the deployment asks for
# confinement; the lab wants the sandbox runner to be the enforcement point.
DSH_HOME="$DSH_HOME" HOME="$HOME" GH_CONFIG_DIR="$gh_config_dir" ALEPH_READ_ROOTS="$aleph_read_roots" ALEPH_SESSION_PERMISSION="${ALEPH_SESSION_PERMISSION:-workspace-write}" ALEPH_CHANNEL_DIR="$run_root/state/aleph-channel" ALEPH_RESULTS_DIR="$run_root/state/results" ALEPH_WORKER_TOOLS="aleph_submit_result" OPENCODE_GO_API_KEY="$api_key" \
  nohup dsh --profile "$profile" --no-open --host 127.0.0.1 --port "$port" \
  > "$run_root/host.log" 2>&1 &
echo $! > "$run_root/host.pid"

token=""
for _ in $(seq 1 120); do
  token="$(grep -o 'token=[A-Za-z0-9_-]*' "$run_root/host.log" 2>/dev/null | head -1 | cut -d= -f2 || true)"
  [ -n "$token" ] && break
  sleep 0.5
done
[ -n "$token" ] || { echo "host did not start; see $run_root/host.log" >&2; exit 1; }

url="http://127.0.0.1:$port/?token=$token"
curl -sS -m 10 -c "$run_root/cookie.txt" "$url" >/dev/null

api="http://127.0.0.1:$port/orchestrator/api"
state=""
for _ in $(seq 1 120); do
  state="$(curl -sS -m 5 -H 'x-orchestrator-request: 1' "$api/state" 2>/dev/null || true)"
  [ -n "$state" ] && break
  sleep 0.5
done
[ -n "$state" ] || { echo "orchestrator API did not answer; see $run_root/host.log" >&2; exit 1; }
phase "host start"

# Wait for the first deployment check to settle, then give it the repository it
# needs. Workers receive gh/git shims even while the GitHub Source stays off.
setup_problem() {
  curl -sS -m 5 -H 'x-orchestrator-request: 1' "$api/state" 2>/dev/null | python3 -c '
import json, sys
try:
    problem = (json.load(sys.stdin).get("setup") or {}).get("problem")
except Exception:
    problem = None
print("" if not problem else problem.get("code", "problem"))
' 2>/dev/null || true
}
for _ in $(seq 1 60); do
  problem="$(setup_problem)"
  [ "$problem" != "" ] && break
  sleep 1
done
if [ -z "${problem:-}" ]; then
  echo "setup already resolved"
elif [ "$problem" = "repositoryUnset" ] || [ "$problem" = "agentCliSignedOut" ] || [ "$problem" = "agentCliUnset" ]; then
  revision="$(curl -sS -H 'x-orchestrator-request: 1' "$api/settings" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next(s["revision"] for s in d["sources"] if s["id"]=="github"))')"
  curl -sS -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' \
    "$api/settings/source:github" \
    -d "{\"value\":{\"enabled\":false,\"config\":{\"repository\":\"$github_repository\",\"cli\":\"gh\",\"observeIssues\":false,\"observePulls\":false,\"observeComments\":false,\"observeCi\":false}},\"revision\":$revision}" >/dev/null || true
  curl -sS -X POST -H 'x-orchestrator-request: 1' "$api/setup/check" >/dev/null || true
  sleep 6
fi
for _ in $(seq 1 60); do
  problem="$(setup_problem)"
  [ -z "$problem" ] && break
  sleep 1
done
if [ -n "${problem:-}" ]; then
  echo "deployment check still failing: $problem" >&2
  curl -sS -H 'x-orchestrator-request: 1' "$api/state" >&2 || true
  exit 1
fi
phase "deployment check"

master=""
for _ in $(seq 1 60); do
  payload="$(curl -sS -m 5 -H 'x-orchestrator-request: 1' "$api/state" 2>/dev/null || true)"
  master="$(printf '%s' "$payload" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("masterId") or "")' 2>/dev/null || true)"
  [ -n "$master" ] && break
  sleep 1
done
[ -n "$master" ] || { echo "main Session did not start; see $run_root/host.log" >&2; exit 1; }
phase "main session"

# Point the research Source at the fixture, give the Executor its prepare command,
# and enable one research rule with automatic acceptance. Everything here is a
# setting: changing it later needs no restart.
api="http://127.0.0.1:$port/orchestrator/api"
python3 - "$api" "$fixtures" "$repo" "$role_provider" "$role_model" "$role_effort" <<'PYSEED'
import json, sys, urllib.error, urllib.request

api, fixtures, repo, role_provider, role_model, role_effort = sys.argv[1:7]
role = {'provider': role_provider, 'model': role_model, 'reasoningEffort': role_effort}

def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(api + path, data=data, method=method,
        headers={'x-orchestrator-request': '1', 'content-type': 'application/json'})
    try:
        with urllib.request.urlopen(request) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        return {'http_error': error.code, 'body': error.read().decode()[:400]}

settings = call('GET', '/settings')
revision = {source['id']: source['revision'] for source in settings['sources']}
aleph = next(source for source in settings['sources'] if source['id'] == 'aleph')
config = {
    'project': 'fixture',
    'repository': f'{fixtures}/research',
    'templateBranch': 'main',
    'dataDir': f'{fixtures}/data',
    'python': sys.executable,
    'conventions': 'Analyse data/ and write findings as Markdown files in this worktree.',
    'evalCommand': f'sh {fixtures}/eval.sh',
    'evalTimeoutMs': 120000,
}
def saved(label, result):
    print(label + ':', result)
    if result.get('http_error'):
        raise SystemExit(f'{label} was refused')

saved('source aleph', call('PUT', '/settings/source:aleph', {
    'value': {'enabled': True, 'config': {**aleph.get('value', {}).get('config', {}), **config}},
    'revision': revision['aleph'],
}))

executor = settings['blocks']['executor']
value = dict(executor['value'])
value['model'] = role
value['prepare'] = f'sh {repo}/scripts/superagent-prepare.sh'
# gh, git and lark-cli are reserved by the prototype and cannot be blocked;
# the research instructions forbid pushing and the Channel never pushes.
value['blockedCommands'] = ['sudo', 'podman', 'docker']
saved('executor', call('PUT', '/settings/executor', {'value': value, 'revision': executor['revision']}))

policy = settings['blocks']['policy']
value = dict(policy['value'])
value['rules'] = [{
    'id': 'research',
    'name': 'Research work',
    'enabled': True,
    'instruction': 'Requests to measure, analyse, model or report on the research project data. Accept when the requested direction and target are settled.',
}]
sources = dict(value.get('sources') or {})
sources['aleph'] = {'allowed': [{'id': 'operator', 'name': 'operator'}]}
sources['github'] = sources.get('github') or {'allowed': [{'id': 'hapenia'}]}
value['sources'] = sources
saved('policy', call('PUT', '/settings/policy', {'value': value, 'revision': policy['revision']}))

eval_block = settings['blocks']['eval']
value = dict(eval_block['value'])
value['mode'] = 'auto'
value['model'] = role
saved('eval', call('PUT', '/settings/eval', {'value': value, 'revision': eval_block['revision']}))
PYSEED
phase "settings seed"

if [ "${ALEPH_SUPERAGENT_SMOKE:-0}" = "1" ]; then
  echo "smoke: sending one research request"
  curl -sS -X POST -H 'content-type: application/json' \
    -d '{"project":"fixture","ticket":"fixture-smoke","requestId":"smoke-1","text":"Read data/labels.csv. Write a short findings.md with two lines: the row count per well and the clipped floor of por. Commit it once, then call aleph_submit_result (required before reporting) and report the score."}' \
    "http://127.0.0.1:$port/aleph/api/trigger" || true
  echo
  date +%s%3N > "$run_root/request-at.ms"
fi
phase "smoke request"

python3 - "$run_root" "$port" "$token" "$url" "$master" <<'PY'
import json, sys
run_root, port, token, url, master = sys.argv[1:6]
info = {
    "run_root": run_root, "port": int(port), "url": url, "token": token,
    "master_session": master, "dsh_home": f"{run_root}/dsh", "state_dir": f"{run_root}/state",
}
json.dump(info, open(f"{run_root}/run.json", "w"), indent=2)
print(json.dumps(info, indent=2))
PY
phase "total"
