import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import { AgentSession as NativeSession } from '../../../../src/lib/agent/agent-session.ts';
import {
  ModelSwitchHandler,
  type ModelSwitchHandlerContext,
} from '../../../../src/lib/agent/model-switch-handler.ts';
import { createSessionRuntimeSettingsOperations } from '../../../../src/lib/session/runtime-settings-operations.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables } from '../../../../src/storage/schema/index.ts';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository.ts';
import { createTestSession } from '../../../helpers/database.ts';

const models = vi.hoisted(() => ({
  valid: vi.fn(async () => true),
  catalog: vi.fn(() => [
    { id: 'new-model', provider: 'anthropic' },
    { id: 'old-model', provider: 'acp' },
  ]),
}));
vi.mock('../../../../src/lib/model-service.ts', async (original) => ({
  ...(await original<typeof import('../../../../src/lib/model-service.ts')>()),
  isValidModel: models.valid,
  getAvailableModels: models.catalog,
  getModelInfo: async (model: string) => ({ id: model }),
  resolveModelAlias: async (model: string) => model,
  isCuratedOutModel: () => false,
}));
vi.mock('../../../../src/lib/providers/factory.js', async (original) => ({
  ...(await original<typeof import('../../../../src/lib/providers/factory.js')>()),
  getProviderRegistry: () => ({
    detectProviderForModel: (_model: string, provider: string) => ({ id: provider }),
  }),
}));

