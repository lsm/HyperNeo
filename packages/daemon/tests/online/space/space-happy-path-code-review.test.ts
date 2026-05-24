/**
 * Space Happy Path — Code Review with Parallel Reviewers
 *
 * Integration tests for the Coding → code-pr-gate → 3 Reviewers (parallel) →
 * review-votes-gate segment of the TEST_FULL_CYCLE_WORKFLOW fixture.
 *
 * No real LLM sessions are started. Gate data is written directly via RPC to
 * simulate agent actions, exercising the gate/channel machinery deterministically.
 *
 * ## Workflow segment under test
 *
 *   code-pr-gate     (coder writes `pr_url`)
 *     └─► Reviewer 1, Reviewer 2, Reviewer 3 activate simultaneously
 *   review-votes-gate (all 3 write `approved` votes; count >= 3)
 *     └─► QA node activates
 *   review-reject-gate (any reviewer writes `rejected` vote; count >= 1)
 *     └─► Coding re-activates (cyclic), iteration counter increments
 *
 * ## Scenarios
 *
 *  1. Writing pr_url to code-pr-gate activates all 3 reviewers in parallel
 *  2. code-pr-gate data is readable after write
 *  3. Partial approval (2/3) → review-votes-gate stays blocked, QA not activated
 *  4. All 3 approve → review-votes-gate opens → QA activates
 *  5. Single rejection → review-reject-gate opens → Coding re-activates (cyclic)
 *  6. Iteration counter increments when a reject cycle fires
 *  7. review-votes-gate resets after a reject cycle (resetOnCycle = true)
 *  8. Max iterations cap prevents further reject cycles
 *  9. Reviewers not activated before code-pr-gate is written
 * 10. review-reject-gate opens with just 1 rejected vote (min: 1)
 * 11. Run stays in_progress during the entire review phase
 * 12. QA passes → qa-result-gate → Done activates (full happy-path tail)
 *
 * ## Running
 *
 *   cd packages/daemon && NEOKAI_USE_DEV_PROXY=1 bun test \
 *     ./tests/online/space/space-happy-path-code-review.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import type { SpaceWorkflow, SpaceWorkflowRun } from '@neokai/shared';
import {
  createTestSpace,
  startWorkflowRun,
  writeGateData,
  readGateData,
  approveGate,
  waitForNodeActivated,
  waitForNewNodeTask,
  waitForRunStatus,
  getTasksForNode,
  mockAgentDone,
} from './helpers/space-test-helpers';

// ---------------------------------------------------------------------------
// Timing constants
// ---------------------------------------------------------------------------

const IS_MOCK = !!process.env.NEOKAI_USE_DEV_PROXY;

const NODE_ACTIVATION_TIMEOUT = IS_MOCK ? 3_000 : 15_000;
const RUN_STATUS_TIMEOUT = IS_MOCK ? 3_000 : 10_000;
const SETUP_TIMEOUT = IS_MOCK ? 15_000 : 30_000;
const TEST_TIMEOUT = IS_MOCK ? 25_000 : 90_000;

// ---------------------------------------------------------------------------
// Shared test fixture setup
// ---------------------------------------------------------------------------

/**
 * Brings the run to the point where code-pr-gate has been written and all
 * three reviewer nodes should be activating.
 *
 * Mirrors real agent behavior:
 *   1. Create space + start run  (optionally set maxCycles on the Code Review channel first)
 *   2. Open plan-pr-gate (simulate planner done)
 *   3. Wait for Plan Review to activate, then complete it
 *   4. Approve plan-approval-gate (simulate reviewer approved)
 *   5. Wait for Coding to activate
 *   6. Complete the Coding task (simulate coder finishing — agent completes before writing gate)
 *   7. Write code-pr-gate (simulate coder writing PR URL after completing work)
 *
 * Completing the Coding task in step 6 is essential: without it the cyclic channel sees
 * an active node and skips activation — so no new Coding task would be created on rejection.
 * Completing the task first lets the cyclic channel create a fresh Coding task on rejection.
 *
 * @param maxIterationsOverride  When set, patches the `maxCycles` on the `Code Review → Coding`
 *   channel (the one with `gateId: 'review-reject-gate'`) via `spaceWorkflow.update`.
 */
