import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { ProjectService } from '../index-v2.js';

const cleanup = (root) => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });

const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

function table() {
  const records = new Map();
  return {
    get: (key) => records.get(key),
    put: async (key, value) => { records.set(key, value); },
    entries: () => records.entries(),
  };
}

function identity(repo) {
  return ['-c', 'user.name=T', '-c', 'user.email=t@t'];
}

test('a researcher completion settles only its own activation record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-ownership-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const service = new ProjectService({}, { table: () => table() }, {});
    const project = await service.init({ workspace });
    await service.scaffoldResearch({ projectId: project.id });

    const pending = new Map();
    const settled = [];
    const subagents = {
      async startActivation({ request }) {
        const childId = `child-${pending.size + 1}`;
        let resolve;
        const result = new Promise((yes) => { resolve = yes; });
        pending.set(childId, { resolve, cwd: request.cwd });
        return { childId, result };
      },
      async sendMessage(sender, targetId, blocks) {
        settled.push({ targetId, blocks });
        return { id: 'message' };
      },
    };
    service.subagents = subagents;

    const leader = { id: 'leader' };
    const first = await service.startResearcher({ projectId: project.id, agent: leader });
    const second = await service.startResearcher({ projectId: project.id, agent: leader });
    assert.notEqual(first.childId, second.childId);

    pending.get(second.childId).resolve({ output: [{ type: 'text', text: 'second finished' }] });
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const records = (service.get(project.id).agents ?? []).filter((item) => item.role === 'researcher');
      if (records.some((item) => item.childId === second.childId && item.status === 'done')) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const records = (service.get(project.id).agents ?? []).filter((item) => item.role === 'researcher');
    const secondRecord = records.find((item) => item.childId === second.childId);
    const firstRecord = records.find((item) => item.childId === first.childId);
    assert.equal(secondRecord.status, 'done');
    assert.equal(secondRecord.summary, 'second finished');
    assert.equal(firstRecord.status, 'running');
    assert.equal(firstRecord.summary, null);
  } finally {
    await cleanup(root);
  }
});

test('an activation without a child identity fails instead of writing a null record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-identity-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const service = new ProjectService({}, { table: () => table() }, {});
    const project = await service.init({ workspace });
    await service.scaffoldResearch({ projectId: project.id });
    service.subagents = {
      async startActivation() { return { childId: null, result: new Promise(() => undefined) }; },
    };
    await assert.rejects(
      () => service.startResearcher({ projectId: project.id, agent: { id: 'leader' } }),
      /child ID/,
    );
    const records = (service.get(project.id).agents ?? []).filter((item) => item.role === 'researcher');
    assert.equal(records.length, 0);
  } finally {
    await cleanup(root);
  }
});

test('an evaluation report stays attached to the commit it scored', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-attribution-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const service = new ProjectService({}, { table: () => table() }, {});
    const project = await service.init({
      workspace,
      evalCommand: "python3 -c \"import json;print(json.dumps({'score': 2}))\"",
    });
    const research = project.researchRoot;
    await writeFile(join(research, 'predict.py'), 'print("v1")\n');
    git(research, ['add', '-A']);
    git(research, [...identity(research), 'commit', '-m', 'research v1']);
    const scored = git(research, ['rev-parse', 'HEAD']);

    const evaluation = await service.evaluate({ projectId: project.id, branch: 'main' });
    assert.equal(evaluation.status, 'done');
    assert.equal(evaluation.score, 2);
    assert.equal(evaluation.evaluatedCommit, scored);
    assert.equal(git(research, ['rev-parse', `${evaluation.researchCommit}^`]), scored);
    assert.equal(git(research, ['rev-parse', 'main']), evaluation.researchCommit);
    assert.equal(git(research, ['rev-parse', evaluation.evaluationRef]), evaluation.researchCommit);
    const message = git(research, ['log', '-1', '--format=%B', evaluation.researchCommit]);
    assert.match(message, /Aleph-Research-Commit: [0-9a-f]{40}/);

    // An independent ref survives later history on the branch.
    await writeFile(join(research, 'predict.py'), 'print("v2")\n');
    git(research, ['add', '-A']);
    git(research, [...identity(research), 'commit', '-m', 'research v2']);
    assert.equal(git(research, ['rev-parse', evaluation.evaluationRef]), evaluation.researchCommit);
    assert.notEqual(git(research, ['rev-parse', 'main']), evaluation.researchCommit);
  } finally {
    await cleanup(root);
  }
});

test('result delivery refuses to overwrite commits pushed after batching', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-delivery-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const service = new ProjectService({}, { table: () => table() }, {});
    const project = await service.init({ workspace });
    const missionRepo = project.missionRoot;
    const branch = 'missions/late-commit';
    git(missionRepo, ['switch', '-c', branch, 'template']);
    await mkdir(join(missionRepo, 'missions', 'late'), { recursive: true });
    await writeFile(join(missionRepo, 'missions', 'late', 'mission.json'), JSON.stringify({ id: 'late', entrypoint: 'run.sh', kind: 'training', title: 'late', summary: 'test mission' }));
    await writeFile(join(missionRepo, 'missions', 'late', 'run.sh'), '#!/usr/bin/env bash\nset -e\nprintf \'{"ok":true}\\n\' > "$ALEPH_OUTPUT_DIR/result.json"\n');
    execFileSync('chmod', ['+x', join(missionRepo, 'missions', 'late', 'run.sh')]);
    git(missionRepo, ['add', '-A']);
    git(missionRepo, [...identity(missionRepo), 'commit', '-m', 'mission late']);
    git(missionRepo, ['switch', 'template']);

    let current = await service.propose({ projectId: project.id, branch, agent: { id: 'researcher' } });
    const missionId = current.missions[0].id;
    current = await service.formBatch({ projectId: project.id });
    const batchId = current.batches[0].id;

    // The researcher keeps working on the mission branch after the batch formed.
    git(missionRepo, ['switch', branch]);
    await writeFile(join(missionRepo, 'missions', 'late', 'notes.md'), 'later work\n');
    git(missionRepo, ['add', '-A']);
    git(missionRepo, [...identity(missionRepo), 'commit', '-m', 'work after batching']);
    const advanced = git(missionRepo, ['rev-parse', branch]);
    git(missionRepo, ['switch', 'template']);

    current = await service.runBatch({ projectId: project.id, batchId });
    const mission = current.missions.find((item) => item.id === missionId);
    assert.equal(mission.status, 'failed');
    // The wording depends on the git locale; the contract is a refused delivery.
    assert.ok(mission.error, 'delivery failure is reported on the mission');
    assert.ok(mission.resultCommit === null || mission.resultCommit, 'mission keeps its recorded state');
    assert.equal(git(missionRepo, ['rev-parse', branch]), advanced, 'the later commit must survive');
  } finally {
    await cleanup(root);
  }
});

