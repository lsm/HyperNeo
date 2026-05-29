/**
 * Space Happy Path — QA Completion Flow
 *
 * Integration tests for the QA → Done (pass) and QA → Coding (fail) segments
 * of the legacy five-node coding pipeline (TEST_FULL_CYCLE_WORKFLOW fixture).
 *
 * No real LLM sessions are started. Gate data is written directly via RPC to
 * simulate agent actions, exercising the gate/channel machinery deterministically.
 *
 * ## Workflow segment under test
 *
 *   review-votes-gate  (all 3 reviewers approve)
 *     └─► QA node activates
 *   qa-result-gate     (QA writes result: passed)
 *     └─► Done node activates → workflow completes
 *   qa-fail-gate       (QA writes result: failed)
 *     └─► Coding re-activates (cyclic, per-channel maxCycles enforced)
 *         └─► code-pr-gate must be re-written → 3 Reviewers re-activate
 *             └─► review-votes-gate must be re-satisfied (all 3 re-vote)
 *                 └─► QA re-activates
 *
 * ## Scenarios
 *
 *  1. QA passes → qa-result-gate opens → Done node activates
 *  2. Done node does not activate before qa-result-gate is written
 *  3. QA failure → qa-fail-gate opens → Coding re-activates (cyclic)
 *  4. qa-result-gate resets after a QA fail cycle (resetOnCycle: true)
 *  5. qa-fail-gate resets after cycle (resetOnCycle: true)
 *  6. After QA fail cycle: Reviewers must re-activate (review-votes-gate reset)
 *  7. After QA fail cycle: All 3 reviewers must re-approve before QA re-activates
 *  8. Full QA fail → re-review → QA re-activates end-to-end
 *  9. Run remains in_progress throughout QA phase
 * 10. Channel maxCycles cap prevents further QA fail cycles
 *
 * ## Running
 *
 *   cd packages/daemon && NEOKAI_USE_DEV_PROXY=1 bun test \
 *     ./tests/online/space/space-happy-path-qa-completion.test.ts
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
const TEST_TIMEOUT = IS_MOCK ? 30_000 : 120_000;

// ---------------------------------------------------------------------------
// Type alias for readability
// ---------------------------------------------------------------------------

type SpaceTask = Awaited<ReturnType<typeof getTasksForNode>>[number];

// ---------------------------------------------------------------------------
// Shared fixture: advance the run to the point where all 3 reviewers have
// approved and QA has been activated.
//
// Steps:
//   1. Create space + optionally patch maxIterations
//   2. Start run
//   3. Write plan-pr-gate → Plan Review activates → complete it
//   4. Approve plan-approval-gate → Coding activates → complete it
//   5. Write code-pr-gate → Reviewers 1/2/3 activate
//   6. Complete all reviewer tasks
//   7. Write all 3 approval votes to review-votes-gate
//   8. QA activates
//   9. Complete the QA task (caller drives the test from here)
// ---------------------------------------------------------------------------

/**
 * Advance a workflow run to the point where QA has been activated.
 * The QA task is returned but NOT completed — callers decide the next step.
 *
 * @param daemon            Running daemon instance.
 * @param maxCyclesOverride When set, patches the qa-fail-gate channel's maxCycles before
 *                          starting the run (used by max-iterations cap tests).
 */
