# Archive

This directory holds the retired implementation, kept for history only. Nothing in
the runtime, configuration, CI or operator workflow depends on it.

- `legacy-plugin/`: the Leader / Composer / Researcher / InfraOptimizer plugin with
  its Batch/Mission model, storage domain, console client and tests.
- `skills/`: the operator skills that drove those roles.
- `scripts/`: the lab, case driver, console and GitHub watch scripts that used the
  old plugin's HTTP API.

The current system lives in `superagent-extension/`, `scripts/superagent-*` and
`docs/architecture.md`; `docs/superagent-migration.md` records the migration.
