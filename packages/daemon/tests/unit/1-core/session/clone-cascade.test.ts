import { describe, expect, test } from 'bun:test';
import type { Session, SpaceLongHorizonAgent } from '@hyperneo/shared';
import {
  createResolveClones,
  type CloneCascadeDependencies,
} from '../../../../src/lib/session/clone-cascade';

function child(id: string, title = id): Session {
  const now = new Date().toISOString();
  return {
    id,
    title,
    workspacePath: '/repo',
    createdAt: now,
    lastActiveAt: now,
    status: 'active',
    config: {},
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
    },
    parentSessionId: 'parent',
  } as Session;
}

const OWNER = {
  id: 'agent-1',
  spaceId: 'space-1',
  handle: 'lead',
  displayName: 'Lead',
  status: 'active',
  sessionId: 'parent',
  instructions: 'Be helpful.',
  autonomyLevel: 3,
  model: 'claude-sonnet-5',
  thinkingLevel: 'think8k',
  provider: 'anthropic',
  settingSources: null,
  toolPermissions: { tools: ['Read'] },
} as SpaceLongHorizonAgent;

interface Harness {
  children: Session[];
  owner: SpaceLongHorizonAgent | null;
  agents: SpaceLongHorizonAgent[];
  detached: string[];
  archived: string[];
  deleted: string[];
  created: Array<Record<string, unknown>>;
  stamped: Array<{ sessionId: string; agentId?: string; source: string }>;
  deps: CloneCascadeDependencies;
}

function makeHarness(overrides: Partial<Harness> = {}): Harness {
  const h: Harness = {
    children: [child('c1', 'First clone'), child('c2', 'Second clone')],
    owner: null,
    agents: [],
    detached: [],
    archived: [],
    deleted: [],
    created: [],
    stamped: [],
    deps: {} as CloneCascadeDependencies,
    ...overrides,
  };
  h.deps = {
    listChildren: () => h.children,
    detach: (id) => {
      h.detached.push(id);
    },
    agentOwning: () => h.owner,
    listAgents: () => h.agents,
    createAgent: (params) => {
      h.created.push(params);
      const agent = { ...OWNER, ...params, id: `agent-${h.created.length}` };
      h.agents = [...h.agents, agent];
      return agent;
    },
    stampProvenance: (sessionId, provenance) => {
      h.stamped.push({ sessionId, agentId: provenance.agentId, source: provenance.source });
    },
    archiveChild: async (id) => {
      h.archived.push(id);
    },
    deleteChild: async (id) => {
      h.deleted.push(id);
    },
  };
  return h;
}

describe('resolveClones', () => {
  test('a parent without clones needs no choice', async () => {
    const h = makeHarness({ children: [] });
    expect(await createResolveClones(h.deps)('parent', undefined, 'archive')).toBeNull();
  });

  test('a parent with clones and no choice is rejected with the clone list', async () => {
    const h = makeHarness();
    expect(await createResolveClones(h.deps)('parent', undefined, 'delete')).toEqual({
      accepted: false,
      reason: 'has_clones',
      clones: [
        { id: 'c1', title: 'First clone' },
        { id: 'c2', title: 'Second clone' },
      ],
    });
    expect(h.archived).toEqual([]);
    expect(h.deleted).toEqual([]);
  });

  test('cascade archives or deletes every clone to match the parent action', async () => {
    const a = makeHarness();
    expect(await createResolveClones(a.deps)('parent', 'cascade', 'archive')).toBeNull();
    expect(a.archived).toEqual(['c1', 'c2']);
    expect(a.deleted).toEqual([]);

    const d = makeHarness();
    expect(await createResolveClones(d.deps)('parent', 'cascade', 'delete')).toBeNull();
    expect(d.deleted).toEqual(['c1', 'c2']);
    expect(d.archived).toEqual([]);
  });

  test('flatten detaches the clones of a plain session', async () => {
    const h = makeHarness();
    expect(await createResolveClones(h.deps)('parent', 'flatten', 'archive')).toBeNull();
    expect(h.detached).toEqual(['c1', 'c2']);
    expect(h.created).toEqual([]);
  });

  test('flatten turns the clones of a Space agent into agents that own them', async () => {
    const h = makeHarness({ owner: OWNER, agents: [OWNER] });
    expect(await createResolveClones(h.deps)('parent', 'flatten', 'delete')).toBeNull();
    expect(h.created).toHaveLength(2);
    expect(h.created[0]).toMatchObject({
      spaceId: 'space-1',
      handle: 'first-clone',
      displayName: 'First clone',
      sessionId: 'c1',
      instructions: 'Be helpful.',
      model: 'claude-sonnet-5',
      toolPermissions: { tools: ['Read'] },
    });
    expect(h.stamped).toEqual([
      { sessionId: 'c1', agentId: 'agent-1', source: 'flattened_clone' },
      { sessionId: 'c2', agentId: 'agent-2', source: 'flattened_clone' },
    ]);
    expect(h.detached).toEqual(['c1', 'c2']);
    expect(h.deleted).toEqual([]);
  });

  test('flattened handles never collide with existing agents', async () => {
    const h = makeHarness({
      owner: OWNER,
      agents: [OWNER, { ...OWNER, id: 'x', handle: 'first-clone' }],
      children: [child('c1', 'First clone')],
    });
    await createResolveClones(h.deps)('parent', 'flatten', 'archive');
    expect(h.created[0]?.handle).not.toBe('first-clone');
    expect(h.created[0]?.handle).toMatch(/^first-clone/);
  });
});
