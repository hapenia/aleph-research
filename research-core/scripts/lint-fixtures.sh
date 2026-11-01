#!/usr/bin/env bash
# Prove the boundary lint configurations reject what they claim to reject.
#
# The normal `research-core` lint only scans `src/`, and the adapter lint only scans the
# adapter package, so neither ever sees a violation. This script copies the real configs
# and the fixture sources into throwaway directories and runs the real tools against
# them:
#
#   1. research-core ESLint config against `lint-fixtures/core-eslint/`;
#   2. research-core ast-grep config (rules + ignores) against `lint-fixtures/core-ast-grep/`;
#   3. superagent-extension ESLint config against `lint-fixtures/adapter/`.
#
# Every invalid fixture must be rejected by the specific rule that owns its violation,
# and every valid control must pass cleanly. A fixture that is accepted, a control that
# is rejected, a missing tool or an unreadable diagnostics file all make the script exit
# nonzero, so a config that silently stops enforcing the boundary cannot pass silently.
#
# Run it directly (`bash research-core/scripts/lint-fixtures.sh`) or through
# `scripts/verify.sh` / CI once wired. The fixtures are never part of `tsc`'s `include`
# and never part of the `src`-scoped lint runs.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$ROOT/.." && pwd)"
FIXTURES="$ROOT/lint-fixtures"
ESLINT="$ROOT/node_modules/eslint/bin/eslint.js"
ASTGREP="$ROOT/node_modules/.bin/ast-grep"
ADAPTER_CONFIG="$REPO/superagent-extension/eslint.config.js"
ADAPTER_PACKAGE="$REPO/superagent-extension/package.json"

failed=0
tmpdirs=()
rejected=0
accepted=0

cleanup() {
  local dir
  for dir in "${tmpdirs[@]:-}"; do
    [ -n "$dir" ] && rm -rf "$dir"
  done
}
trap cleanup EXIT

new_tmp() {
  local dir
  dir="$(mktemp -d "${TMPDIR:-/tmp}/aleph-lint-fixtures.XXXXXX")" || return 1
  tmpdirs+=("$dir")
  printf '%s\n' "$dir"
}

fail() {
  printf 'lint-fixtures: %s\n' "$*" >&2
  failed=1
}

note() {
  printf '%s\n' "$*"
}

# Count one expectations file into the running rejected/accepted totals.
count_expectations() {
  local expectations="$1" name rule
  while IFS=$'\t' read -r name rule; do
    [ -n "$name" ] || continue
    if [ -n "${rule:-}" ]; then
      rejected=$((rejected + 1))
    else
      accepted=$((accepted + 1))
    fi
  done < "$expectations"
}

# validate <label> <eslint|ast-grep> <diagnostics-json> <expectations-tsv>
#
# The TSV has one fixture per line: "<file>\t<expected-rule-id>" means the fixture must
# be rejected by that rule; "<file>\t" means it must be accepted with no diagnostics.
validate() {
  local label="$1" mode="$2" diagnostics="$3" expectations="$4"
  python3 - "$label" "$mode" "$diagnostics" "$expectations" <<'PY'
import json
import sys

label, mode, diagnostics_path, expectations_path = sys.argv[1:5]

try:
    with open(diagnostics_path, encoding="utf-8") as handle:
        raw = json.load(handle)
except (OSError, json.JSONDecodeError) as error:
    print(f"FAIL [{label}] cannot read diagnostics from {diagnostics_path}: {error}", file=sys.stderr)
    raise SystemExit(2)

found: dict[str, set[str]] = {}
if mode == "eslint":
    for entry in raw:
        name = str(entry.get("filePath", "")).rsplit("/", 1)[-1]
        rules = found.setdefault(name, set())
        for message in entry.get("messages", []):
            rule = message.get("ruleId")
            if rule:
                rules.add(str(rule))
else:
    for entry in raw:
        name = str(entry.get("file", "")).rsplit("/", 1)[-1]
        found.setdefault(name, set()).add(str(entry.get("ruleId")))

failures = 0
checked = 0
with open(expectations_path, encoding="utf-8") as handle:
    for line in handle:
        line = line.rstrip("\n")
        if not line:
            continue
        checked += 1
        name, _, expected = line.partition("\t")
        rules = sorted(found.get(name, set()))
        if expected:
            if expected in rules:
                print(f"ok [{label}] {name} rejected by {expected}")
            else:
                print(
                    f"FAIL [{label}] {name}: expected rejection by {expected}, got {rules or 'no diagnostic (fixture accepted)'}",
                    file=sys.stderr,
                )
                failures += 1
        elif rules:
            print(f"FAIL [{label}] {name}: expected to be accepted, got {rules}", file=sys.stderr)
            failures += 1
        else:
            print(f"ok [{label}] {name} accepted")

if checked == 0:
    print(f"FAIL [{label}] no expectations checked", file=sys.stderr)
    raise SystemExit(2)
raise SystemExit(3 if failures else 0)
PY
}

