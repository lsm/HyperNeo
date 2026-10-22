import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { SDKMessageRepository } from '../../../packages/daemon/src/storage/repositories/sdk-message-repository.ts';
import type { SDKMessage } from '../../../packages/shared/src/sdk/sdk.d.ts';
const run = process.argv[2];
assert(run && process.env.NODE_ENV === 'test');
execFileSync('bun', ['.claude/skills/verify/neo-todo-collapse-seed.ts', run], { stdio: 'inherit' });
const { root } = JSON.parse(readFileSync(`${run}/evidence/seed.json`, 'utf8'));
const worker = '40000000-0000-4000-8000-000000008097';
const db = new Database(`${run}/data/daemon.db`);
try {
  db.prepare(`INSERT INTO sessions(id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?,'Synthetic steps and results',?,datetime('now'),datetime('now'),'active','{"queryMode":"manual","messageDisplayMode":"compact"}','{}')`).run(worker, run);
  db.prepare("INSERT INTO neo_todo_sessions(todo_id,target,ref) VALUES ('collapse-card-1','{}',?)").run(JSON.stringify({ adapter: 'hyperneo', id: worker }));
  const messages = new SDKMessageRepository(db);
  const save = (body: Record<string, unknown>) => {
    const message = { uuid: crypto.randomUUID(), session_id: worker, timestamp: Date.now(), parent_tool_use_id: null, ...body } as unknown as SDKMessage;
    if (message.type === 'user') messages.saveUserMessage(worker, message, 'consumed', 'human');
    else assert(messages.saveSDKMessage(worker, message));
  };
  save({ type: 'user', message: { role: 'user', content: 'Synthetic disclosure proof request' } });
  save({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'thinking', thinking: 'Synthetic thinking preview\nShort thinking ending.' },
    { type: 'tool_use', id: 'synthetic-read', name: 'Read', input: { file_path: 'synthetic.txt' } },
  ] } });
  save({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'synthetic-read', content: 'Synthetic tool detail.\nA long synthetic result line. '.repeat(8) }] } });
  save({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Synthetic final reply.' }] } });
  save({ type: 'result', subtype: 'success', is_error: false, result: 'Synthetic result detail', total_cost_usd: 0.01, duration_ms: 1000, duration_api_ms: 900, num_turns: 1, stop_reason: null, usage: { input_tokens: 12, output_tokens: 3 }, modelUsage: {}, permission_denials: [] });
  writeFileSync(`${run}/evidence/steps-seed.json`, JSON.stringify({ root, worker, synthetic: true }, null, 2));
} finally { db.close(); }
