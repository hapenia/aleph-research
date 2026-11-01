#!/usr/bin/env bash
# Mutation checks for the compile-time guarantees: remove one guarantee in a throwaway
# copy and require `tsc` to fail *at the type tests* (not because of an unrelated error).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/aleph-type-mutation.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
cp "$ROOT/tsconfig.json" "$TMP/tsconfig.json"
cp "$ROOT/package.json" "$TMP/package.json"
cp -a "$ROOT/src" "$TMP/src"
ln -s "$ROOT/node_modules" "$TMP/node_modules"
TSC="$ROOT/node_modules/.bin/tsc"
failed=0

resurrect() {
  rm -rf "$TMP/src"
  cp -a "$ROOT/src" "$TMP/src"
}

mutate() {
  local name="$1" file="$2" from="$3" to="$4" expect="$5"
  resurrect
  python3 - "$TMP/$file" "$from" "$to" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path).read()
if old not in text:
    raise SystemExit(f"mutation target not found: {old!r}")
open(path, "w").write(text.replace(old, new, 1))
PY
  local out
  if out=$(cd "$TMP" && "$TSC" -p tsconfig.json 2>&1); then
    echo "MUTATION SURVIVED: $name" >&2
    failed=1
    return
  fi
  if ! printf '%s\n' "$out" | rg -q "$expect"; then
    echo "MUTATION KILLED FOR THE WRONG REASON: $name" >&2
    printf '%s\n' "$out" | head -3 >&2
    failed=1
    return
  fi
  echo "killed: $name"
}

mutate "private brand removed from Program" \
  src/types/program.ts "  private readonly __stopped: true" "" \
  "Unused '@ts-expect-error'"
mutate "success outcome audit accepts any array" \
  src/types/commands.ts "readonly audit: NonEmptyArray<AuditEntryOf<AuditActionOf<K>>>" "readonly audit: readonly AuditEntry[]" \
  "Unused '@ts-expect-error'"
mutate "refusal audit accepts any array" \
  src/types/commands.ts "readonly audit: NonEmptyArray<AuditEntryOf<'command.refused'>>" "readonly audit: readonly AuditEntry[]" \
  "Unused '@ts-expect-error'"
mutate "pause accepts a Researcher" \
  src/types/commands.ts "readonly 'program.pause': OperatorPrincipal" "readonly 'program.pause': OperatorPrincipal | ResearcherPrincipal" \
  "Unused '@ts-expect-error'"
mutate "program.pause maps to the wrong capability" \
  src/types/commands.ts "readonly 'program.pause': 'program:pause'" "readonly 'program.pause': 'program:stop'" \
  "type-tests.ts"
mutate "requestCI drops the ownership Result" \
  src/types/experiment.ts "  ): Result<CIPendingExperiment, DomainError>" "  ): CIPendingExperiment" \
  "Unused '@ts-expect-error'"
mutate "passed Experiment closes with a principal" \
  src/types/experiment.ts "  close(assignment: IssueAssignment, reason: NonEmptyString, at: IsoTimestamp): Result<ClosedExperiment, DomainError>" \
  "  close(assignment: ResearcherPrincipal, reason: NonEmptyString, at: IsoTimestamp): Result<ClosedExperiment, DomainError>" \
  "Unused '@ts-expect-error'"
mutate "trigger kind is swapped for ci.passed" \
  src/types/triggers.ts "readonly 'ci.passed': 'ci-passed'" "readonly 'ci.passed': 'program-created'" \
  "type-tests.ts"
exit "$failed"
