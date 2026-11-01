#!/usr/bin/env bash
# Build the vendored dsh-superagent prototype, applying the local patch series first.
#
# The vendored tree is a snapshot, not a git checkout, so patches are applied with
# patch(1). A patch that is already applied is recognised by reverse dry-run, which
# keeps repeated builds idempotent.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
vendor="$repo/vendor/dsh-superagent"
patches="$repo/vendor/patches"

[ -d "$vendor" ] || { echo "no vendored prototype at $vendor" >&2; exit 1; }

if [ ! -d "$vendor/node_modules" ]; then
  (cd "$vendor" && pnpm install --frozen-lockfile)
fi

if [ -d "$patches" ]; then
  while IFS= read -r patch; do
    [ -n "$patch" ] || continue
    if (cd "$vendor" && patch -p1 --dry-run --silent <"$patch" >/dev/null 2>&1); then
      (cd "$vendor" && patch -p1 --silent <"$patch" >/dev/null)
      echo "applied $(basename "$patch")"
    elif (cd "$vendor" && patch -p1 --reverse --dry-run --silent <"$patch" >/dev/null 2>&1); then
      echo "already applied $(basename "$patch")"
    else
      echo "cannot apply $(basename "$patch") to the vendored tree" >&2
      exit 1
    fi
  done < <(find "$patches" -maxdepth 1 -name '*.patch' | sort)
fi

(cd "$vendor" && pnpm build)
echo "built $vendor/lib"
