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
  await app.jobProcessor.stop();
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
  const whileHeld = async (name: string, input: Record<string, unknown>) => {
    const holder = Bun.spawn(
      ['bun', join(import.meta.dir, 'neo-question-beside-writer-hold.ts'), dbPath, '800'],
      { stdout: 'pipe', stderr: 'inherit' }
    );
    const held = new TextDecoder().decode((await holder.stdout.getReader().read()).value);
    assert.equal(held.trim(), 'held');
    const started = Date.now();
    const result = await handler({ name, input });
    const outcome = { waitedMs: Date.now() - started, isError: !!result.isError, reply: result.content[0]?.text };
    assert.equal(await holder.exited, 0);
    evidence[name] = outcome;
    return outcome;
  };
  const question = await whileHeld('neo.question.ask', {
    askId: 'locked-card-ask',
    kind: 'choice',
    text: 'Which way?',
    options: ['Server only', 'Server and client'],
    retireWhen: { pack: 'core', kind: 'evidence', params: { path: join(run, 'not-created') } },
  });
  const rule = await whileHeld('neo.rule.ask', {
    askId: 'locked-card-ask',
    requestId: 'locked-rule',
    add: ['Synthetic rule for the lock check.'],
  });
  writeFileSync(join(run, 'evidence/neo-question-beside-writer.json'), JSON.stringify(evidence, null, 2));
  const store = new NeoAskTodoRepository(app.db.getDatabase());
  for (const [name, outcome] of [['neo.question.ask', question], ['neo.rule.ask', rule]] as const) {
    assert(!outcome.isError, `${name} failed while another connection held the write lock: ${outcome.reply}`);
    const reply = JSON.parse(String(outcome.reply));
    assert.equal(reply.ok, true, `${name}: ${outcome.reply}`);
    const id = reply.question?.id ?? reply.questionId;
    assert.equal(store.getQuestion(id)?.state, 'open');
    console.log(`PASS: ${name} waited ${outcome.waitedMs} ms for the other write and opened card ${id}.`);
  }
  console.log(join(run, 'evidence/neo-question-beside-writer.json'));
} finally {
  await app.cleanup();
}
