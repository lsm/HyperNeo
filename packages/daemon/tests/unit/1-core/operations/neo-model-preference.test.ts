import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessageHub, ModelInfo, Session } from '@hyperneo/shared';
import { getSessionContextModelInfo, setModelsCache } from '../../../../src/lib/model-service.ts';
import {
  effectiveNeoPreference,
  planNeoAlignment,
  requireNeoPreferenceModel,
} from '../../../../src/lib/neo/model-preference.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { createNeoService } from '../../../../src/lib/neo/packs/runtime.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import { contextBudgetThreshold } from '../../../../src/lib/agent/context-budget-decision.ts';
import { buildProviderSettings } from '../../../../src/lib/agent/query-options-builder.ts';
import { autoCompactReserveTokens } from '../../../../src/lib/agent/context-tracker.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const user: OperationCaller = { source: 'rpc', principal: 'local' };
const flash = {
  id: 'deepseek-v4-flash',
  provider: 'deepseek',
  thinkingModes: 'on',
  available: true,
  contextWindow: 1_000_000,
  autoCompactPercent: 80,
} as ModelInfo;
const opus = {
  id: 'claude-opus',
  provider: 'anthropic',
  thinkingModes: 'granular',
  effortLevels: ['low', 'medium', 'high'],
  available: true,
} as ModelInfo;

describe('requireNeoPreferenceModel', () => {
  test('refuses a model the catalog does not offer and keeps the chosen thinking', () => {
    expect(
      requireNeoPreferenceModel(
        { model: 'gone', provider: 'deepseek', thinkingLevel: 'off' },
        { models: [flash] }
      )
    ).toMatchObject({ reason: { ok: false, reason: expect.stringContaining('invalid_model') } });
    expect(
      requireNeoPreferenceModel(
        { model: 'deepseek-v4-flash', provider: 'deepseek', thinkingLevel: 'think16k' },
        { models: [flash] }
      )
    ).toEqual({
      value: { model: 'deepseek-v4-flash', provider: 'deepseek', thinkingLevel: 'think16k' },
    });
  });

  test('accepts the same model under its 1M id but not a different model sharing its prefix', () => {
    const flashGlm = { id: 'glm-5.3-flash', alias: 'glm-5.3-flash', provider: 'glm' } as ModelInfo;
    expect(
      requireNeoPreferenceModel(
        { model: 'glm-5.3[1m]', provider: 'glm', thinkingLevel: 'off' },
        { models: [flashGlm, { ...flashGlm, id: 'glm-5.3', alias: 'glm-5.3' }] }
      )
    ).toEqual({ value: { model: 'glm-5.3[1m]', provider: 'glm', thinkingLevel: 'off' } });
    expect(
      requireNeoPreferenceModel(
        { model: 'glm-5.3[1m]', provider: 'glm', thinkingLevel: 'off' },
        { models: [flashGlm] }
      )
    ).toMatchObject({ reason: { ok: false, reason: expect.stringContaining('invalid_model') } });
  });

  test('saves the exact model id when given the alias of a listed model', () => {
    const opusAlias = { ...opus, id: 'claude-opus-5-5', alias: 'opus' } as ModelInfo;
    expect(
      requireNeoPreferenceModel(
        { model: 'opus', provider: 'anthropic', thinkingLevel: 'off' },
        { models: [opusAlias] }
      )
    ).toEqual({
      value: { model: 'claude-opus-5-5', provider: 'anthropic', thinkingLevel: 'off' },
    });
  });
});

describe('effectiveNeoPreference', () => {
  const saved = { model: 'm', provider: 'p', thinkingLevel: 'think8k' as const };

  test('uses the saved preference, else root Neo, else nothing', () => {
    expect(effectiveNeoPreference(saved, { model: 'r', provider: 'q' })).toEqual({
      ...saved,
      saved: true,
    });
    expect(effectiveNeoPreference(undefined, { model: 'r', provider: 'q' })).toEqual({
      model: 'r',
      provider: 'q',
      thinkingLevel: 'off',
      saved: false,
    });
    expect(
      effectiveNeoPreference(undefined, { model: 'r', provider: 'q' }, 'think8k')
    ).toMatchObject({
      thinkingLevel: 'think8k',
      saved: false,
    });
    expect(
      effectiveNeoPreference(
        undefined,
        { model: 'r', provider: 'q', thinkingLevel: 'off' },
        'think8k'
      )
    ).toMatchObject({ thinkingLevel: 'off' });
    expect(effectiveNeoPreference(undefined, null)).toBe(null);
  });

  test('normalizes a legacy saved thinking level', () => {
    expect(
      effectiveNeoPreference({ ...saved, thinkingLevel: 'auto' as never }, null)
    ).toMatchObject({ thinkingLevel: 'off', saved: true });
  });
});