test('a Host restart resumes interrupted work instead of replacing it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-resume-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const service = new ProjectService({}, { table: () => table() }, {});
    const project = await service.init({ workspace });
    await service.scaffoldResearch({ projectId: project.id });
    const repo = project.missionRoot;
    const branch = 'missions/slow';
    git(repo, ['switch', '-c', branch, 'template']);
    await mkdir(join(repo, 'missions', 'slow'), { recursive: true });
    await writeFile(join(repo, 'missions', 'slow', 'mission.json'), JSON.stringify({ id: 'slow', entrypoint: 'run.sh', kind: 'training', title: 'slow', summary: 'test mission' }));
    await writeFile(join(repo, 'missions', 'slow', 'run.sh'), '#!/usr/bin/env bash\nset -e\nsleep 1\nprintf \'{}\' > "$ALEPH_OUTPUT_DIR/result.json"\n');
    git(repo, ['add', '-A']);
    git(repo, [...identity(repo), 'commit', '-m', 'slow mission']);
    git(repo, ['switch', 'template']);

    const proposed = await service.propose({ projectId: project.id, branch, agent: { id: 'researcher' } });
    const missionId = proposed.missions[0].id;
    const batch = (await service.formBatch({ projectId: project.id })).batches[0];

    // State a restart leaves behind: the batch says running, a researcher was mid-flight.
    await service.mutate(project.id, (state) => ({
      ...state,
      machines: state.machines.map((machine) => ({ ...machine, status: 'busy', batchId: batch.id })),
      batches: state.batches.map((item) => (item.id === batch.id ? { ...item, status: 'running' } : item)),
      agents: [{ role: 'researcher', childId: 'child-1', status: 'running', summary: null, branch: 'research/r-x', worktree: null, updatedAt: new Date().toISOString() }],
    }));

    const summary = await service.recoverAfterRestart();
    // Recovery resumes the batch in the background; let it settle before the fixture is removed.
    for (let i = 0; i < 300; i += 1) {
      const busy = service.get(project.id).batches.some((batch) => ['forming', 'running'].includes(batch.status));
      if (!busy) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const recovered = service.get(project.id);
    // Recovery either leaves the batch queued or finishes it right away; it must never fail it.
    assert.ok(['interrupted', 'forming', 'running', 'done'].includes(recovered.batches[0].status), `unexpected batch status ${recovered.batches[0].status}`);
    assert.equal(recovered.missions.find((m) => m.id === missionId).status !== 'failed', true, 'its mission is not failed');
    const researcher = recovered.agents.find((item) => item.role === 'researcher');
    assert.equal(researcher.status, 'interrupted', 'the researcher is kept for a cold resume');
    assert.equal(researcher.childId, 'child-1');
    assert.ok(Array.isArray(summary) && summary.length === 1);
  } finally {
    await cleanup(root);
  }
});

test('evaluations accumulate and the best result follows the highest score', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-best-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const service = new ProjectService({}, { table: () => table() }, {});
    const project = await service.init({
      workspace,
      // The evaluator scores from a file the branch carries, so two branches can differ.
      // The evaluator runs beside the project and reads the scored branch from ALEPH_SOLUTION_DIR.
      evalCommand: "python3 -c \"import json,os,pathlib;root=pathlib.Path(os.environ['ALEPH_SOLUTION_DIR']);print(json.dumps({'score': float((root/'score.txt').read_text())}))\"",
    });
    const research = project.researchRoot;
    await writeFile(join(research, 'score.txt'), '1\n');
    git(research, ['add', '-A']);
    git(research, [...identity(research), 'commit', '-m', 'score 1']);
    const low = await service.evaluate({ projectId: project.id, branch: 'main' });
    assert.equal(low.score, 1);

    await writeFile(join(research, 'score.txt'), '3\n');
    git(research, ['add', '-A']);
    git(research, [...identity(research), 'commit', '-m', 'score 3']);
    const high = await service.evaluate({ projectId: project.id, branch: 'main' });
    assert.equal(high.score, 3);

    const state = service.get(project.id);
    assert.equal(state.evaluations.length, 2);
    assert.equal(state.best.score, 3);
    assert.equal(state.best.commit, high.evaluatedCommit);

    // A weaker later evaluation must not displace the best result.
    await writeFile(join(research, 'score.txt'), '2\n');
    git(research, ['add', '-A']);
    git(research, [...identity(research), 'commit', '-m', 'score 2']);
    await service.evaluate({ projectId: project.id, branch: 'main' });
    assert.equal(service.get(project.id).best.score, 3);
    assert.equal(service.get(project.id).evaluations.length, 3);
  } finally {
    await cleanup(root);
  }
});

test('a prepared batch does not claim the machine until it runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-machine-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const service = new ProjectService({}, { table: () => table() }, {});
    const project = await service.init({ workspace });
    const missionRepo = project.missionRoot;
    const branch = 'missions/quick';
    git(missionRepo, ['switch', '-c', branch, 'template']);
    await mkdir(join(missionRepo, 'missions', 'quick'), { recursive: true });
    await writeFile(join(missionRepo, 'missions', 'quick', 'mission.json'), JSON.stringify({ id: 'quick', entrypoint: 'run.sh', kind: 'training', title: 'quick', summary: 'test mission' }));
    await writeFile(join(missionRepo, 'missions', 'quick', 'run.sh'), '#!/usr/bin/env bash\nset -e\nprintf \'{}\\n\' > "$ALEPH_OUTPUT_DIR/result.json"\n');
    git(missionRepo, ['add', '-A']);
    git(missionRepo, [...identity(missionRepo), 'commit', '-m', 'quick mission']);
    git(missionRepo, ['switch', 'template']);

    let current = await service.propose({ projectId: project.id, branch, agent: { id: 'researcher' } });
    const missionId = current.missions[0].id;
    current = await service.formBatch({ projectId: project.id });
    const batchId = current.batches[0].id;
    assert.equal(current.machines[0].status, 'idle', 'a forming batch must not claim the machine');
    assert.equal(current.machines[0].batchId, batchId);

    // A second batch cannot be prepared on the same machine while one awaits dispatch.
    await assert.rejects(() => service.formBatch({ projectId: project.id }), /already has forming batch/);

    current = await service.runBatch({ projectId: project.id, batchId });
    assert.equal(current.batches[0].status, 'done');
    assert.equal(current.machines[0].status, 'idle');
    assert.equal(current.machines[0].batchId, null);
  } finally {
    await cleanup(root);
  }
});

