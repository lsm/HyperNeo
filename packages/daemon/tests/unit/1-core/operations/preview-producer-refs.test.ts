import { existingTodoTarget } from '../../helpers/todo-check-packs.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ArtifactRef } from '@hyperneo/shared/types/artifact-file';
import { createArtifactRefReader } from '../../../../src/lib/artifacts/read-operations.ts';
import { createNeoTodoOperations } from '../../../../src/lib/neo/todo-operations.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { ArtifactFileRepository } from '../../../../src/storage/repositories/artifact-file-repository.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const neo = { source: 'mcp' as const, role: 'neo' as const, sessionId: 'neo:owner' };

describe('producer artifact references on todo evidence', () => {
  let db: Database;
  let ref: ArtifactRef;
  const edit = (input: Record<string, unknown>, caller: OperationCaller = neo) =>
    invokeOperation(
      createOperationRegistry(
        createNeoTodoOperations(
          new NeoAskTodoRepository(db),
          new NeoTodoSessionRepository(db),
          {
            resolveTarget: existingTodoTarget,
            recompute: async (todo, patch) =>
              new NeoAskTodoRepository(db).updateTodo(todo, patch, Date.now()),
            start: async () => ({ ok: false as const, reason: 'not started' }),
            proceed: async () => ({ ok: false as const, reason: 'no session' }),
            retry: async () => ({ ok: false as const, reason: 'not failed' }),
            stop: async () => null,
          },
          () => [],
          createArtifactRefReader(() => db)
        )
      ),
      'neo.todo.edit',
      { todoId: 'todo', done: 'met', evidence: 'Report attached.', ...input },
      caller
    );

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    runMigrations(db, () => {});
    const work = new NeoAskTodoRepository(db);
    work.openAsk({
      id: 'ask',
      projectId: null,
      sessionId: neo.sessionId,
      originMessageId: 'm',
      title: 'Synthetic',
      request: 'Synthetic',
      createdAt: 1,
    });
    work.addTodo(
      'todo',
      'ask',
      { title: 'Report', doneWhen: 'Report read', check: null, instruction: '', named: null },
      1
    );
    const registry = new ArtifactFileRepository(db);
    ref = {
      daemonId: registry.daemonId,
      artifactId: 'synthetic-report',
      title: 'Layout report',
      kind: 'html',
      byteLength: 86016,
    };
    registry.save(
      { kind: 'todo', id: 'todo' },
      'request',
      'fingerprint',
      'a'.repeat(64),
      ref,
      JSON.stringify({ adapter: 'hyperneo', id: 'worker' }),
      'evidence/layout-report.html'
    );
  });
  afterEach(() => db.close());

  test('a ticked todo shows the registered reference after it is read back', async () => {
    expect(await edit({ artifacts: [ref] })).toMatchObject({
      kind: 'completed',
      value: { ok: true, todo: { state: 'blocked', blockedBy: 'check', artifacts: [ref] } },
    });
    expect(new NeoAskTodoRepository(db).getTodo('todo')?.artifacts).toEqual([ref]);
  });

  test('a todo ticked without references reads back with none', async () => {
    await edit({});
    expect(new NeoAskTodoRepository(db).getTodo('todo')?.artifacts).toBeUndefined();
  });

  test('references the daemon did not register as shown, or for another Neo, are refused', async () => {
    const refused = { kind: 'completed', value: { ok: false } };
    expect(await edit({ artifacts: [{ ...ref, title: 'Renamed' }] })).toMatchObject(refused);
    expect(await edit({ artifacts: [{ ...ref, artifactId: 'missing' }] })).toMatchObject(refused);
    expect(
      await edit({ artifacts: [ref] }, { ...neo, sessionId: 'neo:someone-else' })
    ).toMatchObject(refused);
    expect(new NeoAskTodoRepository(db).getTodo('todo')).toMatchObject({ state: 'todo' });
  });

  test('references without ticking the todo are refused rather than dropped', async () => {
    expect(await edit({ done: undefined, evidence: undefined, artifacts: [ref] })).toMatchObject({
      kind: 'completed',
      value: { ok: false },
    });
  });
});
