# Research mechanism v5: experiments without code merges

This document follows two review rounds. v3 borrowed GitHub's Issue / PR / CI shape, but
several parts were still software-engineering thinking. v5 keeps the useful collaboration
shape, removes every merge semantic, replaces best/quota with Boltzmann sampling and raw
metrics, and records the lifecycle decisions the reviews forced.

`research-core/` holds the v2 TypeScript blueprint rewritten against this mechanism; it
was rejected by the second independent adversarial review and is being revised. The
mechanism text below is the authority for that revision.

## Actors and powers

| Actor | May do | May not do |
| --- | --- | --- |
| Operator | create Program, set goal and methodology, set exploration level, set budget, pause/stop (cancels in-flight work), handle attention | run experiments, edit code |
| Researcher (several Sessions) | claim Issues, comment, propose Experiment plans, request CI, review CI results, close Issues, propose merges of knowledge into the Issue body | implement code, choose exploit/explore or the base |
| Implementer (one Worker Session per Experiment Ticket) | write experiment code and environment declaration, commit, mark ready for review | choose strategy, request CI, close Issues |
| Host | own all state, sample the exploration base, run CI in the declared environment, store raw metrics and artifacts, cancel work, audit every decision | decide research direction |
| Watchdog | raise attention for stalls, failing CI and unattended Issues | mutate state |
| Main Session | route attention, answer people | do research |

## Objects

- **Program**: goal, methodology, evaluation contract (CI entry, timeout, score field),
  exploration level, budget and status.
- **Issue**: research question with acceptance criteria; one assignee Researcher; comments;
  linked Experiments.
- **Experiment**: one attempt at an Issue. Carries lineage (strategy, base, base commit),
  branch, environment declaration, CI runs, score and artifacts. It is a snapshot; it is
  never merged.
- **CI run**: on-demand evaluation of one commit in the Experiment environment.
- **Artifact**: model weights, reports, logs and figures stored by the Host with retention.
- **Audit entry**: every Host decision with actor, action, subject and facts checked.

## Base selection: Boltzmann sampling, no mainline, no best

There is no "best" and no fixed exploit/explore quota. The Host chooses the base of a new
Experiment by sampling from the previous Experiments with a Boltzmann distribution:

- each candidate Experiment gets a weight `exp(utility / temperature)`;
- the Operator's exploration degree sets a fixed temperature: a low temperature
  concentrates on high-utility results, a high temperature makes the choice nearly
  uniform;
- a separate fresh-start probability chooses "start from zero": branch from the scaffold
  and attempt a direction not present in the current population (including methods no
  human has tried in this project);
- with an empty population, the first Experiment is always a fresh start.

There is no merge target. The research repository keeps one scaffold branch with project
plumbing; every Experiment branches from either a previous Experiment's commit or the
scaffold, and never merges. This removes merge, cherry-pick and conflict handling
entirely. The exploration level is therefore an algorithmic parameter, not a quota.

## Results and metrics, not a single best

Research quality is not one number. Every CI run reports a set of named metrics (the
Program's evaluation contract lists the required ones; the entry may report more). The
Host stores every run, and exposes a results table per Program: metric values by
Experiment, CI run, commit and time, with filtering and sorting. There is no "best"
record. A Researcher reads the table to decide what to propose next; the Boltzmann
sampler reads a utility computed from the same table.

## Lifecycle

```text
Issue opened (Operator or Researcher)
  -> Researcher claims it
  -> Researcher writes the plan as Issue comments and proposes an Experiment
       (hypothesis, steps, expected outcome, environment declaration, artifact inputs)
  -> Host samples the base with the Boltzmann sampler, records the lineage,
     creates the Experiment record (status open) and opens an Implementer Ticket
  -> Implementer prepares the ticket: branch from the assigned base commit, writes code,
     declares the uv environment, commits, marks the Experiment ready
  -> Researcher reviews the ready experiment and requests CI (explicit, not automatic)
  -> Host builds the environment with uv, runs the Program's CI entry inside it,
     records the CI run, score and artifacts
  -> Researcher reviews the CI result:
       pass: Host records the metrics and artifacts; close the Experiment as concluded;
             close the Issue when its acceptance is met, otherwise propose the next Experiment
       fail: comment and either ask for another commit on the same Experiment (new CI later)
             or close the Experiment and propose a different approach
  -> metrics and audit are updated; the loop continues with the next Issue or Experiment
```

The Program is not a merge target; closing the last Issue ends it, or the Operator stops
it when the budget is exhausted.

## Boltzmann exploration

Fixed levels, no per-Program override:

| level | temperature | fresh-start probability |
| --- | ---: | ---: |
| `low` | 0.2 | 2% |
| `normal` | 1.0 | 10% |
| `high` | 3.0 | 25% |

- Candidate weights use a utility configured per Program: the Operator lists metrics with
  a direction (`higher` or `lower`) and a weight. The Host min-max normalizes each metric
  across the current population, sums the weighted normalized values and uses that scalar
  as `utility`.
- The evaluation contract lists the required metrics; a CI run without all of them is
  invalid for sampling (it may still be stored).
- The candidate population is every Experiment in the Program that has at least one valid
  CI run; no time window and no per-Issue restriction.
- Fresh start (branch from the scaffold) is chosen with the table's probability; with an
  empty population it is the only choice.
- Iterating on the same Experiment does not sample a new base and does not change the
  sampler population; only a new Experiment adds a candidate.
- There is no quota counter.

## Review and iteration

- An Experiment can receive several commits and several CI runs while it is open.
- Requesting changes means a new commit on the same Experiment and a later CI request; it
  does not create a new Experiment, so the diversity quota is not consumed by iteration.
- Closing an Experiment as failed records its reason and keeps its CI history and
  artifacts for learning.
- A Researcher may only act on the Issue it is assigned to; other Researchers see the
  Experiment and its audit but cannot modify it.

## Results table

The Host stores **raw CI records only**: one row per CI run with its commit, timestamp,
metrics and artifacts. There is no stored latest-per-Experiment view and no stored best:
the panel, Researcher tools and the sampler derive their views (latest, average, sorted,
filtered) at query time from the raw records. Artifacts stay attached to their CI run and
Experiment; a later Experiment may consume them through typed inputs.

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

## Resolved in this round

- No "best" and no quota: quality is a raw multi-metric results table; exploration is a
  Boltzmann-weighted base choice with a fixed fresh-start probability per level.
- Utility is a weighted sum of min-max normalized metrics; the Operator configures weights
  and directions per Program; the evaluation contract lists required metrics.
- Exploration levels are the fixed table above; no override.
- The candidate population is every Experiment with at least one valid CI run in the
  Program.
- Storage keeps raw CI records only; views and aggregates are queries.
- Experiment record is created when the Researcher proposes it, and the Host samples the
  base at that moment.
- The same Experiment may receive new commits and repeated CI (iteration).
- CI is requested explicitly by the Researcher.
- The first Experiment (empty population) is a fresh start from the scaffold.

No open questions remain in the mechanism. The next step is rewriting the TypeScript
blueprint (nominal classes with factories, typed command executor, per-role tool schemas,
nominal storage ids with versions, Program state machine, review flow, metrics/artifacts
ports) against this mechanism and the adversarial review's findings.
