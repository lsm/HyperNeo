import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { SDKMessageRepository } from '../../../packages/daemon/src/storage/repositories/sdk-message-repository.ts';
import type { SDKMessage } from '../../../packages/shared/src/sdk/sdk.d.ts';
const run = process.argv[2];
const long = process.argv.includes('--long');
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
  if (long) {
    save({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'synthetic-long-read', name: 'Bash', input: { command: 'synthetic-long-output' } }] } });
    save({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'synthetic-long-read', content: 'Synthetic long result line.\n'.repeat(200) }] } });
  }
  save({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'synthetic-agent', name: 'Agent', input: { subagent_type: 'Explore', description: 'Synthetic exploration', prompt: 'Find synthetic evidence' } }] } });
  save({ type: 'assistant', parent_tool_use_id: 'synthetic-agent', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'synthetic-nested-read', name: 'Read', input: { file_path: 'nested-synthetic.txt' } }] } });
  save({ type: 'user', parent_tool_use_id: 'synthetic-agent', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'synthetic-nested-read', content: 'Nested synthetic evidence.\nShort nested ending.' }] } });
  save({ type: 'tool_progress', parent_tool_use_id: 'synthetic-agent', tool_use_id: 'synthetic-nested-read', tool_name: 'Read', elapsed_time_seconds: 3 });
  save({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'synthetic-agent', content: 'Synthetic subagent final evidence.\n\n' + (long ? 'Synthetic long paragraph.\n\n'.repeat(100) : '') + 'Short final paragraph.' }] } });
  if (long) for (let i = 0; i < 20; i++) save({ type: 'user', message: { role: 'user', content: `Synthetic later message ${i}` } });
  writeFileSync(`${run}/evidence/sdk-tool-seed.json`, JSON.stringify({ worker, synthetic: true }, null, 2));
} finally { db.close(); }