async function setupToQaActivated(
  daemon: DaemonServerContext,
  options?: { maxCyclesOverride?: number }
): Promise<{ spaceId: string; runId: string; qaTask: SpaceTask }> {
  const { space, workflow } = await createTestSpace(daemon);

  if (options?.maxCyclesOverride !== undefined) {
    const { workflow: currentWorkflow } = (await daemon.messageHub.request('spaceWorkflow.get', {
      id: workflow.id,
    })) as { workflow: SpaceWorkflow };
    const updatedChannels = (currentWorkflow.channels ?? []).map((ch) =>
      ch.gateId === 'qa-fail-gate' ? { ...ch, maxCycles: options.maxCyclesOverride! } : ch
    );
    await daemon.messageHub.request('spaceWorkflow.update', {
      id: workflow.id,
      channels: updatedChannels,
    });
  }

  const { runId } = await startWorkflowRun(daemon, space.id, workflow.id, 'QA completion test run');

  // Step 1: plan-pr-gate → Plan Review activates
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
  await mockAgentDone(daemon, space.id, planReviewTask.id);

  // Step 2: plan-approval-gate → Coding activates
  await approveGate(daemon, runId, 'plan-approval-gate');
  const codingTask = await waitForNodeActivated(
    daemon,
    space.id,
    runId,
    'Coding',
    NODE_ACTIVATION_TIMEOUT
  );
  await mockAgentDone(daemon, space.id, codingTask.id, 'PR opened');

  // Step 3: code-pr-gate → Reviewers activate in parallel
  await writeGateData(daemon, runId, 'code-pr-gate', {
    pr_url: 'https://github.com/org/repo/pull/42',
  });

  const [r1, r2, r3] = await Promise.all([
    waitForNodeActivated(daemon, space.id, runId, 'Reviewer 1', NODE_ACTIVATION_TIMEOUT),
    waitForNodeActivated(daemon, space.id, runId, 'Reviewer 2', NODE_ACTIVATION_TIMEOUT),
    waitForNodeActivated(daemon, space.id, runId, 'Reviewer 3', NODE_ACTIVATION_TIMEOUT),
  ]);

  // Complete all reviewer tasks before writing votes
  await mockAgentDone(daemon, space.id, r1.id);
  await mockAgentDone(daemon, space.id, r2.id);
  await mockAgentDone(daemon, space.id, r3.id);

  // Step 4: All 3 approve → review-votes-gate opens → QA activates
  await writeGateData(daemon, runId, 'review-votes-gate', {
    votes: {
      'Reviewer 1': 'approved',
      'Reviewer 2': 'approved',
      'Reviewer 3': 'approved',
    },
  });

  const qaTask = await waitForNodeActivated(daemon, space.id, runId, 'QA', NODE_ACTIVATION_TIMEOUT);

  return { spaceId: space.id, runId, qaTask };
}

/**
 * Trigger a QA fail cycle: complete the QA task, write qa-fail-gate, wait for
 * a NEW Coding task to appear (not the ones in preCycleCodingTaskIds).
 *
 * Returns the newly activated Coding task.
 */
