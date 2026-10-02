import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessageHub, Session, SessionMetadata } from '@hyperneo/shared';
import type { Config } from '../../../../src/config.ts';
import type { AuthManager } from '../../../../src/lib/auth-manager.ts';
import { StateProjectionService } from '../../../../src/lib/state-projection-service.ts';
import { DRAFT_CHAR_LIMIT } from '@hyperneo/shared';
import { Database as SQLite } from '../../../../src/storage/sqlite-compat.ts';
import type { Database } from '../../../../src/storage/database.ts';
import { createTables } from '../../../../src/storage/schema/index.ts';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository.ts';
import type { SessionInputDraftSnapshot } from '../../../../src/storage/repositories/session-input-draft-write.ts';
import { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import { SessionConfigHandler } from '../../../../src/lib/agent/session-config-handler.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import type { SettingsManager } from '../../../../src/lib/settings-manager.ts';
import type { WorktreeManager } from '../../../../src/lib/worktree-manager.ts';
import { SessionCache } from '../../../../src/lib/session/session-cache.ts';
import { SessionLifecycle } from '../../../../src/lib/session/session-lifecycle.ts';
import { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import type { ToolsConfigManager } from '../../../../src/lib/session/tools-config.ts';
import { commitSessionInputDraft } from '../../../../src/lib/session/session-input-draft-commit.ts';

const ID = 'neo:fictional-root';
const OTHER = 'fictional-holder';
const META: SessionMetadata = {
  messageCount: 2,
  totalTokens: 3,
  inputTokens: 1,
  outputTokens: 2,
  totalCost: 0,
  toolCallCount: 0,
  inputDraft: 'saved draft',
  inputDraftVoicePending: 'staged voice',
};

function session(id: string): Session {
  return {
    id,
    title: 'Fictional draft owner',
    workspacePath: '/fictional/draft-workspace',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    config: { model: 'fictional-model', maxTokens: 4096, temperature: 0.7 },
    metadata: { ...META },
  };
}

describe('live conditional draft persistence', () => {
  let sqlite: SQLite;
  let repo: SessionRepository;
  let db: Database;
  let cache: SessionCache;
  let bus: InternalEventBus<DaemonInternalEventMap>;
  let lifecycle: SessionLifecycle;
  let owner: Session;
  let other: Session;
  let unconditional: ReturnType<typeof mock>;
  let construct: ReturnType<typeof mock>;
  let publish: ReturnType<typeof mock>;

  function agentFor(state: Session): AgentSession {
    const handler = new SessionConfigHandler({
      session: state,
      db,
      internalEventBus: bus,
      settingsManager: {} as SettingsManager,
    });
    const shell = { sessionConfigHandler: handler } as unknown as AgentSession;
    return {
      applyCommittedInputDraft: (text: string | null) =>
        AgentSession.prototype.applyCommittedInputDraft.call(shell, text),
      getSessionData: () => state,
      updateMetadata: (updates: Partial<Session>) => handler.updateMetadata(updates),
    } as unknown as AgentSession;
  }

  beforeEach(() => {
    sqlite = new SQLite(':memory:');
    createTables(sqlite);
    repo = new SessionRepository(sqlite);
    repo.createSession(session(ID));
    repo.createSession(session(OTHER));
    unconditional = mock((id: string, updates: Partial<Session>) =>
      repo.updateSession(id, updates)
    );
    db = {
      casSessionInputDraft: (snapshot: SessionInputDraftSnapshot, text: string | null) =>
        repo.casSessionInputDraft(snapshot, text),
      captureSessionInputDraft: (id: string) => repo.captureSessionInputDraft(id),
      getSession: (id: string) => repo.getSession(id),
      updateSession: unconditional,
    } as unknown as Database;
    bus = new InternalEventBus<DaemonInternalEventMap>();
    construct = mock((state: Session) => agentFor(state));
    cache = new SessionCache(construct, (id) => repo.getSession(id));
    owner = repo.getSession(ID)!;
    other = repo.getSession(OTHER)!;
    cache.set(ID, agentFor(owner));
    cache.set(OTHER, agentFor(other));
    lifecycle = new SessionLifecycle(
      db,
      {} as WorktreeManager,
      cache,
      bus,
      {} as MessageHub,
      { defaultModel: 'fictional-model', maxTokens: 4096, temperature: 0.7 },
      {} as ToolsConfigManager,
      construct
    );
    publish = mock(async () => {});
  });
  afterEach(() => sqlite.close());

  const capture = (id = ID) => repo.captureSessionInputDraft(id)!;
  const row = (id = ID) =>
    sqlite.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown>;
  const metadata = (id = ID) => JSON.parse(row(id).metadata as string) as Record<string, unknown>;
  const commit = (snapshot: SessionInputDraftSnapshot, text: string | null) =>
    commitSessionInputDraft(snapshot, text, db, cache, publish);

  test.each(['exact  \n**Markdown**', '', null, '123', 'true', 'null', '[]', '{"a":1}'])(
    'commits exact text %s without a second write or staged voice consumption',
    async (text) => {
      const before = row();
      const otherBefore = row(OTHER);
      expect(await commit(capture(), text)).toEqual({ kind: 'won', notified: true });
      expect(metadata().inputDraft ?? null).toBe(text);
      expect(owner.metadata.inputDraft ?? null).toBe(text);
      expect(metadata().inputDraftVoicePending).toBe('staged voice');
      expect(owner.metadata.inputDraftVoicePending).toBe('staged voice');
      const { inputDraft: ignoredBefore, ...restBefore } = JSON.parse(before.metadata as string);
      const { inputDraft: ignoredAfter, ...restAfter } = metadata();
      expect(restAfter).toEqual(restBefore);
      expect({ ...row(), metadata: before.metadata } as Record<string, unknown>).toEqual(before);
      expect(row(OTHER)).toEqual(otherBefore);
      expect(other.metadata).toEqual(META);
      expect(unconditional).not.toHaveBeenCalled();
      expect(construct).not.toHaveBeenCalled();
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledWith(ID, text);
    }
  );

  test.each([ID, OTHER])('lifecycle publishes the full raw owner metadata %s', async (id) => {
    const listener = mock(async () => {});
    bus.subscribe('session.updated', listener, { subscriberName: 'fictional-draft-listener' });
    expect(await lifecycle.updateInputDraftIf(capture(id), '  new text  ')).toEqual({
      kind: 'won',
      notified: true,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      sessionId: id,
      source: 'input-draft-commit',
      session: { metadata: { ...META, inputDraft: '  new text  ' } },
    });
    expect(cache.get(id)!.getSessionData().metadata.inputDraft).toBe('  new text  ');
    expect(unconditional).not.toHaveBeenCalled();
  });

  test('publication carries a concurrent newer durable edit made before publication', async () => {
    const listener = mock(async () => {});
    bus.subscribe('session.updated', listener, { subscriberName: 'fictional-draft-listener' });
    repo.updateSession(ID, { metadata: { messageCount: 7 } as SessionMetadata });
    const originalCas = db.casSessionInputDraft.bind(db);
    db.casSessionInputDraft = (snapshot, text) => {
      const outcome = originalCas(snapshot, text);
      repo.updateSession(ID, { metadata: { totalTokens: 42 } as SessionMetadata });
      return outcome;
    };
    expect(await lifecycle.updateInputDraftIf(capture(), 'raced')).toEqual({
      kind: 'won',
      notified: true,
    });
    expect(listener).toHaveBeenCalledWith({
      sessionId: ID,
      source: 'input-draft-commit',
      session: {
        metadata: { ...META, messageCount: 7, totalTokens: 42, inputDraft: 'raced' },
      },
    });
    expect(metadata().inputDraftVoicePending).toBe('staged voice');
    expect(unconditional).not.toHaveBeenCalled();
  });

  test('a missing owner at publication stays committed but not notified', async () => {
    const listener = mock(async () => {});
    bus.subscribe('session.updated', listener, { subscriberName: 'fictional-draft-listener' });
    db.getSession = () => null;
    expect(await lifecycle.updateInputDraftIf(capture(), 'orphaned')).toEqual({
      kind: 'won',
      notified: false,
    });
    expect(metadata().inputDraft).toBe('orphaned');
    expect(listener).not.toHaveBeenCalled();
    expect(unconditional).not.toHaveBeenCalled();
  });

  test('a read fault at publication stays committed but not notified', async () => {
    db.getSession = () => {
      throw new Error('fictional read failure');
    };
    expect(await lifecycle.updateInputDraftIf(capture(), 'unread')).toEqual({
      kind: 'won',
      notified: false,
    });
    expect(metadata().inputDraft).toBe('unread');
    expect(unconditional).not.toHaveBeenCalled();
  });

  test('state projection keeps unrelated metadata after a draft commit', async () => {
    const hub = { event: mock(() => {}), onRequest: mock(() => () => {}) };
    const projection = new StateProjectionService(
      hub as never,
      { getSessionAsync: mock(async () => null) } as unknown as SessionManager,
      {} as AuthManager,
      {} as SettingsManager,
      {} as Config,
      undefined,
      bus
    );
    await bus.publish('session.created', { sessionId: ID, session: repo.getSession(ID)! });
    expect(await lifecycle.updateInputDraftIf(capture(), 'projected')).toEqual({
      kind: 'won',
      notified: true,
    });
    const cached = (projection as unknown as { sessionCache: Map<string, Session> }).sessionCache;
    expect(cached.get(ID)!.metadata).toEqual({ ...META, inputDraft: 'projected' });
  });

  test('uncached commit never constructs or loads an agent', async () => {
    cache.remove(ID);
    expect(await commit(capture(), 'cold owner')).toEqual({ kind: 'won', notified: true });
    expect(metadata().inputDraft).toBe('cold owner');
    expect(cache.has(ID)).toBe(false);
    expect(construct).not.toHaveBeenCalled();
    expect(owner.metadata).toEqual(META);
    expect(unconditional).not.toHaveBeenCalled();
  });

  test.each([
    { inputDraft: 'concurrent edit' },
    { inputDraft: '' },
    { inputDraft: null },
    { inputDraftVoicePending: 'new voice' },
    { inputDraftVoicePending: null },
  ])('rejects concurrent durable draft or voice changes %j', async (patch) => {
    const snapshot = capture();
    repo.updateSession(ID, { metadata: patch as SessionMetadata });
    const before = row();
    expect(await commit(snapshot, 'old recovery')).toEqual({ kind: 'superseded' });
    expect(row()).toEqual(before);
    expect(owner.metadata).toEqual(META);
    expect(publish).not.toHaveBeenCalled();
    expect(unconditional).not.toHaveBeenCalled();
  });

  test.each(['ended', 'archived'] as const)('rejects a terminal owner %s', async (status) => {
    const snapshot = capture();
    repo.updateSession(ID, { status });
    const before = row();
    expect(await commit(snapshot, 'old recovery')).toEqual({ kind: 'superseded' });
    expect(row()).toEqual(before);
    expect(owner.metadata).toEqual(META);
    expect(publish).not.toHaveBeenCalled();
  });

  test.each(['paused', 'pending_worktree_choice'] as const)(
    'supports a live owner %s',
    async (status) => {
      repo.updateSession(ID, { status });
      expect(await commit(capture(), 'live draft')).toEqual({ kind: 'won', notified: true });
      expect(metadata().inputDraft).toBe('live draft');
      expect(owner.metadata.inputDraft).toBe('live draft');
      expect(row().status).toBe(status);
    }
  );

  test.each([{ id: '' }, { incarnation: 0 }, { voicePending: false }])(
    'refuses invalid capture %j',
    async (patch) => {
      const before = row();
      expect(await commit({ ...capture(), ...patch } as SessionInputDraftSnapshot, 'edit')).toEqual(
        { kind: 'invalid' }
      );
      expect(row()).toEqual(before);
      expect(owner.metadata).toEqual(META);
      expect(publish).not.toHaveBeenCalled();
    }
  );

  test('refuses an oversized edit without cache adoption or publication', async () => {
    const before = row();
    expect(await commit(capture(), 'x'.repeat(DRAFT_CHAR_LIMIT + 1))).toEqual({ kind: 'invalid' });
    expect(row()).toEqual(before);
    expect(owner.metadata).toEqual(META);
    expect(publish).not.toHaveBeenCalled();
  });

  test('updates committed cache synchronously before yielding to publication', async () => {
    let resolvePublication!: () => void;
    const held = new Promise<void>((resolve) => {
      resolvePublication = resolve;
    });
    const publisher = mock(async () => {
      expect(metadata().inputDraft).toBe('first edit');
      expect(owner.metadata.inputDraft).toBe('first edit');
      await held;
    });
    const first = commitSessionInputDraft(capture(), 'first edit', db, cache, publisher);
    await Promise.resolve();
    expect(publisher).toHaveBeenCalledTimes(1);
    expect(await commit(capture(), 'newer edit')).toEqual({ kind: 'won', notified: true });
    resolvePublication();
    expect(await first).toEqual({ kind: 'won', notified: true });
    expect(metadata().inputDraft).toBe('newer edit');
    expect(owner.metadata.inputDraft).toBe('newer edit');
    expect(unconditional).not.toHaveBeenCalled();
  });

  test('publication failure remains committed and never retries or rolls back', async () => {
    const failure = mock(async () => {
      throw new Error('fictional listener failure');
    });
    bus.subscribe('session.updated', failure, { subscriberName: 'fictional-failing-listener' });
    expect(await lifecycle.updateInputDraftIf(capture(), 'committed despite notification')).toEqual(
      { kind: 'won', notified: false }
    );
    expect(metadata().inputDraft).toBe('committed despite notification');
    expect(owner.metadata.inputDraft).toBe('committed despite notification');
    expect(failure).toHaveBeenCalledTimes(1);
    expect(unconditional).not.toHaveBeenCalled();
  });

  test('database faults propagate without cache adoption or publication', async () => {
    const before = row();
    const fault = {
      casSessionInputDraft: () => {
        throw new Error('fictional database failure');
      },
    };
    await expect(commitSessionInputDraft(capture(), 'edit', fault, cache, publish)).rejects.toThrow(
      'fictional database failure'
    );
    expect(row()).toEqual(before);
    expect(owner.metadata).toEqual(META);
    expect(publish).not.toHaveBeenCalled();
  });

  test('cache-only agent delegation preserves unrelated cached metadata', () => {
    owner.metadata.messageCount = 99;
    cache.get(ID)!.applyCommittedInputDraft(null);
    expect(owner.metadata).toEqual({ ...META, inputDraft: undefined, messageCount: 99 });
    expect(Object.hasOwn(owner.metadata, 'inputDraft')).toBe(false);
    expect(metadata()).toEqual({ ...META });
    expect(unconditional).not.toHaveBeenCalled();
  });

  test('manager captures raw repository state rather than projected cache text', async () => {
    owner.metadata.inputDraft = 'projected draft plus voice';
    const manager = { db, sessionLifecycle: lifecycle } as unknown as SessionManager;
    const snapshot = SessionManager.prototype.captureInputDraft.call(manager, ID)!;
    expect(snapshot.draft).toBe('saved draft');
    expect(snapshot.voicePending).toBe('staged voice');
    expect(snapshot.id).toBe(ID);
    expect(snapshot.incarnation).toBeGreaterThan(0);
    expect(SessionManager.prototype.captureInputDraft.call(manager, 'missing')).toBeNull();
    expect(
      await SessionManager.prototype.updateInputDraftIf.call(manager, snapshot, 'manager edit')
    ).toEqual({ kind: 'won', notified: true });
    expect(metadata().inputDraft).toBe('manager edit');
    expect(owner.metadata.inputDraft).toBe('manager edit');
    expect(unconditional).not.toHaveBeenCalled();
  });
});
