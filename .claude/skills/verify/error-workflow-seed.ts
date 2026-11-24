import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { SDKMessageRepository } from '../../../packages/daemon/src/storage/repositories/sdk-message-repository.ts';
import { SpaceRepository } from '../../../packages/daemon/src/storage/repositories/space-repository.ts';
import { SpaceWorkflowRepository } from '../../../packages/daemon/src/storage/repositories/space-workflow-repository.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import type { SDKMessage } from '../../../packages/shared/src/sdk/sdk.d.ts';
const run = process.argv[2];
assert(run && process.env.NODE_ENV === 'test');
execFileSync('bun', ['.claude/skills/verify/step-result-disclosure-seed.ts', run], { stdio: 'inherit' });
const { worker } = JSON.parse(readFileSync(`${run}/evidence/steps-seed.json`, 'utf8'));
const db = new Database(`${run}/data/daemon.db`);
try {
  let spaceId: string | undefined;
  if (process.argv.includes('--chat-error-row')) {
    const messages = new SDKMessageRepository(db);
    for (let index = 1; index <= 25; index++) {
      const text =
        index === 25 ? 'Synthetic request that failed' : `Synthetic earlier message ${index}`;
      messages.saveUserMessage(
        worker,
        {
          type: 'user',
          uuid: crypto.randomUUID(),
          session_id: worker,
          parent_tool_use_id: null,
          timestamp: Date.now() + index,
          message: { role: 'user', content: text },
        } as unknown as SDKMessage,
        'consumed',
        'human'
      );
    }
  } else {
    const space = new SpaceRepository(db).createSpace({ name: 'Synthetic disclosure space', slug: 'synthetic-disclosure', workspacePath: run, autonomyLevel: 3 });
    spaceId = space.id;
    const workflows = new SpaceWorkflowRepository(db);
    workflows.createWorkflow({ spaceId: space.id, name: 'Synthetic automatic workflow', nodes: [], completionAutonomyLevel: 2 });
    workflows.createWorkflow({ spaceId: space.id, name: 'Synthetic blocked workflow', nodes: [], completionAutonomyLevel: 5 });
  }
  writeFileSync(
    `${run}/evidence/error-workflow-seed.json`,
    JSON.stringify({ worker, spaceId, synthetic: true }, null, 2)
  );
} finally { db.close(); }
