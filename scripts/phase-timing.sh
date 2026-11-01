#!/usr/bin/env bash
# Shared phase timing for the superagent lab and smoke scripts. Source it, do not run it.
#
#   source "$repo/scripts/phase-timing.sh"
#   phase "profile/plugin install"
#
# Each call prints one line with the elapsed time since the previous phase and the
# total time since the script started:
#
#   PHASE profile/plugin install          42.3s (total 42.3s)
#
# When ALEPH_PHASE_LOG names a file, the same measurements are appended there as
# "<name>\t<seconds>" so the smoke script can report the lab's phases too.

__phase_ms_now() { echo $(( $(date +%s%N) / 1000000 )); }

__phase_t0="$(__phase_ms_now)"
__phase_last="$__phase_t0"

# phase <name>: close the current phase and start the next one.
phase() {
  local name="$1" now delta total
  now="$(__phase_ms_now)"
  delta=$(( (now - __phase_last) / 100 ))
  total=$(( (now - __phase_t0) / 100 ))
  printf 'PHASE %-32s %6d.%01ds (total %6d.%01ds)\n' \
    "$name" $((delta / 10)) $((delta % 10)) $((total / 10)) $((total % 10))
  if [ -n "${ALEPH_PHASE_LOG:-}" ]; then
    printf '%s\t%d.%d\n' "$name" $((delta / 10)) $((delta % 10)) >>"$ALEPH_PHASE_LOG"
  fi
  __phase_last="$now"
}
