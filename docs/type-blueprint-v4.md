# Type blueprint v4 proposal: receipt-chained research loop

Status: **design proposal only. Do not implement until reviewed.** The current
`research-core` types are frozen at the previous blueprint; this document proposes the
next whole-system shape after the live test showed that typecheck passing did not mean
the research workflow existed.

## What failed

The previous blueprint typed **nouns**: Program/Issue/Experiment states, command payloads,
repository ports and API responses. Those types were internally consistent, but nothing
forced the system to connect the nouns into a running loop:

- `experiment.propose` could return a valid `OpenExperiment` even though no Trigger was
  delivered, no Source Eval accepted it, no Ticket was opened, no Worker ran and no
  CIRecord was written.
- Ports were optional/defaulted; a composition could omit a stage and still compile.
- `Result<T, DomainError>` let a caller ignore the next step.
- Type tests proved that wrong data could not be constructed, not that a workflow step
  was called at all.

The missing rule is: **each step must take the previous step's proof as a parameter and
return the next step's proof as its result.** A caller cannot skip, reorder or replace a
step, because the proof type is nominal and only the previous stage can produce it.

## The receipt algebra

Every completed step returns a nominal receipt value. Receipt carries only the facts
needed by the next step; the durable aggregate state remains in storage.

```ts
declare class Receipt<Kind extends string> {
  private constructor()
  private readonly __receipt: Kind
  readonly kind: Kind
  readonly at: IsoTimestamp
  readonly programId: ProgramId
}
```

Concrete receipt (sketch):

```ts
IssueAssignedReceipt          // the assignee is known and authorized
ExperimentProposedReceipt     // a typed plan and environment exist
TriggerAcceptedReceipt        // the prototype Source Eval accepted the trigger
TicketOpenedReceipt           // the Executor owns a Ticket for the Experiment
WorkerStartedReceipt          // a Worker Session actually started
CommitSubmittedReceipt        // the Worker committed a head for CI
EnvironmentBuiltReceipt       // uv built the declared environment
CIPassedReceipt / CIFailedReceipt
ResultRecordedReceipt         // the raw CIRecord and artifacts are persisted
ReviewRecordedReceipt         // the Researcher's verdict is persisted
ResearchCompletedReceipt      // the Issue/Experiment are closed with an outcome
```

Receipt constructors are private. A single factory boundary mints them after the real
side effect (or in the in-memory implementation used by tests). The factory is the only
trusted boundary; it does not prove the network call happened, but it makes the call site
explicit and testable.

## The loop as types

A stage is a function whose input is the previous receipt and whose output is the next:

```ts
type FlowStep<In extends Receipt, Out extends Receipt> = (
  input: In,
  ctx: StageContext,
) => Promise<Result<Out, DomainError>>
```

The production composition must satisfy the whole interface:

```ts
interface ResearchFlow {
  deliverTrigger: FlowStep<ExperimentProposedReceipt, TriggerAcceptedReceipt>
  openTicket: FlowStep<TriggerAcceptedReceipt, TicketOpenedReceipt>
  startWorker: FlowStep<TicketOpenedReceipt, WorkerStartedReceipt>
  submitCommit: FlowStep<WorkerStartedReceipt, CommitSubmittedReceipt>
  buildEnvironment: FlowStep<CommitSubmittedReceipt, EnvironmentBuiltReceipt>
  runCI: FlowStep<EnvironmentBuiltReceipt, CIPassedReceipt | CIFailedReceipt>
  recordResult: FlowStep<CIPassedReceipt, ResultRecordedReceipt>
  reviewResult: FlowStep<ResultRecordedReceipt, ReviewRecordedReceipt>
  closePassed: FlowStep<ReviewRecordedReceipt, ResearchCompletedReceipt>
  closeFailed: FlowStep<CIFailedReceipt, ResearchCompletedReceipt>
}
```

`runCI` returns a union, so the caller must handle both branches; a failed CI cannot be
silently dropped. Stages return `DomainError` only for refusals that are meaningful to
the loop (for example an Eval refusal); infrastructure failures are receipt of failure
and must also be consumed by `closeFailed` or a retry stage.

A central `runResearchFlow` receives the wiring and an initial `ExperimentProposedReceipt`
and can only chain stages in the declared order. The compiler enforces the order:

```ts
async function runResearchFlow(loop: ResearchFlow, start: ExperimentProposedReceipt) {
  const accepted = await loop.deliverTrigger(start, ctx)
  if (!accepted.ok) return accepted
  const ticket = await loop.openTicket(accepted.value, ctx)
  // ...
}
```

