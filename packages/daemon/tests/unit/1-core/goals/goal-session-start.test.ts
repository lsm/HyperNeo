import { describe, expect, test } from 'bun:test';
import type { Session } from '@hyperneo/shared';
import { goalParentProblem, startGoalSession } from '../../../../src/lib/goals/goal-session-start';
import type { CreateSessionParams } from '../../../../src/lib/session/session-lifecycle';

function parent(overrides: Partial<Session> = {}): Session {
  return {
    id: 'parent',
    title: 'Parent',
    workspacePath: '/home/neo',
    status: 'active',
    type: 'worker',
    config: {
      model: 'claude-sonnet-5',
      provider: 'anthropic',
      thinkingLevel: 'think8k',
      systemPrompt: 'You are Neo.',
      toolProfile: 'neo',
    },
    metadata: { promptProvenance: { source: 'agent', hash: 'h', agentId: 'a1' } },
    parentSessionId: null,
    ...overrides,
  } as unknown as Session;
}

function harness(isGit: boolean) {
  const created: CreateSessionParams[] = [];
  const joined: string[] = [];
  const attached: string[] = [];
  const released: string[] = [];
  const deps = {
    releaseSession: async (sessionId: string) => {
      released.push(sessionId);
    },
    isGitRepo: async () => isGit,
    createSession: async (params: CreateSessionParams) => {
      created.push(params);
      return 'goal-1';
    },
    addSpaceSession: async (spaceId: string, sessionId: string) => {
      joined.push(`${spaceId}:${sessionId}`);
    },
    attachSpaceTools: async (sessionId: string) => {
      attached.push(sessionId);
    },
  };
  return { created, joined, attached, released, deps };
}

describe('starting a goal session', () => {
  test('keeps the parent model but not its prompt, tools or agent identity', async () => {
    const h = harness(false);
    expect(await startGoalSession(parent(), 'Goal: Grow', h.deps)).toBe('goal-1');
    expect(h.created).toEqual([
      expect.objectContaining({
        workspacePath: '/home/neo',
        worktreeMode: 'direct',
        title: 'Goal: Grow',
        parentSessionId: 'parent',
        config: { model: 'claude-sonnet-5', provider: 'anthropic', thinkingLevel: 'think8k' },
      }),
    ]);
    expect(h.created[0].toolProfile).toBeUndefined();
    expect(h.created[0].promptProvenance).toBeUndefined();
    expect(h.joined).toEqual([]);
  });

  test('works in its own worktree of the parent repository', async () => {
    const h = harness(true);
    await startGoalSession(
      parent({
        workspacePath: '/repo/.worktrees/parent',
        worktree: {
          worktreePath: '/repo/.worktrees/parent',
          mainRepoPath: '/repo',
          branch: 'feat/x',
        },
      } as Partial<Session>),
      'Goal: Grow',
      h.deps
    );
    expect(h.created[0]).toMatchObject({
      workspacePath: '/repo',
      worktreeMode: 'worktree',
      worktreeBaseBranch: 'feat/x',
    });
  });

  test('joins the parent Space and gets its tools', async () => {
    const h = harness(false);
    await startGoalSession(
      parent({ context: { spaceId: 'space-1' } } as Partial<Session>),
      'Goal: Grow',
      h.deps
    );
    expect(h.created[0].spaceId).toBe('space-1');
    expect(h.joined).toEqual(['space-1:goal-1']);
    expect(h.attached).toEqual(['goal-1']);
  });

  test('a Space that refuses the new session releases it', async () => {
    const h = harness(false);
    h.deps.addSpaceSession = async () => {
      throw new Error('space paused');
    };
    await expect(
      startGoalSession(
        parent({ context: { spaceId: 'space-1' } } as Partial<Session>),
        'Goal: Grow',
        h.deps
      )
    ).rejects.toThrow('space paused');
    expect(h.released).toEqual(['goal-1']);
  });
});

describe('choosing a parent for a goal session', () => {
  const problem = (
    session: Session | null,
    { role = 'long_term_agent', paused = false }: { role?: string; paused?: boolean } = {}
  ) =>
    goalParentProblem('parent', {
      getSession: () => session,
      resolveRole: () => role as never,
      getSpace: async (id: string) => ({ id, status: 'active', paused }) as never,
    });

  test('takes the same parents a clone takes', async () => {
    expect(await problem(parent())).toBeNull();
    expect(
      await problem(parent({ context: { spaceId: 'space-1' } } as Partial<Session>))
    ).toBeNull();
  });

  test('refuses a child, a missing or archived session, and task, room or lobby workers', async () => {
    expect(await problem(parent({ parentSessionId: 'root' } as Partial<Session>))).toBe('child');
    expect(await problem(null)).toBe('inactive');
    expect(await problem(parent({ status: 'archived' } as Partial<Session>))).toBe('inactive');
    for (const context of [{ taskId: 't1' }, { roomId: 'r1' }, { lobbyId: 'l1' }]) {
      expect(await problem(parent({ context } as Partial<Session>))).toBe('inactive');
    }
  });

  test('refuses a Space session that is not its agent, or a Space that is not active', async () => {
    const inSpace = parent({ context: { spaceId: 'space-1' } } as Partial<Session>);
    expect(await problem(inSpace, { role: 'universal_read' })).toBe('inactive');
    expect(await problem(inSpace, { paused: true })).toBe('inactive');
  });
});
