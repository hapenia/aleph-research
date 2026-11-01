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
#                     (default: /usr /bin /sbin /lib /lib64 /etc /opt /run /sys)
#
# Host GPU devices (/dev/nvidia*, /dev/nvidia-caps, /dev/dri) are re-exposed after
# bubblewrap's `--dev /dev`; /sys is included because NVML/CUDA needs it to enumerate
# the GPU. Without both, a Worker sees no GPU even though the host has one.
#
# Every other argument from the sandbox profile is forwarded unchanged; bubblewrap
# stays the enforcement point, so a denied read fails normally.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "aleph-sandbox: no bubblewrap profile was supplied" >&2
  exit 97
fi

read_roots="${ALEPH_READ_ROOTS:-/usr:/bin:/sbin:/lib:/lib64:/etc:/opt:/run:/sys}"

prefix=()
IFS=':' read -r -a roots <<<"$read_roots"
for root in "${roots[@]}"; do
  [ -n "$root" ] || continue
  [ -e "$root" ] || continue
  prefix+=(--ro-bind "$root" "$root")
done

# Forward the profile without its whole-host read-only bind. Bubblewrap's own
# `--dev /dev` creates a minimal devtmpfs with no GPU nodes, so re-expose the host
# NVIDIA/DRI devices immediately after that mount. Without this a CUDA/torch probe
# inside the sandbox reports no GPU even though the host has one.
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
  if [ "$current" = "--dev" ] && [ "${args[$((index + 1))]:-}" = "/dev" ]; then
    forwarded+=("/dev")
    for dev in /dev/nvidia0 /dev/nvidiactl /dev/nvidia-uvm /dev/nvidia-uvm-tools /dev/nvidia-modeset; do
      [ -e "$dev" ] && forwarded+=(--dev-bind "$dev" "$dev")
    done
    [ -d /dev/nvidia-caps ] && forwarded+=(--dev-bind /dev/nvidia-caps /dev/nvidia-caps)
    [ -d /dev/dri ] && forwarded+=(--dev-bind /dev/dri /dev/dri)
    index=$((index + 1))
  fi
  index=$((index + 1))
done

exec bwrap "${prefix[@]}" "${forwarded[@]}"
