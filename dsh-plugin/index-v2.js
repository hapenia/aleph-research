/**
 * AlephResearch Host plugin v2.
 *
 * Top-level state is a DSH project/workspace. Research work and mission
 * packaging live in separate git repositories; missions are proposed by
 * researchers, approved by the Leader, composed into machine-bound batches,
 * optimized and run by InfraOptimizer, and their results are cherry-picked
 * back to the pre-batch mission branch.
 */
import { execFile, execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chmod, cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const DOMAIN_NAME = 'aleph_project';
const HANDOFF_FILE = 'ALEPH_HANDOFF.md';
// Files that only carry repository bookkeeping; a merge conflict in these is resolved by the batch side.
const BOOKKEEPING_PATHS = new Set(['.gitignore', '.gitattributes', 'README.md']);

const missionSchema = z.object({
  id: z.string(),
  ownerSession: z.string().nullable(),
  branch: z.string(),
  manifestId: z.string().nullable().optional(),
  manifestPath: z.string().nullable().optional(),
  kind: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  status: z.enum(['proposed', 'approved', 'batched', 'running', 'done', 'failed']),
  entrypoint: z.string().nullable().optional(),
  outputs: z.array(z.unknown()).optional(),
  resource: z.unknown().nullable().optional(),
  batchId: z.string().nullable(),
  preBatchTip: z.string().nullable().optional(),
  resultCommit: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  createdAt: z.string(),
  approvedAt: z.string().nullable().optional(),
  finishedAt: z.string().nullable().optional(),
});

const batchSchema = z.object({
  id: z.string(),
  machineId: z.string(),
  status: z.enum(['forming', 'running', 'done', 'failed', 'interrupted', 'cancelled']),
  infra: z.any().optional(),
  missionIds: z.array(z.string()),
  branch: z.string(),
  baseTip: z.string().nullable().optional(),
  createdAt: z.string(),
  startedAt: z.string().nullable().optional(),
  finishedAt: z.string().nullable().optional(),
  summary: z.unknown().nullable().optional(),
});

const machineSchema = z.object({
  id: z.string(),
  kind: z.enum(['local']),
  status: z.enum(['idle', 'busy']),
  batchId: z.string().nullable(),
  // What the Composer believes is running, replaced as a whole like a todo list.
  loads: z.array(z.object({
    id: z.string(),
    kind: z.enum(['batch', 'mission', 'evaluation', 'other']),
    label: z.string().optional(),
    cpu: z.number().optional(),
    memGb: z.number().optional(),
    vramMb: z.number().optional(),
    startedAt: z.string().optional(),
  })).optional(),
  // Last observed telemetry, filled by the Host sampler.
  telemetry: z.any().optional(),
});

const projectSchema = z.object({
  id: z.string(),
  workspace: z.string(),
  researchRoot: z.string(),
  missionRoot: z.string(),
  templateBranch: z.string(),
  evalCommand: z.string(),
  evalRoot: z.string().nullable().optional(),
  conventions: z.string().nullable().optional(),
  brief: z.string().optional(),
  researcherCount: z.number().int().optional(),
  exploration: z.enum(['low', 'normal', 'high']).optional(),
  paused: z.boolean().optional(),
  pausedAt: z.string().nullable().optional(),
  dispatchSignature: z.string().nullable().optional(),
  pendingNotices: z.array(z.object({ sessionId: z.string(), text: z.string(), at: z.string() })).optional(),
  pendingDispatch: z.object({ at: z.string(), running: z.number().optional(), target: z.number().optional() }).nullable().optional(),
  bootstrap: z.object({
    status: z.enum(['pending', 'running', 'done', 'skipped']),
    childId: z.string().nullable().optional(),
    branch: z.string().nullable().optional(),
    instruction: z.string().nullable().optional(),
    startedAt: z.string().nullable().optional(),
    finishedAt: z.string().nullable().optional(),
    evaluatedCommit: z.string().nullable().optional(),
  }).nullable().optional(),
  prepared: z.boolean().optional(),
  pythonPath: z.string().nullable().optional(),
  visibleData: z.string().nullable().optional(),
  testsetPath: z.string().nullable().optional(),
  submissionPython: z.string().nullable().optional(),
  machines: z.array(machineSchema),
  agents: z.array(z.object({
    role: z.enum(['researcher', 'composer', 'infra']),
    childId: z.string().nullable(),
    status: z.enum(['running', 'done', 'failed', 'interrupted']),
    summary: z.string().nullable(),
    branch: z.string().nullable().optional(),
    worktree: z.string().nullable().optional(),
    updatedAt: z.string(),
  })).optional(),
  missions: z.array(missionSchema),
  batches: z.array(batchSchema),
  violations: z.array(z.string()).optional(),
  evaluations: z.array(z.any()).optional(),
  orchestratorSessionId: z.string().nullable().optional(),
  best: z.any().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const projectDomain = defineDomain({
  name: DOMAIN_NAME,
  version: 1,
  tables: { projects: domainTable(projectSchema) },
});

function now() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

async function run(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    timeout: options.timeout ?? 300_000,
    maxBuffer: 32 * 1024 * 1024,
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
  });
  return result;
}

async function git(repo, args, timeout = 120_000) {
  return run('git', ['-C', repo, ...args], { timeout });
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureRepo(path, branch, files) {
  if (!(await pathExists(join(path, '.git')))) {
    await mkdir(path, { recursive: true });
    await git(path, ['init', '-b', branch]);
    for (const [name, content] of Object.entries(files)) {
      await mkdir(join(path, name, '..'), { recursive: true });
      await writeFile(join(path, name), content, 'utf8');
    }
    await git(path, ['add', '-A']);
    await git(path, ['-c', 'user.name=AlephResearch', '-c', 'user.email=aleph@localhost', 'commit', '-m', 'initialize']);
  }
  return path;
}

function toolOutput() {
  return { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** Convert a value to something JSON can round-trip: no NaN, no Infinity, no undefined. */
function jsonSafe(value, seen = new Set()) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item, seen));
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = jsonSafe(item, seen);
  return out;
}

function tool(name, description, parameters, execute) {
  return defineTool({
    name,
    description,
    parameters,
    output: toolOutput(),
    execute: async (args, ctx) => jsonSafe(await execute(args, ctx)),
  });
}

const TEMPLATE_BATCH_RUNNER = `#!/usr/bin/env python3
import json, os, pathlib, subprocess, sys, time
root = pathlib.Path(__file__).resolve().parent
missions = root / "missions"
results = root / "results"
results.mkdir(exist_ok=True)
reports = []
for mission_dir in sorted(missions.glob("*/")):
    manifest_path = mission_dir / "mission.json"
    if not manifest_path.exists():
        continue
    manifest = json.loads(manifest_path.read_text())
    mission_id = manifest.get("id") or mission_dir.name
    # A resumed batch keeps the work it already finished.
    done_marker = results / mission_id / "result.json"
    if done_marker.exists():
        try:
            prior = json.loads(done_marker.read_text())
        except Exception:
            prior = {}
        if prior.get("status") == "done":
            reports.append({"mission_id": mission_id, "exit_code": 0, "status": "done", "resumed": True})
            continue
    entrypoint = manifest.get("entrypoint") or "run.sh"
    output_dir = results / mission_id
    output_dir.mkdir(parents=True, exist_ok=True)
    (results / "progress.json").write_text(json.dumps({
        "mission_id": mission_id, "phase": "running", "started_at": time.time(),
    }, ensure_ascii=False))
    env = dict(os.environ)
    env["ALEPH_MISSION_ID"] = mission_id
    env["ALEPH_OUTPUT_DIR"] = str(output_dir)
    # A mission reads the provided data through one stable path instead of guessing.
    visible = env.get("ALEPH_VISIBLE_DATA")
    if visible and os.path.isdir(visible):
        link = mission_dir / "data"
        try:
            if link.is_symlink() or link.exists():
                pass
            else:
                link.symlink_to(visible, target_is_directory=True)
        except OSError:
            pass
    log_path = output_dir / "run.log"
    with log_path.open("w", encoding="utf-8", errors="replace") as log:
        proc = subprocess.run(
            ["bash", str(mission_dir / entrypoint)],
            cwd=mission_dir, env=env, stdout=log, stderr=subprocess.STDOUT,
        )
    record = {
        "schema": 1,
        "mission_id": mission_id,
        "status": "done" if proc.returncode == 0 else "failed",
        "exit_code": proc.returncode,
        "artifacts": [str(log_path.relative_to(root))],
        "metrics": {},
        "logs": [str(log_path.relative_to(root))],
        "error": None if proc.returncode == 0 else f"mission entrypoint exited with {proc.returncode}; see {log_path.name}",
    }
    for name, key in (("result.json", None), ("metrics.json", "metrics")):
        candidate = output_dir / name
        if not candidate.exists():
            continue
        try:
            parsed = json.loads(candidate.read_text())
        except Exception:
            continue
        if key is None:
            record.update(parsed)
            record["mission_id"] = mission_id
            if proc.returncode == 0:
                record["status"] = "done"
                record["error"] = None
        else:
            record[key] = parsed
    (output_dir / "result.json").write_text(json.dumps(record, ensure_ascii=False, indent=2))
    (results / "progress.json").write_text(json.dumps({
        "mission_id": mission_id, "phase": "finished", "status": record["status"], "exit_code": proc.returncode,
    }, ensure_ascii=False))
    reports.append({"mission_id": mission_id, "exit_code": proc.returncode, "status": record["status"]})
(results / "batch.json").write_text(json.dumps({"missions": reports}, ensure_ascii=False))
print(json.dumps({"missions": reports}))
sys.exit(0 if all(item["exit_code"] == 0 for item in reports) else 1)
`;

function parseScore(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/).reverse();
  for (const line of lines) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    try {
      const value = JSON.parse(text);
      if (value && typeof value.score === 'number') return value;
    } catch {
      // Keep scanning.
    }
  }
  return null;
}

class ProjectService {
  constructor(ctx, domain, deps) {
    this.ctx = ctx;
    this.table = domain.table('projects');
    this.sessions = deps.sessions;
    this.subagents = deps.subagents;
    this.agentPresets = deps.agentPresets;
    this.sessionQuery = deps.sessionQuery;
    this.agentDefaultModel = deps.agentDefaultModel;
    this.writeChain = Promise.resolve();
  }

  list() {
    return [...this.table.entries()].map(([, project]) => project);
  }

  get(id) {
    return this.table.get(id);
  }

  byWorkspace(workspace) {
    return this.list().find((project) => project.workspace === resolve(workspace));
  }

  async mutate(id, update) {
    const op = async () => {
      const current = this.table.get(id);
      if (!current) throw new Error(`project not found: ${id}`);
      const next = { ...update(current), updatedAt: now() };
      await this.table.put(id, next);
      return next;
    };
    const queued = this.writeChain.then(op, op);
    this.writeChain = queued.catch(() => undefined);
    return queued;
  }

  sessionFor(agent) {
    return this.sessions?.get(agent?.id);
  }

  workspaceFor(agent, explicit) {
    if (typeof explicit === 'string' && explicit.trim()) return resolve(explicit.trim());
    const cwd = this.sessionFor(agent)?.header?.cwd;
    if (typeof cwd === 'string' && cwd) return resolve(cwd);
    throw new Error('workspace is required when the calling session has no cwd');
  }

  assertWorkspace(agent, workspace) {
    const root = this.sessionFor(agent)?.header?.cwd;
    if (typeof root !== 'string' || root === '') return;
    const target = resolve(workspace);
    const base = resolve(root);
    if (target !== base && !target.startsWith(`${base}/`)) {
      throw new Error(`project workspace ${target} is outside the DSH session workspace ${base}; open the project as the DSH workspace`);
    }
  }

  async init({ workspace, evalCommand, evalRoot, visibleData, testsetPath, submissionPython, pythonPath = null, researchers, brief, conventions, agent = null }) {
    const target = resolve(workspace);
    if (!(await pathExists(target))) throw new Error(`workspace does not exist: ${target}`);
    if (agent) this.assertWorkspace(agent, target);
    const existing = this.byWorkspace(target);
    if (existing) {
      // Re-initialising must not reset project settings that were not supplied.
      return this.mutate(existing.id, (current) => ({
        ...current,
        researcherCount: Number.isFinite(Number(researchers)) ? Number(researchers) : (current.researcherCount ?? 4),
        brief: brief ?? current.brief ?? '',
        evalCommand: evalCommand || current.evalCommand,
        evalRoot: evalRoot ? resolve(evalRoot) : current.evalRoot,
        visibleData: visibleData ? resolve(visibleData) : current.visibleData,
        testsetPath: testsetPath ? resolve(testsetPath) : current.testsetPath,
        submissionPython: submissionPython ?? current.submissionPython,
        pythonPath: pythonPath ? resolve(pythonPath) : (current.pythonPath ?? (submissionPython ? resolve(submissionPython) : null)),
        conventions: conventions ?? current.conventions ?? null,
      }));
    }
    const researchRoot = join(target, 'research');
    await ensureRepo(researchRoot, 'main', { 'README.md': '# Research repository\n' });
    const missionRoot = join(target, 'missions');
    const missionReadmeBase = [
      '# Mission repository template',
      '',
      'Each mission lives in `missions/<mission-id>/` and contains `mission.json` with',
      'its `id` and `entrypoint` plus whatever code the mission needs.',
      '',
      'Declare `kind` (`analysis` for a data question, `training` for a model run), a',
      'short `title` and a one-line `summary` of the question it answers. Those fields are',
      'how later researchers discover the result without running the work again.',
      '',
      'Training writes into `$ALEPH_OUTPUT_DIR`, which becomes `results/<mission-id>/`',
      'on the mission branch, so a finished mission result stays readable from its branch.',
      '',
      'The batch runner exports these variables to every mission and creates a `data`',
      'symlink in the mission directory:',
      '',
      '- `ALEPH_PYTHON`: the interpreter to run with; it already has the project runtime.',
      '- `ALEPH_OUTPUT_DIR`: where to write results, metrics and model files.',
      '- `ALEPH_VISIBLE_DATA`: the data directory the Leader provided, also reachable as `./data`.',
      '- `ALEPH_MISSION_ID`: this mission id.',
      '',
      'Do not copy the data into the mission; read it from the environment or `./data`.',
      '',
    ].join('\n');
    await ensureRepo(missionRoot, 'template', {
      'README.md': missionReadmeBase,
      'batch_runner.py': TEMPLATE_BATCH_RUNNER,
      'pyproject.toml': '[project]\nname = "aleph-missions"\nversion = "0.1.0"\nrequires-python = ">=3.10"\n',
      // A shared ignore list keeps missions from colliding on .gitignore and from committing bytecode.
      '.gitignore': '__pycache__/\n*.pyc\n.venv/\n.pytest_cache/\n',
    });
    await mkdir(join(target, '.aleph'), { recursive: true });
    const stamp = now();
    const project = {
      id: newId('p'),
      workspace: target,
      researchRoot,
      missionRoot,
      templateBranch: 'template',
      evalCommand: evalCommand || 'python3 eval/run_eval.py',
      evalRoot: evalRoot ? resolve(evalRoot) : null,
      conventions: conventions ?? null,
      brief: brief ?? '',
      researcherCount: Number.isFinite(Number(researchers)) ? Number(researchers) : 4,
      exploration: 'normal',
      prepared: false,
      visibleData: visibleData ? resolve(visibleData) : null,
      testsetPath: testsetPath ? resolve(testsetPath) : null,
      submissionPython: submissionPython || null,
      pythonPath: pythonPath ? resolve(pythonPath) : (submissionPython ? resolve(submissionPython) : null),
      machines: [{ id: 'local', kind: 'local', status: 'idle', batchId: null }],
      agents: [],
      missions: [],
      batches: [],
      violations: [],
      createdAt: stamp,
      updatedAt: stamp,
    };
    await this.table.put(project.id, project);
    // The Composer is part of the project from the start: it is the Leader's direct child and
    // the queue owner, so it must exist before the first proposal rather than appear on demand.
    if (agent) {
      await this.ensureComposer({ projectId: project.id, agent }).catch(() => undefined);
    }
    return this.get(project.id) ?? project;
  }