Passing `start` to `openTicket`, or calling `buildEnvironment` before `submitCommit`, is a
compile error. There is no `any` or optional stage in the production interface.

## Authorization is receipt too

A command from a model is not executable until a Host gate has checked principal,
capability and ownership. The gate returns a proof:

```ts
interface AuthorizedCommand<K extends CommandType> {
  readonly command: CommandOf<K>
  readonly actor: ActorOfCommand<K>
  readonly authorization: AuthorizationProof<K>
}
```

`CommandExecutor` accepts only `AuthorizedCommand<K>`, not a bare command plus context.
The route/parser layer cannot call the executor without calling the authorizer first.
This is stronger than the previous `CommandContext<K>` because the context was just a
bag; the proof is minted only by the authorizer.

## Wiring and completion ledger

`createResearchHost` takes a complete `ResearchFlow`; there is no default production
wiring. Tests may use `createUnimplementedFlow()` whose stages throw
`UnimplementedError(feature)`.

The completion ledger (`research-core/src/completion.ts`) lists every stage that is not
verified end to end. `npm run check:completion` validates that each pending feature has a
`TODO(@feature)` marker at its seam. `npm run check:release` compiles `release-gate.ts`
and fails while any feature is `'todo'`.

The loop must not be exposed as working merely because types compile. Health reports the
ledger, and the release gate is the deployment gate.

## Storage and DSH seam

Storage remains the durable source of truth for aggregate state. Receipt is ephemeral:
it proves that a step happened, while the corresponding CIRecord, Ticket and state
versions are persisted. Each receipt contains the ids and versions needed by the next
stage, so no stage needs to guess or re-read optional data.

The DSH/prototype seam is represented by concrete stage interfaces, not optional ports:

- `deliverTrigger` calls `ctx.orchestrator.context(aleph).receive` and returns
  `TriggerAcceptedReceipt` only when the Source accepts;
- `openTicket` returns `TicketOpenedReceipt` only with a real Ticket id;
- `startWorker`, `buildEnvironment`, `runCI`, etc. likewise return receipt only after the
  corresponding action.

A fake implementation for tests is allowed, but it must implement the same loop. A
production adapter that has not implemented a stage must either fail the release gate or
expose `UnimplementedError`; it cannot silently skip.

## Compile-time guarantees and limits

Guaranteed by the loop types:

- a stage cannot be skipped or called out of order;
- an earlier receipt cannot be passed to a later stage;
- a CI failure cannot be ignored because the union must be consumed;
- a raw command cannot reach the executor without an authorization proof;
- a missing stage in the production wiring is a type error;
- the release gate refuses to compile while the ledger has todos.

Not guaranteed by types: the external side effect actually happened, the actor really is
the Session, the Source really accepted the trigger, or the CI really ran. The receipt
factory is the single trust boundary; integration tests must exercise it with the real
DSH lab, and the ledger/release gate tracks what is still missing.

## Mapping from the current modules

| Current | v4 |
| --- | --- |
| nominal state classes | stay; they are the durable aggregate shape |
| command handlers returning state | return receipt after the durable write |
| `CommandContext` bag | `AuthorizedCommand` proof from the auth gate |
| optional service ports | required loop stages; unimplemented loop for dev |
| `TriggerFactory` mapping | `deliverTrigger` stage returns `TriggerAcceptedReceipt` |
| `triggerPort` / bridge | `openTicket` stage; no fire-and-forget bridge |
| `createResearchHost` optional pipeline | `ResearchFlow` required; health reports ledger |
| TODO comments | `TODO(@feature)` + completion checker + release gate |
| type/mutation tests | plus loop-order and authorization negative tests |

## Migration plan (after approval)

1. Define receipt classes and the `ResearchFlow` interface; update type tests.
2. Change each handler to return its receipt after the durable write.
3. Implement the auth gate and `AuthorizedCommand`; executor accepts only it.
4. Rewire `research-host` and the DSH adapter to call the loop; delete optional ports.
5. Add loop-order negative tests and a lab integration test that drives
   `ExperimentProposedReceipt` to `ResearchCompletedReceipt`.
6. Empty the completion ledger; only then restart a test DSH.

## Review questions

1. **Receipt persistence.** Keep receipt ephemeral (proposed) or persist it for audit?
   Ephemeral keeps state and proof separate; audit already records the durable facts.
2. **Failure branches.** Should the loop model explicit `CIFailedReceipt` (proposed),
   retryable failure receipt, or both? A retry should be a loop edge, not a hidden retry
   inside `runCI`.
3. **Stage granularity.** Is `submitCommit` separate from `startWorker`, or should the
   Worker stage own prepare → commit and return `CommitSubmittedReceipt` directly?
