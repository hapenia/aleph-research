# Research API smoke evidence (2026-11-02)

Branch `feat/phase-1-runtime`. This note records one end-to-end run of
`scripts/research-smoke.sh`: the compiled runtime is exercised through the DSH web host
mounted by the composition lab, and the Program/Issue are found in the `aleph_research`
storage medium on disk.

## Command and environment

```bash
timeout 420 ./scripts/research-smoke.sh research-api-0620
```

- Run root: `/tmp/aleph-runs/research-api-0620`
- Port: `39827` (the script let the kernel choose a free port and passed it to the lab)
- Lab mode: `ALEPH_SUPERAGENT_SMOKE=0`, so the lab started the host and settings but sent
  no worker research request
- Build: `npm run build` in `research-core/` before the lab; the lab builds it again
- Host tooling: `dsh` 0.2.1-rc.4 at `/usr/bin/dsh`

## Observed output

```text
run:       research-api-0620
run root:  /tmp/aleph-runs/research-api-0620
building research-core
PASS  research-core build                npm run build
port:      39827
starting lab
PASS  lab startup                        run.json at /tmp/aleph-runs/research-api-0620/run.json, port 39827
PASS  research health                    http=200 body={"ok":true,"version":"research-host/1","persistent":true}
PASS  program created                    http=201 id=program-request-1 status=running
PASS  issue created                      http=201 id=issue-request-2 status=open
PASS  program snapshot                   http=200 program=running issues=1 issueStatus=open audit=2 actions=program.created,issue.created
PASS  storage medium                     /tmp/aleph-runs/research-api-0620/dsh/storages/aleph_research.json
PASS  storage size                       bytes=3245 files=1
PASS  storage contains ids               program=program-request-1 issue=issue-request-2
snapshot:  program=running issues=1 issueStatus=open audit=2 actions=program.created,issue.created
PASS  cleanup host stopped               pid 1831245
PASS  cleanup no lab processes           none under /tmp/aleph-runs/research-api-0620
PASS  cleanup run dir removed            /tmp/aleph-runs/research-api-0620
research api smoke PASSED (12 checks)
run directory removed after evidence capture
```

## IDs and snapshot

| Item | Value |
| --- | --- |
| Program id | `program-request-1` |
| Program status | `running` |
| Issue id | `issue-request-2` |
| Issue status | `open` |
| Snapshot issues | 1 |
| Snapshot audit | 2 entries: `program.created`, `issue.created` |

The write path was `POST /aleph/api/research/requests` with
`{path:'/aleph/api/programs', actorKind:'operator', body:{...}}` for the Program and
`{path:'/aleph/api/programs/program-request-1/issues', ...}` for the Issue. Both returned
HTTP 201 and the runtime's `{ok:true,value,audit}` envelope. The snapshot came from
`GET /aleph/api/research/programs/program-request-1`.

## Storage evidence

The JSON backend wrote the domain as a single medium:

- Path: `<run>/dsh/storages/aleph_research.json`
- Size: 3245 bytes, one file
- Content: both `program-request-1` and `issue-request-2` are present in the medium

Persistence was therefore checked on disk, not only through the live host. The medium
path is recorded above even though the run directory was removed after evidence capture.

## Cleanup

The host PID from `host.pid` received `SIGTERM` and exited within the bounded wait. The
script then scanned `/proc/*/cwd` for processes under the run directory, killed any
remaining with bounded `SIGTERM`/`SIGKILL`, and confirmed none remained. With evidence
complete and no processes left, it removed the run directory and the lab log. A post-run
check confirmed both paths were absent and no process still had a cwd under the run root.

This change adds only `scripts/research-smoke.sh` and this note. No commit was made.
