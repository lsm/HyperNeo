import { describe, expect, mock, test } from 'bun:test';
import type { Session, Space } from '@hyperneo/shared';
import {
  createSpawnSessionCloneOperation,
  type SpawnSessionCloneDependencies,
} from '../../../../src/lib/session/clone-operations';
import type { OperationCallerRole } from '../../../../src/lib/operations/registry';
import type { CreateSessionParams } from '../../../../src/lib/session/session-lifecycle';
import type { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';

function makeSession(overrides: Partial<Session> = {}): Session {
  const now = new Date().toISOString();
  return {
    id: 'parent',
    title: 'Parent',
    workspacePath: '/repo',
    createdAt: now,
    lastActiveAt: now,
    status: 'active',
    type: 'worker',
    config: { model: 'claude-sonnet-5', thinkingLevel: 'think8k', systemPrompt: 'be kind' },
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
    },
    parentSessionId: null,
    ...overrides,
  } as Session;
}

interface Harness {
  sessions: Map<string, Session>;
  space: Space | null;
  role: OperationCallerRole;
  isGit: boolean;
  created: CreateSessionParams[];
  memberships: string[];
  attached: string[];
  enqueued: unknown[];
  deps: SpawnSessionCloneDependencies;
}

function makeHarness(overrides: Partial<Harness> = {}): Harness {
  const h: Harness = {
    sessions: new Map([['parent', makeSession()]]),
    space: { id: 'space-1', status: 'active', paused: false, stopped: false } as Space,
    role: 'universal_read',
    isGit: true,
    created: [],
    memberships: [],
    attached: [],
    enqueued: [],
    deps: {} as SpawnSessionCloneDependencies,
    ...overrides,
  };
  h.deps = {
    getSession: (id) => h.sessions.get(id) ?? null,
    getSpace: async () => h.space,
    resolveRole: () => h.role,
    isGitRepo: async () => h.isGit,
    createSession: async (params) => {
      h.created.push(params);
      return 'child';
    },
    addSpaceSession: async (_spaceId, sessionId) => {
      h.memberships.push(sessionId);
    },
    attachSpaceTools: async (sessionId) => {
      h.attached.push(sessionId);
    },
    jobQueue: {
      enqueueUniquePending: mock((job: unknown) => {
        h.enqueued.push(job);
        return { id: 'job-1' };
      }),
    } as unknown as JobQueueRepository,
  };
  return h;
}

function run(h: Harness, input: Record<string, unknown>, caller = { source: 'mcp' as const }) {
  return createSpawnSessionCloneOperation(h.deps).execute(input, {
    ...caller,
    ...('sessionId' in caller ? {} : caller.source === 'mcp' ? { sessionId: 'parent' } : {}),
  });
}

