import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { SDKMessageRepository } from '../../../packages/daemon/src/storage/repositories/sdk-message-repository.ts';
import type { SDKMessage } from '../../../packages/shared/src/sdk/sdk.d.ts';
const run = process.argv[2];
assert(run && process.env.NODE_ENV === 'test');
execFileSync('bun', ['.claude/skills/verify/step-result-disclosure-seed.ts', run], { stdio: 'inherit' });
const { worker } = JSON.parse(readFileSync(`${run}/evidence/steps-seed.json`, 'utf8'));
const db = new Database(`${run}/data/daemon.db`);
try {
  const messages = new SDKMessageRepository(db);
  const save = (body: Record<string, unknown>) => {
    const message = { uuid: crypto.randomUUID(), session_id: worker, timestamp: Date.now(), parent_tool_use_id: null, ...body } as unknown as SDKMessage;
    if (message.type === 'user') messages.saveUserMessage(worker, message, 'consumed', 'human');
    else assert(messages.saveSDKMessage(worker, message));
  };
  save({ type: 'system', subtype: 'memory_recall', memories: [{ scope: 'project', path: 'synthetic-memory.md' }] });
  save({ type: 'system', subtype: 'hook_response', hook_name: 'synthetic-hook', hook_event: 'PreToolUse', stdout: 'Synthetic hook summary\n' + 'Synthetic full hook detail.\n'.repeat(100), stderr: 'Synthetic diagnostic', exit_code: 1 });
  save({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 150000 } });
  save({ type: 'synthetic_unknown', payload: 'Synthetic raw evidence' });
  for (let i = 0; i < 20; i++) save({ type: 'user', message: { role: 'user', content: `Synthetic later history ${i}` } });
  writeFileSync(`${run}/evidence/sdk-system-seed.json`, JSON.stringify({ worker, synthetic: true }, null, 2));
} finally { db.close(); }
