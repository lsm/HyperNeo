import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
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
  const rows = [
    {
      id: 'pr',
      title: 'Land https://github.com/example/project/pull/42',
      report: 'Synthetic PR result',
    },
    { id: 'issue', title: 'Issue example/project#9', report: null },
    { id: 'observed', title: 'Finish example/project#50 and #51', report: null },
    { id: 'unknown', title: 'Finish example/project#52', report: null },
    { id: 'decision', title: 'Choose the next destination', report: null },
  ].map((row) =>
    store.addTodo(
      row.id,
      'ask',
      {
        title: row.title,
        doneWhen: 'Remember to verify',
        check: null,
        instruction: null,
        named: null,
      },
      1
    )
  );
  const snapshot = join(run, 'todos.json');
  writeFileSync(snapshot, JSON.stringify(rows));
  const kinds = join(run, 'ref-kinds.json');
  writeFileSync(kinds, JSON.stringify({ 'example/project#50': 'pr', 'example/project#51': 'pr' }));
  const command = spawnSync(
    process.execPath,
    [resolve('scripts/backfill-neo-todo-checks.ts'), snapshot, kinds],
    { encoding: 'utf8', env: process.env }
  );
  receipts.push({
    cli: { status: command.status, stdout: command.stdout, stderr: command.stderr },
  });
  assert.equal(command.status, 0, 'offline backfill CLI must produce a repair plan');
  const plan = JSON.parse(command.stdout) as {
    edits: { todoId: string; check: NeoTodo['check'] }[];
    unresolved: { todoId: string }[];
  };
  assert.deepEqual(
    plan.edits.map((edit) => edit.todoId),
    ['pr', 'issue', 'observed']
  );
  assert.deepEqual(plan.edits.find((edit) => edit.todoId === 'observed')?.check?.params.urls, [
    'https://github.com/example/project/pull/50',
    'https://github.com/example/project/pull/51',
  ]);
  assert.deepEqual(
    plan.unresolved.map((row) => row.todoId),
    ['unknown', 'decision']
  );
  for (const edit of plan.edits) {
    const result = await rpc('neo.todo.edit', edit);
    assert(result.ok && result.todo, JSON.stringify(result));
    assert.deepEqual(result.todo.check, edit.check);
    assert.notEqual(result.todo.doneWhen, 'Remember to verify');
    assert.equal(result.todo.state, 'todo');
  }
  writeFileSync(snapshot, JSON.stringify(store.listTodos('ask')));
  const repeated = spawnSync(
    process.execPath,
    [resolve('scripts/backfill-neo-todo-checks.ts'), snapshot, kinds],
    { encoding: 'utf8', env: process.env }
  );
  assert.equal(repeated.status, 0, repeated.stderr);
  const second = JSON.parse(repeated.stdout);
  assert.deepEqual(second.edits, []);
  assert.deepEqual(
    second.unresolved.map((row: { todoId: string }) => row.todoId),
    ['unknown', 'decision']
  );
  receipts.push({ final: store.listTodos('ask'), plan, repeated: second });
  console.log(
    'PASS: offline backfill produces PR/issue edits; real RPC stores derived checks and wording; unresolved work remains listed and repeat is idempotent.'
  );
} finally {
  ws?.close();
  await app?.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(receipts, null, 2));
}
