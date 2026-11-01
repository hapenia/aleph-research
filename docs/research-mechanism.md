# Research mechanism v4: experiments without code merges

This revision follows the adversarial type review. The v3 document borrowed GitHub's
Issue / PR / CI shape, but several parts were still software-engineering thinking and
several behaviours were underspecified. v4 keeps the useful collaboration shape, removes
every merge semantic, and fixes the lifecycle questions the type review exposed.

The TypeScript blueprint is paused until this mechanism is agreed; `research-core/` still
describes v3 and will be rewritten afterwards.

## Actors and powers

| Actor | May do | May not do |
| --- | --- | --- |
| Operator | create Program, set goal and methodology, set exploration level, set budget, pause/stop (cancels in-flight work), handle attention | run experiments, edit code |
| Researcher (several Sessions) | claim Issues, comment, propose Experiment plans, request CI, review CI results, close Issues, propose merges of knowledge into the Issue body | implement code, choose exploit/explore or the base |
| Implementer (one Worker Session per Experiment Ticket) | write experiment code and environment declaration, commit, mark ready for review | choose strategy, request CI, close Issues |
| Host | own all state, assign exploration strategy and base, run CI in the declared environment, store artifacts, update best, cancel work, audit every decision | decide research direction |
| Watchdog | raise attention for stalls, failing CI and unattended Issues | mutate state |
| Main Session | route attention, answer people | do research |

## Objects

- **Program**: goal, methodology, evaluation contract (CI entry, timeout, score field),
  exploration level, budget, best result, status.
- **Issue**: research question with acceptance criteria; one assignee Researcher; comments;
  linked Experiments.
- **Experiment**: one attempt at an Issue. Carries lineage (strategy, base, base commit),
  branch, environment declaration, CI runs, score and artifacts. It is a snapshot; it is
  never merged.
- **CI run**: on-demand evaluation of one commit in the Experiment environment.
- **Artifact**: model weights, reports, logs and figures stored by the Host with retention.
- **Audit entry**: every Host decision with actor, action, subject and facts checked.

## What "mainline" means without merges

The research repository has one scaffold branch that only contains project plumbing
(scaffold, data loading, submission skeleton). It is the explore base and never receives
experiment code. An exploit Experiment branches from the commit of the current best
result; an explore Experiment branches from the scaffold branch. "Best" is a Host record
pointing at an Experiment commit and its artifacts, not a branch that receives merges.

This removes the need for merge, cherry-pick or conflict handling entirely.

## Lifecycle

```text
Issue opened (Operator or Researcher)
  -> Researcher claims it
  -> Researcher writes the plan as Issue comments and proposes an Experiment
       (hypothesis, steps, expected outcome, environment declaration, artifact inputs)
  -> Host assigns strategy and base from the Program's exploration level and quota,
     creates the Experiment record (status open) and opens an Implementer Ticket
  -> Implementer prepares the ticket: branch from the assigned base commit, writes code,
     declares the uv environment, commits, marks the Experiment ready
  -> Researcher reviews the ready experiment and requests CI (explicit, not automatic)
  -> Host builds the environment with uv, runs the Program's CI entry inside it,
     records the CI run, score and artifacts
  -> Researcher reviews the CI result:
       pass: close the Experiment as concluded; Host updates best when the score improves;
             close the Issue when its acceptance is met, otherwise propose the next Experiment
       fail: comment and either ask for another commit on the same Experiment (new CI later)
             or close the Experiment and propose a different approach
  -> best and audit are updated; the loop continues with the next Issue or Experiment
```

The Program is not a merge target; closing the last Issue ends it, or the Operator stops
it when the budget is exhausted.

## Exploration without a merge mainline

- Operator sets `low | normal | high`.
- Fixed quota: `low` exploits only; `normal` one explore in every three new Experiments;
  `high` one explore in every two.
- Below the quota denominator (bootstrap), the first Experiment is forced to explore from
  the scaffold branch so the Program does not start from an empty best.
- Exploit requires a best result; if no best exists yet, the Host uses explore.
- The quota counts Experiment creation, not CI runs: retries and iterations on the same
  Experiment do not consume the diversity budget.

## Review and iteration

- An Experiment can receive several commits and several CI runs while it is open.
- Requesting changes means a new commit on the same Experiment and a later CI request; it
  does not create a new Experiment, so the diversity quota is not consumed by iteration.
- Closing an Experiment as failed records its reason and keeps its CI history and
  artifacts for learning.
- A Researcher may only act on the Issue it is assigned to; other Researchers see the
  Experiment and its audit but cannot modify it.

## Best result

Only the Host writes `best`. It is updated from a `PassedCIRun` when the score is at least
the current best (or when the first valid score appears). The best record points at the
Experiment, commit, CI run and its artifacts; later exploit Experiments branch from that
commit and may consume those artifacts through typed inputs.

## Budget and cancellation

- Budget is measured on three counters: new Experiments, CI compute minutes and model
  tokens (the Host records CI compute; the DSH session layer records tokens).
- Exceeding a counter pauses new Experiment creation and raises attention; pausing or
  stopping a Program cancels running Implementer work and pending CI.
- CI requests and retries count toward compute minutes, which is why CI is on demand.

## Multiple Researchers

- The Host keeps a configured pool of Researcher Sessions, each identified by its Session
  id; there is no separate stable researcher identity.
- An Issue has exactly one assignee; only that Session may claim, propose or close for it.
- Idle Researchers may open new Issues from observations (for example a data anomaly) but
  may not touch another Researcher's Issue.
- When a Researcher restarts, its Sessions are recreated; a restart does not silently
  transfer Issue ownership: an Issue whose assignee disappeared becomes attention.

## DSH and SuperAgent integration (mechanism level)

- Researcher Sessions are ordinary DSH Sessions with a research preset and the research
  tools; the Host creates and wakes them, but they hold no execution power.
- Every mechanism fact becomes a Trigger on the Program Thread and goes through the
  prototype's Eval for per-Ticket authorization; the prototype's Router routes accepted
  work and the Executor starts the Implementer Worker.
- CI and scoring are Host responsibilities: the submit tool does not score inline; it asks
  the Host CI runner, which uses the Experiment's uv environment and records the result.
- State and audit live in the Host storage domain; the research repository holds code and
  environment declarations only.

## Open questions for this round

1. Mainline: fixed scaffold branch (proposed) versus a branch the Host advances from
   accepted results (that would reintroduce adoption/merge semantics).
2. When is the Experiment record created: at Researcher proposal (proposed) or only after
   the Implementer marks it ready?
3. Iteration on one Experiment: allow new commits and repeated CI on the same Experiment
   (proposed) or require a new Experiment for every change?
4. Best update: automatic when a passed score is at least the best (proposed) or only after
   Researcher/Operator adoption?
5. Exploration quota window: the last N Experiment creations counted globally (proposed,
   N from the level) or a different accounting?
6. Bootstrap: force the first Experiment to explore from the scaffold (proposed) or let the
   Operator choose the first strategy?
