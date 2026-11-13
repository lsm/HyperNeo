import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'])
  assert.equal(process.env[key], undefined);
for (const dir of ['bin', 'evidence', 'workspace']) mkdirSync(join(run, dir), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });

const dbPath = join(run, 'data/daemon.db');
const root = 'neo:9d1f3c0e-5b7a-4e2d-8c61-2f4a9b7e1d35';
const app = await createDaemonApp({
  config: getConfig({ port: 0, host: '127.0.0.1', dbPath }),
  verbose: false,
});
const evidence: Record<string, unknown> = {};
try {
  const now = new Date().toISOString();
  await app.db.createSession({
    id: root,
    title: 'Synthetic locked card',
    workspacePath: join(run, 'workspace'),
    createdAt: now,
    lastActiveAt: now,
    status: 'active',
    config: { queryMode: 'manual' },
    metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 },
  });
  new NeoRepository(app.db.getDatabase()).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  app.db.updateGlobalSettings({ language: 'en' });
  new NeoAskTodoRepository(app.db.getDatabase()).openAsk({
    id: 'locked-card-ask',
    title: 'Synthetic locked card',
    request: 'Synthetic verification only',
    sessionId: root,
    projectId: null,
    originMessageId: null,
    createdAt: 1,
  });
  const handler = createOperationMcpHandler(
    () => app.sessionManager.getOperationRegistry(),
    () => ({ sessionId: root, role: 'neo' })
  );
  const holder = Bun.spawn(
    ['bun', join(import.meta.dir, 'neo-question-beside-writer-hold.ts'), dbPath, '800'],
    { stdout: 'pipe', stderr: 'inherit' }
  );
  const lines = holder.stdout.getReader();
  const held = new TextDecoder().decode((await lines.read()).value);
  assert.equal(held.trim(), 'held');
  const started = Date.now();
  const result = await handler({
    name: 'neo.question.ask',
    input: {
      askId: 'locked-card-ask',
      kind: 'choice',
      text: 'Which way?',
      options: ['Server only', 'Server and client'],
      retireWhen: { pack: 'core', kind: 'evidence', params: { path: join(run, 'not-created') } },
    },
  });
  evidence.waitedMs = Date.now() - started;
  evidence.isError = !!result.isError;
  evidence.reply = result.content[0]?.text;
  assert.equal(await holder.exited, 0);
  writeFileSync(join(run, 'evidence/neo-question-beside-writer.json'), JSON.stringify(evidence, null, 2));
  assert(!result.isError, `neo.question.ask failed while another connection held the write lock: ${evidence.reply}`);
  const reply = JSON.parse(String(evidence.reply));
  assert.equal(reply.ok, true);
  const stored = new NeoAskTodoRepository(app.db.getDatabase()).getQuestion(reply.question.id);
  assert.equal(stored?.state, 'open');
  console.log(
    `PASS: neo.question.ask waited ${evidence.waitedMs} ms for the other write and opened card ${reply.question.id}. ${join(run, 'evidence/neo-question-beside-writer.json')}`
  );
} finally {
  await app.cleanup();
}
