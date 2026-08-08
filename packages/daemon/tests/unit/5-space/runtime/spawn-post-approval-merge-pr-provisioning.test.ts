/**
 * Provisioning tests for the post-approval PR Merger's `merge_pr` tool (task #879).
 *
 * Scope covered here (spawner-level), for BOTH the reuse and create branches:
 *   - A merger kickoff eagerly attaches `space-agent-tools` (hosts merge_pr)
 *     before the kickoff is injected, so the first turn exposes
 *     `mcp__space-agent-tools__merge_pr`. This is the #870 root cause: a reused
 *     `:exec:` worker carried only `node-agent`, and the query-time invariant
 *     does not cover a plain worker on its first turn.
 *   - The attach OVERWRITES a colliding slot server named `space-agent-tools`
 *     (last-writer-wins) so the kickoff runs against the real built-in server.
 *   - If `merge_pr` is disallowed, the spawn fails clearly before the kickoff.
 *   - The designated-merger role (postApprovalSessionId + postApprovalRequiresMerge)
 *     is stamped on the task BEFORE the kickoff is injected, so a crash between
 *     inject and a later router-side stamp cannot leave the role un-stamped
 *     (3740713905: otherwise rehydrate would omit space-agent-tools on restart).
 *   - A non-merge kickoff attaches nothing extra but still stamps the role
 *     (postApprovalRequiresMerge: false) so rehydrate can find the session.
 *
 * The create branch is the built-in merger's PRIMARY path (it has no prior
 * session); the reuse branch fires for a workflow whose post-approval target
 * already ran. The policy guarantee, handler authorization, and the raw Bash
 * merge guard are covered by their dedicated test files.
 *
 * The real `spawnPostApprovalSubSession` reaches the SDK via
 * `createSubSession`/`injectMessageIntoSession`. To keep this a fast unit test
 * we exercise the real method but override the I/O-owning instance methods and
 * stub the config, so the new provisioning logic runs against a controllable
 * fake session.
 */
import { describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import type { Space, SpaceTask, SpaceWorkflow } from '@hyperneo/shared';

const SPACE_ID = 'space-879';

const MERGER_KICKOFF = [
  'The task has been approved. Your job is to merge PR https://github.com/o/r/pull/1.',
  '1. Call the merge gate:',
  '     merge_pr(pr_url="https://github.com/o/r/pull/1", task_id="task-1")',
  'When merge_pr returns blockers, relay them.',
].join('\n');

const NON_MERGE_KICKOFF =
  'The task is approved. Save a result artifact via save_artifact and call mark_complete.';

interface FakeSession {
  session: { id: string };
  config: {
    mcpServers: Record<string, unknown>;
    disallowedTools: string[];
  };
  mergeCalls: Array<Record<string, unknown>>;
  getSessionData: () => { config: FakeSession['config'] };
  mergeRuntimeMcpServers: (additional: Record<string, unknown>) => void;
}

/** Build a fake AgentSession exposing only the surface the spawn path touches. */
function makeFakeSession(opts: {
  id?: string;
  mcpServers?: Record<string, unknown>;
  disallowedTools?: string[];
}): FakeSession {
  const config = {
    mcpServers: { ...(opts.mcpServers ?? { 'node-agent': {} }) },
    disallowedTools: [...(opts.disallowedTools ?? [])],
  };
  const fake: FakeSession = {
    session: { id: opts.id ?? 'reuse-1' },
    config,
    mergeCalls: [],
    getSessionData: () => ({ config: fake.config }),
    mergeRuntimeMcpServers: (additional) => {
      fake.mergeCalls.push(additional);
      fake.config.mcpServers = { ...fake.config.mcpServers, ...additional };
    },
  };
  return fake;
}

function makeWorkflow(): SpaceWorkflow {
  return {
    id: 'wf-1',
    spaceId: SPACE_ID,
    name: 'Coding',
    nodes: [
      { id: 'code', name: 'Coding', agents: [{ agentId: 'Coder', name: 'coder' }] },
      { id: 'pa', name: 'Post-Approval', agents: [{ agentId: 'PR Merger', name: 'merger' }] },
    ],
    channels: [],
    gates: [],
    startNodeId: 'code',
    endNodeId: 'code',
    completionAutonomyLevel: 3,
  } as unknown as SpaceWorkflow;
}

function makeTask(): SpaceTask {
  return {
    id: 'task-1',
    spaceId: SPACE_ID,
    status: 'approved',
    workflowRunId: 'run-1',
  } as unknown as SpaceTask;
}

/** Shared config pieces for both reuse and create managers. */
function sharedConfig(
  stamps: Array<{ id: string; params: Record<string, unknown> }>,
  events: string[]
) {
  const space = { id: SPACE_ID, workspacePath: '/tmp/ws' } as Space;
  return {
    space,
    config: {
      db: { getDatabase: () => new BunDatabase(':memory:'), getSession: () => null },
      internalEventBus: { subscribe: () => () => {} },
      taskRepo: {
        updateTask: (id: string, params: Record<string, unknown>) => {
          stamps.push({ id, params });
          events.push('stamp');
        },
      },
      spaceManager: { getSpace: async () => space },
      spaceAgentManager: {
        getById: () => ({
          id: 'PR Merger',
          name: 'merger',
          customPrompt: 'merge the approved PR',
          model: 'm',
          tools: [],
        }),
      },
      workflowRunRepo: {
        getRun: () => ({ id: 'run-1', status: 'in_progress', workflowId: 'wf-1' }),
      },
      spaceRuntimeService: {
        buildMemberSpaceToolsMcpServer: (_s: Space, sessionId: string) => ({
          __spaceAgentTools: true,
          __forSession: sessionId,
        }),
      },
    } as unknown as ConstructorParameters<typeof TaskAgentManager>[0],
  };
}

/** REUSE branch: `findLiveSubSessionForAgent` returns the fake's id. */
function makeManagerWithReuseSession(fake: FakeSession): {
  manager: TaskAgentManager;
  injected: string[];
  stamps: Array<{ id: string; params: Record<string, unknown> }>;
  events: string[];
} {
  const injected: string[] = [];
  const stamps: Array<{ id: string; params: Record<string, unknown> }> = [];
  const events: string[] = [];
  const { config } = sharedConfig(stamps, events);
  const manager = new TaskAgentManager(config);

  const override = manager as unknown as Record<string, unknown>;
  override.findLiveSubSessionForAgent = () => fake.session.id;
  override.getSubSession = (id: string) => (id === fake.session.id ? fake : undefined);
  override.injectMessageIntoSession = async (_session: unknown, message: string) => {
    injected.push(message);
    events.push('inject');
  };

  return { manager, injected, stamps, events };
}

/** CREATE branch: no live session, so `createSubSession` is reached. */
function makeManagerWithCreateSession(fake: FakeSession): {
  manager: TaskAgentManager;
  injected: string[];
  stamps: Array<{ id: string; params: Record<string, unknown> }>;
  events: string[];
} {
  const injected: string[] = [];
  const stamps: Array<{ id: string; params: Record<string, unknown> }> = [];
  const events: string[] = [];
  const { config } = sharedConfig(stamps, events);
  const manager = new TaskAgentManager(config);

  const override = manager as unknown as Record<string, unknown>;
  override.findLiveSubSessionForAgent = () => null; // no live session → CREATE
  // Skip the real SDK creation: return the fake's id and surface the fake via
  // getSubSession so the create-path provisioning block runs against it.
  override.createSubSession = async () => fake.session.id;
  override.getSubSession = (id: string) => (id === fake.session.id ? fake : undefined);
  override.buildNodeAgentMcpServerForSession = () => ({ __nodeAgent: true });
  override.ensureNodeAgentAttached = async () => {};
  override.injectMessageIntoSession = async (_session: unknown, message: string) => {
    injected.push(message);
    events.push('inject');
  };

  return { manager, injected, stamps, events };
}

describe('spawnPostApprovalSubSession — merge_pr provisioning (#879)', () => {
  describe('REUSE path', () => {
    test('eagerly attaches space-agent-tools + stamps the role before the first turn', async () => {
      const fake = makeFakeSession({ id: 'reuse-1' }); // node-agent only
      const { manager, injected, stamps, events } = makeManagerWithReuseSession(fake);

      const result = await manager.spawnPostApprovalSubSession({
        task: makeTask(),
        workflow: makeWorkflow(),
        targetAgent: 'merger',
        kickoffMessage: MERGER_KICKOFF,
      });

      expect(result.sessionId).toBe('reuse-1');
      expect(fake.config.mcpServers).toHaveProperty('space-agent-tools');
      expect(fake.mergeCalls[0]).toHaveProperty('space-agent-tools');
      expect(injected).toEqual([MERGER_KICKOFF]);
      // Role stamped BEFORE the kickoff, precisely (merge route → true). The
      // ordered-events log pins the sequencing — a stamp-after-inject regression
      // (reopening the 3740713905 crash window) would fail this.
      expect(events).toEqual(['stamp', 'inject']);
      expect(stamps).toHaveLength(1);
      expect(stamps[0]).toMatchObject({
        id: 'task-1',
        params: { postApprovalSessionId: 'reuse-1', postApprovalRequiresMerge: true },
      });
    });

    test('overwrites space-agent-tools, defeating a colliding slot server (#879 P2-a)', async () => {
      const fake = makeFakeSession({
        id: 'reuse-1',
        mcpServers: { 'node-agent': {}, 'space-agent-tools': { collidingSlotServer: true } },
      });
      const { manager, injected } = makeManagerWithReuseSession(fake);

      await manager.spawnPostApprovalSubSession({
        task: makeTask(),
        workflow: makeWorkflow(),
        targetAgent: 'merger',
        kickoffMessage: MERGER_KICKOFF,
      });

      expect(fake.mergeCalls[0]).toHaveProperty('space-agent-tools');
      expect(fake.config.mcpServers['space-agent-tools']).not.toMatchObject({
        collidingSlotServer: true,
      });
      expect(injected).toHaveLength(1);
    });

    test('fails clearly before the kickoff when merge_pr is disallowed', async () => {
      const fake = makeFakeSession({
        id: 'reuse-1',
        mcpServers: { 'node-agent': {}, 'space-agent-tools': {} },
        disallowedTools: ['mcp__space-agent-tools__*'],
      });
      const { manager, injected, stamps } = makeManagerWithReuseSession(fake);

      await expect(
        manager.spawnPostApprovalSubSession({
          task: makeTask(),
          workflow: makeWorkflow(),
          targetAgent: 'merger',
          kickoffMessage: MERGER_KICKOFF,
        })
      ).rejects.toThrow(/merge_pr/);

      // No kickoff delivered and no role stamped — the spawn aborted at the
      // provisioning invariant, BEFORE the stamp and inject.
      expect(injected).toHaveLength(0);
      expect(stamps).toHaveLength(0);
    });

    test('stamps the role (false) for a non-merge kickoff without attaching space-agent-tools', async () => {
      const fake = makeFakeSession({ id: 'reuse-1' }); // node-agent only
      const { manager, injected, stamps } = makeManagerWithReuseSession(fake);

      await manager.spawnPostApprovalSubSession({
        task: makeTask(),
        workflow: makeWorkflow(),
        targetAgent: 'merger',
        kickoffMessage: NON_MERGE_KICKOFF,
      });

      expect(fake.config.mcpServers).not.toHaveProperty('space-agent-tools');
      expect(fake.mergeCalls).toHaveLength(0);
      expect(injected).toEqual([NON_MERGE_KICKOFF]);
      // The role is still stamped (postApprovalSessionId set, requiresMerge false)
      // so rehydrate can locate the session on restart.
      expect(stamps).toHaveLength(1);
      expect(stamps[0]).toMatchObject({
        id: 'task-1',
        params: { postApprovalSessionId: 'reuse-1', postApprovalRequiresMerge: false },
      });
    });
  });

  describe('CREATE path (the built-in merger primary path)', () => {
    test('attaches space-agent-tools + stamps the role before the first turn', async () => {
      // The built-in merger has no prior session → CREATE branch. The kickoff
      // must cause space-agent-tools to be merged onto the ACTUAL session
      // returned by createSubSession (which may differ from the proposed id),
      // and the role stamped before the kickoff is injected.
      const fake = makeFakeSession({ id: 'create-1' }); // node-agent only
      const { manager, injected, stamps, events } = makeManagerWithCreateSession(fake);

      const result = await manager.spawnPostApprovalSubSession({
        task: makeTask(),
        workflow: makeWorkflow(),
        targetAgent: 'merger',
        kickoffMessage: MERGER_KICKOFF,
      });

      expect(result.sessionId).toBe('create-1');
      expect(fake.config.mcpServers).toHaveProperty('space-agent-tools');
      expect(fake.mergeCalls[0]).toHaveProperty('space-agent-tools');
      expect(injected).toEqual([MERGER_KICKOFF]);
      // Ordered-events log pins stamp-before-inject on the create path too.
      expect(events).toEqual(['stamp', 'inject']);
      expect(stamps).toHaveLength(1);
      expect(stamps[0]).toMatchObject({
        id: 'task-1',
        params: { postApprovalSessionId: 'create-1', postApprovalRequiresMerge: true },
      });
    });

    test('stamps the role (false) for a non-merge kickoff without attaching space-agent-tools', async () => {
      // Parity with the reuse-path non-merge no-op: a create-path post-approval
      // target whose procedure does not reference merge_pr must not have
      // space-agent-tools forced onto it, but the role is still stamped so
      // rehydrate can locate the session.
      const fake = makeFakeSession({ id: 'create-1' }); // node-agent only
      const { manager, injected, stamps } = makeManagerWithCreateSession(fake);

      await manager.spawnPostApprovalSubSession({
        task: makeTask(),
        workflow: makeWorkflow(),
        targetAgent: 'merger',
        kickoffMessage: NON_MERGE_KICKOFF,
      });

      expect(fake.config.mcpServers).not.toHaveProperty('space-agent-tools');
      expect(fake.mergeCalls).toHaveLength(0);
      expect(injected).toEqual([NON_MERGE_KICKOFF]);
      expect(stamps).toHaveLength(1);
      expect(stamps[0]).toMatchObject({
        id: 'task-1',
        params: { postApprovalSessionId: 'create-1', postApprovalRequiresMerge: false },
      });
    });

    test('clears the stamped role if inject fails, so a retry re-dispatches (#879 3740839496)', async () => {
      // The P1 inverse-crash-window fix: the role is stamped before inject, so
      // if inject throws (e.g. ensureQueryStarted fails before saveUserMessage)
      // the role must be CLEARED — otherwise the task is left approved with a
      // live postApprovalSessionId and no kickoff, silently stalled behind the
      // already-routed guard.
      const fake = makeFakeSession({ id: 'create-1' });
      const { manager, stamps } = makeManagerWithCreateSession(fake);
      (
        manager as unknown as {
          injectMessageIntoSession: (...a: unknown[]) => Promise<string>;
        }
      ).injectMessageIntoSession = async () => {
        throw new Error('ensureQueryStarted blew up');
      };

      await expect(
        manager.spawnPostApprovalSubSession({
          task: makeTask(),
          workflow: makeWorkflow(),
          targetAgent: 'merger',
          kickoffMessage: MERGER_KICKOFF,
        })
      ).rejects.toThrow(/ensureQueryStarted/);

      // The role was stamped, then cleared on the inject failure: the net task
      // state has postApprovalSessionId null so a retry re-dispatches.
      expect(stamps).toHaveLength(2);
      expect(stamps[0]).toMatchObject({
        id: 'task-1',
        params: { postApprovalSessionId: 'create-1', postApprovalRequiresMerge: true },
      });
      expect(stamps[1]).toMatchObject({
        id: 'task-1',
        params: { postApprovalSessionId: null, postApprovalRequiresMerge: null },
      });
    });

    test('overwrites space-agent-tools, defeating a colliding slot server (#879 P2-a)', async () => {
      const fake = makeFakeSession({
        id: 'create-1',
        mcpServers: { 'node-agent': {}, 'space-agent-tools': { collidingSlotServer: true } },
      });
      const { manager, injected } = makeManagerWithCreateSession(fake);

      await manager.spawnPostApprovalSubSession({
        task: makeTask(),
        workflow: makeWorkflow(),
        targetAgent: 'merger',
        kickoffMessage: MERGER_KICKOFF,
      });

      expect(fake.mergeCalls[0]).toHaveProperty('space-agent-tools');
      expect(fake.config.mcpServers['space-agent-tools']).not.toMatchObject({
        collidingSlotServer: true,
      });
      expect(injected).toHaveLength(1);
    });

    test('fails clearly before the kickoff when merge_pr is disallowed', async () => {
      const fake = makeFakeSession({
        id: 'create-1',
        mcpServers: { 'node-agent': {}, 'space-agent-tools': {} },
        disallowedTools: ['mcp__space-agent-tools__*'],
      });
      const { manager, injected, stamps } = makeManagerWithCreateSession(fake);

      await expect(
        manager.spawnPostApprovalSubSession({
          task: makeTask(),
          workflow: makeWorkflow(),
          targetAgent: 'merger',
          kickoffMessage: MERGER_KICKOFF,
        })
      ).rejects.toThrow(/merge_pr/);

      expect(injected).toHaveLength(0);
      expect(stamps).toHaveLength(0);
    });
  });
});
