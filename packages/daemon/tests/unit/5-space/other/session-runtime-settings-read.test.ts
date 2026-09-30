import { describe, expect, test } from 'bun:test';
import type { Session } from '@hyperneo/shared';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';
import {
  classifySessionOwnership,
  createSessionRuntimeSettingsReadOperations,
  type RuntimeSettingsReadDependencies,
  type SessionOwnership,
} from '../../../../src/lib/session/runtime-settings-read-operation';
import {
  createOperationRegistry,
  type OperationCaller,
  type OperationDefinition,
} from '../../../../src/lib/operations/registry';
import { listOperationSummaries } from '../../../../src/lib/operations/discovery';

const worktree = { worktreePath: '/w' } as Session['worktree'];
const inSpace = (spaceId: string) => ({ spaceId }) as Session['context'];
const spaceId = (session: Session) =>
  (session.context as { spaceId?: string } | undefined)?.spaceId;

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
  operations: Map<string, OperationDefinition>;
  getSessionCalls: string[];
}

function makeLiveSession(
  h: Harness,
  id: string,
  queryActive: boolean,
  status = 'idle'
): AgentSession {
  if (!h.sessions.has(id)) h.sessions.set(id, makeSession({ id }));
  return {
    getSessionData: () => h.sessions.get(id) as Session,
    isQueryActiveOrStarting: () => queryActive,
    getProcessingState: () => ({ status }),
  } as unknown as AgentSession;
}

function harness(): Harness {
  const h: Harness = {
    sessions: new Map(),
    live: new Map(),
    operations: new Map(),
    getSessionCalls: [],
  };
  const deps: RuntimeSettingsReadDependencies = {
    getLiveSession: (id) => h.live.get(id) ?? null,
    getSession: (id) => {
      h.getSessionCalls.push(id);
      return h.sessions.get(id) ?? null;
    },
    sessionSpaceId: spaceId,
  };
  for (const op of createSessionRuntimeSettingsReadOperations(deps)) h.operations.set(op.name, op);
  return h;
}

const RPC_CALLER: OperationCaller = { source: 'rpc' };
const agent = (spaceId?: string, role: OperationCaller['role'] = 'long_term_agent') =>
  ({ source: 'mcp', sessionId: 'caller-1', role, spaceId }) as OperationCaller;

async function read(
  h: Harness,
  id: string,
  caller: OperationCaller = RPC_CALLER
): Promise<Record<string, unknown>> {
  const op = h.operations.get('session.runtimeSettings.read');
  if (!op) throw new Error('missing session.runtimeSettings.read');
  return (await op.execute({ sessionId: id }, caller)) as Record<string, unknown>;
}

const settingsOf = (result: Record<string, unknown>) => result.settings as Record<string, unknown>;

describe('classifySessionOwnership', () => {
  test('attributes every ownership type', () => {
    const cases: Array<[Partial<Session>, SessionOwnership]> = [
      [{ id: 'plain' }, 'ordinary'],
      [{ id: 'proj', worktree }, 'project'],
      [{ id: 'w:task:1', type: 'space_task_agent' }, 'space-task'],
      [{ id: 'agent-1', context: inSpace('space-1') }, 'space-agent'],
      [{ id: 'neo:root' }, 'neo'],
    ];
    for (const [overrides, ownership] of cases) {
      expect(classifySessionOwnership(makeSession(overrides), spaceId)).toBe(ownership);
    }
  });

  test('applies the documented precedence when several markers match', () => {
    const cases: Array<[Partial<Session>, SessionOwnership]> = [
      [{ id: 'neo:abc', type: 'space_task_agent', worktree, context: inSpace('s') }, 'neo'],
      [{ id: 'w:task:9', type: 'space_task_agent', worktree, context: inSpace('s') }, 'space-task'],
      [{ id: 'agent-2', worktree, context: inSpace('s') }, 'project'],
    ];
    for (const [overrides, ownership] of cases) {
      expect(classifySessionOwnership(makeSession(overrides), spaceId)).toBe(ownership);
    }
  });
});

