# AlephResearch research methodology

These rules come from the retired Leader/Researcher design and apply to every research
ticket on this system.

## Data policy

- Read only the data provided in the ticket (`data/` or the paths the ticket names).
  Never read the source project, other research repositories, credentials or the
  harness state; the sandbox hides them for a reason.
- The source dataset is provided as a copy. If the work needs data the ticket does not
  contain, report the gap instead of searching the machine for it.

## Dependencies and runtime

- The configured runtime (`ALEPH_PYTHON`) is the interpreter a submission must run
  under; check `ALEPH_SUBMISSION_PYTHON` when the project conventions name it.
- `ALEPH_UV` is the bundled uv. Use it for extra dependencies inside the ticket, for
  example `$ALEPH_UV venv .venv --python $ALEPH_PYTHON`, then
  `$ALEPH_UV pip install --python .venv/bin/python -r requirements.txt`. Record the
  exact commands in the ticket so the work is reproducible.
- Never modify the shared runtime or install packages system-wide.

## Compute

- Long jobs start in the background and end the turn: the completion wakes you with
  its result. Do not poll a running job and do not rerun a job that is already
  running.
- Keep the ticket's compute proportionate to its request. Training runs, sweeps and
  multi-process work need a resource declaration on the request; without one they are
  out of scope for that ticket.

## Evaluation

- Commit the work before submitting: the Host refuses to evaluate a dirty tree.
- The Host runs the project evaluator on the committed tree and records the score; do
  not claim a score you did not receive from `aleph_submit_result`.
- Report what changed, what was measured and what blocks a person. Notes on earlier
  attempts and negative results belong in the report so a later ticket does not repeat
  them.
