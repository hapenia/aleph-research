#!/usr/bin/env bash
# Build a reusable, plugin-independent case template from read-only source
# material. A run copies the template, so every plugin iteration starts from the
# same inputs and the same runtime.
#
# Layout produced under <store>/<case>/:
#   template/problem/       original problem statement and data.zip
#   template/eval/          leader-side evaluator
#   template/visible-data/  wells the Leader may hand to researchers
#   template/testsets/      hidden wells, leader-side only
#   template/case.json      init parameters for the current project model
#   runtime/                shared Python with the scientific stack
#
# The source project is only ever read.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case_name="${1:-kunlungpt}"
store="${ALEPH_CASE_STORE:-$repo/.case-templates}"
source_root="${ALEPH_CASE_SOURCE:-/home/hapenia/Projects/kunlungpt-comp}"
python_bin="${ALEPH_CASE_PYTHON:-/usr/bin/python3.14}"

src_case="$source_root/aleph-case"
dest="$store/$case_name"
template="$dest/template"

for path in "$source_root/problem" "$src_case/leader/eval" "$src_case/leader/testsets" "$src_case/visible-data"; do
  [ -e "$path" ] || { echo "missing case asset: $path" >&2; exit 1; }
done

if [ -d "$dest" ]; then
  echo "template already exists: $dest (refreshing metadata only)"
  cp -a "$src_case/leader/eval/." "$template/eval/"
  echo "refreshed eval from $src_case/leader/eval"
else
  mkdir -p "$template"
  cp -a "$source_root/problem" "$template/problem"
  cp -a "$src_case/leader/eval" "$template/eval"
  cp -a "$src_case/leader/testsets" "$template/testsets"
  cp -a "$src_case/visible-data" "$template/visible-data"
  cat > "$template/case.json" <<'JSON'
{
  "name": "kunlungpt",
  "title": "Kunlungpt reservoir prediction",
  "brief": "Predict POR, PERM and SW for unseen wells and maximise the official total score. Inspect research and mission git history before working. Package training, sweeps and other high-compute work as a mission branch; costly work that helps other researchers must also be a mission.",
  "eval_command": "python3 eval/run_eval.py",
  "provide_data": ["visible-data"],
  "researcher_count": 4
}
JSON
  echo "built template: $template"
fi

# The scientific stack is shared by every run of this case.
if [ ! -x "$dest/runtime/bin/python" ]; then
  uv venv "$dest/runtime" --python "$python_bin" >/dev/null
  uv pip install --python "$dest/runtime/bin/python" \
    numpy pandas scipy scikit-learn lightgbm uv >/dev/null
  echo "built runtime: $dest/runtime"
else
  echo "runtime already present: $dest/runtime"
  if [ ! -x "$dest/runtime/bin/uv" ]; then
    uv pip install --python "$dest/runtime/bin/python" uv >/dev/null
    echo "added uv to the runtime"
  fi
fi

"$dest/runtime/bin/python" - <<'PY'
import lightgbm, numpy, pandas, sklearn
print("runtime ok", numpy.__version__, pandas.__version__, sklearn.__version__, lightgbm.__version__)
PY
du -sh "$template" "$dest/runtime"