async function setupToCodePrGate(
  daemon: DaemonServerContext,
  options?: { maxIterationsOverride?: number }
): Promise<{ spaceId: string; runId: string }> {
  const { space, workflow } = await createTestSpace(daemon);

  // Optionally cap cycles on the Code Review → Coding channel before starting the run.
  // We fetch the current workflow, find the channel with gateId 'review-reject-gate',
  // and set maxCycles on it via spaceWorkflow.update.
  if (options?.maxIterationsOverride !== undefined) {
    const { workflow: currentWorkflow } = (await daemon.messageHub.request('spaceWorkflow.get', {
      id: workflow.id,
    })) as { workflow: SpaceWorkflow };
    const updatedChannels = (currentWorkflow.channels ?? []).map((ch) =>
      ch.gateId === 'review-reject-gate' ? { ...ch, maxCycles: options.maxIterationsOverride! } : ch
    );
    await daemon.messageHub.request('spaceWorkflow.update', {
      id: workflow.id,
      channels: updatedChannels,
    });
  }

  const { runId } = await startWorkflowRun(daemon, space.id, workflow.id, 'Code-review test run');

  // Open plan-pr-gate → Plan Review activates
  await writeGateData(daemon, runId, 'plan-pr-gate', {
    pr_url: 'https://github.com/example/repo/pull/10',
    pr_number: 10,
    branch: 'plan/test-feature',
  });
  const planReviewTask = await waitForNodeActivated(
    daemon,
    space.id,
    runId,
    'Plan Review',
    NODE_ACTIVATION_TIMEOUT
  );
  // Complete Plan Review task so it doesn't block future gate resets
  await mockAgentDone(daemon, space.id, planReviewTask.id);

  // Approve plan-approval-gate → Coding activates
  await approveGate(daemon, runId, 'plan-approval-gate');
  const codingTask = await waitForNodeActivated(
    daemon,
    space.id,
    runId,
    'Coding',
    NODE_ACTIVATION_TIMEOUT
  );

  // Complete the Coding task before writing code-pr-gate.
  // This mirrors real agent behavior: the agent finishes work, then writes the gate.
  // It is also required for reject cycles: `onGateDataChanged` only increments the
  // iteration counter when a node is *newly* activated. If the Coding task is still
  // pending, the cyclic channel sees an active node and skips activation + counter.
  await mockAgentDone(daemon, space.id, codingTask.id, 'PR opened at feat/test-feature');

  // Coder writes code-pr-gate (triggers Reviewer 1/2/3 activation in parallel)
  await writeGateData(daemon, runId, 'code-pr-gate', {
    pr_url: 'https://github.com/org/repo/pull/42',
  });

  return { spaceId: space.id, runId };
}

/**
 * Complete all three reviewer tasks and write rejection vote to review-reject-gate,
 * then wait for a *new* Coding task to appear (not the one in preCycleTaskIds).
 *
 * Returns the newly activated Coding task and the IDs of the done reviewer tasks.
 */
async function triggerRejectCycle(
  daemon: DaemonServerContext,
  spaceId: string,
  runId: string,
  preCycleCodingTaskIds: Set<string>,
  rejectingReviewer: string
): Promise<SpaceTask> {
  // Complete all reviewer tasks so the Coding node has no active tasks when the
  // cyclic channel fires. Without this, onGateDataChanged sees the pending reviewer
  // tasks and skips incrementAndResetCyclicGates.
  for (const reviewerName of ['Reviewer 1', 'Reviewer 2', 'Reviewer 3']) {
    const tasks = await getTasksForNode(daemon, spaceId, runId, reviewerName);
    for (const t of tasks) {
      if (t.status !== 'done') {
        await mockAgentDone(daemon, spaceId, t.id);
      }
    }
  }

  await writeGateData(daemon, runId, 'review-reject-gate', {
    votes: { [rejectingReviewer]: 'rejected' },
  });

  // Use waitForNewNodeTask to confirm a *fresh* Coding task was created,
  // not the old done task. waitForNodeActivated would match the old task
  // because it accepts terminal statuses (including 'done').
  return waitForNewNodeTask(
    daemon,
    spaceId,
    runId,
    'Coding',
    preCycleCodingTaskIds,
    NODE_ACTIVATION_TIMEOUT
  );
}

