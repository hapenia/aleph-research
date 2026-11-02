# Type blueprint v4 proposal: typestate research pipeline

Status: **design proposal only. Do not implement until reviewed.** The previous
blueprint typed nouns; this one types the ordered pipeline that connects them.

## What failed

The old types made every individual state and command valid, but did not require the next
step to run:

- `experiment.propose` could return a valid `OpenExperiment` without a Trigger, Source
  Eval, Ticket, Worker or CIRecord.
- Service ports were optional, so a composition could omit a step and still compile.
- `Result<T, DomainError>` let callers ignore the next step.
- Type tests checked data shape, not that a step was called.

The new rule: **each step consumes the previous stage state and returns the next stage
state.** The next state is nominal and only the previous step creates it.

## Stage states

A stage state carries only the facts the next step needs. Durable aggregate state stays
in storage.

```ts
IssueAssigned          // assignee is known and authorized
ExperimentProposed     // plan and environment exist
TriggerAccepted        // Source Eval accepted the trigger
TicketOpened           // Executor owns a Ticket
WorkerStarted          // Worker Session started
CommitSubmitted        // Worker committed a head for CI
EnvironmentBuilt       // uv built the declared environment
CIPassed | CIFailed
ResultRecorded         // CIRecord and artifacts persisted
ReviewRecorded         // Researcher verdict persisted
ResearchCompleted      // Issue/Experiment closed with an outcome
```

Constructors are private. A single factory creates each state after the real side effect
(or in the in-memory implementation used by tests). The factory is the trust boundary: it
does not prove that a network call happened, but it makes the call site explicit.

## Pipeline steps

```ts
type Step<In, Out> = (
  input: In,
  ctx: Context,
) => Promise<Result<Out, DomainError>>

interface ResearchPipeline {
  deliverTrigger: Step<ExperimentProposed, TriggerAccepted>
  openTicket: Step<TriggerAccepted, TicketOpened>
  startWorker: Step<TicketOpened, WorkerStarted>
  submitCommit: Step<WorkerStarted, CommitSubmitted>
  buildEnvironment: Step<CommitSubmitted, EnvironmentBuilt>
  runCI: Step<EnvironmentBuilt, CIPassed | CIFailed>
  recordResult: Step<CIPassed, ResultRecorded>
  reviewResult: Step<ResultRecorded, ReviewRecorded>
  closePassed: Step<ReviewRecorded, ResearchCompleted>
  closeFailed: Step<CIFailed, ResearchCompleted>
}
```

`runCI` returns a union, so both branches must be handled. `runPipeline` chains the steps
in order:

```ts
async function runPipeline(pipeline: ResearchPipeline, start: ExperimentProposed) {
  const accepted = await pipeline.deliverTrigger(start, ctx)
  if (!accepted.ok) return accepted
  const ticket = await pipeline.openTicket(accepted.value, ctx)
  // ...
}
```

Passing `start` to `openTicket`, or calling `buildEnvironment` before `submitCommit`, does
not compile. The production interface has no optional step and no `any`.

## Typestate API

The pipeline interface is for wiring. The public API is typestate: each class exposes
only the next operation.

```ts
class ExperimentProposed {
  deliverTrigger(): Promise<Result<TriggerAccepted, DomainError>>
}
class TriggerAccepted {
  openTicket(): Promise<Result<TicketOpened, DomainError>>
}
class TicketOpened {
  startWorker(): Promise<Result<WorkerStarted, DomainError>>
}
class WorkerStarted {
  submitCommit(): Promise<Result<CommitSubmitted, DomainError>>
}
class CommitSubmitted {
  buildEnvironment(): Promise<Result<EnvironmentBuilt, DomainError>>
}
class EnvironmentBuilt {
  runCI(): Promise<Result<CIPassed | CIFailed, DomainError>>
}
class CIPassed {
  recordResult(): Promise<Result<ResultRecorded, DomainError>>
}
class CIFailed {
  closeFailed(): Promise<Result<ResearchCompleted, DomainError>>
}
class ResultRecorded {
  reviewResult(): Promise<Result<ReviewRecorded, DomainError>>
}
class ReviewRecorded {
  closePassed(): Promise<Result<ResearchCompleted, DomainError>>
}
class ResearchCompleted {
  readonly outcome: 'concluded' | 'failed' | 'cancelled'
}
```

- `openTicket()` does not exist on `ExperimentProposed`, so the trigger step cannot be
  skipped even if the caller holds a state value.
- `CIPassed` and `CIFailed` are distinct types; the branch must be handled.
- `ResearchCompleted` has no next operation.
- Constructors are private; `startPipeline(pipeline, initial)` is the only entry.

TypeScript has no move semantics: a previous object still exists after the next state is
returned. It has no methods that advance the pipeline, so the only way forward is the
current state.

