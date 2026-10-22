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
  const message = { claude_code_version: 'synthetic', output_style: 'default', skills: [], plugins: [], type: 'system', subtype: 'init', uuid: crypto.randomUUID(), session_id: worker, model: 'synthetic-init-model', cwd: '/synthetic/project', permissionMode: 'default', tools: ['Read'], mcp_servers: [], agents: [], slash_commands: [], apiKeySource: 'user' } as unknown as SDKMessage;
  assert(new SDKMessageRepository(db).saveSDKMessage(worker, message));
  writeFileSync(`${run}/evidence/sdk-init-seed.json`, JSON.stringify({ worker, uuid: message.uuid, synthetic: true }, null, 2));
} finally { db.close(); }