describe('session.runtimeSettings.read', () => {
  test('reads a cold session from storage with no live query and mutates nothing', async () => {
    const h = harness();
    h.sessions.set('plain', makeSession({ id: 'plain' }));
    const before = structuredClone(h.sessions.get('plain') as Session);
    expect(settingsOf(await read(h, 'plain'))).toMatchObject({
      sessionId: 'plain',
      ownership: 'ordinary',
      live: false,
      queryActive: false,
      model: 'claude-sonnet-5',
      provider: 'anthropic',
      thinkingLevel: null,
    });
    expect(h.sessions.get('plain')).toEqual(before);
  });

  test('reports the thinking options the provider supports', async () => {
    const h = harness();
    const withProvider = (id: string, provider: string) =>
      makeSession({ id, config: { model: 'm', provider, maxTokens: 1, temperature: 0 } });
    h.sessions.set('copilot', withProvider('copilot', 'anthropic-copilot'));
    h.sessions.set('haiku', withProvider('haiku', 'anthropic'));
    expect(settingsOf(await read(h, 'copilot')).thinkingOptions).toEqual([]);
    expect(settingsOf(await read(h, 'haiku')).thinkingOptions).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: 'think32k' })])
    );
  });

  test('reports query activity from the query itself, not the processing status', async () => {
    const h = harness();
    h.live.set('idle-but-running', makeLiveSession(h, 'idle-but-running', true, 'idle'));
    expect(settingsOf(await read(h, 'idle-but-running'))).toMatchObject({
      live: true,
      queryActive: true,
    });
    h.live.set('busy-but-idle', makeLiveSession(h, 'busy-but-idle', false, 'processing'));
    expect(settingsOf(await read(h, 'busy-but-idle'))).toMatchObject({
      live: true,
      queryActive: false,
    });
  });

  test('never mutates the session it reads', async () => {
    const h = harness();
    h.sessions.set('plain', makeSession({ id: 'plain' }));
    const before = structuredClone(h.sessions.get('plain') as Session);
    await read(h, 'plain');
    expect(h.sessions.get('plain')).toEqual(before);
  });

  test('reports session_not_found for an unknown session', async () => {
    expect(await read(harness(), 'missing')).toEqual({ ok: false, reason: 'session_not_found' });
  });
});

describe('caller admission', () => {
  const seed = () => {
    const h = harness();
    h.sessions.set('mine', makeSession({ id: 'mine', context: inSpace('space-a') }));
    h.sessions.set('theirs', makeSession({ id: 'theirs', context: inSpace('space-b') }));
    h.sessions.set('unowned', makeSession({ id: 'unowned' }));
    return h;
  };

  test('an agent reads a session inside its own Space', async () => {
    expect(settingsOf(await read(seed(), 'mine', agent('space-a')))).toMatchObject({
      ownership: 'space-agent',
      model: 'claude-sonnet-5',
    });
  });

  test('a foreign Space session and a missing session are indistinguishable', async () => {
    const h = seed();
    const foreign = await read(h, 'theirs', agent('space-a'));
    const missing = await read(h, 'ghost', agent('space-a'));
    expect(foreign).toEqual({ ok: false, reason: 'session_not_found' });
    expect(foreign).toEqual(missing);
    expect(foreign).not.toHaveProperty('settings');
  });

  test('a session owned by no Space is refused to a Space-scoped agent', async () => {
    expect(await read(seed(), 'unowned', agent('space-a'))).toEqual({
      ok: false,
      reason: 'session_not_found',
    });
  });

  test('an agent with no resolved Space is refused without probing the target', async () => {
    const h = seed();
    const result = await read(h, 'mine', agent(undefined));
    expect(result).toEqual({ ok: false, reason: 'space_scope_required' });
    expect(h.getSessionCalls).toEqual([]);
  });

  test('a claimed spaceId in the payload is not read as authorization', async () => {
    const h = seed();
    const op = h.operations.get('session.runtimeSettings.read');
    if (!op) throw new Error('missing session.runtimeSettings.read');
    const result = (await op.execute(
      { sessionId: 'theirs', spaceId: 'space-b' },
      agent('space-a')
    )) as Record<string, unknown>;
    expect(result).toEqual({ ok: false, reason: 'session_not_found' });
  });

  test('Neo and local callers keep inventory access to any session', async () => {
    for (const caller of [
      { source: 'mcp', role: 'neo', sessionId: 'neo:root' } as OperationCaller,
      { source: 'rpc' } as OperationCaller,
      { source: 'internal' } as OperationCaller,
    ]) {
      expect(settingsOf(await read(seed(), 'theirs', caller))).toMatchObject({
        ownership: 'space-agent',
        model: 'claude-sonnet-5',
      });
    }
  });
});

describe('Neo discoverability', () => {
  test('a Neo caller discovers and invokes the read through the operations door', async () => {
    const h = harness();
    h.sessions.set('neo:root', makeSession({ id: 'neo:root' }));
    const registry = createOperationRegistry([...h.operations.values()]);
    const caller = { source: 'mcp', sessionId: 'neo:root', role: 'neo' } as const;
    expect(listOperationSummaries(registry, caller).map((entry) => entry.name)).toContain(
      'session.runtimeSettings.read'
    );
    const op = registry.get('session.runtimeSettings.read');
    if (!op) throw new Error('missing session.runtimeSettings.read');
    const result = (await op.execute({ sessionId: 'neo:root' }, caller)) as Record<string, unknown>;
    expect(settingsOf(result)).toMatchObject({ ownership: 'neo', live: false, queryActive: false });
  });
});
