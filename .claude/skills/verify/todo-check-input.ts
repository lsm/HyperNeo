import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const ghLog = join(run, 'evidence/gh.log');
writeFileSync(
  join(run, 'bin/gh'),
  `#!/bin/sh
printf '%s\\n' "$*" >> '${ghLog}'
exit 1
`,
  { mode: 0o700 }
);
const owner = 'neo:10000000-0000-4000-8000-000000008969';
const receipts: unknown[] = [];
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
        if (message.error) done({ error: message.error } as never);
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
  const missing = await rpc('neo.todo.add', {
    askId: 'ask',
    title: 'Missing check',
    doneWhen: 'Remember it',
  });
  assert.notEqual(missing.ok, true, 'adding a todo without a check must be rejected');
  assert.match(JSON.stringify(missing), /check/);
  const check = { pack: 'core', kind: 'evidence', params: { path: join(run, 'result.txt') } };
  const added = await rpc('neo.todo.add', { askId: 'ask', title: 'Observe result', check });
  assert(added.ok && added.todo, JSON.stringify(added));
  assert.equal(added.todo.doneWhen, `File ${check.params.path} exists.`);
  const unknown = await rpc('neo.todo.add', {
    askId: 'ask',
    title: 'Unknown',
    check: { ...check, pack: 'unknown' },
  });
  assert.notEqual(unknown.ok, true);
  const legacy = store.addTodo(
    'legacy',
    'ask',
    { title: 'Old todo', doneWhen: 'Remember it', check: null, instruction: null, named: null },
    1
  );
  const edited = await rpc('neo.todo.edit', { todoId: legacy.id, check, addUrls: ['https://github.com/example/project/pull/42'] });
  assert(edited.ok && edited.todo, JSON.stringify(edited));
  assert.equal(edited.todo.doneWhen, `File ${check.params.path} exists.`);
  assert.deepEqual(edited.todo.check, check);
  writeFileSync(check.params.path, 'Synthetic outcome');
  const closed = await rpc('neo.todo.close', { todoId: edited.todo.id, reason: 'Observed result' });
  assert.equal(closed.todo?.state, 'done');
  receipts.push({ final: store.listTodos('ask'), isolatedPort: app.server.port });
  console.log(
    'PASS: real RPC rejects unchecked/unknown todos, derives wording, upgrades an old row and verifies the outcome.'
  );
} finally {
  ws?.close();
  await app?.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(receipts, null, 2));
}
