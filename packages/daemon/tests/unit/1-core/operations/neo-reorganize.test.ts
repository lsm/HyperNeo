import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { NEO_ASK_MOVED } from '@hyperneo/prompts';
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
  createNeoReorganizeOperation,
  type NeoReorganizeRuntime,
  neoMovedAskMessageId,
  neoMovedAskNote,
  requireNeoAskMovable,
  requireNeoAskProject,
  requireNeoAskUnchanged,
  requireNeoProjectIdle,
  requireNeoSourceIdle,
  selectNeoReorganizableAsks,
} from '../../../../src/lib/neo/reorganize-operation.ts';
import type { NeoRouted } from '../../../../src/lib/neo/router.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
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
  choice: projectId
    ? { projectId, sessionId: `holder:${projectId}`, signal: 'classifier', confidence: 0.9 }
    : null,
});
const neoCaller: OperationCaller = { source: 'mcp', sessionId: root, role: 'neo' };

describe('admitNeoReorganizer', () => {
  test('lets main Neo and the human run it, not a project avatar', () => {
    const main = { sessionId: root, kind: 'neo', projectId: null } as NeoBinding;
    const holder = { sessionId: 'h', kind: 'project', projectId: 'c' } as NeoBinding;
    expect(admitNeoReorganizer(neoCaller, main)).toEqual({ value: true });
    expect(admitNeoReorganizer({ source: 'rpc', principal: 'local' }, null)).toEqual({
      value: true,
    });
    expect(admitNeoReorganizer({ ...neoCaller, sessionId: 'h' }, holder)).toEqual({
      reason: { ok: false, reason: 'main_neo_only' },
    });
  });
});

describe('selectNeoReorganizableAsks', () => {
  test('takes main’s asks and every project’s asks, not asks another conversation opened', () => {
    const asks = [ask('a'), ask('b', { projectId: 'c' }), ask('c', { originSessionId: 'h' })];
    expect(selectNeoReorganizableAsks(asks, root).map((item) => item.id)).toEqual(['a', 'b']);
  });
});

describe('requireNeoSourceIdle', () => {
  test('leaves an ask whose own avatar is mid-turn', () => {
    expect(requireNeoSourceIdle(ask('a'), 'processing')).toEqual({
      reason: { askId: 'a', reason: 'project_busy' },
    });
    expect(requireNeoSourceIdle(ask('a'), null)).toMatchObject({ value: { id: 'a' } });
  });
});

describe('requireNeoAskMovable', () => {
  test('leaves an ask waiting on or blocked on the human with main', () => {
    expect(requireNeoAskMovable(ask('a', { status: 'waiting' }))).toEqual({
      reason: { askId: 'a', reason: 'waiting_on_human' },
    });
    expect(requireNeoAskMovable(ask('a', { status: 'blocked' }))).toEqual({
      reason: { askId: 'a', reason: 'waiting_on_human' },
    });
    expect(requireNeoAskMovable(ask('a'))).toMatchObject({ value: { id: 'a' } });
  });
});

