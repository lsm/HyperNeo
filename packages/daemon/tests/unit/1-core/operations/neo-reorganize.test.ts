import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { NeoBinding, NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import { vi } from 'vitest';
import {
  type DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import {
  admitNeoReorganizer,
  createNeoProjectsReorganizer,
  createNeoReorganizeOperation,
  type NeoReorganizeRuntime,
  requireNeoAskProject,
} from '../../../../src/lib/neo/reorganize-operation.ts';
import type { NeoRouted } from '../../../../src/lib/neo/reorganize-operation.ts';
import { createNeoService } from '../../../../src/lib/neo/packs/runtime.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const root = 'neo:root';
const ask = (id: string, fields: Partial<NeoAsk> = {}): NeoAsk => ({
  id,
  requestKey: `k-${id}`,
  projectId: null,
  originSessionId: root,
  originMessageId: `m-${id}`,
  title: `Ask ${id}`,
  ask: `Do ${id}`,
  doneWhen: '- done',
  doneSource: 'human',
  status: 'open',
  outcome: null,
  workIds: [],
  createdAt: 1,
  updatedAt: 1,
  settledAt: null,
  ...fields,
});
const routed = (projectId: string | null): NeoRouted => ({
  choice: projectId ? { projectId, sessionId: `holder:${projectId}` } : null,
});
const neoCaller: OperationCaller = { source: 'mcp', sessionId: root, role: 'neo' };

describe('admitNeoReorganizer', () => {
  test('lets main Neo and the human run it, not another session', () => {
    const main = { sessionId: root, kind: 'neo', projectId: null } as NeoBinding;
    const holder = { sessionId: 'h', kind: 'worker', projectId: 'inbox' } as NeoBinding;
    expect(admitNeoReorganizer(neoCaller, main)).toEqual({ value: true });
    expect(admitNeoReorganizer({ source: 'rpc', principal: 'local' }, null)).toEqual({
      value: true,
    });
    expect(admitNeoReorganizer({ ...neoCaller, sessionId: 'h' }, holder)).toEqual({
      reason: { ok: false, reason: 'main_neo_only' },
    });
  });
});

describe('requireNeoAskProject', () => {
  test('moves to a project, but keeps main and inbox choices with main', () => {
    expect(requireNeoAskProject(ask('a'), routed('drivers'))).toEqual({
      value: { projectId: 'drivers', sessionId: 'holder:drivers' },
    });
    expect(requireNeoAskProject(ask('a'), routed(null))).toEqual({
      reason: { askId: 'a', reason: 'stays_main' },
    });
    expect(requireNeoAskProject(ask('a'), routed('inbox'))).toEqual({
      reason: { askId: 'a', reason: 'one_off' },
    });
  });

  test('moves a project’s ask only to a different project', () => {
    const held = ask('a', { projectId: 'web' });
    expect(requireNeoAskProject(held, routed('drivers'))).toEqual({
      value: { projectId: 'drivers', sessionId: 'holder:drivers' },
    });
    for (const choice of ['web', 'inbox', null])
      expect(requireNeoAskProject(held, routed(choice))).toEqual({
        reason: { askId: 'a', reason: 'in_place' },
      });
  });
});

describe('neo.projects.reorganize', () => {
  function runtime(
    asks: NeoAsk[],
    routes: Record<string, string | null>,
    busy: string[] = [],
    current: Record<string, NeoAsk | null> = {}
  ) {
    const logged: string[] = [];
    const cleaned: string[] = [];
    const deps: NeoReorganizeRuntime = {
      getBinding: (sessionId) =>
        sessionId === root
          ? ({ sessionId: root, kind: 'neo', projectId: null } as NeoBinding)
          : null,
      rootSessionId: () => root,
      recordIdentities: async () => {},
      projectFacts: () => [],
      machine: () => 'here',
      cleanup: async (step) => {
        cleaned.push(step.projectId);
        if (step.projectId === 'stuck') throw new Error('busy');
      },
      mirroredAliases: async () => new Set(),
      log: (line) => {
        logged.push(line);
      },
    };
    return { deps, logged, cleaned };
  }
  const invoke = (
    deps: NeoReorganizeRuntime,
    caller: OperationCaller = neoCaller,
    input: Record<string, unknown> = {}
  ) =>
    invokeOperation(
      createOperationRegistry([createNeoReorganizeOperation(deps)]),
      'neo.projects.reorganize',
      input,
      caller
    ).then((outcome) => (outcome as { value?: unknown }).value);

  test('without a main session it still plans the cleanup', async () => {
    const { deps } = runtime([ask('a')], { a: 'drivers' });
    deps.rootSessionId = () => null;
    expect(await invoke(deps, { source: 'rpc', principal: 'local' })).toEqual({
      ok: true,
      cleanupPlanned: [],
      cleanupApplied: false,
      cleanupFailed: [],
    });
  });

  test('plans the project cleanup as a dry run: it logs and reports, and applies nothing', async () => {
    const { deps, logged } = runtime([], {});
    deps.projectFacts = () => [
      {
        id: 'empty',
        title: 'Empty',
        createdAt: 1,
        section: false,
        context: 0,
        asks: 0,
        liveAsks: 0,
        work: [],
        liveWork: 0,
        aliases: [],
      },
    ];
    expect(await invoke(deps)).toMatchObject({
      ok: true,
      cleanupPlanned: [{ action: 'delete', projectId: 'empty', title: 'Empty' }],
    });
    expect(logged).toContain('neo reorganize: would delete project empty (Empty)');
    deps.mirroredAliases = async () => null;
    expect(await invoke(deps)).toMatchObject({ ok: true, cleanupPlanned: [] });
    expect(logged).toContain('neo reorganize: no project cleanup, the places could not be read');
  });

  test('apply runs the same plan, logs each step and reports the ones that failed', async () => {
    const { deps, logged, cleaned } = runtime([], {});
    const empty = (id: string) => ({
      id,
      title: id,
      createdAt: 1,
      section: false,
      context: 0,
      asks: 0,
      liveAsks: 0,
      work: [],
      liveWork: 0,
      aliases: [],
    });
    deps.projectFacts = () => [empty('empty'), empty('stuck')];
    expect(await invoke(deps, neoCaller, { apply: true })).toMatchObject({
      ok: true,
      cleanupApplied: true,
      cleanupFailed: [{ projectId: 'stuck', reason: 'Error: busy' }],
    });
    expect(cleaned).toEqual(['empty', 'stuck']);
    expect(logged).toEqual(
      expect.arrayContaining([
        'neo reorganize: did delete project empty (empty)',
        'neo reorganize: could not delete project stuck (stuck): Error: busy',
      ])
    );
  });
});

describe('ReturnType<typeof createNeoService>.moveAsk', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: ReturnType<typeof createNeoService>;
  beforeEach(async () => {
    db = await createTestDb();
    service = createNeoService(
      db,
      { createSession: vi.fn(), getSessionAsync: vi.fn() } as unknown as SessionManager,
      { event: vi.fn() } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    await db.createSession(createTestSession(root));
  });
  afterEach(() => {
    service.dispose();
    db.close();
  });

  test('moved and forwarded notes use ordinary mailbox delivery without a human trigger', async () => {
    service.repo.reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
    await db.createSession(createTestSession('holder:drivers'));
    db.getSDKMessageRepo().saveSDKMessage(root, {
      type: 'user',
      uuid: 'm-a1',
      session_id: root,
      parent_tool_use_id: null,
      inputKind: 'human',
      message: { role: 'user', content: 'Fix login' },
    } as unknown as SDKUserMessage);
    await service.deliverForward('holder:drivers', 'neo-moved:a1', 'Moved.', root);
    await service.deliverForward('holder:drivers', 'neo-forward:m-a1:0', 'Forwarded.', root);
    const jobs = db
      .getJobQueueRepo()
      .listActiveByPayload('mailbox', { 'to.sessionId': 'holder:drivers' });
    expect(jobs.map((job) => job.payload.messageUuid).sort()).toEqual([
      'neo-forward:m-a1:0',
      'neo-moved:a1',
    ]);
    expect(jobs.every((job) => job.payload.message.inputKind === 'system')).toBe(true);
  });
});
