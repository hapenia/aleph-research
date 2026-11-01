#!/usr/bin/env bash
# Verify the packaged build the JS adapter imports.
#
# `npm run build` is the one way to produce `dist/`; this script proves the result is
# complete and clean rather than trusted:
#
#   1. remove `dist/` so a stale file from an earlier run cannot satisfy an assertion;
#   2. compile `tsconfig.build.json` and fail on any diagnostic;
#   3. require the published entry points (root, runtime store, adapter composition and
#      DSH storage adapter) to exist as both `.js` and `.d.ts`;
#   4. require every emitted `.js` to have a sibling `.d.ts` (declaration emit complete)
#      and no `.map` files (source maps are off by contract);
#   5. reject anything that exists only to test or to typecheck: `test/`, `*.test.*`,
#      `type-tests.*`, and `__*` fixtures.
#
# The script is standalone: `bash research-core/scripts/build-check.sh`. It runs `tsc`
# directly instead of `npm run build` so a nonzero exit point is unambiguous, and its
# assertions are written with POSIX tools because it may run in CI.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
TSC="$ROOT/node_modules/.bin/tsc"

failed=0
checked=0

fail() {
  printf 'build-check: %s\n' "$*" >&2
  failed=1
}

# expect_file <path relative to dist>
expect_file() {
  local relative="$1"
  checked=$((checked + 1))
  if [ ! -f "$DIST/$relative" ]; then
    fail "missing dist/$relative"
  fi
}

# Precondition: fail with a clear message instead of a misleading compile error.
if [ ! -x "$TSC" ]; then
  printf 'build-check: missing %s (run npm install in research-core)\n' "$TSC" >&2
  exit 1
fi

# 1. A clean tree makes every assertion below about this build only.
rm -rf "$DIST"

# 2. Build with the same config `npm run build` uses.
if ! build_output="$(cd "$ROOT" && "$TSC" -p tsconfig.build.json --pretty false 2>&1)"; then
  printf 'build-check: tsc -p tsconfig.build.json failed\n' >&2
  printf '%s\n' "$build_output" >&2
  exit 1
fi

# 3. The entry points the adapter consumes, JavaScript and declarations.
for entry in \
  index.js \
  index.d.ts \
  runtime/storage.js \
  runtime/storage.d.ts \
  adapter/composition.js \
  adapter/composition.d.ts \
  adapter/storage-domain.js \
  adapter/storage-domain.d.ts
do
  expect_file "$entry"
done

if [ ! -d "$DIST" ]; then
  fail 'the build produced no dist directory'
else
  # 4. Every module ships its declaration, and no source maps.
  while IFS= read -r emitted; do
    checked=$((checked + 1))
    if [ ! -f "${emitted%.js}.d.ts" ]; then
      fail "missing declaration for ${emitted#"$DIST"/}"
    fi
  done < <(find "$DIST" -type f -name '*.js')

  while IFS= read -r mapped; do
    fail "source maps are disabled by contract, found ${mapped#"$DIST"/}"
  done < <(find "$DIST" -type f \( -name '*.js.map' -o -name '*.d.ts.map' \))

  # 5. Test-only and type-only sources must never reach the package.
  while IFS= read -r stray; do
    fail "unexpected source in dist: ${stray#"$DIST"/}"
  done < <(find "$DIST" -type f \( \
    -path "$DIST/test/*" \
    -o -name '*.test.*' \
    -o -name 'type-tests.*' \
    -o -path "$DIST/__*" \
    -o -path '*/__*' \
  \))
fi

if [ "$failed" != "0" ]; then
  printf 'build-check: FAILED\n' >&2
  exit 1
fi

printf 'build-check: ok (%d files and pairs checked)\n' "$checked"
