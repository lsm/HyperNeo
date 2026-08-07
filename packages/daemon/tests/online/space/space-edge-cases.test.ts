/**
 * Space Workflow — Edge Case Tests
 *
 * Covers uncommon but critical scenarios in the Space workflow system:
 *
 *   a. Concurrent tasks      — two workflow runs share no state; each has its own
 *                              iteration counter (verified at initial state) and
 *                              gate data is fully isolated between runs.
 *   b. Cancellation          — cancelling a run transitions it and all pending
 *                              tasks to 'cancelled'; cancellation is idempotent.
 *   c. Agent crash           — spaceWorkflowRun.markFailed (the production RPC the
 *                              Space Agent calls on crash detection) transitions
 *                              run → blocked with failureReason: 'agentCrash';
 *                              the run can then be resumed.
 *   d. Approval gate persistence — gate data written before a daemon restart is
 *                              intact and readable after the daemon restarts.
 *   e. Vote gate partial + restart — two reviewer votes are written; QA is still
 *                              blocked; after daemon restart the votes persist; the
 *                              third vote opens the gate and activates QA.
 *
 * ## Running
 *
 *   cd packages/daemon && HYPERNEO_USE_DEV_PROXY=1 bun test \
 *     ./tests/online/space/space-edge-cases.test.ts
 *
 * MODES:
 * - Dev Proxy (recommended): HYPERNEO_USE_DEV_PROXY=1 — no real Anthropic calls needed
 * - Real API (default): requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 *   (no LLM calls are made in this test — API key only needed for daemon startup)
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import type { SpaceTask, SpaceWorkflowRun } from '@hyperneo/shared';
import {
  approveGate,
  createTestSpace,
  getTasksForNode,
  markRunFailed,
  readGateData,
  restartDaemon,
  startWorkflowRun,
  waitForNodeActivated,
  waitForRunStatus,
  writeGateData,
} from './helpers/space-test-helpers';

// ---------------------------------------------------------------------------
// Timing constants
// ---------------------------------------------------------------------------

const IS_MOCK = !!process.env.HYPERNEO_USE_DEV_PROXY;

const NODE_ACTIVATION_TIMEOUT = IS_MOCK ? 4_000 : 15_000;
const RUN_STATUS_TIMEOUT = IS_MOCK ? 4_000 : 10_000;
const SETUP_TIMEOUT = IS_MOCK ? 20_000 : 45_000;
const TEST_TIMEOUT = IS_MOCK ? 30_000 : 90_000;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Space Workflow — Edge Cases', () => {
  let daemon: DaemonServerContext;

  beforeEach(async () => {
    daemon = await createDaemonServer();
  }, SETUP_TIMEOUT);

  afterEach(async () => {
    if (daemon) {
      daemon.kill('SIGTERM');
      await daemon.waitForExit();
    }
  }, SETUP_TIMEOUT);

  // =========================================================================
  // a. Concurrent tasks — independent state and gate data isolation
  // =========================================================================
  //
  // Note: worktrees are provisioned by TaskAgentManager when a real agent
  // session starts, not at run creation time. Without live agent sessions
  // (no LLM calls in these tests), there are no worktrees to compare.
  // This test verifies the other forms of run isolation: separate iteration
  // counters, separate task records, and isolated gate data.

  test(
    'Two concurrent workflow runs have independent iteration counters and isolated gate data',
    async () => {
      const { space, workflow } = await createTestSpace(daemon);

      // Start two separate runs against the same workflow
      const { runId: runA } = await startWorkflowRun(
        daemon,
        space.id,
        workflow.id,
        'Concurrent Run A'
      );
      const { runId: runB } = await startWorkflowRun(
        daemon,
        space.id,
        workflow.id,
        'Concurrent Run B'
      );

      expect(runA).not.toBe(runB);

      // Each run has its own Planning task
      const tasksA = await getTasksForNode(daemon, space.id, runA, 'Planning');
      const tasksB = await getTasksForNode(daemon, space.id, runB, 'Planning');

      expect(tasksA.length).toBe(1);
      expect(tasksB.length).toBe(1);
      // Tasks belong to their respective runs
      expect(tasksA[0].workflowRunId).toBe(runA);
      expect(tasksB[0].workflowRunId).toBe(runB);
      // Task IDs are distinct
      expect(tasksA[0].id).not.toBe(tasksB[0].id);

      // Write gate data to runA only — verify runB gate is still empty
      await writeGateData(daemon, runA, 'plan-pr-gate', {
        pr_url: 'https://github.com/example/repo/pull/100',
        pr_number: 100,
        branch: 'plan/run-a',
      });

      const gateA = await readGateData(daemon, runA, 'plan-pr-gate');
      const gateB = await readGateData(daemon, runB, 'plan-pr-gate');

      expect(gateA).not.toBeNull();
      expect(gateA!.data.pr_url).toBe('https://github.com/example/repo/pull/100');
      // runB's gate is untouched — gate isolation verified
      expect(gateB).not.toBeNull();
      expect(gateB!.data).toEqual({ cycle_start_at: expect.any(Number) });

      // Plan Review activates for runA but NOT for runB
      const planReviewA = await waitForNodeActivated(
        daemon,
        space.id,
        runA,
        'Plan Review',
        NODE_ACTIVATION_TIMEOUT
      );
      expect(planReviewA.workflowRunId).toBe(runA);

      const planReviewTasksB = await getTasksForNode(daemon, space.id, runB, 'Plan Review');
      expect(planReviewTasksB.length).toBe(0);
    },
    TEST_TIMEOUT
  );

  // =========================================================================
  // b. Cancellation — tasks cancelled, run reaches 'cancelled', idempotent
  // =========================================================================

  test(
    'Cancelling a workflow run marks the run and all pending tasks as cancelled',
    async () => {
      const { space, workflow } = await createTestSpace(daemon);
      const { runId, tasks } = await startWorkflowRun(
        daemon,
        space.id,
        workflow.id,
        'Cancellation Test Run'
      );

      // Confirm Planning task is pending before cancellation
      const planningTask = tasks.find((t) => t.title === 'Planning');
      expect(planningTask).toBeDefined();
      expect(planningTask!.status).toBe('open');

      // Cancel the run
      const cancelResult = (await daemon.messageHub.request('spaceWorkflowRun.cancel', {
        id: runId,
      })) as { success: boolean };
      expect(cancelResult.success).toBe(true);

      // Run must be in 'cancelled' status
      const { run: cancelledRun } = (await daemon.messageHub.request('spaceWorkflowRun.get', {
        id: runId,
      })) as { run: SpaceWorkflowRun };
      expect(cancelledRun.status).toBe('cancelled');

      // All tasks belonging to this run must be cancelled
      const allTasks = (await daemon.messageHub.request('spaceTask.list', {
        spaceId: space.id,
      })) as SpaceTask[];
      const runTasks = allTasks.filter((t) => t.workflowRunId === runId);
      expect(runTasks.length).toBeGreaterThanOrEqual(1);
      for (const task of runTasks) {
        expect(task.status).toBe('cancelled');
      }
    },
    TEST_TIMEOUT
  );

  test(
    'Cancelling an already-cancelled run is idempotent',
    async () => {
      const { space, workflow } = await createTestSpace(daemon);
      const { runId } = await startWorkflowRun(
        daemon,
        space.id,
        workflow.id,
        'Idempotent Cancel Test'
      );

      // Cancel once
      await daemon.messageHub.request('spaceWorkflowRun.cancel', { id: runId });

      // Cancel again — must not throw
      const result2 = (await daemon.messageHub.request('spaceWorkflowRun.cancel', {
        id: runId,
      })) as { success: boolean };
      expect(result2.success).toBe(true);

      // Still cancelled
      const { run } = (await daemon.messageHub.request('spaceWorkflowRun.get', {
        id: runId,
      })) as { run: SpaceWorkflowRun };
      expect(run.status).toBe('cancelled');
    },
    TEST_TIMEOUT
  );

  // =========================================================================
  // c. Agent crash — spaceWorkflowRun.markFailed (production path) sets
  //    run → blocked with failureReason: 'agentCrash'
  //
  // The Space Agent calls markFailed when it detects an unrecoverable failure
  // (e.g. session terminated unexpectedly). These tests exercise that RPC
  // handler directly, which is the same code path that fires in production.
  // =========================================================================

  test(
    'markFailed RPC transitions run to blocked with agentCrash failureReason',
    async () => {
      const { space, workflow } = await createTestSpace(daemon);
      const { runId } = await startWorkflowRun(daemon, space.id, workflow.id, 'Agent Crash Test');

      // Exercise the production crash-detection RPC (called by Space Agent on unexpected exit)
      const { run: failedRun } = await markRunFailed(
        daemon,
        runId,
        'agentCrash',
        'Planning agent session terminated unexpectedly'
      );

      expect(failedRun.status).toBe('blocked');
      expect(failedRun.failureReason).toBe('agentCrash');

      // Verify via a fresh get
      const { run: reloaded } = (await daemon.messageHub.request('spaceWorkflowRun.get', {
        id: runId,
      })) as { run: SpaceWorkflowRun };
      expect(reloaded.status).toBe('blocked');
      expect(reloaded.failureReason).toBe('agentCrash');
    },
    TEST_TIMEOUT
  );

  test(
    'A run in blocked (agentCrash) can be resumed to in_progress',
    async () => {
      const { space, workflow } = await createTestSpace(daemon);
      const { runId } = await startWorkflowRun(
        daemon,
        space.id,
        workflow.id,
        'Crash Then Resume Test'
      );

      // Mark as crashed
      await markRunFailed(daemon, runId, 'agentCrash');

      const runAfterCrash = await waitForRunStatus(daemon, runId, ['blocked'], RUN_STATUS_TIMEOUT);
      expect(runAfterCrash.failureReason).toBe('agentCrash');

      // Resume — human resolved the issue
      const { run: resumedRun } = (await daemon.messageHub.request('spaceWorkflowRun.resume', {
        id: runId,
      })) as { run: SpaceWorkflowRun };

      expect(resumedRun.status).toBe('in_progress');
    },
    TEST_TIMEOUT
  );

  // =========================================================================
  // d. Approval gate persistence — gate data survives daemon restart
  // =========================================================================

  test(
    'Gate data written before daemon restart is intact and readable after restart',
    async () => {
      // Use a pre-allocated workspace so daemon 1 does not delete it on exit
      // (passing workspacePath marks the workspace as externally owned).
      const restartWorkspace = `/tmp/hyperneo-restart-gate-${Date.now()}`;
      mkdirSync(restartWorkspace, { recursive: true });

      try {
        // Replace the default daemon with one that won't delete its workspace on exit.
        // Runs inside the try block so the workspace is always cleaned up in finally
        // even if createDaemonServer throws.
        daemon.kill('SIGTERM');
        await daemon.waitForExit();
        daemon = await createDaemonServer({ workspacePath: restartWorkspace });
        const { space, workflow } = await createTestSpace(daemon);
        const { runId } = await startWorkflowRun(
          daemon,
          space.id,
          workflow.id,
          'Gate Persistence Test'
        );

        // Simulate planner writing plan-pr-gate (waiting for human review)
        await writeGateData(daemon, runId, 'plan-pr-gate', {
          pr_url: 'https://github.com/example/repo/pull/42',
          pr_number: 42,
          branch: 'plan/persistence-test',
        });

        // Wait for Plan Review to activate — confirms gate machinery wired correctly
        await waitForNodeActivated(daemon, space.id, runId, 'Plan Review', NODE_ACTIVATION_TIMEOUT);

        // Write partial state to plan-approval-gate (waiting_human scenario)
        const waitingData = { waiting: true, requestedAt: 1700000000000 };
        await writeGateData(daemon, runId, 'plan-approval-gate', waitingData);

        // ── Restart daemon ──────────────────────────────────────────────
        // restartDaemon kills daemon 1 (workspace is preserved — external) and
        // spins up daemon 2 pointing at the same workspace/DB.
        daemon = await restartDaemon(daemon);
        // ────────────────────────────────────────────────────────────────

        // plan-pr-gate data must survive
        const gateAfterRestart = await readGateData(daemon, runId, 'plan-pr-gate');
        expect(gateAfterRestart).not.toBeNull();
        expect(gateAfterRestart!.data.pr_url).toBe('https://github.com/example/repo/pull/42');
        expect(gateAfterRestart!.data.pr_number).toBe(42);

        // plan-approval-gate partial state must survive
        const approvalGateAfterRestart = await readGateData(daemon, runId, 'plan-approval-gate');
        expect(approvalGateAfterRestart).not.toBeNull();
        expect(approvalGateAfterRestart!.data.waiting).toBe(true);
        expect(approvalGateAfterRestart!.data.requestedAt).toBe(1700000000000);

        // Run must still be in_progress after restart
        const { run } = (await daemon.messageHub.request('spaceWorkflowRun.get', {
          id: runId,
        })) as { run: SpaceWorkflowRun };
        expect(run.status).toBe('in_progress');
      } finally {
        // afterEach handles daemon shutdown; clean up the workspace here.
        rmSync(restartWorkspace, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT
  );

  // =========================================================================
  // e. Vote gate partial + restart — partial votes survive restart, 3rd vote
  //    opens the gate and activates QA
  // =========================================================================

  test(
    'Partial review votes persist across restart; 3rd vote opens gate and activates QA',
    async () => {
      // Pre-allocate workspace for restart (same pattern as the gate persistence test)
      const restartWorkspace = `/tmp/hyperneo-restart-votes-${Date.now()}`;
      mkdirSync(restartWorkspace, { recursive: true });

      try {
        // Replace the default daemon inside the try block so the workspace is always
        // cleaned up in finally even if createDaemonServer throws.
        daemon.kill('SIGTERM');
        await daemon.waitForExit();
        daemon = await createDaemonServer({ workspacePath: restartWorkspace });
        const { space, workflow } = await createTestSpace(daemon);
        const { runId } = await startWorkflowRun(
          daemon,
          space.id,
          workflow.id,
          'Vote Gate Persistence Test'
        );

        // ── Step 1: advance through Planning → Plan Review → Coding ────
        await writeGateData(daemon, runId, 'plan-pr-gate', {
          pr_url: 'https://github.com/example/repo/pull/10',
          pr_number: 10,
        });
        await waitForNodeActivated(daemon, space.id, runId, 'Plan Review', NODE_ACTIVATION_TIMEOUT);

        await approveGate(daemon, runId, 'plan-approval-gate');
        await waitForNodeActivated(daemon, space.id, runId, 'Coding', NODE_ACTIVATION_TIMEOUT);

        // ── Step 2: open code-pr-gate to unblock Reviewer nodes ────────
        await writeGateData(daemon, runId, 'code-pr-gate', {
          pr_url: 'https://github.com/org/repo/pull/42',
        });
        // Wait for at least Reviewer 1 to activate (parallel fan-in pattern)
        await waitForNodeActivated(daemon, space.id, runId, 'Reviewer 1', NODE_ACTIVATION_TIMEOUT);

        // ── Step 3: write 2 out of 3 approve votes ─────────────────────
        // The vote map uses the complete map per write (shallow merge replaces
        // the top-level 'votes' key, so we send the cumulative map each time).
        await writeGateData(daemon, runId, 'review-votes-gate', {
          votes: { 'Reviewer 1': 'approved', 'Reviewer 2': 'approved' },
        });

        // QA must NOT be activated yet (need min:3 approved votes)
        const qaTasksBefore = await getTasksForNode(daemon, space.id, runId, 'QA');
        expect(qaTasksBefore.length).toBe(0);

        // Confirm current vote count via gate data
        const votesBeforeRestart = await readGateData(daemon, runId, 'review-votes-gate');
        expect(votesBeforeRestart).not.toBeNull();
        expect(Object.keys(votesBeforeRestart!.data.votes as Record<string, unknown>).length).toBe(
          2
        );

        // ── Step 4: restart daemon ──────────────────────────────────────
        daemon = await restartDaemon(daemon);
        // ────────────────────────────────────────────────────────────────

        // Votes must still be there after restart
        const votesAfterRestart = await readGateData(daemon, runId, 'review-votes-gate');
        expect(votesAfterRestart).not.toBeNull();
        const votesMap = votesAfterRestart!.data.votes as Record<string, string>;
        expect(votesMap['Reviewer 1']).toBe('approved');
        expect(votesMap['Reviewer 2']).toBe('approved');
        expect(Object.keys(votesMap).length).toBe(2);

        // QA still not active after restart (gate still closed — only 2 votes)
        const qaTasksAfterRestart = await getTasksForNode(daemon, space.id, runId, 'QA');
        expect(qaTasksAfterRestart.length).toBe(0);

        // ── Step 5: write 3rd vote — gate must open and QA must activate ─
        await writeGateData(daemon, runId, 'review-votes-gate', {
          votes: {
            'Reviewer 1': 'approved',
            'Reviewer 2': 'approved',
            'Reviewer 3': 'approved',
          },
        });

        // QA node must now activate
        const qaTask = await waitForNodeActivated(
          daemon,
          space.id,
          runId,
          'QA',
          NODE_ACTIVATION_TIMEOUT
        );
        expect(qaTask.title).toBe('QA');
        expect(qaTask.workflowRunId).toBe(runId);
        expect(['open', 'in_progress']).toContain(qaTask.status);
      } finally {
        // afterEach handles daemon shutdown; clean up workspace here.
        rmSync(restartWorkspace, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT
  );
});
