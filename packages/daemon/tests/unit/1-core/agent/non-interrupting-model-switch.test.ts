import { beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { createTestSession } from '../../../helpers/database.ts';
import { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import {
  ModelSwitchHandler,
  type ModelSwitchHandlerContext,
  gateSwitchIdle,
  gateSwitchPair,
  gateSwitchTurn,
} from '../../../../src/lib/agent/model-switch-handler.ts';

const models = vi.hoisted(() => ({ valid: vi.fn(async () => true) }));
vi.mock('../../../../src/lib/model-service.ts', async (original) => ({
  ...(await original<typeof import('../../../../src/lib/model-service.ts')>()),
  isValidModel: models.valid,
  getModelInfo: vi.fn(async (model: string) => ({ id: model })),
  resolveModelAlias: vi.fn(async (model: string) => model),
}));
vi.mock('../../../../src/lib/providers/factory.js', async (original) => ({
  ...(await original<typeof import('../../../../src/lib/providers/factory.js')>()),
  getProviderRegistry: () => ({ detectProviderForModel: () => ({ id: 'anthropic' }) }),
}));

function fixture() {
  const session = createTestSession('fictional-model-switch');
  session.config = { ...session.config, model: 'old-model', provider: 'anthropic' };
  session.sdkSessionId = 'saved-sdk';
  const ctx = {
    session,
    db: { updateSession: vi.fn() },
    messageHub: {},
    internalEventBus: { publish: vi.fn(async () => {}) },
    contextTracker: { setModel: vi.fn() },
    stateManager: { getState: () => ({ status: 'idle' }) },
    errorManager: { handleError: vi.fn(async () => {}) },
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    lifecycleManager: { restart: vi.fn(async () => {}) },
    queryObject: null as object | null,
    queryPromise: null as Promise<void> | null,
    messageQueue: { isRunning: vi.fn(() => false) },
    getQueryGeneration: vi.fn(() => 0),
  };
  return { ctx, handler: new ModelSwitchHandler(ctx as unknown as ModelSwitchHandlerContext) };
}

function expectNoEffects(ctx: ReturnType<typeof fixture>['ctx']) {
  expect(ctx.db.updateSession).not.toHaveBeenCalled();
  expect(ctx.lifecycleManager.restart).not.toHaveBeenCalled();
  expect(ctx.internalEventBus.publish).not.toHaveBeenCalled();
  expect(ctx.contextTracker.setModel).not.toHaveBeenCalled();
  expect(ctx.errorManager.handleError).not.toHaveBeenCalled();
}

describe('non-interrupting model switch admission', () => {
  beforeEach(() => models.valid.mockReset().mockResolvedValue(true));

  test('pure gates preserve opt-in precedence and reject missing turn evidence', () => {
    const pair = { model: 'model', provider: 'anthropic' as const };
    expect(gateSwitchIdle(true, true)).toEqual({ reason: 'session_busy' });
    expect(gateSwitchIdle(false, true)).toEqual({ value: true });
    expect(gateSwitchPair(true, pair, { ...pair, model: 'other' })).toEqual({
      reason: 'session_settings_changed',
    });
    expect(gateSwitchPair(false, pair, { ...pair, model: 'other' })).toEqual({ value: true });
    expect(gateSwitchTurn(true, undefined, undefined)).toEqual({ reason: 'session_turn_changed' });
    expect(gateSwitchTurn(false, undefined, undefined)).toEqual({ value: true });
    expect(gateSwitchTurn(true, 0, 0)).toEqual({ value: true });
    expect(gateSwitchTurn(true, 0, 1)).toEqual({ reason: 'session_turn_changed' });
  });

  test.each(['queryObject', 'queryPromise', 'queue'])(
    'refuses an already active %s without mutation or restart',
    async (active) => {
      const { ctx, handler } = fixture();
      if (active === 'queryObject') ctx.queryObject = {};
      if (active === 'queryPromise') ctx.queryPromise = Promise.resolve();
      if (active === 'queue') ctx.messageQueue.isRunning.mockReturnValue(true);
      const before = structuredClone(ctx.session);
      expect(await handler.switchModel('new-model', 'anthropic', true)).toEqual({
        success: false,
        model: 'old-model',
        error: 'session_busy',
      });
      expect(ctx.session).toEqual(before);
      expectNoEffects(ctx);
    }
  );

  test.each(['active', 'completed', 'unavailable'])(
    'rechecks an %s turn after validation',
    async (state) => {
      const { ctx, handler } = fixture();
      if (state === 'unavailable') Reflect.deleteProperty(ctx, 'getQueryGeneration');
      const validation = Promise.withResolvers<boolean>();
      models.valid.mockReturnValueOnce(validation.promise);
      const pending = handler.switchModel('new-model', 'anthropic', true);
      expect(models.valid).toHaveBeenCalledTimes(1);
      if (state === 'active') ctx.queryObject = {};
      else if (state === 'completed') ctx.getQueryGeneration.mockReturnValue(1);
      validation.resolve(true);
      expect(await pending).toMatchObject({
        success: false,
        error: state === 'active' ? 'session_busy' : 'session_turn_changed',
      });
      expect(ctx.session.config.model).toBe('old-model');
      expect(ctx.session.sdkSessionId).toBe('saved-sdk');
      expectNoEffects(ctx);
    }
  );

  test.each(['model', 'provider'] as const)(
    'refuses a concurrent %s change after validation without overwriting it',
    async (field) => {
      const { ctx, handler } = fixture();
      const validation = Promise.withResolvers<boolean>();
      models.valid.mockReturnValueOnce(validation.promise);
      const pending = handler.switchModel('new-model', 'anthropic', true);
      if (field === 'model') ctx.session.config.model = 'other-model';
      else ctx.session.config.provider = 'glm';
      const concurrent = structuredClone(ctx.session);
      validation.resolve(true);
      expect(await pending).toMatchObject({ success: false, error: 'session_settings_changed' });
      expect(ctx.session).toEqual(concurrent);
      expectNoEffects(ctx);
    }
  );

  test('a validation exception cannot roll back a concurrent change or touch an active turn', async () => {
    const { ctx, handler } = fixture();
    const validation = Promise.withResolvers<boolean>();
    models.valid.mockReturnValueOnce(validation.promise);
    const pending = handler.switchModel('new-model', 'anthropic', true);
    ctx.session.config.model = 'other-model';
    ctx.queryObject = {};
    const concurrent = structuredClone(ctx.session);
    validation.reject(new Error('validation failed'));
    expect(await pending).toEqual({
      success: false,
      model: 'other-model',
      error: 'validation failed',
    });
    expect(ctx.session).toEqual(concurrent);
    expectNoEffects(ctx);
  });

  test('an inactive guarded switch still uses native persistence and context tracking', async () => {
    const { ctx, handler } = fixture();
    const cleanup = vi.spyOn(
      handler as unknown as { stripThinkingBlocksIfNeeded(): void },
      'stripThinkingBlocksIfNeeded'
    );
    ctx.internalEventBus.publish.mockImplementationOnce(async () => {
      expect(cleanup).toHaveBeenCalledTimes(1);
      ctx.queryObject = {};
    });
    expect(await handler.switchModel('new-model', 'anthropic', true)).toEqual({
      success: true,
      model: 'new-model',
    });
    expect(ctx.db.updateSession).toHaveBeenCalledTimes(1);
    expect(ctx.session.config.model).toBe('new-model');
    expect(ctx.contextTracker.setModel).toHaveBeenCalledWith('new-model');
    expect(ctx.internalEventBus.publish).toHaveBeenCalledTimes(1);
    expect(ctx.lifecycleManager.restart).not.toHaveBeenCalled();
  });

  test('default human/native behavior still restarts an active query', async () => {
    const { ctx, handler } = fixture();
    ctx.queryObject = {};
    expect(await handler.switchModel('new-model', 'anthropic')).toEqual({
      success: true,
      model: 'new-model',
    });
    expect(ctx.lifecycleManager.restart).toHaveBeenCalledTimes(1);
    expect(ctx.db.updateSession).toHaveBeenCalledTimes(1);
  });

  test.each(['active', 'superseded', 'completed'])(
    'a post-write failure cannot roll back %s work',
    async (change) => {
      const { ctx, handler } = fixture();
      ctx.internalEventBus.publish.mockImplementationOnce(async () => {
        if (change === 'active') ctx.queryObject = {};
        else if (change === 'superseded') ctx.session.config.model = 'other-model';
        else ctx.getQueryGeneration.mockReturnValue(1);
        ctx.session.sdkSessionId = 'new-turn-sdk';
        throw new Error('publish failed');
      });
      const model = change === 'superseded' ? 'other-model' : 'new-model';
      expect(await handler.switchModel('new-model', 'anthropic', true)).toEqual({
        success: false,
        model,
        error: 'publish failed',
      });
      expect(ctx.session.config.model).toBe(model);
      expect(ctx.session.sdkSessionId).toBe('new-turn-sdk');
      expect(ctx.db.updateSession).toHaveBeenCalledTimes(1);
      expect(ctx.lifecycleManager.restart).not.toHaveBeenCalled();
      expect(ctx.errorManager.handleError).not.toHaveBeenCalled();
    }
  );

  test('a synchronous write failure still compensates when the applied pair is unchanged and idle', async () => {
    const { ctx, handler } = fixture();
    ctx.db.updateSession.mockImplementationOnce(() => {
      throw new Error('write failed');
    });
    expect(await handler.switchModel('new-model', 'anthropic', true)).toEqual({
      success: false,
      model: 'old-model',
      error: 'write failed',
    });
    expect(ctx.session.config.model).toBe('old-model');
    expect(ctx.db.updateSession).toHaveBeenCalledTimes(2);
    expect(ctx.errorManager.handleError).toHaveBeenCalledTimes(1);
    expect(ctx.lifecycleManager.restart).not.toHaveBeenCalled();
  });

  test('AgentSession forwards the opt-in mode and preserves the default', async () => {
    const switchModel = vi.fn(async () => ({ success: true, model: 'new-model' }));
    const session = { modelSwitchHandler: { switchModel } } as unknown as AgentSession;
    await AgentSession.prototype.handleModelSwitch.call(session, 'new-model', 'anthropic', true);
    await AgentSession.prototype.handleModelSwitch.call(session, 'new-model', 'anthropic');
    expect(switchModel.mock.calls).toEqual([
      ['new-model', 'anthropic', true],
      ['new-model', 'anthropic'],
    ]);
  });
});