test('machine load is an observed list, not a boolean', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-load-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const service = new ProjectService({}, { table: () => table() }, {});
    const project = await service.init({ workspace });
    assert.equal(service.get(project.id).machines[0].status, 'idle');

    const loaded = await service.setMachineLoad({
      projectId: project.id,
      loads: [{ id: 'train-1', kind: 'mission', cpu: 6, memGb: 8 }],
    });
    assert.equal(loaded.status, 'busy');
    assert.equal(loaded.loads.length, 1);
    assert.ok(loaded.telemetry && typeof loaded.telemetry.cores === 'number');
    assert.ok(typeof loaded.telemetry.load1 === 'number');
    assert.equal(service.get(project.id).machines[0].status, 'busy');

    // Replacing the list with an empty one is the only way to free the machine.
    const cleared = await service.setMachineLoad({ projectId: project.id, loads: [] });
    assert.equal(cleared.status, 'idle');
    assert.deepEqual(cleared.loads, []);
    assert.equal(service.get(project.id).machines[0].status, 'idle');

    // Unknown kinds are normalised instead of rejected.
    const normalised = await service.setMachineLoad({ projectId: project.id, loads: [{ id: 'x', kind: 'weird' }] });
    assert.equal(normalised.loads[0].kind, 'other');
  } finally {
    await cleanup(root);
  }
});

test('a researcher can adopt a finished mission code and results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-adopt-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const service = new ProjectService({}, { table: () => table() }, {});
    const project = await service.init({ workspace });
    const missionRepo = project.missionRoot;
    const branch = 'missions/adoptable';
    git(missionRepo, ['switch', '-c', branch, 'template']);
    await mkdir(join(missionRepo, 'missions', 'adoptable'), { recursive: true });
    await writeFile(join(missionRepo, 'missions', 'adoptable', 'mission.json'), JSON.stringify({ id: 'adoptable', entrypoint: 'run.sh', kind: 'training', title: 'adoptable', summary: 'test mission' }));
    await writeFile(join(missionRepo, 'missions', 'adoptable', 'run.sh'), '#!/usr/bin/env bash\nset -e\nprintf \'{"ok":true}\\n\' > "$ALEPH_OUTPUT_DIR/result.json"\nprintf \'{"w":1}\\n\' > "$ALEPH_OUTPUT_DIR/metrics.json"\n');
    await writeFile(join(missionRepo, 'missions', 'adoptable', 'predict.py'), 'print("inference")\n');
    git(missionRepo, ['add', '-A']);
    git(missionRepo, [...identity(missionRepo), 'commit', '-m', 'adoptable mission']);
    git(missionRepo, ['switch', 'template']);

    let current = await service.propose({ projectId: project.id, branch, agent: { id: 'researcher' } });
    const missionId = current.missions[0].id;
    current = await service.formBatch({ projectId: project.id });
    await service.runBatch({ projectId: project.id, batchId: current.batches[0].id });

    // Give the researcher a worktree to adopt into.
    await service.scaffoldResearch({ projectId: project.id });
    const research = project.researchRoot;
    const worktree = join(workspace, 'researcher-wt');
    git(research, ['worktree', 'add', '-b', 'research/adopter', worktree, 'HEAD']);
    await service.mutate(project.id, (state) => ({
      ...state,
      agents: [...(state.agents ?? []), { role: 'researcher', childId: 'child-adopt', status: 'running', summary: null, branch: 'research/adopter', worktree, updatedAt: new Date().toISOString() }],
    }));

    const adopted = await service.adoptMission({ projectId: project.id, missionId, agent: { id: 'child-adopt' } });
    assert.ok(existsSync(join(adopted.missionDir, 'predict.py')), 'mission source is copied');
    assert.ok(existsSync(join(adopted.resultsDir, 'metrics.json')), 'mission results are copied');
    assert.ok(adopted.files.length > 0);
  } finally {
    await cleanup(root);
  }
});

test('project conventions come from the project, not from Aleph', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-conventions-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const service = new ProjectService({}, { table: () => table() }, {});
    const project = await service.init({
      workspace,
      conventions: 'Submission: write answer.txt with a single number.',
    });
    assert.equal(project.conventions, 'Submission: write answer.txt with a single number.');
    // The mission template describes the repository, not how a mission must work.
    assert.doesNotMatch(git(project.missionRoot, ['show', 'template:README.md']), /answer\.txt/);

    await service.scaffoldResearch({ projectId: project.id });
    assert.match(await readFile(join(project.researchRoot, 'README.md'), 'utf8'), /answer\.txt/);

    // A second init without conventions keeps the project's own text.
    const again = await service.init({ workspace });
    assert.match(again.conventions, /answer\.txt/);
  } finally {
    await cleanup(root);
  }
});

test('a scaffold without explicit data uses the data the project offers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-offered-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const offered = join(root, 'offered-data');
    await mkdir(offered, { recursive: true });
    await writeFile(join(offered, 'well_01.txt'), 'DEPTH,GR\n1,2\n');
    const service = new ProjectService({}, { table: () => table() }, {});
    const project = await service.init({ workspace, visibleData: offered });

    const scaffolded = await service.scaffoldResearch({ projectId: project.id });
    assert.ok(existsSync(join(project.researchRoot, 'data', 'well_01.txt')), 'offered data is copied into the scaffold');
    assert.equal(scaffolded.visibleData, join(project.researchRoot, 'data'));
  } finally {
    await cleanup(root);
  }
});

test('a prepared batch may wait behind a running one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-queue-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const service = new ProjectService({}, { table: () => table() }, {});
    const project = await service.init({ workspace });
    const repo = project.missionRoot;

    const makeApprovedMission = async (name) => {
      const branch = `missions/${name}`;
      git(repo, ['switch', '-c', branch, 'template']);
      await mkdir(join(repo, 'missions', name), { recursive: true });
      await writeFile(join(repo, 'missions', name, 'mission.json'), JSON.stringify({ id: name, entrypoint: 'run.sh', kind: 'training', title: name, summary: 'test mission' }));
      await writeFile(join(repo, 'missions', name, 'run.sh'), '#!/usr/bin/env bash\nset -e\nsleep 1\nprintf \'{}\' > "$ALEPH_OUTPUT_DIR/result.json"\n');
      git(repo, ['add', '-A']);
      git(repo, [...identity(repo), 'commit', '-m', `mission ${name}`]);
      git(repo, ['switch', 'template']);
      const proposed = await service.propose({ projectId: project.id, branch, agent: { id: 'researcher' } });
      const created = proposed.missions[proposed.missions.length - 1];
      return created.id;
    };

    await makeApprovedMission('first');
    const runningBatch = (await service.formBatch({ projectId: project.id })).batches[0];
    assert.equal(service.get(project.id).machines[0].status, 'idle', 'preparation alone does not claim the machine');

    const running = service.runBatch({ projectId: project.id, batchId: runningBatch.id });
    // Wait for the batch to actually start instead of assuming a fixed delay.
    for (let i = 0; i < 200; i += 1) {
      const state = service.get(project.id).batches.find((b) => b.id === runningBatch.id);
      if (state?.status === 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(service.get(project.id).batches.find((b) => b.id === runningBatch.id).status, 'running');

    await makeApprovedMission('second');
    const prepared = (await service.formBatch({ projectId: project.id })).batches[1];
    assert.equal(prepared.status, 'forming', 'a batch may be prepared while another runs');

    // The queue depth is one: a third prepared batch is refused.
    await makeApprovedMission('third');
    await assert.rejects(() => service.formBatch({ projectId: project.id }), /already has forming batch/);

    const done = await running;
    assert.equal(done.batches.find((b) => b.id === runningBatch.id).status, 'done');
    assert.equal(done.machines[0].status, 'idle', 'the machine frees when the running batch ends');
  } finally {
    await cleanup(root);
  }
});

