process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { subscribeToStructuredLogs } from '../../../packages/daemon/src/lib/logger.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
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
    const result = await new Promise<{ ok?: boolean; todo?: NeoTodo; commit?: string; accepted?:boolean; data?:string; reason?:string }>(
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
    config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'user-folder') }),
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
  ws = createLocalSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => {
    ws!.onopen = () => done();
    ws!.onerror = () => fail(new Error('WebSocket open failed'));
  });
  const add = async (kind: string, params: Record<string, unknown>) => {
    const result = await rpc('neo.todo.add', { after: [],
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
    store.updateTodo(store.getTodo(todo.id)!, { startedAt: Date.now() }, Date.now());
    const result = await rpc('neo.todo.close', {
      todoId: todo.id,
      reason: 'Observed synthetic outcome',
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.todo?.state, state, JSON.stringify(result));
  };
  const path = join(run, 'result.txt');
  const fileTodo = await add('evidence', { path });
  await close(fileTodo, 'blocked');
  writeFileSync(path, 'Synthetic result');
  await close(fileTodo, 'done');
  app.db.updateGlobalSettings({ neo: { packs: ['life-admin', 'coding'] } });
  store.openAsk({ id: 'repo-ask', title: 'Repo outcome', request: 'Verify', sessionId: owner, projectId: null, originMessageId: null, createdAt: Date.now() });
  db.prepare('UPDATE neo_asks SET repo = ? WHERE id = ?').run('lsm/hyperneo', 'repo-ask');
  assert.equal((db.prepare('SELECT repo FROM neo_asks WHERE id = ?').get('repo-ask') as { repo: string }).repo, 'lsm/hyperneo');
  const repoCheck = (params: Record<string, unknown>) => ({ pack: 'core', kind: 'evidence', params });
  const assigned = await rpc('neo.todo.add', { after: [], askId: 'repo-ask', title: 'Assigned evidence', named: { repository: 'lsm/hyperneo' }, check: repoCheck({}) });
  assert(assigned.ok && assigned.todo, JSON.stringify(assigned));
  const assignedPath = join(run, 'data/work/evidence', assigned.todo.id, 'result.md');
  assert.deepEqual(assigned.todo.check?.params, { path: assignedPath });
  assert(assigned.todo.doneWhen.includes(assignedPath), 'the worker brief carries doneWhen');
  await close(assigned.todo, 'blocked');
  mkdirSync(dirname(assignedPath), { recursive: true });
  writeFileSync(assignedPath, 'Worker result');
  await close(assigned.todo, 'done');
  const assignedRead = await rpc('file.reference.read', { sourceMessageOrCard: { kind: 'todo', id: assigned.todo.id }, reference: assignedPath });
  assert.equal(assignedRead.accepted, true, JSON.stringify(assignedRead));
  const userPath = join(run, 'user-folder/proof.md');
  const beforeRefusal = store.listTodos('repo-ask').length;
  const refusedAdd = await rpc('neo.todo.add', { after: [], askId: 'repo-ask', title: 'User folder evidence', named: { repository: 'lsm/hyperneo' }, check: repoCheck({ path: userPath }) });
  assert.equal(refusedAdd.ok, false, JSON.stringify(refusedAdd));
  assert.match(refusedAdd.reason!, /Omit params\.path/);
  assert.equal(store.listTodos('repo-ask').length, beforeRefusal);
  const editable = await rpc('neo.todo.add', { after: [], askId: 'repo-ask', title: 'Edited evidence', named: { repository: 'lsm/hyperneo' }, check: repoCheck({ path: join(run, 'other.md') }) });
  assert(editable.ok && editable.todo, JSON.stringify(editable));
  const refusedEdit = await rpc('neo.todo.edit', { todoId: editable.todo.id, check: repoCheck({ path: userPath }) });
  assert.equal(refusedEdit.ok, false, JSON.stringify(refusedEdit));
  const keptPath = store.addTodo('existing-user-path', 'repo-ask', { title: 'Existing path', doneWhen: 'x', instruction: null, named: null, check: repoCheck({ path: userPath }) }, Date.now());
  const unchanged = await rpc('neo.todo.edit', { todoId: keptPath.id, check: keptPath.check });
  assert.equal(unchanged.ok, true, JSON.stringify(unchanged));
  const reassigned = await rpc('neo.todo.edit', { todoId: editable.todo.id, check: repoCheck({}) });
  assert.deepEqual(reassigned.todo?.check?.params, { path: join(run, 'data/work/evidence', editable.todo.id, 'result.md') });
  app.db.updateGlobalSettings({ neo: { packs: ['life-admin'] } });
  const countBeforeLegacyAdmission=store.listTodos('ask').length;
  const refusedArtifact=await rpc('neo.todo.add',{ after: [],askId:'ask',title:'New artifact evidence',check:{pack:'core',kind:'evidence',params:{artifact:'synthetic-artifact'}}});
  assert.equal(refusedArtifact.ok,false,'new artifact evidence must use an absolute path instead');
  assert.equal(store.listTodos('ask').length,countBeforeLegacyAdmission);
  const artifactTodo=store.addTodo('legacy-artifact-todo','ask',{title:'Legacy evidence',doneWhen:'Registered artifact synthetic-artifact exists.',instruction:null,named:null,check:{pack:'core',kind:'evidence',params:{artifact:'synthetic-artifact'}}},Date.now());
  await close(artifactTodo, 'blocked');
  const unchangedLegacy=await rpc('neo.todo.edit',{todoId:artifactTodo.id,check:artifactTodo.check});
  assert.equal(unchangedLegacy.ok,true,JSON.stringify(unchangedLegacy));
  const replacedLegacy=await rpc('neo.todo.edit',{todoId:artifactTodo.id,check:{pack:'core',kind:'evidence',params:{artifact:'different'}}});
  assert.equal(replacedLegacy.ok,false,JSON.stringify(replacedLegacy));
  assert.deepEqual(store.getTodo(artifactTodo.id)?.check,artifactTodo.check);
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
    'blocked'
  );
  const readCurrent=()=>rpc('file.reference.read',{sourceMessageOrCard:{kind:'todo',id:fileTodo.id},reference:path});
  const first=await readCurrent();
  assert.equal(first.accepted,true,JSON.stringify(first));
  assert.equal(Buffer.from(first.data!,'base64').toString(),'Synthetic result');
  writeFileSync(path,'Edited current result');
  const edited=await readCurrent();
  assert.equal(edited.accepted,true,JSON.stringify(edited));
  assert.equal(Buffer.from(edited.data!,'base64').toString(),'Edited current result');
  rmSync(path);
  assert.equal((await readCurrent()).reason,'missing');
  assert.equal(store.getTodo(fileTodo.id)?.state,'done');
  receipts.push({
    state: store.listTodos('ask'),
    isolatedPort: app.server.port,
    enabledPacks: ['life-admin'],
  });
  console.log(
    'PASS: real RPC derives completion text and checks recorded human answers, file, artifact and daemon build ancestry with life-admin enabled; repository admission uses the coding policy.'
  );
} finally {
  ws?.close();
  await app?.cleanup();
  unsubscribe();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(receipts, null, 2));
}
