import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { subscribeToStructuredLogs } from '../../../packages/daemon/src/lib/logger.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { ArtifactFileRepository } from '../../../packages/daemon/src/storage/repositories/artifact-file-repository.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const ghLog = join(run, 'evidence/gh.log');
const compare = join(run, 'compare.json');
writeFileSync(compare, JSON.stringify({ status: 'ahead' }));
writeFileSync(
  join(run, 'bin/gh'),
  `#!/bin/sh
printf '%s\\n' "$*" >> '${ghLog}'
case "$*" in
  'api repos/lsm/hyperneo/compare/'*) cat '${compare}' ;;
  *) exit 1 ;;
esac
`,
  { mode: 0o700 }
);
const owner = 'neo:10000000-0000-4000-8000-000000008969';
const receipts: unknown[] = [];
const packWarnings: string[] = [];
const unsubscribe = subscribeToStructuredLogs((event) => {
  if (event.message.includes('Neo file pack core was not loaded')) packWarnings.push(event.message);
});
mkdirSync(join(run, 'data/neo-packs/core'), { recursive: true });
writeFileSync(
  join(run, 'data/neo-packs/core/SKILL.md'),
  '---\nname: core\ndescription: Synthetic collision\n---\nInstructions that must not be silently lost.\n'
);
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let ws: WebSocket | undefined;
async function rpc(name: string, input: unknown) {
  assert(ws);
  const id = crypto.randomUUID();
  const result = await new Promise<{ ok?: boolean; todo?: NeoTodo; commit?: string }>(
    (done, fail) => {
      const timeout = setTimeout(() => fail(new Error(`${name} timed out`)), 15000);
      ws!.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id !== id && message.requestId !== id) return;
        clearTimeout(timeout);
        if (message.error) fail(new Error(JSON.stringify(message.error)));
        else done(message.data.value ?? message.data);
      };
      ws!.send(
        JSON.stringify({
          id,
          type: 'REQ',
          sessionId: 'global',
          method: 'operation.invoke',
          data: { name, input },
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        })
      );
    }
  );
  receipts.push({ name, input, result });
  return result;
}
try {
  app = await createDaemonApp({
    config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
    verbose: false,
  });
  assert(app.server.port > 0 && app.server.port !== 8399);
  receipts.push({ packWarnings });
  assert.equal(
    packWarnings.length,
    1,
    'a core file pack collision must produce a reservation warning'
  );
  await app.jobProcessor.stop();
  await app.spaceRuntimeService.ready();
  const db = app.db.getDatabase();
  db.prepare(`INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata)
    VALUES (?, 'Synthetic core checks', ?, '2026-10-26T00:00:00Z', '2026-10-26T00:00:00Z', 'active', '{"queryMode":"manual"}', '{}')`).run(
    owner,
    run
  );
  new NeoRepository(db).reserveBinding({ sessionId: owner, kind: 'neo', projectId: null });
  app.db.updateGlobalSettings({ neo: { packs: ['life-admin'] } });
  const store = new NeoAskTodoRepository(db);
  store.openAsk({
    id: 'ask',
    title: 'Check outcomes',
    request: 'Verify outcomes',
    sessionId: owner,
    projectId: null,
    originMessageId: null,
    createdAt: Date.now(),
  });
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => {
    ws!.onopen = () => done();
    ws!.onerror = () => fail(new Error('WebSocket open failed'));
  });
  const add = async (kind: string, params: Record<string, unknown>) => {
    const result = await rpc('neo.todo.add', {
      askId: 'ask',
      title: `Verify ${kind}`,
      doneWhen: 'This sentence must be replaced',
      check: { pack: 'core', kind, params },
    });
    assert(result.ok && result.todo, JSON.stringify(result));
    assert.notEqual(result.todo.doneWhen, 'This sentence must be replaced');
    return result.todo;
  };
  const close = async (todo: NeoTodo, state: string) => {
    const result = await rpc('neo.todo.close', {
      todoId: todo.id,
      reason: 'Observed synthetic outcome',
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.todo?.state, state, JSON.stringify(result));
  };
  const path = join(run, 'result.txt');
  const fileTodo = await add('evidence', { path });
  await close(fileTodo, 'closed_unverified');
  writeFileSync(path, 'Synthetic result');
  await close(fileTodo, 'done');
  const artifactTodo = await add('evidence', { artifact: 'synthetic-artifact' });
  await close(artifactTodo, 'closed_unverified');
  const artifacts = new ArtifactFileRepository(db);
  artifacts.save(
    { kind: 'ask', id: 'ask' },
    'request',
    'fingerprint',
    'a'.repeat(64),
    {
      artifactId: 'synthetic-artifact',
      daemonId: artifacts.daemonId,
      title: 'Synthetic result',
      kind: 'text',
      byteLength: 16,
    },
    '{}',
    path
  );
  await close(artifactTodo, 'done');
  for (const answer of ['no', 'yes']) {
    const question = store.askQuestion(
      `question-${answer}`,
      'ask',
      {
        text: 'Is the synthetic result complete?',
        kind: 'yesno',
        options: null,
        multiple: false,
        noLabel: 'No',
        yesLabel: 'Yes',
        startTodos: null,
      },
      Date.now()
    );
    const todo = await add('human_confirmed', { questionId: question.id });
    assert.equal((await rpc('neo.question.answer', { questionId: question.id, answer })).ok, true);
    await close(todo, 'done');
  }
  const build = await rpc('system.build', {});
  assert.match(build.commit!, /^[0-9a-f]{40}$/);
  await close(await add('deployed', { repo: 'lsm/HyperNeo', sha: build.commit }), 'done');
  await close(await add('deployed', { repo: 'lsm/HyperNeo', sha: 'a'.repeat(40) }), 'done');
  writeFileSync(compare, JSON.stringify({ status: 'diverged' }));
  await close(
    await add('deployed', { repo: 'lsm/HyperNeo', sha: 'b'.repeat(40) }),
    'closed_unverified'
  );
  receipts.push({
    state: store.listTodos('ask'),
    isolatedPort: app.server.port,
    enabledPacks: ['life-admin'],
  });
  console.log(
    'PASS: real RPC derives completion text and checks recorded human answers, file, artifact and daemon build ancestry with only life-admin enabled.'
  );
} finally {
  ws?.close();
  await app?.cleanup();
  unsubscribe();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(receipts, null, 2));
}
