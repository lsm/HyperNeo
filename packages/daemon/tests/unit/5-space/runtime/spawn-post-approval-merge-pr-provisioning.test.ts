/**
 * Provisioning tests for the post-approval PR Merger's `merge_pr` tool (task #879).
 *
 * Scope covered here (spawner-level):
 *   - REUSE path: a reused `:exec:` workflow-worker session (built with only
 *     `node-agent`) gets `space-agent-tools` eagerly attached before the merge
 *     kickoff is injected, so the merger's first turn exposes
 *     `mcp__space-agent-tools__merge_pr`. This is the #870 root cause: the
 *     reused session lacked the server, and the query-time MCP invariant does
 *     not cover a plain worker on its first turn (the router stamps
 *     `task.postApprovalSessionId` only AFTER spawn returns).
 *   - REUSE path: if the procedure requires `merge_pr` but the tool is not
 *     available (disallowed), the spawn fails clearly before the kickoff runs.
 *   - REUSE path: a non-merge kickoff does not attach anything extra.
 *
 * The create-path invariant, the policy guarantee (designated merger requires
 * space-agent-tools), the handler authorization (non-merger rejected), and the
 * raw Bash merge guard are covered by their dedicated test files.
 *
 * The real `spawnPostApprovalSubSession` reaches the SDK via
 * `createSubSession`/`injectMessageIntoSession`. To keep this a fast unit test
 * we exercise the real method but override the three instance methods that own
 * that I/O (`findLiveSubSessionForAgent`, `getSubSession`,
 * `injectMessageIntoSession`) and stub `buildMemberSpaceToolsMcpServer`, so the
 * new provisioning logic runs against a controllable fake session.
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

/** Build a fake AgentSession exposing only the surface the reuse path touches. */
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

function makeManagerWithReuseSession(fake: FakeSession): {
  manager: TaskAgentManager;
  injected: string[];
} {
  const space = { id: SPACE_ID, workspacePath: '/tmp/ws' } as Space;
  const injected: string[] = [];
  const db = new BunDatabase(':memory:');
  const manager = new TaskAgentManager({
    db: { getDatabase: () => db },
    internalEventBus: { subscribe: () => () => {} },
    spaceManager: { getSpace: async () => space },
    spaceRuntimeService: {
      buildMemberSpaceToolsMcpServer: (_s: Space, sessionId: string) => ({
        __spaceAgentTools: true,
        __forSession: sessionId,
      }),
    },
  } as unknown as ConstructorParameters<typeof TaskAgentManager>[0]);

  // Override the I/O-owning instance methods so the real provisioning logic
  // (required-tool inference, eager attach, invariant) runs against `fake`.
  const override = manager as unknown as Record<string, unknown>;
  override.findLiveSubSessionForAgent = () => fake.session.id;
  override.getSubSession = (id: string) => (id === fake.session.id ? fake : undefined);
  override.injectMessageIntoSession = async (_session: unknown, message: string) => {
    injected.push(message);
  };

  return { manager, injected };
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

describe('spawnPostApprovalSubSession — merge_pr provisioning (#879)', () => {
  test('reuse path eagerly attaches space-agent-tools before the first turn', async () => {
    // A reused `:exec:` worker is provisioned with only node-agent — the #870
    // failure surface. The merger kickoff must cause space-agent-tools (which
    // hosts merge_pr) to be merged in before the kickoff is injected.
    const fake = makeFakeSession({ id: 'reuse-1' }); // node-agent only
    const { manager, injected } = makeManagerWithReuseSession(fake);

    const result = await manager.spawnPostApprovalSubSession({
      task: makeTask(),
      workflow: makeWorkflow(),
      targetAgent: 'merger',
      kickoffMessage: MERGER_KICKOFF,
    });

    expect(result.sessionId).toBe('reuse-1');
    // space-agent-tools was attached, and it is the merger's own session id.
    expect(fake.config.mcpServers).toHaveProperty('space-agent-tools');
    expect(fake.mergeCalls).toHaveLength(1);
    expect(fake.mergeCalls[0]).toHaveProperty('space-agent-tools');
    // The kickoff was delivered (after the attach).
    expect(injected).toHaveLength(1);
    expect(injected[0]).toBe(MERGER_KICKOFF);
  });

  test('reuse path does not re-attach when space-agent-tools is already present', async () => {
    // Idempotent: an already-provisioned merger session (e.g. re-dispatch) must
    // not get a duplicate attach.
    const fake = makeFakeSession({
      id: 'reuse-1',
      mcpServers: { 'node-agent': {}, 'space-agent-tools': { alreadyHere: true } },
    });
    const { manager, injected } = makeManagerWithReuseSession(fake);

    await manager.spawnPostApprovalSubSession({
      task: makeTask(),
      workflow: makeWorkflow(),
      targetAgent: 'merger',
      kickoffMessage: MERGER_KICKOFF,
    });

    expect(fake.mergeCalls).toHaveLength(0);
    expect(injected).toHaveLength(1);
  });

  test('reuse path fails clearly before the kickoff when merge_pr is disallowed', async () => {
    // Even with space-agent-tools present, a disallow entry (mcp__server__*)
    // removes merge_pr from the surface. The provisioning invariant must throw
    // before the kickoff is injected rather than letting the merger run a
    // degraded turn.
    const fake = makeFakeSession({
      id: 'reuse-1',
      mcpServers: { 'node-agent': {}, 'space-agent-tools': {} },
      disallowedTools: ['mcp__space-agent-tools__*'],
    });
    const { manager, injected } = makeManagerWithReuseSession(fake);

    await expect(
      manager.spawnPostApprovalSubSession({
        task: makeTask(),
        workflow: makeWorkflow(),
        targetAgent: 'merger',
        kickoffMessage: MERGER_KICKOFF,
      })
    ).rejects.toThrow(/merge_pr/);

    // No kickoff delivered — the spawn aborted at the provisioning invariant.
    expect(injected).toHaveLength(0);
  });

  test('reuse path leaves a non-merge kickoff untouched (no space-agent-tools attach)', async () => {
    // A post-approval target whose procedure does not reference merge_pr must
    // not have space-agent-tools forced onto it.
    const fake = makeFakeSession({ id: 'reuse-1' }); // node-agent only
    const { manager, injected } = makeManagerWithReuseSession(fake);

    await manager.spawnPostApprovalSubSession({
      task: makeTask(),
      workflow: makeWorkflow(),
      targetAgent: 'merger',
      kickoffMessage: NON_MERGE_KICKOFF,
    });

    expect(fake.config.mcpServers).not.toHaveProperty('space-agent-tools');
    expect(fake.mergeCalls).toHaveLength(0);
    expect(injected).toHaveLength(1);
    expect(injected[0]).toBe(NON_MERGE_KICKOFF);
  });
});
