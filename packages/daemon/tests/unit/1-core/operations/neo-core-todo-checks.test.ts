import { afterEach, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILD_METADATA } from '../../../../src/lib/build-metadata.ts';
import { createCoreTodoPack } from '../../../../src/lib/neo/core-todo-checks.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { ArtifactFileRepository } from '../../../../src/storage/repositories/artifact-file-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0).reverse()) close();
});
function fixture() {
  const db = new Database(':memory:');
  closing.push(() => db.close());
  runMigrations(db, () => {});
  createTables(db);
  const store = new NeoAskTodoRepository(db);
  store.openAsk({
    id: 'ask',
    sessionId: 'neo',
    projectId: null,
    originMessageId: null,
    title: 'Verify result',
    request: 'Verify',
    createdAt: 1,
  });
  const todo = store.addTodo(
    'todo',
    'ask',
    { title: 'Verify', doneWhen: 'Observed', instruction: null, named: null, check: null },
    1
  );
  const contains = mock(async () => false);
  const pack = createCoreTodoPack(db, contains);
  const checked = (kind: string, params: Record<string, unknown>) => ({
    ...todo,
    check: { pack: 'core', kind, params },
  });
  return { db, store, pack, contains, checked };
}

test('evidence waits for a regular file, or a registered artifact in this work context', async () => {
  const { db, pack, checked } = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'neo-check-'));
  closing.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'result.txt');
  const todo = checked('evidence', { path });
  expect(await pack.todos!.check(todo)).toEqual({ done: false, evidence: null });
  writeFileSync(path, 'Result');
  expect(await pack.todos!.check(todo)).toEqual({ done: true, evidence: `File ${path} exists.` });
  expect(await pack.todos!.check(checked('evidence', { path: dir }))).toEqual({
    done: false,
    evidence: null,
  });
  const artifactTodo = checked('evidence', { artifact: 'snapshot' });
  expect(await pack.todos!.check(artifactTodo)).toEqual({ done: false, evidence: null });
  const artifacts = new ArtifactFileRepository(db);
  artifacts.save(
    { kind: 'ask', id: 'ask' },
    'request',
    'fingerprint',
    'a'.repeat(64),
    {
      daemonId: artifacts.daemonId,
      artifactId: 'snapshot',
      title: 'Result',
      kind: 'text',
      byteLength: 6,
    },
    '{}',
    path
  );
  expect(await pack.todos!.check(artifactTodo)).toMatchObject({ done: true });
  expect(await pack.todos!.check({ ...artifactTodo, askId: 'foreign' })).toEqual({
    done: false,
    evidence: null,
  });
  const facts = await pack.readFacts!(todo);
  rmSync(path);
  expect(pack.judge!(todo, facts)).toMatchObject({ state: 'done' });
  expect(await pack.todos!.check(todo)).toEqual({ done: false, evidence: null });
});

test('deployed compares the requested commit to the daemon build, never the working tree HEAD', async () => {
  const { pack, contains, checked } = fixture();
  const todo = checked('deployed', { repo: 'lsm/HyperNeo', sha: 'a'.repeat(40) });
  expect(await pack.todos!.check(todo)).toEqual({ done: false, evidence: null });
  expect(contains).toHaveBeenCalledWith('lsm/hyperneo', 'a'.repeat(40), BUILD_METADATA.commit);
  contains.mockImplementation(async () => true);
  expect(await pack.todos!.check(todo)).toMatchObject({ done: true });
  expect(
    await pack.todos!.check(checked('deployed', { repo: 'other/repo', sha: BUILD_METADATA.commit }))
  ).toEqual({ done: false, evidence: null });
  expect(
    await pack.todos!.check(checked('deployed', { repo: 'lsm/HyperNeo', sha: 'unknown' }))
  ).toEqual({ done: false, evidence: null });
});

test('core checks reject malformed inputs and derive their completion sentence', () => {
  const { pack, checked } = fixture();
  for (const todo of [
    checked('typo', {}),
    checked('human_confirmed', {}),
    checked('evidence', { path: 'relative' }),
    checked('evidence', { artifact: 'id', path: '/file' }),
  ]) {
    expect(pack.todos!.refuse!(todo)).toContain('invalid_core_check');
    expect(pack.todos!.doneWhen!(todo.check)).toBeNull();
  }
  const todo = checked('human_confirmed', { questionId: 'card' });
  expect(pack.todos!.refuse!(todo)).toBeNull();
  expect(pack.todos!.doneWhen!(todo.check)).toBe('The human answers yes to card card.');
});
