import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: Record<string, unknown> = {};
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP is disabled'); }) as typeof fetch;
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
try {
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const socket = join(run, 'data/session-door.sock');
  assert(existsSync(socket), 'the session door must be listening');
  const store = new NeoAskTodoRepository(app.db.getDatabase());
  store.openAsk({ id: 'synthetic-ask', sessionId: 'neo:synthetic-relay', projectId: null, originMessageId: null, title: 'Synthetic card', request: 'Choose a result', createdAt: 1 });
  const card = (id: string) => store.askQuestion(id, 'synthetic-ask', { text: 'Which one?', kind: 'choice', options: ['Alpha', 'Beta'], multiple: false, noLabel: null, yesLabel: null, startTodos: null }, 1);
  card('card-allowed');
  card('card-unlisted');
  const configured = await invokeOperation(app.sessionManager.getOperationRegistry(), 'neo.relaySenders.set', { relaySenders: [{ sender: 'synthetic-relay', name: 'Synthetic relay' }] }, { source: 'rpc', principal: 'local' });
  assert.deepEqual(configured, { kind: 'completed', value: { ok: true } });
  const relay = async (sender: string, questionId: string) => {
    const child = Bun.spawn([process.execPath, 'packages/cli/main.ts', 'relay', questionId, '--where', 'a synthetic call', '--when', 'Monday evening', '--', 'pick B'], {
      env: { ...process.env, HYPERNEO_SESSION_ID: sender, HYPERNEO_SESSION_DOOR: socket },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = [await new Response(child.stdout).text(), await new Response(child.stderr).text(), await child.exited];
    evidence[`${sender}:${questionId}`] = { code, stdout, stderr, card: store.getQuestion(questionId) };
    return { code, stdout, stderr };
  };
  const unlisted = await relay('synthetic-stranger', 'card-unlisted');
  assert.notEqual(unlisted.code, 0);
  assert.match(unlisted.stdout + unlisted.stderr, /sender_not_allowed/);
  assert.equal(store.getQuestion('card-unlisted')?.state, 'open');
  const allowed = await relay('synthetic-relay', 'card-allowed');
  assert.equal(allowed.code, 0, allowed.stderr);
  assert.match(allowed.stdout, /"ok": ?true/);
  const answered = store.getQuestion('card-allowed');
  assert.equal(answered?.state, 'answered');
  assert.equal(answered?.answeredBy, 'chat');
  assert.deepEqual(answered?.answer, ['Beta']);
  assert.deepEqual(
    { ...answered?.answerProvenance, at: undefined },
    { words: 'pick B', via: 'synthetic-relay', viaName: 'Synthetic relay', where: 'a synthetic call', when: 'Monday evening', at: undefined }
  );
  const queued = app.db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': 'neo:synthetic-relay' });
  evidence.queued = queued.map((job) => job.payload);
  assert.equal(queued.length, 1);
  console.log('PASS: hyperneo relay reaches neo.question.answer through the real session door; an allowed sender records the mapped answer with provenance and wakes Neo once; an unlisted sender is refused and the card stays open.');
} finally {
  globalThis.fetch = network;
  writeFileSync(join(run, 'evidence/relay-answer-door.json'), JSON.stringify(evidence, null, 2));
  await app.cleanup();
}
