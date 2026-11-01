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

# The vendored tree stays pristine in git: patches are applied for the build and then
# reversed, so a dirty vendor directory is never committed and a rebuild is repeatable.
applied=()
restore() {
  # Reverse in the opposite order of application, or overlapping patches conflict.
  local index patch
  for ((index = ${#applied[@]} - 1; index >= 0; index--)); do
    patch="${applied[$index]}"
    (cd "$vendor" && patch -R -p1 --no-backup-if-mismatch --silent <"$patch" >/dev/null 2>&1) || true
  done
  find "$vendor" -name '*.orig' -delete 2>/dev/null || true
  find "$vendor" -name '*.rej' -delete 2>/dev/null || true
}
trap restore EXIT

if [ -d "$patches" ]; then
  while IFS= read -r patch; do
    [ -n "$patch" ] || continue
    if (cd "$vendor" && patch -p1 --dry-run --silent <"$patch" >/dev/null 2>&1); then
      (cd "$vendor" && patch -p1 --no-backup-if-mismatch --silent <"$patch" >/dev/null)
      applied+=("$patch")
      echo "applied $(basename "$patch")"
    elif (cd "$vendor" && patch -p1 --reverse --dry-run --silent <"$patch" >/dev/null 2>&1); then
      # Left over from an interrupted build: reverse it too, so this run starts clean.
      (cd "$vendor" && patch -R -p1 --no-backup-if-mismatch --silent <"$patch" >/dev/null)
      (cd "$vendor" && patch -p1 --no-backup-if-mismatch --silent <"$patch" >/dev/null)
      applied+=("$patch")
      echo "reapplied $(basename "$patch")"
    else
      echo "cannot apply $(basename "$patch") to the vendored tree" >&2
      exit 1
    fi
  done < <(find "$patches" -maxdepth 1 -name '*.patch' | sort)
fi

(cd "$vendor" && pnpm build)
echo "built $vendor/lib"
