# Type blueprint v3: nominal research domain, explicit trust boundaries

Status: **v3, revised after the second independent adversarial review; review pending.**
`research-core/src/types/` is the blueprint; the package contains types plus compile-time
negative tests only. The JavaScript extension stays the runtime until the phased rewrite
reaches parity.

v2 claimed more than TypeScript can enforce: the executor was defeated by widening,
nominal classes had no factory or hydration boundary, cancellation and failed CI could
not be expressed, and ownership was unchecked. v3 keeps the nominal model but narrows its
claims, adds the missing states and tokens, and states the one trust boundary honestly.

## Mechanism

Mechanism v5 (`docs/research-mechanism.md`): no best, no quota, no merge. The Host samples
each new Experiment's base by Boltzmann weight `exp(utility / temperature)` over previous
Experiments with a valid CI record, or takes a fresh start from the scaffold. Fixed
levels: `low` 0.2/2%, `normal` 1.0/10%, `high` 3.0/25%. Utility is the Operator's weighted
sum of min-max normalized metrics. CI records are raw and multi-metric. Experiments are
snapshots; iteration reuses one Experiment; CI is requested explicitly.

## Nominal states and the trust boundary

`Program`, `Issue`, `Experiment`, `CIRun` states are nominal classes: private
constructors, private brand fields, fields owned by their variant. Variants cannot be
assigned to each other, and the spread lookalike that supplies every field of another
state is rejected by the private brand (compile-time test).

A class cannot prevent `JSON.parse`, `any` or `as`. v3 therefore declares a real trust
boundary instead of pretending there is none:

- every state class declares `static create(...)` for Host-internal construction and
  `static fromRow(row: unknown): Result<State, StoreError>` for hydration;
- `fromRow` is the single place allowed to validate and (internally) cast a storage row;
- repositories and services only accept constructed classes, never raw rows;
- `DomainFailureMapper.toFailure` is the single place mapping a refusal code to its HTTP
  status;
- `Schema.fromRow` / `Schema.create` are the boundary for tool schemas.

The negative tests prove the boundary is load-bearing where the compiler can see it; they
do not and cannot prove that a cast never happens inside `fromRow`.

## State machines

```ts
RunningProgram.pause(OperatorPrincipal) / pauseForBudget(HostPrincipal) / stop / complete
PausedProgram.resume / setGoal / setMethodology / setExploration / recordUsage
AssignedIssue.authorize(ResearcherPrincipal): Result<IssueAssignment, DomainError>
AssignedIssue.addExperiment(IssueAssignment, ExperimentId)
OpenExperiment.submit(TicketBinding, head, environment): ReadyExperiment
ReadyExperiment.requestCI(IssueAssignment, CIRunId): CIPendingExperiment
CIPendingExperiment.startCI(HostPrincipal, digest): CIRunningExperiment
CIRunningExperiment.passCI(HostPrincipal, PassedCICompletion): CIPassedExperiment
CIRunningExperiment.failCI(HostPrincipal, FailedCICompletion): CIFailedExperiment
CIPendingExperiment.cancel(HostPrincipal) / CIRunningExperiment.cancel(HostPrincipal)
CIPassedExperiment.close(IssueAssignment) / CIFailedExperiment.revise(TicketBinding) / close
```

- `ReadyExperiment` is the readiness gate: CI cannot be requested before the Implementer
  submits.
- Cancellation is a Host transition on ready, pending and running Experiments; a
  cancelled Experiment closes with `outcome: 'cancelled'`.
- CI evidence comes from `PassedCICompletion` / `FailedCICompletion` tokens that only the
  Host CI runner mints; a bare run object cannot be passed.
- Program has `CompletedProgram`; closing the last Issue lets the Host complete it.
- Budget usage is a `UsageDelta` of non-negative counters recorded by the Host; there is
  no way to decrease usage or record it as a model.

## Ownership tokens

A role class alone does not prove ownership. Two nominal tokens express it:

- `IssueAssignment` is minted only by `AssignedIssue.authorize(actor)`, which compares the
  actor Session with the assignee at runtime. `addExperiment`, `close`, `requestCI` and
  Experiment closes require it.
- `TicketBinding` is minted by the Host from a Ticket record and carries ticket, experiment
  and Implementer Session. `submit`, `revise` require it; the submit tool input omits it,
  so the model cannot choose another Ticket.

