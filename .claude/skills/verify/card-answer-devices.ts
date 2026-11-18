import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { readLocalCredential } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: Record<string, unknown> = {};
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
try {
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const socket = join(run, 'data/session-door.sock');
  const store = new NeoAskTodoRepository(app.db.getDatabase());
  store.openAsk({ id: 'synthetic-ask', sessionId: 'neo:synthetic', projectId: null, originMessageId: null, title: 'Synthetic card', request: 'Choose a result', createdAt: 1 });
  store.askQuestion('synthetic-card', 'synthetic-ask', { text: 'Which one?', kind: 'choice', options: ['Alpha', 'Beta'], multiple: false, noLabel: null, yesLabel: null }, 1);
  const cli = Bun.spawn([process.execPath, 'packages/cli/main.ts', 'relay', 'synthetic-card', '--where', 'here', '--when', 'now', '--', 'Beta'], { env: { ...process.env, HYPERNEO_SESSION_ID: 'synthetic', HYPERNEO_SESSION_DOOR: socket }, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
  evidence.cli = { stdout, stderr, exitCode };
  assert.match(stderr, /Unknown option: relay/);
  const credential = await readLocalCredential();
  const door = await new Promise<{ status: number; body: string }>((resolveDoor, reject) => {
    const call = request({ socketPath: socket, path: '/', method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolveDoor({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    call.on('error', reject);
    call.end(JSON.stringify({ sender: 'synthetic', name: 'neo.question.answer', input: { questionId: 'synthetic-card', answer: 'Beta', where: 'here', when: 'now' } }));
  });
  evidence.door = door;
  assert.equal(door.status, 400);
  assert.match(door.body, /not_allowed/);
  assert.equal(store.getQuestion('synthetic-card')?.state, 'open');
  const rpc = Bun.spawn([process.execPath, '.claude/skills/verify/rpc.ts', 'neo.question.answer', JSON.stringify({ questionId: 'synthetic-card', answer: ['Beta'] })], { env: { ...process.env, VERIFY_PORT: String(app.server.port) }, stdout: 'pipe', stderr: 'pipe' });
  const [rpcOut, rpcErr, rpcExit] = await Promise.all([new Response(rpc.stdout).text(), new Response(rpc.stderr).text(), rpc.exited]);
  evidence.rpc = { stdout: rpcOut, stderr: rpcErr, exitCode: rpcExit };
  assert.equal(rpcExit, 0, rpcErr);
  assert.equal(store.getQuestion('synthetic-card')?.state, 'answered');
  evidence.card = store.getQuestion('synthetic-card');
  console.log('PASS: relay CLI and session door refused; human RPC answered the open card.');
} finally {
  writeFileSync(join(run, 'evidence/card-answer-devices.json'), JSON.stringify(evidence, null, 2));
  await app.cleanup();
}
