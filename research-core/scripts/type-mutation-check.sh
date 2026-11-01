#!/usr/bin/env bash
# Mutation checks for the compile-time guarantees: remove one guarantee in a throwaway
# copy and require `tsc` to fail. A surviving mutation means the negative tests no longer
# protect the claim they describe.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/aleph-type-mutation.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
cp "$ROOT/tsconfig.json" "$TMP/tsconfig.json"
cp "$ROOT/package.json" "$TMP/package.json"
cp -a "$ROOT/src" "$TMP/src"
ln -s "$ROOT/node_modules" "$TMP/node_modules"
TSC="$ROOT/node_modules/.bin/tsc"

resurrect() {
  rm -rf "$TMP/src"
  cp -a "$ROOT/src" "$TMP/src"
}

mutate() {
  local name="$1" file="$2" from="$3" to="$4"
  resurrect
  python3 - "$TMP/$file" "$from" "$to" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path).read()
if old not in text:
    raise SystemExit(f"mutation target not found: {old!r}")
open(path, "w").write(text.replace(old, new, 1))
PY
  if (cd "$TMP" && "$TSC" -p tsconfig.json >/dev/null 2>&1); then
    echo "MUTATION SURVIVED: $name" >&2
    failed=1
  else
    echo "killed: $name"
  fi
}

failed=0
mutate "private brand removed from Program" \
  src/types/program.ts "  private readonly __stopped: true" ""
mutate "command outcome audit accepts any array" \
  src/types/commands.ts "readonly audit: NonEmptyArray<AuditEntryOf<AuditActionOf<K>>>" "readonly audit: readonly AuditEntry[]"
mutate "pause accepts a Researcher" \
  src/types/commands.ts "readonly 'program.pause': OperatorPrincipal" "readonly 'program.pause': OperatorPrincipal | ResearcherPrincipal"
mutate "program.pause maps to the wrong capability" \
  src/types/commands.ts "readonly 'program.pause': 'program:pause'" "readonly 'program.pause': 'program:stop'"
exit "$failed"