// ---------------------------------------------------------------------------
// Type alias for readability
// ---------------------------------------------------------------------------

// SpaceTask is only used as a return type inside test helpers; the import
// comes from @neokai/shared via the helper module — no direct import needed.
type SpaceTask = Awaited<ReturnType<typeof getTasksForNode>>[number];

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Space Happy Path — Code Review with Parallel Reviewers', () => {
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

  // -------------------------------------------------------------------------
  // Test 1: All 3 reviewers activate simultaneously after code-pr-gate opens
  // -------------------------------------------------------------------------
  test(
    'Writing pr_url to code-pr-gate activates all 3 reviewer nodes simultaneously',
    async () => {
      const { spaceId, runId } = await setupToCodePrGate(daemon);

      // All three reviewer nodes must activate after code-pr-gate is written.
      // Use Promise.all to confirm they all come up within the same timeout window,
      // demonstrating parallel (not sequential) activation.
      const [r1, r2, r3] = await Promise.all([
        waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 1', NODE_ACTIVATION_TIMEOUT),
        waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 2', NODE_ACTIVATION_TIMEOUT),
        waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 3', NODE_ACTIVATION_TIMEOUT),
      ]);

      expect(r1.title).toBe('Reviewer 1');
      expect(r2.title).toBe('Reviewer 2');
      expect(r3.title).toBe('Reviewer 3');
      for (const task of [r1, r2, r3]) {
        expect(task.workflowRunId).toBe(runId);
        expect(['open', 'in_progress']).toContain(task.status);
      }

      // QA must NOT be active yet — review-votes-gate still blocked
      const qaTasks = await getTasksForNode(daemon, spaceId, runId, 'QA');
      expect(qaTasks.length).toBe(0);
    },
    TEST_TIMEOUT
  );

  // -------------------------------------------------------------------------
  // Test 2: code-pr-gate data is readable and contains the pr_url field
  // -------------------------------------------------------------------------
  test(
    'code-pr-gate data is readable after coder writes it',
    async () => {
      const { runId } = await setupToCodePrGate(daemon);

      const gate = await readGateData(daemon, runId, 'code-pr-gate');
      expect(gate).not.toBeNull();
      expect(gate!.gateId).toBe('code-pr-gate');
      expect(gate!.data.pr_url).toBe('https://github.com/org/repo/pull/42');
    },
    TEST_TIMEOUT
  );

  // -------------------------------------------------------------------------
  // Test 3: Partial approval (2/3) — review-votes-gate stays blocked
  // -------------------------------------------------------------------------
  test(
    'Partial approval (2 out of 3 votes) does not open review-votes-gate',
    async () => {
      const { spaceId, runId } = await setupToCodePrGate(daemon);

      // Wait for all reviewers to activate
      await Promise.all([
        waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 1', NODE_ACTIVATION_TIMEOUT),
        waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 2', NODE_ACTIVATION_TIMEOUT),
        waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 3', NODE_ACTIVATION_TIMEOUT),
      ]);

      // Reviewer 1 votes approved
      await writeGateData(daemon, runId, 'review-votes-gate', {
        votes: { 'Reviewer 1': 'approved' },
      });

      // Reviewer 2 votes approved (read-merge-write: include existing votes)
      await writeGateData(daemon, runId, 'review-votes-gate', {
        votes: { 'Reviewer 1': 'approved', 'Reviewer 2': 'approved' },
      });

      // Gate has 2 approvals — condition requires min: 3. QA must NOT activate.
      const voteGate = await readGateData(daemon, runId, 'review-votes-gate');
      expect(voteGate).not.toBeNull();
      expect(voteGate!.data.votes).toEqual({
        'Reviewer 1': 'approved',
        'Reviewer 2': 'approved',
      });

      // QA must remain inactive
      const qaTasks = await getTasksForNode(daemon, spaceId, runId, 'QA');
      expect(qaTasks.length).toBe(0);
    },
    TEST_TIMEOUT
  );

  // -------------------------------------------------------------------------
  // Test 4: All 3 approve → review-votes-gate opens → QA activates
  // -------------------------------------------------------------------------
  test(
    'All 3 reviewers approving opens review-votes-gate and activates QA',
    async () => {
      const { spaceId, runId } = await setupToCodePrGate(daemon);

      await Promise.all([
        waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 1', NODE_ACTIVATION_TIMEOUT),
        waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 2', NODE_ACTIVATION_TIMEOUT),
        waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 3', NODE_ACTIVATION_TIMEOUT),
      ]);

      // All three vote approved (read-merge-write pattern)
      await writeGateData(daemon, runId, 'review-votes-gate', {
        votes: { 'Reviewer 1': 'approved' },
      });
      await writeGateData(daemon, runId, 'review-votes-gate', {
        votes: { 'Reviewer 1': 'approved', 'Reviewer 2': 'approved' },
      });
      await writeGateData(daemon, runId, 'review-votes-gate', {
        votes: {
          'Reviewer 1': 'approved',
          'Reviewer 2': 'approved',
          'Reviewer 3': 'approved',
        },
      });

      // QA must now activate — review-votes-gate condition (count >= 3) satisfied
      const qaTask = await waitForNodeActivated(
        daemon,
        spaceId,
        runId,
        'QA',
        NODE_ACTIVATION_TIMEOUT
      );

      expect(qaTask.title).toBe('QA');
      expect(qaTask.workflowRunId).toBe(runId);
      expect(['open', 'in_progress']).toContain(qaTask.status);

      // Run is still in_progress — QA hasn't finished yet
      const { run } = (await daemon.messageHub.request('spaceWorkflowRun.get', {
        id: runId,
      })) as { run: SpaceWorkflowRun };
      expect(run.status).toBe('in_progress');
    },
    TEST_TIMEOUT
  );

  // -------------------------------------------------------------------------
  // Test 5: Any reviewer rejects → review-reject-gate fires → Coding re-activates
  // -------------------------------------------------------------------------
  test(
    'A single reviewer rejection opens review-reject-gate and cycles back to Coding',
    async () => {
      const { spaceId, runId } = await setupToCodePrGate(daemon);

      await Promise.all([
        waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 1', NODE_ACTIVATION_TIMEOUT),
        waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 2', NODE_ACTIVATION_TIMEOUT),
        waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 3', NODE_ACTIVATION_TIMEOUT),
      ]);

      // Collect existing Coding task IDs (done from setup) so we can confirm
      // the post-cycle Coding task is genuinely new (not the old done one).
      const existingCodingTasks = await getTasksForNode(daemon, spaceId, runId, 'Coding');
      const preCycleIds = new Set(existingCodingTasks.map((t) => t.id));

      const codingTask = await triggerRejectCycle(
        daemon,
        spaceId,
        runId,
        preCycleIds,
        'Reviewer 1'
      );

      expect(codingTask.title).toBe('Coding');
      expect(codingTask.workflowRunId).toBe(runId);
      expect(['open', 'in_progress']).toContain(codingTask.status);

      // QA must NOT have activated — the happy path did not complete
      const qaTasks = await getTasksForNode(daemon, spaceId, runId, 'QA');
      expect(qaTasks.length).toBe(0);

      // Run must remain in_progress (not blocked — rejection is a cycle, not a human-reject)
      const { run } = (await daemon.messageHub.request('spaceWorkflowRun.get', {
        id: runId,
      })) as { run: SpaceWorkflowRun };
      expect(run.status).toBe('in_progress');
    },
    TEST_TIMEOUT
  );

  // -------------------------------------------------------------------------
  // Test 6: A reject cycle creates a new Coding task
  // -------------------------------------------------------------------------
  test(
    'A reject cycle via review-reject-gate creates a new Coding task',
    async () => {
      const { spaceId, runId } = await setupToCodePrGate(daemon);

      await Promise.all([
        waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 1', NODE_ACTIVATION_TIMEOUT),
        waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 2', NODE_ACTIVATION_TIMEOUT),
        waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 3', NODE_ACTIVATION_TIMEOUT),
      ]);

      const existingCodingTasks = await getTasksForNode(daemon, spaceId, runId, 'Coding');
      const preCycleIds = new Set(existingCodingTasks.map((t) => t.id));

      const newCodingTask = await triggerRejectCycle(
        daemon,
        spaceId,
        runId,
        preCycleIds,
        'Reviewer 2'
      );

      // A fresh Coding task must have been created by the reject cycle
      expect(newCodingTask).toBeDefined();
      expect(newCodingTask.title).toBe('Coding');
      expect(['open', 'in_progress']).toContain(newCodingTask.status);
    },
    TEST_TIMEOUT
  );

  // -------------------------------------------------------------------------
  // Test 7: review-votes-gate resets after a reject cycle (resetOnCycle: true)
  // -------------------------------------------------------------------------
  test(
    'review-votes-gate is reset after a reject cycle so reviewers must re-vote',
    async () => {
      const { spaceId, runId } = await setupToCodePrGate(daemon);

      await Promise.all([
        waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 1', NODE_ACTIVATION_TIMEOUT),
        waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 2', NODE_ACTIVATION_TIMEOUT),
        waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 3', NODE_ACTIVATION_TIMEOUT),
      ]);

      // Write partial approvals to review-votes-gate before the cycle
      await writeGateData(daemon, runId, 'review-votes-gate', {
        votes: { 'Reviewer 1': 'approved', 'Reviewer 2': 'approved' },
      });

      const existingCodingTasks = await getTasksForNode(daemon, spaceId, runId, 'Coding');
      const preCycleIds = new Set(existingCodingTasks.map((t) => t.id));

      // Trigger reject cycle — Reviewer 3 rejects
      await triggerRejectCycle(daemon, spaceId, runId, preCycleIds, 'Reviewer 3');

      // review-votes-gate must have been reset to its default data ({})
      // After reset, either no record exists or the record data equals the gate's
      // default (empty object — no `votes` field).
      const votesGate = await readGateData(daemon, runId, 'review-votes-gate');
      if (votesGate !== null) {
        // The gate was reset to {} — the `votes` key should be absent or empty
        const votes = votesGate.data.votes as Record<string, string> | undefined;
        expect(votes == null || Object.keys(votes).length === 0).toBe(true);
      }
      // QA still not activated — review-votes-gate was reset, needs 3 new approvals
      const qaTasks = await getTasksForNode(daemon, spaceId, runId, 'QA');
      expect(qaTasks.length).toBe(0);
    },
    TEST_TIMEOUT
  );

  // -------------------------------------------------------------------------
  // Test 8: Max iterations cap prevents further reject cycles
  // -------------------------------------------------------------------------
  test(
    'Reject cycles stop being accepted once the channel maxCycles cap is reached',
    async () => {
      // Set maxCycles=1 on the Code Review → Coding channel before starting the run.
      // The cap is enforced per-channel via WorkflowChannel.maxCycles.
      const { spaceId, runId } = await setupToCodePrGate(daemon, {
        maxIterationsOverride: 1,
      });

      // ── First reject cycle: should succeed (cycles 0 → 1) ────────────────
      await Promise.all([
        waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 1', NODE_ACTIVATION_TIMEOUT),
        waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 2', NODE_ACTIVATION_TIMEOUT),
        waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 3', NODE_ACTIVATION_TIMEOUT),
      ]);

      const existingCodingTasksBeforeCycle1 = await getTasksForNode(
        daemon,
        spaceId,
        runId,
        'Coding'
      );
      const preFirstCycleIds = new Set(existingCodingTasksBeforeCycle1.map((t) => t.id));

      const newCodingTask = await triggerRejectCycle(
        daemon,
        spaceId,
        runId,
        preFirstCycleIds,
        'Reviewer 1'
      );

      // ── Second reject cycle: must be blocked (channel maxCycles reached) ──
      // Complete the new Coding task so the node has no active tasks.
      // This ensures the router can check the cycle cap (not hide behind the
      // node-idempotency guard). With the cap enforced, onGateDataChanged throws
      // ActivationError which is caught internally by fireGateChanged and logged.
      await mockAgentDone(daemon, spaceId, newCodingTask.id, 'PR updated');

      // Write code-pr-gate again so reviewers re-activate for the second round
      await writeGateData(daemon, runId, 'code-pr-gate', {
        pr_url: 'https://github.com/org/repo/pull/42',
      });

      // Complete the new reviewer tasks so they're not blocking activation
      for (const name of ['Reviewer 1', 'Reviewer 2', 'Reviewer 3']) {
        const reviewerTasks = await getTasksForNode(daemon, spaceId, runId, name);
        const active = reviewerTasks.filter(
          (t) => t.status === 'open' || t.status === 'in_progress'
        );
        for (const t of active) {
          await mockAgentDone(daemon, spaceId, t.id);
        }
      }

      // Record all existing Coding task IDs — no new one should appear
      const allCodingTasksBefore = await getTasksForNode(daemon, spaceId, runId, 'Coding');
      const codingTaskIdsBefore = new Set(allCodingTasksBefore.map((t) => t.id));

      // Attempt second reject — fireGateChanged is fire-and-forget; ActivationError
      // is logged internally (not propagated). The assertion confirms no new
      // Coding task appears within the full activation timeout.
      await writeGateData(daemon, runId, 'review-reject-gate', {
        votes: { 'Reviewer 1': 'rejected' },
      });

      // Poll for the full NODE_ACTIVATION_TIMEOUT to confirm no new Coding task appears.
      // fireGateChanged is async but in-process; if a new task were to appear it would
      // do so quickly. Waiting the full timeout gives a strict negative guarantee.
      const deadline = Date.now() + NODE_ACTIVATION_TIMEOUT;
      let unexpectedTask: SpaceTask | undefined;
      while (Date.now() < deadline) {
        const codingTasks = await getTasksForNode(daemon, spaceId, runId, 'Coding');
        unexpectedTask = codingTasks.find(
          (t) =>
            !codingTaskIdsBefore.has(t.id) && (t.status === 'open' || t.status === 'in_progress')
        );
        if (unexpectedTask) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      expect(unexpectedTask).toBeUndefined();
    },
    TEST_TIMEOUT
  );

  // -------------------------------------------------------------------------
  // Test 9: Reviewers not activated before code-pr-gate is written
  // -------------------------------------------------------------------------
  test(
    'Reviewer nodes are not activated before code-pr-gate is written',
    async () => {
      const { space, workflow } = await createTestSpace(daemon);
      const { runId } = await startWorkflowRun(
        daemon,
        space.id,
        workflow.id,
        'Reviewers-blocked test run'
      );

      // Open plan-pr-gate and approve plan-approval-gate to reach Coding
      await writeGateData(daemon, runId, 'plan-pr-gate', {
        pr_url: 'https://github.com/example/repo/pull/12',
      });
      await waitForNodeActivated(daemon, space.id, runId, 'Plan Review', NODE_ACTIVATION_TIMEOUT);
      await approveGate(daemon, runId, 'plan-approval-gate');
      await waitForNodeActivated(daemon, space.id, runId, 'Coding', NODE_ACTIVATION_TIMEOUT);

      // code-pr-gate has NOT been written yet — reviewers must be inactive
      for (const reviewerName of ['Reviewer 1', 'Reviewer 2', 'Reviewer 3']) {
        const reviewerTasks = await getTasksForNode(daemon, space.id, runId, reviewerName);
        expect(reviewerTasks.length).toBe(0);
      }

      // Verify gate data is absent
      const codePrGate = await readGateData(daemon, runId, 'code-pr-gate');
      expect(codePrGate).toBeNull();
    },
    TEST_TIMEOUT
  );

  // -------------------------------------------------------------------------
  // Test 10: review-reject-gate opens with just 1 rejected vote (min: 1)
  // -------------------------------------------------------------------------
  test(
    'review-reject-gate opens with just 1 rejected vote (min: 1)',
    async () => {
      const { spaceId, runId } = await setupToCodePrGate(daemon);

      await Promise.all([
        waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 1', NODE_ACTIVATION_TIMEOUT),
        waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 2', NODE_ACTIVATION_TIMEOUT),
        waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 3', NODE_ACTIVATION_TIMEOUT),
      ]);

      const existingCodingTasks = await getTasksForNode(daemon, spaceId, runId, 'Coding');
      const preCycleIds = new Set(existingCodingTasks.map((t) => t.id));

      // Reviewer 3 is the only one to reject — that is enough (min: 1)
      const codingTask = await triggerRejectCycle(
        daemon,
        spaceId,
        runId,
        preCycleIds,
        'Reviewer 3'
      );
      expect(codingTask.title).toBe('Coding');
      expect(['open', 'in_progress']).toContain(codingTask.status);
    },
    TEST_TIMEOUT
  );

  // -------------------------------------------------------------------------
  // Test 11: Run stays in_progress during the entire review phase
  // -------------------------------------------------------------------------
  test(
    'Run status remains in_progress throughout the review phase',
    async () => {
      const { runId } = await setupToCodePrGate(daemon);

      // Immediately after code-pr-gate is written, run is still in_progress
      const { run } = (await daemon.messageHub.request('spaceWorkflowRun.get', {
        id: runId,
      })) as { run: SpaceWorkflowRun };
      expect(run.status).toBe('in_progress');

      // Also verify after run status poll helper
      const polled = await waitForRunStatus(daemon, runId, ['in_progress'], RUN_STATUS_TIMEOUT);
      expect(polled.status).toBe('in_progress');
    },
    TEST_TIMEOUT
  );

  // -------------------------------------------------------------------------
  // Test 12: Full happy-path tail — QA passes → qa-result-gate → Done activates
  // -------------------------------------------------------------------------
  test(
    'QA writing passed to qa-result-gate opens it and activates Done node',
    async () => {
      const { spaceId, runId } = await setupToCodePrGate(daemon);

      // Advance through full review: all 3 approve
      const [r1, r2, r3] = await Promise.all([
        waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 1', NODE_ACTIVATION_TIMEOUT),
        waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 2', NODE_ACTIVATION_TIMEOUT),
        waitForNodeActivated(daemon, spaceId, runId, 'Reviewer 3', NODE_ACTIVATION_TIMEOUT),
      ]);
      await mockAgentDone(daemon, spaceId, r1.id);
      await mockAgentDone(daemon, spaceId, r2.id);
      await mockAgentDone(daemon, spaceId, r3.id);

      await writeGateData(daemon, runId, 'review-votes-gate', {
        votes: {
          'Reviewer 1': 'approved',
          'Reviewer 2': 'approved',
          'Reviewer 3': 'approved',
        },
      });

      // QA activates after review-votes-gate opens
      const qaTask = await waitForNodeActivated(
        daemon,
        spaceId,
        runId,
        'QA',
        NODE_ACTIVATION_TIMEOUT
      );
      expect(qaTask.title).toBe('QA');

      // Done must NOT be active yet — qa-result-gate is still blocked
      const doneBefore = await getTasksForNode(daemon, spaceId, runId, 'Done');
      expect(doneBefore.length).toBe(0);

      // Complete the QA task, then QA writes passed to qa-result-gate
      await mockAgentDone(daemon, spaceId, qaTask.id, 'All checks passed');

      await writeGateData(daemon, runId, 'qa-result-gate', { result: 'passed' });

      // Done node must now activate
      const doneTask = await waitForNodeActivated(
        daemon,
        spaceId,
        runId,
        'Done',
        NODE_ACTIVATION_TIMEOUT
      );
      expect(doneTask.title).toBe('Done');
      expect(doneTask.workflowRunId).toBe(runId);
      expect(['open', 'in_progress']).toContain(doneTask.status);

      // Run is still in_progress (Done agent hasn't finished yet)
      const { run } = (await daemon.messageHub.request('spaceWorkflowRun.get', {
        id: runId,
      })) as { run: SpaceWorkflowRun };
      expect(run.status).toBe('in_progress');
    },
    TEST_TIMEOUT
  );
});
