import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(join(run, 'workspace'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const app = await createDaemonApp({
  config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
  verbose: false,
});
const evidence: Record<string, unknown> = {};
const violations: string[] = [];
function includes(text: string, phrase: string, surface: string) {
  if (!text.includes(phrase)) violations.push(`${surface}: missing ${phrase}`);
}
async function rpc(name: string, input: unknown = {}) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'rpc.ts'), name, JSON.stringify(input)], {
    env: { ...process.env, VERIFY_PORT: String(app.server.port) }, stdout: 'pipe', stderr: 'inherit',
  });
  const result = JSON.parse(await new Response(child.stdout).text());
  assert.equal(await child.exited, 0);
  assert(!result.reply.error, JSON.stringify(result));
  return result.reply.value ?? result.reply;
}
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  const opened = await rpc('neo.open');
  assert(opened.sessionId, JSON.stringify(opened));
  const root = opened.sessionId;
  const mcp = createOperationMcpHandler(() => app.sessionManager.getOperationRegistry(), () => ({ sessionId: root, role: 'neo' }));
  const descriptions: Record<string, unknown> = {};
  for (const name of ['work.start', 'work.rename', 'neo.todo.add', 'task.workerSession.handoff']) {
    const response = name === 'task.workerSession.handoff'
      ? await rpc('operations.describe', { name })
      : JSON.parse((await mcp({ name: 'operations.describe', input: { name } })).content[0].text);
    descriptions[name] = response;
    includes(JSON.stringify(response), 'project and a number', name);
    includes(JSON.stringify(response), 'never a task title', name);
  }
  evidence.descriptions = descriptions;
  const prompt = String(app.sessionManager.getSessionFromDB(root)?.config.systemPrompt);
  evidence.neoSystemPrompt = prompt;
  for (const phrase of ['project and a number', 'never a task title', 'work.rename', 'Coordination questions', 'never human cards']) includes(prompt, phrase, 'Neo system prompt');
  const db = app.db.getDatabase();
  db.prepare("INSERT INTO sessions(id,title,workspace_path,created_at,last_active_at,status,config,metadata,type) VALUES ('synthetic-worker','HyperNeo dev 1',?,'2026-10-25','2026-10-25','active','{}','{}','worker')").run(join(run, 'workspace'));
  const store = new NeoAskTodoRepository(db);
  store.openAsk({ id: 'synthetic-ask', sessionId: root, projectId: null, originMessageId: null, title: 'Synthetic task', request: 'Synthetic task', createdAt: Date.now() });
  const result = await rpc('neo.todo.add', {
    askId: 'synthetic-ask', title: 'Synthetic task', doneWhen: 'Evidence delivered',
    instruction: 'SYNTHETIC_WORKER_GUIDANCE', check: { pack: 'coding', kind: 'issue_closed', params: { issue: 'example/synthetic#1' } },
    target: { verb: 'send', ref: { adapter: 'hyperneo', id: 'synthetic-worker' } }, start: true,
  });
  evidence.todoResult = result;
  const messages = db.prepare("SELECT queue, payload FROM job_queue WHERE queue = 'mailbox'").all();
  const brief = JSON.stringify(messages);
  evidence.workerMessages = messages;
  assert(brief.includes('SYNTHETIC_WORKER_GUIDANCE'), 'worker mailbox must receive the task through the real todo/send path');
  for (const phrase of ['at most 2 booted machine-wide', 'wait and retry', 'never ask the human', 'coordination questions', 'never a human card', 'requiring a human decision']) includes(brief, phrase, 'queued worker brief');
  evidence.violations = violations;
  writeFileSync(join(run, 'evidence/worker-session-guidance.json'), JSON.stringify(evidence, null, 2));
  assert.deepEqual(violations, []);
  console.log('PASS: live MCP/RPC descriptions, Neo session prompt and queued worker brief');
} finally {
  writeFileSync(join(run, 'evidence/worker-session-guidance.json'), JSON.stringify({ ...evidence, violations }, null, 2));
  await app.cleanup();
}