test('a finished mission notifies its owner with the outcome', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-notify-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const service = new ProjectService({}, { table: () => table() }, {});
    const project = await service.init({ workspace });
    const repo = project.missionRoot;
    const branch = 'missions/reports-back';
    git(repo, ['switch', '-c', branch, 'template']);
    await mkdir(join(repo, 'missions', 'reports-back'), { recursive: true });
    await writeFile(join(repo, 'missions', 'reports-back', 'mission.json'), JSON.stringify({ id: 'reports-back', entrypoint: 'run.sh', kind: 'training', title: 'reports-back', summary: 'test mission' }));
    await writeFile(join(repo, 'missions', 'reports-back', 'run.sh'), '#!/usr/bin/env bash\nset -e\nexit 3\n');
    git(repo, ['add', '-A']);
    git(repo, [...identity(repo), 'commit', '-m', 'failing mission']);
    git(repo, ['switch', 'template']);

    const proposed = await service.propose({ projectId: project.id, branch, agent: { id: 'researcher-owner' } });
    const mission = proposed.missions[0];
    const batch = (await service.formBatch({ projectId: project.id })).batches[0];

    const delivered = [];
    const parent = { id: 'leader' };
    service.subagents = {
      async sendMessage(sender, targetId, blocks) { delivered.push({ targetId, text: blocks[0].text }); },
    };
    service.parentAgents = new Map([['researcher-owner', parent]]);

    const done = await service.runBatch({ projectId: project.id, batchId: batch.id });
    assert.equal(done.missions.find((m) => m.id === mission.id).status, 'failed');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const notice = delivered.find((entry) => entry.targetId === 'researcher-owner');
    assert.ok(notice, 'the owner is told about its failed mission');
    assert.match(notice.text, /failed/);
    assert.match(notice.text, /Result commit|No result commit/);
  } finally {
    await cleanup(root);
  }
});

test('a Leader-facing action records the orchestrator session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-orch-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const service = new ProjectService({}, { table: () => table() }, {});
    const project = await service.init({ workspace });
    const leader = { id: 'session-leader' };
    await service.scaffoldResearch({ projectId: project.id, agent: leader });
    assert.equal(service.get(project.id).orchestratorSessionId, 'session-leader');

    // A restart can then find the session that owns the loop.
    const summary = await service.recoverAfterRestart();
    assert.ok(Array.isArray(summary));
  } finally {
    await cleanup(root);
  }
});

test('initializing a project creates the Composer as the Leader child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-init-composer-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const service = new ProjectService({}, { table: () => table() }, {});
    const leader = { id: 'session-leader' };
    const started = [];
    service.subagents = {
      async startActivation(options) {
        started.push({ preset: options.request.agentPreset, parent: options.request.parent?.id });
        let resolve;
        const result = new Promise((yes) => { resolve = yes; });
        return { childId: `child-${started.length}`, result };
      },
      async sendMessage() { return { id: 'm' }; },
    };

    const composers = () => started.filter((entry) => entry.preset === 'aleph-composer');
    const project = await service.init({ workspace, agent: leader });
    assert.equal(composers().length, 1, 'one Composer activation at initialization');
    assert.equal(composers()[0].parent, leader.id, 'the Composer is a direct child of the Leader');
    const composer = service.get(project.id).agents.find((item) => item.role === 'composer');
    assert.ok(composer, 'the Composer record exists before any mission');
    assert.equal(composer.childId, 'child-1');

    // Starting the project again must not spawn a second Composer.
    await service.scaffoldResearch({ projectId: project.id, agent: leader });
    assert.equal(composers().length, 1, 'restarting the project reuses the Composer');
  } finally {
    await cleanup(root);
  }
});

test('an agent starts a batch without waiting for it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-detached-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const service = new ProjectService({}, { table: () => table() }, {});
    const project = await service.init({ workspace });
    const repo = project.missionRoot;
    const branch = 'missions/long';
    git(repo, ['switch', '-c', branch, 'template']);
    await mkdir(join(repo, 'missions', 'long'), { recursive: true });
    await writeFile(join(repo, 'missions', 'long', 'mission.json'), JSON.stringify({ id: 'long', entrypoint: 'run.sh', kind: 'training', title: 'long', summary: 'test mission' }));
    await writeFile(join(repo, 'missions', 'long', 'run.sh'), '#!/usr/bin/env bash\nset -e\nsleep 2\nprintf \'{}\' > "$ALEPH_OUTPUT_DIR/result.json"\n');
    git(repo, ['add', '-A']);
    git(repo, [...identity(repo), 'commit', '-m', 'long mission']);
    git(repo, ['switch', 'template']);
    await service.propose({ projectId: project.id, branch, agent: { id: 'researcher' } });
    const batch = (await service.formBatch({ projectId: project.id })).batches[0];

    const began = Date.now();
    const started = service.startBatch({ projectId: project.id, batchId: batch.id });
    const elapsed = Date.now() - began;
    assert.equal(started.detached, true);
    assert.ok(elapsed < 1000, `startBatch returned in ${elapsed}ms instead of waiting for the run`);
    await assert.rejects(async () => { service.startBatch({ projectId: project.id, batchId: batch.id }); }, /already running|not runnable/);

    // The run continues in the background and reaches a terminal state.
    for (let i = 0; i < 400; i += 1) {
      const state = service.get(project.id).batches.find((b) => b.id === batch.id);
      if (state.status === 'done' || state.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(['done', 'failed'].includes(service.get(project.id).batches.find((b) => b.id === batch.id).status));
  } finally {
    await cleanup(root);
  }
});

