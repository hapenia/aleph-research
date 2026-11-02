# Research core live smoke

Host: `/tmp/aleph-runs/case-test-2200`, profile `aleph-superagent`, port `40201`.

The real embedded wasm core, the real Rust command bridge and the DSH concept adapters
were loaded. The benchmark command was a synthetic `printf '{"score":1}\n'`; this is an
infrastructure smoke, not a 24-hour case run.

Sequence:

1. `POST /aleph/api/research/programs` created `program-2026-11-02T14-06-09.227Z-1`.
2. `POST /programs/:id/issues` created `issue-2026-11-02T14-08-23.055Z-2`.
3. `POST /issues/:id/claim` assigned the Issue.
4. `POST /issues/:id/experiments` created `experiment-2026-11-02T14-12-58.099Z-3`.
5. `POST /experiments/:id/benchmarks` paused at `sessions.submitCommit` (sequence 5,
   stage `WorkerStarted`).
6. `POST /tickets/submit` resumed the pipeline, ran the benchmark and paused at
   `sessions.review` (sequence 10, stage `ResultRecorded`).
7. `POST /experiments/:id/reviews` completed the pipeline with outcome `concluded`.

Reported stages:

```
ExperimentProposed
TriggerAccepted
TicketOpened
WorkerStarted
CommitSubmitted
EnvironmentBuilt
BenchmarkPassed
ResultRecorded
ReviewRecorded
ResearchCompleted
```

Health: `{"ok":true,"version":"research-core/1","persistent":true}`.

The actual 24-hour case run is out of scope for this implementation.
