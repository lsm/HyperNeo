/**
 * Space Happy Path — Plan-to-Approve Flow
 *
 * End-to-end integration test for the Planning → Plan Review → Coding gate sequence
 * in the TEST_FULL_CYCLE_WORKFLOW fixture.  Instead of running real LLM agents, this test
 * writes gate data directly via RPC to simulate agent actions and verify the gate/channel
 * machinery activates the correct downstream nodes.
 *
 * ## Workflow gates under test
 *
 *   plan-pr-gate       (planner writes `pr_url`)
 *     └─► Plan Review node activates when gate opens
 *   plan-approval-gate (reviewer writes `approved:true`, or human calls approveGate)
 *     └─► Coding node activates when gate opens
 *
 * ## Scenarios
 *
 * 1. Planning node is created on run start (pending task exists)
 * 2. Writing plan-pr-gate opens the gate → Plan Review activates
 * 3. plan-pr-gate is readable and contains the written data
 * 4. plan-approval-gate blocks Coding when no approval exists
 * 5. Approving plan-approval-gate → Coding node activates
 * 6. Rejecting plan-approval-gate → run transitions to blocked + humanRejected
 *
 * ## Running
 *
 *   cd packages/daemon && HYPERNEO_USE_DEV_PROXY=1 bun test \
 *     ./tests/online/space/space-happy-path-plan-to-approve.test.ts
 *
 * MODES:
 * - Dev Proxy (recommended): HYPERNEO_USE_DEV_PROXY=1 — no real Anthropic calls needed
 * - Real API (default): requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 *   (no LLM calls are made in this test — API key only needed for daemon startup)
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import {
  createTestSpace,
  startWorkflowRun,
  writeGateData,
  readGateData,
  approveGate,
  rejectGate,
  waitForNodeActivated,
  waitForRunStatus,
  getTasksForNode,
} from './helpers/space-test-helpers';

// ---------------------------------------------------------------------------
// Timing constants — shorter for mock mode since no real I/O happens
// ---------------------------------------------------------------------------

const IS_MOCK = !!process.env.HYPERNEO_USE_DEV_PROXY;

/** How long to wait for a node to appear after gate data is written */
const NODE_ACTIVATION_TIMEOUT = IS_MOCK ? 3_000 : 15_000;
/** How long to wait for run status transitions */
const RUN_STATUS_TIMEOUT = IS_MOCK ? 3_000 : 10_000;
/** Setup / teardown guard */
const SETUP_TIMEOUT = IS_MOCK ? 15_000 : 30_000;
/** Per-test timeout */
const TEST_TIMEOUT = IS_MOCK ? 20_000 : 60_000;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Space Happy Path — Plan-to-Approve Flow', () => {
  let daemon: DaemonServerContext;

  beforeEach(async () => {
    // Fresh daemon with an empty in-memory SQLite DB per test — no cross-test state.
    // Dev Proxy is not needed for the daemon itself (no LLM calls), but HYPERNEO_USE_DEV_PROXY
    // is respected for the shared dev proxy lifecycle (start/stop once per process).
    daemon = await createDaemonServer();
  }, SETUP_TIMEOUT);

  afterEach(async () => {
    if (daemon) {
      daemon.kill('SIGTERM');
      await daemon.waitForExit();
    }
  }, SETUP_TIMEOUT);

  // -------------------------------------------------------------------------
  // Test 1: Planning node activates on run start
  // -------------------------------------------------------------------------
  test(
    'Planning node is created as a pending task when the workflow run starts',
    async () => {
      const { space, workflow } = await createTestSpace(daemon);
      const { runId, tasks } = await startWorkflowRun(
        daemon,
        space.id,
        workflow.id,
        'Test run — Planning node'
      );

      // At least one pending task should exist for the Planning node.
      // The start node in TEST_FULL_CYCLE_WORKFLOW is "Planning" (planner agent).
      expect(tasks.length).toBeGreaterThanOrEqual(1);
      const planningTask = tasks.find((t) => t.title === 'Planning');
      expect(planningTask).toBeDefined();
      expect(planningTask!.status).toBe('open');
      expect(planningTask!.workflowRunId).toBe(runId);

      // Plan Review should NOT be activated yet — no plan has been submitted
      const planReviewTasks = await getTasksForNode(daemon, space.id, runId, 'Plan Review');
      expect(planReviewTasks.length).toBe(0);
    },
    TEST_TIMEOUT
  );

  // -------------------------------------------------------------------------
  // Test 2: plan-pr-gate → Plan Review activates
  // -------------------------------------------------------------------------
  test(
    'Writing pr_url to plan-pr-gate activates the Plan Review node',
    async () => {
      const { space, workflow } = await createTestSpace(daemon);
      const { runId } = await startWorkflowRun(
        daemon,
        space.id,
        workflow.id,
        'Test run — plan-pr-gate'
      );

      // Simulate the Planner agent calling write_gate("plan-pr-gate", { pr_url: ... })
      const gateRecord = await writeGateData(daemon, runId, 'plan-pr-gate', {
        pr_url: 'https://github.com/example/repo/pull/1',
        pr_number: 1,
        branch: 'plan/test-branch',
      });

      expect(gateRecord.gateId).toBe('plan-pr-gate');
      expect(gateRecord.data.pr_url).toBeDefined();

      // After writing, the channel router should have re-evaluated plan-pr-gate
      // and activated the Plan Review node (condition: pr_url exists)
      const planReviewTask = await waitForNodeActivated(
        daemon,
        space.id,
        runId,
        'Plan Review',
        NODE_ACTIVATION_TIMEOUT
      );

      expect(planReviewTask.title).toBe('Plan Review');
      expect(planReviewTask.workflowRunId).toBe(runId);
      expect(['open', 'in_progress']).toContain(planReviewTask.status);
    },
    TEST_TIMEOUT
  );

  // -------------------------------------------------------------------------
  // Test 3: readGateData returns the written data
  // -------------------------------------------------------------------------
  test(
    'readGateData returns the current gate data after a write',
    async () => {
      const { space, workflow } = await createTestSpace(daemon);
      const { runId } = await startWorkflowRun(
        daemon,
        space.id,
        workflow.id,
        'Test run — readGateData'
      );

      // Before any write, gate data should be null (or not present)
      const beforeWrite = await readGateData(daemon, runId, 'plan-pr-gate');
      expect(beforeWrite).not.toBeNull();
      expect(beforeWrite!.data).toEqual({ cycle_start_at: expect.any(Number) });

      await writeGateData(daemon, runId, 'plan-pr-gate', {
        pr_url: 'https://github.com/example/repo/pull/42',
        pr_number: 42,
        branch: 'plan/feature-x',
      });

      const afterWrite = await readGateData(daemon, runId, 'plan-pr-gate');
      expect(afterWrite).not.toBeNull();
      expect(afterWrite!.gateId).toBe('plan-pr-gate');
      expect(afterWrite!.data.pr_url).toBe('https://github.com/example/repo/pull/42');
      expect(afterWrite!.data.pr_number).toBe(42);
      expect(afterWrite!.data.branch).toBe('plan/feature-x');
    },
    TEST_TIMEOUT
  );

  // -------------------------------------------------------------------------
  // Test 4: plan-approval-gate blocks Coding until approved
  // -------------------------------------------------------------------------
  test(
    'plan-approval-gate blocks Coding node until approval is written',
    async () => {
      const { space, workflow } = await createTestSpace(daemon);
      const { runId } = await startWorkflowRun(
        daemon,
        space.id,
        workflow.id,
        'Test run — plan-approval-gate blocks'
      );

      // Open plan-pr-gate to activate Plan Review
      await writeGateData(daemon, runId, 'plan-pr-gate', {
        pr_url: 'https://github.com/example/repo/pull/2',
      });

      // Wait for Plan Review to activate (plan-pr-gate opened)
      await waitForNodeActivated(daemon, space.id, runId, 'Plan Review', NODE_ACTIVATION_TIMEOUT);

      // Coding should NOT be active — plan-approval-gate is still blocked
      const codingTasksBefore = await getTasksForNode(daemon, space.id, runId, 'Coding');
      expect(codingTasksBefore.length).toBe(0);

      // Verify plan-approval-gate has no data yet
      const approvalGate = await readGateData(daemon, runId, 'plan-approval-gate');
      expect(approvalGate).not.toBeNull();
      expect(approvalGate!.data).toEqual({ cycle_start_at: expect.any(Number) });
    },
    TEST_TIMEOUT
  );

  // -------------------------------------------------------------------------
  // Test 5: Approval → Coding activates
  // -------------------------------------------------------------------------
  test(
    'Approving plan-approval-gate activates the Coding node',
    async () => {
      const { space, workflow } = await createTestSpace(daemon);
      const { runId } = await startWorkflowRun(
        daemon,
        space.id,
        workflow.id,
        'Test run — approve to coding'
      );

      // Step 1: Open plan-pr-gate (simulate planner done)
      await writeGateData(daemon, runId, 'plan-pr-gate', {
        pr_url: 'https://github.com/example/repo/pull/3',
      });

      // Step 2: Wait for Plan Review to activate
      await waitForNodeActivated(daemon, space.id, runId, 'Plan Review', NODE_ACTIVATION_TIMEOUT);

      // Step 3: Approve plan-approval-gate (simulate reviewer approved)
      const { run: updatedRun, gateData } = await approveGate(daemon, runId, 'plan-approval-gate');

      expect(gateData.data.approved).toBe(true);
      expect(gateData.data.approvedAt).toBeDefined();
      // Run should still be in_progress after approval (Coding is now active)
      expect(updatedRun.status).toBe('in_progress');

      // Step 4: Coding node should now be active
      const codingTask = await waitForNodeActivated(
        daemon,
        space.id,
        runId,
        'Coding',
        NODE_ACTIVATION_TIMEOUT
      );

      expect(codingTask.title).toBe('Coding');
      expect(codingTask.workflowRunId).toBe(runId);
      expect(['open', 'in_progress']).toContain(codingTask.status);
    },
    TEST_TIMEOUT
  );

  // -------------------------------------------------------------------------
  // Test 6: Rejection → blocked with humanRejected
  // -------------------------------------------------------------------------
  test(
    'Rejecting plan-approval-gate transitions run to blocked with humanRejected',
    async () => {
      const { space, workflow } = await createTestSpace(daemon);
      const { runId } = await startWorkflowRun(
        daemon,
        space.id,
        workflow.id,
        'Test run — rejection flow'
      );

      // Open plan-pr-gate so the run has something to reject
      await writeGateData(daemon, runId, 'plan-pr-gate', {
        pr_url: 'https://github.com/example/repo/pull/4',
      });

      await waitForNodeActivated(daemon, space.id, runId, 'Plan Review', NODE_ACTIVATION_TIMEOUT);

      // Reject the plan-approval-gate
      const { run: rejectedRun, gateData: rejectedGate } = await rejectGate(
        daemon,
        runId,
        'plan-approval-gate',
        'Plan needs more detail on implementation approach'
      );

      // Gate data should reflect the rejection
      expect(rejectedGate.data.approved).toBe(false);
      expect(rejectedGate.data.rejectedAt).toBeDefined();
      expect(rejectedGate.data.reason).toBe('Plan needs more detail on implementation approach');

      // Run must be in blocked with humanRejected
      expect(rejectedRun.status).toBe('blocked');
      expect(rejectedRun.failureReason).toBe('humanRejected');

      // Coding must NOT have been activated
      const codingTasks = await getTasksForNode(daemon, space.id, runId, 'Coding');
      expect(codingTasks.length).toBe(0);

      // Confirm via polling helper too
      const finalRun = await waitForRunStatus(daemon, runId, ['blocked'], RUN_STATUS_TIMEOUT);
      expect(finalRun.failureReason).toBe('humanRejected');
    },
    TEST_TIMEOUT
  );

  // -------------------------------------------------------------------------
  // Test 7: Re-approve after rejection resumes the run
  // -------------------------------------------------------------------------
  test(
    'Approving after a rejection resumes the run and activates Coding',
    async () => {
      const { space, workflow } = await createTestSpace(daemon);
      const { runId } = await startWorkflowRun(
        daemon,
        space.id,
        workflow.id,
        'Test run — re-approve after rejection'
      );

      // Open plan-pr-gate
      await writeGateData(daemon, runId, 'plan-pr-gate', {
        pr_url: 'https://github.com/example/repo/pull/5',
      });
      await waitForNodeActivated(daemon, space.id, runId, 'Plan Review', NODE_ACTIVATION_TIMEOUT);

      // Reject first
      await rejectGate(daemon, runId, 'plan-approval-gate', 'Needs revision');
      const afterReject = await waitForRunStatus(daemon, runId, ['blocked'], RUN_STATUS_TIMEOUT);
      expect(afterReject.failureReason).toBe('humanRejected');

      // Now approve (overrides rejection)
      const { run: resumedRun, gateData: approvedGate } = await approveGate(
        daemon,
        runId,
        'plan-approval-gate'
      );

      // Run must be back to in_progress with no failureReason
      expect(resumedRun.status).toBe('in_progress');
      // failureReason is cleared to null in DB; may deserialize as null or undefined
      expect(resumedRun.failureReason ?? null).toBeNull();
      expect(approvedGate.data.approved).toBe(true);

      // Coding should now activate
      const codingTask = await waitForNodeActivated(
        daemon,
        space.id,
        runId,
        'Coding',
        NODE_ACTIVATION_TIMEOUT
      );
      expect(codingTask.title).toBe('Coding');
    },
    TEST_TIMEOUT
  );

  // -------------------------------------------------------------------------
  // Test 8: Idempotent double-approve
  // -------------------------------------------------------------------------
  test(
    'Approving an already-approved gate is idempotent and does not cause errors',
    async () => {
      const { space, workflow } = await createTestSpace(daemon);
      const { runId } = await startWorkflowRun(
        daemon,
        space.id,
        workflow.id,
        'Test run — idempotent approve'
      );

      await writeGateData(daemon, runId, 'plan-pr-gate', {
        pr_url: 'https://github.com/example/repo/pull/6',
      });
      await waitForNodeActivated(daemon, space.id, runId, 'Plan Review', NODE_ACTIVATION_TIMEOUT);

      // Approve twice
      const first = await approveGate(daemon, runId, 'plan-approval-gate');
      const second = await approveGate(daemon, runId, 'plan-approval-gate');

      expect(first.gateData.data.approved).toBe(true);
      expect(second.gateData.data.approved).toBe(true);
      // Both calls should return the same gate data (idempotent)
      expect(first.gateData.data.approvedAt).toBe(second.gateData.data.approvedAt);
      // Run stays in_progress
      expect(second.run.status).toBe('in_progress');
    },
    TEST_TIMEOUT
  );
});