describe('session.runtimeSettings.update native boundary', () => {
  let db: Database;
  let repo: SessionRepository;
  beforeEach(() => {
    db = new Database(':memory:');
    createTables(db);
    repo = new SessionRepository(db);
    const session = createTestSession('fictional-target');
    session.config = { ...session.config, model: 'old-model', provider: 'anthropic' };
    session.processingState = JSON.stringify({ status: 'idle' });
    repo.createSession(session);
    models.valid.mockReset().mockResolvedValue(true);
    models.catalog.mockReset().mockReturnValue([
      { id: 'new-model', provider: 'anthropic' },
      { id: 'old-model', provider: 'acp' },
    ]);
  });
  afterEach(() => db.close());
  function row() {
    return db.prepare('SELECT * FROM sessions WHERE id = ?').get('fictional-target');
  }
  function fixture() {
    const session = repo.getSession('fictional-target')!;
    const state = {
      status: 'idle',
      query: null as object | null,
      starting: null as Promise<void> | null,
      generation: 0,
      preparing: false,
      pending: false,
    };
    const restart = vi.fn(async () => {});
    const blindWrite = vi.fn();
    const cas = vi.fn(repo.casSessionRuntimeSettings.bind(repo));
    const capture = vi.fn(repo.captureSessionRuntimeSettings.bind(repo));
    const publish = vi.fn(async () => {});
    const ctx = {
      session,
      db: { casSessionRuntimeSettings: cas, updateSession: blindWrite },
      internalEventBus: { publish },
      contextTracker: { setModel: vi.fn() },
      stateManager: { getState: () => ({ status: state.status }) },
      errorManager: { handleError: vi.fn() },
      logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      lifecycleManager: { restart },
      get queryObject() {
        return state.query;
      },
      get queryPromise() {
        return state.starting;
      },
      messageQueue: { isRunning: () => false, hasQueuedMessages: () => state.pending },
      getQueryGeneration: () => state.generation,
    } as unknown as ModelSwitchHandlerContext;
    const native = {
      modelSwitchHandler: new ModelSwitchHandler(ctx),
      handleModelSwitch: NativeSession.prototype.handleModelSwitch,
      getSessionData: () => session,
      getProcessingState: () => ({ status: state.status }),
      isQueryActiveOrStarting: () => !!state.query || !!state.starting,
    } as unknown as AgentSession;
    let owner: AgentSession | null = native;
    const operations = createSessionRuntimeSettingsOperations({
      getSession: repo.getSession.bind(repo),
      getLiveSession: () => owner,
      sessionSpaceId: () => undefined,
      capture,
      commit: cas,
      isPreparing: () => state.preparing,
      hasPendingWork: () => state.pending,
      notify: publish,
    });
    const update = operations.find(
      (operation) => operation.name === 'session.runtimeSettings.update'
    )!;
    const invoke = (patch: Record<string, unknown>) =>
      update.execute({ sessionId: session.id, ...patch }, { source: 'rpc' });
    return {
      state,
      session,
      cas,
      capture,
      restart,
      blindWrite,
      publish,
      native,
      invoke,
      cold: () => {
        owner = null;
      },
      replace: () => {
        owner = { ...native } as AgentSession;
      },
    };
  }

  const PATCHES = [{ model: 'new-model' }, { provider: 'acp' }, { thinkingLevel: 'think16k' }];
  for (const patch of PATCHES) {
    test.each([
      'processing',
      'queued',
      'waiting_for_input',
      'starting',
      'query',
      'preparing',
      'pending',
    ])(
      `refuses %s for ${Object.keys(patch)[0]} with unchanged real storage and native config`,
      async (busy) => {
        const f = fixture();
        if (busy === 'starting') f.state.starting = Promise.resolve();
        else if (busy === 'query') f.state.query = {};
        else if (busy === 'preparing' || busy === 'pending') f.state[busy] = true;
        else f.state.status = busy;
        const before = row();
        const config = structuredClone(f.session.config);
        expect(await f.invoke(patch)).toMatchObject({ ok: false, reason: 'session_busy' });
        expect(row()).toEqual(before);
        expect(f.session.config).toEqual(config);
        expect(f.cas).not.toHaveBeenCalled();
        expect(f.restart).not.toHaveBeenCalled();
        expect(f.blindWrite).not.toHaveBeenCalled();
      }
    );
  }

  test.each(['query', 'pending', 'preparing', 'replacement', 'archive-revival', 'generation'])(
    'rejects %s arising during actual native validation using the original capture',
    async (change) => {
      const f = fixture();
      const validation = Promise.withResolvers<boolean>();
      models.valid.mockReturnValueOnce(validation.promise);
      const pending = f.invoke({ model: 'new-model', thinkingLevel: 'think16k' });
      await vi.waitFor(() => expect(models.valid).toHaveBeenCalledTimes(1));
      if (change === 'query') f.state.query = {};
      if (change === 'pending' || change === 'preparing') f.state[change] = true;
      if (change === 'replacement') f.replace();
      if (change === 'generation') f.state.generation++;
      if (change === 'archive-revival') {
        db.prepare("UPDATE sessions SET status = 'archived' WHERE id = ?").run(f.session.id);
        db.prepare("UPDATE sessions SET status = 'active' WHERE id = ?").run(f.session.id);
      }
      const before = row();
      validation.resolve(true);
      expect(await pending).toMatchObject({ ok: false });
      expect(f.capture).toHaveBeenCalledTimes(1);
      expect(row()).toEqual(before);
      expect(f.session.config.model).toBe('old-model');
      expect(f.restart).not.toHaveBeenCalled();
      expect(f.blindWrite).not.toHaveBeenCalled();
    }
  );

  test('commits the exact original snapshot once through the real native switch', async () => {
    const f = fixture();
    expect(await f.invoke({ model: 'new-model', thinkingLevel: 'think16k' })).toMatchObject({
      ok: true,
      appliesFrom: 'next-turn',
    });
    expect(f.cas).toHaveBeenCalledTimes(1);
    expect(f.cas.mock.calls[0][0]).toBe(f.capture.mock.results[0].value);
    expect(repo.getSession(f.session.id)?.config).toMatchObject({
      model: 'new-model',
      thinkingLevel: 'think16k',
    });
    expect(f.session.config).toMatchObject({ model: 'new-model', thinkingLevel: 'think16k' });
    expect(f.restart).not.toHaveBeenCalled();
    expect(f.blindWrite).not.toHaveBeenCalled();
  });

  test('thinking-only uses one CAS and no provider validation or blind native write', async () => {
    const f = fixture();
    expect(await f.invoke({ thinkingLevel: 'think32k' })).toMatchObject({ ok: true });
    expect(f.cas).toHaveBeenCalledTimes(1);
    expect(models.valid).not.toHaveBeenCalled();
    expect(f.session.config.thinkingLevel).toBe('think32k');
    expect(repo.getSession(f.session.id)?.config.thinkingLevel).toBe('think32k');
    expect(f.blindWrite).not.toHaveBeenCalled();
  });

  test('cold provider changes atomically clear SDK identity without losing other config', async () => {
    const f = fixture();
    repo.updateSession(f.session.id, {
      sdkSessionId: 'fictional-sdk',
      sdkOriginPath: '/fictional/origin',
    });
    f.cold();
    expect(await f.invoke({ provider: 'acp', thinkingLevel: 'think8k' })).toMatchObject({
      ok: true,
    });
    const stored = repo.getSession(f.session.id)!;
    expect(stored.sdkSessionId).toBeUndefined();
    expect(stored.sdkOriginPath).toBeUndefined();
    expect(stored.config).toMatchObject({
      model: 'old-model',
      provider: 'acp',
      thinkingLevel: 'think8k',
      maxTokens: f.session.config.maxTokens,
    });
    expect(f.cas).toHaveBeenCalledTimes(1);
    expect(f.restart).not.toHaveBeenCalled();
  });

  test.each([
    { catalog: [], reason: 'catalog_unavailable' },
    { catalog: [{ id: 'old-model', provider: 'anthropic' }], reason: 'catalog_unavailable' },
    { catalog: [{ id: 'other-model', provider: 'openrouter' }], reason: 'invalid_model' },
  ])('cold provider-only rejects $reason without writing any stored row', async (entry) => {
    const f = fixture();
    f.cold();
    models.catalog.mockReturnValue(entry.catalog);
    const before = row();
    expect(await f.invoke({ provider: 'openrouter' })).toMatchObject({
      ok: false,
      reason: entry.reason,
    });
    expect(row()).toEqual(before);
    expect(f.cas).not.toHaveBeenCalled();
    expect(f.restart).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });

  test('a post-commit notification failure does not invent a rollback or rejection', async () => {
    const f = fixture();
    f.publish.mockRejectedValueOnce(new Error('fictional listener fault'));
    expect(await f.invoke({ thinkingLevel: 'think8k' })).toMatchObject({ ok: true });
    expect(repo.getSession(f.session.id)?.config.thinkingLevel).toBe('think8k');
    expect(f.cas).toHaveBeenCalledTimes(1);
  });
});