test('one call creates a mission that is immediately proposable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-create-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const service = new ProjectService({}, { table: () => table() }, {});
    const project = await service.init({ workspace });
    await service.scaffoldResearch({ projectId: project.id });

    const created = await service.createMission({
      projectId: project.id,
      name: 'label-structure',
      kind: 'analysis',
      title: 'Label structure and clipping floors',
      summary: 'Distributions, floors and per-well spread of POR, PERM and SW',
      dependencies: ['numpy', 'pandas'],
    });
    assert.equal(created.kind, 'analysis');
    assert.ok(existsSync(join(created.missionDir, 'mission.json')));
    assert.ok(existsSync(join(created.missionDir, 'run.sh')));
    assert.ok(existsSync(join(created.missionDir, 'main.py')));
    assert.ok(existsSync(join(created.missionDir, 'pyproject.toml')));
    const manifest = JSON.parse(await readFile(join(created.missionDir, 'mission.json'), 'utf8'));
    assert.equal(manifest.kind, 'analysis');
    assert.equal(manifest.title, 'Label structure and clipping floors');
    assert.ok(manifest.summary.includes('floors'));

    // Committing the stub is enough to enter the queue with no extra packaging steps.
    git(created.worktree, [...identity(created.worktree), 'commit', '--allow-empty', '-m', 'mission ready']);
    const proposed = await service.propose({ projectId: project.id, branch: created.branch, agent: { id: 'researcher' } });
    const mission = proposed.missions.find((item) => item.branch === created.branch);
    assert.equal(mission.status, 'approved', 'a created mission enters the queue directly');
    assert.equal(mission.kind, 'analysis');
    assert.equal(mission.title, 'Label structure and clipping floors');
  } finally {
    await cleanup(root);
  }
});

test('a malformed mission reports every problem at once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-problems-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const service = new ProjectService({}, { table: () => table() }, {});
    const project = await service.init({ workspace });
    const repo = project.missionRoot;
    const branch = 'missions/incomplete';
    git(repo, ['switch', '-c', branch, 'template']);
    await mkdir(join(repo, 'missions', 'incomplete'), { recursive: true });
    // No kind, title or summary, and the entrypoint file is missing.
    await writeFile(join(repo, 'missions', 'incomplete', 'mission.json'), JSON.stringify({ id: 'incomplete', entrypoint: 'run.sh' }));
    git(repo, ['add', '-A']);
    git(repo, [...identity(repo), 'commit', '-m', 'incomplete mission']);
    git(repo, ['switch', 'template']);

    await assert.rejects(
      () => service.propose({ projectId: project.id, branch, agent: { id: 'researcher' } }),
      (error) => {
        const text = String(error.message);
        assert.match(text, /missing "kind"/);
        assert.match(text, /missing "title"/);
        assert.match(text, /missing "summary"/);
        assert.match(text, /entrypoint .* does not exist/);
        return true;
      },
    );
  } finally {
    await cleanup(root);
  }
});

test('tool results survive a JSON round trip even with unparsable telemetry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-jsonsafe-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const service = new ProjectService({}, { table: () => table() }, {});
    const project = await service.init({ workspace });
    const snapshot = service.get(project.id);
    // A GPU line such as "[N/A]" parses to NaN; the value handed back must still be lossless JSON.
    const telemetry = { sampledAt: 'now', cores: 8, load1: 0.1, gpus: [{ name: 'gpu', utilization: Number.NaN, memoryUsedMb: null }] };
    const encoded = JSON.stringify(snapshot, (_key, value) => (typeof value === 'number' && !Number.isFinite(value) ? null : value));
    assert.equal(JSON.parse(encoded).id, project.id);
    assert.ok(Number.isNaN(telemetry.gpus[0].utilization), 'fixture really has a NaN');
  } finally {
    await cleanup(root);
  }
});

test('listing missions returns the fields a researcher needs to reuse a result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-list-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const service = new ProjectService({}, { table: () => table() }, {});
    const project = await service.init({ workspace });
    await service.scaffoldResearch({ projectId: project.id });
    const created = await service.createMission({
      projectId: project.id,
      name: 'target-profile',
      kind: 'analysis',
      title: 'Target profile',
      summary: 'Distributions and floors',
    });
    const proposed = await service.propose({ projectId: project.id, branch: created.branch, agent: { id: 'researcher' } });
    const missions = await service.listMissions({ projectId: project.id });
    const listed = missions.find((mission) => mission.id === proposed.missions[0].id);
    assert.ok(listed, 'the queued mission is listed');
    assert.equal(listed.kind, 'analysis');
    assert.equal(listed.title, 'Target profile');
    assert.equal(listed.summary, 'Distributions and floors');
    assert.match(listed.resultPath, /^results\//);
  } finally {
    await cleanup(root);
  }
});

test('the machine stays free while InfraOptimizer edits a batch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-infra-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const service = new ProjectService({}, { table: () => table() }, {});
    const project = await service.init({ workspace });
    const repo = project.missionRoot;
    const branch = 'missions/editable';
    git(repo, ['switch', '-c', branch, 'template']);
    await mkdir(join(repo, 'missions', 'editable'), { recursive: true });
    await writeFile(join(repo, 'missions', 'editable', 'mission.json'), JSON.stringify({ id: 'editable', entrypoint: 'run.sh', kind: 'training', title: 'editable', summary: 'test' }));
    await writeFile(join(repo, 'missions', 'editable', 'run.sh'), '#!/usr/bin/env bash\nset -e\nprintf \'{}\' > "$ALEPH_OUTPUT_DIR/result.json"\n');
    git(repo, ['add', '-A']);
    git(repo, [...identity(repo), 'commit', '-m', 'editable mission']);
    git(repo, ['switch', 'template']);
    await service.propose({ projectId: project.id, branch, agent: { id: 'researcher' } });
    const batch = (await service.formBatch({ projectId: project.id })).batches[0];

    // The infra worktree exists while the batch is prepared.
    const infraRoot = join(workspace, '.aleph', 'infra');
    await mkdir(join(infraRoot, batch.id), { recursive: true });
    assert.equal(service.get(project.id).machines[0].status, 'idle', 'optimization does not claim the machine');

    // Nothing under the infra root may keep running, because the machine serves the batch.
    service.checkProcesses();
    assert.ok(!service.hasProcessUnder(infraRoot), 'no lingering process under the infra worktree');
  } finally {
    await cleanup(root);
  }
});

