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
  const lines = Array.from({ length: 14 }, (_, n) => `Synthetic reasoning line ${n + 1}.`).join('\n');
  const short = `${lines}\nShort ending.`;
  const long = `${lines}\n${'Long final reasoning line. '.repeat(20)}`;
  const synthetic = `${Array.from({ length: 18 }, (_, n) => `Synthetic paragraph ${n + 1}.`).join('\n\n')}\n\nShort synthetic ending.`;
  for (const thinking of [short, long]) assert(messages.saveSDKMessage(worker, {
    type: 'assistant', uuid: crypto.randomUUID(), session_id: worker, parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'thinking', thinking }] },
  } as SDKMessage));
  messages.saveUserMessage(worker, { type: 'user', uuid: crypto.randomUUID(), session_id: worker,
    parent_tool_use_id: null, isSynthetic: true, message: { role: 'user', content: synthetic },
  } as SDKMessage, 'consumed', 'system');
  writeFileSync(`${run}/evidence/sdk-text-seed.json`, JSON.stringify({ worker, short, long, synthetic }, null, 2));
} finally { db.close(); }
