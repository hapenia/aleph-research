# Legacy case run evidence

This directory preserves the last run of the superseded ticket-per-request mechanism
before the research mechanism rewrite. The run was stopped on 2026-11-02; no Host
process or soak remains.

## Run

- case: `kunlungpt`
- master session: `orchestrator-1f1d4a164adab857204c0b29a6cfecdf`
- results log: `results.jsonl` (4 records, best 79.77104919489919)
- soak samples: `soak.jsonl` (19 samples, host alive in 19)
- run metadata: `run.json` (token removed)

## Evaluation records

| at | score | ticket | commit |
| --- | ---: | --- | --- |
| 2026-11-01T15:29:35.172Z | None | e0c9efd5 | 3f8818cd |
| 2026-11-01T15:32:12.947Z | 79.77104919489919 | e0c9efd5 | 3f8818cd |
| 2026-11-01T15:59:34.560Z | 68.93513008350408 | 95d901ce | 8739cb37 |
| 2026-11-01T16:05:02.806Z | 79.48049365323425 | efaeb2eb | 83debd1f |

The first record scored `null` because the case evaluator needed an `ALEPH_WORKSPACE/.aleph`
scratch directory that the wrapper did not create; the same commit scored 79.77 after
the fix. The last two records are the fire-test ticket and the first improvement ticket.

## Why this is archived

The rewrite in `docs/type-blueprint.md` replaces this mechanism with Host-held Programs,
Issues and Experiments. These files are historical evidence for the migration record,
not an input to the new system.