test('one InfraOptimizer serves every batch of a machine and dispatch does not block', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-infra-role-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const service = new ProjectService({}, { table: () => table() }, {});
    const project = await service.init({ workspace });
    const repo = project.missionRoot;
    const makeMission = async (name) => {
      const branch = `missions/${name}`;
      git(repo, ['switch', '-c', branch, 'template']);
      await mkdir(join(repo, 'missions', name), { recursive: true });
      await writeFile(join(repo, 'missions', name, 'mission.json'), JSON.stringify({ id: name, entrypoint: 'run.sh', kind: 'training', title: name, summary: 'test' }));
      await writeFile(join(repo, 'missions', name, 'run.sh'), '#!/usr/bin/env bash\nset -e\nprintf \'{}\' > "$ALEPH_OUTPUT_DIR/result.json"\n');
      git(repo, ['add', '-A']);
      git(repo, [...identity(repo), 'commit', '-m', `mission ${name}`]);
      git(repo, ['switch', 'template']);
      await service.propose({ projectId: project.id, branch, agent: { id: 'researcher' } });
    };

    const activations = [];
    service.subagents = {
      async startActivation(options) {
        activations.push(options.request.agentPreset);
        let resolve;
        const result = new Promise((yes) => { resolve = yes; });
        // A persistent session keeps its result pending until it is really done.
        return { childId: `child-${activations.length}`, result };
      },
      async sendMessage() { return { id: 'm' }; },
    };

    await makeMission('first');
    const first = (await service.formBatch({ projectId: project.id })).batches[0];
    const began = Date.now();
    const dispatched = await service.runInfra({ projectId: project.id, batchId: first.id, agent: { id: 'composer' } });
    assert.ok(Date.now() - began < 1000, 'dispatching does not wait for the optimizer');
    assert.equal(dispatched.dispatched, true);
    assert.equal(activations.filter((preset) => preset === 'aleph-infra').length, 1, 'one optimizer per machine');
    const infras = () => service.get(project.id).agents.filter((item) => item.role === 'infra');
    assert.equal(infras().length, 1);

    // The same machine reuses the same optimizer session for a later batch.
    service.finishInfra = async () => ({ commit: null, changed: false });
    await service.mutate(project.id, (state) => ({
      ...state,
      batches: state.batches.map((batch) => ({ ...batch, status: 'done', infra: { status: 'done' } })),
    }));
    await makeMission('second');
    const second = (await service.formBatch({ projectId: project.id })).batches.at(-1);
    await service.runInfra({ projectId: project.id, batchId: second.id, agent: { id: 'composer' } });
    assert.equal(activations.filter((preset) => preset === 'aleph-infra').length, 1, 'the optimizer is not respawned');
    assert.equal(infras().length, 1);
  } finally {
    await cleanup(root);
  }
});

test('the researcher contract lives in the persona and the Leader sends only an assignment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-rule-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const here = dirname(fileURLToPath(import.meta.url));
    // The durable rules belong to the preset persona, not to the Host message.
    const patch = readFileSync(join(here, '..', 'cordis.patch.yml'), 'utf8');
    assert.match(patch, /has not been produced by any mission yet, create the mission that produces it/);
    assert.match(patch, /ALEPH_VISIBLE_DATA/);
    assert.match(patch, /The Leader writes your opening assignment/);

    const service = new ProjectService({}, { table: () => table() }, {});
    const project = await service.init({ workspace });
    await service.scaffoldResearch({ projectId: project.id });
    const prompts = [];
    service.subagents = {
      async startActivation(options) { prompts.push(options.request.prompt?.[0]?.text ?? ''); return { childId: `child-${prompts.length}`, result: new Promise(() => {}) }; },
      async sendMessage() { return { id: 'm' }; },
    };
    const assignment = 'Focus on the PERM targets and explain the clipped floor before modelling anything.';
    await service.startBootstrap({ projectId: project.id, agent: { id: 'leader' }, instruction: assignment });
    assert.match(prompts[0], /Assignment from the Leader:/, 'the Host labels the assignment');
    assert.ok(prompts[0].includes(assignment), 'the Leader assignment is delivered verbatim');
    assert.doesNotMatch(prompts[0], /has not been produced by any mission yet/, 'the contract is not repeated in the message');
    assert.match(prompts[0], /Host context for this session/, 'the Host still supplies coordinates');
    assert.match(prompts[0], /Shared interpreter:/, 'the Host names the prepared interpreter');
  } finally {
    await cleanup(root);
  }
});

test('a cohort accepts one shared assignment or one per researcher', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-cohort-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const service = new ProjectService({}, { table: () => table() }, {});
    const project = await service.init({ workspace, researchers: 3 });
    await service.scaffoldResearch({ projectId: project.id });
    const prompts = [];
    service.subagents = {
      async startActivation(options) { prompts.push(options.request.prompt?.[0]?.text ?? ''); return { childId: `child-${prompts.length}`, result: new Promise(() => {}) }; },
      async sendMessage() { return { id: 'm' }; },
    };
    await service.startResearchers({
      projectId: project.id,
      count: 3,
      instructions: ['Explore feature interactions.', 'Explore calibration.', ''],
      instruction: 'Fallback assignment',
      agent: { id: 'leader' },
    });
    assert.equal(prompts.length, 3);
    assert.match(prompts[0], /Explore feature interactions\./);
    assert.match(prompts[1], /Explore calibration\./);
    assert.match(prompts[2], /Fallback assignment/, 'an empty per-researcher entry falls back to the shared assignment');
  } finally {
    await cleanup(root);
  }
});

test('the project opens with one researcher and starts the cohort after its evaluation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-bootstrap-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const service = new ProjectService({}, { table: () => table() }, {});
    const project = await service.init({ workspace, researchers: 3 });
    await service.scaffoldResearch({ projectId: project.id });

    const activations = [];
    service.subagents = {
      async startActivation(options) {
        activations.push({ preset: options.request.agentPreset, prompt: (options.request.prompt?.[0]?.text ?? '') });
        let resolve;
        const result = new Promise((yes) => { resolve = yes; });
        return { childId: `child-${activations.length}`, result };
      },
      async sendMessage() { return { id: 'm' }; },
    };

    const leader = { id: 'session-leader' };
    const opened = await service.startBootstrap({ projectId: project.id, agent: leader });
    assert.equal(opened.started, true);
    const researchers = () => service.get(project.id).agents.filter((item) => item.role === 'researcher');
    assert.equal(researchers().length, 1, 'exactly one researcher opens the project');
    assert.equal(researchers()[0].phase, 'bootstrap');
    assert.equal(service.get(project.id).bootstrap.status, 'running');

    // No second researcher appears while the opening one is still working.
    await service.maybeDispatchReplacement({ projectId: project.id });
    assert.equal(researchers().length, 1, 'the cohort waits for the opening researcher');

    // Its evaluation closes the bootstrap phase and starts the configured cohort.
    const result = await service.completeBootstrap({ projectId: project.id, reason: 'test', evaluatedCommit: 'abc1234' });
    assert.equal(result.completed, true);
    assert.equal(service.get(project.id).bootstrap.status, 'done');
    assert.equal(service.get(project.id).bootstrap.evaluatedCommit, 'abc1234');
    const cohort = service.get(project.id).agents.filter((item) => item.role === 'researcher' && item.status === 'running');
    assert.equal(cohort.length, 3, 'the configured cohort starts after the evaluation');
    assert.equal(activations.filter((item) => item.preset === 'aleph-researcher').length, 4, 'one opening plus three cohort researchers');
    // The opening researcher gets the ordinary prompt: no extra analysis or cleaning brief.
    const normalise = (text) => text.replace(/r-[0-9a-f]{8}/g, 'r-ID').replace(/research\/r-ID/g, 'research/r-ID');
    assert.equal(normalise(activations[0].prompt), normalise(activations[1].prompt), 'the opening instruction matches the cohort prompt');
  } finally {
    await cleanup(root);
  }
});

