#!/usr/bin/env bash
# Mutation checks for the compile-time guarantees: remove one guarantee in a throwaway
# copy of `src` and require `tsc` to fail **at the type tests with the expected
# diagnostic** (not from an unrelated error, and not with an arbitrary substring).
#
# Each mutation declares the edits it makes and the diagnostic it must produce. A
# diagnostic expectation is anchored to `src/type-tests.ts(<line>,<column>)` plus the
# TypeScript error code and the message shape, so a change that only makes the compiler
# fail elsewhere (or that fails for a new, unrelated reason) is reported as
# "killed for the wrong reason" instead of passing.
#
# The harness also checks that the untouched copy typechecks first: if the baseline is
# not green (for example while another agent is mid-edit), mutation results are
# meaningless, so the script stops with an explicit baseline error instead of blaming the
# mutations.
#
# The last group holds the mutations that are known to survive today because no negative
# test covers them yet (assignment on propose/review/close, binding on submit, and the
# issue/experiment trigger, capability and audit maps). They are part of the harness on
# purpose: the script exits nonzero while a mutation survives, which keeps the missing
# test visible instead of letting the harness report a false green. Killing them requires
# new negative tests in `src/type-tests.ts`; this harness reports the gap, it does not
# hide it.
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
killed=0
survived=0

resurrect() {
  rm -rf "$TMP/src"
  cp -a "$ROOT/src" "$TMP/src"
}