describe('session.clone.spawn', () => {
  test('an MCP caller clones its own session', async () => {
    const h = makeHarness();
    const result = await run(h, {});
    expect(result).toEqual({ accepted: true, sessionId: 'child' });
    expect(h.created[0]).toMatchObject({
      parentSessionId: 'parent',
      workspacePath: '/repo',
      worktreeMode: 'worktree',
      title: 'Parent · 分身',
      config: { model: 'claude-sonnet-5', thinkingLevel: 'think8k', systemPrompt: 'be kind' },
    });
    expect(h.memberships).toEqual([]);
    expect(h.attached).toEqual([]);
    expect(h.enqueued).toEqual([]);
  });

  test('an MCP caller naming another parent is denied', async () => {
    const h = makeHarness();
    const result = await run(h, { parentSessionId: 'other' });
    expect(result).toMatchObject({ accepted: false, reason: 'caller_denied' });
    expect(h.created).toEqual([]);
  });

  test('an RPC caller must name the parent', async () => {
    const h = makeHarness();
    expect(await run(h, {}, { source: 'rpc' })).toMatchObject({
      accepted: false,
      reason: 'parent_required',
    });
    expect(await run(h, { parentSessionId: 'parent' }, { source: 'rpc' })).toEqual({
      accepted: true,
      sessionId: 'child',
    });
  });

  test('a missing parent is parent_not_found', async () => {
    const h = makeHarness();
    expect(await run(h, { parentSessionId: 'ghost' }, { source: 'rpc' })).toMatchObject({
      reason: 'parent_not_found',
    });
  });

  test('a clone cannot spawn a clone', async () => {
    const h = makeHarness();
    h.sessions.set('parent', makeSession({ parentSessionId: 'root' }));
    expect(await run(h, {})).toMatchObject({ reason: 'nested_clone' });
  });

  test.each([
    ['archived', makeSession({ status: 'archived' })],
    ['a task worker', makeSession({ context: { spaceId: 'space-1', taskId: 'task-1' } })],
    ['a lobby', makeSession({ type: 'lobby' })],
  ])('an unavailable parent (%s) is rejected', async (_label, parent) => {
    const h = makeHarness();
    h.sessions.set('parent', parent);
    expect(await run(h, {})).toMatchObject({ reason: 'parent_unavailable' });
    expect(h.created).toEqual([]);
  });

  test('a Space parent must resolve to the agent role', async () => {
    const h = makeHarness({ role: 'workflow_worker' });
    h.sessions.set('parent', makeSession({ context: { spaceId: 'space-1' } }));
    expect(await run(h, {})).toMatchObject({ reason: 'parent_unavailable' });
  });

  test('a paused Space refuses clones', async () => {
    const h = makeHarness({ role: 'long_term_agent' });
    h.space = { ...h.space, paused: true } as Space;
    h.sessions.set('parent', makeSession({ context: { spaceId: 'space-1' } }));
    expect(await run(h, {})).toMatchObject({ reason: 'parent_unavailable' });
  });

  test('a Space agent clone joins the Space, gets its tools, then its brief', async () => {
    const h = makeHarness({ role: 'long_term_agent' });
    const provenance = { source: 'long_horizon_agent', hash: 'agent-1', agentId: 'agent-1' };
    h.sessions.set(
      'parent',
      makeSession({
        context: { spaceId: 'space-1' },
        metadata: { ...makeSession().metadata, promptProvenance: provenance },
      })
    );
    const result = await run(h, { brief: 'Investigate the flaky test.' });
    expect(result).toEqual({ accepted: true, sessionId: 'child' });
    expect(h.created[0]).toMatchObject({ spaceId: 'space-1', promptProvenance: provenance });
    expect(h.memberships).toEqual(['child']);
    expect(h.attached).toEqual(['child']);
    expect(h.enqueued).toHaveLength(1);
    const job = h.enqueued[0] as { payload: Record<string, unknown> };
    expect(job.payload).toMatchObject({
      to: { kind: 'session', sessionId: 'child' },
      origin: 'session:parent',
      messageUuid: 'clone-brief:child',
    });
    const text = JSON.stringify(job.payload.message);
    expect(text).toContain('Investigate the flaky test.');
    expect(text).toContain('session.clone.return');
  });

  test('model and thinking level overrides replace the copied values', async () => {
    const h = makeHarness();
    await run(h, { model: 'claude-opus-5-5', thinkingLevel: 'off' });
    expect(h.created[0]?.config).toMatchObject({
      model: 'claude-opus-5-5',
      thinkingLevel: 'off',
      systemPrompt: 'be kind',
    });
  });

  test('a non-git workspace is shared directly; a worktree parent clones from its main repo', async () => {
    const h = makeHarness({ isGit: false });
    await run(h, {});
    expect(h.created[0]).toMatchObject({ worktreeMode: 'direct', workspacePath: '/repo' });

    const g = makeHarness();
    g.sessions.set(
      'parent',
      makeSession({
        workspacePath: '/repo/.worktrees/parent',
        worktree: {
          isWorktree: true,
          worktreePath: '/repo/.worktrees/parent',
          mainRepoPath: '/repo',
          branch: 'session/parent',
        },
      })
    );
    await run(g, {});
    expect(g.created[0]).toMatchObject({ worktreeMode: 'worktree', workspacePath: '/repo' });
    expect(g.created[0].worktreeBaseBranch).toBe('session/parent');
  });
});
