#!/usr/bin/env bash
# Reproduce the isolated DSH lab: a private DSH_HOME, a web profile, the
# plugin bundle and a toy leader workspace. The current DSH profile is not used.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
lab="${1:-/tmp/aleph-dsh-lab}"
port="${2:-39871}"

HOME_REAL="${HOME}"
export DSH_HOME="$lab"
export HOME="$lab/home"
mkdir -p "$HOME" "$lab/leader"

dsh --profile aleph-lab --from-default-profile web --help >/dev/null
(cd "$repo/dsh-plugin" && npm install --no-save --silent)
dsh plugin --profile aleph-lab add "$repo/dsh-plugin" >/dev/null

patch="$DSH_HOME/profiles/aleph-lab/cordis.patch.yml"
if [ -f "$patch" ] && ! grep -q 'opencode-go' "$patch"; then
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
  echo "patched profile:   opencode-go provider, full access"
fi

# Agent turns in the lab authenticate with the same key the desktop profile uses.
if [ -f "$HOME_REAL/.dsh/.credentials.yaml" ] && [ ! -f "$DSH_HOME/.credentials.yaml" ]; then
  cp "$HOME_REAL/.dsh/.credentials.yaml" "$DSH_HOME/.credentials.yaml"
fi

echo "isolated DSH_HOME: $DSH_HOME"
echo "leader workspace:  $lab/leader"
echo "start:             DSH_HOME=$DSH_HOME HOME=$HOME dsh --profile aleph-lab --no-open --host 127.0.0.1 --port $port"
