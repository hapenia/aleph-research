# Research mechanism v3: Issue, Pull request, CI

This document replaces the earlier ticket-per-request loop and the partial restoration
of the retired Leader/Researcher design. The mechanism borrows GitHub's collaboration
shape because it separates research judgement from implementation and gives every
result a reviewable, mergeable artifact.

## Roles

- **Operator**: sets the research goal, the evaluation contract and the budget; pauses
  or stops the program; handles anomalies. The only role allowed to change the goal.
- **Researcher** (several concurrent Sessions): owns an assigned Issue, writes the
  experiment plan as Issue comments, reviews CI results, requests CI, closes Issues and
  proposes merges. A Researcher never implements.
- **Implementer** (one Worker Session per Pull request Ticket): implements the plan on
  the Pull request branch, declares its environment, commits and submits. An Implementer
  makes no research decision.
- **Host**: the only writer of research state; runs CI, records results, enforces the
  auto-merge rule, and keeps the resident Sessions alive.
- **Watchdog**: supervises stalled Pull requests, failing CI and Issues nobody follows.
- **Main Session**: notification and attention routing only.

## Objects

State lives in Host storage (not in the research repository). The research repository
holds only code and the environment declaration the Host needs to run CI.

- **Program**: goal, evaluation contract, budget (Pull requests, compute minutes,
  tokens), status (running, paused, stopped), best result.
- **Issue**: id, title, body (goal and acceptance), labels, `assignees` (one Researcher
  claims it), status (open, reviewing, closed), comments, linked Pull requests.
- **Pull request**: id, Issue id, branch, head commit, environment declaration,
  status (open, ci_requested, ci_passed, ci_failed, merged, closed), CI runs, review
  comments.
- **CI run**: id, Pull request id, commit, environment digest, score, metrics, logs,
  duration, verdict.

State machines:

```text
Issue:        open -> assigned -> in_review -> closed
Pull request: open -> ci_requested -> ci_passed -> merged
                    \\-> ci_failed -> (new commits) -> ci_requested ...
CI run:       requested -> running -> passed | failed
```

## Flow

```text
1. Operator creates a Program (goal + evaluation contract + budget) and a first Issue.
2. Host wakes an idle Researcher; it claims the Issue (assignee).
3. Researcher writes the experiment plan as Issue comments and asks for an Implementer:
   Host opens a Pull request Ticket with the plan as the assignment.
4. Implementer writes code on the Pull request branch, declares the environment
   (`environment/uv.lock` or `requirements.txt` and the program's CI entry), commits.
5. Researcher requests CI for the current head commit.
6. Host builds the Pull request's environment with uv, runs the CI entry inside it,
   records the CI run and posts the result as a review comment.
7. Researcher reviews: request changes (back to step 4), or propose merge.
8. Auto-merge: when the Program's acceptance rule holds (for example CI passed, score
   above the current best, no conflicts) the Host merges the Pull request into the
   research mainline, updates the best result and links the merge from the Issue.
9. When the Issue's acceptance is met the Researcher closes it; when the Program goal is
   met or the budget is exhausted the Program stops and the Operator is notified.
```

Every step is an event on the Program Thread; the Host turns an event into a Trigger,
Eval authorizes per Ticket, and a Worker or a Researcher Session handles it. No cron
script injects requests.

## Authorization

- Every Implementer Ticket is authorized by Eval per Ticket, with the Policy rules the
  Operator set for the Program.
- Researcher tools are restricted to Researcher Sessions and checked against the Issue
  assignee; a Researcher cannot act on another Researcher's Issue.
- CI runs only on explicit Researcher request.
- Auto-merge is a Host rule, not a model decision. It requires the declared acceptance
  criteria, a passed CI run on the head commit and a clean merge.
- The Operator can veto or pause at any point.

## Concurrency

Several Researchers exist at once. Each Issue has exactly one assignee; the Host routes
Issue events only to that assignee and wakes an idle Researcher only for unassigned
Issues. Implementers are bounded by the prototype's worker concurrency. There is no
separate machine or batch scheduler: compute runs inside the Pull request environment,
and resource declarations are descriptive.

## Environments and CI

The Pull request branch declares its environment. The Program evaluation contract names
the CI entry (for example `eval/ci.sh`) and the score extraction. The Host copies the
branch into a ticket workspace, builds the environment with the bundled uv, runs the CI
entry inside that environment with `ALEPH_SUBMISSION_PYTHON` pointing at the built
interpreter, and records the JSON score the entry prints. A branch without a declaration
falls back to the Program runtime.

## Panel

The research panel stays read-only in the first version: Program status, Issues with
assignees, Pull requests with CI verdicts and the best result. Controls remain API/tools
until the mechanism is proven on a real case.

## Implementation phases

1. **State and store**: Program, Issue, Pull request and CI run records with a tested
   store, plus management routes and Event to Trigger mapping.
2. **Researcher pool**: preset, session pool, assignee claiming, Issue and CI tools,
   wake-ups from Issue and CI events.
3. **Implementer flow**: Pull request Tickets, environment declaration in prepare,
   on-demand CI runner with uv, review comments.
4. **Auto-merge and panel**: acceptance rule, merge, best update, read-only Program view.
5. **Case migration**: run the kunlungpt case as a Program with Issues and Pull
   requests, then the 24-hour unattended run and final verification.

Open points carried from the design discussion: the exact CI acceptance expressions per
Program, and how the first Researcher pool size is configured.