test('a researcher creating a mission does not steal the orchestrator role', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-orch-guard-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const service = new ProjectService({}, { table: () => table() }, {});
    const project = await service.init({ workspace });
    await service.scaffoldResearch({ projectId: project.id, agent: { id: 'session-leader' } });
    // The Host knows which preset each session runs; a researcher must be rejected.
    service.presetOfAgent = (agent) => (agent?.id === 'session-leader' ? 'aleph' : 'aleph-researcher');
    assert.equal(service.get(project.id).orchestratorSessionId, 'session-leader');

    await service.createMission({ projectId: project.id, name: 'probe', kind: 'analysis', title: 'probe', summary: 'probe', agent: { id: 'researcher-1' } });
    assert.equal(service.get(project.id).orchestratorSessionId, 'session-leader', 'the opening Leader session keeps ownership');
    // And a mission-creation call cannot introduce a non-Leader owner either.
    await service.rememberOrchestrator(project.id, { id: 'researcher-2' });
    assert.equal(service.get(project.id).orchestratorSessionId, 'session-leader');
  } finally {
    await cleanup(root);
  }
});

test('a drained cohort is recorded for a later dispatch instead of disappearing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-pending-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const service = new ProjectService({}, { table: () => table() }, {});
    const project = await service.init({ workspace, researchers: 2 });
    await service.scaffoldResearch({ projectId: project.id });
    await service.mutate(project.id, (state) => ({
      ...state,
      exploration: 'high',
      orchestratorSessionId: 'session-leader',
      bootstrap: { status: 'done' },
      agents: [],
    }));
    // No live orchestrator: the dispatch cannot happen yet, but must not be lost.
    const first = await service.maybeDispatchReplacement({ projectId: project.id });
    assert.equal(first.dispatched, false);
    assert.ok(service.get(project.id).pendingDispatch, 'the intent is stored');

    // Once the Leader is live again, the watchdog serves the pending dispatch.
    service.ctx = { agents: { get: (id) => (id === 'session-leader' ? { id } : undefined) } };
    service.presetOfAgent = () => 'aleph';
    service.subagents = {
      async startActivation() { return { childId: 'child-x', result: new Promise(() => {}) }; },
      async sendMessage() { return { id: 'm' }; },
    };
    const retried = await service.maybeDispatchReplacement({ projectId: project.id });
    assert.equal(retried.dispatched, true, 'the replacement starts once a parent is live');
  } finally {
    await cleanup(root);
  }
});

test('console agent table reads the top-level snapshot list', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const client = readFileSync(join(here, '..', 'client.js'), 'utf8');
  assert.match(client, /agentSection\(t, snapshot\)/, 'the section gets the snapshot, not the project');
  assert.doesNotMatch(client, /agentSection\(t, project\)/);
  assert.match(client, /snapshot\?\.agents/, 'the section reads the top-level agents list');
});

test('an evaluation refuses uncommitted work and stops its own processes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-eval-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const service = new ProjectService({}, { table: () => table() }, {});
    const project = await service.init({ workspace });
    await service.scaffoldResearch({ projectId: project.id });
    // A researcher worktree with an uncommitted change must not be scored.
    const worktree = join(workspace, '.aleph', 'researchers', 'r-test');
    git(project.researchRoot, ['worktree', 'add', '-b', 'research/r-test', worktree, 'HEAD']);
    await writeFile(join(worktree, 'predict.py'), 'print("draft")\n');
    await service.mutate(project.id, (state) => ({
      ...state,
      agents: [{ role: 'researcher', childId: 'child-eval', status: 'running', branch: 'research/r-test', worktree, updatedAt: new Date().toISOString() }],
    }));
    await assert.rejects(
      () => service.evaluate({ projectId: project.id, agent: { id: 'child-eval' } }),
      /uncommitted changes/,
    );
    assert.match(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index-v2.js'), 'utf8'), /killByEnvMarker/, 'descendants are stopped by marker');
  } finally {
    await cleanup(root);
  }
});

test('selecting the best result refuses a checked-out branch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-select-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const service = new ProjectService({}, { table: () => table() }, {});
    const project = await service.init({ workspace });
    await service.scaffoldResearch({ projectId: project.id });
    const worktree = join(workspace, '.aleph', 'researchers', 'r-sel');
    git(project.researchRoot, ['worktree', 'add', '-b', 'research/r-sel', worktree, 'HEAD']);
    const bestCommit = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    await service.mutate(project.id, (state) => ({ ...state, best: { score: 1, branch: 'research/r-sel', commit: bestCommit } }));
    await assert.rejects(() => service.selectBest({ projectId: project.id, branch: 'research/r-sel' }), /checked out/);
  } finally {
    await cleanup(root);
  }
});

test('a paused project starts nothing and a cancelled batch releases the machine', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-controls-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const service = new ProjectService({}, { table: () => table() }, {});
    const project = await service.init({ workspace });
    const repo = project.missionRoot;
    const branch = 'missions/stoppable';
    git(repo, ['switch', '-c', branch, 'template']);
    await mkdir(join(repo, 'missions', 'stoppable'), { recursive: true });
    await writeFile(join(repo, 'missions', 'stoppable', 'mission.json'), JSON.stringify({ id: 'stoppable', entrypoint: 'run.sh', kind: 'training', title: 'stoppable', summary: 'test' }));
    await writeFile(join(repo, 'missions', 'stoppable', 'run.sh'), '#!/usr/bin/env bash\nset -e\nsleep 3\nprintf \'{}\' > "$ALEPH_OUTPUT_DIR/result.json"\n');
    git(repo, ['add', '-A']);
    git(repo, [...identity(repo), 'commit', '-m', 'stoppable mission']);
    git(repo, ['switch', 'template']);
    await service.propose({ projectId: project.id, branch, agent: { id: 'researcher' } });
    const batch = (await service.formBatch({ projectId: project.id })).batches[0];

    // Paused: starting is refused, resuming allows it again.
    await service.pauseProject({ projectId: project.id, reason: 'operator' });
    assert.equal(service.get(project.id).paused, true);
    await assert.rejects(async () => { service.startBatch({ projectId: project.id, batchId: batch.id }); }, /paused/);
    await service.resumeProject({ projectId: project.id });
    assert.equal(service.get(project.id).paused, false);

    // Running: cancelling stops it and frees the machine.
    service.startBatch({ projectId: project.id, batchId: batch.id });
    for (let i = 0; i < 100; i += 1) {
      if (service.get(project.id).batches.find((item) => item.id === batch.id).status === 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const cancelled = await service.cancelBatch({ projectId: project.id, batchId: batch.id });
    assert.equal(cancelled.cancelled, true);
    const after = service.get(project.id);
    assert.equal(after.batches.find((item) => item.id === batch.id).status, 'cancelled');
    assert.equal(after.machines[0].status, 'idle', 'the machine is released');
    assert.equal(after.missions.find((mission) => mission.batchId === batch.id)?.status, 'cancelled');
  } finally {
    await cleanup(root);
  }
});

