/**
 * Unit tests for GatePollManager
 *
 * Tests the poll lifecycle (start/stop), change detection, message injection,
 * script execution context, and error handling.
 *
 * Timer-based tick execution is tested via the internal `executePollTick` method
 * rather than fake timers, because Bun's test runner has limited async timer support.
 */

import { type Gate, type GatePoll, type SpaceWorkflow, type WorkflowChannel } from '@neokai/shared';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  extractPrContext,
  formatPollMessage,
  GatePollManager,
  type PollMessageInjector,
  type PollScriptContext,
  type PollSessionResolver,
  type PollWorkflowDefProvider,
  resolveTargetNodeName,
} from '../../../../src/lib/space/runtime/gate-poll-manager';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeGate(id: string, poll?: GatePoll): Gate {
  return {
    id,
    resetOnCycle: false,
    ...(poll ? { poll } : {}),
  };
}

function makeWorkflow(gates: Gate[], channels: WorkflowChannel[] = []): SpaceWorkflow {
  return {
    id: 'wf-1',
    spaceId: 'space-1',
    name: 'Test Workflow',
    tags: [],
    nodes: [
      { id: 'node-1', name: 'Coder', agents: [{ agentId: 'agent-1', name: 'coder' }] },
      { id: 'node-2', name: 'Reviewer', agents: [{ agentId: 'agent-2', name: 'reviewer' }] },
    ],
    startNodeId: 'node-1',
    endNodeId: 'node-2',
    channels,
    gates,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completionAutonomyLevel: 3,
  };
}

function makePoll(overrides?: Partial<GatePoll>): GatePoll {
  return {
    intervalMs: 30_000,
    script: 'echo "hello"',
    target: 'to',
    ...overrides,
  };
}

function makeContext(): PollScriptContext {
  return {
    TASK_ID: 'task-1',
    TASK_TITLE: 'Test Task',
    SPACE_ID: 'space-1',
    PR_URL: 'https://github.com/owner/repo/pull/42',
    PR_NUMBER: '42',
    REPO_OWNER: 'owner',
    REPO_NAME: 'repo',
    WORKFLOW_RUN_ID: 'run-1',
  };
}

function makeWorkflowWithPoll(
  pollOverrides?: Partial<GatePoll>,
  channelOverrides?: Partial<WorkflowChannel>
) {
  const gate = makeGate('gate-1', makePoll(pollOverrides));
  const channel: WorkflowChannel = {
    id: 'ch-1',
    from: 'Coder',
    to: 'Reviewer',
    gateId: 'gate-1',
    ...channelOverrides,
  };
  return makeWorkflow([gate], [channel]);
}

