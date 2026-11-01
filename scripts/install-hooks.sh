#!/usr/bin/env bash
# Point this clone at the repository hooks so pre-commit and pre-push run.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

git config core.hooksPath .githooks
echo "hooks installed: $(git config --get core.hooksPath)"
echo "pre-commit checks staged syntax; pre-push runs scripts/verify.sh"
