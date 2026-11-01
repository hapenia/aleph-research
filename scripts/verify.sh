#!/usr/bin/env bash
# The gate every branch passes before it is pushed or merged.
#
#   scripts/verify.sh          # syntax plus the extension test suite
#   scripts/verify.sh --docs   # the same, then the documentation lint when installed
#
# CI runs the extension syntax check and the tests; keep this script a superset so a
# green local run implies a green CI run.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

docs=0
[ "${1:-}" = "--docs" ] && docs=1

echo "== syntax: extension sources"
node --check superagent-extension/index.js
node --check superagent-extension/research-extension.js
node --check superagent-extension/client.js

echo "== syntax: shell scripts"
for script in scripts/*.sh; do
  bash -n "$script"
done

if [ -f research-core/package.json ]; then
  echo "== typecheck: research core blueprint"
  (cd research-core && npm install --no-audit --no-fund --silent && npm run -s typecheck)
fi

if [ -f superagent-extension/package.json ]; then
  echo "== tests: superagent extension"
  (cd superagent-extension && npm install --no-audit --no-fund --silent && npm test --silent)
fi

if [ "$docs" = "1" ]; then
  lint="${ALEPH_DOC_LINT:-$HOME/.dsh/skills/chinese-writing-standard/scripts/lint_chinese_writing.py}"
  if [ -f "$lint" ]; then
    echo "== docs: writing standard"
    python3 "$lint" README.md docs/*.md
  else
    echo "== docs: lint script not installed, skipped"
  fi
fi

echo "verify: ok"