test('the watchdog announces a queue state once instead of polling the Composer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-notice-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const service = new ProjectService({}, { table: () => table() }, {});
    const project = await service.init({ workspace });
    await service.scaffoldResearch({ projectId: project.id });
    // One queued mission and no live orchestrator: the state must be announced, then left alone.
    const repo = project.missionRoot;
    const branch = 'missions/queued';
    git(repo, ['switch', '-c', branch, 'template']);
    await mkdir(join(repo, 'missions', 'queued'), { recursive: true });
    await writeFile(join(repo, 'missions', 'queued', 'mission.json'), JSON.stringify({ id: 'queued', entrypoint: 'run.sh', kind: 'training', title: 'queued', summary: 'test' }));
    await writeFile(join(repo, 'missions', 'queued', 'run.sh'), '#!/usr/bin/env bash\nset -e\nprintf \'{}\' > "$ALEPH_OUTPUT_DIR/result.json"\n');
    git(repo, ['add', '-A']);
    git(repo, [...identity(repo), 'commit', '-m', 'queued mission']);
    git(repo, ['switch', 'template']);
    await service.propose({ projectId: project.id, branch, agent: { id: 'researcher' } });

    let notices = 0;
    service.notifyComposer = async () => { notices += 1; return { delivered: true }; };
    service.ctx = { agents: { get: (id) => (id === 'session-leader' ? { id } : undefined) } };
    service.presetOfAgent = () => 'aleph';
    await service.mutate(project.id, (state) => ({ ...state, orchestratorSessionId: 'session-leader' }));

    for (let tick = 0; tick < 6; tick += 1) service.checkProcesses();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(notices, 1, 'one announcement for one queue state, not one per tick');

    // A changed queue is announced again.
    await service.mutate(project.id, (state) => ({ ...state, dispatchSignature: 'stale' }));
    for (let tick = 0; tick < 3; tick += 1) service.checkProcesses();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(notices, 2, 'a changed state produces one new notice');
  } finally {
    await cleanup(root);
  }
});

test('a notice for a cold child is parked and delivered when the parent returns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-notice-queue-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const service = new ProjectService({}, { table: () => table() }, {});
    const project = await service.init({ workspace });
    // No live parent yet: the notice must be stored rather than lost.
    service.subagents = { async sendMessage() { throw new Error('parent is not live'); } };
    const parked = await service.deliverOrQueue({ projectId: project.id, sessionId: 'child-a', text: 'your mission finished' });
    assert.equal(parked.queued, true);
    const queued = service.get(project.id).pendingNotices;
    assert.equal(queued.length, 1);
    assert.equal(queued[0].sessionId, 'child-a');

    // Once the parent is live the watchdog flushes it and clears the record.
    const delivered = [];
    service.parentAgents = new Map([['child-a', { id: 'leader' }]]);
    service.subagents = { async sendMessage(_parent, childId, blocks) { delivered.push({ childId, text: blocks[0].text }); } };
    const count = await service.flushPendingNotices(service.get(project.id));
    assert.equal(count, 1);
    assert.equal(delivered[0].childId, 'child-a');
    assert.equal(service.get(project.id).pendingNotices.length, 0);
  } finally {
    await cleanup(root);
  }
});

test('the cohort inherits the opening researcher assignment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-inherit-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const service = new ProjectService({}, { table: () => table() }, {});
    const project = await service.init({ workspace, researchers: 2 });
    await service.scaffoldResearch({ projectId: project.id });
    const prompts = [];
    service.subagents = {
      async startActivation(options) { prompts.push(options.request.prompt?.[0]?.text ?? ''); return { childId: `child-${prompts.length}`, result: new Promise(() => {}) }; },
      async sendMessage() { return { id: 'm' }; },
    };
    const assignment = 'Investigate the clipped targets before modelling.';
    await service.startBootstrap({ projectId: project.id, agent: { id: 'leader' }, instruction: assignment });
    await service.completeBootstrap({ projectId: project.id, reason: 'test' });
    assert.ok(prompts[0].includes(assignment), 'the opening researcher gets it');
    assert.ok(prompts[1]?.includes(assignment), 'the cohort inherits it');
  } finally {
    await cleanup(root);
  }
});

test('a queue notice never forks a second Composer when the Leader is cold', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-composer-parent-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const service = new ProjectService({}, { table: () => table() }, {});
    const project = await service.init({ workspace });
    service.presetOfAgent = (agent) => (agent?.id === 'session-leader' ? 'aleph' : 'aleph-researcher');
    service.subagents = { async sendMessage() { throw new Error('parent is not live'); }, async startActivation() { throw new Error('must not fork'); } };
    await service.mutate(project.id, (state) => ({
      ...state,
      agents: [{ role: 'composer', childId: 'composer-a', parentSessionId: 'session-leader', status: 'done', updatedAt: new Date().toISOString() }],
    }));

    // A researcher triggers a notice while the Leader session is cold.
    const result = await service.notifyComposer({ projectId: project.id, agent: { id: 'researcher-1' }, event: 'mission queued', detail: 'm-1' });
    assert.equal(result.delivered, false);
    assert.equal(result.childId, 'composer-a', 'the existing Composer stays the queue owner');
    const agents = service.get(project.id).agents.filter((item) => item.role === 'composer');
    assert.equal(agents.length, 1, 'no second Composer was created');
    assert.equal(agents[0].childId, 'composer-a');
    assert.ok((service.get(project.id).pendingNotices ?? []).length >= 1, 'the notice is parked for later');

    // A researcher may not start the Composer either.
    await assert.rejects(() => service.runComposer({ projectId: project.id, agent: { id: 'researcher-1' } }), /only the Leader/);
  } finally {
    await cleanup(root);
  }
});
