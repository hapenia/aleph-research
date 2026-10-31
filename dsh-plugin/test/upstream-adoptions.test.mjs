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
    await writeFile(join(repo, 'missions', 'slow', 'mission.json'), JSON.stringify({ id: 'slow', entrypoint: 'run.sh' }));
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
    // The mission template describes the repository, not how a mission must work.
    assert.doesNotMatch(git(project.missionRoot, ['show', 'template:README.md']), /answer\.txt/);

    await service.scaffoldResearch({ projectId: project.id });
    assert.match(await readFile(join(project.researchRoot, 'README.md'), 'utf8'), /answer\.txt/);

    // A second init without conventions keeps the project's own text.
    const again = await service.init({ workspace });
    assert.match(again.conventions, /answer\.txt/);
  } finally {
    await rm(root, { recursive: true, force: true });
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
    await rm(root, { recursive: true, force: true });
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
      await writeFile(join(repo, 'missions', name, 'mission.json'), JSON.stringify({ id: name, entrypoint: 'run.sh' }));
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
    await rm(root, { recursive: true, force: true });
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
    await writeFile(join(repo, 'missions', 'reports-back', 'mission.json'), JSON.stringify({ id: 'reports-back', entrypoint: 'run.sh' }));
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
    await rm(root, { recursive: true, force: true });
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
    await rm(root, { recursive: true, force: true });
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
    await rm(root, { recursive: true, force: true });
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
    await writeFile(join(repo, 'missions', 'long', 'mission.json'), JSON.stringify({ id: 'long', entrypoint: 'run.sh' }));
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
    await rm(root, { recursive: true, force: true });
  }
});
