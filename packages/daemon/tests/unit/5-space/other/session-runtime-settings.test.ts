import { beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { Session, SessionConfig } from '@hyperneo/shared';
import type { ModelInfo } from '@hyperneo/shared';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';
import type { RuntimeSettingsCommit } from '../../../../src/lib/agent/model-switch-handler';
import type {
  SessionRuntimeSettingsSnapshot,
  RuntimeSettingsPatch,
} from '../../../../src/storage/repositories/session-runtime-settings-write';
import { createSessionRuntimeSettingsOperations } from '../../../../src/lib/session/runtime-settings-operations';
import {
  createOperationRegistry,
  type OperationDefinition,
} from '../../../../src/lib/operations/registry';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { listOperationSummaries } from '../../../../src/lib/operations/discovery';

const { catalog, curatedOut } = vi.hoisted(() => ({
  catalog: vi.fn(() => [] as ModelInfo[]),
  curatedOut: vi.fn((model: string) => model.endsWith('-hidden')),
}));

vi.mock('../../../../src/lib/model-service.ts', () => ({
  getAvailableModels: () => catalog(),
  isCuratedOutModel: (_model: string, _provider: string) => curatedOut(_model),
}));

function model(id: string, provider = 'anthropic'): ModelInfo {
  return {
    id,
    name: id,
    alias: '',
    family: provider,
    provider,
    contextWindow: 200000,
    description: '',
    releaseDate: '',
    available: true,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'target-1',
    type: 'space_chat',
    status: 'active',
    config: { model: 'claude-sonnet-5', provider: 'anthropic', maxTokens: 8192, temperature: 0 },
    metadata: {},
    ...overrides,
  } as unknown as Session;
}

interface Harness {
  sessions: Map<string, Session>;
  live: Map<string, AgentSession>;
  persisted: Map<string, SessionConfig>;
  switched: Array<{ model: string; provider: string }>;
  liveConfigs: Array<Partial<SessionConfig>>;
  operations: Map<string, OperationDefinition>;
  commit: (
    snapshot: SessionRuntimeSettingsSnapshot,
    patch: RuntimeSettingsPatch
  ) => 'won' | 'superseded';
}

function makeLiveSession(h: Harness, sessionId: string, status: string): AgentSession {
  const session = h.sessions.get(sessionId) ?? makeSession({ id: sessionId });
  h.sessions.set(sessionId, session);
  return {
    getSessionData: () => h.sessions.get(sessionId) as Session,
    getProcessingState: () => ({ status }),
    isQueryActiveOrStarting: () => status !== 'idle',
    handleModelSwitch: async (
      model: string,
      provider: string,
      nonInterrupting: boolean,
      commit: RuntimeSettingsCommit
    ) => {
      expect(nonInterrupting).toBe(true);
      expect(commit.isCurrentOwner?.()).toBe(true);
      expect(
        h.commit(commit.snapshot, { model, provider, thinkingLevel: commit.thinkingLevel })
      ).toBe('won');
      h.switched.push({ model, provider });
      const current = h.sessions.get(sessionId) as Session;
      h.sessions.set(sessionId, {
        ...current,
        config: { ...current.config, model, provider: provider as SessionConfig['provider'] },
      });
      return { success: true, model };
    },
    updateConfig: async (updates: Partial<SessionConfig>) => {
      h.liveConfigs.push(updates);
      const current = h.sessions.get(sessionId) as Session;
      h.sessions.set(sessionId, { ...current, config: { ...current.config, ...updates } });
    },
  } as unknown as AgentSession;
}

function harness(): Harness {
  const h: Harness = {
    sessions: new Map(),
    live: new Map(),
    persisted: new Map(),
    switched: [],
    liveConfigs: [],
    operations: new Map(),
    commit: (snapshot, patch) => {
      const current = h.sessions.get(snapshot.id);
      if (!current || JSON.stringify(current.config) !== snapshot.config) return 'superseded';
      const config = { ...current.config };
      if (patch.model !== undefined) config.model = patch.model;
      if (patch.provider !== undefined)
        config.provider = patch.provider as SessionConfig['provider'];
      if (patch.thinkingLevel !== undefined)
        config.thinkingLevel = patch.thinkingLevel as SessionConfig['thinkingLevel'];
      h.persisted.set(snapshot.id, config);
      h.sessions.set(snapshot.id, { ...current, config });
      return 'won';
    },
  };
  const ops = createSessionRuntimeSettingsOperations({
    getLiveSession: (sessionId) => h.live.get(sessionId) ?? null,
    getSession: (sessionId) => h.sessions.get(sessionId) ?? null,
    sessionSpaceId: (session) =>
      (session.context as { spaceId?: string } | undefined)?.spaceId ?? undefined,
    capture: (id) => {
      const session = h.sessions.get(id);
      return session
        ? {
            id,
            incarnation: 1,
            config: JSON.stringify(session.config),
            metadata: '{}',
            sessionContext: null,
            status: session.status,
            type: session.type ?? 'space_chat',
            archivedAt: null,
            processingState: null,
            parentId: null,
            workspacePath: null,
            isWorktree: 0,
            worktreePath: null,
            mainRepoPath: null,
            worktreeBranch: null,
            sdkSessionId: null,
            acpSessionId: null,
            sdkOriginPath: null,
          }
        : null;
    },
    commit: (snapshot, patch) => h.commit(snapshot, patch),
    isPreparing: () => false,
    hasPendingWork: () => false,
    notify: async () => {},
  });
  for (const op of ops) h.operations.set(op.name, op);
  return h;
}

async function run(h: Harness, name: string, input: unknown) {
  const op = h.operations.get(name);
  if (!op) throw new Error(`missing ${name}`);
  return (await op.execute(input, { source: 'rpc' })) as Record<string, unknown>;
}

beforeEach(() => {
  catalog.mockReturnValue([
    model('claude-sonnet-5'),
    model('claude-opus-5'),
    model('claude-haiku-4-5'),
  ]);
  curatedOut.mockImplementation((m: string) => m.endsWith('-hidden'));
});

describe('session.runtimeSettings.read', () => {
  test('classifies every ownership type and reports live state', async () => {
    const h = harness();
    h.sessions.set('plain', makeSession({ id: 'plain' }));
    h.sessions.set(
      'project',
      makeSession({
        id: 'project',
        worktree: { isWorktree: true, worktreePath: '/w', mainRepoPath: '/r', branch: 'b' },
      })
    );
    h.sessions.set('task', makeSession({ id: 'x:task:1', type: 'space_task_agent' }));
    h.sessions.set(
      'agent-1',
      makeSession({ id: 'agent-1', context: { spaceId: 'space-1' } as Session['context'] })
    );
    h.sessions.set('neo:root', makeSession({ id: 'neo:root' }));
    h.live.set('agent-1', makeLiveSession(h, 'agent-1', 'processing'));

    for (const [id, ownership] of [
      ['plain', 'ordinary'],
      ['project', 'project'],
      ['task', 'space-task'],
      ['agent-1', 'space-agent'],
      ['neo:root', 'neo'],
    ] as const) {
      const result = await run(h, 'session.runtimeSettings.read', { sessionId: id });
      expect(result.ok).toBe(true);
      expect((result.settings as Record<string, unknown>).ownership).toBe(ownership);
    }
    const agentResult = await run(h, 'session.runtimeSettings.read', { sessionId: 'agent-1' });
    expect((agentResult.settings as Record<string, unknown>).live).toBe(true);
    expect((agentResult.settings as Record<string, unknown>).queryActive).toBe(true);
  });

  test('fails for an unknown session', async () => {
    const h = harness();
    const result = await run(h, 'session.runtimeSettings.read', { sessionId: 'missing' });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('session_not_found');
  });
});

describe('session.runtimeSettings.update', () => {
  test('changes model on a live ordinary session through the live switch path', async () => {
    const h = harness();
    h.sessions.set('plain', makeSession({ id: 'plain' }));
    h.live.set('plain', makeLiveSession(h, 'plain', 'idle'));

    const result = await run(h, 'session.runtimeSettings.update', {
      sessionId: 'plain',
      model: 'claude-opus-5',
    });
    expect(result.ok).toBe(true);
    expect(h.switched).toEqual([{ model: 'claude-opus-5', provider: 'anthropic' }]);
    expect((result.settings as Record<string, unknown>).model).toBe('claude-opus-5');
    expect(result.appliesFrom).toBe('next-turn');
    expect(result.changes).toMatchObject({ model: true });
  });

  test('persists model and thinking level for a cold session and reports the pickup note', async () => {
    const h = harness();
    h.sessions.set('plain', makeSession({ id: 'plain' }));

    const result = await run(h, 'session.runtimeSettings.update', {
      sessionId: 'plain',
      model: 'claude-haiku-4-5',
      thinkingLevel: 'think16k',
    });
    expect(result.ok).toBe(true);
    expect(h.persisted.get('plain')).toMatchObject({
      model: 'claude-haiku-4-5',
      thinkingLevel: 'think16k',
    });
    expect((result.notes as string[]).join(' ')).toContain('starts under it next time');
    expect(result.appliesFrom).toBe('next-turn');
  });

  test('a running turn refuses settings without entering the native switch', async () => {
    const h = harness();
    h.sessions.set('plain', makeSession({ id: 'plain' }));
    h.live.set('plain', makeLiveSession(h, 'plain', 'processing'));

    const result = await run(h, 'session.runtimeSettings.update', {
      sessionId: 'plain',
      model: 'claude-opus-5',
    });
    expect(result).toMatchObject({ ok: false, reason: 'session_busy' });
    expect(h.switched).toHaveLength(0);
    expect(h.persisted.size).toBe(0);
    expect(h.sessions.get('plain')?.config.model).toBe('claude-sonnet-5');
  });

  test('invalid model fails with the valid catalog ids listed', async () => {
    const h = harness();
    h.sessions.set('plain', makeSession({ id: 'plain' }));
    const result = await run(h, 'session.runtimeSettings.update', {
      sessionId: 'plain',
      model: 'gpt-not-here',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('invalid_model');
    expect(result.availableModels).toEqual([
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-haiku-4-5',
    ]);
  });

  test('curated-out models are refused with the curated list', async () => {
    const h = harness();
    catalog.mockReturnValue([model('claude-sonnet-5'), model('claude-secret-hidden')]);
    h.sessions.set('plain', makeSession({ id: 'plain' }));
    const result = await run(h, 'session.runtimeSettings.update', {
      sessionId: 'plain',
      model: 'claude-secret-hidden',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('curated_out');
    expect(result.availableModels).toEqual(['claude-sonnet-5']);
  });

  test('empty catalog degrades to a stated catalog_unavailable error', async () => {
    const h = harness();
    catalog.mockReturnValue([]);
    h.sessions.set('plain', makeSession({ id: 'plain' }));
    const result = await run(h, 'session.runtimeSettings.update', {
      sessionId: 'plain',
      model: 'claude-sonnet-5',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('catalog_unavailable');
  });

  test('thinking level on a provider without thinking controls records a stated no-op', async () => {
    const h = harness();
    h.sessions.set(
      'plain',
      makeSession({
        id: 'plain',
        config: {
          model: 'm',
          provider: 'anthropic-copilot',
          maxTokens: 1,
          temperature: 0,
        } as SessionConfig,
      })
    );
    h.live.set('plain', makeLiveSession(h, 'plain', 'idle'));
    const result = await run(h, 'session.runtimeSettings.update', {
      sessionId: 'plain',
      thinkingLevel: 'think32k',
    });
    expect(result.ok).toBe(true);
    expect((result.notes as string[]).join(' ')).toContain('no-op');
    expect(h.persisted.get('plain')).toMatchObject({ thinkingLevel: 'think32k' });
    expect(h.liveConfigs).toHaveLength(0);
  });

  test('thinking level normalizes unknown values to off', async () => {
    const h = harness();
    h.sessions.set('plain', makeSession({ id: 'plain' }));
    const result = await run(h, 'session.runtimeSettings.update', {
      sessionId: 'plain',
      thinkingLevel: 'maximum',
    });
    expect(result.ok).toBe(true);
    expect((result.settings as Record<string, unknown>).thinkingLevel).toBe('off');
  });

  test('provider-only updates use the non-interrupting joint switch', async () => {
    const h = harness();
    h.sessions.set('plain', makeSession({ id: 'plain' }));
    h.live.set('plain', makeLiveSession(h, 'plain', 'idle'));
    const result = await run(h, 'session.runtimeSettings.update', {
      sessionId: 'plain',
      provider: 'anthropic',
    });
    expect(result.ok).toBe(true);
    expect(h.switched).toEqual([{ model: 'claude-sonnet-5', provider: 'anthropic' }]);
    expect(h.liveConfigs).toHaveLength(0);
  });

  test('refuses an empty update and an unknown session', async () => {
    const h = harness();
    h.sessions.set('plain', makeSession({ id: 'plain' }));
    const empty = await run(h, 'session.runtimeSettings.update', { sessionId: 'plain' });
    expect(empty.ok).toBe(false);
    expect(empty.reason).toContain('nothing_to_update');
    const missing = await run(h, 'session.runtimeSettings.update', {
      sessionId: 'nope',
      model: 'claude-opus-5',
    });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toContain('session_not_found');
  });

  test('an unknown provider is refused by the input schema before anything is written', async () => {
    const h = harness();
    h.sessions.set('plain', makeSession({ id: 'plain' }));
    h.live.set('plain', makeLiveSession(h, 'plain', 'idle'));
    const registry = createOperationRegistry([...h.operations.values()]);
    const outcome = await invokeOperation(
      registry,
      'session.runtimeSettings.update',
      { sessionId: 'plain', provider: 'not-a-provider' },
      { source: 'mcp', sessionId: 'plain', role: 'neo' }
    );
    expect(outcome).toMatchObject({ kind: 'failed', code: 'invalid_input' });
    expect(h.liveConfigs).toHaveLength(0);
    expect(h.switched).toHaveLength(0);
  });

  test('a provider-only change refuses a model curated out for the target provider', async () => {
    const h = harness();
    h.sessions.set(
      'plain',
      makeSession({
        id: 'plain',
        config: {
          model: 'claude-secret-hidden',
          provider: 'anthropic-copilot',
          maxTokens: 1,
          temperature: 0,
        } as SessionConfig,
      })
    );
    h.live.set('plain', makeLiveSession(h, 'plain', 'idle'));
    const result = await run(h, 'session.runtimeSettings.update', {
      sessionId: 'plain',
      provider: 'anthropic',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('curated_out');
    expect(h.liveConfigs).toHaveLength(0);
  });

  test('a provider-only change on a cold session is checked against the effective pair', async () => {
    const h = harness();
    h.sessions.set(
      'plain',
      makeSession({
        id: 'plain',
        config: {
          model: 'claude-secret-hidden',
          provider: 'anthropic-copilot',
          maxTokens: 1,
          temperature: 0,
        } as SessionConfig,
      })
    );
    const result = await run(h, 'session.runtimeSettings.update', {
      sessionId: 'plain',
      provider: 'openrouter',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('curated_out');
    expect(h.persisted.has('plain')).toBe(false);
  });

  test('re-affirming the pair the session already runs is allowed', async () => {
    const h = harness();
    catalog.mockReturnValue([model('claude-secret-hidden')]);
    h.sessions.set(
      'plain',
      makeSession({
        id: 'plain',
        config: {
          model: 'claude-secret-hidden',
          provider: 'anthropic',
          maxTokens: 1,
          temperature: 0,
        } as SessionConfig,
      })
    );
    h.live.set('plain', makeLiveSession(h, 'plain', 'idle'));
    const result = await run(h, 'session.runtimeSettings.update', {
      sessionId: 'plain',
      provider: 'anthropic',
    });
    expect(result.ok).toBe(true);
    expect(h.switched).toEqual([{ model: 'claude-secret-hidden', provider: 'anthropic' }]);
  });
});

describe('Neo discoverability', () => {
  test('operations.list offers both runtime settings operations to a Neo caller', () => {
    const h = harness();
    const registry = createOperationRegistry([...h.operations.values()]);
    const names = listOperationSummaries(registry, {
      source: 'mcp',
      sessionId: 'neo:root',
      role: 'neo',
    }).map((entry) => entry.name);
    expect(names).toContain('session.runtimeSettings.read');
    expect(names).toContain('session.runtimeSettings.update');
  });

  test('the read result passes the operation result schema through the door', async () => {
    const h = harness();
    h.sessions.set('neo:root', makeSession({ id: 'neo:root' }));
    const registry = createOperationRegistry([...h.operations.values()]);
    const outcome = await invokeOperation(
      registry,
      'session.runtimeSettings.read',
      { sessionId: 'neo:root' },
      { source: 'mcp', sessionId: 'neo:root', role: 'neo' }
    );
    expect(outcome).toMatchObject({
      kind: 'completed',
      value: { ok: true, settings: { ownership: 'neo' } },
    });
  });
});