## Wiring builder

Wiring completeness is also a typestate:

```ts
type Capability =
  | 'trigger' | 'ticket' | 'worker' | 'commit' | 'environment'
  | 'ci' | 'result' | 'review' | 'close'

class PipelineBuilder<W extends Capability = never> {
  withTrigger(fn: Step<ExperimentProposed, TriggerAccepted>): PipelineBuilder<W | 'trigger'>
  withTicket(fn: Step<TriggerAccepted, TicketOpened>): PipelineBuilder<W | 'ticket'>
  // ...
  build(this: PipelineBuilder<Capability>): ResearchPipeline
}
```

`build()` exists only when every capability is present. A partial builder has no way to
start a pipeline.

## Authorization

`CommandDraft<K>` has no executor. `.authorize(principal, hostProof)` returns
`AuthorizedCommand<K>`, and only that type is accepted by `CommandExecutor`. The
aggregate classes stay typestate as before: `OpenIssue.claim()` only on the open variant,
`CIPassedExperiment.close()` only on the passed variant.

## Completion gate

`createResearchHost` takes a complete `ResearchPipeline`; there is no default production
wiring. Tests supply an in-memory `FakePipeline` that actually implements every step.
There is no `createUnimplementedPipeline`: a complete-looking object whose methods throw
would let incomplete wiring pass typecheck and fail only at runtime.

The completion ledger (`research-core/src/completion.ts`) lists every feature that is not
verified end to end. `npm run check:completion` prints pending work from the ledger;
`npm run check:release` fails to compile while any feature is `'todo'`. Rust stubs use the
standard `todo!()` macro; there are no explanatory TODO comments. Health reports the
ledger; the release gate is the deployment gate.

## Storage and DSH seam

Storage remains the source of truth for aggregate state. Stage states are ephemeral: they
prove that a step happened, while the CIRecord, Ticket and state versions are persisted.
Each state contains the ids and versions needed by the next step.

The DSH/prototype seam is concrete steps, not optional ports:

- `deliverTrigger` calls `ctx.orchestrator.context(aleph).receive` and returns
  `TriggerAccepted` only when the Source accepts;
- `openTicket` returns `TicketOpened` only with a real Ticket id;
- `startWorker`, `buildEnvironment`, `runCI` likewise return their state only after the
  corresponding action.

A fake implementation may implement the same pipeline for tests. A production adapter
that has not implemented a step must fail the release gate or throw `UnimplementedError`
at that step; it cannot silently skip and cannot wrap the gap in a fake complete pipeline.

## Guarantees and limits

The types guarantee:

- a step cannot be skipped or called out of order;
- an earlier stage state cannot be passed to a later step;
- a CI failure cannot be ignored because the union must be consumed;
- a raw command cannot reach the executor without an authorization proof;
- a missing step in production wiring is a type error;
- the release gate refuses to compile while the ledger has todos.

They do not prove that the external side effect happened, that the actor is the real
Session, that the Source accepted the trigger, or that CI ran. The factory is the single
trust boundary; integration tests must exercise it with the real DSH lab.

## Mapping and migration

| Current | v4 |
| --- | --- |
| nominal state classes | stay as durable aggregate shape |
| command handlers returning state | return the stage state after the durable write |
| `CommandContext` bag | `AuthorizedCommand` from the auth gate |
| optional service ports | required pipeline steps; tests implement the full fake pipeline |
| `TriggerFactory` | `deliverTrigger` returns `TriggerAccepted` |
| `triggerPort` / bridge | `openTicket`; no fire-and-forget bridge |
| `createResearchHost` optional pipeline | `ResearchPipeline` required; health reports ledger |
| completion tracking | `completion.ts` ledger + `check:release`; Rust stubs use `todo!()` |
| type/mutation tests | add pipeline-order and authorization negative tests |

Migration after approval:

1. Define stage states and `ResearchPipeline`; update type tests.
2. Change each handler to return its stage state after the durable write.
3. Implement the auth gate and `AuthorizedCommand`; executor accepts only it.
4. Rewire `research-host` and the DSH adapter to call the pipeline; delete optional ports.
5. Add pipeline-order negative tests and a lab integration test.
6. Empty the completion ledger; only then restart a test DSH.

## Review questions

1. **Stage state persistence.** Keep stage states ephemeral (proposed) or persist them
   for audit? Ephemeral keeps state and proof separate; audit already records facts.
2. **Failure branches.** Model explicit `CIFailed` (proposed), retryable failure, or both?
   A retry should be a pipeline edge, not a hidden retry inside `runCI`.
3. **Step granularity.** Is `submitCommit` separate from `startWorker`, or should the
   Worker step own prepare → commit and return `CommitSubmitted` directly?