describe('planNeoAlignment', () => {
  const preference = { model: 'm', provider: 'p', thinkingLevel: 'off' as const };

  test.each<[string, Parameters<typeof planNeoAlignment>[0], ReturnType<typeof planNeoAlignment>]>([
    ['a session already in sync', { model: 'm', provider: 'p', thinkingLevel: 'off' }, null],
    [
      'another model',
      { model: 'x', provider: 'p', thinkingLevel: 'off' },
      { model: true, thinking: false },
    ],
    [
      'another thinking level',
      { model: 'm', provider: 'p', thinkingLevel: 'think8k' },
      { model: false, thinking: true },
    ],
  ])('plans %s', (_case, config, plan) => {
    expect(planNeoAlignment(config, preference)).toEqual(plan);
  });
});

describe('neo.preferences.set', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: ReturnType<typeof createNeoService>;
  let switched: unknown[];
  let updated: unknown[];
  let restarted: unknown[];
  let created: unknown[];
  let recovering: boolean;
  let busy: boolean;
  let events: InternalEventBus<DaemonInternalEventMap>;
  let switchFailure: 'refused' | 'throws' | 'pending' | undefined;

  beforeEach(async () => {
    db = await createTestDb();
    const root = createTestSession('neo:root');
    await db.createSession({
      ...root,
      config: { ...root.config, model: 'claude-opus', provider: 'anthropic' },
    });
    setModelsCache(new Map([['global', [flash, opus]]]));
    switched = [];
    updated = [];
    restarted = [];
    created = [];
    recovering = false;
    busy = false;
    switchFailure = undefined;
    const sessions = {
      getSessionForControl: async (sessionId: string) => ({
        isLimitRecoveryPending: () => false,
        restartQuery: async () => {
          restarted.push(db.getSession(sessionId)?.config);
        },
        getProcessingState: () => ({ status: busy ? 'processing' : 'idle' }),
        getRateLimitWatchdogState: () => ({
          lastUserMessage: recovering ? { uuid: 'limited-turn' } : null,
        }),
        requestModelSwitch: async (model: string, provider: string) => {
          switched.push([sessionId, model, provider]);
          if (switchFailure === 'pending')
            return { success: true, model, pending: { model, provider, requestedAt: 1 } };
          if (switchFailure === 'throws') throw new Error('Synthetic unavailable primary');
          if (switchFailure === 'refused')
            return {
              success: false,
              model: db.getSession(sessionId)?.config.model,
              error: 'Synthetic unavailable primary',
            };
          await db.updateSession(sessionId, {
            config: {
              ...db.getSession(sessionId)!.config,
              model,
              provider: provider as Session['config']['provider'],
            },
          });
          return { success: true, model };
        },
        getSessionData: () => db.getSession(sessionId),
      }),
      updateSession: async (sessionId: string, updates: Partial<Session>) => {
        updated.push([sessionId, updates]);
        await db.updateSession(sessionId, updates);
      },
      createSession: async (params: unknown) => {
        created.push(params);
      },
    };
    events = new InternalEventBus<DaemonInternalEventMap>();
    service = createNeoService(
      db,
      sessions as unknown as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      events
    );
    service.repo.reserveBinding({ sessionId: 'neo:root', kind: 'neo', projectId: null });
  });
  afterEach(() => {
    service.dispose();
    db.close();
    setModelsCache(new Map());
  });

  function invoke(name: string, input: unknown, caller = user) {
    return invokeOperation(
      createOperationRegistry(createNeoOperations(service)),
      name,
      input,
      caller
    );
  }

  test.each([
    [1, 10],
    [70, 70],
    [101, 100],
  ])('clamps percentage %s to %s and exposes it in settings/snapshot', async (input, expected) => {
    const preference = {
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
      thinkingLevel: 'off',
      autoCompactPercent: input,
    };
    expect(await invoke('neo.preferences.set', preference)).toMatchObject({
      value: { ok: true, preferences: { autoCompactPercent: expected } },
    });
    expect(db.getGlobalSettings().neo?.preferences).toMatchObject({ autoCompactPercent: expected });
    expect(await invoke('neo.snapshot', {})).toMatchObject({
      value: { preferences: { autoCompactPercent: expected, saved: true } },
    });
  });

  test.each([70.5, '70', null, true, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid percentage %s without saving',
    async (autoCompactPercent) => {
      const result = await invoke('neo.preferences.set', {
        model: 'claude-opus',
        provider: 'anthropic',
        thinkingLevel: 'off',
        autoCompactPercent,
      });
      expect(result).toMatchObject({ kind: 'failed', code: 'invalid_input' });
      expect(db.getGlobalSettings().neo?.preferences).toBeUndefined();
    }
  );

  test('writes the ordinary session setting only for Neo without a special restart', async () => {
    const base = {
      model: 'deepseek-v4-flash',
      provider: 'deepseek' as const,
      thinkingLevel: 'off' as const,
    };
    for (const id of ['neo:root', 'ordinary', 'worker']) {
      if (id !== 'neo:root') await db.createSession(createTestSession(id));
      await db.updateSession(id, { config: { ...(await db.getSession(id)!.config), ...base } });
    }
    service.repo.reserveBinding({ sessionId: 'worker', kind: 'worker', projectId: null });
    const percentage = async (id: string) =>
      (await getSessionContextModelInfo(db.getSession(id)!))?.autoCompactPercent;
    busy = true;
    await invoke('neo.preferences.set', { ...base, autoCompactPercent: 70 });
    expect(updated).toContainEqual([
      'neo:root',
      expect.objectContaining({ config: expect.objectContaining({ autoCompactPercent: 70 }) }),
    ]);
    busy = false;
    for (const id of ['neo:root', 'ordinary', 'worker']) {
      const event = await events.publish('session.updated', {
        sessionId: id,
        processingState: { status: 'idle' },
      });
      expect(event.failures).toEqual([]);
      expect(await percentage(id)).toBe(id === 'neo:root' ? 70 : 80);
    }
    const info = await getSessionContextModelInfo(db.getSession('neo:root')!);
    expect(contextBudgetThreshold(info!.contextWindow!, info!.autoCompactPercent)).toBe(700_000);
    expect(
      buildProviderSettings('deepseek', info!.contextWindow, info!.id, info!.autoCompactPercent)
        ?.autoCompactWindow
    ).toBe(700_000 + autoCompactReserveTokens('deepseek'));
    expect(buildProviderSettings('anthropic', 1_000_000, 'claude-opus', 70)).toBeUndefined();
    expect(await getSessionContextModelInfo(db.getSession('ordinary')!)).toMatchObject({
      autoCompactPercent: 80,
    });
    await invoke('neo.preferences.set', base);
    expect(await percentage('neo:root')).toBe(80);
    expect(db.getGlobalSettings().neo?.preferences).not.toHaveProperty('autoCompactPercent');
  });

  test('updates ordinary model configuration without a Neo percentage restart', async () => {
    await db.updateSession('neo:root', {
      config: {
        ...db.getSession('neo:root')!.config,
        model: 'deepseek-v4-flash',
        provider: 'deepseek',
        thinkingLevel: 'off',
      },
    });
    await invoke('neo.preferences.set', {
      model: 'claude-opus',
      provider: 'anthropic',
      thinkingLevel: 'think8k',
      autoCompactPercent: 70,
    });
    expect(db.getSession('neo:root')?.config).toMatchObject({
      model: 'claude-opus',
      provider: 'anthropic',
      thinkingLevel: 'think8k',
    });
  });

  test('saves one preference, shows it in the snapshot and switches idle Neo sessions', async () => {
    expect(await invoke('neo.snapshot', {})).toMatchObject({
      value: { preferences: { model: 'claude-opus', provider: 'anthropic', saved: false } },
    });

    expect(
      await invoke('neo.preferences.set', {
        model: 'deepseek-v4-flash',
        provider: 'deepseek',
        thinkingLevel: 'off',
      })
    ).toMatchObject({
      value: {
        ok: true,
        preferences: { model: 'deepseek-v4-flash', provider: 'deepseek', thinkingLevel: 'off' },
      },
    });
    expect(await invoke('neo.snapshot', {})).toMatchObject({
      value: { preferences: { model: 'deepseek-v4-flash', saved: true } },
    });
    expect(switched).toEqual([['neo:root', 'deepseek-v4-flash', 'deepseek']]);
  });

  test('refuses Neo itself and models the catalog does not offer', async () => {
    expect(
      await invoke(
        'neo.preferences.set',
        { model: 'deepseek-v4-flash', provider: 'deepseek', thinkingLevel: 'off' },
        { source: 'mcp', sessionId: 'neo:root', role: 'neo' }
      )
    ).toMatchObject({ value: { ok: false, reason: 'This action needs the user.' } });
    expect(
      await invoke('neo.preferences.set', {
        model: 'gone',
        provider: 'deepseek',
        thinkingLevel: 'off',
      })
    ).toMatchObject({ value: { ok: false, reason: expect.stringContaining('invalid_model') } });
  });

  test('persists ordered fallbacks with their chosen thinking and preserves them on primary-only edits', async () => {
    const fallbacks = [
      { model: 'claude-opus', provider: 'anthropic', thinkingLevel: 'think16k' },
      { model: 'deepseek-v4-flash', provider: 'deepseek', thinkingLevel: 'think16k' },
    ];
    const first = await invoke('neo.preferences.set', {
      model: 'claude-opus',
      provider: 'anthropic',
      thinkingLevel: 'off',
      fallbacks,
    });
    const expected = fallbacks;
    expect(first).toMatchObject({ value: { ok: true, preferences: { fallbacks: expected } } });
    expect(await invoke('neo.snapshot', {})).toMatchObject({
      value: { preferences: { fallbacks: expected } },
    });
    expect(db.getGlobalSettings().neo?.preferences).toMatchObject({ fallbacks: expected });
    await invoke('neo.preferences.set', {
      model: 'claude-opus',
      provider: 'anthropic',
      thinkingLevel: 'think8k',
    });
    expect(db.getGlobalSettings().neo?.preferences).toMatchObject({ fallbacks: expected });
    expect(
      await invoke('neo.preferences.set', {
        model: 'claude-opus',
        provider: 'anthropic',
        thinkingLevel: 'off',
        fallbacks: [{ model: 'gone', provider: 'anthropic', thinkingLevel: 'off' }],
      })
    ).toMatchObject({ value: { ok: false, reason: expect.stringContaining('invalid_model') } });
    expect(db.getGlobalSettings().neo?.preferences).toMatchObject({ fallbacks: expected });
    await invoke('neo.preferences.set', {
      model: 'claude-opus',
      provider: 'anthropic',
      thinkingLevel: 'off',
      fallbacks: [],
    });
    expect(db.getGlobalSettings().neo?.preferences).toMatchObject({ fallbacks: [] });
  });

  test('stores a percentage per model and gives the Neo session the one for the model it runs', async () => {
    const result = await invoke('neo.preferences.set', {
      model: 'claude-opus',
      provider: 'anthropic',
      thinkingLevel: 'off',
      autoCompactPercent: 70,
      fallbacks: [
        {
          model: 'deepseek-v4-flash',
          provider: 'deepseek',
          thinkingLevel: 'off',
          autoCompactPercent: 101,
        },
      ],
    });
    expect(result).toMatchObject({ value: { ok: true } });
    expect(db.getGlobalSettings().neo?.preferences).toMatchObject({
      autoCompactPercent: 70,
      fallbacks: [{ model: 'deepseek-v4-flash', autoCompactPercent: 100 }],
    });
    expect(db.getSession('neo:root')?.config.autoCompactPercent).toBe(70);
    await db.updateSession('neo:root', {
      config: {
        ...db.getSession('neo:root')!.config,
        model: 'deepseek-v4-flash',
        provider: 'deepseek',
      },
    });
    switchFailure = 'refused';
    await service.saveModelPreference(db.getGlobalSettings().neo!.preferences!);
    expect(db.getSession('neo:root')?.config.autoCompactPercent).toBe(100);
    switchFailure = 'pending';
    await service.saveModelPreference(db.getGlobalSettings().neo!.preferences!);
    expect(db.getSession('neo:root')?.config).toMatchObject({
      model: 'deepseek-v4-flash',
      autoCompactPercent: 70,
    });
  });

  test('a mid-run switch to a fallback gives the Neo session that model percentage', async () => {
    await invoke('neo.preferences.set', {
      model: 'claude-opus',
      provider: 'anthropic',
      thinkingLevel: 'off',
      autoCompactPercent: 70,
      fallbacks: [
        {
          model: 'deepseek-v4-flash',
          provider: 'deepseek',
          thinkingLevel: 'off',
          autoCompactPercent: 80,
        },
      ],
    });
    expect(db.getSession('neo:root')?.config.autoCompactPercent).toBe(70);
    const config = {
      ...db.getSession('neo:root')!.config,
      model: 'deepseek-v4-flash',
      provider: 'deepseek' as const,
    };
    await db.updateSession('neo:root', { config });
    await events.publish('session.updated', {
      sessionId: 'neo:root',
      source: 'status',
      session: { config },
    });
    expect(db.getSession('neo:root')?.config.autoCompactPercent).toBe(70);
    await events.publish('session.updated', {
      sessionId: 'neo:root',
      source: 'model-switch',
      session: { config },
    });
    expect(db.getSession('neo:root')?.config.autoCompactPercent).toBe(80);
    const back = { ...config, model: 'claude-opus', provider: 'anthropic' as const };
    await db.updateSession('neo:root', { config: back });
    await events.publish('session.updated', {
      sessionId: 'neo:root',
      source: 'model-refusal-fallback',
      session: { config: back },
    });
    expect(db.getSession('neo:root')?.config.autoCompactPercent).toBe(70);
  });

  test('a new Neo session starts on the preference, thinking included', async () => {
    await invoke('neo.preferences.set', {
      model: 'claude-opus',
      provider: 'anthropic',
      thinkingLevel: 'think8k',
    });
    db.getDatabase().exec('DELETE FROM neo_session_bindings');
    await service.open();
    expect(created).toEqual([
      expect.objectContaining({
        config: expect.objectContaining({
          model: 'claude-opus',
          provider: 'anthropic',
          thinkingLevel: 'think8k',
        }),
      }),
    ]);
  });

  test.each(['refused', 'throws', 'pending'] as const)(
    'preserves the fallback model/thinking pair when primary restoration %s',
    async (failure) => {
      const fallback = {
        model: 'glm-5',
        provider: 'glm' as const,
        thinkingLevel: 'think8k' as const,
      };
      await db.updateSession('neo:root', {
        config: { ...db.getSession('neo:root')!.config, ...fallback },
      });
      switchFailure = failure;
      await service.saveModelPreference({
        model: 'claude-opus',
        provider: 'anthropic',
        thinkingLevel: 'think24k',
      });
      expect(switched).toEqual([['neo:root', 'claude-opus', 'anthropic']]);
      expect(db.getSession('neo:root')?.config).toMatchObject(fallback);
      expect(updated).toHaveLength(2);
      expect(db.getGlobalSettings().neo?.preferences).toMatchObject({
        model: 'claude-opus',
        thinkingLevel: 'think24k',
      });
      if (failure === 'pending') {
        switchFailure = 'refused';
        await service.saveModelPreference({
          model: 'claude-opus',
          provider: 'anthropic',
          thinkingLevel: 'think24k',
        });
        expect(db.getSession('neo:root')?.config).toMatchObject(fallback);
        switchFailure = undefined;
        await service.saveModelPreference({
          model: 'claude-opus',
          provider: 'anthropic',
          thinkingLevel: 'think24k',
        });
        expect(db.getSession('neo:root')?.config).toMatchObject({
          model: 'claude-opus',
          provider: 'anthropic',
          thinkingLevel: 'think24k',
        });
      }
    }
  );

  test('does not realign a fallback while its retried input is active, then realigns after recovery', async () => {
    recovering = true;
    const preference = { model: 'deepseek-v4-flash', provider: 'deepseek', thinkingLevel: 'off' };
    await invoke('neo.preferences.set', preference);
    expect(switched).toEqual([]);
    recovering = false;
    await invoke('neo.preferences.set', preference);
    expect(switched).toEqual([['neo:root', 'deepseek-v4-flash', 'deepseek']]);
  });

  test('saves a fallback again unchanged after a forced refresh lists it under its remote id', async () => {
    const glm = { provider: 'glm', alias: 'glm-5.3', thinkingModes: 'on', available: true };
    setModelsCache(
      new Map([['global', [flash, opus, { ...glm, id: 'glm-5.3[1m]' } as ModelInfo]]])
    );
    const preference = {
      model: 'claude-opus',
      provider: 'anthropic',
      thinkingLevel: 'off',
      fallbacks: [{ model: 'glm-5.3[1m]', provider: 'glm', thinkingLevel: 'off' as const }],
    };
    expect(await invoke('neo.preferences.set', preference)).toMatchObject({
      value: { ok: true },
    });
    setModelsCache(new Map([['global', [flash, opus, { ...glm, id: 'glm-5.3' } as ModelInfo]]]));
    const saved = db.getGlobalSettings().neo?.preferences;
    expect(
      await invoke('neo.preferences.set', { ...saved, thinkingLevel: 'think8k' })
    ).toMatchObject({ value: { ok: true } });
    expect(db.getGlobalSettings().neo?.preferences?.fallbacks).toEqual(preference.fallbacks);
  });
});