async function triggerQaFailCycle(
  daemon: DaemonServerContext,
  spaceId: string,
  runId: string,
  qaTaskId: string,
  preCycleCodingTaskIds: Set<string>,
  summary?: string
): Promise<SpaceTask> {
  // Complete QA task before writing the fail gate — same pattern as review reject cycle:
  // onGateDataChanged increments iteration only when a node is *newly* activated.
  await mockAgentDone(daemon, spaceId, qaTaskId, summary ?? 'Tests failing, needs fix');

  await writeGateData(daemon, runId, 'qa-fail-gate', {
    result: 'failed',
    summary: summary ?? 'Test suite failed: 3 assertions failing',
  });

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
// Test suite
// ---------------------------------------------------------------------------

describe('Space Happy Path — QA Completion Flow', () => {
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
  // Test 1: QA passes → qa-result-gate opens → Done node activates
  // -------------------------------------------------------------------------
  test(
    'QA writing passed to qa-result-gate activates Done node',
    async () => {
      const { spaceId, runId, qaTask } = await setupToQaActivated(daemon);

      // Done must NOT be active yet — qa-result-gate is still closed
      const doneBefore = await getTasksForNode(daemon, spaceId, runId, 'Done');
      expect(doneBefore.length).toBe(0);

      // Complete QA task then write qa-result-gate
      await mockAgentDone(daemon, spaceId, qaTask.id, 'All checks green');
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
    },
    TEST_TIMEOUT
  );

  // -------------------------------------------------------------------------
  // Test 2: Done does not activate before qa-result-gate is written
  // -------------------------------------------------------------------------
  test(
    'Done node is not activated before qa-result-gate is written',
    async () => {
      const { spaceId, runId } = await setupToQaActivated(daemon);

      // QA is active but qa-result-gate has NOT been written
      const doneTasks = await getTasksForNode(daemon, spaceId, runId, 'Done');
      expect(doneTasks.length).toBe(0);

      // Confirm gate is still empty
      const gate = await readGateData(daemon, runId, 'qa-result-gate');
      expect(gate).not.toBeNull();
      expect(gate!.data).toEqual({ cycle_start_at: expect.any(Number) });
    },
    TEST_TIMEOUT
  );

  // -------------------------------------------------------------------------
  // Test 3: QA failure → qa-fail-gate opens → Coding re-activates (cyclic)
  // -------------------------------------------------------------------------
  test(
    'QA writing failed to qa-fail-gate cycles back to Coding',
    async () => {
      const { spaceId, runId, qaTask } = await setupToQaActivated(daemon);

      // Collect existing Coding task IDs so we can confirm the post-cycle
      // Coding task is genuinely new.
      const existingCodingTasks = await getTasksForNode(daemon, spaceId, runId, 'Coding');
      const preCycleIds = new Set(existingCodingTasks.map((t) => t.id));

      const newCodingTask = await triggerQaFailCycle(
        daemon,
        spaceId,
        runId,
        qaTask.id,
        preCycleIds
      );

      expect(newCodingTask.title).toBe('Coding');
      expect(newCodingTask.workflowRunId).toBe(runId);
      expect(['open', 'in_progress']).toContain(newCodingTask.status);

      // Done must NOT have activated — happy path did not complete
      const doneTasks = await getTasksForNode(daemon, spaceId, runId, 'Done');
      expect(doneTasks.length).toBe(0);

      // Run remains in_progress (qa fail is a cyclic correction, not a human rejection)
      const { run } = (await daemon.messageHub.request('spaceWorkflowRun.get', {
        id: runId,
      })) as { run: SpaceWorkflowRun };
      expect(run.status).toBe('in_progress');
    },
    TEST_TIMEOUT
  );

  // -------------------------------------------------------------------------
  // Test 4: qa-result-gate resets after a QA fail cycle
  // -------------------------------------------------------------------------
  test(
    'qa-result-gate is reset after a QA fail cycle (resetOnCycle: true)',
    async () => {
      const { spaceId, runId, qaTask } = await setupToQaActivated(daemon);

      // Write partial data to qa-result-gate before the cycle
      // (shouldn't normally happen in the happy path, but tests the reset)
      await writeGateData(daemon, runId, 'qa-result-gate', { result: 'passed' });

      const existingCodingTasks = await getTasksForNode(daemon, spaceId, runId, 'Coding');
      const preCycleIds = new Set(existingCodingTasks.map((t) => t.id));

      // Trigger fail cycle — qa-result-gate must be reset
      await triggerQaFailCycle(daemon, spaceId, runId, qaTask.id, preCycleIds);

      const gate = await readGateData(daemon, runId, 'qa-result-gate');
      if (gate !== null) {
        // If the record exists after reset, it must be empty (no 'result' field)
        expect(gate.data.result).toBeUndefined();
      }
    },
    TEST_TIMEOUT
  );

  // -------------------------------------------------------------------------
  // Test 5: qa-fail-gate resets after cycle (resetOnCycle: true)
  // -------------------------------------------------------------------------
  test(
    'qa-fail-gate is reset after the QA fail cycle (resetOnCycle: true)',
    async () => {
      const { spaceId, runId, qaTask } = await setupToQaActivated(daemon);

      const existingCodingTasks = await getTasksForNode(daemon, spaceId, runId, 'Coding');
      const preCycleIds = new Set(existingCodingTasks.map((t) => t.id));

      await triggerQaFailCycle(daemon, spaceId, runId, qaTask.id, preCycleIds);

      // qa-fail-gate should be reset (either null or empty data) after the cycle
      const gate = await readGateData(daemon, runId, 'qa-fail-gate');
      if (gate !== null) {
        expect(gate.data.result).toBeUndefined();
      }
    },
    TEST_TIMEOUT
  );

  // -------------------------------------------------------------------------
  // Test 6: After QA fail cycle, review-votes-gate is reset so reviewers
  //         must re-activate (code-pr-gate triggers them again)
  // -------------------------------------------------------------------------
  test(
    'After QA fail cycle, review-votes-gate is reset so reviewers must re-vote',
    async () => {
      const { spaceId, runId, qaTask } = await setupToQaActivated(daemon);

      const existingCodingTasks = await getTasksForNode(daemon, spaceId, runId, 'Coding');
      const preCycleIds = new Set(existingCodingTasks.map((t) => t.id));

      const newCodingTask = await triggerQaFailCycle(
        daemon,
        spaceId,
        runId,
        qaTask.id,
        preCycleIds
      );

      // review-votes-gate must be reset — the `votes` map should be empty
      const votesGate = await readGateData(daemon, runId, 'review-votes-gate');
      if (votesGate !== null) {
        const votes = votesGate.data.votes as Record<string, string> | undefined;
        expect(votes == null || Object.keys(votes).length === 0).toBe(true);
      }

      // QA must NOT have re-activated — review-votes-gate is still blocked
      const qaTasks = await getTasksForNode(daemon, spaceId, runId, 'QA');
      const activeQaTasks = qaTasks.filter(
        (t) => t.status === 'open' || t.status === 'in_progress'
      );
      expect(activeQaTasks.length).toBe(0);

      // Cleanup: complete the new Coding task to leave clean state
      await mockAgentDone(daemon, spaceId, newCodingTask.id);
    },
    TEST_TIMEOUT
  );

  // -------------------------------------------------------------------------
  // Test 7: After QA fail cycle, partial re-review (2/3) still blocks QA
  // -------------------------------------------------------------------------
  test(
    'After QA fail cycle, partial re-review (2/3 votes) does not re-activate QA',
    async () => {
      const { spaceId, runId, qaTask } = await setupToQaActivated(daemon);

      const existingCodingTasks = await getTasksForNode(daemon, spaceId, runId, 'Coding');
      const preCycleIds = new Set(existingCodingTasks.map((t) => t.id));

      const newCodingTask = await triggerQaFailCycle(
        daemon,
        spaceId,
        runId,
        qaTask.id,
        preCycleIds
      );

      // Collect existing reviewer task IDs BEFORE writing code-pr-gate.
      // writeGateData triggers reviewer activation synchronously within the RPC,
      // so collecting IDs after the write would capture the newly created tasks
      // and cause waitForNewNodeTask to never find them.
      const allReviewerTasksBefore = [
        ...(await getTasksForNode(daemon, spaceId, runId, 'Reviewer 1')),
        ...(await getTasksForNode(daemon, spaceId, runId, 'Reviewer 2')),
        ...(await getTasksForNode(daemon, spaceId, runId, 'Reviewer 3')),
      ];
      const preActivationIds = new Set(allReviewerTasksBefore.map((t) => t.id));

      // Complete new Coding task and re-write code-pr-gate to trigger reviewers
      await mockAgentDone(daemon, spaceId, newCodingTask.id, 'Fixed failing tests');
      await writeGateData(daemon, runId, 'code-pr-gate', {
        pr_url: 'https://github.com/org/repo/pull/42',
      });

      const [newR1, newR2, newR3] = await Promise.all([
        waitForNewNodeTask(
          daemon,
          spaceId,
          runId,
          'Reviewer 1',
          preActivationIds,
          NODE_ACTIVATION_TIMEOUT
        ),
        waitForNewNodeTask(
          daemon,
          spaceId,
          runId,
          'Reviewer 2',
          preActivationIds,
          NODE_ACTIVATION_TIMEOUT
        ),
        waitForNewNodeTask(
          daemon,
          spaceId,
          runId,
          'Reviewer 3',
          preActivationIds,
          NODE_ACTIVATION_TIMEOUT
        ),
      ]);

      await mockAgentDone(daemon, spaceId, newR1.id);
      await mockAgentDone(daemon, spaceId, newR2.id);
      await mockAgentDone(daemon, spaceId, newR3.id);

      // Only 2 of 3 approve — QA must NOT re-activate
      await writeGateData(daemon, runId, 'review-votes-gate', {
        votes: { 'Reviewer 1': 'approved', 'Reviewer 2': 'approved' },
      });

      const existingQaTasks = await getTasksForNode(daemon, spaceId, runId, 'QA');
      const preCheckQaIds = new Set(existingQaTasks.map((t) => t.id));

      // Wait a moment then confirm no new QA task appears
      await new Promise((resolve) => setTimeout(resolve, 500));
      const qaTasksAfter = await getTasksForNode(daemon, spaceId, runId, 'QA');
      const newQaTasks = qaTasksAfter.filter(
        (t) => !preCheckQaIds.has(t.id) && (t.status === 'open' || t.status === 'in_progress')
      );
      expect(newQaTasks.length).toBe(0);
    },
    TEST_TIMEOUT
  );

  // -------------------------------------------------------------------------
  // Test 8: Full QA fail → re-review → QA re-activates end-to-end
  // -------------------------------------------------------------------------
  test(
    'Full QA fail cycle: QA fails → Coding → 3 reviewers re-vote → QA re-activates',
    async () => {
      const { spaceId, runId, qaTask } = await setupToQaActivated(daemon);

      const existingCodingTasks = await getTasksForNode(daemon, spaceId, runId, 'Coding');
      const preCycleCodingIds = new Set(existingCodingTasks.map((t) => t.id));

      // Step 1: QA fails → Coding re-activates
      const newCodingTask = await triggerQaFailCycle(
        daemon,
        spaceId,
        runId,
        qaTask.id,
        preCycleCodingIds
      );
      expect(newCodingTask.title).toBe('Coding');

      // Step 2: Complete Coding, re-write code-pr-gate → reviewers re-activate.
      // Collect reviewer task IDs BEFORE writing code-pr-gate — writeGateData
      // triggers activation synchronously, so ids must be captured first.
      const allReviewerTasksBefore = [
        ...(await getTasksForNode(daemon, spaceId, runId, 'Reviewer 1')),
        ...(await getTasksForNode(daemon, spaceId, runId, 'Reviewer 2')),
        ...(await getTasksForNode(daemon, spaceId, runId, 'Reviewer 3')),
      ];
      const preActivationReviewerIds = new Set(allReviewerTasksBefore.map((t) => t.id));

      await mockAgentDone(daemon, spaceId, newCodingTask.id, 'Fixed failing tests');
      await writeGateData(daemon, runId, 'code-pr-gate', {
        pr_url: 'https://github.com/org/repo/pull/42',
      });

      // Wait for all 3 reviewers to re-activate with fresh tasks
      const [newR1, newR2, newR3] = await Promise.all([
        waitForNewNodeTask(
          daemon,
          spaceId,
          runId,
          'Reviewer 1',
          preActivationReviewerIds,
          NODE_ACTIVATION_TIMEOUT
        ),
        waitForNewNodeTask(
          daemon,
          spaceId,
          runId,
          'Reviewer 2',
          preActivationReviewerIds,
          NODE_ACTIVATION_TIMEOUT
        ),
        waitForNewNodeTask(
          daemon,
          spaceId,
          runId,
          'Reviewer 3',
          preActivationReviewerIds,
          NODE_ACTIVATION_TIMEOUT
        ),
      ]);

      expect(newR1.title).toBe('Reviewer 1');
      expect(newR2.title).toBe('Reviewer 2');
      expect(newR3.title).toBe('Reviewer 3');

      // Complete all reviewer tasks
      await mockAgentDone(daemon, spaceId, newR1.id);
      await mockAgentDone(daemon, spaceId, newR2.id);
      await mockAgentDone(daemon, spaceId, newR3.id);

      // Step 3: All 3 re-vote approved → QA re-activates
      const existingQaTasks = await getTasksForNode(daemon, spaceId, runId, 'QA');
      const preCheckQaIds = new Set(existingQaTasks.map((t) => t.id));

      await writeGateData(daemon, runId, 'review-votes-gate', {
        votes: {
          'Reviewer 1': 'approved',
          'Reviewer 2': 'approved',
          'Reviewer 3': 'approved',
        },
      });

      // QA must re-activate with a new task
      const newQaTask = await waitForNewNodeTask(
        daemon,
        spaceId,
        runId,
        'QA',
        preCheckQaIds,
        NODE_ACTIVATION_TIMEOUT
      );

      expect(newQaTask.title).toBe('QA');
      expect(newQaTask.workflowRunId).toBe(runId);
      expect(['open', 'in_progress']).toContain(newQaTask.status);

      // Run is still in_progress (QA hasn't produced a result yet)
      const { run } = (await daemon.messageHub.request('spaceWorkflowRun.get', {
        id: runId,
      })) as { run: SpaceWorkflowRun };
      expect(run.status).toBe('in_progress');
    },
    TEST_TIMEOUT
  );

  // -------------------------------------------------------------------------
  // Test 9: Run remains in_progress throughout the QA phase
  // -------------------------------------------------------------------------
  test(
    'Run status remains in_progress throughout the QA phase',
    async () => {
      const { runId } = await setupToQaActivated(daemon);

      const polled = await waitForRunStatus(daemon, runId, ['in_progress'], RUN_STATUS_TIMEOUT);
      expect(polled.status).toBe('in_progress');
    },
    TEST_TIMEOUT
  );

  // -------------------------------------------------------------------------
  // Test 10: Max cycles cap prevents further QA fail cycles
  // -------------------------------------------------------------------------
  test(
    'QA fail cycles stop when the channel maxCycles cap is reached',
    async () => {
      // Cap at 1 cycle so the first QA fail cycle exhausts the budget.
      // After the cap, writing qa-fail-gate again must NOT create a new Coding task.
      const { spaceId, runId, qaTask } = await setupToQaActivated(daemon, {
        maxCyclesOverride: 1,
      });

      // ── First QA fail cycle: should succeed ────────────────────────────
      const existingCodingTasks = await getTasksForNode(daemon, spaceId, runId, 'Coding');
      const preCycleIds = new Set(existingCodingTasks.map((t) => t.id));

      const newCodingTask = await triggerQaFailCycle(
        daemon,
        spaceId,
        runId,
        qaTask.id,
        preCycleIds
      );

      // ── Second QA fail cycle: must be blocked ──────────────────────────
      // Re-drive Coding → reviewers → re-approve → QA for the second run.
      // Collect reviewer task IDs BEFORE writing code-pr-gate (activation is synchronous).
      const allReviewerTasksBefore = [
        ...(await getTasksForNode(daemon, spaceId, runId, 'Reviewer 1')),
        ...(await getTasksForNode(daemon, spaceId, runId, 'Reviewer 2')),
        ...(await getTasksForNode(daemon, spaceId, runId, 'Reviewer 3')),
      ];
      const preActivationReviewerIds = new Set(allReviewerTasksBefore.map((t) => t.id));

      await mockAgentDone(daemon, spaceId, newCodingTask.id, 'Fixed again');
      await writeGateData(daemon, runId, 'code-pr-gate', {
        pr_url: 'https://github.com/org/repo/pull/42',
      });

      const [newR1, newR2, newR3] = await Promise.all([
        waitForNewNodeTask(
          daemon,
          spaceId,
          runId,
          'Reviewer 1',
          preActivationReviewerIds,
          NODE_ACTIVATION_TIMEOUT
        ),
        waitForNewNodeTask(
          daemon,
          spaceId,
          runId,
          'Reviewer 2',
          preActivationReviewerIds,
          NODE_ACTIVATION_TIMEOUT
        ),
        waitForNewNodeTask(
          daemon,
          spaceId,
          runId,
          'Reviewer 3',
          preActivationReviewerIds,
          NODE_ACTIVATION_TIMEOUT
        ),
      ]);

      await mockAgentDone(daemon, spaceId, newR1.id);
      await mockAgentDone(daemon, spaceId, newR2.id);
      await mockAgentDone(daemon, spaceId, newR3.id);

      // Collect QA task IDs BEFORE writing review-votes-gate (activation is synchronous)
      const existingQaTasks = await getTasksForNode(daemon, spaceId, runId, 'QA');
      const preCheckQaIds = new Set(existingQaTasks.map((t) => t.id));

      await writeGateData(daemon, runId, 'review-votes-gate', {
        votes: {
          'Reviewer 1': 'approved',
          'Reviewer 2': 'approved',
          'Reviewer 3': 'approved',
        },
      });

      const newQaTask = await waitForNewNodeTask(
        daemon,
        spaceId,
        runId,
        'QA',
        preCheckQaIds,
        NODE_ACTIVATION_TIMEOUT
      );

      // Complete the second QA task — now attempt the capped fail cycle
      await mockAgentDone(daemon, spaceId, newQaTask.id, 'Still failing');

      // Record all existing Coding task IDs — no new one should appear after cap
      const allCodingTasksBefore = await getTasksForNode(daemon, spaceId, runId, 'Coding');
      const codingTaskIdsBefore = new Set(allCodingTasksBefore.map((t) => t.id));

      await writeGateData(daemon, runId, 'qa-fail-gate', {
        result: 'failed',
        summary: 'Still failing',
      });

      // Poll for the full NODE_ACTIVATION_TIMEOUT to confirm no new Coding task appears
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

      // No new Coding task must appear — the cap was reached after 1 cycle
      expect(unexpectedTask).toBeUndefined();
    },
    TEST_TIMEOUT
  );
});
