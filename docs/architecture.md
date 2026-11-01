# Architecture

AlephResearch runs on DeepSeek Harness with the Super-agent composition. One
profile mounts `dsh-base`, `dsh-web-app`, the pinned `dsh-superagent` prototype and
the AlephResearch extension; the prototype owns the domain, the extension adds the
research side through the prototype's supported seams.

## Domain (prototype)

- **Source / Thread / Trigger**: an external event becomes a Trigger on a Thread.
  Sources are registered plugins; the `aleph` kind is ours.
- **Eval / Mandate**: the Host assesses a Trigger against Policy rules and records an
  explicit or inferred authorization before any work starts.
- **Ticket / Assignment / Executor**: an accepted request is a durable Ticket with an
  Assignment; the Executor runs a Worker Session in the ticket directory and keeps
  inputs, reports and outbox effects durable across restarts.
- **Channel / Delivery / Effects**: replies and notifications leave through a
  Channel adapter; the Outbox retries them.

The main Session is resident inside the plugin: it does not depend on a browser
being open, and a restart restores the same Session id.

## Research extension

- **Source kind `aleph`**: Threads `research:<project>:ticket:<ticket>`, Triggers
  `request`/`result`/`timer`/`note`, an operator allowlist, the local research
  Channel, and `ALEPH_*` execution variables derived from the Source configuration.
- **Admission**: `admission.js` classifies a request through `budget.js`; the Host
  auto-accepts cheap tiers, holds `training`/`design` for a person, and enforces an
  optional hourly cap.
- **Prepare**: `scripts/superagent-prepare.sh` initializes a self-contained
  repository in the ticket directory, copies only the configured data directory, and
  writes `AGENTS.md` with the data policy, runtime and conventions.
- **Sandbox**: the profile installs `scripts/bwrap-restricted.sh` as the sandbox
  provider's runner; it binds only the declared read roots and the ticket workspace,
  so the host home and source data are invisible to Worker shells.
- **Evaluation**: `evaluation.js` runs the project evaluator with a unique marker and
  kills the whole process tree on timeout; `aleph_submit_result` refuses uncommitted
  work, then feeds the score back as a `result` Trigger and appends it to the results
  log (`results.js`).
- **Watchdog**: one resident session (`aleph-watchdog` preset) receives change-driven
  stall briefs and can stop or retry tickets through the management API.
- **Configuration and panel**: `ConfigStore` versions research settings and applies
  them hot through the prototype settings API; `client.js` renders the research panel;
  `POST /aleph/api/reload` re-imports the extension module from disk.

## Runs

`scripts/superagent-lab.sh` starts an isolated lab: profile, deployment check,
fixture or case project, management API seeding, and the panel URL. `superagent-case.sh`
builds a case run on top of it. `superagent-smoke.sh` asserts the fixture path end to
end; `superagent-soak.sh` samples a case lab for long unattended runs.

## Rewrite in progress

The research mechanism is being rewritten in TypeScript with a type-first design:
`docs/type-blueprint.md` and `research-core/` define the Program, Issue, Experiment
and CI domain before any implementation. The current JavaScript extension stays the
runtime until the phased rewrite reaches parity.

## Legacy

The earlier Leader / Composer / Researcher / Batch plugin, its operator skills and
the scripts that drove it are archived under `archive/`. They are kept for history;
nothing in the runtime, configuration or CI depends on them.
