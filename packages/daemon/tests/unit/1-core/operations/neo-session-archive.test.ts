import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { createNeoSessionArchiveOperation } from '../../../../src/lib/neo/session-archive-operation.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import type { ArchiveAdmission, WorkRef } from '../../../../src/lib/drivers/types.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { NEO_WORK_CLOSED_DONE_PREFIX } from '@hyperneo/shared/types/neo-snapshot';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

describe('neo.session.archive', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let repo: NeoRepository;
  const ref = { adapter: 'test', id: 'worker' };
  const user: OperationCaller = { source: 'rpc', principal: 'local' };
  let caller: OperationCaller;
  const archive = mock(
    async (_ref: WorkRef, admit: ArchiveAdmission) =>
      admit() ?? { ok: true as const, value: { archived: true } }
  );
  const remote = {
    list: () => [],
    invoke: mock(async () => ({ ok: true, value: { archived: true } })),
  };
  const invoke = (target = ref, who = user, capable = true) =>
    invokeOperation(
      createOperationRegistry([
        createNeoSessionArchiveOperation({
          db,
          daemonName: 'here',
          remote,
          adapters: () => [
            {
              id: 'test',
              capabilities: capable ? ['find', 'archive'] : ['find'],
              find: () => [],
              archive: capable ? archive : undefined,
            },
          ],
        }),
      ]),
      'neo.session.archive',
      { ref: target },
      who
    );

  beforeEach(async () => {
    db = await createTestDb();
    repo = new NeoRepository(db.getDatabase());
    for (const id of ['root', 'worker']) await db.createSession(createTestSession(id));
    repo.reserveBinding({ sessionId: 'root', kind: 'neo', projectId: null });
    db.getSDKMessageRepo().saveSDKMessage('root', {
      type: 'user',
      uuid: 'human',
      session_id: 'root',
      parent_tool_use_id: null,
      inputKind: 'human',
      message: { role: 'user', content: 'Archive the finished session.' },
    } as unknown as SDKUserMessage);
    caller = {
      source: 'mcp',
      role: 'neo',
      sessionId: 'root',
    };
    archive.mockClear();
    remote.invoke.mockClear();
  });
  afterEach(() => db.close());

  test('refuses a session a doing todo drives until the todo is done', async () => {
    const todo = (target: WorkRef) => {
      db.getDatabase().exec(`INSERT INTO neo_asks (id, session_id, title, request, status, created_at, updated_at)
          VALUES ('ask', 'root', 'Ship', 'Ship it', 'open', 1, 1);
        INSERT INTO neo_todos (id, ask_id, position, title, done_when, state, created_at, updated_at)
          VALUES ('todo', 'ask', 0, 'Fix the loader', 'Merged', 'doing', 1, 1)`);
      db.getDatabase()
        .prepare('INSERT INTO neo_todo_sessions (todo_id, target, ref) VALUES (?, ?, ?)')
        .run('todo', JSON.stringify({ verb: 'send', ref: target }), JSON.stringify(target));
    };
    todo(ref);
    expect(await invoke(ref, user)).toMatchObject({
      value: { ok: false, reason: 'live_todo', detail: expect.stringContaining('Fix the loader') },
    });
    expect(archive).not.toHaveBeenCalled();
    db.getDatabase().exec("UPDATE neo_todos SET state = 'done' WHERE id = 'todo'");
    expect(await invoke(ref, user)).toMatchObject({ value: { ok: true } });
  });

  test('requires the ordinary local user even when Neo received a human message', async () => {
    expect(await invoke(ref, caller)).toMatchObject({ value: { ok: false, reason: 'human_only' } });
    expect(await invoke(ref, user)).toMatchObject({ value: { ok: true } });
    expect(archive).toHaveBeenCalledTimes(1);
  });

  test.each(['mcp', 'unbound', 'internal', 'untrusted_rpc'])(
    'refuses %s callers before driver or remote effects',
    async (kind) => {
      if (kind === 'unbound') caller = { ...caller, sessionId: 'worker' };
      if (kind === 'internal') caller = { ...caller, source: 'internal' };
      if (kind === 'untrusted_rpc') caller = { source: 'rpc' };
      expect(await invoke(ref, caller)).toMatchObject({
        value: { ok: false, reason: 'human_only' },
      });
      expect(archive).not.toHaveBeenCalled();
      expect(remote.invoke).not.toHaveBeenCalled();
    }
  );

  test('forwards one hop after admission and refuses unsupported or failed drivers', async () => {
    const target = { ...ref, daemon: 'remote' };
    expect(await invoke(target)).toMatchObject({ value: { ok: true } });
    expect(remote.invoke).toHaveBeenCalledWith('remote', 'neo.session.archive', { ref }, undefined);
    expect(remote.invoke).toHaveBeenCalledTimes(1);
    expect(await invoke(ref, user, false)).toMatchObject({
      value: { ok: false, reason: 'unsupported' },
    });
    archive.mockImplementationOnce(async () => {
      throw new Error('offline');
    });
    expect(await invoke(ref, user)).toMatchObject({
      value: { ok: false, reason: 'unreachable', detail: 'offline' },
    });
  });
});
