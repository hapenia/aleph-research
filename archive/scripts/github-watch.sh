#!/usr/bin/env bash
# Report GitHub issues and pull requests that appeared since the last check.
#
#   scripts/github-watch.sh             # print new items and advance the cursor
#   scripts/github-watch.sh --peek      # print new items without advancing
#   scripts/github-watch.sh --reset     # forget the cursor
#
# The cursor is .github-watch.json at the repository root: the highest issue and
# pull-request number already seen. A watcher subagent runs this, triages what it
# prints, and reports. Everything here is read-only except the cursor file.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cursor="$repo_root/.github-watch.json"
mode="${1:-}"

if [ "$mode" = "--reset" ]; then
  rm -f "$cursor"
  echo "cursor reset"
  exit 0
fi

command -v gh >/dev/null 2>&1 || { echo "gh is not installed" >&2; exit 1; }

read_cursor() {
  if [ -f "$cursor" ]; then
    python3 - "$cursor" <<'PY'
import json, sys
try:
    data = json.load(open(sys.argv[1]))
except Exception:
    data = {}
print(data.get('issue', 0), data.get('pr', 0))
PY
  else
    echo "0 0"
  fi
}

read -r last_issue last_pr <<<"$(read_cursor)"

# Items this login authored are the repository's own workflow, not outside activity.
self_login="$(gh api user --jq .login 2>/dev/null || echo '')"

issues_json="$(gh issue list --state all --limit 100 --json number,title,state,author,updatedAt)"
prs_json="$(gh pr list --state all --limit 100 --json number,title,state,author,updatedAt)"

python3 - "$last_issue" "$last_pr" "$issues_json" "$prs_json" "$cursor" "$mode" "$self_login" <<'PY'
import json, sys

last_issue = int(sys.argv[1])
last_pr = int(sys.argv[2])
issues = json.loads(sys.argv[3] or '[]')
prs = json.loads(sys.argv[4] or '[]')
cursor_path = sys.argv[5]
peek = sys.argv[6] == '--peek'
self_login = sys.argv[7] if len(sys.argv) > 7 else ''

def authored_by_self(item):
    return self_login != '' and ((item.get('author') or {}).get('login') == self_login)

new_issues = sorted((i for i in issues if i['number'] > last_issue and not authored_by_self(i)), key=lambda i: i['number'])
new_prs = sorted((p for p in prs if p['number'] > last_pr and not authored_by_self(p)), key=lambda p: p['number'])

def line(item):
    author = (item.get('author') or {}).get('login', '?')
    return f"#{item['number']} [{item['state']}] {item['title']} (@{author})"

if not new_issues and not new_prs:
    print('no new GitHub activity')
else:
    for issue in new_issues:
        print('ISSUE', line(issue))
    for pr in new_prs:
        print('PR', line(pr))

if not peek:
    top_issue = max([last_issue] + [i['number'] for i in issues])
    top_pr = max([last_pr] + [p['number'] for p in prs])
    json.dump({'issue': top_issue, 'pr': top_pr}, open(cursor_path, 'w'), indent=2)
    open(cursor_path, 'a').write('\n')
PY
