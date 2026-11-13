import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoPublicationRepository } from '../../../packages/daemon/src/storage/repositories/neo-publication-repository.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(process.env[key], undefined);
for (const dir of ['bin', 'evidence', 'workspace']) mkdirSync(join(run, dir), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
const conversationId = '5c1e0f8a-3d7b-4c2e-9a61-0b8f4e2d7c13', root = `neo:${conversationId}`;
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
const evidence: Record<string, unknown> = {};
const call = async (name: string, input: Record<string, unknown>) => {
  const result = await createOperationMcpHandler(() => app.sessionManager.getOperationRegistry(), () => ({ sessionId: root, role: 'neo' }))({ name, input });
  return { isError: result.isError === true, body: JSON.parse(result.content[0].text) };
};
try {
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const now = new Date().toISOString();
  await app.db.createSession({ id: root, title: 'Synthetic Neo', workspacePath: join(run, 'workspace'), createdAt: now, lastActiveAt: now, status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  new NeoRepository(app.db.getDatabase()).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const registry = app.sessionManager.getOperationRegistry();
  evidence.registered = { publish: !!registry.get('neo.publication.publish'), edit: !!registry.get('neo.publication.edit') };
  assert.deepEqual(evidence.registered, { publish: true, edit: false });
  const first = await call('neo.publication.publish', { requestId: 'first', text: 'The build is green.' });
  assert(!first.isError && first.body.accepted, JSON.stringify(first));
  const edit = await call('neo.publication.edit', { requestId: 'edit', publicationId: first.body.publication.publicationId, fullText: 'Correction: the build is red.' });
  evidence.edit = edit;
  assert(edit.isError, JSON.stringify(edit));
  const correction = await call('neo.publication.publish', { requestId: 'correction', text: 'Correction: the build is red.' });
  assert(!correction.isError && correction.body.accepted, JSON.stringify(correction));
  const rows = new NeoPublicationRepository(app.db.getDatabase()).list(conversationId)!;
  evidence.rows = rows.map((row) => ({ publicationId: row.publicationId, fullText: row.fullText, revisions: row.revisions?.length ?? 0 }));
  assert.deepEqual(rows.map((row) => row.fullText), ['The build is green.', 'Correction: the build is red.']);
  assert(rows.every((row) => !row.revisions?.length));
  console.log(`PASS publication edit removed; ${run}/evidence/publication-edit-removed.json`);
} finally {
  await app.cleanup();
  writeFileSync(join(run, 'evidence/publication-edit-removed.json'), JSON.stringify(evidence, null, 2));
}
