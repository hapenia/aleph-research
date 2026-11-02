#!/usr/bin/env bash
# Prepare one research ticket: a git worktree from the research repository, the
# allowed data, and the instructions the Worker reads.
#
# The executor runs this once per ticket with the execution variables in scope:
#   DSH_SUPERAGENT_DIR, DSH_SUPERAGENT_NAME, DSH_SUPERAGENT_TICKET
#   ALEPH_RESEARCH_REPO, ALEPH_TEMPLATE_BRANCH, ALEPH_DATA_DIR, ALEPH_PYTHON,
#   ALEPH_CONVENTIONS
#
# It is idempotent: an existing ticket directory is left alone.
set -euo pipefail

dir="${DSH_SUPERAGENT_DIR:?ticket directory is required}"
name="${DSH_SUPERAGENT_NAME:?ticket name is required}"
repo="${ALEPH_RESEARCH_REPO:?ALEPH_RESEARCH_REPO is required}"
template="${ALEPH_TEMPLATE_BRANCH:-main}"
data_dir="${ALEPH_DATA_DIR:-}"
python="${ALEPH_PYTHON:-python3}"
conventions="${ALEPH_CONVENTIONS:-}"
uv=""
if [ -n "${ALEPH_UV:-}" ] && [ -x "${ALEPH_UV}" ]; then uv="$ALEPH_UV"; fi
resources="${ALEPH_RESOURCES:-null}"
methodology="${ALEPH_METHODOLOGY_PATH:-}"
if [ -n "$uv" ]; then
  uv_help="The project runtime bundles uv at $uv. Use it for extra dependencies inside this ticket, for example: $uv venv .venv --python $python ; $uv pip install --python .venv/bin/python -r requirements.txt . Record the exact commands in the ticket. Never modify the shared runtime or install packages system-wide; the submission still has to run under $python."
else
  uv_help="No uv is bundled with this runtime; use only the packages the runtime provides."
fi
if [ "$resources" = "null" ]; then
  resources_help="No compute budget was declared beyond the ticket default."
else
  resources_help="$resources"
fi

if [ ! -d "$repo/.git" ] && [ ! -f "$repo/.git" ]; then
  echo "research repository not found: $repo" >&2
  exit 1
fi

if [ -e "$dir" ]; then
  echo "ticket directory already prepared: $dir"
  exit 0
fi

mkdir -p "$(dirname "$dir")"
# A self-contained repository inside the ticket: its git directory lives in the
# workspace, so the sandbox never has to expose the research repository itself.
git init -q -b "ticket/$name" "$dir"
git -C "$dir" remote add origin "$repo"
git -C "$dir" fetch -q --no-tags origin "$template"
git -C "$dir" reset -q --hard FETCH_HEAD

# The data a Worker may read is copied in, not linked: a write through the link
# would reach the source directory.
if [ -n "$data_dir" ] && [ -d "$data_dir" ]; then
  mkdir -p "$dir/data"
  cp -a "$data_dir/." "$dir/data/"
fi

cat > "$dir/AGENTS.md" <<EOF
# Research ticket: $name

This directory is a git worktree created for one research ticket. Work only here.

## Data

The data you may read is under \`data/\` in this directory. Do not read other
paths on this machine: no other project, no DSH state, no credentials, no
datasets outside \`data/\`. If a request seems to need more data, add an Input or
report that the data is missing instead of reading around the restriction.

Missing measurements may use a sentinel rather than an empty cell. Treat any numeric
value <= -9999 as missing for features and targets; never feed it to a model or a
least-squares fit. The evaluator also skips such rows, so cleaning them is not optional.

## Runtime

Use \`$python\` as the interpreter; the submission has to run under it. Do not modify
the shared runtime.

## Dependencies

$uv_help

## Declared resources

$resources_help

## Conventions

${conventions:-No project conventions were provided.}

## Work

Implement what the ticket asks, verify it with the commands the ticket names, and
commit your work on this branch with a clear message.

This ticket is a self-contained worktree. Legacy research/mission branches and the
source project are not available here; inspect this worktree's own history only.

## Long computations

Start a long command in the background and then end your turn: the job's completion
wakes you with its result. Do not poll a running job with repeated \`job_output\`
waits, and do not re-run a training job that is already running.

The sandbox uses its own PID namespace. \`ps\` inside the workspace may therefore show
no process for a background job that is still running. Trust the \`job_output\` status
instead of \`ps\`; a running job is not a dead job.

The sandbox also gives each command a fresh \`/tmp\`. Scripts or artifacts written to
\`/tmp\` are gone by the next command. Keep analysis scripts and outputs in the ticket
worktree (for example \`scratch/\` or \`experiments/\`), never in \`/tmp\`.

## Environment limits

The configured runtime is the only trusted Python environment. Do not install
system-wide packages, do not use virtual environments from other projects, and do not
plan GPU training unless the ticket or the project conventions name a supported GPU
runtime. GPU device nodes may be visible in the sandbox even when the runtime has no
CUDA-enabled framework; visibility alone is not a promise that training will work. If
a request needs a capability this environment does not have, report that limitation
instead of improvising around it.

## Finishing the ticket (required order)

1. Commit every change on this branch.
2. Call the \`aleph_submit_result\` tool with a one-line summary. It refuses
   uncommitted changes, runs the project evaluation in this directory and reports
   the score back to the ticket. The ticket is not finished until this call
   returns.
3. Only then call the report tool to tell the orchestrator that the ticket is ready.

Report what you changed, what you measured and anything that blocks a person.
EOF

if [ -n "$methodology" ] && [ -f "$methodology" ]; then
  printf '\n\n' >> "$dir/AGENTS.md"
  cat "$methodology" >> "$dir/AGENTS.md"
fi

cat > "$dir/.gitignore" <<'EOF'
data/
results/
__pycache__/
*.pyc
.venv/
EOF

git -C "$dir" add AGENTS.md .gitignore
git -C "$dir" -c user.name=AlephResearch -c user.email=aleph@localhost \
  commit -m "ticket $name: prepare worktree and instructions" >/dev/null
echo "prepared $dir on branch ticket/$name"
