#!/usr/bin/env bash
# Stop a case lab and optionally remove its run directory.
#
#   scripts/superagent-case-stop.sh <run-name> [--keep]
set -euo pipefail
run_root="${ALEPH_RUN_ROOT:-/tmp/aleph-runs}/$1"
[ -d "$run_root" ] || { echo "no run at $run_root" >&2; exit 1; }
pid="$(cat "$run_root/host.pid" 2>/dev/null || true)"
[ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null || true
sleep 2
for proc in /proc/[0-9]*; do
  cwd="$(readlink "$proc/cwd" 2>/dev/null || true)"
  case "$cwd" in "$run_root"/*) kill -TERM "${proc#/proc/}" 2>/dev/null || true ;; esac
done
sleep 1
if [ "${2:-}" != "--keep" ]; then rm -rf "$run_root"; echo "removed $run_root"; else echo "kept $run_root"; fi