  /** Point a research branch at the best evaluated commit, so a later iteration starts from it. */
  /** Stop dispatching new work; running work is left to finish. */
  async pauseProject({ projectId, reason = null }) {
    const project = this.get(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    const next = await this.mutate(projectId, (current) => ({ ...current, paused: true, pausedAt: now(), pauseReason: reason ?? null }));
    await this.notifyComposer({ projectId, agent: null, event: 'project paused', detail: reason ?? 'paused by the operator' }).catch(() => undefined);
    return { projectId, paused: true, runningBatches: (next.batches ?? []).filter((batch) => batch.status === 'running').length };
  }

  async resumeProject({ projectId }) {
    const project = this.get(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    await this.mutate(projectId, (current) => ({ ...current, paused: false, pausedAt: null, pauseReason: null }));
    await this.notifyComposer({ projectId, agent: null, event: 'project resumed', detail: 'dispatch may continue' }).catch(() => undefined);
    return { projectId, paused: false };
  }

  /** Stop one batch: kill its runner tree, release the machine and mark its missions cancelled. */
  async cancelBatch({ projectId, batchId, reason = 'cancelled by the operator' }) {
    const project = this.get(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    const batch = (project.batches ?? []).find((item) => item.id === batchId);
    if (!batch) throw new Error(`batch not found: ${batchId}`);
    if (['done', 'failed', 'cancelled'].includes(batch.status)) throw new Error(`batch ${batchId} is already ${batch.status}`);
    const worktree = join(project.workspace, '.aleph', 'batches', batchId);
    const killed = this.killUnder(worktree);
    await git(project.missionRoot, ['worktree', 'remove', '--force', worktree]).catch(() => undefined);
    await rm(worktree, { recursive: true, force: true }).catch(() => undefined);
    this.runningBatches?.delete?.(batchId);
    const updated = await this.mutate(projectId, (current) => ({
      ...current,
      machines: current.machines.map((machine) => {
        const loads = (machine.loads ?? []).filter((entry) => entry.id !== batchId);
        if (machine.batchId !== batchId) return machine;
        return { ...machine, status: loads.length === 0 ? 'idle' : 'busy', batchId: loads.length === 0 ? null : machine.batchId, loads, telemetry: this.sampleTelemetry() };
      }),
      batches: current.batches.map((item) => (item.id === batchId
        ? { ...item, status: 'cancelled', finishedAt: now(), summary: { ...(item.summary ?? {}), cancelled: reason, killed } }
        : item)),
      missions: current.missions.map((mission) => (mission.batchId === batchId && ['batched', 'running', 'approved'].includes(mission.status)
        ? { ...mission, status: 'cancelled', error: reason, finishedAt: now() }
        : mission)),
    }));
    await this.notifyComposer({ projectId, agent: null, event: 'batch cancelled', detail: `${batchId}: ${reason} (${killed} process(es) stopped)` }).catch(() => undefined);
    return { projectId, batchId, cancelled: true, killed, machine: updated.machines.find((machine) => machine.id === batch.machineId) ?? null };
  }

  async selectBest({ projectId, branch = 'main' }) {
    const project = this.get(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    const best = project.best;
    if (!best?.commit) throw new Error('no evaluated best result yet');
    const ref = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
    const current = (await git(project.researchRoot, ['rev-parse', '--verify', ref]).catch(() => ({ stdout: '' }))).stdout.trim();
    if (!current) throw new Error(`research branch not found: ${branch}`);
    // A checked-out branch must keep matching its worktree, so refuse instead of moving the ref.
    const checkedOut = (await git(project.researchRoot, ['worktree', 'list', '--porcelain'])).stdout
      .split(/\r?\n/)
      .some((line) => line.trim() === `branch ${ref}` || line.trim() === `branch ${branch}`);
    if (checkedOut) throw new Error(`cannot move ${branch}: it is checked out in a worktree; ask the researcher to stop or use a different branch`);
    await git(project.researchRoot, ['update-ref', '-m', `select best ${best.commit}`, ref, best.commit, current]);
    return { projectId, branch, commit: best.commit, score: best.score, previous: current };
  }

  async setPython({ projectId, pythonPath }) {
    if (!pythonPath) throw new Error('python path is required');
    const resolved = resolve(pythonPath);
    if (!(await pathExists(resolved))) throw new Error(`python path does not exist: ${resolved}`);
    await this.mutate(projectId, (current) => ({ ...current, pythonPath: resolved }));
    return { projectId, pythonPath: resolved };
  }

  async scaffoldResearch({ projectId, title = 'Research project', dataSources = [], pythonPath = null, conventions = null, agent = null, instruction = null }) {
    const project = this.get(projectId);
    await this.rememberOrchestrator(projectId, agent);
    if (!project) throw new Error(`project not found: ${projectId}`);
    const root = project.researchRoot;
    const conventionsSection = project.conventions ? `\n## Project conventions\n\n${project.conventions}\n` : '';
    await writeFile(join(root, 'README.md'), `# ${title}\n\n${project.brief || ''}\n\n## Provided data\n\nThe data the Leader selected for researchers is under data/ in this worktree.\n${conventionsSection}`, 'utf8');
    await writeFile(join(root, 'pyproject.toml'), '[project]\nname = "aleph-research"\nversion = "0.1.0"\nrequires-python = ">=3.10"\n', 'utf8');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', '__init__.py'), '', 'utf8');
    await writeFile(join(root, '.gitignore'), '__pycache__/\n*.pyc\n.venv/\n', 'utf8');
    // The project records which data the operator offers; the Leader still decides what to hand over.
    const offered = Array.isArray(dataSources) ? dataSources.filter((path) => typeof path === 'string' && path.trim()) : [];
    const toCopy = offered.length > 0 ? offered : (project.visibleData ? [project.visibleData] : []);
    let visibleData = null;
    if (toCopy.length > 0) {
      const dataRoot = join(root, 'data');
      await mkdir(dataRoot, { recursive: true });
      for (const source of toCopy) {
        const resolved = resolve(source);
        if (!(await pathExists(resolved))) throw new Error(`provided data path does not exist: ${resolved}`);
        await cp(resolved, dataRoot, { recursive: true });
      }
      visibleData = dataRoot;
    }
    await git(root, ['add', '-A']);
    // Re-scaffolding an unchanged project must stay idempotent.
    await git(root, ['-c', 'user.name=AlephResearch', '-c', 'user.email=aleph@localhost', 'commit', '--allow-empty', '-m', 'leader: research project scaffold']);
    const commit = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
    const next = await this.mutate(projectId, (current) => ({ ...current, prepared: true, ...(conventions !== null ? { conventions } : {}), ...(visibleData ? { visibleData } : {}), ...(pythonPath ? { pythonPath: resolve(pythonPath) } : {}) }));
    // The Composer is the Leader's direct child and must exist before work is queued.
    await this.ensureComposer({ projectId, agent }).catch(() => undefined);
    // Preparing a project is when the loop starts; the cohort must not wait for a second call.
    let cohort = null;
    const running = (next.agents ?? []).filter((item) => item.role === 'researcher' && item.status === 'running').length;
    if (agent && running === 0) {
      cohort = await this.startBootstrap({ projectId, agent, instruction }).catch((error) => ({ error: String(error?.message ?? error) }));
    }
    return { projectId, commit, prepared: next.prepared, visibleData: next.visibleData, cohort };
  }

  async removeMissionWorktree(project, branch) {
    const text = (await git(project.missionRoot, ['worktree', 'list', '--porcelain'])).stdout;
    let current = null;
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) current = { path: line.slice(9) };
      else if (current && line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//, '');
      else if (!line.trim() && current) {
        if (current.branch === branch) await git(project.missionRoot, ['worktree', 'remove', '--force', current.path]).catch(() => undefined);
        current = null;
      }
    }
  }

  /** One call that leaves a valid mission behind: metadata, entrypoint, code stub and project file. */
  async createMission({
    projectId,
    name = 'mission',
    kind = 'analysis',
    title = null,
    summary = null,
    entrypoint = 'run.sh',
    dependencies = [],
    agent = null,
  }) {
    const project = this.get(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    if (!['analysis', 'training', 'other'].includes(kind)) throw new Error(`unknown mission kind: ${kind}`);
    const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'mission';
    const branch = `missions/${slug}-${randomUUID().slice(0, 8)}`;
    const worktree = join(project.workspace, '.aleph', 'missions', newId('mw'));
    await mkdir(join(project.workspace, '.aleph', 'missions'), { recursive: true });
    await git(project.missionRoot, ['worktree', 'add', '-b', branch, worktree, project.templateBranch]);
    const missionDir = join(worktree, 'missions', slug);
    await mkdir(missionDir, { recursive: true });
    await writeFile(join(missionDir, 'mission.json'), JSON.stringify({
      id: slug,
      entrypoint,
      kind,
      title: title ?? slug,
      summary: summary ?? '',
      outputs: [],
    }, null, 2), 'utf8');
    // The stub is already a working entrypoint: correct interpreter, correct directory, fails loudly.
    await writeFile(join(missionDir, 'run.sh'), '#!/usr/bin/env bash\nset -euo pipefail\ncd "$(dirname "$0")"\nif [ ! -f main.py ]; then echo "mission has no main.py yet" >&2; exit 1; fi\nexec "${ALEPH_PYTHON:-python3}" main.py "$@"\n', 'utf8');
    await writeFile(join(missionDir, 'main.py'), 'def main() -> int:\n    raise SystemExit("replace main.py with the mission implementation")\n\n\nif __name__ == "__main__":\n    raise SystemExit(main())\n', 'utf8');
    const dependencyList = (Array.isArray(dependencies) ? dependencies : []).filter((item) => typeof item === 'string' && item.trim());
    await writeFile(join(missionDir, 'pyproject.toml'), [
      '[project]',
      `name = "${slug}"`,
      'version = "0.1.0"',
      'requires-python = ">=3.10"',
      'dependencies = [',
      ...dependencyList.map((item) => `  "${item}",`),
      ']',
      '',
    ].join('\n'), 'utf8');
    await writeFile(join(missionDir, 'README.md'), `# ${slug}\n\n${title ?? ''}\n\n${summary ?? ''}\n`, 'utf8');
    // Git records the executable bit; committing it here removes a whole class of "permission denied" failures.
    await chmod(join(missionDir, 'run.sh'), 0o755).catch(() => undefined);
    await git(worktree, ['add', '-A']);
    await git(worktree, ['-c', 'user.name=AlephResearch', '-c', 'user.email=aleph@localhost', 'commit', '-m', `mission ${slug}: metadata, entrypoint and project`]);
    return { projectId, branch, worktree, missionId: slug, missionDir, entrypoint, kind, title: title ?? slug, dependencies: dependencyList };
  }

  async startMission({ projectId, name = 'mission' }) {
    return this.createMission({ projectId, name });
  }

  /** Every mission with the fields a researcher needs to reuse its result. */
  async listMissions({ projectId }) {
    const project = this.get(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    const sorted = [...(project.missions ?? [])].sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
    return sorted.map((mission) => ({
      id: mission.id,
      status: mission.status,
      kind: mission.kind ?? null,
      title: mission.title ?? mission.manifestId ?? null,
      summary: mission.summary ?? null,
      branch: mission.branch,
      ownerSession: mission.ownerSession,
      resultCommit: mission.resultCommit,
      resultPath: mission.manifestId ? `results/${mission.manifestId}/` : null,
      error: mission.error,
    }));
  }

  /** Copy a finished mission's code and results into a research worktree. */
  async adoptMission({ projectId, missionId, agent, dir = null }) {
    const project = this.get(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    const mission = project.missions.find((item) => item.id === missionId);
    if (!mission) throw new Error(`mission not found: ${missionId}`);
    const record = (project.agents ?? []).find((item) => item.role === 'researcher' && item.childId === (agent?.id ?? null) && item.worktree);
    const worktree = record?.worktree;
    if (!worktree || !(await pathExists(worktree))) throw new Error('a researcher worktree is required to adopt a mission');
    const missionDir = mission.manifestPath ? mission.manifestPath.split('/')[1] : null;
    if (!missionDir) throw new Error('mission has no manifest path recorded');
    const target = join(worktree, dir ?? 'adopted', missionId);
    await mkdir(target, { recursive: true });
    const paths = [`missions/${missionDir}`];
    if (mission.manifestId) paths.push(`results/${mission.manifestId}`);
    const archive = await new Promise((resolve, reject) => {
      const child = execFile('git', ['-C', project.missionRoot, 'archive', '--format=tar', mission.branch, ...paths], { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 }, (error, stdout) => {
        if (error) reject(error); else resolve(stdout);
      });
      child.stdin?.end?.();
    });
    await new Promise((resolve, reject) => {
      const untar = execFile('tar', ['-x', '-C', target], { encoding: 'buffer' }, (error) => (error ? reject(error) : resolve()));
      untar.stdin.end(archive);
    });
    const listing = [];
    for (const path of paths) {
      const base = join(target, path);
      if (!(await pathExists(base))) continue;
      for (const entry of await readdir(base).catch(() => [])) listing.push(`${path}/${entry}`);
    }
    return {
      projectId, missionId, branch: mission.branch, target,
      missionDir: join(target, 'missions', missionDir),
      resultsDir: mission.manifestId ? join(target, 'results', mission.manifestId) : null,
      files: listing,
      hint: 'The copied files are a working reference: reuse whatever is useful, adapt it in your own branch, commit, then call aleph_evaluate.',
    };
  }

  async propose({ projectId, branch, agent }) {
    const project = this.get(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    const branchExists = await git(project.missionRoot, ['rev-parse', '--verify', branch]).then(() => true).catch(() => false);
    if (!branchExists) throw new Error(`mission branch not found: ${branch}`);
    const ancestor = await git(project.missionRoot, ['merge-base', '--is-ancestor', project.templateBranch, branch]).then(() => true).catch(() => false);
    if (!ancestor) throw new Error(`mission branch ${branch} is not derived from ${project.templateBranch}`);
    // Collect every problem at once: a researcher should not rediscover them one call at a time.
    const problems = [];
    const files = (await git(project.missionRoot, ['ls-tree', '-r', '--name-only', branch])).stdout.split(/\r?\n/).filter(Boolean);
    const manifestPath = files.find((path) => /^missions\/[^/]+\/mission\.json$/.test(path));
    let manifest = null;
    if (!manifestPath) {
      problems.push('no missions/<id>/mission.json on the branch');
    } else {
      try {
        manifest = JSON.parse((await git(project.missionRoot, ['show', `${branch}:${manifestPath}`])).stdout);
        manifest.__manifestPath = manifestPath;
      } catch (error) {
        problems.push(`mission.json is not valid JSON: ${error instanceof Error ? error.message.split('\n')[0] : error}`);
      }
    }
    if (manifest) {
      for (const key of ['id', 'entrypoint', 'kind', 'title', 'summary']) {
        const value = manifest[key];
        if (typeof value !== 'string' || value.trim() === '') problems.push(`mission.json is missing "${key}"`);
      }
      if (typeof manifest.entrypoint === 'string' && manifest.entrypoint.trim()) {
        const entryPath = `${manifest.__manifestPath.split('/').slice(0, 2).join('/')}/${manifest.entrypoint}`;
        const entryRow = (await git(project.missionRoot, ['ls-tree', branch, entryPath])).stdout.trim();
        // The runner invokes the entrypoint through bash, so the executable bit is not required.
        if (!entryRow) problems.push(`entrypoint ${entryPath} does not exist on the branch`);
      }
    }
    if (problems.length > 0) {
      throw new Error(`mission branch ${branch} is not proposable:\n- ${problems.join('\n- ')}\nCall aleph_create_mission for a valid scaffold, or fix these and propose again.`);
    }
    const existingMission = (project.missions ?? []).find((mission) => mission.branch === branch);
    if (existingMission) return { projectId, missions: project.missions };
    const ownerSession = agent?.id ?? null;
    const registered = await this.mutate(projectId, (current) => ({
      ...current,
      missions: [...current.missions, {
        id: newId('m'),
        ownerSession,
        branch,
        manifestId: manifest.id ?? manifest.__manifestPath.split('/')[1],
        manifestPath: manifest.__manifestPath,
        kind: typeof manifest.kind === 'string' ? manifest.kind : null,
        title: typeof manifest.title === 'string' ? manifest.title : null,
        summary: typeof manifest.summary === 'string' ? manifest.summary : null,
        status: 'approved',
        entrypoint: manifest.entrypoint ?? null,
        outputs: Array.isArray(manifest.outputs) ? manifest.outputs : [],
        resource: manifest.resource ?? null,
        batchId: null,
        preBatchTip: null,
        resultCommit: null,
        error: null,
        createdAt: now(),
        approvedAt: now(),
        finishedAt: null,
      }],
    }));
    await this.removeMissionWorktree(project, branch);
    const created = registered.missions[registered.missions.length - 1];
    // A proposal enters the dispatch queue directly, so the Composer has to hear about it.
    await this.notifyComposer({
      projectId,
      agent,
      event: 'mission queued',
      detail: created ? `${created.manifestId ?? created.id} on ${created.branch}` : branch,
    }).catch(() => undefined);
    const orchestrator = this.get(projectId)?.orchestratorSessionId ?? null;
    if (orchestrator && created) {
      this.notifySession({
        sessionId: orchestrator,
        text: `Mission ${created.manifestId ?? created.id} entered the queue from branch ${created.branch}; the Composer dispatches it. Review the research direction only if the brief changed.`,
      }).catch(() => undefined);
    }
    return registered;
  }

  /** Progress the batch runner publishes while it works, so the console is not blind mid-run. */
  liveProgress(project) {
    const out = {};
    for (const batch of project.batches ?? []) {
      if (batch.status !== 'running') continue;
      const file = join(project.workspace, '.aleph', 'batches', batch.id, 'results', 'progress.json');
      try {
        out[batch.id] = JSON.parse(readFileSync(file, 'utf8'));
      } catch { /* the runner has not published yet */ }
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  /** How many researchers an exploration level keeps alive. */
  explorationTarget(project) {
    const size = project.researcherCount ?? 4;
    const level = project.exploration ?? 'normal';
    if (level === 'high') return size;
    if (level === 'normal') return Math.max(1, Math.ceil(size / 2));
    return 0;
  }

  async setExploration({ projectId, level }) {
    if (!['low', 'normal', 'high'].includes(level)) throw new Error(`unknown exploration level: ${level}`);
    await this.mutate(projectId, (current) => ({ ...current, exploration: level }));
    const dispatched = await this.maybeDispatchReplacement({ projectId }).catch(() => null);
    const project = this.get(projectId);
    return {
      projectId,
      exploration: level,
      target: this.explorationTarget(project),
      running: (project.agents ?? []).filter((item) => item.role === 'researcher' && item.status === 'running').length,
      dispatched,
    };
  }

  /**
   * A researcher finishing is the moment to decide whether exploration continues.
   * The level, not the caller, decides how many researchers stay alive.
   */
  async maybeDispatchReplacement({ projectId }) {
    const project = this.get(projectId);
    if (!project) return { dispatched: false, reason: 'no project' };
    if (project.bootstrap?.status === 'running') return { dispatched: false, reason: 'the opening researcher owns the project' };
    const running = (project.agents ?? []).filter((item) => item.role === 'researcher' && item.status === 'running').length;
    const waiting = (project.agents ?? []).filter((item) => item.role === 'researcher' && item.status === 'interrupted').length;
    const target = this.explorationTarget(project);
    // Sessions waiting to be resumed are not dead; replacing them would duplicate their work.
    if (running + waiting >= target) return { dispatched: false, running, waiting, target, reason: 'interrupted researchers are waiting to resume' };
    const parent = this.liveOrchestrator(project) ?? await this.reviveOrchestrator(project).catch(() => null);
    if (!parent) {
      // The Leader session can be cold while the cohort drains; retry from the watchdog.
      await this.mutate(projectId, (current) => ({ ...current, pendingDispatch: { at: now(), running, target } })).catch(() => undefined);
      return { dispatched: false, running, target, reason: 'no live orchestrator session to dispatch from' };
    }
    const started = await this.startResearcher({ projectId, agent: parent });
    return { dispatched: true, running: running + 1, target, childId: started.childId, branch: started.branch };
  }

  /** Observed machine capacity and current pressure. Cheap enough to sample on demand. */
  sampleTelemetry() {
    const read = (path, fallback) => { try { return readFileSync(path, 'utf8'); } catch { return fallback; } };
    const load = read('/proc/loadavg', '0 0 0').trim().split(/\s+/).map(Number);
    const mem = {};
    for (const line of read('/proc/meminfo', '').split('\n')) {
      const match = /^(\w+):\s+(\d+) kB/.exec(line);
      if (match) mem[match[1]] = Number(match[2]) * 1024;
    }
    let gpus = [];
    try {
      const query = execFileSync('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 2000 });
      gpus = query.trim().split('\n').filter(Boolean).map((line) => {
        const [name, util, used, total] = line.split(',').map((part) => part.trim());
        const finite = (text) => (Number.isFinite(Number(text)) ? Number(text) : null);
        return { name, utilization: finite(util), memoryUsedMb: finite(used), memoryTotalMb: finite(total) };
      });
    } catch { gpus = []; }
    return {
      sampledAt: now(),
      cores: os.cpus().length,
      load1: load[0] ?? 0,
      load5: load[1] ?? 0,
      load15: load[2] ?? 0,
      cpuUtilization: Math.min(1, (load[0] ?? 0) / Math.max(1, os.cpus().length)),
      memTotalGb: Number((mem.MemTotal / 1e9).toFixed(2)) || null,
      memAvailableGb: Number((mem.MemAvailable / 1e9).toFixed(2)) || null,
      gpus,
    };
  }

  /** Replace the machine load list, exactly like writing a todo list. */
  async setMachineLoad({ projectId, machineId = 'local', loads = [] }) {
    const project = this.get(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    const machine = project.machines.find((item) => item.id === machineId);
    if (!machine) throw new Error(`machine not found: ${machineId}`);
    const clean = (Array.isArray(loads) ? loads : []).map((entry, index) => ({
      id: String(entry?.id ?? `load-${index}`),
      kind: ['batch', 'mission', 'evaluation', 'other'].includes(entry?.kind) ? entry.kind : 'other',
      label: entry?.label ? String(entry.label).slice(0, 200) : undefined,
      cpu: Number.isFinite(Number(entry?.cpu)) ? Number(entry.cpu) : undefined,
      memGb: Number.isFinite(Number(entry?.memGb)) ? Number(entry.memGb) : undefined,
      vramMb: Number.isFinite(Number(entry?.vramMb)) ? Number(entry.vramMb) : undefined,
      startedAt: typeof entry?.startedAt === 'string' ? entry.startedAt : now(),
    }));
    const next = await this.mutate(projectId, (current) => ({
      ...current,
      machines: current.machines.map((item) => (item.id === machineId
        ? { ...item, loads: clean, status: clean.length === 0 ? 'idle' : 'busy', telemetry: this.sampleTelemetry() }
        : item)),
    }));
    return { projectId, machineId, loads: clean, status: clean.length === 0 ? 'idle' : 'busy', telemetry: next.machines.find((item) => item.id === machineId)?.telemetry ?? null };
  }

  /**
   * Remember the Leader session that drives this project. Only the Leader may own this
   * role: a researcher creating a mission used to overwrite it, after which the Host
   * tried to spawn replacements from a dead researcher session and the loop stopped.
   */
  async rememberOrchestrator(projectId, agent) {
    if (!agent?.id) return;
    if (this.presetOfAgent && this.presetOfAgent(agent) !== 'aleph') return;
    const project = this.get(projectId);
    if (!project) return;
    const storedIsLeader = (() => {
      if (!project.orchestratorSessionId) return false;
      const session = this.sessions?.get?.(project.orchestratorSessionId);
      const preset = session && this.agentPresets?.presetForSession ? this.agentPresets.presetForSession(session) : null;
      return preset === 'aleph';
    })();
    // A stored id that is not a Leader session is corruption from an older build; replace it.
    if (project.orchestratorSessionId && project.orchestratorSessionId !== agent.id && !storedIsLeader) {
      await this.mutate(projectId, (current) => ({ ...current, orchestratorSessionId: agent.id })).catch(() => undefined);
      return;
    }
    if (project.orchestratorSessionId === agent.id) return;
    await this.mutate(projectId, (current) => ({ ...current, orchestratorSessionId: agent.id })).catch(() => undefined);
  }

  /**
   * Deliver a notice to a child session, or park it until its parent is live again.
   * A researcher that ends its turn must still learn that its mission settled.
   */
  async deliverOrQueue({ projectId, sessionId, text }) {
    const sent = await this.notifySession({ sessionId, text }).catch(() => ({ delivered: false }));
    if (sent?.delivered) return { delivered: true };
    const project = this.get(projectId);
    const queued = project?.pendingNotices ?? [];
    if (queued.some((entry) => entry.sessionId === sessionId && entry.text === text)) return { delivered: false, queued: true };
    await this.mutate(projectId, (current) => ({
      ...current,
      pendingNotices: [...(current.pendingNotices ?? []), { sessionId, text, at: now() }].slice(-50),
    })).catch(() => undefined);
    return { delivered: false, queued: true };
  }

  /** Retry parked notices once their parent session is available. */
  async flushPendingNotices(project) {
    const queued = project.pendingNotices ?? [];
    if (queued.length === 0) return 0;
    let delivered = 0;
    const remaining = [];
    for (const entry of queued) {
      const sent = await this.notifySession({ sessionId: entry.sessionId, text: entry.text }).catch(() => ({ delivered: false }));
      if (sent?.delivered) delivered += 1;
      else if (Date.now() - Date.parse(entry.at) < 6 * 60 * 60 * 1000) remaining.push(entry);
    }
    if (delivered > 0 || remaining.length !== queued.length) {
      await this.mutate(project.id, (current) => ({ ...current, pendingNotices: remaining })).catch(() => undefined);
    }
    return delivered;
  }

  /**
   * Bring the Leader session back to life when it is cold.
   *
   * A subagent can only be woken or cold-resumed through a live direct parent, so once
   * the browser session that drives the project is gone, the queue owner and its
   * researchers become unreachable. Resuming the recorded Leader session restores the
   * whole tree without inventing a second owner.
   */
  async reviveOrchestrator(project) {
    const sessionId = project?.orchestratorSessionId;
    if (!sessionId) return null;
    const live = this.ctx?.agents?.get?.(sessionId);
    if (live) return live;
    this.revives ??= new Map();
    const last = this.revives.get(sessionId) ?? 0;
    if (Date.now() - last < 60_000) return null;
    this.revives.set(sessionId, Date.now());
    const sessions = this.sessionQuery;
    const presets = this.agentPresets;
    try {
      const observation = await sessions?.observeSession?.(sessionId);
      if (!observation) return null;
      const presetId = observation.projections?.values?.agentPreset ?? 'aleph';
      const resolved = presets ? (await presets.resolve(presetId)).id : presetId;
      const selection = this.agentDefaultModel?.currentSelection?.() ?? {};
      const resumed = await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: { ...(selection.provider ? { provider: selection.provider } : {}), ...(selection.model ? { model: selection.model } : {}) },
        setup: async (agentCtx, agent) => {
          if (presets && resolved) await presets.mount(agentCtx, resolved);
        },
      });
      return resumed?.agent ?? null;
    } catch (error) {
      console.warn(`[aleph] could not revive session ${sessionId}: ${String(error?.message ?? error)}`);
      return null;
    }
  }

  /** A live Agent that may parent subagents, or null when the owning session is gone. */
  liveOrchestrator(project) {
    if (!project?.orchestratorSessionId) return null;
    const revived = this.ctx?.agents?.get?.(project.orchestratorSessionId);
    if (revived && !(this.presetOfAgent && this.presetOfAgent(revived) !== 'aleph')) return revived;
    const agent = this.ctx?.agents?.get?.(project.orchestratorSessionId) ?? null;
    if (!agent) return null;
    // A session that is not the Leader must never parent the cohort.
    if (this.presetOfAgent && this.presetOfAgent(agent) !== 'aleph') return null;
    return agent;
  }

  /** Kill processes that carry a marker in their environment, including grandchildren. */
  killByEnvMarker(marker) {
    if (!marker) return 0;
    let killed = 0;
    let entries = [];
    try { entries = readdirSync('/proc'); } catch { return killed; }
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (pid === process.pid) continue;
      let environ = '';
      try { environ = readFileSync(`/proc/${entry}/environ`).toString('utf8'); } catch { continue; }
      if (!environ.includes(marker)) continue;
      try { process.kill(pid, 'SIGKILL'); killed += 1; } catch { /* already gone */ }
    }
    return killed;
  }

  killUnder(rootPath) {
    const root = resolve(rootPath);
    let killed = 0;
    let entries = [];
    try { entries = readdirSync('/proc'); } catch { return killed; }
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (pid === process.pid) continue;
      let cwd = '';
      try { cwd = readlinkSync(`/proc/${entry}/cwd`); } catch { continue; }
      if (cwd === root || cwd.startsWith(`${root}/`)) {
        try { process.kill(pid, 'SIGKILL'); killed += 1; } catch { /* already gone */ }
      }
    }
    return killed;
  }

  /** Dependency names declared by a mission pyproject. */
  async declaredDependencies(manifestPath) {
    try {
      const text = await readFile(manifestPath, 'utf8');
      const match = /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(text);
      if (!match) return [];
      return [...match[1].matchAll(/"([^"]+)"/g)]
        .map((entry) => entry[1])
        .map((spec) => spec.split(/[<>=!~;\[]/)[0].trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Which of those distributions the shared interpreter cannot already import. */
  async missingDependencies(project, names) {
    if (names.length === 0) return [];
    const python = project.pythonPath;
    if (!python) return names;
    const probe = `import importlib.metadata as m, sys\nmissing=[]\nfor name in ${JSON.stringify(names)}:\n    try: m.version(name)\n    except Exception: missing.append(name)\nprint(' '.join(missing))`;
    try {
      const { stdout } = await run(python, ['-c', probe], { timeout: 30_000 });
      return stdout.trim().split(/\s+/).filter(Boolean);
    } catch {
      return names;
    }
  }

  async prepareBatchRuntime({ project, batch, missionRecords, batchWorktree }) {
    const cores = Math.max(1, Number(os.cpus().length) || 1);
    // One mission runs at a time, so it may use most of the machine without starving the desktop.
    const threads = Math.max(1, Math.min(cores - 2, 16));
    const uvCache = join(batchWorktree, '.uv-cache');
    const timeoutMs = Number(process.env.ALEPH_BATCH_TIMEOUT_MS) > 0
      ? Number(process.env.ALEPH_BATCH_TIMEOUT_MS)
      : 6 * 60 * 60 * 1000;
    const env = {
      ALEPH_THREADS: String(threads),
      OMP_NUM_THREADS: String(threads),
      OPENBLAS_NUM_THREADS: String(threads),
      MKL_NUM_THREADS: String(threads),
      NUMEXPR_NUM_THREADS: String(threads),
      UV_CACHE_DIR: uvCache,
      UV_PYTHON_DOWNLOADS: 'never',
    };
    const prepared = [];
    for (const mission of missionRecords) {
      const dir = mission.manifestPath ? join(batchWorktree, mission.manifestPath.split('/').slice(0, 2).join('/')) : null;
      if (!dir) continue;
      const manifest = join(dir, 'pyproject.toml');
      if (!(await pathExists(manifest))) { prepared.push({ mission: mission.id, status: 'no-pyproject' }); continue; }
      // Never build a mission-local environment the shared runtime already satisfies: a partial
      // .venv is worse than none, because mission entrypoints prefer it.
      const needed = await this.declaredDependencies(manifest);
      const missing = await this.missingDependencies(project, needed);
      if (missing.length === 0) {
        prepared.push({ mission: mission.id, status: 'satisfied-by-runtime', dependencies: needed.length });
        continue;
      }
      try {
        await run('uv', ['sync', '--quiet', '--project', dir], { cwd: batchWorktree, env, timeout: 300_000 });
        prepared.push({ mission: mission.id, status: 'synced', missing });
      } catch (error) {
        // A failed sync leaves a half-built venv that would shadow the runtime, so remove it.
        await rm(join(dir, '.venv'), { recursive: true, force: true }).catch(() => undefined);
        prepared.push({ mission: mission.id, status: 'sync-failed', missing, error: String(error?.message ?? error).slice(0, 400) });
      }
    }
    const infra = { cores, threads, missions: prepared, runner: project.pythonPath ?? 'python3', timeout_ms: timeoutMs };
    await writeFile(join(batchWorktree, 'infra.json'), JSON.stringify(infra, null, 2), 'utf8').catch(() => undefined);
    return { ...infra, env };
  }

  /**
   * Start a batch and return at once. An agent that awaits compute holds its own turn for
   * hours and cannot keep managing the queue, so agent-facing tools use this, while the
   * operator route still awaits runBatch for scripted use.
   */
  startBatch({ projectId, batchId }) {
    const project = this.get(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    const batch = project.batches.find((item) => item.id === batchId);
    if (!batch) throw new Error(`batch not found: ${batchId}`);
    if (project.paused) throw new Error('project is paused; resume it before starting work');
    if (batch.status !== 'forming' && batch.status !== 'interrupted') {
      throw new Error(`batch ${batchId} is not runnable (status ${batch.status})`);
    }
    this.runningBatches ??= new Set();
    if (this.runningBatches.has(batchId)) throw new Error(`batch ${batchId} is already running`);
    this.runningBatches.add(batchId);
    this.runBatch({ projectId, batchId })
      .catch(async (error) => {
        // A rejected run must still leave an honest terminal state.
        await this.mutate(projectId, (current) => ({
          ...current,
          machines: current.machines.map((machine) => (machine.batchId === batchId ? { ...machine, status: 'idle', batchId: null, loads: [] } : machine)),
          batches: current.batches.map((item) => (item.id === batchId
            ? { ...item, status: 'failed', finishedAt: now(), summary: { ...(item.summary ?? {}), runnerError: String(error?.message ?? error) } }
            : item)),
        })).catch(() => undefined);
      })
      .finally(() => this.runningBatches.delete(batchId));
    return { projectId, batchId, status: 'started', detached: true };
  }

  async runBatch({ projectId, batchId }) {
    const project = this.get(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    const batch = project.batches.find((item) => item.id === batchId);
    if (!batch) throw new Error(`batch not found: ${batchId}`);
    if (batch.status !== 'forming') throw new Error(`batch ${batchId} is not runnable (status ${batch.status})`);
    const missionRecords = project.missions.filter((mission) => batch.missionIds.includes(mission.id));
    const worktreesRoot = join(project.workspace, '.aleph', 'batches');
    const batchWorktree = join(worktreesRoot, batchId);
    await mkdir(worktreesRoot, { recursive: true });
    await rm(batchWorktree, { recursive: true, force: true });
    await git(project.missionRoot, ['worktree', 'add', '--detach', batchWorktree, batch.branch]);
    // The Host owns the runner so runner upgrades do not depend on each mission repo copy.
    await writeFile(join(batchWorktree, '.aleph_batch_runner.py'), TEMPLATE_BATCH_RUNNER, 'utf8');
    // Batches run real training; the budget must fit the machine, not a demo.
    const batchTimeoutMs = Number(process.env.ALEPH_BATCH_TIMEOUT_MS) > 0
      ? Number(process.env.ALEPH_BATCH_TIMEOUT_MS)
      : 6 * 60 * 60 * 1000;
    const infra = await this.prepareBatchRuntime({ project, batch, missionRecords, batchWorktree });
    const startedAt = now();
    const loadEntry = { id: batch.id, kind: 'batch', label: `batch ${batch.id} on ${batch.machineId}`, cpu: infra.threads, startedAt };
    await this.mutate(projectId, (current) => ({
      ...current,
      machines: current.machines.map((item) => (item.id === batch.machineId
        ? { ...item, status: 'busy', batchId: batch.id, loads: [...(item.loads ?? []).filter((entry) => entry.id !== batch.id), loadEntry], telemetry: this.sampleTelemetry() }
        : item)),
      batches: current.batches.map((item) => (item.id === batch.id ? { ...item, status: 'running', startedAt, infra } : item)),
    }));
    let runnerError = null;
    try {
      await run(project.pythonPath || 'python3', ['.aleph_batch_runner.py'], {
        cwd: batchWorktree,
        timeout: batchTimeoutMs,
        env: {
          ...(project.pythonPath ? { PATH: `${dirname(project.pythonPath)}:${process.env.PATH ?? ''}` } : {}),
          ...infra.env,
          ALEPH_WORKSPACE: project.workspace,
          ...(project.visibleData ? { ALEPH_VISIBLE_DATA: project.visibleData } : {}),
          ...(project.pythonPath ? { ALEPH_PYTHON: project.pythonPath } : {}),
          ...(project.testsetPath ? { ALEPH_TESTSET: project.testsetPath } : {}),
        },
      });
      runnerError = null;
    } catch (error) {
      // Keep the runner's own words: "Command failed" alone explains nothing.
      const stdoutTail = String(error?.stdout ?? '').trim().split('\n').slice(-12).join('\n');
      const stderrTail = String(error?.stderr ?? '').trim().split('\n').slice(-12).join('\n');
      const parts = [error instanceof Error ? error.message : String(error)];
      if (stderrTail) parts.push(`stderr:\n${stderrTail}`);
      if (stdoutTail) parts.push(`stdout:\n${stdoutTail}`);
      runnerError = parts.join('\n').slice(0, 4000);
    }

    const outcomes = [];
    for (const mission of missionRecords) {
      let manifestPath = mission.manifestPath;
      let manifestId = mission.manifestId;
      if (!manifestPath) {
        const files = (await git(project.missionRoot, ['ls-tree', '-r', '--name-only', mission.branch])).stdout.split(/\r?\n/);
        manifestPath = files.find((path) => /^missions\/[^/]+\/mission\.json$/.test(path));
        if (manifestPath && !manifestId) {
          try {
            const raw = await git(project.missionRoot, ['show', `${mission.branch}:${manifestPath}`]);
            const parsed = JSON.parse(raw.stdout);
            manifestId = parsed.id ?? manifestPath.split('/')[1];
          } catch {
            manifestId = manifestPath.split('/')[1];
          }
        }
      }
      const missionDir = manifestPath ? manifestPath.split('/')[1] : null;
      manifestId = manifestId ?? missionDir ?? mission.id;
      let envelope = {
        schema: 1,
        mission_id: manifestId,
        batch_id: batch.id,
        machine_id: batch.machineId,
        status: runnerError ? 'failed' : 'done',
        started_at: startedAt,
        finished_at: now(),
        metrics: {},
        artifacts: [],
        logs: [],
        resource: mission.resource ?? null,
        error: runnerError,
      };
      // The runner may key output by manifest id while the mission directory carries a suffix.
      let resultDir = null;
      if (missionDir) {
        for (const candidate of [manifestId, missionDir].filter(Boolean)) {
          if (await pathExists(join(batchWorktree, 'results', candidate))) { resultDir = candidate; break; }
        }
      }
      if (resultDir) {
        try {
          const raw = await readFile(join(batchWorktree, 'results', resultDir, 'result.json'), 'utf8');
          const own = JSON.parse(raw);
          envelope = { ...envelope, ...own, batch_id: batch.id, machine_id: batch.machineId };
          // The runner writes one result.json per mission, so a mission's own status is authoritative.
          if (envelope.status === 'done') envelope.error = null;
          else envelope.error = envelope.error || runnerError || 'mission failed';
          try {
            const metricsRaw = await readFile(join(batchWorktree, 'results', resultDir, 'metrics.json'), 'utf8');
            envelope.metrics = JSON.parse(metricsRaw);
          } catch { /* mission did not publish metrics */ }
        } catch (error) {
          const listing = await readdir(join(batchWorktree, 'results', resultDir)).catch(() => []);
          envelope.status = 'failed';
          envelope.error = runnerError
            || `mission result missing (${resultDir}/result.json: ${String(error?.message ?? error).split('\n')[0]}; files: ${listing.slice(0, 12).join(', ') || 'none'})`;
        }
      } else {
        envelope.status = 'failed';
        envelope.error = missionDir ? 'mission produced no result directory' : 'mission manifest not found';
      }

      let resultCommit = null;
      const resultWorktree = join(worktreesRoot, `${batch.id}-${mission.id}-result`);
      const missionWorktree = join(worktreesRoot, `${batch.id}-${mission.id}-mission`);
      try {
        await git(project.missionRoot, ['worktree', 'add', '--detach', resultWorktree, batch.branch]);
        const target = join(resultWorktree, 'results', manifestId);
        await mkdir(target, { recursive: true });
        // Persist every produced file so later researchers can reuse artifacts and metrics.
        if (resultDir) {
          const produced = join(batchWorktree, 'results', resultDir);
          for (const entry of await readdir(produced).catch(() => [])) {
            if (entry === 'result.json') continue;
            await cp(join(produced, entry), join(target, entry), { recursive: true, force: true }).catch(() => undefined);
          }
        }
        await writeFile(join(target, 'result.json'), JSON.stringify(envelope, null, 2), 'utf8');
        await git(resultWorktree, ['add', '-A']);
        await git(resultWorktree, ['-c', 'user.name=AlephResearch', '-c', 'user.email=aleph@localhost', 'commit', '-m',
          `mission result ${mission.id}\n\nAleph-Mission: ${mission.id}\nAleph-Batch: ${batch.id}\nAleph-Machine: ${batch.machineId}`]);
        resultCommit = (await git(resultWorktree, ['rev-parse', 'HEAD'])).stdout.trim();
        const missionRef = mission.branch.startsWith('refs/heads/') ? mission.branch : `refs/heads/${mission.branch}`;
        const expectedTip = mission.preBatchTip
          ?? (await git(project.missionRoot, ['rev-parse', '--verify', missionRef])).stdout.trim();
        await git(project.missionRoot, ['worktree', 'add', '--detach', missionWorktree, expectedTip]);
        await git(missionWorktree, ['-c', 'user.name=AlephResearch', '-c', 'user.email=aleph@localhost', 'cherry-pick', resultCommit]);
        const newTip = (await git(missionWorktree, ['rev-parse', 'HEAD'])).stdout.trim();
        resultCommit = newTip;
        const occupied = (await git(project.missionRoot, ['worktree', 'list', '--porcelain'])).stdout
          .split(/\r?\n/).some((line) => line.trim() === `branch ${missionRef}` || line.trim() === `branch ${mission.branch}`);
        if (occupied) throw new Error(`cannot deliver result: mission branch ${mission.branch} is checked out in a worktree`);
        // Compare-and-swap instead of branch -f: a commit pushed to the mission branch after
        // the batch was formed is never discarded by result delivery.
        await git(project.missionRoot, ['update-ref', '-m', `mission result ${mission.id}`, missionRef, newTip, expectedTip]);
      } catch (error) {
        envelope.status = 'failed';
        envelope.error = error instanceof Error ? error.message : String(error);
      } finally {
        await git(project.missionRoot, ['worktree', 'remove', '--force', resultWorktree]).catch(() => undefined);
        await git(project.missionRoot, ['worktree', 'remove', '--force', missionWorktree]).catch(() => undefined);
        await rm(resultWorktree, { recursive: true, force: true }).catch(() => undefined);
        await rm(missionWorktree, { recursive: true, force: true }).catch(() => undefined);
      }
      outcomes.push({ missionId: mission.id, manifestId, manifestPath, status: envelope.status, resultCommit, envelope });
      if (mission.ownerSession) {
        const lines = [
          `Your mission ${mission.id} (${manifestId}) finished with status ${envelope.status}.`,
          resultCommit ? `Result commit: ${resultCommit}` : 'No result commit was delivered.',
          envelope.error ? `Error: ${String(envelope.error).split('\n').slice(0, 6).join(' ')}` : 'Read results/' + manifestId + ' on the mission branch for metrics and artifacts.',
          envelope.status === 'done'
            ? 'Adopt it with aleph_adopt_mission when you want to use it, then commit and evaluate when you decide.'
            : 'Fix what the log shows in a new mission branch; do not rerun the same failing mission.',
        ];
        this.deliverOrQueue({ projectId, sessionId: mission.ownerSession, text: lines.join('\n') }).catch(() => undefined);
      }
    }

    // A timed-out runner leaves its mission children behind; never leave them consuming the machine.
    const orphans = this.killUnder(batchWorktree);
    // InfraOptimizer only edits files; anything it starts under its worktree is an accident.
    const infraRoot = join(project.workspace, '.aleph', 'infra');
    const infraStrays = this.killUnder(infraRoot);
    await git(project.missionRoot, ['worktree', 'remove', '--force', batchWorktree]).catch(() => undefined);
    await rm(batchWorktree, { recursive: true, force: true }).catch(() => undefined);
    if (orphans > 0) {
      await this.mutate(projectId, (current) => ({
        ...current,
        violations: [...(current.violations ?? []), `${now()} killed ${orphans} orphan process(es) left by batch ${batch.id}`].slice(-50),
      })).catch(() => undefined);
    }
    const settled = await this.mutate(projectId, (current) => ({
      ...current,
      machines: current.machines.map((item) => {
        if (item.id !== batch.machineId) return item;
        const loads = (item.loads ?? []).filter((entry) => entry.id !== batch.id);
        return { ...item, status: loads.length === 0 ? 'idle' : 'busy', batchId: loads.length === 0 ? null : item.batchId, loads, telemetry: this.sampleTelemetry() };
      }),
      missions: current.missions.map((mission) => {
        const outcome = outcomes.find((item) => item.missionId === mission.id);
        if (!outcome) return mission;
        return {
          ...mission,
          manifestId: outcome.manifestId,
          manifestPath: outcome.manifestPath,
          status: outcome.status === 'done' ? 'done' : 'failed',
          resultCommit: outcome.resultCommit,
          error: outcome.envelope.error ?? null,
          finishedAt: now(),
        };
      }),
      batches: current.batches.map((item) => item.id === batch.id ? {
        ...item,
        status: runnerError ? 'failed' : (outcomes.every((outcome) => outcome.status === 'done') ? 'done' : 'failed'),
        startedAt,
        finishedAt: now(),
        summary: { runnerError, missions: outcomes.map(({ envelope, ...rest }) => rest) },
      } : item),
    }));
    const queued = (this.get(projectId)?.batches ?? []).find((item) => item.machineId === batch.machineId && item.status === 'forming');
    await this.notifyComposer({
      projectId,
      agent: null,
      event: 'batch finished',
      detail: queued ? `${batch.id} freed the machine and batch ${queued.id} is prepared and waiting` : batch.id,
    }).catch(() => undefined);
    return settled;
  }

  async evaluate({ projectId, agent, branch = null }) {
    const project = this.get(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    const owner = agent?.id ?? null;
    const pending = project.missions.filter((mission) => (
      mission.ownerSession === owner && ['proposed', 'approved', 'batched', 'running'].includes(mission.status)
    ));
    if (pending.length > 0) {
      return { status: 'waiting', projectId, pending: pending.map((mission) => ({ id: mission.id, branch: mission.branch, status: mission.status })) };
    }
    const agentRecord = (project.agents ?? []).find((item) => item.role === 'researcher' && item.childId === owner && item.worktree);
    const evaluationId = newId('eval');
    const worktreeRoot = join(project.workspace, '.aleph', 'evaluations');
    let worktree = null;
    let temporary = false;
    let targetRef = null;
    let evaluatedCommit;
    if (!branch && agentRecord?.worktree && await pathExists(agentRecord.worktree)) {
      // Score the committed tree, never a worktree that is still being edited: a report
      // must point at code that exists in the repository.
      const dirty = (await git(agentRecord.worktree, ['status', '--porcelain']).catch(() => ({ stdout: '' }))).stdout.trim();
      if (dirty) {
        throw new Error(`cannot evaluate uncommitted changes in ${agentRecord.worktree}; commit them first so the report matches the scored code`);
      }
      const symbolic = await git(agentRecord.worktree, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => ({ stdout: '' }));
      targetRef = symbolic.stdout.trim() || null;
      evaluatedCommit = (await git(agentRecord.worktree, ['rev-parse', 'HEAD'])).stdout.trim();
      await mkdir(worktreeRoot, { recursive: true });
      worktree = join(worktreeRoot, evaluationId);
      await git(project.researchRoot, ['worktree', 'add', '--detach', worktree, evaluatedCommit]);
      temporary = true;
    } else {
      const rev = branch ?? 'HEAD';
      const exists = branch
        ? await git(project.researchRoot, ['rev-parse', '--verify', branch]).then(() => true).catch(() => false)
        : true;
      if (!exists) throw new Error(`research branch not found: ${branch}`);
      const symbolic = await git(project.researchRoot, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => ({ stdout: '' }));
      targetRef = branch ? (branch.startsWith('refs/') ? branch : `refs/heads/${branch}`) : (symbolic.stdout.trim() || null);
      evaluatedCommit = (await git(project.researchRoot, ['rev-parse', '--verify', rev])).stdout.trim();
      await mkdir(worktreeRoot, { recursive: true });
      worktree = join(worktreeRoot, evaluationId);
      await git(project.researchRoot, ['worktree', 'add', '--detach', worktree, evaluatedCommit]);
      temporary = true;
    }
    const evaluatedTree = (await git(project.researchRoot, ['rev-parse', `${evaluatedCommit}^{tree}`])).stdout.trim();
    const env = {
      ALEPH_WORKSPACE: project.workspace,
      ALEPH_SOLUTION_DIR: worktree,
      ...(project.visibleData ? { ALEPH_VISIBLE_DATA: project.visibleData } : {}),
      ...(project.testsetPath ? { ALEPH_TESTSET: project.testsetPath } : {}),
      ...(project.submissionPython ? { ALEPH_SUBMISSION_PYTHON: project.submissionPython } : {}),
      ...(project.pythonPath ? { ALEPH_PYTHON: project.pythonPath } : {}),
    };
    let score = null;
    let stdout = '';
    let stderr = '';
    // Every process this evaluation starts carries the marker, so the Host can stop the
    // whole tree instead of only the entry command.
    const marker = `ALEPH_EVALUATION_ID=${evaluationId}`;
    try {
      // The evaluator lives beside the project; it reads the scored snapshot through ALEPH_SOLUTION_DIR.
      const result = await run('bash', ['-lc', project.evalCommand], {
        cwd: project.evalRoot || project.workspace,
        env: { ...env, ALEPH_EVALUATION_ID: evaluationId },
        timeout: 600_000,
      });
      stdout = result.stdout;
      stderr = result.stderr;
      score = parseScore(stdout)?.score ?? null;
    } catch (error) {
      stdout = String(error?.stdout ?? '');
      stderr = String(error?.stderr ?? '');
      throw error;
    } finally {
      // Kill scoring descendants before removing their input directory.
      const killed = this.killByEnvMarker(marker);
      if (killed > 0) {
        await this.mutate(projectId, (current) => ({
          ...current,
          violations: [...(current.violations ?? []), `${now()} stopped ${killed} leftover evaluation process(es)`].slice(-50),
        })).catch(() => undefined);
      }
      if (temporary && worktree) {
        await git(project.researchRoot, ['worktree', 'remove', '--force', worktree]).catch(() => undefined);
        await rm(worktree, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    const message = `research evaluation: ${score ?? 'no score'}\n\nAleph-Project: ${project.id}\nAleph-Evaluation: ${score ?? 'none'}\nAleph-Research-Commit: ${evaluatedCommit}\n\n${stdout.trim().slice(0, 4000)}`;
    // Build the report from the evaluated tree so files the evaluator generated never enter the branch.
    const researchCommit = (await git(project.researchRoot, ['-c', 'user.name=AlephResearch', '-c', 'user.email=aleph@localhost',
      'commit-tree', evaluatedTree, '-p', evaluatedCommit, '-m', message])).stdout.trim();
    const evaluationRef = `refs/aleph/evaluations/${evaluationId}`;
    await git(project.researchRoot, ['update-ref', evaluationRef, researchCommit, '']);
    let researchBranchUpdated = false;
    if (targetRef) {
      try {
        // Compare-and-swap: commits made while the evaluation ran are never replaced.
        await git(project.researchRoot, ['update-ref', targetRef, researchCommit, evaluatedCommit]);
        researchBranchUpdated = true;
      } catch {
        // The branch moved on; the evaluation ref still preserves this report.
      }
    }
    const record = {
      id: evaluationId, branch: targetRef ? targetRef.replace(/^refs\/heads\//, '') : null,
      evaluatedCommit, researchCommit, evaluationRef, score, at: now(),
    };
    const updated = await this.mutate(projectId, (current) => {
      const best = current.best ?? null;
      const better = typeof score === 'number' && (!best || typeof best.score !== 'number' || score > best.score);
      return {
        ...current,
        evaluations: [...(current.evaluations ?? []), record].slice(-200),
        best: better ? { score, branch: record.branch, commit: evaluatedCommit, researchCommit, evaluationRef, at: record.at } : best,
      };
    });
    // The opening researcher is done once its method has a score; the cohort replaces it.
    let bootstrap = null;
    if (updated.bootstrap?.status === 'running' && owner && updated.bootstrap.childId === owner) {
      bootstrap = await this.completeBootstrap({ projectId, reason: 'the opening method was evaluated', evaluatedCommit }).catch(() => null);
    }
    return {
      status: 'done', projectId, score, researchCommit, evaluatedCommit, evaluationRef, researchBranchUpdated,
      best: updated.best ?? null,
      bootstrap,
      stdout: stdout.slice(0, 8000), stderr: stderr.slice(0, 4000),
    };
  }

  async startResearcher({ projectId, agent, bootstrap = false, instruction = null }) {
    if (!agent) throw new Error('a calling Agent is required to start a researcher');
    await this.rememberOrchestrator(projectId, agent);
    if (!this.subagents) throw new Error('subagent service is unavailable');
    const project = this.get(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    this.assertWorkspace(agent, project.workspace);
    const phase = bootstrap ? 'bootstrap' : 'cohort';
    const branch = `research/r-${randomUUID().slice(0, 8)}`;
    const worktree = join(project.workspace, '.aleph', 'researchers', newId('r'));
    await mkdir(join(project.workspace, '.aleph', 'researchers'), { recursive: true });
    await git(project.researchRoot, ['worktree', 'add', '-b', branch, worktree, 'HEAD']);
    // The static contract lives in the persona and the skill; the Host sends only this
    // session's coordinates plus the assignment the Leader wrote for it.
    const assignment = typeof instruction === 'string' && instruction.trim()
      ? instruction.trim()
      : 'No specific assignment was given. Read the project README, then choose the most valuable direction you can justify and start there.';
    const prompt = [
      'Host context for this session:',
      `- Project: ${project.id}. Research brief: ${project.brief || '(none)'}.`,
      `- Worktree: ${worktree}`,
      `- Branch: ${branch}`,
      `- Mission repo: ${project.missionRoot}. Template branch: ${project.templateBranch}.`,
      `- Provided data: data/ inside the worktree${project.visibleData ? `; the visible data directory is ${project.visibleData}` : ''}.`,
      `- Shared interpreter: ${project.pythonPath ?? 'python3'} (numpy, pandas, scipy, scikit-learn and lightgbm are installed there).`,
      ...(project.conventions ? [`- Project conventions:\n${project.conventions}`] : []),
      '',
      'Assignment from the Leader:',
      assignment,
    ].join('\n');
    const abort = new AbortController();
    let activation;
    try {
      activation = await this.subagents.startActivation({
        provider: 'spawn', label: `aleph researcher ${project.id}`, delivery: 'caller', signal: abort.signal,
        request: { parent: agent, cwd: worktree, agentPreset: 'aleph-researcher', prompt: [{ type: 'text', text: prompt }] },
      });
    } catch (error) {
      await this.mutate(projectId, (current) => ({ ...current, agents: [...(current.agents ?? []), { role: 'researcher', childId: null, status: 'failed', summary: String(error), branch, worktree, updatedAt: now() }] }));
      throw error;
    }
    // A missing identity would make the completion callback match every record with a null child.
    if (typeof activation.childId !== 'string' || !activation.childId.trim()) {
      void activation.result.catch(() => undefined);
      abort.abort();
      throw new Error('researcher activation did not return a child ID');
    }
    const childId = activation.childId;
    await this.mutate(projectId, (current) => ({
      ...current,
      agents: [...(current.agents ?? []), { role: 'researcher', phase, childId, status: 'running', summary: null, branch, worktree, updatedAt: now() }],
      ...(bootstrap ? { bootstrap: { status: 'running', childId, branch, instruction: instruction ?? null, startedAt: now() } } : {}),
    }));
    this.parentAgents ??= new Map();
    if (agent) this.parentAgents.set(childId, agent);
    // Ownership is exact: only this activation may settle its own record.
    const settle = async (status, summary) => {
      await this.mutate(projectId, (current) => ({
        ...current,
        agents: (current.agents ?? []).map((item) => (item.role === 'researcher' && item.childId === childId && item.status === 'running'
          ? { ...item, status, summary, updatedAt: now() }
          : item)),
      })).catch(() => undefined);
      if (bootstrap) {
        await this.completeBootstrap({ projectId, reason: 'the initial researcher finished' }).catch(() => undefined);
        return;
      }
      await this.maybeDispatchReplacement({ projectId }).catch(() => undefined);
    };
    activation.result.then(async (result) => {
      const summary = (result?.output ?? []).filter((block) => block?.type === 'text').map((block) => block.text).join('\n').trim().slice(0, 8000) || '(no summary)';
      await settle('done', summary);
    }, async (error) => {
      await settle('failed', String(error));
    });
    return { projectId, role: 'researcher', childId, branch, worktree };
  }

  async startResearchers({ projectId, count = null, agent, instruction = null, instructions = null }) {
    await this.rememberOrchestrator(projectId, agent);
    const project = this.get(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    if (!project.prepared) throw new Error('research project not prepared; Leader must call aleph_create_research_scaffold first');
    const missionBranches = new Set((await git(project.missionRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/missions'])).stdout.split(/\r?\n/).filter(Boolean));
    if ((project.missions ?? []).some((mission) => !missionBranches.has(mission.branch))) {
      await this.mutate(projectId, (current) => ({ ...current, missions: (current.missions ?? []).filter((mission) => missionBranches.has(mission.branch)) }));
    }
    const requested = Math.max(1, Math.min(16, Number(count) || project.researcherCount || 4));
    await this.mutate(projectId, (current) => ({
      ...current,
      // An explicit cohort request supersedes the single opening researcher.
      ...(current.bootstrap && current.bootstrap.status !== 'done'
        ? { bootstrap: { ...current.bootstrap, status: 'skipped', finishedAt: now() } }
        : {}),
      agents: (current.agents ?? []).map((item) => item.role === 'researcher' && item.status === 'running'
        ? { ...item, status: 'failed', summary: 'superseded by a new researcher batch', updatedAt: now() }
        : item),
    }));
    const started = [];
    for (let index = 0; index < requested; index += 1) {
      // One shared assignment, or one per researcher so the cohort covers different work.
      const own = Array.isArray(instructions) ? instructions[index] : null;
      const assignment = typeof own === 'string' && own.trim() ? own : instruction;
      started.push(await this.startResearcher({ projectId, agent, instruction: assignment }));
    }
    const checkpoint = setTimeout(() => {
      for (const researcher of this.get(projectId)?.agents ?? []) {
        if (researcher.role !== 'researcher' || researcher.status !== 'running' || !researcher.childId) continue;
        this.nudgeChild(researcher.childId, 'Checkpoint: keep the exploration small. When you have something worth running, create a mission with aleph_create_mission, put the current implementation in main.py, commit and propose it. You can improve it after the first result.');
      }
    }, 60_000);
    checkpoint.unref?.();
    const finalCheckpoint = setTimeout(() => {
      for (const researcher of this.get(projectId)?.agents ?? []) {
        if (researcher.role !== 'researcher' || researcher.status !== 'running' || !researcher.childId) continue;
        this.nudgeChild(researcher.childId, 'Final checkpoint: commit the mission work now and call aleph_propose_mission. Add analysis later only if the result shows you need it.');
      }
    }, 180_000);
    finalCheckpoint.unref?.();
    return { projectId, requested, started };
  }

  /**
   * The project opens with a single researcher. Its experiments and its first evaluated
   * method settle the project's defaults, and only then does the full cohort start.
   */
  async startBootstrap({ projectId, agent, instruction = null }) {
    const project = this.get(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    const current = project.bootstrap;
    if (current?.status === 'running') return { started: false, reason: 'bootstrap already running', bootstrap: current };
    if (current?.status === 'done' || current?.status === 'skipped') {
      const cohort = await this.startResearchers({ projectId, agent });
      return { started: false, reason: 'bootstrap already done', cohort };
    }
    const started = await this.startResearcher({ projectId, agent, bootstrap: true, instruction });
    return { started: true, ...started };
  }

  /** Reclaim the initial researcher and start the configured cohort. */
  async completeBootstrap({ projectId, reason = 'done', evaluatedCommit = null }) {
    const project = this.get(projectId);
    if (!project) return { completed: false };
    const bootstrap = project.bootstrap;
    if (!bootstrap || bootstrap.status === 'done' || bootstrap.status === 'skipped') return { completed: false };
    await this.mutate(projectId, (state) => ({
      ...state,
      bootstrap: {
        ...(state.bootstrap ?? {}),
        status: 'done',
        finishedAt: now(),
        evaluatedCommit: evaluatedCommit ?? state.bootstrap?.evaluatedCommit ?? null,
        detail: reason,
      },
      // The bootstrap session is finished by construction; the cohort replaces it.
      agents: (state.agents ?? []).map((item) => (item.role === 'researcher' && item.childId === bootstrap.childId && item.status === 'running'
        ? { ...item, status: 'done', summary: item.summary ?? 'bootstrap finished; cohort started', updatedAt: now() }
        : item)),
    }));
    const parent = bootstrap.childId ? (this.parentAgents?.get(bootstrap.childId) ?? (project.orchestratorSessionId ? this.ctx?.agents?.get?.(project.orchestratorSessionId) : null)) : null;
    if (!parent) return { completed: true, cohort: null, reason: 'no live parent to start the cohort' };
    // The cohort inherits the Leader's opening direction; the Host has no other channel to it.
    const cohort = await this.startResearchers({ projectId, agent: parent, instruction: bootstrap.instruction ?? null }).catch((error) => ({ error: String(error?.message ?? error) }));
    return { completed: true, cohort };
  }

  nudgeChild(childId, text) {
    if (!childId || !this.subagents) return;
    const parent = this.parentAgents?.get(childId);
    if (!parent) return;
    this.subagents.sendMessage(parent, childId, [{ type: 'text', text }], { signal: new AbortController().signal })
      .catch(() => undefined);
  }

  nudgeForKill(project, cwd, reason) {
    const agentRecord = (project.agents ?? []).find((item) => item.status === 'running' && item.worktree
      && (cwd === item.worktree || cwd.startsWith(`${item.worktree}/`)));
    if (!agentRecord?.childId || !this.subagents) return;
    const parent = this.parentAgents?.get(agentRecord.childId);
    if (!parent) return;
    this.nudged ??= new Set();
    if (this.nudged.has(agentRecord.childId)) return;
    this.nudged.add(agentRecord.childId);
    const text = `A local compute process was stopped (${reason}). Stop retrying local experiments. Create a mission with aleph_start_mission, fill its mission.json, code and uv project, commit the branch, and call aleph_propose_mission.`;
    this.subagents.sendMessage(parent, agentRecord.childId, [{ type: 'text', text }], { signal: new AbortController().signal })
      .catch(() => undefined);
  }

  /**
   * A Host restart ends every live activation and any batch runner, but storage still
   * describes them as running. Reconcile that once at startup so the machine is usable.
   */
  async recoverAfterRestart() {
    const nowText = now();
    const summary = [];
    for (const project of this.list()) {
      const batchesRoot = join(project.workspace, '.aleph', 'batches');
      const interruptedBatches = (project.batches ?? [])
        .filter((batch) => batch.status === 'running' && !this.hasProcessUnder(join(batchesRoot, batch.id)))
        .map((batch) => batch.id);
      const interruptedResearchers = (project.agents ?? [])
        .filter((item) => item.role === 'researcher' && item.status === 'running')
        .map((item) => item.childId)
        .filter(Boolean);
      if (interruptedBatches.length === 0 && interruptedResearchers.length === 0) continue;

      await this.mutate(project.id, (current) => ({
        ...current,
        batches: (current.batches ?? []).map((batch) => (
          interruptedBatches.includes(batch.id)
            ? { ...batch, status: 'interrupted', summary: { ...(batch.summary ?? {}), interruptedAt: nowText } }
            : batch
        )),
        // The session survives a restart, so its researcher can be resumed instead of replaced.
        agents: (current.agents ?? []).map((item) => (
          item.role === 'researcher' && item.status === 'running'
            ? { ...item, status: 'interrupted', summary: 'waiting to resume after a Host restart', updatedAt: nowText }
            : item
        )),
        machines: (current.machines ?? []).map((machine) => (
          interruptedBatches.includes(machine.batchId ?? '') ? { ...machine, status: 'idle', loads: [] } : machine
        )),
      })).catch(() => undefined);
      summary.push({ project: project.id, interruptedBatches, interruptedResearchers });
    }

    // Resume the work the restart stopped, newest first.
    for (const entry of summary) {
      for (const batchId of entry.interruptedBatches) {
        this.resumeBatch({ projectId: entry.project, batchId }).catch(() => undefined);
      }
      await this.resumeResearchers({ projectId: entry.project }).catch(() => undefined);
    }
    return summary;
  }

  /** Re-run an interrupted batch; the runner skips missions that already finished. */
  async resumeBatch({ projectId, batchId }) {
    const project = this.get(projectId);
    const batch = (project?.batches ?? []).find((item) => item.id === batchId);
    if (!batch || batch.status !== 'interrupted') return { resumed: false, reason: 'batch is not interrupted' };
    await this.mutate(projectId, (current) => ({
      ...current,
      batches: (current.batches ?? []).map((item) => (item.id === batchId ? { ...item, status: 'forming' } : item)),
    }));
    this.runBatch({ projectId, batchId }).catch(() => undefined);
    return { resumed: true, batchId };
  }

  /** Cold-resume interrupted researchers by messaging their existing sessions. */
  async resumeResearchers({ projectId }) {
    const project = this.get(projectId);
    if (!project) return { resumed: 0 };
    const interrupted = (project.agents ?? []).filter((item) => item.role === 'researcher' && item.status === 'interrupted' && item.childId);
    if (interrupted.length === 0) return { resumed: 0 };
    const parent = project.orchestratorSessionId ? this.ctx?.agents?.get?.(project.orchestratorSessionId) : null;
    if (!parent) return { resumed: 0, reason: 'orchestrator session is not live yet' };
    let resumed = 0;
    for (const record of interrupted) {
      const sent = await this.notifySession({
        sessionId: record.childId,
        text: 'The Host restarted and your mission work was interrupted mid-flight. Resume where you left off: check aleph_list_missions for your mission results, continue the work you were doing, and finish the lifecycle you already planned.',
      }).catch(() => ({ delivered: false }));
      if (!sent?.delivered) continue;
      await this.mutate(projectId, (current) => ({
        ...current,
        agents: (current.agents ?? []).map((item) => (item.childId === record.childId ? { ...item, status: 'running', summary: null, updatedAt: now() } : item)),
      })).catch(() => undefined);
      resumed += 1;
    }
    return { resumed };
  }

  /** Resume whatever was left waiting, now that the orchestrator may be live again. */
  recoverPending() {
    if (this.recovering) return;
    this.recovering = true;
    (async () => {
      for (const project of this.list()) {
        const interruptedBefore = (project.agents ?? []).filter((item) => item.role === 'researcher' && item.status === 'interrupted');
        const needsWake = interruptedBefore.length > 0 || (project.pendingNotices ?? []).length > 0;
        if (needsWake) await this.reviveOrchestrator(project).catch(() => null);
        const live = this.liveOrchestrator(project);
        const interrupted = interruptedBefore;
        if (live && interrupted.length > 0) {
          await this.resumeResearchers({ projectId: project.id }).catch(() => undefined);
        }
        // Announce a queue state once. Repeating the same notice every tick is the
        // difference between a Host that reports changes and a Host that polls.
        const signature = this.queueSignature(project);
        if (live && signature !== project.dispatchSignature) {
          const queued = (project.missions ?? []).filter((mission) => mission.status === 'approved').length;
          const busy = (project.batches ?? []).some((batch) => batch.status === 'running');
          await this.mutate(project.id, (current) => ({ ...current, dispatchSignature: signature })).catch(() => undefined);
          if (queued > 0 || busy) {
            await this.notifyComposer({
              projectId: project.id,
              agent: null,
              event: 'dispatch pending',
              detail: `${queued} mission(s) queued; machine ${busy ? 'busy' : 'free'}`,
            }).catch(() => undefined);
          }
        }
        const interruptedBatch = (project.batches ?? []).find((batch) => batch.status === 'interrupted');
        if (interruptedBatch && !this.resumeScheduled?.has?.(interruptedBatch.id)) {
          this.resumeScheduled ??= new Set();
          this.resumeScheduled.add(interruptedBatch.id);
          this.resumeBatch({ projectId: project.id, batchId: interruptedBatch.id }).catch(() => undefined);
        }
      }
    })().catch(() => undefined).finally(() => { this.recovering = false; });
  }

  hasProcessUnder(rootPath) {
    const root = resolve(rootPath);
    let entries = [];
    try { entries = readdirSync('/proc'); } catch { return false; }
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const cwd = readlinkSync(`/proc/${entry}/cwd`);
        if (cwd === root || cwd.startsWith(`${root}/`)) return true;
      } catch { /* process vanished */ }
    }
    return false;
  }

  checkProcesses() {
    this.recoverPending();
    const hasBwrapAncestor = (pid) => {
      let current = pid;
      for (let depth = 0; depth < 12; depth += 1) {
        try {
          const status = readFileSync(`/proc/${current}/status`, 'utf8');
          const ppid = Number((status.match(/^PPid:\s*(\d+)/m) ?? [])[1]);
          if (!Number.isFinite(ppid) || ppid <= 1) return false;
          const cmdline = readFileSync(`/proc/${ppid}/cmdline`).toString('utf8');
          if (cmdline.includes('bwrap')) return true;
          current = ppid;
        } catch { return false; }
      }
      return false;
    };
    const projects = this.list();
    const nowMs = Date.now();
    for (const project of projects) {
      if ((project.pendingNotices ?? []).length > 0) this.flushPendingNotices(project).catch(() => undefined);
    }
    for (const project of projects) {
      if (project.paused) continue;
      if ((project.pendingNotices ?? []).length === 0) continue;
      // Notices are parked because no parent is live; keep the loop moving meanwhile.
      // Skip when the Composer itself can still be woken through its own parent.
      const composerWakeable = (project.agents ?? []).some((item) => item.role === 'composer' && item.childId
        && (this.parentAgents?.has(item.childId)
          || (item.parentSessionId ? Boolean(this.ctx?.agents?.get?.(item.parentSessionId)) : false)));
      if (!composerWakeable) this.mechanicalDispatch(project).catch(() => undefined);
    }
    // A cohort that drained while the Leader session was cold resumes here.
    for (const project of projects) {
      if (!project.pendingDispatch || !this.liveOrchestrator(project)) continue;
      this.maybeDispatchReplacement({ projectId: project.id })
        .then((result) => {
          if (result?.dispatched) this.mutate(project.id, (current) => ({ ...current, pendingDispatch: null })).catch(() => undefined);
        })
        .catch(() => undefined);
    }
    for (const project of projects) {
      for (const batch of project.batches ?? []) {
        if (batch.status !== 'running') continue;
        const worktree = join(resolve(project.workspace), '.aleph', 'batches', batch.id);
        if (this.hasProcessUnder(worktree)) continue;
        // The runner is gone but the record still says running: settle it honestly.
        this.finishDeadBatch({ projectId: project.id, batchId: batch.id }).catch(() => undefined);
      }
      for (const batch of project.batches ?? []) {
        if (batch.infra?.status !== 'requested') continue;
        const requestedAt = Date.parse(batch.infra.requestedAt ?? '') || 0;
        if (requestedAt && Date.now() - requestedAt > 15 * 60 * 1000) {
          this.releaseStalledInfra({ projectId: project.id, batchId: batch.id }).catch(() => undefined);
        }
      }
    }
    // InfraOptimizer edits files only. Anything it starts would compete with the running
    // batch, so such processes are killed as soon as they appear.
    for (const project of projects) {
      const infraRoot = join(resolve(project.workspace), '.aleph', 'infra');
      if (this.hasProcessUnder(infraRoot)) {
        const killed = this.killUnder(infraRoot);
        this.notifyComposer({
          projectId: project.id,
          agent: null,
          event: 'infra ran code',
          detail: `${killed} process(es) started by InfraOptimizer were stopped; it must optimize by editing only`,
        }).catch(() => undefined);
      }
    }
    for (const project of projects) {
      const workspace = resolve(project.workspace);
      const allowed = [
        join(workspace, '.aleph', 'researchers'),
        join(workspace, '.aleph', 'missions'),
        join(workspace, '.aleph', 'batches'),
        join(workspace, '.aleph', 'evals'),
      ];
      let entries = [];
      const groups = new Map();
      try { entries = readdirSync('/proc'); } catch { continue; }
      for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue;
        const pid = Number(entry);
        if (pid === process.pid) continue;
        let cwd = '';
        let cmd = '';
        let environ = '';
        try {
          cwd = readlinkSync(`/proc/${entry}/cwd`);
          cmd = readFileSync(`/proc/${entry}/cmdline`).toString('utf8').replace(/\0/g, ' ');
          environ = readFileSync(`/proc/${entry}/environ`).toString('utf8');
        } catch { continue; }
        const isPython = /\.venv|python|pip|uv pip|conda|lightgbm|catboost|xgboost|torch/i.test(cmd);
        const isBuild = /(?:^|[\s/])(?:cc1|cc1plus|gcc|g\+\+|ld|meson|ninja|cmake|make|rustc|cargo)(?:[\s/]|$)/i.test(cmd);
        const isCaseProcess = environ.includes('DSH_PROFILE=aleph-lab');
        if (!cwd.startsWith(workspace)) continue;
        const underAllowed = allowed.some((path) => cwd === path || cwd.startsWith(`${path}/`));
        const underMission = cwd === project.missionRoot || cwd.startsWith(`${project.missionRoot}/`);
        const nested = isCaseProcess && hasBwrapAncestor(pid);
        const underBatchOrEval = cwd.startsWith(join(workspace, '.aleph', 'batches')) || cwd.startsWith(join(workspace, '.aleph', 'evals'));
        if (nested && isBuild && !underBatchOrEval) {
          try { process.kill(pid, 'SIGKILL'); } catch { continue; }
          this.mutate(project.id, (current) => ({
            ...current,
            violations: [...(current.violations ?? []), `${now()} killed package/build process ${pid}: ${cmd.slice(0, 160)}`].slice(-50),
          })).catch(() => undefined);
          continue;
        }
        const forbidden = /\/home\/hapenia\/Projects\/kunlungpt-comp|\/home\/hapenia\/Projects\/aleph-research|\/home\/hapenia\/\.dsh|problem\/data\.zip|\/testsets(?:\/|\b)|\/tmp\/aleph-case-lab\/(?:profiles|sessions|storages|home)\b/.test(cmd);
        if (nested && forbidden) {
          try { process.kill(pid, 'SIGKILL'); } catch { continue; }
          this.nudgeForKill(project, cwd, 'forbidden path access');
          this.mutate(project.id, (current) => ({
            ...current,
            violations: [...(current.violations ?? []), `${now()} killed forbidden-path access ${pid}: ${cmd.slice(0, 160)}`].slice(-50),
          })).catch(() => undefined);
          continue;
        }
        if (nested && (cwd === workspace || (!underAllowed && !underMission))) {
          try { process.kill(pid, 'SIGKILL'); } catch { continue; }
          this.nudgeForKill(project, cwd, 'out-of-bounds command');
          this.mutate(project.id, (current) => ({
            ...current,
            violations: [...(current.violations ?? []), `${now()} killed command outside researcher/mission directories ${pid}: ${cmd.slice(0, 160)}`].slice(-50),
          })).catch(() => undefined);
          continue;
        }
        const isSearch = /(?:grep\s+-r|find\s+\/tmp|find\s+\/home|grep\s+-r.*\/home)/.test(cmd);
        if (nested && !underAllowed && isSearch) {
          try { process.kill(pid, 'SIGKILL'); } catch { continue; }
          this.mutate(project.id, (current) => ({
            ...current,
            violations: [...(current.violations ?? []), `${now()} killed out-of-scope search ${pid}: ${cmd.slice(0, 160)}`].slice(-50),
          })).catch(() => undefined);
          continue;
        }
        if (!isPython) continue;
        if (nested && !underAllowed) {
          try { process.kill(pid, 'SIGKILL'); } catch { continue; }
          this.mutate(project.id, (current) => ({
            ...current,
            violations: [...(current.violations ?? []), `${now()} killed out-of-worktree process ${pid}: ${cmd.slice(0, 160)}`].slice(-50),
          })).catch(() => undefined);
          continue;
        }
        if (!underAllowed) continue;
        // A batch worktree that no longer belongs to a running batch must not keep computing.
        const batchPrefix = `${join(workspace, '.aleph', 'batches')}/`;
        if (cwd.startsWith(batchPrefix)) {
          const batchId = cwd.slice(batchPrefix.length).split('/')[0];
          const current = this.get(project.id);
          const live = (current?.batches ?? []).find((item) => item.id === batchId);
          if (!live || (live.status !== 'running' && live.status !== 'forming')) {
            try { process.kill(pid, 'SIGKILL'); } catch { continue; }
            this.mutate(project.id, (cur) => ({
              ...cur,
              violations: [...(cur.violations ?? []), `${now()} killed orphan batch process ${pid} (${batchId}): ${cmd.slice(0, 120)}`].slice(-50),
            })).catch(() => undefined);
            continue;
          }
          continue;
        }
        // Compute limits only police researcher worktrees. Batch and evaluation worktrees
        // run the approved heavy compute and must never be throttled by the watchdog.
        const inResearcherWorktree = cwd === join(workspace, '.aleph', 'researchers') || cwd.startsWith(`${join(workspace, '.aleph', 'researchers')}/`);
        if (!inResearcherWorktree) continue;
        // Inside a researcher worktree, kill long-running local experiments.
        try {
          const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
          const fields = stat.split(' ');
          const ticks = Number(fields[13]) + Number(fields[14]);
          const startTicks = Number(fields[21]);
          const uptimeSec = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
          const ageSec = uptimeSec - startTicks / 100;
          if (nested && cwd.startsWith(join(workspace, '.aleph', 'researchers')) && ageSec > 90) {
            try { process.kill(pid, 'SIGKILL'); } catch { continue; }
            this.nudgeForKill(project, cwd, 'long local experiment');
            this.mutate(project.id, (current) => ({
              ...current,
              violations: [...(current.violations ?? []), `${now()} killed long local experiment ${pid} (${Math.round(ageSec)}s): ${cmd.slice(0, 160)}`].slice(-50),
            })).catch(() => undefined);
            this.cpuSamples.delete(`${project.id}:${pid}`);
            continue;
          }
          const key = `${project.id}:${pid}`;
          const prior = this.cpuSamples?.get?.(key);
          this.cpuSamples ??= new Map();
          if (prior && prior.ticks > 0) {
            const delta = ticks - prior.ticks;
            if (delta > 1000) {
              process.kill(pid, 'SIGKILL');
              this.nudgeForKill(project, cwd, 'sustained heavy compute');
              this.mutate(project.id, (current) => ({
                ...current,
                violations: [...(current.violations ?? []), `${now()} killed sustained heavy compute ${pid}: ${cmd.slice(0, 160)}`].slice(-50),
              })).catch(() => undefined);
              this.cpuSamples.delete(key);
              continue;
            }
          }
          this.cpuSamples.set(key, { ticks, at: nowMs });
          const groupKey = allowed.find((path) => cwd === path || cwd.startsWith(`${path}/`)) ?? cwd;
          const group = groups.get(groupKey) ?? { ticks: 0, pids: [] };
          group.ticks += prior ? Math.max(0, ticks - prior.ticks) : 0;
          group.pids.push(pid);
          groups.set(groupKey, group);
        } catch { /* process exited */ }
      }
      for (const [groupKey, group] of groups) {
        if (group.ticks > 1000) {
          for (const pid of group.pids) {
            try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
          }
          this.mutate(project.id, (current) => ({
            ...current,
            violations: [...(current.violations ?? []), `${now()} killed aggregate heavy compute (${group.ticks} ticks) under ${groupKey}`].slice(-50),
          })).catch(() => undefined);
        }
      }
    }
  }

  composerRecord(projectId) {
    const project = this.get(projectId);
    return (project?.agents ?? []).find((item) => item.role === 'composer' && item.status === 'running');
  }

  /** The Composer is a long-lived queue manager; start it once and keep talking to it. */
  async ensureComposer({ projectId, agent }) {
    const project = this.get(projectId);
    if (!agent && project?.orchestratorSessionId) {
      agent = this.ctx?.agents?.get?.(project.orchestratorSessionId) ?? null;
    }
    if (!agent) return { projectId, childId: null, started: false, reason: 'no live orchestrator session' };
    // Reuse a live Composer session; a failed one is replaced instead of resuming a broken child.
    const existing = (project?.agents ?? []).filter((item) => item.role === 'composer' && item.childId && item.status !== 'failed').pop();
    if (existing?.childId) return { projectId, childId: existing.childId, started: false };
    const started = await this.runComposer({ projectId, agent });
    return { projectId, childId: started.childId, started: true };
  }

  /** Deliver a Host message to a live session, using the remembered orchestrator as the parent. */
  async notifySession({ sessionId, text }) {
    if (!sessionId || !this.subagents) return { delivered: false, reason: 'no session or subagents' };
    let target = null;
    for (const [childId, parent] of this.parentAgents ?? []) {
      if (childId === sessionId) { target = parent; break; }
    }
    if (!target) {
      for (const [, parent] of this.parentAgents ?? []) { target = parent; break; }
    }
    if (!target && this.get?.length) {
      for (const project of this.list()) {
        const parent = project.orchestratorSessionId ? this.ctx?.agents?.get?.(project.orchestratorSessionId) : null;
        if (parent) { target = parent; break; }
      }
    }
    if (!target) return { delivered: false, reason: 'no live parent session' };
    try {
      await this.subagents.sendMessage(target, sessionId, [{ type: 'text', text }], { signal: new AbortController().signal });
      return { delivered: true };
    } catch (error) {
      return { delivered: false, reason: String(error?.message ?? error) };
    }
  }

  /** A value that changes only when the dispatchable state changes. */
  queueSignature(project) {
    const queued = (project.missions ?? [])
      .filter((mission) => mission.status === 'approved')
      .map((mission) => mission.id)
      .sort()
      .join(',');
    const batches = (project.batches ?? [])
      .filter((batch) => ['forming', 'running'].includes(batch.status))
      .map((batch) => `${batch.id}:${batch.status}`)
      .sort()
      .join(',');
    return `${queued}|${batches}|${project.paused ? 'paused' : 'open'}`;
  }

  /** Tell the Composer the MissionQueue changed. */
  async notifyComposer({ projectId, agent, event, detail }) {
    this.composerNotices ??= new Map();
    const key = `${event}|${detail}`;
    const previous = this.composerNotices.get(projectId);
    if (previous && previous.key === key && Date.now() - previous.at < 60_000) {
      return { started: false, delivered: false, deduped: true, reason: 'the same notice was just sent' };
    }
    this.composerNotices.set(projectId, { key, at: Date.now() });
    const project = this.get(projectId);
    if (!project) return { delivered: false, reason: 'no project' };
    const record = (project.agents ?? []).filter((item) => item.role === 'composer' && item.childId && item.status !== 'failed').pop();
    if (!record?.childId) {
      const ensured = await this.ensureComposer({ projectId, agent }).catch(() => null);
      return { delivered: Boolean(ensured), started: true, childId: ensured?.childId ?? null };
    }
    const remembered = project.orchestratorSessionId ? this.ctx?.agents?.get?.(project.orchestratorSessionId) : null;
    // The Composer answers to the session that created it, never to whoever happens to call.
    const recordedParent = record.parentSessionId ? this.ctx?.agents?.get?.(record.parentSessionId) : null;
    const parent = this.parentAgents?.get(record.childId) ?? recordedParent ?? remembered ?? null;
    const queued = project.missions.filter((mission) => mission.status === 'approved').length;
    const machine = project.machines.find((item) => item.id === 'local');
    const text = [
      `MissionQueue changed (${event}${detail ? `: ${detail}` : ''}).`,
      `${queued} mission(s) approved and waiting. Machine local is ${machine?.status ?? 'unknown'}.`,
      'Apply your dispatch policy: run approved work immediately when the machine is idle; only compose ahead and invoke InfraOptimizer while it is busy.',
    ].join(' ');
    if (!parent || !this.subagents) {
      // Try to bring its parent back first; a fork here would give the project two owners.
      const revived = await this.reviveOrchestrator(project).catch(() => null);
      if (revived && this.subagents) {
        try {
          await this.subagents.sendMessage(revived, record.childId, [{ type: 'text', text }], { signal: new AbortController().signal });
          return { delivered: true, childId: record.childId, queued, revived: true };
        } catch { /* fall through to parking */ }
      }
      await this.deliverOrQueue({ projectId, sessionId: record.childId, text }).catch(() => undefined);
      return { delivered: false, queued: true, childId: record.childId, reason: 'no live composer parent yet' };
    }
    try {
      await this.subagents.sendMessage(parent, record.childId, [{ type: 'text', text }], { signal: new AbortController().signal });
    } catch {
      const leader = this.liveOrchestrator(project);
      if (leader) {
        // The recorded owner cannot be reached through its own parent; replace it under the Leader
        // rather than leaving the project with a queue owner nobody can wake.
        await this.mutate(projectId, (current) => ({
          ...current,
          agents: (current.agents ?? []).map((item) => (item.role === 'composer' && item.childId === record.childId
            ? { ...item, status: 'failed', summary: 'replaced: its parent session could not wake it', updatedAt: now() }
            : item)),
        })).catch(() => undefined);
        const restarted = await this.runComposer({ projectId, agent: leader }).catch(() => null);
        if (restarted?.childId && this.subagents) {
          await this.subagents.sendMessage(leader, restarted.childId, [{ type: 'text', text }], { signal: new AbortController().signal }).catch(() => undefined);
          return { delivered: true, childId: restarted.childId, queued, restarted: true };
        }
      }
      await this.deliverOrQueue({ projectId, sessionId: record.childId, text }).catch(() => undefined);
      return { delivered: false, queued: true, childId: record.childId, reason: 'delivery failed; notice parked' };
    }
    return { delivered: true, childId: record.childId, queued };
  }

  async claimRole(projectId, role) {
    const project = this.get(projectId);
    if ((project.agents ?? []).some((item) => item.role === role && item.status === 'running')) {
      throw new Error(`${role} is already running for this project`);
    }
    // A crashed or superseded activation leaves a stale running record; clear it first.
    await this.mutate(projectId, (current) => ({
      ...current,
      agents: (current.agents ?? []).map((item) => (
        item.role === role && item.status === 'running' ? { ...item, status: 'failed', summary: 'superseded', updatedAt: now() } : item
      )),
    }));
  }

  async runComposer({ projectId, agent }) {
    if (!agent) throw new Error('a calling Agent is required to start Composer');
    if (this.presetOfAgent && this.presetOfAgent(agent) !== 'aleph') {
      throw new Error('only the Leader session starts the Composer; a researcher must not fork the queue owner');
    }
    if (!this.subagents) throw new Error('subagent service is unavailable');
    const project = this.get(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    this.assertWorkspace(agent, project.workspace);
    await this.rememberOrchestrator(projectId, agent);
    await this.claimRole(projectId, 'composer');
    const prompt = [
      'You are MissionComposer for AlephResearch, the long-lived owner of the MissionQueue.',
      `Project: ${project.id}. Research repo: ${project.researchRoot}. Mission repo: ${project.missionRoot}. Machine: local.`,
      'You are started when the project is created, as the Leader direct child, and you stay addressable for the whole project. Researcher proposals enter the queue directly and the Host messages you whenever that queue changes. Keep the queue moving; you are the only role that decides when work runs.',
      '',
      `Machine load is not a flag. aleph_status reports sampled telemetry (cores, load average, memory, GPU utilization) plus the machine load list you maintain with aleph_machine_load, which replaces the whole list like a todo list.`,
      'Dispatch policy:',
      '- Treat the machine as free only when the sampled utilization leaves room for the next batch. A running batch reports its own load entry with its thread count.',
      '- When there is room, run approved work immediately: form a batch with aleph_form_batch and start it with aleph_run_batch, and record the new load with aleph_machine_load.',
      '- When the machine is saturated, use the waiting time productively: form the next batch and call aleph_run_infra. It returns at once; this machine keeps one long-lived InfraOptimizer, which edits the batch and then tells you through aleph_finish_infra. Start the batch when it reports back.',
      '- Never leave approved missions sitting while the machine has room, and never optimize work you could already have finished.',
      '',
      'Batch composition is your call. Delegate the mechanical work of merging branches and settling conflicts to a sub composer agent when a batch needs judgment; resolve nothing by hand in the mission repo yourself.',
      'Do not run researchers, do not edit research branches, and do not change project budgets. Report what you dispatched or prepared, with batch ids.',
    ].join('\n');
    const abort = new AbortController();
    let activation;
    try {
      activation = await this.subagents.startActivation({
        provider: 'spawn', label: `aleph composer ${project.id}`, delivery: 'caller', signal: abort.signal,
        request: { parent: agent, cwd: project.workspace, agentPreset: 'aleph-composer', prompt: [{ type: 'text', text: prompt }] },
      });
    } catch (error) {
      await this.mutate(projectId, (current) => ({ ...current, agents: [...(current.agents ?? []), { role: 'composer', childId: null, status: 'failed', summary: String(error), branch: null, worktree: null, updatedAt: now() }] }));
      throw error;
    }
    const childId = activation.childId ?? null;
    await this.mutate(projectId, (current) => ({
      ...current,
      agents: [
        ...(current.agents ?? []).filter((item) => !(item.role === 'composer' && item.status === 'running')),
        { role: 'composer', childId, status: 'running', summary: null, branch: null, worktree: null, updatedAt: now() },
      ],
    }));
    this.parentAgents ??= new Map();
    if (childId) this.parentAgents.set(childId, agent);
    // The Composer stays addressable between turns; the record closes when its session settles.
    activation.result.then(async (result) => {
      const summary = (result?.output ?? []).filter((block) => block?.type === 'text').map((block) => block.text).join('\n').trim().slice(0, 8000) || '(no summary)';
      await this.mutate(projectId, (current) => ({
        ...current,
        agents: (current.agents ?? []).map((item) => (item.role === 'composer' && item.childId === childId ? { ...item, status: 'done', summary, updatedAt: now() } : item)),
      })).catch(() => undefined);
    }, async (error) => {
      await this.mutate(projectId, (current) => ({
        ...current,
        agents: (current.agents ?? []).map((item) => (item.role === 'composer' && item.childId === childId ? { ...item, status: 'failed', summary: String(error), updatedAt: now() } : item)),
      })).catch(() => undefined);
    });
    return { projectId, role: 'composer', childId, persistent: true };
  }

  /**
   * One InfraOptimizer per machine, kept alive across batches. Its value is the machine
   * knowledge it accumulates, so it is never respawned for each batch.
   */
  async ensureInfra({ projectId, agent, machineId = 'local' }) {
    const project = this.get(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    if (!agent) throw new Error('a calling Agent is required to start InfraOptimizer');
    if (!this.subagents) throw new Error('subagent service is unavailable');
    const existing = (project.agents ?? []).find((item) => item.role === 'infra'
      && (item.machineId ?? 'local') === machineId
      && item.childId
      && item.status !== 'failed');
    if (existing) return { started: false, childId: existing.childId, machineId };
    const prompt = [
      'You are InfraOptimizer for AlephResearch, the permanent optimizer of one machine.',
      `Machine: ${machineId}. Project: ${projectId}. Workspace: ${project.workspace}.`,
      'You stay with this machine for the whole project. Each task names one batch worktree; you edit files there and only there.',
      'You never execute code: no benchmarks, no smoke runs, no profiling commands, no training, no dependency installs, no tests. The machine is serving a running batch, so execution steals capacity and measures the wrong thing.',
      'Optimize by reading and editing: thread and process limits, batching, import cost, allocation, precision, caching, data loading and I/O. Carry forward what you learned from earlier batches of this machine.',
      'When a task is finished, call aleph_finish_infra with the project id and batch id. The Host then commits the worktree and records the result.',
    ].join('\n');
    const abort = new AbortController();
    const activation = await this.subagents.startActivation({
      provider: 'spawn',
      label: `aleph infra ${machineId}`,
      delivery: 'caller',
      signal: abort.signal,
      request: { parent: agent, cwd: project.workspace, agentPreset: 'aleph-infra', prompt: [{ type: 'text', text: prompt }] },
    });
    const childId = activation.childId ?? null;
    this.parentAgents ??= new Map();
    if (childId && agent) this.parentAgents.set(childId, agent);
    await this.mutate(projectId, (current) => ({
      ...current,
      agents: [...(current.agents ?? []), { role: 'infra', machineId, childId, status: 'running', summary: null, branch: null, updatedAt: now() }],
    }));
    // The session outlives a turn, so a settled turn returns the role to waiting, not to dead.
    activation.result
      .then((result) => {
        const text = (result?.output ?? []).filter((block) => block?.type === 'text').map((block) => block.text).join('\n').trim();
        return this.mutate(projectId, (current) => ({
          ...current,
          agents: (current.agents ?? []).map((item) => (item.role === 'infra' && item.childId === childId
            ? { ...item, status: 'waiting', summary: text ? text.slice(0, 800) : item.summary ?? null, updatedAt: now() }
            : item)),
        }));
      })
      .catch(() => undefined);
    return { started: true, childId, machineId };
  }

  /** Hand one batch worktree to the machine's InfraOptimizer and return at once. */
  async runInfra({ projectId, batchId, agent }) {
    const project = this.get(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    const batch = project.batches.find((item) => item.id === batchId);
    if (!batch) throw new Error(`batch not found: ${batchId}`);
    if (batch.status !== 'forming') throw new Error(`batch ${batchId} is not forming`);
    if (batch.infra?.status === 'requested') throw new Error(`batch ${batchId} is already with InfraOptimizer`);
    const infra = await this.ensureInfra({ projectId, agent, machineId: batch.machineId ?? 'local' });
    const worktreeRoot = join(project.workspace, '.aleph', 'infra');
    const worktree = join(worktreeRoot, batchId);
    await mkdir(worktreeRoot, { recursive: true });
    await rm(worktree, { recursive: true, force: true });
    const baseTip = (await git(project.missionRoot, ['rev-parse', batch.branch])).stdout.trim();
    await git(project.missionRoot, ['worktree', 'add', '--detach', worktree, batch.branch]);
    await this.mutate(projectId, (current) => ({
      ...current,
      batches: (current.batches ?? []).map((item) => (item.id === batchId
        ? { ...item, infra: { status: 'requested', worktree, baseTip, childId: infra.childId ?? null, requestedAt: now() } }
        : item)),
    }));
    const task = [
      `Batch ${batch.id} is prepared and waiting for your optimization.`,
      `Worktree: ${worktree}. Mission ids: ${(batch.missionIds ?? []).join(', ') || 'none'}.`,
      'Read the batch entrypoint, the mission code and the manifests, then edit what limits this machine. Do not run anything.',
      `When done, call aleph_finish_infra with project_id ${projectId} and batch_id ${batchId}.`,
    ].join('\n');
    const sent = infra.childId
      ? await this.notifySession({ sessionId: infra.childId, text: task }).catch(() => ({ delivered: false }))
      : { delivered: false };
    // An unacknowledged message usually still lands once the session resumes, so the task
    // stays requested; the watchdog fails it only if nothing happens for too long.
    if (!sent?.delivered) {
      await this.mutate(projectId, (current) => ({
        ...current,
        batches: (current.batches ?? []).map((item) => (item.id === batchId
          ? { ...item, infra: { ...(item.infra ?? {}), delivery: 'unconfirmed' } }
          : item)),
      }));
    }
    return { projectId, batchId, machineId: batch.machineId ?? 'local', childId: infra.childId, worktree, dispatched: true, delivery: sent?.delivered ? 'sent' : 'queued' };
  }

  /**
   * Dispatch queued work when the queue owner cannot be woken at all.
   *
   * The Composer is a subagent, so waking it needs a live parent session. When the
   * Leader session is cold, every notification is parked and the research loop would
   * stop with work approved and the machine idle. Dispatching is then the same action
   * the Composer's policy prescribes, so the Host does it and records why.
   */
  async mechanicalDispatch(project) {
    const machine = (project.machines ?? []).find((item) => item.id === 'local');
    if (!machine || machine.status !== 'idle') return { dispatched: false, reason: 'machine is not idle' };
    const running = (project.batches ?? []).find((batch) => batch.status === 'running');
    if (running) return { dispatched: false, reason: 'a batch is already running' };
    // A batch prepared by an earlier Composer turn may be waiting for a start nobody can issue.
    const prepared = (project.batches ?? []).find((batch) => batch.status === 'forming');
    if (prepared) {
      if (prepared.infra?.status === 'requested') return { dispatched: false, reason: 'the prepared batch is still with InfraOptimizer' };
      try {
        this.startBatch({ projectId: project.id, batchId: prepared.id });
        await this.mutate(project.id, (current) => ({
          ...current,
          violations: [...(current.violations ?? []), `${now()} the Host started prepared batch ${prepared.id}: the Composer could not be woken`].slice(-50),
        })).catch(() => undefined);
        return { dispatched: true, batchId: prepared.id, started: true };
      } catch (error) {
        return { dispatched: false, reason: String(error?.message ?? error) };
      }
    }
    const queued = (project.missions ?? []).filter((mission) => mission.status === 'approved');
    if (queued.length === 0) return { dispatched: false, reason: 'nothing queued' };
    try {
      const formed = await this.formBatch({ projectId: project.id, machineId: machine.id });
      const batch = formed.batches[formed.batches.length - 1];
      if (!batch) return { dispatched: false, reason: 'no batch formed' };
      this.startBatch({ projectId: project.id, batchId: batch.id });
      await this.mutate(project.id, (current) => ({
        ...current,
        violations: [...(current.violations ?? []), `${now()} the Host dispatched batch ${batch.id}: the Composer could not be woken`].slice(-50),
      })).catch(() => undefined);
      return { dispatched: true, batchId: batch.id };
    } catch (error) {
      return { dispatched: false, reason: String(error?.message ?? error) };
    }
  }

  /** Settle a batch whose runner exited without reporting. */
  async finishDeadBatch({ projectId, batchId, reason = 'the batch runner exited without reporting' }) {
    const project = this.get(projectId);
    const batch = (project?.batches ?? []).find((item) => item.id === batchId);
    if (!batch || batch.status !== 'running') return { settled: false };
    const worktree = join(project.workspace, '.aleph', 'batches', batchId);
    const orphans = this.killUnder(worktree);
    await git(project.missionRoot, ['worktree', 'remove', '--force', worktree]).catch(() => undefined);
    await rm(worktree, { recursive: true, force: true }).catch(() => undefined);
    await this.mutate(projectId, (current) => ({
      ...current,
      machines: current.machines.map((machine) => {
        if (machine.id !== batch.machineId) return machine;
        const loads = (machine.loads ?? []).filter((entry) => entry.id !== batchId);
        return { ...machine, status: loads.length === 0 ? 'idle' : 'busy', batchId: loads.length === 0 ? null : machine.batchId, loads, telemetry: this.sampleTelemetry() };
      }),
      batches: current.batches.map((item) => (item.id === batchId
        ? { ...item, status: 'failed', finishedAt: now(), summary: { ...(item.summary ?? {}), runnerError: reason } }
        : item)),
    }));
    await this.notifyComposer({ projectId, agent: null, event: 'batch runner exited', detail: `${batchId}: ${reason}` }).catch(() => undefined);
    return { settled: true, orphans };
  }

  /** Release a batch whose optimizer never reported back. */
  async releaseStalledInfra({ projectId, batchId, reason = 'the optimizer never reported back' }) {
    const project = this.get(projectId);
    const batch = (project?.batches ?? []).find((item) => item.id === batchId);
    if (!batch?.infra || batch.infra.status !== 'requested') return { released: false };
    const worktree = batch.infra.worktree;
    await git(project.missionRoot, ['worktree', 'remove', '--force', worktree]).catch(() => undefined);
    await rm(worktree, { recursive: true, force: true }).catch(() => undefined);
    await this.mutate(projectId, (current) => ({
      ...current,
      batches: (current.batches ?? []).map((item) => (item.id === batchId
        ? { ...item, infra: { ...(item.infra ?? {}), status: 'failed', summary: reason, finishedAt: now() } }
        : item)),
    }));
    await this.notifyComposer({ projectId, agent: null, event: 'infra released', detail: `batch ${batchId}: ${reason}` }).catch(() => undefined);
    return { released: true };
  }

  /** Commit what InfraOptimizer changed and release the batch back to the queue. */
  async finishInfra({ projectId, batchId }) {
    const project = this.get(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    const batch = project.batches.find((item) => item.id === batchId);
    if (!batch) throw new Error(`batch not found: ${batchId}`);
    if (!batch.infra || batch.infra.status !== 'requested') throw new Error(`batch ${batchId} is not with InfraOptimizer`);
    const worktree = batch.infra.worktree;
    const handoff = await readFile(join(worktree, 'ALEPH_HANDOFF.md'), 'utf8').catch(() => '');
    const dirty = (await git(worktree, ['status', '--porcelain']).catch(() => ({ stdout: '' }))).stdout.trim();
    let commit = null;
    if (dirty) {
      const summary = (handoff || 'infra optimization').trim();
      await git(worktree, ['add', '-A']);
      await git(worktree, ['-c', 'user.name=AlephResearch', '-c', 'user.email=aleph@localhost', 'commit', '-m', `infra optimization for ${batchId}\n\n${summary.slice(0, 4000)}`]);
      const tip = (await git(worktree, ['rev-parse', 'HEAD'])).stdout.trim();
      // Compare-and-swap keeps a concurrent advance of the batch branch from being clobbered.
      await git(project.missionRoot, ['update-ref', `refs/heads/${batch.branch}`, tip, batch.infra.baseTip]);
      commit = tip;
    }
    await git(project.missionRoot, ['worktree', 'remove', '--force', worktree]).catch(() => undefined);
    await rm(worktree, { recursive: true, force: true }).catch(() => undefined);
    await this.mutate(projectId, (current) => ({
      ...current,
      batches: (current.batches ?? []).map((item) => (item.id === batchId
        ? {
          ...item,
          infra: { ...(item.infra ?? {}), status: 'done', commit, summary: handoff.trim().slice(0, 4000), finishedAt: now() },
          summary: { ...(item.summary ?? {}), infra: { commit, changed: Boolean(dirty) } },
        }
        : item)),
    }));
    await this.notifyComposer({
      projectId,
      agent: null,
      event: 'infra finished',
      detail: commit ? `batch ${batchId} was optimized in ${commit}` : `batch ${batchId} needed no change`,
    }).catch(() => undefined);
    return { projectId, batchId, commit, changed: Boolean(dirty) };
  }

  async formBatch({ projectId, machineId = 'local' }) {
    const project = this.get(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    const machine = project.machines.find((item) => item.id === machineId);
    if (!machine) throw new Error(`machine not found: ${machineId}`);
    // Prepared work may wait behind the batch that is running: that queue is the point.
    // Only a second *prepared* batch is refused, because the queue depth is one.
    const prepared = (project.batches ?? []).find((batch) => batch.machineId === machineId && batch.status === 'forming');
    if (prepared) throw new Error(`machine ${machineId} already has forming batch ${prepared.id}`);
    const approvedAll = project.missions.filter((mission) => mission.status === 'approved');
    const terminalBranches = new Set(project.missions.filter((mission) => ['done', 'failed', 'batched'].includes(mission.status)).map((mission) => mission.branch));
    const seenBranches = new Set();
    const approved = approvedAll.filter((mission) => {
      if (terminalBranches.has(mission.branch)) return false;
      if (seenBranches.has(mission.branch)) return false;
      seenBranches.add(mission.branch);
      return true;
    });
    if (approved.length === 0) throw new Error('no approved missions');
    const batchId = newId('b');
    const batchBranch = `batch/${batchId}`;
    const baseTip = (await git(project.missionRoot, ['rev-parse', project.templateBranch])).stdout.trim();
    await git(project.missionRoot, ['switch', '-c', batchBranch, project.templateBranch]);
    const preBatch = {};
    for (const mission of approved) {
      preBatch[mission.id] = (await git(project.missionRoot, ['rev-parse', mission.branch])).stdout.trim();
      try {
        await git(project.missionRoot, ['-c', 'user.name=AlephResearch', '-c', 'user.email=aleph@localhost', 'merge', '--no-ff', '-m', `merge mission ${mission.id}`, mission.branch]);
      } catch (error) {
        // Bookkeeping files carry no mission logic; keep the batch side and continue.
        const conflicted = (await git(project.missionRoot, ['diff', '--name-only', '--diff-filter=U']).catch(() => ({ stdout: '' }))).stdout.split(/\r?\n/).filter(Boolean);
        const trivial = conflicted.length > 0 && conflicted.every((path) => BOOKKEEPING_PATHS.has(path));
        if (trivial) {
          await git(project.missionRoot, ['checkout', '--ours', '--', ...conflicted]).catch(() => undefined);
          await git(project.missionRoot, ['add', '-A']);
          await git(project.missionRoot, ['-c', 'user.name=AlephResearch', '-c', 'user.email=aleph@localhost', 'commit', '--no-edit']).catch(() => undefined);
          continue;
        }
        await git(project.missionRoot, ['merge', '--abort']).catch(() => undefined);
        await git(project.missionRoot, ['switch', project.templateBranch]);
        throw new Error(`merge conflict for mission ${mission.id}; Composer must resolve it before batching`);
      }
    }
    await git(project.missionRoot, ['switch', project.templateBranch]);
    return this.mutate(projectId, (current) => ({
      ...current,
      machines: current.machines.map((item) => (item.id === machineId ? { ...item, batchId } : item)),
      missions: current.missions.map((mission) => {
        if (approved.some((item) => item.id === mission.id)) {
          return { ...mission, status: 'batched', batchId, preBatchTip: preBatch[mission.id] };
        }
        if (mission.status === 'approved' && (approved.some((item) => item.branch === mission.branch) || terminalBranches.has(mission.branch))) {
          return { ...mission, status: 'failed', error: 'branch already has a terminal mission; propose a new branch', finishedAt: now() };
        }
        return mission;
      }),
      batches: [...current.batches, {
        id: batchId,
        machineId,
        status: 'forming',
        missionIds: approved.map((mission) => mission.id),
        branch: batchBranch,
        baseTip,
        createdAt: now(),
      }],
    }));
  }
}

async function gitSnapshot(project) {
  const safe = async (root, args) => {
    try { return (await git(root, args)).stdout.trim(); } catch { return ''; }
  };
  const repo = async (root) => {
    const branchText = await safe(root, ['for-each-ref', '--format=%(refname:short)	%(objectname:short)	%(subject)	%(committerdate:short)', 'refs/heads']);
    const branches = branchText.split(/\r?\n/).filter(Boolean).map((line) => {
      const [name, tip, subject, date] = line.split('\t');
      return { name, tip, subject, date };
    });
    const worktreeText = await safe(root, ['worktree', 'list', '--porcelain']);
    const worktrees = [];
    let current = null;
    for (const line of worktreeText.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) { if (current) worktrees.push(current); current = { path: line.slice(9), head: '', branch: '' }; }
      else if (current && line.startsWith('HEAD ')) current.head = line.slice(5);
      else if (current && line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//, '');
    }
    if (current) worktrees.push(current);
    const commitText = await safe(root, ['log', '--all', '--date=short', '--format=%h	%d	%s	%ad', '-n', '30']);
    const commits = commitText.split(/\r?\n/).filter(Boolean).map((line) => {
      const [hash, refs, subject, date] = line.split('\t');
      return { hash, refs: refs.trim().replace(/^\((.*)\)$/, '$1'), subject, date };
    });
    return { root, branches, worktrees, commits };
  };
  return { research: await repo(project.researchRoot), missions: await repo(project.missionRoot) };
}

function snapshot(project, options = {}) {
  return {
    schema: 2,
    generated_at: now(),
    project: {
      id: project.id,
      title: project.workspace.split('/').pop() || 'Aleph project',
      status: 'running',
      workspace: project.workspace,
      research_root: project.researchRoot,
      mission_root: project.missionRoot,
      template_branch: project.templateBranch,
      eval_command: project.evalCommand,
      eval_root: project.evalRoot ?? null,
      conventions: project.conventions ?? null,
      orchestrator_session: project.orchestratorSessionId ?? null,
      best: project.best ?? null,
      evaluations: (project.evaluations ?? []).slice(-20),
      brief: project.brief ?? '',
      researcher_count: project.researcherCount ?? 4,
      exploration: project.exploration ?? 'normal',
      paused: Boolean(project.paused),
      bootstrap: project.bootstrap ?? null,
      prepared: project.prepared === true,
      python_path: project.pythonPath ?? null,
      visible_data: project.visibleData ?? null,
      testset_path: project.testsetPath ?? null,
      submission_python: project.submissionPython ?? null,
      violations: (project.violations ?? []).slice(-20),
    },
    missions: project.missions.map((mission) => ({
      id: mission.id,
      owner_session: mission.ownerSession,
      status: mission.status,
      branch: mission.branch,
      manifest_id: mission.manifestId ?? null,
      kind: mission.kind ?? null,
      title: mission.title ?? null,
      summary: mission.summary ?? null,
      manifest_path: mission.manifestPath ?? null,
      entrypoint: mission.entrypoint ?? null,
      batch_id: mission.batchId,
      pre_batch_tip: mission.preBatchTip ?? null,
      result_commit: mission.resultCommit ?? null,
      error: mission.error ?? null,
      created_at: mission.createdAt,
      approved_at: mission.approvedAt ?? null,
      finished_at: mission.finishedAt ?? null,
    })),
    batches: project.batches.map((batch) => ({
      id: batch.id,
      machine_id: batch.machineId,
      status: batch.status,
      mission_ids: batch.missionIds,
      branch: batch.branch,
      base_tip: batch.baseTip ?? null,
      created_at: batch.createdAt,
      started_at: batch.startedAt ?? null,
      infra: batch.infra ?? null,
      finished_at: batch.finishedAt ?? null,
      summary: batch.summary ?? null,
    })),
    progress: options.liveProgress ? options.liveProgress(project) : null,
    machines: project.machines.map((machine) => ({
      ...machine,
      loads: machine.loads ?? [],
      telemetry: options.telemetry ? options.telemetry(project, machine) : (machine.telemetry ?? null),
    })),
    agents: project.agents ?? [],
    counts: {
      // Batched missions wait inside their batch; one batch entrypoint runs them in order.
      queued: project.missions.filter((mission) => ['proposed', 'approved', 'batched'].includes(mission.status)).length,
      running: project.missions.filter((mission) => mission.status === 'running').length,
      done: project.missions.filter((mission) => mission.status === 'done').length,
      failed: project.missions.filter((mission) => mission.status === 'failed').length,
    },
  };
}

export const inject = ['storageDomain', 'tools', 'webServer', 'agents'];

export async function apply(ctx) {
  const domain = await ctx.storageDomain.open(projectDomain);
  ctx.effect(() => () => { void domain.close(); });
  const sessions = ctx.get('sessions');
  const subagents = ctx.get('subagents');
  const agentPresets = ctx.get('agentPresets');
  const sessionQuery = ctx.get('sessionQuery');
  const agentDefaultModel = ctx.get('agentDefaultModel');
  const workspaceRegistry = ctx.get('workspaceRegistry');
  const service = new ProjectService(ctx, domain, { sessions, subagents, agentPresets, sessionQuery, agentDefaultModel });
  ctx.effect(() => { const timer = setInterval(() => service.checkProcesses(), 5000); timer.unref?.(); return () => clearInterval(timer); });
  service.recoverAfterRestart().then(
    (summary) => { if (summary) console.warn('[aleph] restart recovery', summary); },
    (error) => console.warn('[aleph] restart recovery failed', error?.message ?? error),
  );

  const presetOf = (agent) => {
    if (!sessions || !agentPresets) return null;
    const session = sessions.get(agent?.id);
    return session ? agentPresets.presetForSession(session) : null;
  };
  const isAleph = (agent) => ['aleph', 'aleph-researcher', 'aleph-composer', 'aleph-infra'].includes(presetOf(agent));
  const isLeader = (agent) => presetOf(agent) === 'aleph';
  const isComposer = (agent) => presetOf(agent) === 'aleph-composer';
  const isInfra = (agent) => presetOf(agent) === 'aleph-infra';
  const projectIdParam = { project_id: { type: 'string', required: true, description: 'Project id' } };

  const disposers = [
    ctx.tools.register(tool(
      'aleph_init_project',
      'Initialize the DSH project: research repo, mission template repo, machine registry and queues.',
      {
        workspace: { type: 'string', description: 'Absolute workspace path; defaults to the session cwd' },
        eval_command: { type: 'string', description: 'Research evaluator command' },
        eval_root: { type: 'string', description: 'Directory the evaluator runs from' },
        conventions: { type: 'string', description: 'Project-specific conventions written into the mission template' },
        visible_data: { type: 'string' },
        testset: { type: 'string' },
        submission_python: { type: 'string' },
        researchers: { type: 'integer', description: 'Default researcher count (default 4)' },
        brief: { type: 'string', description: 'Research objective for researcher prompts' },
      },
      async (args, exec) => service.init({
        workspace: service.workspaceFor(exec.agent, args.workspace),
        evalCommand: args.eval_command,
        evalRoot: args.eval_root ?? null,
        conventions: args.conventions ?? null,
        visibleData: args.visible_data,
        testsetPath: args.testset,
        submissionPython: args.submission_python,
        pythonPath: args.python ?? null,
        researchers: args.researchers ?? 4,
        brief: args.brief ?? '',
        agent: exec.agent,
      }),
    ), { when: ({ agent }) => isLeader(agent) }),
    ctx.tools.register(tool(
      'aleph_list_missions',
      'List all missions with status, branch, result commit and result path; use before repeating analysis.',
      { ...projectIdParam },
      async (args) => service.listMissions({ projectId: args.project_id }),
    ), { when: ({ agent }) => isAleph(agent) }),
    ctx.tools.register(tool(
      'aleph_machine_load',
      'Replace the load list for a machine, like writing a todo list: what is actually running and how much it is expected to use. The machine is idle exactly when the list is empty.',
      {
        ...projectIdParam,
        machine_id: { type: 'string', description: 'Machine id, default local' },
        loads: {
          type: 'array',
          description: 'Complete list of active loads; pass an empty list to mark the machine idle',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              kind: { type: 'string' },
              label: { type: 'string' },
              cpu: { type: 'number' },
              memGb: { type: 'number' },
              vramMb: { type: 'number' },
            },
            additionalProperties: false,
          },
        },
      },
      async (args) => service.setMachineLoad({ projectId: args.project_id, machineId: args.machine_id ?? 'local', loads: args.loads ?? [] }),
    ), { when: ({ agent }) => isAleph(agent) }),
    ctx.tools.register(tool(
      'aleph_status',
      'Return projects, missions, batches and machines.',
      { project_id: { type: 'string', description: 'Optional project id' } },
      async (args) => (args.project_id ? [service.get(args.project_id)].filter(Boolean) : service.list())
        .map((project) => snapshot(project, { telemetry: () => service.sampleTelemetry(), liveProgress: (item) => service.liveProgress(item) })),
    ), { when: ({ agent }) => isAleph(agent) }),
    ctx.tools.register(tool(
      'aleph_set_python',
      'Leader pins the shared Python executable used by researchers and missions.',
      { ...projectIdParam, python: { type: 'string', required: true, description: 'Python executable path' } },
      async (args) => service.setPython({ projectId: args.project_id, pythonPath: args.python }),
    ), { when: ({ agent }) => isLeader(agent) }),
    ctx.tools.register(tool(
      'aleph_start_project',
      'Start the research loop: prepare the scaffold from the data the project offers and start the opening researcher with your assignment.',
      { ...projectIdParam, instruction: { type: 'string', description: 'Opening assignment for the first researcher' } },
      async (args, exec) => {
        const project = service.get(args.project_id);
        if (!project) throw new Error(`project not found: ${args.project_id}`);
        return service.scaffoldResearch({
          projectId: args.project_id,
          title: project.workspace.split('/').pop() || 'Research project',
          dataSources: [],
          pythonPath: project.pythonPath ?? null,
          conventions: project.conventions ?? null,
          instruction: args.instruction ?? null,
          agent: exec.agent,
        });
      },
    ), { when: ({ agent }) => isLeader(agent) }),
    ctx.tools.register(tool(
      'aleph_create_research_scaffold',
      'Leader creates the initial research project before any researcher starts.',
      { ...projectIdParam, title: { type: 'string', description: 'Research project title' }, data: { type: 'array', items: { type: 'string' }, description: 'Data sources to copy into the research project' }, python: { type: 'string', description: 'Shared Python executable for researchers and missions' } },
      async (args, exec) => service.scaffoldResearch({ projectId: args.project_id, title: args.title ?? 'Research project', dataSources: args.data, pythonPath: args.python, agent: exec.agent }),
    ), { when: ({ agent }) => isLeader(agent) }),
    ctx.tools.register(tool(
      'aleph_start_mission',
      'Create a mission branch from the template and return its worktree for the researcher to fill.',
      { ...projectIdParam, name: { type: 'string', description: 'Short mission name' } },
      async (args) => service.startMission({ projectId: args.project_id, name: args.name ?? 'mission' }),
    ), { when: ({ agent }) => isAleph(agent) }),
    ctx.tools.register(tool(
      'aleph_create_mission',
      'Create a ready-to-run mission in one call: branch, worktree, mission.json with kind/title/summary, executable run.sh, main.py stub and pyproject. Fill main.py, commit, then propose it.',
      {
        ...projectIdParam,
        name: { type: 'string', required: true, description: 'Short mission name, used for the directory and slug' },
        kind: { type: 'string', description: 'analysis, training or other' },
        title: { type: 'string', description: 'One-line title shown in aleph_list_missions' },
        summary: { type: 'string', description: 'One-line summary of the question the mission answers' },
        dependencies: { type: 'array', items: { type: 'string' }, description: 'Python distributions for the mission pyproject' },
      },
      async (args, exec) => service.createMission({
        projectId: args.project_id,
        name: args.name,
        kind: args.kind ?? 'analysis',
        title: args.title ?? null,
        summary: args.summary ?? null,
        dependencies: args.dependencies ?? [],
        agent: exec.agent,
      }),
    ), { when: ({ agent }) => isAleph(agent) }),
    ctx.tools.register(tool(
      'aleph_propose_mission',
      'Register a mission branch created by the researcher; Leader approval is required before batching.',
      {
        ...projectIdParam,
        branch: { type: 'string', required: true, description: 'Mission branch in the mission repo' },
      },
      async (args, exec) => service.propose({ projectId: args.project_id, branch: args.branch, agent: exec.agent }),
    ), { when: ({ agent }) => isAleph(agent) }),
    ctx.tools.register(tool(
      'aleph_form_batch',
      'MissionComposer entry: merge approved missions into a machine-bound batch branch.',
      { ...projectIdParam, machine_id: { type: 'string', description: 'Machine id, default local' } },
      async (args) => service.formBatch({ projectId: args.project_id, machineId: args.machine_id ?? 'local' }),
    ), { when: ({ agent }) => isAleph(agent) }),
    ctx.tools.register(tool(
      'aleph_adopt_mission',
      'Copy a finished mission code and results into your research worktree for adoption.',
      { ...projectIdParam, mission_id: { type: 'string', required: true }, dir: { type: 'string', description: 'Destination directory inside the worktree, default adopted' } },
      async (args, exec) => service.adoptMission({ projectId: args.project_id, missionId: args.mission_id, agent: exec.agent, dir: args.dir ?? null }),
    ), { when: ({ agent }) => isAleph(agent) }),
    ctx.tools.register(tool(
      'aleph_pause_project',
      'Stop dispatching new work. Running batches and researchers are left to finish.',
      { ...projectIdParam, reason: { type: 'string', description: 'Why the project is paused' } },
      async (args) => service.pauseProject({ projectId: args.project_id, reason: args.reason ?? null }),
    ), { when: ({ agent }) => isLeader(agent) || isComposer(agent) }),
    ctx.tools.register(tool(
      'aleph_resume_project',
      'Allow dispatching again after a pause.',
      { ...projectIdParam },
      async (args) => service.resumeProject({ projectId: args.project_id }),
    ), { when: ({ agent }) => isLeader(agent) || isComposer(agent) }),
    ctx.tools.register(tool(
      'aleph_cancel_batch',
      'Cancel one batch: stop its processes, release the machine and mark its missions cancelled.',
      { ...projectIdParam, batch_id: { type: 'string', required: true }, reason: { type: 'string' } },
      async (args) => service.cancelBatch({ projectId: args.project_id, batchId: args.batch_id, reason: args.reason ?? 'cancelled by the operator' }),
    ), { when: ({ agent }) => isLeader(agent) || isComposer(agent) }),
    ctx.tools.register(tool(
      'aleph_evaluate',
      'Evaluate the research branch after all missions owned by this researcher are done; Host writes the report into the research commit message.',
      { ...projectIdParam },
      async (args, exec) => service.evaluate({ projectId: args.project_id, agent: exec.agent }),
    ), { when: ({ agent }) => isAleph(agent) }),
    ctx.tools.register(tool(
      'aleph_run_researcher',
      'Start a researcher subagent in the research repo; it proposes missions and waits only for its own missions.',
      { ...projectIdParam },
      async (args, exec) => service.startResearcher({ projectId: args.project_id, agent: exec.agent }),
    ), { when: ({ agent }) => isLeader(agent) }),
    ctx.tools.register(tool(
      'aleph_set_exploration',
      'Set how many researchers stay alive as they finish: low stops after the current cohort, normal keeps half the cohort, high keeps it full.',
      { ...projectIdParam, level: { type: 'string', required: true, description: 'low, normal or high' } },
      async (args) => service.setExploration({ projectId: args.project_id, level: args.level }),
    ), { when: ({ agent }) => isLeader(agent) }),
    ctx.tools.register(tool(
      'aleph_run_researchers',
      'Start researcher subagents, each with its own worktree and branch. Write their opening assignment: what to investigate and why.',
      {
        ...projectIdParam,
        count: { type: 'integer', description: 'Optional count; defaults to the project researcher count' },
        instruction: { type: 'string', description: 'Opening assignment shared by the cohort' },
        instructions: { type: 'array', items: { type: 'string' }, description: 'One opening assignment per researcher, aligned with cohort order' },
      },
      async (args, exec) => service.startResearchers({
        projectId: args.project_id,
        count: args.count,
        instruction: args.instruction ?? null,
        instructions: args.instructions ?? null,
        agent: exec.agent,
      }),
    ), { when: ({ agent }) => isLeader(agent) }),
    ctx.tools.register(tool(
      'aleph_run_composer',
      'Start MissionComposer to inspect the approved queue and form a machine-bound batch.',
      { ...projectIdParam },
      async (args, exec) => service.runComposer({ projectId: args.project_id, agent: exec.agent }),
    ), { when: ({ agent }) => isLeader(agent) }),
    ctx.tools.register(tool(
      'aleph_run_infra',
      'Hand a prepared batch to this machine InfraOptimizer. Returns at once; it edits files and reports back with aleph_finish_infra.',
      { ...projectIdParam, batch_id: { type: 'string', required: true } },
      async (args, exec) => service.runInfra({ projectId: args.project_id, batchId: args.batch_id, agent: exec.agent }),
    ), { when: ({ agent }) => isComposer(agent) || isLeader(agent) }),
    ctx.tools.register(tool(
      'aleph_finish_infra',
      'Report that the optimization of a batch is complete. The Host commits the worktree and returns the batch to the queue.',
      { ...projectIdParam, batch_id: { type: 'string', required: true } },
      async (args, exec) => {
        const record = (service.get(args.project_id)?.agents ?? []).find((item) => item.role === 'infra' && item.childId === exec.agent?.id);
        if (!record) throw new Error('only this project InfraOptimizer may finish a batch');
        return service.finishInfra({ projectId: args.project_id, batchId: args.batch_id });
      },
    ), { when: ({ agent }) => isInfra(agent) }),
    ctx.tools.register(tool(
      'aleph_run_batch',
      'Run a formed machine-bound batch, write per-mission result envelopes and cherry-pick results to pre-batch mission branches.',
      { ...projectIdParam, batch_id: { type: 'string', required: true } },
      async (args) => service.startBatch({ projectId: args.project_id, batchId: args.batch_id }),
    ), { when: ({ agent }) => isAleph(agent) }),
  ];
  ctx.effect(() => () => { for (const dispose of disposers) dispose(); });

  const sendJson = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
    res.end(text);
  };
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/aleph/snapshot',
    async handler(req, res) {
      const project = service.list().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (!project) return sendJson(res, 404, { ok: false, error: { code: 'aleph/no-project' } });
      const body = snapshot(project, {
        telemetry: () => service.sampleTelemetry(),
        liveProgress: (item) => service.liveProgress(item),
      });
      body.git = await gitSnapshot(project);
      return sendJson(res, 200, body);
    },
  });
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/aleph/projects',
    handler(req, res) {
      return sendJson(res, 200, { projects: service.list().map((project) => snapshot(project, { telemetry: () => service.sampleTelemetry(), liveProgress: (item) => service.liveProgress(item) })) });
    },
  });
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/aleph/init',
    async handler(req, res) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false });
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const args = body ? JSON.parse(body) : {};
        const project = await service.init({
          workspace: args.workspace,
          evalCommand: args.evalCommand ?? args.eval_command,
          evalRoot: args.evalRoot ?? args.eval_root ?? null,
          conventions: args.conventions ?? null,
          visibleData: args.visibleData ?? args.visible_data,
          testsetPath: args.testset ?? args.testsetPath,
          submissionPython: args.submissionPython ?? args.submission_python,
          pythonPath: args.python ?? args.python_path ?? null,
          researchers: args.researchers ?? 4,
          brief: args.brief ?? '',
        });
        return sendJson(res, 200, snapshot(project));
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: { code: 'aleph/init-failed', message: String(error?.message ?? error) } });
      }
    },
  });
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/aleph/workspace',
    async handler(req, res) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false });
      const registry = workspaceRegistry ?? ctx.get('workspaceRegistry');
      if (!registry) return sendJson(res, 503, { ok: false, error: { code: 'aleph/workspace-unavailable' } });
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const args = body ? JSON.parse(body) : {};
        const workspace = await registry.create(args.path);
        return sendJson(res, 200, { workspace: { id: workspace.workspaceId, path: workspace.path, title: workspace.title } });
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: { code: 'aleph/workspace-failed', message: String(error?.message ?? error) } });
      }
    },
  });
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/aleph/health',
    handler(req, res) {
      return sendJson(res, 200, { ok: true, version: '0.3.0', storage: DOMAIN_NAME });
    },
  });
  // Operator automation: drive the mission pipeline without an LLM turn, so a case can be
  // replayed headlessly. Only missions whose branch has no terminal mission are approved.
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/aleph/set-python',
    async handler(req, res) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false });
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const args = body ? JSON.parse(body) : {};
        const result = await service.setPython({
          projectId: args.project_id ?? args.projectId,
          pythonPath: args.python,
        });
        return sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: { code: 'aleph/set-python-failed', message: String(error?.message ?? error) } });
      }
    },
  });
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/aleph/scaffold',
    async handler(req, res) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false });
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const args = body ? JSON.parse(body) : {};
        const projectId = args.project_id ?? args.projectId;
        const result = await service.scaffoldResearch({
          projectId,
          title: args.title ?? 'Research project',
          dataSources: args.data ?? [],
          pythonPath: args.python ?? null,
          conventions: args.conventions ?? null,
        });
        return sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: { code: 'aleph/scaffold-failed', message: String(error?.message ?? error) } });
      }
    },
  });
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/aleph/batch',
    async handler(req, res) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false });
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const args = body ? JSON.parse(body) : {};
        const projectId = args.project_id ?? args.projectId;
        const formed = await service.formBatch({ projectId, machineId: args.machine_id ?? 'local' });
        const batch = formed.batches[formed.batches.length - 1];
        return sendJson(res, 200, { ok: true, batch: { id: batch.id, mission_ids: batch.missionIds, branch: batch.branch } });
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: { code: 'aleph/batch-failed', message: String(error?.message ?? error) } });
      }
    },
  });
  // Retry a terminal batch: failed missions go back to the approved queue and a fresh
  // batch is formed from the same mission branches.
  // Operator visibility into the Composer channel: start it, or poke it and report the outcome.
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/aleph/recover',
    async handler(req, res) {
      try {
        const summary = await service.recoverAfterRestart();
        return sendJson(res, 200, { ok: true, summary });
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: { code: 'aleph/recover-failed', message: String(error?.stack ?? error?.message ?? error) } });
      }
    },
  });
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/aleph/composer',
    async handler(req, res) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false });
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const args = body ? JSON.parse(body) : {};
        const projectId = args.project_id ?? args.projectId;
        const action = args.action ?? 'notify';
        if (action === 'ensure') {
          return sendJson(res, 200, { ok: true, ...(await service.ensureComposer({ projectId, agent: null })) });
        }
        const result = await service.notifyComposer({ projectId, agent: null, event: 'operator poke' });
        return sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: { code: 'aleph/composer-failed', message: String(error?.stack ?? error?.message ?? error) } });
      }
    },
  });
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/aleph/select-best',
    async handler(req, res) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false });
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const args = body ? JSON.parse(body) : {};
        const result = await service.selectBest({ projectId: args.project_id ?? args.projectId, branch: args.branch ?? 'main' });
        return sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: { code: 'aleph/select-best-failed', message: String(error?.message ?? error) } });
      }
    },
  });
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/aleph/pause',
    async handler(req, res) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false });
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const args = body ? JSON.parse(body) : {};
        return sendJson(res, 200, { ok: true, ...(await service.pauseProject({ projectId: args.projectId ?? args.project_id, reason: args.reason ?? null })) });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: { code: 'aleph/pause-failed', message: String(error?.message ?? error) } });
      }
    },
  });
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/aleph/resume',
    async handler(req, res) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false });
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const args = body ? JSON.parse(body) : {};
        return sendJson(res, 200, { ok: true, ...(await service.resumeProject({ projectId: args.projectId ?? args.project_id })) });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: { code: 'aleph/resume-failed', message: String(error?.message ?? error) } });
      }
    },
  });
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/aleph/cancel',
    async handler(req, res) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false });
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const args = body ? JSON.parse(body) : {};
        return sendJson(res, 200, { ok: true, ...(await service.cancelBatch({ projectId: args.projectId ?? args.project_id, batchId: args.batchId ?? args.batch_id, reason: args.reason ?? 'cancelled by the operator' })) });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: { code: 'aleph/cancel-failed', message: String(error?.message ?? error) } });
      }
    },
  });
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/aleph/retry',
    async handler(req, res) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false });
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const args = body ? JSON.parse(body) : {};
        const projectId = args.project_id ?? args.projectId;
        const project = service.get(projectId);
        if (!project) return sendJson(res, 404, { ok: false, error: { code: 'aleph/no-project' } });
        const batch = project.batches.find((item) => item.id === (args.batch_id ?? args.batchId));
        if (!batch) return sendJson(res, 404, { ok: false, error: { code: 'aleph/no-batch' } });
        if (batch.status === 'forming' || batch.status === 'running') {
          return sendJson(res, 409, { ok: false, error: { code: 'aleph/batch-active', message: `batch ${batch.id} is ${batch.status}` } });
        }
        const doneBranches = new Set(project.missions.filter((mission) => mission.status === 'done').map((mission) => mission.branch));
        const reopened = [];
        for (const missionId of batch.missionIds) {
          const mission = project.missions.find((item) => item.id === missionId);
          if (!mission || mission.status !== 'failed' || doneBranches.has(mission.branch)) continue;
          await service.mutate(projectId, (current) => ({
            ...current,
            missions: current.missions.map((item) => (item.id === missionId
              ? { ...item, status: 'approved', batchId: null, preBatchTip: null, resultCommit: null, error: null, approvedAt: now(), finishedAt: null }
              : item)),
          }));
          reopened.push({ id: missionId, branch: mission.branch });
        }
        if (reopened.length === 0) return sendJson(res, 409, { ok: false, error: { code: 'aleph/nothing-to-retry' } });
        const formed = await service.formBatch({ projectId, machineId: batch.machineId ?? 'local' });
        const next = formed.batches[formed.batches.length - 1];
        await service.notifyComposer({ projectId, agent: null, event: 'batch retried', detail: next.id }).catch(() => undefined);
        return sendJson(res, 200, { ok: true, reopened, batch: { id: next.id, mission_ids: next.missionIds, branch: next.branch } });
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: { code: 'aleph/retry-failed', message: String(error?.message ?? error) } });
      }
    },
  });
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/aleph/evaluate',
    async handler(req, res) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false });
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const args = body ? JSON.parse(body) : {};
        const projectId = args.project_id ?? args.projectId;
        const agent = args.session_id ? { id: args.session_id } : null;
        const result = await service.evaluate({ projectId, agent, branch: args.branch ?? null });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: { code: 'aleph/evaluate-failed', message: String(error?.message ?? error) } });
      }
    },
  });
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/aleph/run',
    async handler(req, res) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false });
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const args = body ? JSON.parse(body) : {};
        const projectId = args.project_id ?? args.projectId;
        const ran = await service.runBatch({ projectId, batchId: args.batch_id ?? args.batchId });
        const batch = ran.batches.find((item) => item.id === (args.batch_id ?? args.batchId));
        return sendJson(res, 200, {
          ok: batch?.status === 'done',
          batch: { id: batch?.id, status: batch?.status },
          missions: ran.missions.map((mission) => ({ id: mission.id, status: mission.status, result_commit: mission.resultCommit, error: mission.error })),
        });
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: { code: 'aleph/run-failed', message: String(error?.message ?? error) } });
      }
    },
  });
}

export { ProjectService, snapshot };