run_core_eslint() {
  local dir expectations
  dir="$(new_tmp)" || { fail "cannot create a temporary directory"; return; }
  cp "$ROOT/eslint.config.js" "$ROOT/tsconfig.json" "$ROOT/package.json" "$dir/" || { fail "cannot stage core eslint config"; return; }
  ln -s "$ROOT/node_modules" "$dir/node_modules" || { fail "cannot link core node_modules"; return; }
  mkdir -p "$dir/src" && cp "$FIXTURES"/core-eslint/*.ts "$dir/src/" || { fail "cannot stage core eslint fixtures"; return; }
  expectations="$dir/expectations.tsv"
  cat > "$expectations" <<'TSV'
type-assertion.ts	@typescript-eslint/consistent-type-assertions
non-null-assertion.ts	@typescript-eslint/no-non-null-assertion
explicit-any.ts	@typescript-eslint/no-explicit-any
type-predicate.ts	no-restricted-syntax
json-parse.ts	no-restricted-syntax
dynamic-import.ts	no-restricted-syntax
boundary-import.ts	no-restricted-imports
ts-suppression.ts	@typescript-eslint/ban-ts-comment
global-clock.ts	no-restricted-syntax
process-global.ts	no-restricted-globals
clean.ts	
factories.ts	
TSV
  count_expectations "$expectations"
  note "== fixtures: research-core ESLint boundary"
  ( cd "$dir" && node "$ESLINT" . --format json > "$dir/diagnostics.json" 2> "$dir/tool-stderr.txt" )
  if ! validate "core-eslint" "eslint" "$dir/diagnostics.json" "$expectations"; then
    failed=1
    head -20 "$dir/tool-stderr.txt" >&2
  fi
}

run_core_ast_grep() {
  local dir expectations
  dir="$(new_tmp)" || { fail "cannot create a temporary directory"; return; }
  cp -a "$ROOT/ast-grep" "$dir/ast-grep" || { fail "cannot stage ast-grep config"; return; }
  mkdir -p "$dir/src" && cp "$FIXTURES"/core-ast-grep/*.ts "$dir/src/" || { fail "cannot stage ast-grep fixtures"; return; }
  expectations="$dir/expectations.tsv"
  cat > "$expectations" <<'TSV'
type-assertion.ts	no-type-assertion
explicit-any.ts	no-any-type
json-parse.ts	no-json-parse
type-predicate.ts	no-type-predicate
clean.ts	
TSV
  count_expectations "$expectations"
  note "== fixtures: research-core ast-grep boundary"
  ( cd "$dir" && "$ASTGREP" scan --config ast-grep/sgconfig.yml --json > "$dir/diagnostics.json" 2> "$dir/tool-stderr.txt" )
  # ast-grep exits 1 when it reports error-level diagnostics, which is the expected case.
  if ! validate "core-ast-grep" "ast-grep" "$dir/diagnostics.json" "$expectations"; then
    failed=1
    grep -v 'postinstall script did not run' "$dir/tool-stderr.txt" | head -20 >&2
  fi
}

run_adapter() {
  local dir expectations
  dir="$(new_tmp)" || { fail "cannot create a temporary directory"; return; }
  cp "$ADAPTER_CONFIG" "$ADAPTER_PACKAGE" "$dir/" || { fail "cannot stage adapter eslint config"; return; }
  cp "$FIXTURES"/adapter/*.js "$dir/" || { fail "cannot stage adapter fixtures"; return; }
  expectations="$dir/expectations.tsv"
  cat > "$expectations" <<'TSV'
eval-call.js	no-eval
new-function.js	no-new-func
implied-eval.js	no-implied-eval
json-parse.js	adapter/json-parse-boundary
dynamic-boundary-import.js	adapter/boundary-import
static-boundary-import.js	adapter/boundary-import
require-boundary.js	adapter/boundary-import
ts-suppression.js	adapter/no-ts-suppressions
clean.js	
results.js	
index.js	
TSV
  count_expectations "$expectations"
  note "== fixtures: superagent-extension adapter boundary"
  ( cd "$dir" && node "$ESLINT" . --format json > "$dir/diagnostics.json" 2> "$dir/tool-stderr.txt" )
  if ! validate "adapter" "eslint" "$dir/diagnostics.json" "$expectations"; then
    failed=1
    head -20 "$dir/tool-stderr.txt" >&2
  fi
}

# Preconditions: fail with a clear message instead of a misleading fixture result.
[ -f "$ESLINT" ] || { printf 'lint-fixtures: missing %s (run npm install in research-core)\n' "$ESLINT" >&2; exit 1; }
[ -x "$ASTGREP" ] || { printf 'lint-fixtures: missing %s (run npm install in research-core)\n' "$ASTGREP" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo 'lint-fixtures: python3 is required' >&2; exit 1; }
[ -f "$ADAPTER_CONFIG" ] || { printf 'lint-fixtures: missing %s\n' "$ADAPTER_CONFIG" >&2; exit 1; }

run_core_eslint
run_core_ast_grep
run_adapter

if [ "$failed" != "0" ]; then
  printf 'lint-fixtures: FAILED (a fixture was accepted or a control was rejected)\n' >&2
  exit 1
fi
printf 'lint-fixtures: ok (%d invalid fixtures rejected, %d valid controls accepted)\n' "$rejected" "$accepted"
