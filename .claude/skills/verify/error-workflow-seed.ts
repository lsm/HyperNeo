import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { SpaceRepository } from '../../../packages/daemon/src/storage/repositories/space-repository.ts';
import { SpaceWorkflowRepository } from '../../../packages/daemon/src/storage/repositories/space-workflow-repository.ts';
const run = process.argv[2];
assert(run && process.env.NODE_ENV === 'test');
execFileSync('bun', ['.claude/skills/verify/step-result-disclosure-seed.ts', run], { stdio: 'inherit' });
const { worker } = JSON.parse(readFileSync(`${run}/evidence/steps-seed.json`, 'utf8'));
const db = new Database(`${run}/data/daemon.db`);
try {
  const space = new SpaceRepository(db).createSpace({ name: 'Synthetic disclosure space', slug: 'synthetic-disclosure', workspacePath: run, autonomyLevel: 3 });
  const workflows = new SpaceWorkflowRepository(db);
  workflows.createWorkflow({ spaceId: space.id, name: 'Synthetic automatic workflow', nodes: [], completionAutonomyLevel: 2 });
  workflows.createWorkflow({ spaceId: space.id, name: 'Synthetic blocked workflow', nodes: [], completionAutonomyLevel: 5 });
  writeFileSync(`${run}/evidence/error-workflow-seed.json`, JSON.stringify({ worker, spaceId: space.id, synthetic: true }, null, 2));
} finally { db.close(); }
