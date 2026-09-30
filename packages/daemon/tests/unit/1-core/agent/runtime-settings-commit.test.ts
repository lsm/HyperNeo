import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { Session, SessionConfig, SessionMetadata, ThinkingLevel } from '@hyperneo/shared';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables } from '../../../../src/storage/schema/index.ts';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository.ts';
import { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import { isValidModel } from '../../../../src/lib/model-service.ts';
import {
  gateCommitIdle,
  gateCommitTarget,
  gateCommitTurn,
  ModelSwitchHandler,
  type ModelSwitchHandlerContext,
  type RuntimeSettingsCommit,
  snapshotPair,
  snapshotProcessingStatus,
} from '../../../../src/lib/agent/model-switch-handler.ts';

const ID = 'fictional-session';
const CORRUPT = 'corrupt processing state';
const REFUSE = { reason: 'session_settings_changed' };
const BUSY = { reason: 'session_busy' };
const TURN = { reason: 'session_turn_changed' };
const LIVE_P = Promise.resolve();
const CONFIG_WRITE = 'UPDATE sessions SET config = ? WHERE id = ?';

vi.mock('../../../../src/lib/model-service.ts', async (original) => ({
  ...(await original<typeof import('../../../../src/lib/model-service.ts')>()),
  isValidModel: vi.fn(async () => true),
  getModelInfo: vi.fn(async (model: string) => ({ id: model })),
  resolveModelAlias: vi.fn(async (model: string) => model),
}));
vi.mock('../../../../src/lib/providers/factory.js', async (original) => ({
  ...(await original<typeof import('../../../../src/lib/providers/factory.js')>()),
  getProviderRegistry: () => ({
    detectProviderForModel: (_model: string, provider?: string) => ({
      id: provider ?? 'anthropic',
    }),
  }),
}));
vi.mock('../../../../src/lib/sdk-session-file-manager.ts', () => ({
  stripThinkingBlocksFromSessionFile: () => {
    throw new Error('strip failed');
  },
}));

const CONFIG: SessionConfig = { model: 'old-model', provider: 'anthropic', maxTokens: 4096 };
const DRIFTED = { ...CONFIG, model: 'drifted-model' };
const METADATA: SessionMetadata = {
  messageCount: 0,
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalCost: 0,
  toolCallCount: 0,
  acpContextUsageEstimate: 11,
  acpSessionCommand: 'fictional-acp --stdio',
};

interface Live {
  queryObject: object | null;
  queryPromise: Promise<void> | null;
  generation: number;
}

interface Parked {
  provider?: 'anthropic' | 'acp';
  nullProcessing?: boolean;
  sdkIdentity?: boolean;
  status?: string;
  queued?: boolean;
  queryObject?: object | null;
  queryPromise?: Promise<void> | null;
  driftGeneration?: boolean;
  contextFault?: boolean;
  publishFault?: boolean;
  live?: Live;
}

function seedSession(shape: Parked = {}): Session {
  return {
    id: ID,
    title: 'Fictional session',
    workspacePath: '/fictional/workspace',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    config: { ...CONFIG, provider: shape.provider ?? 'anthropic' },
    metadata: METADATA,
    processingState: shape.nullProcessing ? undefined : JSON.stringify({ status: 'idle' }),
    acpSessionId: 'fictional-acp',
    sdkSessionId: shape.sdkIdentity ? 'fictional-sdk' : undefined,
    sdkOriginPath: shape.sdkIdentity ? '/fictional/origin' : undefined,
  };
}

describe('runtime settings commit admission', () => {
  let db: Database;
  let repo: SessionRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    createTables(db);
    repo = new SessionRepository(db);
  });
  afterEach(() => db.close());

  function stored(): Record<string, unknown> {
    return db.prepare('SELECT * FROM sessions WHERE id = ?').get(ID) as Record<string, unknown>;
  }
  function storedConfig(): Record<string, unknown> {
    return JSON.parse(stored().config as string) as Record<string, unknown>;
  }
  function snapshot() {
    return repo.captureSessionRuntimeSettings(ID)!;
  }
  function run(sql: string, ...params: unknown[]) {
    return db.prepare(sql).run(...params);
  }
  function fixture(parked: Parked = {}) {
    repo.createSession(seedSession(parked));
    const session = repo.getSession(ID)!;
    let reads = 0;
    const fail = (message: string) => async () => {
      throw new Error(message);
    };
    const publish = parked.publishFault
      ? vi.fn(async () => {
          if (parked.live)
            Object.assign(parked.live, { queryObject: {}, queryPromise: LIVE_P, generation: 4 });
          throw new Error('publish failed');
        })
      : vi.fn(async () => {});
    const restart = vi.fn();
    const updateSession = vi.fn();
    const ctx = {
      session,
      db: { updateSession, casSessionRuntimeSettings: repo.casSessionRuntimeSettings.bind(repo) },
      internalEventBus: { publish },
      contextTracker: { setModel: vi.fn() },
      stateManager: { getState: () => ({ status: parked.status ?? 'idle' }) },
      errorManager: { handleError: vi.fn(fail('handled')) },
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
      lifecycleManager: { restart },
      reevaluateContextBudgetAfterModelSwitch: parked.contextFault ? fail('context') : undefined,
      get queryObject() {
        return parked.live ? parked.live.queryObject : (parked.queryObject ?? null);
      },
      get queryPromise() {
        return parked.live ? parked.live.queryPromise : (parked.queryPromise ?? null);
      },
      messageQueue: { isRunning: () => false, hasQueuedMessages: () => parked.queued ?? false },
      getQueryGeneration: () =>
        parked.live ? parked.live.generation : parked.driftGeneration && ++reads > 1 ? 1 : 0,
    } as unknown as ModelSwitchHandlerContext;
    return { session, handler: new ModelSwitchHandler(ctx), ctx, publish, updateSession, restart };
  }

  function commit(thinkingLevel?: ThinkingLevel): RuntimeSettingsCommit {
    return thinkingLevel ? { snapshot: snapshot(), thinkingLevel } : { snapshot: snapshot() };
  }

  const PARKED: ReadonlyArray<readonly [string, Parked, string]> = [
    ['queued messages', { queued: true }, 'session_busy'],
    ['waiting_for_input', { status: 'waiting_for_input' }, 'session_busy'],
    ['processing', { status: 'processing' }, 'session_busy'],
    ['active query', { queryObject: {} }, 'session_busy'],
    ['starting query', { queryPromise: Promise.resolve() }, 'session_busy'],
    ['drifted generation', { driftGeneration: true }, 'session_turn_changed'],
  ];

  test.each(PARKED)(
    'a %s session refuses a thinking-only commit with zero writes',
    async (_label, parked, reason) => {
      const { handler } = fixture(parked);
      const before = stored();
      const payload = commit('think16k');
      const result = await handler.switchModel('old-model', 'anthropic', true, payload);
      expect(result).toEqual({ success: false, model: 'old-model', error: reason });
      expect(stored()).toEqual(before);
    }
  );

  test('missing infrastructure on a same-pair thinking-only commit never rolls back', async () => {
    const { handler, session, updateSession } = fixture();
    const before = stored();
    const payload = commit('think16k');
    run('DELETE FROM session_incarnations WHERE session_id = ?', ID);
    const result = await handler.switchModel('old-model', 'anthropic', true, payload);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid session incarnation');
    expect(session.config.model).toBe('old-model');
    expect(session.config.thinkingLevel).toBeUndefined();
    expect(session.acpSessionId).toBe('fictional-acp');
    expect(stored().config).toBe(before.config);
    expect(stored().acp_session_id).toBe('fictional-acp');
    expect(updateSession).not.toHaveBeenCalled();
  });

  function recreate() {
    run('DELETE FROM sessions WHERE id = ?', ID);
    repo.createSession(seedSession());
  }

  const LOST: ReadonlyArray<readonly [string, () => void]> = [
    ['a same-id recreate', recreate],
    ['raw status drift', () => run('UPDATE sessions SET status = ? WHERE id = ?', 'paused', ID)],
    ['raw config drift', () => run(CONFIG_WRITE, JSON.stringify(DRIFTED), ID)],
  ];

  test.each(LOST)('%s loses the compare with every memory field unchanged', async (_l, drift) => {
    const { handler, session } = fixture({ sdkIdentity: true });
    const payload = commit('think16k');
    drift();
    const persisted = stored();
    const result = await handler.switchModel('new-model', 'glm', true, payload);
    expect(result.success).toBe(false);
    expect(result.error).toBe('session_settings_changed');
    expect(session.config).toMatchObject({ model: 'old-model', provider: 'anthropic' });
    expect(session.config.thinkingLevel).toBeUndefined();
    expect([session.sdkSessionId, session.acpSessionId]).toEqual([
      'fictional-sdk',
      'fictional-acp',
    ]);
    expect(session.sdkOriginPath).toBe('/fictional/origin');
    expect(stored()).toEqual(persisted);
  });

  test('a combined model, provider and thinking commit lands as one won CAS', async () => {
    const { handler, session } = fixture();
    const payload = commit('think16k');
    const result = await handler.switchModel('new-model', 'glm', true, payload);
    expect(result).toEqual({ success: true, model: 'new-model' });
    const expected = { model: 'new-model', provider: 'glm', thinkingLevel: 'think16k' };
    expect(session.config).toMatchObject({ ...expected, maxTokens: 4096 });
    expect(storedConfig()).toMatchObject({ ...expected, maxTokens: 4096 });
  });

  test('a provider-only change off acp clears both acp identities in the same commit', async () => {
    const { handler, session } = fixture({ provider: 'acp' });
    const result = await handler.switchModel('old-model', 'anthropic', true, commit());
    expect(result.success).toBe(true);
    expect(session.acpSessionId).toBeUndefined();
    expect(stored().acp_session_id).toBeNull();
    expect(stored().metadata).not.toMatch(/acpContextUsageEstimate|acpSessionCommand/);
  });

  test.each(['pair drift', 'archivedAt', 'wrong id'])(
    '%s refuses before any async model validation',
    async (mode) => {
      const { handler, session } = fixture();
      let payload = commit('think16k');
      if (mode === 'pair drift') session.config.model = 'other-model';
      if (mode === 'archivedAt') {
        run('UPDATE sessions SET archived_at = ? WHERE id = ?', '2026-02-02T00:00:00.000Z', ID);
        payload = commit('think16k');
      }
      if (mode === 'wrong id') payload = { ...payload, snapshot: { ...payload.snapshot, id: 'x' } };
      vi.mocked(isValidModel).mockClear();
      const result = await handler.switchModel('new-model', 'anthropic', true, payload);
      expect(result.success).toBe(false);
      expect(result.error).toBe('session_settings_changed');
      expect(isValidModel).not.toHaveBeenCalled();
      expect(storedConfig().thinkingLevel).toBeUndefined();
    }
  );

  test('a legitimately null persisted processing state is admitted under native idle', async () => {
    const { handler } = fixture({ nullProcessing: true });
    const result = await handler.switchModel('old-model', 'anthropic', true, commit());
    expect(result.success).toBe(true);
    expect(stored().processing_state).toBeNull();
  });

  test('gateCommitTarget admits only live, unarchived, native-matching evidence', () => {
    fixture();
    const live = snapshot();
    const pair = snapshotPair(live);
    expect(pair).toEqual({ model: 'old-model', provider: 'anthropic' });
    expect(() => snapshotProcessingStatus({ ...live, processingState: '{oops' })).toThrow(CORRUPT);
    expect(() => snapshotProcessingStatus({ ...live, processingState: '{"s":"x"}' })).toThrow(
      CORRUPT
    );
    const cases = [
      [live, pair, ID, CONFIG, true],
      [live, { ...pair, model: 'other' }, ID, CONFIG, false],
      [live, pair, ID, { ...CONFIG, provider: 'glm' }, false],
      [live, pair, 'other-session', CONFIG, false],
      [{ ...live, status: 'paused' }, pair, ID, CONFIG, false],
      [{ ...live, archivedAt: '2026-02-01T00:00:00.000Z' }, pair, ID, CONFIG, false],
    ] as const;
    const admitted = cases.map(([s, p, id, cur]) => gateCommitTarget(s, p, id, CONFIG, cur));
    expect(admitted).toEqual(cases.map(([, , , , ok]) => (ok ? { value: true } : REFUSE)));
  });

  test.each([
    [null, 'idle', false, false, true],
    ['idle', 'idle', false, false, true],
    ['idle', 'queued', false, false, false],
    [null, 'waiting_for_input', false, false, false],
    ['processing', 'idle', false, false, false],
    [null, 'idle', true, false, false],
    [null, 'idle', false, true, false],
  ])('gateCommitIdle record=%s native=%s queued=%s active=%s admits=%s', (s, n, q, a, ok) => {
    expect(gateCommitIdle(s, n, q, a)).toEqual(ok ? { value: true } : BUSY);
  });

  test('gateCommitTurn admits only a matching known generation', () => {
    expect(gateCommitTurn(4, 4)).toEqual({ value: true });
    expect([gateCommitTurn(4, 5), gateCommitTurn(undefined, 5)]).toEqual([TURN, TURN]);
  });

  test('a provider-only change into acp clears both sdk identity columns', async () => {
    const { handler, session } = fixture({ sdkIdentity: true });
    const result = await handler.switchModel('old-model', 'acp', true, commit());
    expect(result.success).toBe(true);
    expect([session.sdkSessionId, session.sdkOriginPath]).toEqual([undefined, undefined]);
    expect(stored().sdk_session_id).toBeNull();
    expect(stored().sdk_origin_path).toBeNull();
  });

  const POSTCOMMIT: ReadonlyArray<readonly [string, Parked, string, string]> = [
    ['strip', { sdkIdentity: true }, 'glm', 'strip failed'],
    ['context', { contextFault: true }, 'anthropic', ''],
    ['publish', { publishFault: true }, 'anthropic', 'publish failed'],
  ];

  test.each(POSTCOMMIT)(
    'a post-commit %s fault reports durable success without rollback',
    async (_label, parked, provider, message) => {
      const { handler, session, updateSession, restart } = fixture(parked);
      const result = await handler.switchModel('new-model', provider, true, commit());
      expect(result.success).toBe(true);
      if (message) expect(result.error).toContain(message);
      expect(session.config.model).toBe('new-model');
      expect(storedConfig().model).toBe('new-model');
      expect(restart).not.toHaveBeenCalled();
      expect(updateSession).not.toHaveBeenCalled();
    }
  );

  test('a false opt-in is refused rather than forced to non-interrupting', async () => {
    const { handler } = fixture();
    const attempt = handler.switchModel('new-model', 'anthropic', false, commit());
    await expect(attempt).rejects.toThrow('requires the non-interrupting opt-in');
  });

  test('a post-commit fault that starts a new query keeps it and the commit', async () => {
    const live: Live = { queryObject: null, queryPromise: null, generation: 0 };
    const parked: Parked = { publishFault: true, live };
    const { handler, session, ctx, updateSession, restart } = fixture(parked);
    const result = await handler.switchModel('new-model', 'glm', true, commit('think16k'));
    expect(result.success).toBe(true);
    const applied = { model: 'new-model', provider: 'glm', thinkingLevel: 'think16k' };
    expect(session.config).toMatchObject(applied);
    expect(storedConfig()).toMatchObject(applied);
    expect(ctx.queryObject).toBe(live.queryObject);
    expect(ctx.queryPromise).toBe(LIVE_P);
    expect(ctx.getQueryGeneration()).toBe(4);
    expect([restart.mock.calls.length, updateSession.mock.calls.length]).toEqual([0, 0]);
  });

  test('AgentSession forwards two, three and four arguments exactly', async () => {
    const switchModel = vi.fn(async () => ({ success: true, model: 'm' }));
    const session = { modelSwitchHandler: { switchModel } } as unknown as AgentSession;
    await AgentSession.prototype.handleModelSwitch.call(session, 'm', 'anthropic');
    await AgentSession.prototype.handleModelSwitch.call(session, 'm', 'anthropic', true);
    repo.createSession(seedSession());
    const payload = commit();
    await AgentSession.prototype.handleModelSwitch.call(session, 'm', 'anthropic', true, payload);
    expect(switchModel.mock.calls).toEqual([
      ['m', 'anthropic'],
      ['m', 'anthropic', true],
      ['m', 'anthropic', true, payload],
    ]);
  });
});
