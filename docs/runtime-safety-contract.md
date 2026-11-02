# Runtime safety contract

The blueprint is a **type contract plus this runtime contract**. Five independent
adversarial reviews showed that TypeScript and lint cannot make construction, ownership
and untrusted input unforgeable inside a types-only package. Phase 1 implements the checks
below and tests them; these tests, not another type-review round, are the acceptance gate.

Each row names the rule, why types/lint cannot enforce it, the runtime check, the phase
and the evidence the phase must produce.

## Construction and minting

| Rule | Why static tools cannot enforce it | Runtime check | Evidence |
| --- | --- | --- | --- |
| Only the composition root mints principals, tokens and states | `@ts-expect-error`, `as`, `any`, JSON and allowlisted modules can forge; adapter package is outside `research-core` lint | factories/hydration/parsers are the only importers in the adapter; adapter runs the same ESLint/ast-grep rules; `HostAuthority` value created at plugin startup and passed to factories | adapter lint config; forbidden-import fixture; startup tests |
| `IssueAssignment` only for the Issue assignee | tokens are values; any factory call is a runtime event | `AssignedIssue.authorize(actor)` compares Session and returns `Result`; factories do not accept a bare actor | unit tests for matching and non-matching Session |
| `TicketBinding` only from a Ticket | `createTicketBinding(unknown)` accepts anything | mint only from `TicketRepository.get`, compare program/issue/experiment/session | binding tests with wrong ticket/program |
| `CIRequestToken` only for one Experiment/commit | the token is data | check `experimentId` and `commit` against the Experiment before creating the run | token association tests |

## Ownership and transitions

| Rule | Runtime check | Evidence |
| --- | --- | --- |
| Propose/review/close only by the assignee | transition compares `assignment.issueId` and assignee and returns `DomainError` | cross-issue token tests |
| Submit/revise only by the bound Implementer | compare `binding.ticketId`, `experimentId`, `sessionId` with the actor and Experiment | wrong-session/wrong-ticket tests |
| CI evidence belongs to the Experiment | compare completion record experiment, commit and run id with `this.id`, `this.head`, `this.ciRunId` | wrong-run/wrong-commit tests |
| Close outcome follows the CI result | implementation sets `concluded`/`failed`/`cancelled`; a passed Experiment cannot close as failed | per-state close tests |

## Write path and Host injection

| Rule | Runtime check | Evidence |
| --- | --- | --- |
| One write path through the executor | `executeRoute` is the only route executor; it takes `CommandContext<K>` and a refusal-audit port, parses, merges Host-injected fields (`assignment`, `binding`, `CIRequestToken`) and calls `executor[route]` | route tests proving other slots are unreachable and refusals are audited |
| Host-injected fields never come from the model | tools omit `assignment`/`binding`; adapter injects them after the ownership check | tool schema tests; injection tests |
| Every route body passes a parser | parser table covers every `CommandType`; `executeRoute` rejects unknown bodies | parser completeness test |
| Panel is read-only | no write method on the panel surface | route surface test |

## Structural records and storage

| Rule | Runtime check | Evidence |
| --- | --- | --- |
| `CIRecord`, `Ticket`, `IssueComment`, `ExperimentReview`, `Attention` are validated | repositories validate before save; hydration validates on read; structural types are documented as contracts, not brands | repository round-trip tests; forged-row rejection tests |
| Optimistic concurrency | every repository read returns `Versioned<T>`; save compares expected version | version-conflict tests per aggregate |
| Raw CI records only | no stored best/latest aggregate; `MetricQuery` computes views | query tests; snapshot tests |
| Artifacts are content-addressed and retained | digest, size and retention checked on store/prune | artifact store tests |

## Maps and triggers

| Rule | Runtime check | Evidence |
| --- | --- | --- |
| Capability, audit-action and trigger maps are correct | compile-time tables are spot-checked; Phase 1 adds all-entry tests and a lint fixture; runtime `TriggerFactory` must return the mapped kind | map tests for every command/action; draft-kind tests |
| Trigger draft matches its report | `executeRoute`/trigger delivery checks report action and draft kind | delivery tests |
| Refusals are audited as `command.refused` | `executeRoute` builds the refusal entry with actor, program, at, request id and reason | refusal audit tests |

## Parsers and presets

| Rule | Runtime check | Evidence |
| --- | --- | --- |
| Untrusted bodies never reach the domain unparsed | parsers cover every command and every branded id/refinement (`ProgramId` … `DurationMs`, `NonEmptyString`, `PositiveInt`, `Version`, `RequestId`) | parser coverage test |
| Presets are exact | `low 0.2/0.02`, `normal 1.0/0.10`, `high 3.0/0.25` come from one factory table and are asserted | preset test |
| Sampler input is valid and deduplicated | validate required metrics, uniqueness by `ciRunId`/experiment and non-empty population | sampler tests |
| Metrics are JSON-finite | reject NaN/Infinity and non-required missing metrics at the CI result boundary | CI result tests |

## Lint and mutation gates

| Rule | Runtime check | Evidence |
| --- | --- | --- |
| Boundary cannot be laundered | ESLint bans imports of factories/hydration/parsers/type-tests outside allowlist, bans `@ts-expect-error`, predicates, `JSON`/`globalThis`, `eval`, `new Function`; ast-grep mirrors it | lint fixtures that must fail |
| Adapter is covered | add ESLint/ast-grep to `superagent-extension` and run in CI | adapter lint job |
| Mutation harness is meaningful | assert file:line and diagnostic code; include the surviving mutations (token fields, trigger/capability/audit maps) and lint fixtures | mutation job exit code plus expected-diagnostic assertions |

## Mechanism features still to implement or mark non-goals

- `setBudget` / budget change command.
- Issue body update for accumulated knowledge.
- Attention acknowledge transition and tool.
- `pauseForBudget` raising attention.
- Per-Ticket authorization delivery to the prototype Eval (`TriggerPort` carries the ticket binding).
- Operator closes an Issue only after the assignee (or explicit takeover) — decide the rule.

These are Phase 1 decisions; the blueprint currently has no type for them.


## Completion ledger

Features that are not wired end to end are listed as `'todo'` in
`research-core/src/completion.ts`; the ledger is the source of truth, not code comments.
`npm run check:completion` validates the markers and prints the pending features; it runs
in `verify.sh` and CI. `npm run check:release` compiles `src/release-gate.ts` and fails
while any feature remains `'todo'`, so a release cannot ignore the gap. The current
pending features are the experiment-to-ticket path, implementer execution, CI writeback,
researcher review, session tools, the Rust command bridge; an actual 24-hour case run is out of scope for this implementation.
