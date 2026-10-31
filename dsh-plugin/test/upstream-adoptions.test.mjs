import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ProjectService } from '../index-v2.js';

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
    await rm(root, { recursive: true, force: true });
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
    await rm(root, { recursive: true, force: true });
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
    await rm(root, { recursive: true, force: true });
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
    await writeFile(join(missionRepo, 'missions', 'late', 'mission.json'), JSON.stringify({ id: 'late', entrypoint: 'run.sh' }));
    await writeFile(join(missionRepo, 'missions', 'late', 'run.sh'), '#!/usr/bin/env bash\nset -e\nprintf \'{"ok":true}\\n\' > "$ALEPH_OUTPUT_DIR/result.json"\n');
    execFileSync('chmod', ['+x', join(missionRepo, 'missions', 'late', 'run.sh')]);
    git(missionRepo, ['add', '-A']);
    git(missionRepo, [...identity(missionRepo), 'commit', '-m', 'mission late']);
    git(missionRepo, ['switch', 'template']);

    let current = await service.propose({ projectId: project.id, branch, agent: { id: 'researcher' } });
    const missionId = current.missions[0].id;
    await service.approve({ projectId: project.id, missionId });
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
    await rm(root, { recursive: true, force: true });
  }
});

test('a Host restart frees the machine and fails interrupted work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-recovery-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const records = table();
    const service = new ProjectService({}, { table: () => records }, {});
    const project = await service.init({ workspace });
    const missionRepo = project.missionRoot;
    const branch = 'missions/slow';
    git(missionRepo, ['switch', '-c', branch, 'template']);
    await mkdir(join(missionRepo, 'missions', 'slow'), { recursive: true });
    await writeFile(join(missionRepo, 'missions', 'slow', 'mission.json'), JSON.stringify({ id: 'slow', entrypoint: 'run.sh' }));
    await writeFile(join(missionRepo, 'missions', 'slow', 'run.sh'), '#!/usr/bin/env bash\nsleep 30\n');
    git(missionRepo, ['add', '-A']);
    git(missionRepo, [...identity(missionRepo), 'commit', '-m', 'slow mission']);
    git(missionRepo, ['switch', 'template']);

    let current = await service.propose({ projectId: project.id, branch, agent: { id: 'researcher' } });
    const missionId = current.missions[0].id;
    await service.approve({ projectId: project.id, missionId });
    current = await service.formBatch({ projectId: project.id });
    const batchId = current.batches[0].id;

    // Simulate the state a restart leaves behind: the batch says running, the machine is busy.
    await service.mutate(project.id, (state) => ({
      ...state,
      machines: state.machines.map((machine) => ({ ...machine, status: 'busy', batchId })),
      batches: state.batches.map((batch) => (batch.id === batchId ? { ...batch, status: 'running' } : batch)),
    }));

    await service.recoverAfterRestart();
    const recovered = service.get(project.id);
    assert.equal(recovered.batches[0].status, 'failed');
    assert.match(recovered.batches[0].summary.runnerError, /restart/);
    assert.equal(recovered.missions[0].status, 'failed');
    assert.match(recovered.missions[0].error, /restart/);
    assert.equal(recovered.machines[0].status, 'idle');
    assert.equal(recovered.machines[0].batchId, null);
  } finally {
    await rm(root, { recursive: true, force: true });
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
    await rm(root, { recursive: true, force: true });
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
    await writeFile(join(missionRepo, 'missions', 'quick', 'mission.json'), JSON.stringify({ id: 'quick', entrypoint: 'run.sh' }));
    await writeFile(join(missionRepo, 'missions', 'quick', 'run.sh'), '#!/usr/bin/env bash\nset -e\nprintf \'{}\\n\' > "$ALEPH_OUTPUT_DIR/result.json"\n');
    git(missionRepo, ['add', '-A']);
    git(missionRepo, [...identity(missionRepo), 'commit', '-m', 'quick mission']);
    git(missionRepo, ['switch', 'template']);

    let current = await service.propose({ projectId: project.id, branch, agent: { id: 'researcher' } });
    const missionId = current.missions[0].id;
    await service.approve({ projectId: project.id, missionId });
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
    await rm(root, { recursive: true, force: true });
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
    await rm(root, { recursive: true, force: true });
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
    await writeFile(join(missionRepo, 'missions', 'adoptable', 'mission.json'), JSON.stringify({ id: 'adoptable', entrypoint: 'run.sh' }));
    await writeFile(join(missionRepo, 'missions', 'adoptable', 'run.sh'), '#!/usr/bin/env bash\nset -e\nprintf \'{"ok":true}\\n\' > "$ALEPH_OUTPUT_DIR/result.json"\nprintf \'{"w":1}\\n\' > "$ALEPH_OUTPUT_DIR/metrics.json"\n');
    await writeFile(join(missionRepo, 'missions', 'adoptable', 'predict.py'), 'print("inference")\n');
    git(missionRepo, ['add', '-A']);
    git(missionRepo, [...identity(missionRepo), 'commit', '-m', 'adoptable mission']);
    git(missionRepo, ['switch', 'template']);

    let current = await service.propose({ projectId: project.id, branch, agent: { id: 'researcher' } });
    const missionId = current.missions[0].id;
    await service.approve({ projectId: project.id, missionId });
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
    await rm(root, { recursive: true, force: true });
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
    assert.match(git(project.missionRoot, ['show', 'template:README.md']), /Project conventions[\s\S]*answer\.txt/);

    await service.scaffoldResearch({ projectId: project.id });
    assert.match(await readFile(join(project.researchRoot, 'README.md'), 'utf8'), /answer\.txt/);

    // A second init without conventions keeps the project's own text.
    const again = await service.init({ workspace });
    assert.match(again.conventions, /answer\.txt/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
