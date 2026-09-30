import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { Session, SessionConfig, SessionMetadata } from '@hyperneo/shared';
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
  providerIdentityClears,
  snapshotPair,
  snapshotProcessingStatus,
} from '../../../../src/lib/agent/model-switch-handler.ts';

const ID = 'fictional-session';
const PAIR = { model: 'old-model', provider: 'anthropic' as const };
const CHANGED = { reason: 'session_settings_changed' };
const BUSY = { reason: 'session_busy' };
const CORRUPT = 'corrupt processing state';

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

interface Shape {
  provider?: 'anthropic' | 'acp';
  nullProcessing?: boolean;
  sdkIdentity?: boolean;
}

function seedSession(shape: Shape = {}): Session {
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

type Parked = Shape & {
  status?: string;
  queued?: boolean;
  queryObject?: object | null;
  queryPromise?: Promise<void> | null;
  driftGeneration?: boolean;
  contextFault?: boolean;
  publishFault?: boolean;
};

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
    const publish = parked.publishFault ? vi.fn(fail('publish failed')) : vi.fn(async () => {});
    const restart = vi.fn();
    const updateSession = vi.fn();
    const handler = new ModelSwitchHandler({
      session,
      db: { updateSession, casSessionRuntimeSettings: repo.casSessionRuntimeSettings.bind(repo) },
      internalEventBus: { publish },
      contextTracker: { setModel: vi.fn() },
      stateManager: { getState: () => ({ status: parked.status ?? 'idle' }) },
      errorManager: { handleError: vi.fn(fail('handled')) },
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
      lifecycleManager: { restart },
      reevaluateContextBudgetAfterModelSwitch: parked.contextFault
        ? fail('context failed')
        : undefined,
      queryObject: parked.queryObject ?? null,
      queryPromise: parked.queryPromise ?? null,
      messageQueue: { isRunning: () => false, hasQueuedMessages: () => parked.queued ?? false },
      getQueryGeneration: () => {
        reads += 1;
        return parked.driftGeneration && reads > 1 ? 1 : 0;
      },
    } as unknown as ModelSwitchHandlerContext);
    return { session, handler, publish, updateSession, restart };
  }

  function commit(thinkingLevel?: string): RuntimeSettingsCommit {
    return thinkingLevel ? { snapshot: snapshot(), thinkingLevel } : { snapshot: snapshot() };
  }

  test('pure gates refuse archived, drifted, parked and superseded evidence', () => {
    fixture();
    const live = snapshot();
    expect(gateCommitTarget(live, PAIR, ID, CONFIG, CONFIG)).toEqual({ value: true });
    expect(gateCommitTarget(live, { ...PAIR, model: 'other' }, ID, CONFIG, CONFIG)).toEqual(
      CHANGED
    );
    expect(gateCommitTarget(live, PAIR, 'other-session', CONFIG, CONFIG)).toEqual(CHANGED);
    expect(gateCommitTarget({ ...live, status: 'paused' }, PAIR, ID, CONFIG, CONFIG)).toEqual(
      CHANGED
    );
    expect(gateCommitIdle(null, 'idle', false, false)).toEqual({ value: true });
    expect(gateCommitIdle('idle', 'idle', true, false)).toEqual({ reason: 'session_busy' });
    expect(gateCommitTurn(1, 1)).toEqual({ value: true });
  });

  test('snapshot evidence reads the original pair and separates absence from corruption', () => {
    fixture();
    const live = snapshot();
    expect(snapshotPair(live)).toEqual(PAIR);
    expect(snapshotProcessingStatus(live)).toBe('idle');
    expect(snapshotProcessingStatus({ ...live, processingState: null })).toBeNull();
    expect(() => snapshotProcessingStatus({ ...live, processingState: '{oops' })).toThrow(CORRUPT);
    expect(() => snapshotProcessingStatus({ ...live, processingState: '{"s":"x"}' })).toThrow(
      CORRUPT
    );
    const to = ['anthropic', 'acp', 'glm'];
    expect(
      ['acp', 'anthropic', 'anthropic'].map((f, i) => providerIdentityClears(f, to[i]))
    ).toEqual([
      { clearAcpSession: true, clearSdkSession: false },
      { clearAcpSession: false, clearSdkSession: true },
      { clearAcpSession: false, clearSdkSession: false },
    ]);
  });

  const PARKED: ReadonlyArray<readonly [string, Parked, string]> = [
    ['queued messages', { queued: true }, 'session_busy'],
    ['waiting_for_input', { status: 'waiting_for_input' }, 'session_busy'],
    ['processing', { status: 'processing' }, 'session_busy'],
    ['rate limited', { status: 'rate_limit_cooldown' }, 'session_busy'],
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
    ['raw config drift', () => run('UPDATE sessions SET config = ? WHERE id = ?', '{"d":1}', ID)],
  ];

  test.each(LOST)('%s loses the compare with every memory field unchanged', async (_l, drift) => {
    const { handler, session } = fixture({ sdkIdentity: true });
    const payload = commit('think16k');
    drift();
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
    expect(storedConfig().model).not.toBe('new-model');
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
    expect(stored().metadata).not.toContain('acpContextUsageEstimate');
    expect(stored().metadata).not.toContain('acpSessionCommand');
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
