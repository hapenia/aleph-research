import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ProjectService } from '../index-v2.js';

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function table() {
  const records = new Map();
  return {
    get: (key) => records.get(key),
    put: async (key, value) => { records.set(key, value); },
    entries: () => records.entries(),
  };
}

test('project mission flows through approval, batch, result cherry-pick and evaluate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aleph-project-test-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const campaignTable = table();
    const service = new ProjectService({}, { table: () => campaignTable }, {});
    const project = await service.init({
      workspace,
      evalCommand: "python3 -c \"import json;print(json.dumps({'score': 1}))\"",
    });

    const missionRepo = join(workspace, 'missions');
    git(missionRepo, ['switch', '-c', 'mission/test', 'template']);
    await mkdir(join(missionRepo, 'missions', 'm-test'), { recursive: true });
    await writeFile(join(missionRepo, 'missions', 'm-test', 'mission.json'), JSON.stringify({
      id: 'm-test', entrypoint: 'run.sh', kind: 'training', title: 'm-test', summary: 'test mission',
      outputs: [{ key: 'score' }], resource: { cpu: 1 },
    }));
    await writeFile(join(missionRepo, 'missions', 'm-test', 'run.sh'), '#!/usr/bin/env bash\nset -e\nprintf \'{"score": 1}\\n\' > "$ALEPH_OUTPUT_DIR/score.json"\n');
    execFileSync('chmod', ['+x', join(missionRepo, 'missions', 'm-test', 'run.sh')]);
    git(missionRepo, ['add', '-A']);
    git(missionRepo, ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-m', 'mission test']);
    git(missionRepo, ['switch', 'template']);

    const researcher = { id: 'researcher-test' };
    let current = await service.propose({ projectId: project.id, branch: 'mission/test', agent: researcher });
    const mission = current.missions[0];
    assert.equal(mission.status, 'approved');

    const waiting = await service.evaluate({ projectId: project.id, agent: researcher });
    assert.equal(waiting.status, 'waiting');
    assert.equal(waiting.pending[0].id, mission.id);

    const otherResearcher = await service.evaluate({ projectId: project.id, agent: { id: 'other' } });
    assert.equal(otherResearcher.status, 'done');


    current = await service.formBatch({ projectId: project.id });
    const batch = current.batches[0];
    assert.equal(batch.status, 'forming');
    assert.equal(current.missions[0].status, 'batched');

    current = await service.runBatch({ projectId: project.id, batchId: batch.id });
    assert.equal(current.batches[0].status, 'done');
    assert.equal(current.missions[0].status, 'done');
    assert.ok(current.missions[0].resultCommit);
    const result = JSON.parse(git(missionRepo, ['show', 'mission/test:results/m-test/result.json']));
    assert.equal(result.mission_id, 'm-test');
    assert.equal(result.status, 'done');
    assert.equal(result.batch_id, batch.id);

    const evaluation = await service.evaluate({ projectId: project.id, agent: researcher });
    assert.equal(evaluation.status, 'done');
    assert.equal(evaluation.score, 1);
    const message = git(join(workspace, 'research'), ['log', '-1', '--format=%B']);
    assert.match(message, /Aleph-Evaluation: 1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
