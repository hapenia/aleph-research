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
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
  status: z.enum(['forming', 'running', 'done', 'failed']),
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
  prepared: z.boolean().optional(),
  pythonPath: z.string().nullable().optional(),
  visibleData: z.string().nullable().optional(),
  testsetPath: z.string().nullable().optional(),
  submissionPython: z.string().nullable().optional(),
  machines: z.array(machineSchema),
  agents: z.array(z.object({
    role: z.enum(['researcher', 'composer', 'infra']),
    childId: z.string().nullable(),
    status: z.enum(['running', 'done', 'failed']),
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

function tool(name, description, parameters, execute) {
  return defineTool({ name, description, parameters, output: toolOutput(), execute });
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
    entrypoint = manifest.get("entrypoint") or "run.sh"
    output_dir = results / mission_id
    output_dir.mkdir(parents=True, exist_ok=True)
    (results / "progress.json").write_text(json.dumps({
        "mission_id": mission_id, "phase": "running", "started_at": time.time(),
    }, ensure_ascii=False))
    env = dict(os.environ)
    env["ALEPH_MISSION_ID"] = mission_id
    env["ALEPH_OUTPUT_DIR"] = str(output_dir)
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

  async init({ workspace, evalCommand, evalRoot, visibleData, testsetPath, submissionPython, researchers, brief, conventions, agent = null }) {
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
      'Training writes into `$ALEPH_OUTPUT_DIR`, which becomes `results/<mission-id>/`',
      'on the mission branch, so a finished mission result stays readable from its branch.',
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
      prepared: false,
      visibleData: visibleData ? resolve(visibleData) : null,
      testsetPath: testsetPath ? resolve(testsetPath) : null,
      submissionPython: submissionPython || null,
      machines: [{ id: 'local', kind: 'local', status: 'idle', batchId: null }],
      agents: [],
      missions: [],
      batches: [],
      violations: [],
      createdAt: stamp,
      updatedAt: stamp,
    };
    await this.table.put(project.id, project);
    return project;
  }

  /** Point a research branch at the best evaluated commit, so a later iteration starts from it. */
  async selectBest({ projectId, branch = 'main' }) {
    const project = this.get(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    const best = project.best;
    if (!best?.commit) throw new Error('no evaluated best result yet');
    const ref = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
    const current = (await git(project.researchRoot, ['rev-parse', '--verify', ref]).catch(() => ({ stdout: '' }))).stdout.trim();
    if (!current) throw new Error(`research branch not found: ${branch}`);
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

  async scaffoldResearch({ projectId, title = 'Research project', dataSources = [], pythonPath = null, conventions = null }) {
    const project = this.get(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    const root = project.researchRoot;
    const conventionsSection = project.conventions ? `\n## Project conventions\n\n${project.conventions}\n` : '';
    await writeFile(join(root, 'README.md'), `# ${title}\n\n${project.brief || ''}\n\n## Provided data\n\nThe data the Leader selected for researchers is under data/ in this worktree.\n${conventionsSection}`, 'utf8');
    await writeFile(join(root, 'pyproject.toml'), '[project]\nname = "aleph-research"\nversion = "0.1.0"\nrequires-python = ">=3.10"\n', 'utf8');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', '__init__.py'), '', 'utf8');
    await writeFile(join(root, '.gitignore'), '__pycache__/\n*.pyc\n.venv/\n', 'utf8');
    const toCopy = Array.isArray(dataSources) ? dataSources.filter((path) => typeof path === 'string' && path.trim()) : [];
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
    return { projectId, commit, prepared: next.prepared, visibleData: next.visibleData };
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

  async startMission({ projectId, name = 'mission' }) {
    const project = this.get(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'mission';
    const branch = `missions/${slug}-${randomUUID().slice(0, 8)}`;
    const worktree = join(project.workspace, '.aleph', 'missions', newId('mw'));
    await mkdir(join(project.workspace, '.aleph', 'missions'), { recursive: true });
    await git(project.missionRoot, ['worktree', 'add', '-b', branch, worktree, project.templateBranch]);
    const missionDir = join(worktree, 'missions', slug);
    await mkdir(missionDir, { recursive: true });
    await writeFile(join(missionDir, 'mission.json'), JSON.stringify({ id: slug, entrypoint: 'run.sh', outputs: [] }, null, 2), 'utf8');
    await writeFile(join(missionDir, 'run.sh'), '#!/usr/bin/env bash\nset -euo pipefail\n# Replace this stub with the mission entrypoint.\necho "mission not implemented" >&2\nexit 1\n', 'utf8');
    await writeFile(join(missionDir, 'README.md'), `# ${slug}\n\nFill mission.json, replace run.sh with the mission entrypoint, add code and an uv project, commit, then call aleph_propose_mission.\n`, 'utf8');
    await git(worktree, ['add', '-A']);
    await git(worktree, ['-c', 'user.name=AlephResearch', '-c', 'user.email=aleph@localhost', 'commit', '-m', `mission scaffold ${slug}`]);
    return { projectId, branch, worktree, missionId: slug, missionDir };
  }

  async mutateProject(projectId, updater) {
    return this.mutate(projectId, updater);
  }

  /**
   * Copy a finished mission's code and results into a research worktree so its
   * submission can be adopted without hand-copying files out of git.
   */
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
    // git archive keeps the checkout untouched and copies exactly what the branch holds.
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

  async listMissions({ projectId }) {
    const project = this.get(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    return project.missions.map((mission) => ({
      id: mission.id,
      status: mission.status,
      branch: mission.branch,
      ownerSession: mission.ownerSession,
      resultCommit: mission.resultCommit,
      resultPath: mission.manifestId ? `results/${mission.manifestId}/result.json` : null,
      error: mission.error,
    }));
  }

  async propose({ projectId, branch, agent }) {
    const project = this.get(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    const branchExists = await git(project.missionRoot, ['rev-parse', '--verify', branch]).then(() => true).catch(() => false);
    if (!branchExists) throw new Error(`mission branch not found: ${branch}`);
    const ancestor = await git(project.missionRoot, ['merge-base', '--is-ancestor', project.templateBranch, branch]).then(() => true).catch(() => false);
    if (!ancestor) throw new Error(`mission branch ${branch} is not derived from ${project.templateBranch}`);
    let manifest = null;
    try {
      const files = (await git(project.missionRoot, ['ls-tree', '-r', '--name-only', branch])).stdout.split(/\r?\n/);
      const manifestPath = files.find((path) => /^missions\/[^/]+\/mission\.json$/.test(path));
      if (!manifestPath) throw new Error('no missions/<id>/mission.json');
      const raw = await git(project.missionRoot, ['show', `${branch}:${manifestPath}`]);
      manifest = JSON.parse(raw.stdout);
      manifest.__manifestPath = manifestPath;
    } catch (error) {
      throw new Error(`mission branch ${branch} has no valid missions/<id>/mission.json: ${error instanceof Error ? error.message : error}`);
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
        status: 'proposed',
        entrypoint: manifest.entrypoint ?? null,
        outputs: Array.isArray(manifest.outputs) ? manifest.outputs : [],
        resource: manifest.resource ?? null,
        batchId: null,
        preBatchTip: null,
        resultCommit: null,
        error: null,
        createdAt: now(),
        approvedAt: null,
        finishedAt: null,
      }],
    }));
    await this.removeMissionWorktree(project, branch);
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
        return { name, utilization: Number(util), memoryUsedMb: Number(used), memoryTotalMb: Number(total) };
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

  /** Remember the session that drives this project so the Host can restart the Composer later. */
  async rememberOrchestrator(projectId, agent) {
    if (!agent?.id) return;
    const project = this.get(projectId);
    if (!project || project.orchestratorSessionId === agent.id) return;
    await this.mutate(projectId, (current) => ({ ...current, orchestratorSessionId: agent.id })).catch(() => undefined);
  }

  async approve({ projectId, missionId, agent = null }) {
    await this.rememberOrchestrator(projectId, agent);
    const updated = await this.mutate(projectId, (project) => ({
      ...project,
      missions: project.missions.map((mission) => (
        mission.id === missionId && mission.status === 'proposed'
          ? { ...mission, status: 'approved', approvedAt: now() }
          : mission
      )),
    }));
    await this.notifyComposer({ projectId, agent, event: 'mission approved', detail: missionId }).catch(() => undefined);
    return updated;
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

  async prepareBatchRuntime({ project, batch, missionRecords, batchWorktree }) {
    const cores = Math.max(1, Number(os.cpus().length) || 1);
    // One mission runs at a time, so it may use most of the machine without starving the desktop.
    const threads = Math.max(1, Math.min(cores - 2, 16));
    const uvCache = join(batchWorktree, '.uv-cache');
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
      try {
        // Dependencies come from the mission's own pyproject; the shared runtime is the fallback.
        await run('uv', ['sync', '--quiet', '--project', dir], { cwd: batchWorktree, env, timeout: 300_000 });
        prepared.push({ mission: mission.id, status: 'synced' });
      } catch (error) {
        prepared.push({ mission: mission.id, status: 'sync-failed', error: String(error?.message ?? error).slice(0, 400) });
      }
    }
    const infra = { cores, threads, missions: prepared, runner: project.pythonPath ?? 'python3', timeout_ms: Number(process.env.ALEPH_BATCH_TIMEOUT_MS) > 0 ? Number(process.env.ALEPH_BATCH_TIMEOUT_MS) : 6 * 60 * 60 * 1000 };
    await writeFile(join(batchWorktree, 'infra.json'), JSON.stringify(infra, null, 2), 'utf8').catch(() => undefined);
    return { ...infra, env };
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
      runnerError = error instanceof Error ? error.message : String(error);
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
        } catch {
          envelope.status = 'failed';
          envelope.error = runnerError || 'mission result missing';
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
    }

    // A timed-out runner leaves its mission children behind; never leave them consuming the machine.
    const orphans = this.killUnder(batchWorktree);
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
    await this.notifyComposer({ projectId, agent: null, event: 'batch finished', detail: batch.id }).catch(() => undefined);
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
      // Evaluate the researcher's own worktree, but pin the commit so the report
      // keeps pointing at the code that was actually scored.
      worktree = agentRecord.worktree;
      const symbolic = await git(worktree, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => ({ stdout: '' }));
      targetRef = symbolic.stdout.trim() || null;
      evaluatedCommit = (await git(worktree, ['rev-parse', 'HEAD'])).stdout.trim();
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
    try {
      // The evaluator lives beside the project; it reads the scored branch through ALEPH_SOLUTION_DIR.
      const result = await run('bash', ['-lc', project.evalCommand], { cwd: project.evalRoot || project.workspace, env, timeout: 600_000 });
      stdout = result.stdout;
      stderr = result.stderr;
      score = parseScore(stdout)?.score ?? null;
    } finally {
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
    return {
      status: 'done', projectId, score, researchCommit, evaluatedCommit, evaluationRef, researchBranchUpdated,
      best: updated.best ?? null,
      stdout: stdout.slice(0, 8000), stderr: stderr.slice(0, 4000),
    };
  }

  async startResearcher({ projectId, agent }) {
    if (!agent) throw new Error('a calling Agent is required to start a researcher');
    if (!this.subagents) throw new Error('subagent service is unavailable');
    const project = this.get(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    this.assertWorkspace(agent, project.workspace);
    const branch = `research/r-${randomUUID().slice(0, 8)}`;
    const worktree = join(project.workspace, '.aleph', 'researchers', newId('r'));
    await mkdir(join(project.workspace, '.aleph', 'researchers'), { recursive: true });
    await git(project.researchRoot, ['worktree', 'add', '-b', branch, worktree, 'HEAD']);
    const prompt = [
      'You are an AlephResearch researcher.',
      `Project: ${project.id}. Research brief: ${project.brief || '(no extra brief)'}.`,
      `Research worktree: ${worktree}. Research branch: ${branch}. Mission repo: ${project.missionRoot}. Template branch: ${project.templateBranch}.`,
      ...(project.conventions ? [`Project conventions:\n${project.conventions}`] : []),
      `The Leader created your initial research scaffold. Provided data is already copied under data/ in ${worktree}; use it directly. Do not read data.zip, testsets, the original project or DSH state.`,
      `The runtime environment is prepared by Composer and InfraOptimizer. Do not inspect Python versions, installed packages, CPU/GPU, system services or create/install environments. Mission code receives ALEPH_PYTHON.`, 'Declare dependencies in the mission pyproject; Composer and InfraOptimizer resolve the runtime environment. Do not install packages yourself.', 'Small bounded analysis uses the prepared runtime; full training must still be a mission.',
      'Do not read problem/data.zip, any testsets directory, /home/hapenia/Projects/kunlungpt-comp, /home/hapenia/Projects/aleph-research, /home/hapenia/.dsh or any DSH profile/state. Run commands from your worktree, not from the project root; use canonical visible data only.' ,
      'Work only in the assigned research worktree and commit research changes to its branch when appropriate.',
      'You may inspect the complete git history of both repositories with git: use git log --all, git branch -a, git show and git diff in the research worktree and mission repo. Mission results are cherry-picked onto mission branches, so previous work is visible there.',
      'Before creating or proposing a mission, inspect the mission repo history and branches for an equivalent mission that already ran or is queued. Do not re-run a mission that already has a result; read its existing result commit or result envelope instead.',
      'All missions are visible to every researcher. Before doing data analysis, call aleph_list_missions; if an equivalent mission already has a result, inspect it with git show in the mission repo and reuse it instead of repeating the analysis.',
      'Budget the exploration: keep schema and data sanity checks compact, then create a mission or commit a code increment instead of running exploratory scripts indefinitely.',
      'A local script that fits a model, runs cross-validation, or needs a timeout above 120 seconds is mission-worthy even if named quick or prototype. Create the mission before running it locally.',
      'If a local command is killed for exceeding the compute limit, do not retry it locally; create a mission for that work and let other researchers reuse the result.',
      'If a task would help other researchers and has non-trivial cost, create a mission for it instead of running it only locally. Shared analysis, feature engineering, data cleaning, baselines, training and sweeps are typical examples; other researchers must be able to read the mission result.',
      'Small work can be done directly. For work with significant hardware cost, call aleph_start_mission to create a mission branch and worktree, work there, add missions/<id>/mission.json plus code and an uv project, commit the branch, then call aleph_propose_mission.',
      'After proposing, wait only for missions owned by you: call aleph_evaluate; if it returns status waiting, wait briefly and retry. Do not wait for other researchers missions.',
      'When all your missions are done, call aleph_evaluate once more so the Host evaluates your research branch and writes the report into its commit, then finish. Do not modify project queue, batch or machine state.',
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
    await this.mutate(projectId, (current) => ({ ...current, agents: [...(current.agents ?? []), { role: 'researcher', childId, status: 'running', summary: null, branch, worktree, updatedAt: now() }] }));
    this.parentAgents ??= new Map();
    if (agent) this.parentAgents.set(childId, agent);
    // Ownership is exact: only this activation may settle its own record.
    const settle = (status, summary) => this.mutate(projectId, (current) => ({
      ...current,
      agents: (current.agents ?? []).map((item) => (item.role === 'researcher' && item.childId === childId && item.status === 'running'
        ? { ...item, status, summary, updatedAt: now() }
        : item)),
    })).catch(() => undefined);
    activation.result.then(async (result) => {
      const summary = (result?.output ?? []).filter((block) => block?.type === 'text').map((block) => block.text).join('\n').trim().slice(0, 8000) || '(no summary)';
      await settle('done', summary);
    }, async (error) => {
      await settle('failed', String(error));
    });
    return { projectId, role: 'researcher', childId, branch, worktree };
  }

  async startResearchers({ projectId, count = null, agent }) {
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
      agents: (current.agents ?? []).map((item) => item.role === 'researcher' && item.status === 'running'
        ? { ...item, status: 'failed', summary: 'superseded by a new researcher batch', updatedAt: now() }
        : item),
    }));
    const started = [];
    for (let index = 0; index < requested; index += 1) {
      started.push(await this.startResearcher({ projectId, agent }));
    }
    const checkpoint = setTimeout(() => {
      for (const researcher of this.get(projectId)?.agents ?? []) {
        if (researcher.role !== 'researcher' || researcher.status !== 'running' || !researcher.childId) continue;
        this.nudgeChild(researcher.childId, 'Checkpoint: stop expanding the analysis. Commit a valid mission with the current code and call aleph_propose_mission now. You can improve it after the first result.');
      }
    }, 60_000);
    checkpoint.unref?.();
    const finalCheckpoint = setTimeout(() => {
      for (const researcher of this.get(projectId)?.agents ?? []) {
        if (researcher.role !== 'researcher' || researcher.status !== 'running' || !researcher.childId) continue;
        this.nudgeChild(researcher.childId, 'Final checkpoint: run git add -A && git commit in your mission worktree now, then call aleph_propose_mission. Do not write more analysis before proposing.');
      }
    }, 180_000);
    finalCheckpoint.unref?.();
    return { projectId, requested, started };
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
      const running = (project.batches ?? []).filter((batch) => batch.status === 'running');
      const interrupted = new Set();
      for (const batch of running) {
        const live = this.hasProcessUnder(join(batchesRoot, batch.id));
        if (live) continue;
        interrupted.add(batch.id);
      }
      const idleMachine = (project.machines ?? []).every((machine) => machine.status === 'idle');
      if (interrupted.size === 0 && idleMachine) {
        // Nothing was left mid-flight; only stale agent records may need closing.
        const staleAgents = (project.agents ?? []).filter((item) => item.status === 'running');
        if (staleAgents.length === 0) continue;
      }
      await this.mutate(project.id, (current) => ({
        ...current,
        machines: (current.machines ?? []).map((machine) => (
          interrupted.has(machine.batchId ?? '') || (machine.status === 'busy' && !(current.batches ?? []).some((batch) => batch.id === machine.batchId && batch.status === 'running' && !interrupted.has(batch.id)))
            ? { ...machine, status: 'idle', batchId: null }
            : machine
        )),
        batches: (current.batches ?? []).map((batch) => (
          interrupted.has(batch.id)
            ? { ...batch, status: 'failed', finishedAt: nowText, summary: { ...(batch.summary ?? {}), runnerError: 'interrupted by Host restart' } }
            : batch
        )),
        missions: (current.missions ?? []).map((mission) => (
          mission.batchId && interrupted.has(mission.batchId) && ['batched', 'running'].includes(mission.status)
            ? { ...mission, status: 'failed', error: 'interrupted by Host restart', finishedAt: nowText }
            : mission
        )),
        agents: (current.agents ?? []).map((item) => (
          item.status === 'running'
            ? { ...item, status: 'failed', summary: 'interrupted by Host restart', updatedAt: nowText }
            : item
        )),
        violations: [...(current.violations ?? []), `${nowText} recovered from restart: ${interrupted.size} interrupted batch(es)`].slice(-50),
      })).catch(() => undefined);
      summary.push({ project: project.id, interrupted: [...interrupted] });
    }
    return summary;
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

  /** Tell the Composer the MissionQueue changed. */
  async notifyComposer({ projectId, agent, event, detail }) {
    const project = this.get(projectId);
    if (!project) return { delivered: false, reason: 'no project' };
    const record = (project.agents ?? []).filter((item) => item.role === 'composer' && item.childId && item.status !== 'failed').pop();
    if (!record?.childId) {
      const ensured = await this.ensureComposer({ projectId, agent }).catch(() => null);
      return { delivered: Boolean(ensured), started: true, childId: ensured?.childId ?? null };
    }
    const remembered = project.orchestratorSessionId ? this.ctx?.agents?.get?.(project.orchestratorSessionId) : null;
    const parent = this.parentAgents?.get(record.childId) ?? agent ?? remembered ?? null;
    if (!parent || !this.subagents) return { delivered: false, reason: 'no live composer parent' };
    const queued = project.missions.filter((mission) => mission.status === 'approved').length;
    const machine = project.machines.find((item) => item.id === 'local');
    const text = [
      `MissionQueue changed (${event}${detail ? `: ${detail}` : ''}).`,
      `${queued} mission(s) approved and waiting. Machine local is ${machine?.status ?? 'unknown'}.`,
      'Apply your dispatch policy: run approved work immediately when the machine is idle; only compose ahead and invoke InfraOptimizer while it is busy.',
    ].join(' ');
    try {
      await this.subagents.sendMessage(parent, record.childId, [{ type: 'text', text }], { signal: new AbortController().signal });
    } catch (error) {
      const restarted = await this.runComposer({ projectId, agent }).catch(() => null);
      return { delivered: Boolean(restarted), restarted: true, childId: restarted?.childId ?? null };
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
    if (!this.subagents) throw new Error('subagent service is unavailable');
    const project = this.get(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    this.assertWorkspace(agent, project.workspace);
    await this.rememberOrchestrator(projectId, agent);
    await this.claimRole(projectId, 'composer');
    const prompt = [
      'You are MissionComposer for AlephResearch, the long-lived owner of the MissionQueue.',
      `Project: ${project.id}. Research repo: ${project.researchRoot}. Mission repo: ${project.missionRoot}. Machine: local.`,
      'Researcher missions arrive as proposals; the Leader approves them into the queue and the Host notifies you whenever that queue changes.',
      '',
      `Machine load is not a flag. aleph_status reports sampled telemetry (cores, load average, memory, GPU utilization) plus the machine load list you maintain with aleph_machine_load, which replaces the whole list like a todo list.`,
      'Dispatch policy:',
      '- Treat the machine as free only when the sampled utilization leaves room for the next batch. A running batch reports its own load entry with its thread count.',
      '- When there is room, run approved work immediately: form a batch with aleph_form_batch and start it with aleph_run_batch, and record the new load with aleph_machine_load.',
      '- When the machine is saturated, use the waiting time productively: form the next batch and call aleph_run_infra so InfraOptimizer resolves dependencies and tunes that batch for this machine, so it starts as soon as capacity frees.',
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

  async runInfra({ projectId, batchId, agent }) {
    if (!agent) throw new Error('a calling Agent is required to start InfraOptimizer');
    if (!this.subagents) throw new Error('subagent service is unavailable');
    const project = this.get(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    const batch = project.batches.find((item) => item.id === batchId);
    if (!batch) throw new Error(`batch not found: ${batchId}`);
    if (batch.status !== 'forming') throw new Error(`batch ${batchId} is not forming`);
    await this.claimRole(projectId, 'infra');
    const worktreeRoot = join(project.workspace, '.aleph', 'infra');
    const worktree = join(worktreeRoot, batchId);
    await mkdir(worktreeRoot, { recursive: true });
    await rm(worktree, { recursive: true, force: true });
    const baseTip = (await git(project.missionRoot, ['rev-parse', batch.branch])).stdout.trim();
    await git(project.missionRoot, ['worktree', 'add', '--detach', worktree, batch.branch]);
    const prompt = [
      'You are InfraOptimizer for AlephResearch.',
      `Batch: ${batch.id}. Machine: ${batch.machineId}. Work only inside this worktree: ${worktree}.`,
      `Optimize only files under the current worktree. Shared Python: ${project.pythonPath ?? 'python3'}; ALEPH_PYTHON is set for batch execution. Resolve mission dependencies with uv inside this worktree before optimizing; this is the only environment setup. Do not inspect /home, /root, DSH profile/state, other projects, or search the filesystem. Do not start extra agents.`,
      'First read the batch files and the manifest. Make at most one focused optimization to threading, batching, import cost, allocation, precision or caching. Run one small before/after benchmark if cheap; otherwise inspect statically.',
      'Use at most six shell commands total. If no safe improvement is justified, write ALEPH_HANDOFF.md and stop without changing code.',
      'Write ALEPH_HANDOFF.md with changes and before/after measurements. Do not change project budget, queue or scheduling constraints. The Host commits the batch branch and runs the single batch entrypoint.',
    ].join('\n');
    const abort = new AbortController();
    let activation;
    try {
      activation = await this.subagents.startActivation({
        provider: 'spawn', label: `aleph infra ${batch.id}`, delivery: 'caller', signal: abort.signal,
        request: { parent: agent, cwd: worktree, agentPreset: 'aleph-infra', prompt: [{ type: 'text', text: prompt }] },
      });
    } catch (error) {
      await git(project.missionRoot, ['worktree', 'remove', '--force', worktree]).catch(() => undefined);
      throw error;
    }
    await this.mutate(projectId, (current) => ({ ...current, agents: [...(current.agents ?? []), { role: 'infra', childId: activation.childId ?? null, status: 'running', summary: null, branch: batch.branch, updatedAt: now() }] }));
    try {
      const result = await activation.result;
      const handoff = await readFile(join(worktree, 'ALEPH_HANDOFF.md'), 'utf8').catch(() => '');
      const summary = (handoff || (result?.output ?? []).filter((block) => block?.type === 'text').map((block) => block.text).join('\n') || '(no summary)').trim().slice(0, 8000);
      const dirty = (await git(worktree, ['status', '--porcelain'])).stdout.trim();
      if (dirty) {
        await git(worktree, ['add', '-A']);
        await git(worktree, ['-c', 'user.name=AlephResearch', '-c', 'user.email=aleph@localhost', 'commit', '-m', `infra optimization for ${batch.id}\n\n${summary.slice(0, 4000)}`]);
        const tip = (await git(worktree, ['rev-parse', 'HEAD'])).stdout.trim();
        await git(project.missionRoot, ['branch', '-f', batch.branch, tip]);
      }
      await this.mutate(projectId, (current) => ({ ...current, agents: (current.agents ?? []).map((item) => item.role === 'infra' && item.status === 'running' ? { ...item, status: 'done', summary, branch: batch.branch, updatedAt: now() } : item) }));
      return this.runBatch({ projectId, batchId });
    } catch (error) {
      await this.mutate(projectId, (current) => ({ ...current, agents: (current.agents ?? []).map((item) => item.role === 'infra' && item.status === 'running' ? { ...item, status: 'failed', summary: String(error), updatedAt: now() } : item) }));
      throw error;
    } finally {
      await git(project.missionRoot, ['worktree', 'remove', '--force', worktree]).catch(() => undefined);
      await rm(worktree, { recursive: true, force: true }).catch(() => undefined);
      this.activations?.delete?.(abort);
    }
  }

  async formBatch({ projectId, machineId = 'local' }) {
    const project = this.get(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    const machine = project.machines.find((item) => item.id === machineId);
    if (!machine) throw new Error(`machine not found: ${machineId}`);
    // A forming batch is prepared work, not running work: the machine stays idle until it starts.
    const active = (project.batches ?? []).find((batch) => batch.machineId === machineId && ['forming', 'running'].includes(batch.status));
    if (active) throw new Error(`machine ${machineId} already has ${active.status} batch ${active.id}`);
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
      return { hash, refs: refs.replace(/^\(|\)$/g, ''), subject, date };
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
  const workspaceRegistry = ctx.get('workspaceRegistry');
  const service = new ProjectService(ctx, domain, { sessions, subagents, agentPresets });
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
      'aleph_create_research_scaffold',
      'Leader creates the initial research project before any researcher starts.',
      { ...projectIdParam, title: { type: 'string', description: 'Research project title' }, data: { type: 'array', items: { type: 'string' }, description: 'Data sources to copy into the research project' }, python: { type: 'string', description: 'Shared Python executable for researchers and missions' } },
      async (args) => service.scaffoldResearch({ projectId: args.project_id, title: args.title ?? 'Research project', dataSources: args.data, pythonPath: args.python }),
    ), { when: ({ agent }) => isLeader(agent) }),
    ctx.tools.register(tool(
      'aleph_start_mission',
      'Create a mission branch from the template and return its worktree for the researcher to fill.',
      { ...projectIdParam, name: { type: 'string', description: 'Short mission name' } },
      async (args) => service.startMission({ projectId: args.project_id, name: args.name ?? 'mission' }),
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
      'aleph_approve_mission',
      'Approve a proposed mission and move it to the approved queue.',
      { ...projectIdParam, mission_id: { type: 'string', required: true } },
      async (args, exec) => service.approve({ projectId: args.project_id, missionId: args.mission_id, agent: exec.agent }),
    ), { when: ({ agent }) => isLeader(agent) }),
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
      'aleph_run_researchers',
      'Start the project default number of researcher subagents, each with its own research worktree and branch.',
      { ...projectIdParam, count: { type: 'integer', description: 'Optional count; defaults to the project researcher count' } },
      async (args, exec) => service.startResearchers({ projectId: args.project_id, count: args.count, agent: exec.agent }),
    ), { when: ({ agent }) => isLeader(agent) }),
    ctx.tools.register(tool(
      'aleph_run_composer',
      'Start MissionComposer to inspect the approved queue and form a machine-bound batch.',
      { ...projectIdParam },
      async (args, exec) => service.runComposer({ projectId: args.project_id, agent: exec.agent }),
    ), { when: ({ agent }) => isLeader(agent) }),
    ctx.tools.register(tool(
      'aleph_run_infra',
      'Start InfraOptimizer on a forming batch, then run the batch and deliver per-mission results.',
      { ...projectIdParam, batch_id: { type: 'string', required: true } },
      async (args, exec) => service.runInfra({ projectId: args.project_id, batchId: args.batch_id, agent: exec.agent }),
    ), { when: ({ agent }) => isLeader(agent) }),
    ctx.tools.register(tool(
      'aleph_run_batch',
      'Run a formed machine-bound batch, write per-mission result envelopes and cherry-pick results to pre-batch mission branches.',
      { ...projectIdParam, batch_id: { type: 'string', required: true } },
      async (args) => service.runBatch({ projectId: args.project_id, batchId: args.batch_id }),
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
    path: '/api/aleph/approve',
    async handler(req, res) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false });
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const args = body ? JSON.parse(body) : {};
        const projectId = args.project_id ?? args.projectId;
        const project = service.get(projectId);
        if (!project) return sendJson(res, 404, { ok: false, error: { code: 'aleph/no-project' } });
        const terminalBranches = new Set(project.missions.filter((mission) => ['done', 'failed', 'batched'].includes(mission.status)).map((mission) => mission.branch));
        const wanted = args.mission_id ? [args.mission_id] : project.missions.filter((mission) => mission.status === 'proposed').map((mission) => mission.id);
        const approved = [];
        const skipped = [];
        for (const id of wanted) {
          const mission = project.missions.find((item) => item.id === id);
          if (!mission || mission.status !== 'proposed') { skipped.push({ id, reason: 'not proposed' }); continue; }
          if (terminalBranches.has(mission.branch)) { skipped.push({ id, reason: 'branch already has a terminal mission' }); continue; }
          await service.approve({ projectId, missionId: id });
          approved.push({ id, branch: mission.branch });
        }
        return sendJson(res, 200, { ok: true, approved, skipped });
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: { code: 'aleph/approve-failed', message: String(error?.message ?? error) } });
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
          await service.mutateProject(projectId, (current) => ({
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
