process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { waitForSdkBodyCopy } from './wait-for-sdk-body-copy.ts';

const [mode, directory] = process.argv.slice(2);
const run = resolve(directory);
assert(['success', 'uncertain'].includes(mode));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN'])
  assert.equal(process.env[key], undefined);
for (const folder of ['bin', 'evidence', 'workspace'])
  mkdirSync(join(run, folder), { recursive: true });
writeFileSync(join(run, 'home/.gitconfig'), '[user]\n name = Synthetic Home\n email = home@example.invalid\n[commit]\n gpgsign = false\n');
const remote = join(run, 'remote.git');
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git(run, 'init', '--bare', remote);
writeFileSync(join(run, 'bin/gh'), `#!/bin/sh
set -eu
RUN="$(dirname "$0")/.."
printf '%s\\n' "$*" >> "$RUN/evidence/home-gh.log"
case "$*" in
  'auth status') exit 0 ;;
  'api user --jq .login') echo synthetic-owner ;;
  'repo create synthetic-owner/neo-home --private --source . --remote origin --push')
    touch "$RUN/create-entered"
    while [ ! -f "$RUN/create-release" ]; do sleep 0.02; done
    ${mode === 'uncertain'
      ? 'git push "$RUN/remote.git" HEAD:refs/heads/main\n    exit 7'
      : 'git remote add origin "$RUN/remote.git"\n    git push -u origin HEAD'} ;;
  *) exit 97 ;;
esac
`, { mode: 0o700 });
const calls = () => readFileSync(join(run, 'evidence/home-gh.log'), 'utf8');
const creates = () => calls().split('\n').filter((line) => line.startsWith('repo create '));
const originalFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP refused'); }) as typeof fetch;
const root = `neo:${crypto.randomUUID()}`;
const evidence: Record<string, unknown> = { mode, verified: false, ports: [] };
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let socket: WebSocket | undefined;
type Result = { ok: boolean; reason?: string; status?: string; questionId?: string; commit?: string };

async function open() {
  app = await createDaemonApp({
    config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
    verbose: false,
  });
  assert(![8399, 8499].includes(app.server.port));
  (evidence.ports as number[]).push(app.server.port);
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await waitForSdkBodyCopy(app.db.getDatabase());
  socket = createLocalSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => {
    socket!.onopen = () => done();
    socket!.onerror = () => fail(new Error('Isolated RPC unavailable'));
  });
}

async function close() {
  socket?.close();
  socket = undefined;
  await app?.cleanup();
  app = undefined;
}

function rpc<T = Result>(name: string, input: unknown = {}): Promise<T> {
  return new Promise((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      socket!.removeEventListener('message', receive);
      fail(new Error(`${name} timed out`));
    }, 15_000);
    const receive = (event: MessageEvent) => {
      const reply = JSON.parse(String(event.data));
      if (reply.id !== id && reply.requestId !== id) return;
      clearTimeout(timer);
      socket!.removeEventListener('message', receive);
      if (reply.error) fail(new Error(JSON.stringify(reply.error)));
      else done(reply.data);
    };
    socket!.addEventListener('message', receive);
    socket!.send(JSON.stringify({
      id, type: 'REQ', method: 'operation.invoke', data: { name, input },
      sessionId: 'global', timestamp: new Date().toISOString(), version: '1.0.0',
    }));
  });
}

