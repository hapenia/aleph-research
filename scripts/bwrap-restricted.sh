#!/usr/bin/env bash
# A bwrap-compatible sandbox runner with a restricted read view.
#
# `dsh-sandbox-local` builds a bubblewrap profile whose first mount is the whole host
# filesystem read-only (`--ro-bind / /`). This runner drops exactly that mount and
# replaces it with read-only binds of the roots an agent may read, so a command can
# reach the system and its workspace but not the operator's home, other projects or
# the harness state.
#
# Configuration:
#   ALEPH_READ_ROOTS  colon-separated absolute roots to expose read-only
#                     (default: /usr /bin /sbin /lib /lib64 /etc /opt /run)
#
# Every other argument from the sandbox profile is forwarded unchanged; bubblewrap
# stays the enforcement point, so a denied read fails normally.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "aleph-sandbox: no bubblewrap profile was supplied" >&2
  exit 97
fi

read_roots="${ALEPH_READ_ROOTS:-/usr:/bin:/sbin:/lib:/lib64:/etc:/opt:/run}"

prefix=()
IFS=':' read -r -a roots <<<"$read_roots"
for root in "${roots[@]}"; do
  [ -n "$root" ] || continue
  [ -e "$root" ] || continue
  prefix+=(--ro-bind "$root" "$root")
done

# Forward the profile without its whole-host read-only bind.
args=("$@")
forwarded=()
index=0
while [ "$index" -lt "${#args[@]}" ]; do
  current="${args[$index]}"
  if [ "$current" = "--ro-bind" ] && [ "${args[$((index + 1))]:-}" = "/" ] && [ "${args[$((index + 2))]:-}" = "/" ]; then
    index=$((index + 3))
    continue
  fi
  forwarded+=("$current")
  index=$((index + 1))
done

exec bwrap "${prefix[@]}" "${forwarded[@]}"
