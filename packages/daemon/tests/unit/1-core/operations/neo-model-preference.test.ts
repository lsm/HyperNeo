import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessageHub, ModelInfo } from '@hyperneo/shared';
import { setModelsCache } from '../../../../src/lib/model-service.ts';
import {
  clampNeoThinking,
  effectiveNeoPreference,
  planNeoAlignment,
  requireNeoPreferenceModel,
  requireNeoUser,
} from '../../../../src/lib/neo/model-preference.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
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
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const user: OperationCaller = { source: 'rpc', principal: 'local' };
const flash = {
  id: 'deepseek-v4-flash',
  provider: 'deepseek',
  thinkingModes: 'on',
  available: true,
} as ModelInfo;
const opus = {
  id: 'claude-opus',
  provider: 'anthropic',
  thinkingModes: 'granular',
  effortLevels: ['low', 'medium', 'high'],
  available: true,
} as ModelInfo;

describe('clampNeoThinking', () => {
  test.each<
    [
      string,
      Parameters<typeof clampNeoThinking>[0],
      Parameters<typeof clampNeoThinking>[1],
      ReturnType<typeof clampNeoThinking>,
    ]
  >([
    ['a supported level', ['off', 'think8k', 'think16k'], 'think16k', 'think16k'],
    [
      'the highest level below an unsupported one',
      ['off', 'think8k', 'think32k'],
      'think16k',
      'think8k',
    ],
    ['off for a model without thinking', [], 'think32k', 'off'],
  ])('keeps %s', (_case, levels, requested, clamped) => {
    expect(clampNeoThinking(levels, requested)).toBe(clamped);
  });
});

describe('requireNeoPreferenceModel', () => {
  test('refuses a model the catalog does not offer and clamps thinking to the model', () => {
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
      value: { model: 'deepseek-v4-flash', provider: 'deepseek', thinkingLevel: 'off' },
    });
  });
});

describe('requireNeoUser', () => {
  test('admits only the local user', () => {
    expect(requireNeoUser(user)).toEqual({ value: user });
    expect(requireNeoUser({ source: 'mcp', sessionId: 'neo:root', role: 'neo' })).toMatchObject({
      reason: { ok: false },
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
  let service: NeoService;
  let switched: unknown[];
  let updated: unknown[];
  let created: unknown[];

  beforeEach(async () => {
    db = await createTestDb();
    const root = createTestSession('neo:root');
    db.createSession({
      ...root,
      config: { ...root.config, model: 'claude-opus', provider: 'anthropic' },
    });
    setModelsCache(new Map([['global', [flash, opus]]]));
    switched = [];
    updated = [];
    created = [];
    const sessions = {
      getSessionForControl: async (sessionId: string) => ({
        handleModelSwitch: async (model: string, provider: string, nonInterrupting: boolean) => {
          switched.push([sessionId, model, provider, nonInterrupting]);
          return { success: true, model };
        },
        getSessionData: () => db.getSession(sessionId),
      }),
      updateSession: async (sessionId: string, updates: unknown) => {
        updated.push([sessionId, updates]);
      },
      createSession: async (params: unknown) => {
        created.push(params);
      },
    };
    service = new NeoService(
      db,
      sessions as unknown as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    service.repo.reserveBinding({ sessionId: 'neo:root', kind: 'neo', concernId: null });
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
    expect(switched).toEqual([['neo:root', 'deepseek-v4-flash', 'deepseek', true]]);
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

  test('a new topic session starts on the preference, thinking included', async () => {
    await invoke('neo.preferences.set', {
      model: 'claude-opus',
      provider: 'anthropic',
      thinkingLevel: 'think8k',
    });
    service.repo.saveConcern({ id: 'garden', title: 'Garden', summary: '', context: '' }, 0);
    await service.open('garden');
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
});