try {
  await open();
  await app!.db.updateGlobalSettings({ neo: { packs: [] } });
  await close();
  await open();
  assert.deepEqual(app!.db.getGlobalSettings().neo?.packs, []);
  evidence.enabledPacksAtStartup = [];
  await app!.db.createSession({
    id: root, title: 'Synthetic coordinator', workspacePath: join(run, 'workspace'),
    createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active',
    config: { queryMode: 'manual' }, metadata: {
      messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0,
      totalCost: 0, toolCallCount: 0,
    },
  });
  new NeoRepository(app!.db.getDatabase()).reserveBinding({ sessionId: root, projectId: null, kind: 'neo' });
  new NeoAskTodoRepository(app!.db.getDatabase()).openAsk({
    id: 'synthetic-home', sessionId: root, projectId: null, originMessageId: null,
    title: 'Synthetic home', request: 'Review private home publication', createdAt: Date.now(),
  });
  const initialized = await rpc<{ ok: boolean; path: string }>('neo.home.init');
  assert(initialized.ok, JSON.stringify(initialized));
  const branch = git(initialized.path, 'symbolic-ref', '--short', 'HEAD');
  git(run, '--git-dir', remote, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`);
  evidence.branch = branch;
  const proposed = await rpc('neo.home.github', { askId: 'synthetic-home' });
  assert(proposed.ok && proposed.status === 'proposed' && proposed.questionId, JSON.stringify(proposed));
  const openConsent = await rpc('neo.home.github', { questionId: proposed.questionId });
  const missingConsent = await rpc('neo.home.github', { questionId: 'missing' });
  assert(!openConsent.ok && !missingConsent.ok);
  assert.equal(creates().length, 0);
  assert((await rpc('neo.question.answer', { questionId: proposed.questionId, answer: 'yes' })).ok);
  const consent = await rpc<{ answeredByHuman: boolean }>('neo.question.get', { questionId: proposed.questionId });
  assert.equal(consent.answeredByHuman, true);
  const creating = rpc('neo.home.github', { questionId: proposed.questionId });
  const deadline = performance.now() + 10_000;
  while (!existsSync(join(run, 'create-entered'))) {
    assert(performance.now() < deadline, 'Synthetic create was not entered');
    await new Promise((done) => setTimeout(done, 10));
  }
  const document = { path: 'projects/proof/note.md', content: 'Synthetic curated note.\n', message: 'Record synthetic note' };
  const saving = rpc('neo.home.save', document);
  await new Promise((done) => setTimeout(done, 100));
  assert(!existsSync(join(initialized.path, document.path)), 'Save must share the publication lane');
  writeFileSync(join(run, 'create-release'), 'release');
  const [created, saved] = await Promise.all([creating, saving]);
  assert(saved.ok, JSON.stringify(saved));
  assert.equal(creates().length, 1);
  assert.equal(readFileSync(join(initialized.path, document.path), 'utf8'), document.content);
  if (mode === 'success') {
    assert(created.ok && created.status === 'created', JSON.stringify(created));
    assert.equal(git(initialized.path, 'rev-parse', 'HEAD'), git(run, '--git-dir', remote, 'rev-parse', 'HEAD'));
    assert.equal(git(run, '--git-dir', remote, 'show', `HEAD:${document.path}`), document.content.trim());
  } else {
    assert(!created.ok && created.reason?.includes('creation_unconfirmed'), JSON.stringify(created));
    assert(git(run, '--git-dir', remote, 'rev-parse', 'refs/heads/main'));
  }
  await close();
  await open();
  assert.deepEqual(app!.db.getGlobalSettings().neo?.packs, []);
  const repeated = await rpc('neo.home.github', { questionId: proposed.questionId });
  const proposalRetry = await rpc('neo.home.github', { askId: 'synthetic-home' });
  if (mode === 'success') {
    assert.deepEqual(repeated, created);
    assert.deepEqual(proposalRetry, created);
  } else {
    assert(!repeated.ok && repeated.reason?.includes('creation_unconfirmed'), JSON.stringify(repeated));
    assert(!proposalRetry.ok && proposalRetry.reason?.includes('creation_unconfirmed'), JSON.stringify(proposalRetry));
  }
  assert.equal(creates().length, 1);
  evidence.proposed = proposed;
  evidence.created = created;
  evidence.saved = saved;
  evidence.repeated = repeated;
  evidence.proposalRetry = proposalRetry;
  evidence.createAttempts = creates().length;
  evidence.boundHumanYes = consent.answeredByHuman;
  evidence.saveSerialized = true;
  evidence.verified = true;
} finally {
  await close();
  globalThis.fetch = originalFetch;
  evidence.resourcesClosed = true;
  writeFileSync(join(run, 'evidence/home-git-backend.json'), JSON.stringify(evidence, null, 2));
}
console.log(JSON.stringify({ verified: evidence.verified, mode, createAttempts: creates().length, resourcesClosed: true }));
