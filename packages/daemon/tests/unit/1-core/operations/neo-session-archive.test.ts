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
  let live: boolean;
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
  const invoke = (target = ref, who = caller, capable = true) =>
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
    for (const id of ['root', 'worker']) db.createSession(createTestSession(id));
    repo.reserveBinding({ sessionId: 'root', kind: 'neo', projectId: null });
    db.getSDKMessageRepo().saveSDKMessage('root', {
      type: 'user',
      uuid: 'human',
      session_id: 'root',
      parent_tool_use_id: null,
      inputKind: 'human',
      message: { role: 'user', content: 'Archive the finished session.' },
    } as unknown as SDKUserMessage);
    live = true;
    caller = {
      source: 'mcp',
      role: 'neo',
      sessionId: 'root',
      neoTurn: { messageId: 'human', human: true, isLive: () => live },
    };
    archive.mockClear();
    remote.invoke.mockClear();
  });
  afterEach(() => db.close());

  test('allows a verified live human turn and the local user', async () => {
    expect(await invoke()).toMatchObject({ value: { ok: true, value: { archived: true } } });
    expect(await invoke(ref, user)).toMatchObject({ value: { ok: true } });
    expect(archive).toHaveBeenCalledTimes(2);
  });

  test.each(['stale', 'system', 'unbound', 'missing_prompt', 'internal', 'untrusted_rpc'])(
    'refuses %s callers before driver or remote effects',
    async (kind) => {
      if (kind === 'stale') live = false;
      if (kind === 'system') caller = { ...caller, neoTurn: { ...caller.neoTurn!, human: false } };
      if (kind === 'unbound') caller = { ...caller, sessionId: 'worker' };
      if (kind === 'missing_prompt')
        caller = { ...caller, neoTurn: { ...caller.neoTurn!, messageId: 'absent' } };
      if (kind === 'internal') caller = { ...caller, source: 'internal' };
      if (kind === 'untrusted_rpc') caller = { source: 'rpc' };
      expect(await invoke()).toMatchObject(
        kind === 'stale'
          ? { kind: 'failed', code: 'forbidden' }
          : { value: { ok: false, reason: 'human_only' } }
      );
      expect(archive).not.toHaveBeenCalled();
      expect(remote.invoke).not.toHaveBeenCalled();
    }
  );

  test('rechecks the turn after a driver awaits', async () => {
    archive.mockImplementationOnce(async (_ref, admit) => {
      await Promise.resolve();
      live = false;
      return admit() ?? { ok: true, value: { archived: true } };
    });
    expect(await invoke()).toMatchObject({ value: { ok: false, reason: 'human_only' } });
  });

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