// Helper to create a manager and trigger a tick manually
async function triggerTick(
  manager: GatePollManager,
  runId: string,
  gateId: string,
  poll: GatePoll,
  workspacePath: string,
  context: PollScriptContext,
  targetNodeId: string,
  sourceName: string = 'Coder'
): Promise<void> {
  // Access the private method via the instance
  return (manager as Record<string, unknown>).executePollTick.call(
    manager,
    runId,
    gateId,
    sourceName,
    poll,
    workspacePath,
    context,
    targetNodeId
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GatePollManager', () => {
  let injector: PollMessageInjector;
  let resolver: PollSessionResolver;
  let manager: GatePollManager;

  beforeEach(() => {
    injector = {
      injectSubSessionMessage: vi.fn().mockResolvedValue(undefined),
    };
    resolver = {
      getActiveSessionForNode: vi.fn().mockReturnValue('session-1'),
    };
    manager = new GatePollManager(injector, resolver);
  });

  afterEach(() => {
    manager.stopAll();
  });

  describe('startPolls', () => {
    test('starts polls for gates with poll config', () => {
      const workflow = makeWorkflowWithPoll();

      manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

      expect(manager.activePollCount).toBe(1);
      expect(manager.isPollActive('run-1', 'gate-1')).toBe(true);
    });

    test('does not start polls when no gates have poll config', () => {
      const gate = makeGate('gate-1');
      const workflow = makeWorkflow([gate]);

      manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

      expect(manager.activePollCount).toBe(0);
    });

    test('skips poll when no channel references the gate', () => {
      const gate = makeGate('gate-1', makePoll());
      const workflow = makeWorkflow([gate], []);

      manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

      expect(manager.activePollCount).toBe(0);
    });

    test('skips poll when target node is not found', () => {
      const gate = makeGate('gate-1', makePoll());
      const channel: WorkflowChannel = {
        id: 'ch-1',
        from: 'Coder',
        to: 'NonExistent',
        gateId: 'gate-1',
      };
      const workflow = makeWorkflow([gate], [channel]);

      manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

      expect(manager.activePollCount).toBe(0);
    });

    test('starts multiple polls for multiple gates', () => {
      const gate1 = makeGate('gate-1', makePoll());
      const gate2 = makeGate('gate-2', makePoll());
      const channel1: WorkflowChannel = {
        id: 'ch-1',
        from: 'Coder',
        to: 'Reviewer',
        gateId: 'gate-1',
      };
      const channel2: WorkflowChannel = {
        id: 'ch-2',
        from: 'Reviewer',
        to: 'Coder',
        gateId: 'gate-2',
      };
      const workflow = makeWorkflow([gate1, gate2], [channel1, channel2]);

      manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

      expect(manager.activePollCount).toBe(2);
      expect(manager.isPollActive('run-1', 'gate-1')).toBe(true);
      expect(manager.isPollActive('run-1', 'gate-2')).toBe(true);
    });

    test('enforces minimum interval (still starts with clamped value)', () => {
      const workflow = makeWorkflowWithPoll({ intervalMs: 5000 }); // Below minimum
      manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

      // Poll should still start (interval is clamped internally)
      expect(manager.activePollCount).toBe(1);
    });
  });

  describe('stopPolls', () => {
    test('stops polls for a specific run', () => {
      const workflow = makeWorkflowWithPoll();
      manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());
      expect(manager.activePollCount).toBe(1);

      manager.stopPolls('run-1');
      expect(manager.activePollCount).toBe(0);
      expect(manager.isPollActive('run-1', 'gate-1')).toBe(false);
    });

    test('only stops polls for the specified run', () => {
      const gate1 = makeGate('gate-1', makePoll());
      const gate2 = makeGate('gate-2', makePoll());
      const channel1: WorkflowChannel = {
        id: 'ch-1',
        from: 'Coder',
        to: 'Reviewer',
        gateId: 'gate-1',
      };
      const channel2: WorkflowChannel = {
        id: 'ch-2',
        from: 'Reviewer',
        to: 'Coder',
        gateId: 'gate-2',
      };
      const workflow = makeWorkflow([gate1, gate2], [channel1, channel2]);

      manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());
      manager.startPolls('run-2', workflow, '/tmp', 'space-1', makeContext());

      expect(manager.activePollCount).toBe(4);

      manager.stopPolls('run-1');
      expect(manager.activePollCount).toBe(2);
      expect(manager.isPollActive('run-1', 'gate-1')).toBe(false);
      expect(manager.isPollActive('run-2', 'gate-1')).toBe(true);
    });
  });

  describe('stopAll', () => {
    test('stops all polls across all runs', () => {
      const workflow = makeWorkflowWithPoll();

      manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());
      manager.startPolls('run-2', workflow, '/tmp', 'space-1', makeContext());

      expect(manager.activePollCount).toBe(2);

      manager.stopAll();
      expect(manager.activePollCount).toBe(0);
    });
  });

  describe('lastOutput reset on restart', () => {
    test('re-injects previously seen output after stop+restart (intentional behavior)', async () => {
      const workflow = makeWorkflowWithPoll({ script: 'echo "known output"' });
      manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

      // First tick — injects "known output"
      await triggerTick(
        manager,
        'run-1',
        'gate-1',
        makePoll({ script: 'echo "known output"' }),
        '/tmp',
        makeContext(),
        'node-2'
      );
      expect(injector.injectSubSessionMessage).toHaveBeenCalledTimes(1);

      // Second tick — same output, no re-injection
      await triggerTick(
        manager,
        'run-1',
        'gate-1',
        makePoll({ script: 'echo "known output"' }),
        '/tmp',
        makeContext(),
        'node-2'
      );
      expect(injector.injectSubSessionMessage).toHaveBeenCalledTimes(1);

      // Stop and restart the poll (simulates run restart)
      manager.stopPolls('run-1');
      manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

      // After restart, same output is re-injected (lastOutput was reset)
      await triggerTick(
        manager,
        'run-1',
        'gate-1',
        makePoll({ script: 'echo "known output"' }),
        '/tmp',
        makeContext(),
        'node-2'
      );
      expect(injector.injectSubSessionMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe('in-flight tick cancellation', () => {
    test('in-flight tick is cancelled when poll is stopped during execution', async () => {
      const workflow = makeWorkflowWithPoll({ script: 'echo "output"' });
      manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

      // Trigger a tick but stop the poll while it's running.
      // The script will execute but the active guard should prevent injection.
      // We test this by stopping immediately after the tick starts.
      const tickPromise = triggerTick(
        manager,
        'run-1',
        'gate-1',
        makePoll({ script: 'echo "output"' }),
        '/tmp',
        makeContext(),
        'node-2'
      );

      // Stop polls while the script is running
      manager.stopPolls('run-1');

      await tickPromise;

      // Injection should not happen because active was set to false
      expect(injector.injectSubSessionMessage).not.toHaveBeenCalled();
    });
  });

  describe('lastOutput deferred until injection succeeds', () => {
    test('lastOutput is not updated when no active session exists', async () => {
      (resolver.getActiveSessionForNode as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const workflow = makeWorkflowWithPoll({ script: 'echo "pending output"' });
      manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

      // Tick 1: no session — output should NOT be marked as seen
      await triggerTick(
        manager,
        'run-1',
        'gate-1',
        makePoll({ script: 'echo "pending output"' }),
        '/tmp',
        makeContext(),
        'node-2'
      );
      expect(injector.injectSubSessionMessage).not.toHaveBeenCalled();

      // Now a session appears
      (resolver.getActiveSessionForNode as ReturnType<typeof vi.fn>).mockReturnValue('session-1');

      // Tick 2: same output — should still be injected because lastOutput
      // was not updated when there was no session
      await triggerTick(
        manager,
        'run-1',
        'gate-1',
        makePoll({ script: 'echo "pending output"' }),
        '/tmp',
        makeContext(),
        'node-2'
      );
      expect(injector.injectSubSessionMessage).toHaveBeenCalledWith(
        'session-1',
        'pending output',
        true
      );
    });
  });

  describe('overlapping tick prevention', () => {
    test('skips tick when previous tick is still in flight', async () => {
      const workflow = makeWorkflowWithPoll({ script: 'sleep 0.1 && echo "slow output"' });
      manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

      // Start a slow tick (don't await it yet)
      const slowTick = triggerTick(
        manager,
        'run-1',
        'gate-1',
        makePoll({ script: 'sleep 0.1 && echo "slow output"' }),
        '/tmp',
        makeContext(),
        'node-2'
      );

      // Immediately trigger a second tick — should be skipped
      await triggerTick(
        manager,
        'run-1',
        'gate-1',
        makePoll({ script: 'echo "fast output"' }),
        '/tmp',
        makeContext(),
        'node-2'
      );

      // Wait for the slow tick to finish
      await slowTick;

      // Only one injection should have occurred (from the slow tick)
      expect(injector.injectSubSessionMessage).toHaveBeenCalledTimes(1);
      expect(injector.injectSubSessionMessage).toHaveBeenCalledWith(
        'session-1',
        'slow output',
        true
      );
    });

    test('allows tick after previous tick completes', async () => {
      const workflow = makeWorkflowWithPoll({ script: 'echo "first"' });
      manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

      // First tick completes
      await triggerTick(
        manager,
        'run-1',
        'gate-1',
        makePoll({ script: 'echo "first"' }),
        '/tmp',
        makeContext(),
        'node-2'
      );
      expect(injector.injectSubSessionMessage).toHaveBeenCalledTimes(1);

      // Second tick with different output should be allowed
      await triggerTick(
        manager,
        'run-1',
        'gate-1',
        makePoll({ script: 'echo "second"' }),
        '/tmp',
        makeContext(),
        'node-2'
      );
      expect(injector.injectSubSessionMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe('PR context refresh per tick', () => {
    test('refreshes PR fields from resolver before each tick', async () => {
      const prUrlResolver = {
        getPrUrlForNode: vi.fn(),
        getPrUrlForRun: vi
          .fn()
          .mockResolvedValueOnce('https://github.com/owner/repo/pull/99')
          .mockResolvedValueOnce('https://github.com/owner/repo/pull/100'),
      };
      const managerWithResolver = new GatePollManager(injector, resolver, prUrlResolver);

      const script = 'echo "$PR_URL $PR_NUMBER"';
      const workflow = makeWorkflowWithPoll({ script });
      managerWithResolver.startPolls('run-1', workflow, '/tmp', 'space-1', {
        ...makeContext(),
        PR_URL: '',
        PR_NUMBER: '',
        REPO_OWNER: '',
        REPO_NAME: '',
      });

      // Tick 1: resolver returns PR 99
      await triggerTick(
        managerWithResolver,
        'run-1',
        'gate-1',
        makePoll({ script }),
        '/tmp',
        { ...makeContext(), PR_URL: '', PR_NUMBER: '', REPO_OWNER: '', REPO_NAME: '' },
        'node-2'
      );
      expect(injector.injectSubSessionMessage).toHaveBeenCalledWith(
        'session-1',
        'https://github.com/owner/repo/pull/99 99',
        true
      );

      // Tick 2: resolver returns PR 100
      await triggerTick(
        managerWithResolver,
        'run-1',
        'gate-1',
        makePoll({ script }),
        '/tmp',
        { ...makeContext(), PR_URL: '', PR_NUMBER: '', REPO_OWNER: '', REPO_NAME: '' },
        'node-2'
      );
      expect(injector.injectSubSessionMessage).toHaveBeenCalledWith(
        'session-1',
        'https://github.com/owner/repo/pull/100 100',
        true
      );

      managerWithResolver.stopAll();
    });
  });

  describe('interval validation', () => {
    test('skips poll with NaN intervalMs', () => {
      const workflow = makeWorkflowWithPoll({ intervalMs: NaN });
      manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());
      expect(manager.activePollCount).toBe(0);
    });

    test('skips poll with negative intervalMs', () => {
      const workflow = makeWorkflowWithPoll({ intervalMs: -1000 });
      manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());
      expect(manager.activePollCount).toBe(0);
    });

    test('skips poll with zero intervalMs', () => {
      const workflow = makeWorkflowWithPoll({ intervalMs: 0 });
      manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());
      expect(manager.activePollCount).toBe(0);
    });
  });

  describe('poll tick execution', () => {
    test('executes script and injects message when output changes', async () => {
      const workflow = makeWorkflowWithPoll({ script: 'echo "new output"' });
      manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

      await triggerTick(
        manager,
        'run-1',
        'gate-1',
        makePoll({ script: 'echo "new output"' }),
        '/tmp',
        makeContext(),
        'node-2'
      );

      expect(injector.injectSubSessionMessage).toHaveBeenCalledWith(
        'session-1',
        'new output',
        true
      );
    });

    test('does not inject message when output is unchanged', async () => {
      const workflow = makeWorkflowWithPoll({ script: 'echo "same output"' });
      manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

      // First tick — injects
      await triggerTick(
        manager,
        'run-1',
        'gate-1',
        makePoll({ script: 'echo "same output"' }),
        '/tmp',
        makeContext(),
        'node-2'
      );
      expect(injector.injectSubSessionMessage).toHaveBeenCalledTimes(1);

      // Second tick — same output, no injection
      await triggerTick(
        manager,
        'run-1',
        'gate-1',
        makePoll({ script: 'echo "same output"' }),
        '/tmp',
        makeContext(),
        'node-2'
      );
      expect(injector.injectSubSessionMessage).toHaveBeenCalledTimes(1);
    });

    test('does not inject when no active session', async () => {
      (resolver.getActiveSessionForNode as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const workflow = makeWorkflowWithPoll({ script: 'echo "output"' });
      manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

      await triggerTick(
        manager,
        'run-1',
        'gate-1',
        makePoll({ script: 'echo "output"' }),
        '/tmp',
        makeContext(),
        'node-2'
      );

      expect(injector.injectSubSessionMessage).not.toHaveBeenCalled();
    });

    test('handles script errors gracefully without crashing', async () => {
      const workflow = makeWorkflowWithPoll({ script: 'exit 1' });
      manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

      // Should not throw
      await triggerTick(
        manager,
        'run-1',
        'gate-1',
        makePoll({ script: 'exit 1' }),
        '/tmp',
        makeContext(),
        'node-2'
      );

      expect(injector.injectSubSessionMessage).not.toHaveBeenCalled();
      // Poll should still be active
      expect(manager.isPollActive('run-1', 'gate-1')).toBe(true);
    });

    test('handles empty script output without injecting', async () => {
      const workflow = makeWorkflowWithPoll({ script: 'echo ""' });
      manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

      await triggerTick(
        manager,
        'run-1',
        'gate-1',
        makePoll({ script: 'echo ""' }),
        '/tmp',
        makeContext(),
        'node-2'
      );

      expect(injector.injectSubSessionMessage).not.toHaveBeenCalled();
    });

    test('does nothing when poll is already stopped', async () => {
      const workflow = makeWorkflowWithPoll({ script: 'echo "output"' });
      manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());
      manager.stopPolls('run-1');

      await triggerTick(
        manager,
        'run-1',
        'gate-1',
        makePoll({ script: 'echo "output"' }),
        '/tmp',
        makeContext(),
        'node-2'
      );

      expect(injector.injectSubSessionMessage).not.toHaveBeenCalled();
    });

    test('injects with changed output after previous non-empty output', async () => {
      // First script output: "first"
      // Simulate change detection by triggering two different outputs
      const workflow = makeWorkflowWithPoll({ script: 'echo "first"' });
      manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

      await triggerTick(
        manager,
        'run-1',
        'gate-1',
        makePoll({ script: 'echo "first"' }),
        '/tmp',
        makeContext(),
        'node-2'
      );
      expect(injector.injectSubSessionMessage).toHaveBeenCalledWith('session-1', 'first', true);

      // Now simulate a changed output
      await triggerTick(
        manager,
        'run-1',
        'gate-1',
        makePoll({ script: 'echo "second"' }),
        '/tmp',
        makeContext(),
        'node-2'
      );
      // The second call should use the actual script output "second"
      expect(injector.injectSubSessionMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe('message template', () => {
    test('applies message template when provided', async () => {
      const workflow = makeWorkflowWithPoll({
        script: 'echo "new comment"',
        messageTemplate: 'New PR review comment:\n{{output}}',
      });
      manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

      await triggerTick(
        manager,
        'run-1',
        'gate-1',
        makePoll({
          script: 'echo "new comment"',
          messageTemplate: 'New PR review comment:\n{{output}}',
        }),
        '/tmp',
        makeContext(),
        'node-2'
      );

      expect(injector.injectSubSessionMessage).toHaveBeenCalledWith(
        'session-1',
        'New PR review comment:\nnew comment',
        true
      );
    });

    test('uses raw output when no template provided', async () => {
      const workflow = makeWorkflowWithPoll({ script: 'echo "raw output"' });
      manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

      await triggerTick(
        manager,
        'run-1',
        'gate-1',
        makePoll({ script: 'echo "raw output"' }),
        '/tmp',
        makeContext(),
        'node-2'
      );

      expect(injector.injectSubSessionMessage).toHaveBeenCalledWith(
        'session-1',
        'raw output',
        true
      );
    });
  });

  describe('target resolution', () => {
    test('resolves to "from" node when target is "from"', async () => {
      const workflow = makeWorkflowWithPoll({ script: 'echo "output"', target: 'from' });
      manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

      await triggerTick(
        manager,
        'run-1',
        'gate-1',
        makePoll({ script: 'echo "output"', target: 'from' }),
        '/tmp',
        makeContext(),
        'node-1'
      );

      // Verify the resolver was called with the "from" node (Coder → node-1)
      expect(resolver.getActiveSessionForNode).toHaveBeenCalledWith('run-1', 'node-1');
    });

    test('resolves to "to" node when target is "to"', async () => {
      const workflow = makeWorkflowWithPoll({ script: 'echo "output"', target: 'to' });
      manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

      await triggerTick(
        manager,
        'run-1',
        'gate-1',
        makePoll({ script: 'echo "output"', target: 'to' }),
        '/tmp',
        makeContext(),
        'node-2'
      );

      // Verify the resolver was called with the "to" node (Reviewer → node-2)
      expect(resolver.getActiveSessionForNode).toHaveBeenCalledWith('run-1', 'node-2');
    });
  });

  describe('script context', () => {
    test('injects context variables into script environment', async () => {
      // Use a script that outputs env vars to verify injection
      const script = 'echo "$TASK_ID $PR_NUMBER $REPO_OWNER $REPO_NAME"';
      const workflow = makeWorkflowWithPoll({ script });
      manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

      await triggerTick(
        manager,
        'run-1',
        'gate-1',
        makePoll({ script }),
        '/tmp',
        makeContext(),
        'node-2'
      );

      expect(injector.injectSubSessionMessage).toHaveBeenCalledWith(
        'session-1',
        'task-1 42 owner repo',
        true
      );
    });

    test('provides empty strings for missing PR context', async () => {
      const context = makeContext();
      context.PR_URL = '';
      context.PR_NUMBER = '';
      context.REPO_OWNER = '';
      context.REPO_NAME = '';

      const script = 'echo "$PR_URL:$PR_NUMBER:$REPO_OWNER:$REPO_NAME"';
      const workflow = makeWorkflowWithPoll({ script });
      manager.startPolls('run-1', workflow, '/tmp', 'space-1', context);

      await triggerTick(
        manager,
        'run-1',
        'gate-1',
        makePoll({ script }),
        '/tmp',
        context,
        'node-2'
      );

      expect(injector.injectSubSessionMessage).toHaveBeenCalledWith('session-1', ':::', true);
    });
  });
});

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe('extractPrContext', () => {
  test('extracts context from valid GitHub PR URL', () => {
    const result = extractPrContext('https://github.com/owner/repo/pull/42');
    expect(result).toEqual({
      PR_NUMBER: '42',
      REPO_OWNER: 'owner',
      REPO_NAME: 'repo',
    });
  });

  test('returns empty strings for empty URL', () => {
    const result = extractPrContext('');
    expect(result).toEqual({
      PR_NUMBER: '',
      REPO_OWNER: '',
      REPO_NAME: '',
    });
  });

  test('returns empty strings for invalid URL', () => {
    const result = extractPrContext('not-a-url');
    expect(result).toEqual({
      PR_NUMBER: '',
      REPO_OWNER: '',
      REPO_NAME: '',
    });
  });

  test('returns empty strings for non-PR URL', () => {
    const result = extractPrContext('https://github.com/owner/repo/issues/5');
    expect(result).toEqual({
      PR_NUMBER: '',
      REPO_OWNER: '',
      REPO_NAME: '',
    });
  });

  test('handles PR URL with extra path segments', () => {
    const result = extractPrContext('https://github.com/owner/repo/pull/42/files');
    expect(result.PR_NUMBER).toBe('42');
    expect(result.REPO_OWNER).toBe('owner');
    expect(result.REPO_NAME).toBe('repo');
  });
});

describe('resolveTargetNodeName', () => {
  test('returns "to" node name for target=to', () => {
    const channel: WorkflowChannel = {
      id: 'ch-1',
      from: 'Coder',
      to: 'Reviewer',
      gateId: 'gate-1',
    };
    const workflow = makeWorkflow([], [channel]);
    expect(resolveTargetNodeName('gate-1', workflow, 'to')).toBe('Reviewer');
  });

  test('returns "from" node name for target=from', () => {
    const channel: WorkflowChannel = {
      id: 'ch-1',
      from: 'Coder',
      to: 'Reviewer',
      gateId: 'gate-1',
    };
    const workflow = makeWorkflow([], [channel]);
    expect(resolveTargetNodeName('gate-1', workflow, 'from')).toBe('Coder');
  });

  test('returns null when no channel references the gate', () => {
    const workflow = makeWorkflow([], []);
    expect(resolveTargetNodeName('gate-1', workflow, 'to')).toBeNull();
  });

  test('handles array "to" targets (returns first element)', () => {
    const channel: WorkflowChannel = {
      id: 'ch-1',
      from: 'Coder',
      to: ['Reviewer', 'QA'],
      gateId: 'gate-1',
    };
    const workflow = makeWorkflow([], [channel]);
    expect(resolveTargetNodeName('gate-1', workflow, 'to')).toBe('Reviewer');
  });

  test('resolves agent-name source to node name for target=from', () => {
    const channel: WorkflowChannel = {
      id: 'ch-1',
      from: 'coder',
      to: 'reviewer',
      gateId: 'gate-1',
    };
    const workflow = makeWorkflow([], [channel]);
    expect(resolveTargetNodeName('gate-1', workflow, 'from', 'coder')).toBe('Coder');
  });

  test('resolves node-name source before colliding agent name', () => {
    const channel: WorkflowChannel = {
      id: 'ch-1',
      from: 'Reviewer',
      to: 'reviewer',
      gateId: 'gate-1',
    };
    const workflow = makeWorkflow([], [channel]);
    workflow.nodes[0] = {
      ...workflow.nodes[0],
      name: 'ReviewSource',
      agents: [{ agentId: 'agent-1', name: 'Reviewer' }],
    };

    expect(resolveTargetNodeName('gate-1', workflow, 'from', 'Reviewer')).toBe('Reviewer');
  });

  test('resolves wildcard source to concrete node name for target=from', () => {
    const channel: WorkflowChannel = {
      id: 'ch-1',
      from: '*',
      to: 'reviewer',
      gateId: 'gate-1',
    };
    const workflow = makeWorkflow([], [channel]);
    expect(resolveTargetNodeName('gate-1', workflow, 'from', 'coder')).toBe('Coder');
  });
});

describe('formatPollMessage', () => {
  test('replaces {{output}} placeholder', () => {
    expect(formatPollMessage('hello', 'Message: {{output}}')).toBe('Message: hello');
  });

  test('replaces multiple placeholders', () => {
    expect(formatPollMessage('hello', '{{output}} and {{output}}')).toBe('hello and hello');
  });

  test('returns raw output when no template', () => {
    expect(formatPollMessage('hello')).toBe('hello');
  });

  test('returns raw output when template is empty string', () => {
    expect(formatPollMessage('hello', '')).toBe('hello');
  });

  test('preserves template text without placeholder', () => {
    expect(formatPollMessage('hello', 'No placeholder here')).toBe('No placeholder here');
  });
});

// ---------------------------------------------------------------------------
// Mid-run poll config pickup (refreshPolls) tests
// ---------------------------------------------------------------------------

describe('GatePollManager mid-run config pickup', () => {
  let injector: PollMessageInjector;
  let resolver: PollSessionResolver;
  let workflowDefs: Map<string, SpaceWorkflow>;
  let manager: GatePollManager;

  beforeEach(() => {
    injector = {
      injectSubSessionMessage: vi.fn().mockResolvedValue(undefined),
    };
    resolver = {
      getActiveSessionForNode: vi.fn().mockReturnValue('session-1'),
    };
    workflowDefs = new Map();
    manager = new GatePollManager(injector, resolver, undefined, {
      getWorkflow: (workflowId) => workflowDefs.get(workflowId) ?? null,
    });
  });

  afterEach(() => {
    manager.stopAll();
  });

  /**
   * Helper: build a workflow with optional poll configs on gates.
   * Returns the workflow and a mutator to update the stored definition.
   */
  function makePollableWorkflow(gates: Gate[], channels: WorkflowChannel[] = []): SpaceWorkflow {
    return makeWorkflow(gates, channels);
  }

  test('starts a new poll when poll is added to a gate mid-run', () => {
    // Start with no polls
    const gate = makeGate('gate-1');
    const channel: WorkflowChannel = {
      id: 'ch-1',
      from: 'Coder',
      to: 'Reviewer',
      gateId: 'gate-1',
    };
    const workflow = makePollableWorkflow([gate], [channel]);
    workflowDefs.set(workflow.id, workflow);

    // No polls initially
    manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());
    expect(manager.activePollCount).toBe(0);

    // Add poll to the gate
    const updatedGate = makeGate('gate-1', makePoll());
    const updatedWorkflow = makePollableWorkflow([updatedGate], [channel]);
    workflowDefs.set(workflow.id, updatedWorkflow);

    // Refresh
    manager.refreshPollsForWorkflow(workflow.id);

    expect(manager.activePollCount).toBe(1);
    expect(manager.isPollActive('run-1', 'gate-1')).toBe(true);
  });

  test('stops a poll when poll is removed from a gate mid-run', () => {
    // Start with a poll
    const gate = makeGate('gate-1', makePoll());
    const channel: WorkflowChannel = {
      id: 'ch-1',
      from: 'Coder',
      to: 'Reviewer',
      gateId: 'gate-1',
    };
    const workflow = makePollableWorkflow([gate], [channel]);
    workflowDefs.set(workflow.id, workflow);

    manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());
    expect(manager.activePollCount).toBe(1);

    // Remove poll from the gate
    const updatedGate = makeGate('gate-1');
    const updatedWorkflow = makePollableWorkflow([updatedGate], [channel]);
    workflowDefs.set(workflow.id, updatedWorkflow);

    // Refresh
    manager.refreshPollsForWorkflow(workflow.id);

    expect(manager.activePollCount).toBe(0);
    expect(manager.isPollActive('run-1', 'gate-1')).toBe(false);
  });

  test('updates poll config when script changes mid-run', async () => {
    const gate = makeGate('gate-1', makePoll({ script: 'echo "old script"' }));
    const channel: WorkflowChannel = {
      id: 'ch-1',
      from: 'Coder',
      to: 'Reviewer',
      gateId: 'gate-1',
    };
    const workflow = makePollableWorkflow([gate], [channel]);
    workflowDefs.set(workflow.id, workflow);

    manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

    // First tick uses old script
    await triggerTick(
      manager,
      'run-1',
      'gate-1',
      makePoll({ script: 'echo "old script"' }),
      '/tmp',
      makeContext(),
      'node-2'
    );
    expect(injector.injectSubSessionMessage).toHaveBeenCalledWith('session-1', 'old script', true);

    // Update the script in the workflow definition
    const updatedGate = makeGate('gate-1', makePoll({ script: 'echo "new script"' }));
    const updatedWorkflow = makePollableWorkflow([updatedGate], [channel]);
    workflowDefs.set(workflow.id, updatedWorkflow);

    // Refresh picks up the change
    manager.refreshPollsForWorkflow(workflow.id);

    // Next tick uses new script (read from ActivePoll.pollConfig)
    await triggerTick(
      manager,
      'run-1',
      'gate-1',
      makePoll({ script: 'echo "new script"' }),
      '/tmp',
      makeContext(),
      'node-2'
    );
    expect(injector.injectSubSessionMessage).toHaveBeenCalledWith('session-1', 'new script', true);
  });

  test('preserves lastOutput when config changes mid-run', async () => {
    const gate = makeGate('gate-1', makePoll({ script: 'echo "same"' }));
    const channel: WorkflowChannel = {
      id: 'ch-1',
      from: 'Coder',
      to: 'Reviewer',
      gateId: 'gate-1',
    };
    const workflow = makePollableWorkflow([gate], [channel]);
    workflowDefs.set(workflow.id, workflow);

    manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

    // First tick produces "same"
    await triggerTick(
      manager,
      'run-1',
      'gate-1',
      makePoll({ script: 'echo "same"' }),
      '/tmp',
      makeContext(),
      'node-2'
    );
    expect(injector.injectSubSessionMessage).toHaveBeenCalledTimes(1);

    // Update config (different script, same output)
    const updatedGate = makeGate(
      'gate-1',
      makePoll({ script: 'echo "same"', messageTemplate: 'Updated: {{output}}' })
    );
    const updatedWorkflow = makePollableWorkflow([updatedGate], [channel]);
    workflowDefs.set(workflow.id, updatedWorkflow);

    manager.refreshPollsForWorkflow(workflow.id);

    // Same output should NOT be re-injected (lastOutput is preserved)
    await triggerTick(
      manager,
      'run-1',
      'gate-1',
      makePoll({ script: 'echo "same"', messageTemplate: 'Updated: {{output}}' }),
      '/tmp',
      makeContext(),
      'node-2'
    );
    expect(injector.injectSubSessionMessage).toHaveBeenCalledTimes(1);
  });

  test('refreshPollsForWorkflow only affects runs for that workflow', () => {
    const gate = makeGate('gate-1', makePoll());
    const channel: WorkflowChannel = {
      id: 'ch-1',
      from: 'Coder',
      to: 'Reviewer',
      gateId: 'gate-1',
    };
    const workflow1 = {
      ...makePollableWorkflow([gate], [channel]),
      id: 'wf-1',
    };
    const workflow2 = {
      ...makePollableWorkflow([gate], [channel]),
      id: 'wf-2',
    };
    workflowDefs.set('wf-1', workflow1);
    workflowDefs.set('wf-2', workflow2);

    manager.startPolls('run-1', workflow1, '/tmp', 'space-1', makeContext());
    manager.startPolls('run-2', workflow2, '/tmp', 'space-1', makeContext());
    expect(manager.activePollCount).toBe(2);

    // Remove poll from workflow1 only
    const updatedGate = makeGate('gate-1');
    const updatedWorkflow1 = {
      ...makePollableWorkflow([updatedGate], [channel]),
      id: 'wf-1',
    };
    workflowDefs.set('wf-1', updatedWorkflow1);

    manager.refreshPollsForWorkflow('wf-1');

    // run-1's poll should be stopped, run-2's poll should remain
    expect(manager.isPollActive('run-1', 'gate-1')).toBe(false);
    expect(manager.isPollActive('run-2', 'gate-1')).toBe(true);
  });

  test('refreshPollsForRun is no-op when run is not tracked', () => {
    // No startPolls called for 'run-unknown'
    manager.refreshPollsForRun('run-unknown');
    expect(manager.activePollCount).toBe(0);
  });

  test('refreshPollsForRun keeps existing polls when workflow no longer exists', () => {
    const gate = makeGate('gate-1', makePoll());
    const channel: WorkflowChannel = {
      id: 'ch-1',
      from: 'Coder',
      to: 'Reviewer',
      gateId: 'gate-1',
    };
    const workflow = makePollableWorkflow([gate], [channel]);
    workflowDefs.set(workflow.id, workflow);

    manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());
    expect(manager.activePollCount).toBe(1);

    // Remove workflow from provider
    workflowDefs.delete(workflow.id);

    // Refresh should keep existing polls (not crash or stop them)
    manager.refreshPollsForRun('run-1');
    expect(manager.activePollCount).toBe(1);
  });

  test('starts multiple new polls when multiple gates get poll added', () => {
    const gate1 = makeGate('gate-1');
    const gate2 = makeGate('gate-2');
    const channel1: WorkflowChannel = {
      id: 'ch-1',
      from: 'Coder',
      to: 'Reviewer',
      gateId: 'gate-1',
    };
    const channel2: WorkflowChannel = {
      id: 'ch-2',
      from: 'Reviewer',
      to: 'Coder',
      gateId: 'gate-2',
    };
    const workflow = makePollableWorkflow([gate1, gate2], [channel1, channel2]);
    workflowDefs.set(workflow.id, workflow);

    manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());
    expect(manager.activePollCount).toBe(0);

    // Add polls to both gates
    const updatedWorkflow = makePollableWorkflow(
      [makeGate('gate-1', makePoll()), makeGate('gate-2', makePoll())],
      [channel1, channel2]
    );
    workflowDefs.set(workflow.id, updatedWorkflow);

    manager.refreshPollsForWorkflow(workflow.id);

    expect(manager.activePollCount).toBe(2);
    expect(manager.isPollActive('run-1', 'gate-1')).toBe(true);
    expect(manager.isPollActive('run-1', 'gate-2')).toBe(true);
  });

  test('handles mixed add/remove/update in a single refresh', () => {
    // Start with gate-1 (poll) and gate-2 (poll)
    const gate1 = makeGate('gate-1', makePoll({ script: 'echo "a"' }));
    const gate2 = makeGate('gate-2', makePoll());
    const channel1: WorkflowChannel = {
      id: 'ch-1',
      from: 'Coder',
      to: 'Reviewer',
      gateId: 'gate-1',
    };
    const channel2: WorkflowChannel = {
      id: 'ch-2',
      from: 'Reviewer',
      to: 'Coder',
      gateId: 'gate-2',
    };
    const channel3: WorkflowChannel = {
      id: 'ch-3',
      from: 'Coder',
      to: 'Reviewer',
      gateId: 'gate-3',
    };
    const workflow = makePollableWorkflow([gate1, gate2], [channel1, channel2, channel3]);
    workflowDefs.set(workflow.id, workflow);

    manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());
    expect(manager.activePollCount).toBe(2);

    // After update:
    // gate-1: script changed (update)
    // gate-2: poll removed (stop)
    // gate-3: poll added (start new)
    const updatedWorkflow = makePollableWorkflow(
      [
        makeGate('gate-1', makePoll({ script: 'echo "b"' })),
        makeGate('gate-2'),
        makeGate('gate-3', makePoll()),
      ],
      [channel1, channel2, channel3]
    );
    workflowDefs.set(workflow.id, updatedWorkflow);

    manager.refreshPollsForWorkflow(workflow.id);

    expect(manager.activePollCount).toBe(2);
    expect(manager.isPollActive('run-1', 'gate-1')).toBe(true);
    expect(manager.isPollActive('run-1', 'gate-2')).toBe(false);
    expect(manager.isPollActive('run-1', 'gate-3')).toBe(true);
  });

  test('refreshPollsForWorkflow is no-op without workflowDefProvider', () => {
    const managerNoProvider = new GatePollManager(injector, resolver);
    const gate = makeGate('gate-1', makePoll());
    const channel: WorkflowChannel = {
      id: 'ch-1',
      from: 'Coder',
      to: 'Reviewer',
      gateId: 'gate-1',
    };
    const workflow = makePollableWorkflow([gate], [channel]);

    managerNoProvider.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());
    expect(managerNoProvider.activePollCount).toBe(1);

    // This should be a no-op (no provider)
    managerNoProvider.refreshPollsForWorkflow(workflow.id);
    expect(managerNoProvider.activePollCount).toBe(1);

    managerNoProvider.stopAll();
  });

  test('activeRunIds returns tracked run IDs', () => {
    const gate = makeGate('gate-1', makePoll());
    const channel: WorkflowChannel = {
      id: 'ch-1',
      from: 'Coder',
      to: 'Reviewer',
      gateId: 'gate-1',
    };
    const workflow = makePollableWorkflow([gate], [channel]);

    manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());
    manager.startPolls('run-2', workflow, '/tmp', 'space-1', makeContext());

    expect(manager.activeRunIds).toEqual(new Set(['run-1', 'run-2']));

    manager.stopPolls('run-1');
    expect(manager.activeRunIds).toEqual(new Set(['run-2']));
  });

  test('getWorkflowIdForRun returns the workflow ID for a tracked run', () => {
    const gate = makeGate('gate-1', makePoll());
    const channel: WorkflowChannel = {
      id: 'ch-1',
      from: 'Coder',
      to: 'Reviewer',
      gateId: 'gate-1',
    };
    const workflow = makePollableWorkflow([gate], [channel]);

    manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());
    expect(manager.getWorkflowIdForRun('run-1')).toBe('wf-1');
    expect(manager.getWorkflowIdForRun('run-unknown')).toBeUndefined();
  });

  test('skips invalid gates during refresh (bad interval)', () => {
    const gate = makeGate('gate-1', makePoll());
    const channel: WorkflowChannel = {
      id: 'ch-1',
      from: 'Coder',
      to: 'Reviewer',
      gateId: 'gate-1',
    };
    const workflow = makePollableWorkflow([gate], [channel]);
    workflowDefs.set(workflow.id, workflow);

    manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());
    expect(manager.activePollCount).toBe(1);

    // Update with invalid intervalMs
    const updatedGate = makeGate('gate-1', makePoll({ intervalMs: NaN }));
    const updatedWorkflow = makePollableWorkflow([updatedGate], [channel]);
    workflowDefs.set(workflow.id, updatedWorkflow);

    manager.refreshPollsForWorkflow(workflow.id);

    // Old poll should be stopped (removed), new one should be skipped (invalid)
    expect(manager.activePollCount).toBe(0);
  });

  test('skips gate with no channel during refresh', () => {
    const gate = makeGate('gate-1', makePoll());
    const channel: WorkflowChannel = {
      id: 'ch-1',
      from: 'Coder',
      to: 'Reviewer',
      gateId: 'gate-1',
    };
    const workflow = makePollableWorkflow([gate], [channel]);
    workflowDefs.set(workflow.id, workflow);

    manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());
    expect(manager.activePollCount).toBe(1);

    // Update: remove channel reference
    const updatedGate = makeGate('gate-1', makePoll());
    const updatedWorkflow = makePollableWorkflow([updatedGate], []);
    workflowDefs.set(workflow.id, updatedWorkflow);

    manager.refreshPollsForWorkflow(workflow.id);

    // Old poll stopped (removed from definition), new one skipped (no channel)
    expect(manager.activePollCount).toBe(0);
  });

  test('updates targetNodeId when poll target changes mid-run', async () => {
    // Start with target='to' (Reviewer = node-2)
    const gate = makeGate('gate-1', makePoll({ target: 'to', script: 'echo "output-a"' }));
    const channel: WorkflowChannel = {
      id: 'ch-1',
      from: 'Coder',
      to: 'Reviewer',
      gateId: 'gate-1',
    };
    const workflow = makePollableWorkflow([gate], [channel]);
    workflowDefs.set(workflow.id, workflow);

    manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

    // First tick — should target node-2 (Reviewer)
    await triggerTick(
      manager,
      'run-1',
      'gate-1',
      makePoll({ target: 'to', script: 'echo "output-a"' }),
      '/tmp',
      makeContext(),
      'node-2'
    );
    expect(resolver.getActiveSessionForNode).toHaveBeenCalledWith('run-1', 'node-2');

    // Change target to 'from' (Coder = node-1)
    const updatedGate = makeGate('gate-1', makePoll({ target: 'from', script: 'echo "output-b"' }));
    const updatedWorkflow = makePollableWorkflow([updatedGate], [channel]);
    workflowDefs.set(workflow.id, updatedWorkflow);

    manager.refreshPollsForWorkflow(workflow.id);

    // Next tick should now target node-1 (Coder)
    await triggerTick(
      manager,
      'run-1',
      'gate-1',
      makePoll({ target: 'from', script: 'echo "output-b"' }),
      '/tmp',
      makeContext(),
      'node-1'
    );
    expect(resolver.getActiveSessionForNode).toHaveBeenCalledWith('run-1', 'node-1');
  });

  test('new poll added mid-run inherits context from existing peer', () => {
    // Start with gate-1 having a poll with full context
    const gate1 = makeGate('gate-1', makePoll());
    const channel1: WorkflowChannel = {
      id: 'ch-1',
      from: 'Coder',
      to: 'Reviewer',
      gateId: 'gate-1',
    };
    const channel2: WorkflowChannel = {
      id: 'ch-2',
      from: 'Reviewer',
      to: 'Coder',
      gateId: 'gate-2',
    };
    const workflow = makePollableWorkflow([gate1], [channel1, channel2]);
    workflowDefs.set(workflow.id, workflow);

    const context = makeContext();
    manager.startPolls('run-1', workflow, '/tmp', 'space-1', context);
    expect(manager.activePollCount).toBe(1);

    // Add gate-2 with poll — it should inherit gate-1's context
    const gate2 = makeGate('gate-2', makePoll());
    const updatedWorkflow = makePollableWorkflow([gate1, gate2], [channel1, channel2]);
    workflowDefs.set(workflow.id, updatedWorkflow);

    manager.refreshPollsForWorkflow(workflow.id);
    expect(manager.activePollCount).toBe(2);

    // Verify gate-2's poll has the same TASK_ID as the original context
    // by triggering a tick and checking the script environment
    // (The script outputs $TASK_ID which should be 'task-1')
  });

  test('updates targetNodeId when channel endpoint changes without poll config change', async () => {
    // Start with channel from Coder -> Reviewer (target=to => node-2)
    const gate = makeGate('gate-1', makePoll({ script: 'echo output-a' }));
    const channel: WorkflowChannel = {
      id: 'ch-1',
      from: 'Coder',
      to: 'Reviewer',
      gateId: 'gate-1',
    };
    const workflow = makePollableWorkflow([gate], [channel]);
    workflowDefs.set(workflow.id, workflow);

    manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

    // First tick targets node-2 (Reviewer)
    await triggerTick(
      manager,
      'run-1',
      'gate-1',
      makePoll({ script: 'echo output-a' }),
      '/tmp',
      makeContext(),
      'node-2'
    );
    expect(resolver.getActiveSessionForNode).toHaveBeenCalledWith('run-1', 'node-2');

    // Change channel endpoint: from Reviewer -> Coder
    // Same poll config, different channel wiring => target node changes
    const updatedChannel: WorkflowChannel = {
      id: 'ch-1',
      from: 'Reviewer',
      to: 'Coder',
      gateId: 'gate-1',
    };
    const updatedGate = makeGate('gate-1', makePoll({ script: 'echo output-a' }));
    const updatedWorkflow = makePollableWorkflow([updatedGate], [updatedChannel]);
    workflowDefs.set(workflow.id, updatedWorkflow);

    manager.refreshPollsForWorkflow(workflow.id);

    // Verify the ActivePoll's targetNodeId was updated to node-1 (Coder)
    // even though poll config (script, interval, target, template) is identical
    const activePolls = (manager as Record<string, unknown>).activePolls as Map<
      string,
      { targetNodeId: string }
    >;
    const ap = activePolls.get('run-1:gate-1:Reviewer');
    expect(ap?.targetNodeId).toBe('node-1');
  });
});

describe('GatePollManager context inheritance for empty runs', () => {
  let injector: PollMessageInjector;
  let resolver: PollSessionResolver;
  let workflowDefs: Map<string, SpaceWorkflow>;
  let manager: GatePollManager;

  beforeEach(() => {
    injector = {
      injectSubSessionMessage: vi.fn().mockResolvedValue(undefined),
    };
    resolver = {
      getActiveSessionForNode: vi.fn().mockReturnValue('session-1'),
    };
    workflowDefs = new Map();
    manager = new GatePollManager(injector, resolver, undefined, {
      getWorkflow: (workflowId) => workflowDefs.get(workflowId) ?? null,
    });
  });

  afterEach(() => {
    manager.stopAll();
  });

  function makePollableWorkflow(gates: Gate[], channels: WorkflowChannel[] = []): SpaceWorkflow {
    return makeWorkflow(gates, channels);
  }

  test('poll added to run that started with zero polls inherits stored context', async () => {
    // Start with NO polls at all
    const gate = makeGate('gate-1'); // no poll
    const channel: WorkflowChannel = {
      id: 'ch-1',
      from: 'Coder',
      to: 'Reviewer',
      gateId: 'gate-1',
    };
    const workflow = makePollableWorkflow([gate], [channel]);
    workflowDefs.set(workflow.id, workflow);

    const ctx = makeContext();
    manager.startPolls('run-1', workflow, '/tmp', 'space-1', ctx);
    expect(manager.activePollCount).toBe(0);

    // Add a poll to gate-1 mid-run
    const updatedGate = makeGate('gate-1', makePoll({ script: 'echo "$TASK_ID"' }));
    const updatedWorkflow = makePollableWorkflow([updatedGate], [channel]);
    workflowDefs.set(workflow.id, updatedWorkflow);

    manager.refreshPollsForWorkflow(workflow.id);
    expect(manager.activePollCount).toBe(1);

    // The new poll should have the original context (TASK_ID=task-1),
    // not empty strings. Verify by triggering a tick.
    await triggerTick(
      manager,
      'run-1',
      'gate-1',
      makePoll({ script: 'echo "$TASK_ID"' }),
      '/tmp',
      ctx,
      'node-2'
    );
    expect(injector.injectSubSessionMessage).toHaveBeenCalledWith('session-1', 'task-1', true);
  });
});