# run_mutation <must-kill|survivor> <name> <expected-diagnostic-regex> <file> <from> <to> [...]
#
# Applies the edits to a fresh copy (one first-occurrence replacement per triplet) and
# compiles. The script exits nonzero when a mutation survives or is killed by a
# diagnostic that does not match the expectation.
#
#   must-kill: the type tests cover this guarantee; the expected diagnostic must appear.
#   survivor:  the guarantee has no negative test yet; the mutation is measured *at the
#              type tests*. It is a survivor when tsc passes, or when tsc fails only
#              outside `src/type-tests.ts` (an unrelated module may happen to depend on
#              the same field; that does not prove the test exists). Any such outcome is
#              reported and fails the script, so the missing test stays visible.
run_mutation() {
  local mode="$1" name="$2" expect="$3"
  shift 3
  if [ $(( $# % 3 )) -ne 0 ]; then
    echo "MUTATION HARNESS ERROR: expected file/from/to triplets after '$name'" >&2
    failed=1
    return
  fi
  resurrect
  while [ "$#" -gt 0 ]; do
    local file="$1" from="$2" to="$3"
    shift 3
    if ! python3 - "$TMP/$file" "$from" "$to" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path).read()
if old not in text:
    raise SystemExit(f"mutation target not found: {old!r}")
open(path, "w").write(text.replace(old, new, 1))
PY
    then
      echo "MUTATION TARGET MISSING: $name ($file)" >&2
      failed=1
      return
    fi
  done
  local out
  if out=$(cd "$TMP" && "$TSC" -p tsconfig.json --pretty false 2>&1); then
    echo "MUTATION SURVIVED: $name" >&2
    echo "  an expected diagnostic (once a negative test covers this) would be: $expect" >&2
    survived=$((survived + 1))
    failed=1
    return
  fi
  if printf '%s\n' "$out" | grep -Eq "$expect"; then
    killed=$((killed + 1))
    echo "killed: $name"
    return
  fi
  if [ "$mode" = "survivor" ]; then
    echo "MUTATION SURVIVED AT THE TYPE TESTS: $name" >&2
    echo "  no negative test covers this fact; tsc instead failed outside src/type-tests.ts:" >&2
    printf '%s\n' "$out" | head -3 | sed 's/^/    /' >&2
    echo "  an expected diagnostic (once a negative test covers this) would be: $expect" >&2
    survived=$((survived + 1))
    failed=1
    return
  fi
  echo "MUTATION KILLED FOR THE WRONG REASON: $name" >&2
  echo "  expected: $expect" >&2
  printf '%s\n' "$out" | head -3 >&2
  failed=1
}

# The two wrappers keep the mutation list below readable.
mutate() {
  run_mutation must-kill "$@"
}
mutate_survivor() {
  run_mutation survivor "$@"
}

# The untouched copy must typecheck, otherwise every mutation below would "fail" for a
# reason unrelated to the mutation.
if ! baseline=$(cd "$TMP" && "$TSC" -p tsconfig.json --pretty false 2>&1); then
  echo "MUTATION HARNESS ERROR: baseline tsc fails; the source tree did not typecheck, so no mutation result is meaningful." >&2
  printf '%s\n' "$baseline" | head -5 >&2
  exit 1
fi

# ---------------------------------------------------------------------------------------
# Guarantees the current type tests already cover. Each expectation names the exact
# diagnostic the mutation must produce.
# ---------------------------------------------------------------------------------------

mutate "private brand removed from Program" \
  '^src/type-tests\.ts\(72,1\): error TS2578: Unused .@ts-expect-error. directive\.$' \
  src/types/program.ts "  private readonly __stopped: true" ""

mutate "success outcome audit accepts any array" \
  '^src/type-tests\.ts\(138,1\): error TS2578: Unused .@ts-expect-error. directive\.$' \
  src/types/commands.ts "readonly audit: NonEmptyArray<AuditEntryOf<AuditActionOf<K>>>" "readonly audit: readonly AuditEntry[]"

mutate "refusal audit accepts any array" \
  '^src/type-tests\.ts\(140,1\): error TS2578: Unused .@ts-expect-error. directive\.$' \
  src/types/commands.ts "readonly audit: NonEmptyArray<AuditEntryOf<'command.refused'>>" "readonly audit: readonly AuditEntry[]"

mutate "pause accepts a Researcher" \
  '^src/type-tests\.ts\(99,1\): error TS2578: Unused .@ts-expect-error. directive\.$' \
  src/types/commands.ts "readonly 'program.pause': OperatorPrincipal" "readonly 'program.pause': OperatorPrincipal | ResearcherPrincipal"

mutate "program.pause maps to the wrong capability" \
  '^src/type-tests\.ts\(158,7\): error TS2322: Type ."program:stop". is not assignable to type ."program:pause".\.$' \
  src/types/commands.ts "readonly 'program.pause': 'program:pause'" "readonly 'program.pause': 'program:stop'"

mutate "requestCI drops the ownership Result" \
  '^src/type-tests\.ts\(180,7\): error TS2322: Type .CIPendingExperiment. is not assignable to type .Result<CIPendingExperiment, DomainError>.\.$' \
  src/types/experiment.ts "  ): Result<CIPendingExperiment, DomainError>" "  ): CIPendingExperiment"

mutate "passed Experiment closes with a principal" \
  '^src/type-tests\.ts\(185,1\): error TS2578: Unused .@ts-expect-error. directive\.$' \
  src/types/experiment.ts \
  "  close(assignment: IssueAssignment, reason: NonEmptyString, at: IsoTimestamp): Result<ClosedExperiment, DomainError>" \
  "  close(assignment: ResearcherPrincipal, reason: NonEmptyString, at: IsoTimestamp): Result<ClosedExperiment, DomainError>"

mutate "trigger kind is swapped for ci.passed" \
  '^src/type-tests\.ts\(198,7\): error TS2322: Type ."program-created". is not assignable to type ."ci-passed".\.$' \
  src/types/triggers.ts "readonly 'ci.passed': 'ci-passed'" "readonly 'ci.passed': 'program-created'"

# ---------------------------------------------------------------------------------------
# Known survivors: no type test covers these map/ownership facts yet. They are
# measured at the type tests, not merely at any compiler error. They are expected
# to be reported as MUTATION SURVIVED and to make this script exit nonzero until a
# negative test in src/type-tests.ts kills them. Do not weaken the expectations to make
# them pass.
# ---------------------------------------------------------------------------------------

# The Host-injected assignment is what proves the assignee proposed/reviewed/closed the
# Experiment; dropping it from the commands must not compile once a negative test asserts
# the field is required (missing property) or makes an existing @ts-expect-error unused.
mutate_survivor "assignment removed from propose/review/close" \
  '^src/type-tests\.ts\([0-9]+,[0-9]+\): error TS(2578|2741):' \
  src/types/commands.ts "  readonly assignment: IssueAssignment" "" \
  src/types/commands.ts "  readonly assignment: IssueAssignment" "" \
  src/types/commands.ts "  readonly assignment: IssueAssignment" ""

# The TicketBinding is the Implementer's ownership proof; the tool omits it so the Host
# injects it, and a command without the field would accept a bare submission.
mutate_survivor "binding removed from submit" \
  '^src/type-tests\.ts\([0-9]+,[0-9]+\): error TS(2578|2741):' \
  src/types/commands.ts "  readonly binding: TicketBinding" ""

# The trigger kind table is per-action; swapping two audit facts must fail a test that
# pins the literal mapping (unused @ts-expect-error or a not-assignable literal).
mutate_survivor "issue.created and experiment.proposed trigger kinds swapped" \
  '^src/type-tests\.ts\([0-9]+,[0-9]+\): error TS(2578|2322):' \
  src/types/triggers.ts "readonly 'issue.created': 'issue-created'" "readonly 'issue.created': 'experiment-proposed'" \
  src/types/triggers.ts "readonly 'experiment.proposed': 'experiment-proposed'" "readonly 'experiment.proposed': 'issue-created'"

# Capability and audit maps are load-bearing for authorization: swapping the issue
# command entries must fail a test that pins all three, not only the spot-checked
# program.pause entry.
mutate_survivor "issue command capability entries swapped" \
  '^src/type-tests\.ts\([0-9]+,[0-9]+\): error TS(2578|2322):' \
  src/types/commands.ts "readonly 'issue.create': 'issue:create'" "readonly 'issue.create': 'issue:claim'" \
  src/types/commands.ts "readonly 'issue.claim': 'issue:claim'" "readonly 'issue.claim': 'issue:close'" \
  src/types/commands.ts "readonly 'issue.close': 'issue:close'" "readonly 'issue.close': 'issue:create'"

mutate_survivor "issue command audit entries swapped" \
  '^src/type-tests\.ts\([0-9]+,[0-9]+\): error TS(2578|2322):' \
  src/types/commands.ts "readonly 'issue.create': 'issue.created'" "readonly 'issue.create': 'issue.claimed'" \
  src/types/commands.ts "readonly 'issue.claim': 'issue.claimed'" "readonly 'issue.claim': 'issue.closed'" \
  src/types/commands.ts "readonly 'issue.close': 'issue.closed'" "readonly 'issue.close': 'issue.created'"

if [ "$failed" != "0" ]; then
  echo "mutation: FAILED ($killed killed, $survived survived; a survivor means a guaranteed fact has no negative test)" >&2
  exit "$failed"
fi
echo "mutation: ok ($killed mutations killed)"
