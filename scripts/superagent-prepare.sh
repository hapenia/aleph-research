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

## Runtime

Use \`$python\` as the interpreter. It already has the project runtime installed;
do not create or install environments.

## Conventions

${conventions:-No project conventions were provided.}

## Work

Implement what the ticket asks, verify it with the commands the ticket names, and
commit your work on this branch with a clear message.

## Finishing the ticket (required order)

1. Commit every change on this branch.
2. Call the \`aleph_submit_result\` tool with a one-line summary. It refuses
   uncommitted changes, runs the project evaluation in this directory and reports
   the score back to the ticket. The ticket is not finished until this call
   returns.
3. Only then call the report tool to tell the orchestrator that the ticket is ready.

Report what you changed, what you measured and anything that blocks a person.
EOF

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
