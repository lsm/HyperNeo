import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { SDKMessageRepository } from '../../../packages/daemon/src/storage/repositories/sdk-message-repository.ts';
import type { SDKMessage } from '../../../packages/shared/src/sdk/sdk.d.ts';

const run = process.argv[2];
assert(run && process.env.NODE_ENV === 'test');
execFileSync('bun', ['.claude/skills/verify/preview-register.ts', run, 'seed'], { stdio: 'inherit' });
const content = readFileSync(new URL('./cjk-markdown.md', import.meta.url), 'utf8');
writeFileSync(`${run}/workspace/report.md`, content);
const db = new Database(`${run}/data/daemon.db`);
try {
  const worker = '40000000-0000-4000-8000-000000008643';
  db.prepare('UPDATE sessions SET id = ? WHERE id = ?').run(worker, 'worker');
  db.prepare('UPDATE neo_todo_sessions SET ref = ?').run(JSON.stringify({ adapter: 'hyperneo', id: worker }));
  const messages = new SDKMessageRepository(db);
  assert(messages.saveSDKMessage(worker, {
    uuid: crypto.randomUUID(), session_id: worker, type: 'assistant', timestamp: Date.now(),
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'text', text: content }] },
  } as unknown as SDKMessage));
} finally { db.close(); }
