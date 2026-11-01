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
python_version="${ALEPH_CASE_PYTHON_VERSION:-3.14}"
uv_bin="${ALEPH_UV:-uv}"

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

# The scientific stack is shared by every run of this case. The interpreter must be
# a uv-managed Python, not the host's system interpreter: the runtime is the only
# trusted Python a submission may run under, and a uv-managed build keeps it
# reproducible and independent of distro upgrades.
command -v "$uv_bin" >/dev/null 2>&1 || {
  echo "uv is required to build the runtime (install uv or set ALEPH_UV)" >&2
  exit 1
}

runtime_is_uv_managed() {
  [ -x "$dest/runtime/bin/python" ] || return 1
  [ -f "$dest/runtime/pyvenv.cfg" ] || return 1
  grep -Eq '^home = .*/(uv/python|uv)/.*' "$dest/runtime/pyvenv.cfg"
}

build_runtime() {
  local tmp="$dest/runtime.new.$$"
  rm -rf "$tmp"
  echo "building uv-managed runtime (Python $python_version)"
  "$uv_bin" venv "$tmp" --managed-python --python "$python_version" >/dev/null
  "$uv_bin" pip install --python "$tmp/bin/python" \
    numpy pandas scipy scikit-learn lightgbm uv >/dev/null
  "$tmp/bin/python" - <<'PY'
import lightgbm, numpy, pandas, sklearn
print("runtime ok", numpy.__version__, pandas.__version__, sklearn.__version__, lightgbm.__version__)
PY
  rm -rf "$dest/runtime.old"
  [ -d "$dest/runtime" ] && mv "$dest/runtime" "$dest/runtime.old"
  mv "$tmp" "$dest/runtime"
  rm -rf "$dest/runtime.old"
  echo "built runtime: $dest/runtime"
}

if [ ! -x "$dest/runtime/bin/python" ]; then
  build_runtime
elif ! runtime_is_uv_managed; then
  echo "existing runtime is not uv-managed; rebuilding it" >&2
  build_runtime
else
  echo "uv-managed runtime already present: $dest/runtime"
  if [ ! -x "$dest/runtime/bin/uv" ]; then
    "$uv_bin" pip install --python "$dest/runtime/bin/python" uv >/dev/null
    echo "added uv to the runtime"
  fi
fi

"$dest/runtime/bin/python" - <<'PY'
import lightgbm, numpy, pandas, sklearn
print("runtime ok", numpy.__version__, pandas.__version__, sklearn.__version__, lightgbm.__version__)
PY
du -sh "$template" "$dest/runtime"