The tokens prove that a runtime ownership check happened; they cannot prove at compile
time that a Session id equals the stored assignee. That comparison is explicitly listed as
a runtime rule.

## Executor, commands and audit

- The executor is one method per command literal (`executor['program.pause']`), not a
  generic function; a widened `UserCommand`, a generic `CommandType` or a mismatched
  context does not typecheck.
- Each command maps at compile time to its capability, actor and result type.
- `CommandOutcome<K>` carries a non-empty audit array on both success and refusal.
- `TriggerKindForAction` is a total map from audit actions to trigger kinds, so a new
  action forces a trigger decision.
- `AuditEntry` is a mapped union: action fixes allowed actor kinds and subject id type.

## Storage and metrics

- Versioned, nominal repositories: `get(id: ProgramId)`, `listAssignedTo(ResearcherSessionId)`,
  `save(expected: Version, next)`.
- `UnitOfWork` covers programs, issues, experiments, CI records, tickets, artifacts,
  attention and audit.
- `CIRecord` is a status union (`requested/running/passed/failed`) with metrics, artifacts,
  duration and environment digest where they exist; failed runs are persisted.
- Only passed records with the required metrics feed the sampler (`listPassed`); validity
  is computed by query, not stored.
- No best record exists.

## Tools and API

- `Schema<T>` is nominal with `parse`, `toJsonSchema`, `create` and `fromRow`.
- Command tools carry the command literal; Implementer submit input omits `binding`;
  output is `ReadyExperiment`.
- Routes are actor-typed; responses are `ApiResponse<T>` = value or `DomainFailure` whose
  status is derived from the code. Parsers accept raw `unknown` and return commands.
- Panel reads `ProgramSnapshot` (current state, raw CI records, audit, artifacts,
  attention); no replay.

## DSH and dsh-superagent integration

`research-core` is DSH-independent. `superagent-extension` becomes the TypeScript adapter
with the same bundle name, bootstrap and profile composition. It maps DSH services to the
ports: webServer routes, tool registration, sessions/agentPresets for Researcher sessions,
`ctx.orchestrator` for the Trigger seam, the `aleph_research` DSH storage domain for state,
subprocess/shell for uv and CI, filesystem for artifacts, effects for attention, fiber for
hot reload. Researcher Sessions are DSH sessions with a research preset; Implementer work
stays a prototype Ticket/Worker with the existing sandbox. The submit tool delegates to
the Host CI runner and records raw metrics and artifacts; the Main Session keeps routing
attention.

## Compile-time guarantees and tests

`research-core/src/type-tests.ts` covers: widened command rejection, per-command actor
mismatch, executor host actor rejection, spread/status lookalike rejection, variant
assignment rejection, failed-CI to passed assignment rejection, DomainFailure construction
and status correlation, nomial id mixing, ownership-token substitution, Host-only
cancellation, completed-Program transitions, empty audit rejection, tool input narrowing,
and lineage separation.

Known limits, stated instead of hidden:

- `as`, `any`, `JSON.parse` and reflection can defeat any TypeScript guarantee; the only
  defence is the single `fromRow`/factory boundary and runtime validation there.
- Class instances lose methods on JSON round-trip; storage must hydrate through `fromRow`.
- Ownership tokens prove a runtime check happened, not Session equality at compile time.
- Gossip of compile-time maps (`CapabilityForCommand`, `CommandAuditMap`) is checked by
  tests only where used; adding a command requires touching the maps, which the compiler
  enforces for the handler and audit maps.

## Phases

1. Factories/fromRow implementations, command handlers and audit, DSH storage-domain
   repositories, management routes, negative tests kept green.
2. Host services: uv builder, CI runner, artifact store, sampler with injected RNG,
   session pool, attention, cancellation.
3. Adapter: tool registration, Trigger seam, Researcher preset, panel.
4. Case migration and 24-hour run.

## Non-goals

No missions, machines, batches, merge/mainline semantics, scheduling, GitHub integration,
stored best/aggregates, event replay or panel controls in v1.

## Review request

Please review the trust boundary (`static create` / `fromRow` in the state classes), the
ownership tokens (`IssueAssignment`, `TicketBinding`), and the cancellation/CI-record
surface first. Implementation starts after approval.
