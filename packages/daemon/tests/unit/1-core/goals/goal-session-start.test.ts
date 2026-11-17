import { describe, expect, test } from 'bun:test';
import type { Session } from '@hyperneo/shared';
import { startGoalSession } from '../../../../src/lib/goals/goal-session-start';
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
  const deps = {
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
  return { created, joined, attached, deps };
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
});