describe('requireNeoAskUnchanged', () => {
  test('stops an ask settled, gone or re-homed while it was routed', () => {
    const changed = { reason: { askId: 'a', reason: 'changed' as const } };
    expect(requireNeoAskUnchanged(ask('a'), null, root)).toEqual(changed);
    expect(requireNeoAskUnchanged(ask('a'), ask('a', { status: 'achieved' }), root)).toEqual(
      changed
    );
    expect(requireNeoAskUnchanged(ask('a'), ask('a', { projectId: 'c' }), root)).toEqual(changed);
    expect(
      requireNeoAskUnchanged(ask('a'), ask('a', { status: 'waiting', title: 'Now' }), root)
    ).toMatchObject({ value: { status: 'waiting', title: 'Now' } });
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

describe('requireNeoProjectIdle', () => {
  test('skips a project whose avatar is mid-turn', () => {
    const project = { projectId: 'c', sessionId: 'h' };
    expect(requireNeoProjectIdle(ask('a'), project, 'processing')).toEqual({
      reason: { askId: 'a', reason: 'project_busy' },
    });
    expect(requireNeoProjectIdle(ask('a'), project, 'idle')).toEqual({ value: project });
    expect(requireNeoProjectIdle(ask('a'), project, null)).toEqual({ value: project });
  });
});

describe('neoMovedAskNote', () => {
  test('hands over the ask, its open items and its cards, without doneWhen when items restate it', () => {
    const note = neoMovedAskNote(
      ask('a', {
        doneItems: [
          {
            id: 'i1',
            text: 'merged',
            state: 'pending',
            evidence: null,
            check: null,
            metBy: null,
            removed: false,
            addedAt: null,
          },
          {
            id: 'i2',
            text: 'gone',
            state: 'pending',
            evidence: null,
            check: null,
            metBy: null,
            removed: true,
            addedAt: null,
          },
        ],
      }),
      [{ id: 'w1', title: 'Fix', status: 'queued' } as NeoWork]
    );
    expect(note.startsWith(NEO_ASK_MOVED)).toBe(true);
    expect(JSON.parse(note.slice(NEO_ASK_MOVED.length + 1))).toEqual({
      askId: 'a',
      title: 'Ask a',
      ask: 'Do a',
      status: 'open',
      items: [{ id: 'i1', text: 'merged', state: 'pending' }],
      cards: [{ id: 'w1', title: 'Fix', status: 'queued' }],
    });
  });
});

describe('neo.projects.reorganize', () => {
  function runtime(
    asks: NeoAsk[],
    routes: Record<string, string | null>,
    busy: string[] = [],
    current: Record<string, NeoAsk | null> = {},
    merged: { sourceId: string; targetId: string }[] = []
  ) {
    const delivered: { sessionId: string; messageId: string; parent: unknown }[] = [];
    const moves: { askId: string; projectId: string; messageId: string }[] = [];
    const logged: string[] = [];
    const cleaned: string[] = [];
    const deps: NeoReorganizeRuntime = {
      getBinding: (sessionId) =>
        sessionId === root
          ? ({ sessionId: root, kind: 'neo', projectId: null } as NeoBinding)
          : null,
      rootSessionId: () => root,
      liveAsks: () => asks,
      ask: (id) => (id in current ? current[id] : (asks.find((item) => item.id === id) ?? null)),
      route: async (item) => routed(routes[item.id] ?? null),
      sessionStatus: (sessionId) => (busy.includes(sessionId) ? 'processing' : 'idle'),
      projectSession: (projectId) => `holder:${projectId}`,
      cards: () => [],
      deliver: async (sessionId, messageId, _content, _from, parent) => {
        delivered.push({ sessionId, messageId, parent });
      },
      move: (item, _cards, owner) => {
        moves.push({ askId: item.id, projectId: owner.projectId, messageId: owner.messageId });
        return true;
      },
      mergeProjects: async () => ({ merged, asked: [] }),
      projectFacts: () => [],
      machine: () => 'here',
      retiredHolders: () => [],
      cleanup: async (step) => {
        cleaned.push(step.projectId);
        if (step.projectId === 'stuck') throw new Error('busy');
      },
      mirroredAliases: async () => new Set(),
      log: (line) => {
        logged.push(line);
      },
    };
    return { deps, delivered, moves, logged, cleaned };
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

  test('moves each main ask to its project and reports what stayed and why', async () => {
    const { deps, delivered, moves } = runtime(
      [ask('a'), ask('b', { status: 'waiting' }), ask('c'), ask('d'), ask('e')],
      { a: 'drivers', c: null, d: 'inbox', e: 'busy' },
      ['holder:busy']
    );
    expect(await invoke(deps)).toEqual({
      ok: true,
      cleanupPlanned: [],
      cleanupApplied: false,
      cleanupFailed: [],
      merged: [],
      asked: [],
      moved: [{ askId: 'a', projectId: 'drivers' }],
      stayed: [
        { askId: 'b', reason: 'waiting_on_human' },
        { askId: 'c', reason: 'stays_main' },
        { askId: 'd', reason: 'one_off' },
        { askId: 'e', reason: 'project_busy' },
      ],
    });
    expect(delivered).toEqual([
      {
        sessionId: 'holder:drivers',
        messageId: neoMovedAskMessageId(ask('a')),
        parent: { sessionId: root, messageId: 'm-a' },
      },
    ]);
    expect(moves).toEqual([
      { askId: 'a', projectId: 'drivers', messageId: neoMovedAskMessageId(ask('a')) },
    ]);
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
        routed: 0,
        holderMessages: 0,
        archived: false,
        holder: null,
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

  test('a merged holder mid-turn waits for a later pass; a human-named archive is still planned', async () => {
    const { deps } = runtime([], {}, ['holder:busy', 'retired:busy']);
    deps.retiredHolders = () => [
      { projectId: 'old', title: 'Old', sessionId: 'retired:busy', spoke: true },
      { projectId: 'idle', title: 'Idle', sessionId: 'retired:idle', spoke: true },
    ];
    deps.projectFacts = () => [
      {
        id: 'named',
        title: 'Named',
        createdAt: 1,
        section: false,
        context: 1,
        asks: 0,
        liveAsks: 0,
        work: [],
        liveWork: 0,
        routed: 0,
        holderMessages: 0,
        archived: false,
        holder: 'holder:busy',
        aliases: [],
      },
    ];
    expect(await invoke(deps, neoCaller, { archive: ['named'] })).toMatchObject({
      ok: true,
      cleanupPlanned: [
        { action: 'archive', projectId: 'named', title: 'Named', sessionId: 'holder:busy' },
        { action: 'archive', projectId: 'idle', title: 'Idle', sessionId: 'retired:idle' },
      ],
    });
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
      routed: 0,
      holderMessages: 0,
      archived: false,
      holder: null,
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

  test('merges matching projects first and logs each merge', async () => {
    const { deps, logged } = runtime([], {}, [], {}, [{ sourceId: 'web-2', targetId: 'web' }]);
    expect(await invoke(deps)).toEqual({
      ok: true,
      cleanupPlanned: [],
      cleanupApplied: false,
      cleanupFailed: [],
      merged: [{ sourceId: 'web-2', targetId: 'web' }],
      asked: [],
      moved: [],
      stayed: [],
    });
    expect(logged).toEqual(['neo reorganize: merged project web-2 into web']);
  });

  test('moves an off-project ask between projects unless either avatar is mid-turn', async () => {
    const moved = ask('a', {
      projectId: 'web',
      originSessionId: 'holder:web',
      originMessageId: 'neo-moved:a:x',
    });
    const { deps, delivered, moves } = runtime(
      [moved, ask('b', { projectId: 'busy', originSessionId: 'holder:busy' })],
      { a: 'drivers', b: 'drivers' },
      ['holder:busy']
    );
    expect(await invoke(deps)).toEqual({
      ok: true,
      cleanupPlanned: [],
      cleanupApplied: false,
      cleanupFailed: [],
      merged: [],
      asked: [],
      moved: [{ askId: 'a', projectId: 'drivers' }],
      stayed: [{ askId: 'b', reason: 'project_busy' }],
    });
    expect(delivered).toEqual([
      {
        sessionId: 'holder:drivers',
        messageId: neoMovedAskMessageId(moved),
        parent: { sessionId: 'holder:web', messageId: 'neo-moved:a:x' },
      },
    ]);
    expect(moves).toEqual([
      { askId: 'a', projectId: 'drivers', messageId: neoMovedAskMessageId(moved) },
    ]);
    expect(neoMovedAskMessageId(moved)).not.toBe(neoMovedAskMessageId(ask('a')));
  });

  test('re-reads each ask after routing and leaves one that changed meanwhile', async () => {
    const { deps, delivered, moves } = runtime(
      [ask('a'), ask('b'), ask('c')],
      { a: 'drivers', b: 'drivers', c: 'drivers' },
      [],
      { a: ask('a', { status: 'achieved' }), b: ask('b', { status: 'blocked' }), c: null }
    );
    expect(await invoke(deps)).toEqual({
      ok: true,
      cleanupPlanned: [],
      cleanupApplied: false,
      cleanupFailed: [],
      merged: [],
      asked: [],
      moved: [],
      stayed: [
        { askId: 'a', reason: 'changed' },
        { askId: 'b', reason: 'waiting_on_human' },
        { askId: 'c', reason: 'changed' },
      ],
    });
    expect(delivered).toEqual([]);
    expect(moves).toEqual([]);
  });

  test('never moves an ask when the handoff note fails to reach the avatar', async () => {
    const { deps, moves } = runtime([ask('a')], { a: 'drivers' });
    deps.deliver = async () => {
      throw new Error('mailbox down');
    };
    expect(await invoke(deps)).toEqual({
      ok: true,
      cleanupPlanned: [],
      cleanupApplied: false,
      cleanupFailed: [],
      merged: [],
      asked: [],
      moved: [],
      stayed: [{ askId: 'a', reason: 'handoff_failed' }],
    });
    expect(moves).toEqual([]);
  });
});

describe('NeoService.moveAsk', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: NeoService;
  beforeEach(async () => {
    db = await createTestDb();
    service = new NeoService(
      db,
      { createSession: vi.fn(), getSessionAsync: vi.fn() } as unknown as SessionManager,
      { event: vi.fn() } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    db.createSession(createTestSession(root));
  });
  afterEach(() => {
    service.dispose();
    db.close();
  });

  test('gives the ask and its cards to the project avatar in one step', () => {
    service.repo.saveProject({ id: 'drivers', title: 'Drivers', summary: '', context: '' }, 0);
    const opened = service.askRecords.open({
      id: 'a1',
      requestKey: 'k-a1',
      projectId: null,
      originSessionId: root,
      originMessageId: 'm-a1',
      title: 'Fix login',
      ask: 'Fix login',
      doneWhen: '- merged',
      doneSource: 'human',
    })!;
    const card = service.repo.proposeWork({
      id: 'w1',
      requestKey: 'k-w1',
      projectId: null,
      originSessionId: root,
      originMessageId: 'm-a1',
      title: 'Fix login',
      instruction: 'Fix it.',
    });
    service.askRecords.link(opened.id, card.id);
    const owner = { projectId: 'drivers', sessionId: 'holder:drivers', messageId: 'neo-moved:a1' };
    expect(service.moveAsk({ ...opened, projectId: 'garden' }, [card], owner)).toBe(false);
    expect(service.askRecords.get('a1')).toMatchObject({ projectId: null });
    expect(service.moveAsk(opened, [card], owner)).toBe(true);
    expect(service.askRecords.get('a1')).toMatchObject({
      projectId: 'drivers',
      originSessionId: 'holder:drivers',
      originMessageId: 'neo-moved:a1',
      status: 'open',
    });
    expect(service.repo.getWork('w1')).toMatchObject({
      projectId: 'drivers',
      originSessionId: 'holder:drivers',
      originMessageId: 'neo-moved:a1',
    });
  });

  test('a moved-ask note hands the ask over without the human’s publish trigger; a forward keeps it', async () => {
    service.repo.reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
    db.createSession(createTestSession('holder:drivers'));
    db.getSDKMessageRepo().saveSDKMessage(root, {
      type: 'user',
      uuid: 'm-a1',
      session_id: root,
      parent_tool_use_id: null,
      inputKind: 'human',
      message: { role: 'user', content: 'Fix login' },
    } as unknown as SDKUserMessage);
    const parent = { sessionId: root, messageId: 'm-a1' };
    await service.deliverForward('holder:drivers', 'neo-moved:a1', 'Moved.', root, parent, null);
    await service.deliverForward(
      'holder:drivers',
      'neo-forward:m-a1:0',
      'Forwarded.',
      root,
      parent,
      'continues'
    );
    expect(service.inputTrigger({ sessionId: 'holder:drivers', messageId: 'neo-moved:a1' })).toBe(
      null
    );
    expect(
      service.inputTrigger({ sessionId: 'holder:drivers', messageId: 'neo-forward:m-a1:0' })
    ).toBe('human:m-a1');
  });
});
