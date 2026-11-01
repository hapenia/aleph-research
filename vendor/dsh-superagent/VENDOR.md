# Vendored copy of dsh-superagent

This directory is a fixed snapshot of the DeepSeek Harness research prototype
`dsh-superagent`, included so the composition can be built offline and pinned.

| | |
| --- | --- |
| Upstream | https://github.com/deepseek-ai/dsh-superagent-prototype |
| Commit | `6337fc823ce20251c8de8085948165c81aaa701e` |
| License | MIT (see `LICENSE`) |
| Retrieved | 2026-11-01 |
| Upstream note | research prototype, not an official DeepSeek product |

## Why a snapshot instead of a submodule

Cloning from GitHub failed repeatedly in this environment while a local clone of the
same commit was available. A snapshot keeps the build reproducible without network
access and without submodule recursion. Treat upstream changes as a deliberate
upgrade: fetch, diff against this copy, update the commit above, rebuild, and run the
composition smoke test.

## Rules for this copy

- Do not edit files here; our behaviour lives in `@local/dsh-aleph-research` and in
  the profile patch. When a change is unavoidable, keep it as a patch file under
  `vendor/patches/` and record it here. `scripts/build-superagent-vendor.sh` applies
  the series before building, idempotently.

| Patch | Why |
| --- | --- |
| `0001-configurable-session-permission.patch` | The prototype pins every session to `danger-full-access`; the patch lets a deployment choose the permission preset through `ALEPH_SESSION_PERMISSION` while keeping the default. |
| `0002-worker-extra-tools.patch` | The Worker's `restrict({ allow })` mask only admits the prototype's work tools; the patch adds the names in `ALEPH_WORKER_TOOLS` so an extension tool such as `aleph_submit_result` is visible to the Worker. Empty by default.
- Do not commit `node_modules`, `lib` or `.artifacts`; they are build output.
- Build with `pnpm install && pnpm build` from this directory.

## Upstream documents read for the migration

- `docs/000-philosophy.md`, `001-domain.md`, `003-execution.md`, `004-prompts.md`,
  `006-deployment.md`, `007-architecture.md`, `008-cookbook.md`.
