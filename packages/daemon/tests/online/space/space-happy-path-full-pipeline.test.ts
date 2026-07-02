/**
 * Space Happy Path — Full Pipeline End-to-End Test
 *
 * Single end-to-end integration test that drives the entire legacy five-node
 * coding pipeline (TEST_FULL_CYCLE_WORKFLOW fixture) from run start to completion,
 * simulating every agent action via gate writes rather than real LLM sessions.
 * The fixture exercises the same gate/channel primitives still used by the
 * current Coding, Coding with QA, and Plan & Decompose workflows.
 *
 * ## Full pipeline under test
 *
 *   Planning (start)
 *     └─► plan-pr-gate       — planner writes PR URL
 *   Plan Review
 *     └─► plan-approval-gate — human approves plan
 *   Coding
 *     └─► code-pr-gate       — coder writes PR URL
 *   Reviewer 1 + 2 + 3  (parallel)
 *     └─► review-votes-gate  — all 3 approve
 *   QA
 *     └─► qa-result-gate     — QA writes passed
 *   Done
 *     └─► run.status = done
 *
 * ## Test scenarios
 *
 *  1. Happy path — full pipeline completes; run.status becomes done
 *     Verifies every stage in order and confirms the completion summary.
 *
 *  2. Failure-and-recovery — two failure injections:
 *       a. QA fails once (qa-fail-gate → cycles Coding back, iteration 1)
 *       b. One reviewer rejects in the next review round
 *          (review-reject-gate → cycles Coding back, iteration 2)
 *       c. Third Coding pass → all approve → QA passes → Done
 *     Verifies iteration counter increments, gate resets, and eventual completion.
 *
 * ## Running
 *
 *   cd packages/daemon && HYPERNEO_USE_DEV_PROXY=1 bun test \
 *     ./tests/online/space/space-happy-path-full-pipeline.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import type { SpaceWorkflowRun } from '@hyperneo/shared';
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
  mockWorkflowComplete,
} from './helpers/space-test-helpers';

// ---------------------------------------------------------------------------
// Timing constants
// ---------------------------------------------------------------------------

const IS_MOCK = !!process.env.HYPERNEO_USE_DEV_PROXY;

const NODE_ACTIVATION_TIMEOUT = IS_MOCK ? 3_000 : 15_000;
// Run completion requires a SpaceRuntime tick (default 5s interval), so we
// allow up to 15s in mock mode to safely cover two tick periods. This applies
// to both tests since Done-node completion in either test path triggers the
// same tick-based detection.
const RUN_STATUS_TIMEOUT = IS_MOCK ? 15_000 : 30_000;
const SETUP_TIMEOUT = IS_MOCK ? 15_000 : 30_000;
const TEST_TIMEOUT = IS_MOCK ? 60_000 : 180_000;

// ---------------------------------------------------------------------------
// Shared pipeline helper
// ---------------------------------------------------------------------------

/**
 * Drive the workflow through Planning → Plan Review → Coding → 3 Reviewers
 * (all approve) and return after writing review-votes-gate (which activates QA
 * synchronously).
 *
 * Steps executed:
 *   1. Create space → start run → Planning task appears
 *   2. Write plan-pr-gate → Plan Review activates → complete it
 *   3. Approve plan-approval-gate → Coding activates → complete it
 *   4. Write code-pr-gate → Reviewer 1/2/3 activate (parallel) → complete all
 *   5. Write all 3 approval votes to review-votes-gate (opens gate, QA activates)
 *
 * Caller is responsible for waiting on QA (and continuing the pipeline).
 *
 * Note: existing reviewer task IDs are captured BEFORE writing code-pr-gate
 * because writeGateData triggers node activation synchronously inside the RPC.
 * On the first reviewer round the exclude-set is empty, so waitForNewNodeTask
 * behaves equivalently to waitForNodeActivated — but the same pattern applies
 * consistently across all rounds.
 *
 * Note: all 3 votes are written in a single RPC call for simplicity. Real agents
 * use a sequential read-merge-write pattern per reviewer, but the gate condition
 * (count votes == approved, min: 3) evaluates correctly either way.
 */
async function driveToCodePrGateOpen(
  daemon: DaemonServerContext,
  runTitle: string
): Promise<{ spaceId: string; runId: string }> {
  const { space, workflow } = await createTestSpace(daemon);
  const { runId } = await startWorkflowRun(daemon, space.id, workflow.id, runTitle);

  // ── Stage 1: Planning → plan-pr-gate ───────────────────────────────────
  const planningTask = await waitForNodeActivated(
    daemon,
    space.id,
    runId,
    'Planning',
    NODE_ACTIVATION_TIMEOUT
  );
  expect(['open', 'in_progress']).toContain(planningTask.status);

  await mockAgentDone(daemon, space.id, planningTask.id, 'Plan PR opened');
  await writeGateData(daemon, runId, 'plan-pr-gate', {
    pr_url: 'https://github.com/example/repo/pull/10',
    pr_number: 10,
    branch: 'plan/test-feature',
  });

  // ── Stage 2: Plan Review → plan-approval-gate ──────────────────────────
  const planReviewTask = await waitForNodeActivated(
    daemon,
    space.id,
    runId,
    'Plan Review',
    NODE_ACTIVATION_TIMEOUT
  );
  await mockAgentDone(daemon, space.id, planReviewTask.id, 'Plan looks good');
  await approveGate(daemon, runId, 'plan-approval-gate', 'Approved after review');

  // ── Stage 3: Coding → code-pr-gate ─────────────────────────────────────
  const codingTask = await waitForNodeActivated(
    daemon,
    space.id,
    runId,
    'Coding',
    NODE_ACTIVATION_TIMEOUT
  );
  await mockAgentDone(daemon, space.id, codingTask.id, 'Implementation complete, PR opened');

  // ── Stage 4: Reviewer 1/2/3 (parallel) → review-votes-gate ─────────────
  // Collect existing reviewer task IDs BEFORE writing code-pr-gate.
  // writeGateData triggers reviewer activation synchronously inside the RPC,
  // so IDs must be captured first to allow waitForNewNodeTask to detect them.
  const reviewerTasksBefore = [
    ...(await getTasksForNode(daemon, space.id, runId, 'Reviewer 1')),
    ...(await getTasksForNode(daemon, space.id, runId, 'Reviewer 2')),
    ...(await getTasksForNode(daemon, space.id, runId, 'Reviewer 3')),
  ];
  const reviewerIdsBefore = new Set(reviewerTasksBefore.map((t) => t.id));

  await writeGateData(daemon, runId, 'code-pr-gate', {
    pr_url: 'https://github.com/org/repo/pull/42',
  });

  const [r1, r2, r3] = await Promise.all([
    waitForNewNodeTask(
      daemon,
      space.id,
      runId,
      'Reviewer 1',
      reviewerIdsBefore,
      NODE_ACTIVATION_TIMEOUT
    ),
    waitForNewNodeTask(
      daemon,
      space.id,
      runId,
      'Reviewer 2',
      reviewerIdsBefore,
      NODE_ACTIVATION_TIMEOUT
    ),
    waitForNewNodeTask(
      daemon,
      space.id,
      runId,
      'Reviewer 3',
      reviewerIdsBefore,
      NODE_ACTIVATION_TIMEOUT
    ),
  ]);
  expect(['open', 'in_progress']).toContain(r1.status);
  expect(['open', 'in_progress']).toContain(r2.status);
  expect(['open', 'in_progress']).toContain(r3.status);

  // Complete all reviewer tasks before writing votes (mirrors real agent ordering)
  await mockAgentDone(daemon, space.id, r1.id, 'LGTM');
  await mockAgentDone(daemon, space.id, r2.id, 'LGTM');
  await mockAgentDone(daemon, space.id, r3.id, 'LGTM');

  // Write all 3 approval votes — opens review-votes-gate, QA activates synchronously
  await writeGateData(daemon, runId, 'review-votes-gate', {
    votes: {
      'Reviewer 1': 'approved',
      'Reviewer 2': 'approved',
      'Reviewer 3': 'approved',
    },
  });

  return { spaceId: space.id, runId };
}

/**
 * Drive the workflow from start through QA activation.
 *
 * Delegates to driveToCodePrGateOpen for the Planning → reviewers-approve
 * phase, then waits for QA to appear.
 */
async function driveToQaActivated(daemon: DaemonServerContext): Promise<{
  spaceId: string;
  runId: string;
  qaTaskId: string;
}> {
  const { spaceId, runId } = await driveToCodePrGateOpen(daemon, 'Full pipeline test run');
  const qaTask = await waitForNodeActivated(daemon, spaceId, runId, 'QA', NODE_ACTIVATION_TIMEOUT);
  return { spaceId, runId, qaTaskId: qaTask.id };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Space Happy Path — Full Pipeline End-to-End', () => {
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
  // Test 1: Full happy path — every stage completes; run reaches completed
  // -------------------------------------------------------------------------
  test(
    'Full pipeline happy path: Planning → Plan Review → Coding → 3 Reviewers → QA → Done',
    async () => {
      const { spaceId, runId, qaTaskId } = await driveToQaActivated(daemon);

      // Verify run is in_progress at this point (no cycles, no completion yet)
      const { run: runMid } = (await daemon.messageHub.request('spaceWorkflowRun.get', {
        id: runId,
      })) as { run: SpaceWorkflowRun };
      expect(runMid.status).toBe('in_progress');

      // Done must NOT be active yet
      const doneBefore = await getTasksForNode(daemon, spaceId, runId, 'Done');
      expect(doneBefore.length).toBe(0);

      // ── Stage 6: QA passes → qa-result-gate → Done activates ────────────
      await mockAgentDone(daemon, spaceId, qaTaskId, 'All CI checks green, PR mergeable');
      await writeGateData(daemon, runId, 'qa-result-gate', {
        result: 'passed',
        summary: 'All tests pass, CI green, PR in mergeable state',
      });

      const doneTask = await waitForNodeActivated(
        daemon,
        spaceId,
        runId,
        'Done',
        NODE_ACTIVATION_TIMEOUT
      );
      expect(doneTask.title).toBe('Done');
      expect(['open', 'in_progress']).toContain(doneTask.status);

      // ── Stage 7: Complete Done → run reaches completed ─────────────────
      const completionSummary =
        'Feature implemented: PR #99 merged, all tests pass, CI green. ' +
        'Reviewed by 3 reviewers. QA confirmed mergeable state.';
      await mockWorkflowComplete(daemon, spaceId, runId, doneTask.id, completionSummary);

      const completedRun = await waitForRunStatus(daemon, runId, ['done'], RUN_STATUS_TIMEOUT);
      expect(completedRun.status).toBe('done');
      expect(completedRun.completedAt).toBeDefined();

      // ── Verify completion summary ──────────────────────────────────────
      const doneTasks = await getTasksForNode(daemon, spaceId, runId, 'Done');
      const completedDoneTask = doneTasks.find((t) => t.status === 'done');
      expect(completedDoneTask).toBeDefined();
      expect(completedDoneTask?.result).toBe(completionSummary);

      // Verify gate data is still accessible after completion
      const prGate = await readGateData(daemon, runId, 'code-pr-gate');
      expect(prGate).not.toBeNull();
      expect(prGate?.data.pr_url).toBe('https://github.com/org/repo/pull/42');

      const qaResultGate = await readGateData(daemon, runId, 'qa-result-gate');
      expect(qaResultGate).not.toBeNull();
      expect(qaResultGate?.data.result).toBe('passed');
    },
    TEST_TIMEOUT
  );

  // -------------------------------------------------------------------------
  // Test 2: Failure-and-recovery — QA fail then reviewer rejection
  //
  // Pipeline path:
  //   driveToCodePrGateOpen → QA activates (all approved, round 1)
  //   → QA fails (qa-fail-gate) → Coding cycles back (cycle 1 via qa-fail channel)
  //   → Reviewer 1 rejects (review-reject-gate) → Coding cycles back (cycle 1 via reject channel)
  //   → all 3 approve (round 3) → QA passes → Done → done
  // -------------------------------------------------------------------------
  test(
    'Failure-and-recovery: QA fail + reviewer rejection → eventual completion',
    async () => {
      // Use the shared helper for the initial Planning → reviewers-approve pass
      const { spaceId, runId } = await driveToCodePrGateOpen(
        daemon,
        'Failure-and-recovery pipeline test'
      );

      // QA activates after all 3 reviewers approved in the helper
      const qaTask1 = await waitForNodeActivated(
        daemon,
        spaceId,
        runId,
        'QA',
        NODE_ACTIVATION_TIMEOUT
      );

      // ── QA fail → Coding cycles back (iteration 1) ──────────────────────
      await mockAgentDone(daemon, spaceId, qaTask1.id, 'Tests failing: 3 assertions broken');

      const codingTasksBefore1 = await getTasksForNode(daemon, spaceId, runId, 'Coding');
      const codingIdsBefore1 = new Set(codingTasksBefore1.map((t) => t.id));

      await writeGateData(daemon, runId, 'qa-fail-gate', {
        result: 'failed',
        summary: 'Test suite failed: 3 assertions breaking',
      });

      const codingTask2 = await waitForNewNodeTask(
        daemon,
        spaceId,
        runId,
        'Coding',
        codingIdsBefore1,
        NODE_ACTIVATION_TIMEOUT
      );

      const { run: runAfter1 } = (await daemon.messageHub.request('spaceWorkflowRun.get', {
        id: runId,
      })) as { run: SpaceWorkflowRun };
      expect(runAfter1.status).toBe('in_progress');

      // ── Coding round 2: Reviewer 1 rejects → Coding cycles back (iter 2) ─
      await mockAgentDone(daemon, spaceId, codingTask2.id, 'Fixed failing tests');

      // Collect reviewer IDs BEFORE writing code-pr-gate (activation is synchronous)
      const reviewerTasksBefore2 = [
        ...(await getTasksForNode(daemon, spaceId, runId, 'Reviewer 1')),
        ...(await getTasksForNode(daemon, spaceId, runId, 'Reviewer 2')),
        ...(await getTasksForNode(daemon, spaceId, runId, 'Reviewer 3')),
      ];
      const reviewerIdsBefore2 = new Set(reviewerTasksBefore2.map((t) => t.id));

      await writeGateData(daemon, runId, 'code-pr-gate', {
        pr_url: 'https://github.com/org/repo/pull/42',
      });

      const [r2a, r2b, r2c] = await Promise.all([
        waitForNewNodeTask(
          daemon,
          spaceId,
          runId,
          'Reviewer 1',
          reviewerIdsBefore2,
          NODE_ACTIVATION_TIMEOUT
        ),
        waitForNewNodeTask(
          daemon,
          spaceId,
          runId,
          'Reviewer 2',
          reviewerIdsBefore2,
          NODE_ACTIVATION_TIMEOUT
        ),
        waitForNewNodeTask(
          daemon,
          spaceId,
          runId,
          'Reviewer 3',
          reviewerIdsBefore2,
          NODE_ACTIVATION_TIMEOUT
        ),
      ]);
      expect(['open', 'in_progress']).toContain(r2a.status);
      expect(['open', 'in_progress']).toContain(r2b.status);
      expect(['open', 'in_progress']).toContain(r2c.status);

      await mockAgentDone(daemon, spaceId, r2a.id, 'Needs refactoring');
      await mockAgentDone(daemon, spaceId, r2b.id, 'LGTM');
      await mockAgentDone(daemon, spaceId, r2c.id, 'LGTM');

      // Reviewer 1 rejects: review-reject-gate (min: 1 rejected) opens → Coding cycles
      const codingTasksBefore2 = await getTasksForNode(daemon, spaceId, runId, 'Coding');
      const codingIdsBefore2 = new Set(codingTasksBefore2.map((t) => t.id));

      await writeGateData(daemon, runId, 'review-reject-gate', {
        votes: { 'Reviewer 1': 'rejected' },
      });

      const codingTask3 = await waitForNewNodeTask(
        daemon,
        spaceId,
        runId,
        'Coding',
        codingIdsBefore2,
        NODE_ACTIVATION_TIMEOUT
      );
      expect(codingTask3.title).toBe('Coding');

      const { run: runAfter2 } = (await daemon.messageHub.request('spaceWorkflowRun.get', {
        id: runId,
      })) as { run: SpaceWorkflowRun };
      expect(runAfter2.status).toBe('in_progress');

      // review-votes-gate must be reset after the reject cycle.
      // null means the gate record was deleted, which also counts as a reset.
      const votesGateAfterReject = await readGateData(daemon, runId, 'review-votes-gate');
      if (votesGateAfterReject !== null) {
        const votes = votesGateAfterReject.data.votes as Record<string, string> | undefined;
        expect(votes == null || Object.keys(votes).length === 0).toBe(true);
      }

      // ── Coding round 3: all 3 approve → QA passes → Done ─────────────────
      await mockAgentDone(daemon, spaceId, codingTask3.id, 'Refactored as requested');

      // Collect reviewer IDs BEFORE writing code-pr-gate
      const reviewerTasksBefore3 = [
        ...(await getTasksForNode(daemon, spaceId, runId, 'Reviewer 1')),
        ...(await getTasksForNode(daemon, spaceId, runId, 'Reviewer 2')),
        ...(await getTasksForNode(daemon, spaceId, runId, 'Reviewer 3')),
      ];
      const reviewerIdsBefore3 = new Set(reviewerTasksBefore3.map((t) => t.id));

      await writeGateData(daemon, runId, 'code-pr-gate', {
        pr_url: 'https://github.com/org/repo/pull/42',
      });

      const [r3a, r3b, r3c] = await Promise.all([
        waitForNewNodeTask(
          daemon,
          spaceId,
          runId,
          'Reviewer 1',
          reviewerIdsBefore3,
          NODE_ACTIVATION_TIMEOUT
        ),
        waitForNewNodeTask(
          daemon,
          spaceId,
          runId,
          'Reviewer 2',
          reviewerIdsBefore3,
          NODE_ACTIVATION_TIMEOUT
        ),
        waitForNewNodeTask(
          daemon,
          spaceId,
          runId,
          'Reviewer 3',
          reviewerIdsBefore3,
          NODE_ACTIVATION_TIMEOUT
        ),
      ]);

      expect(['open', 'in_progress']).toContain(r3a.status);
      expect(['open', 'in_progress']).toContain(r3b.status);
      expect(['open', 'in_progress']).toContain(r3c.status);

      await mockAgentDone(daemon, spaceId, r3a.id, 'LGTM');
      await mockAgentDone(daemon, spaceId, r3b.id, 'LGTM');
      await mockAgentDone(daemon, spaceId, r3c.id, 'LGTM');

      // Collect QA task IDs BEFORE writing review-votes-gate (activation is synchronous)
      const qaTasksBefore = await getTasksForNode(daemon, spaceId, runId, 'QA');
      const qaIdsBefore = new Set(qaTasksBefore.map((t) => t.id));

      await writeGateData(daemon, runId, 'review-votes-gate', {
        votes: {
          'Reviewer 1': 'approved',
          'Reviewer 2': 'approved',
          'Reviewer 3': 'approved',
        },
      });

      const qaTask2 = await waitForNewNodeTask(
        daemon,
        spaceId,
        runId,
        'QA',
        qaIdsBefore,
        NODE_ACTIVATION_TIMEOUT
      );

      // Collect Done task IDs BEFORE writing qa-result-gate (activation is synchronous)
      const doneTasksBefore = await getTasksForNode(daemon, spaceId, runId, 'Done');
      const doneIdsBefore = new Set(doneTasksBefore.map((t) => t.id));

      const completionSummary = 'Fixed tests pass; CI green; PR #99 mergeable.';
      await mockAgentDone(daemon, spaceId, qaTask2.id, 'All checks green');
      await writeGateData(daemon, runId, 'qa-result-gate', { result: 'passed' });

      const doneTask = await waitForNewNodeTask(
        daemon,
        spaceId,
        runId,
        'Done',
        doneIdsBefore,
        NODE_ACTIVATION_TIMEOUT
      );
      expect(doneTask.title).toBe('Done');

      await mockWorkflowComplete(daemon, spaceId, runId, doneTask.id, completionSummary);

      // ── Final assertions ─────────────────────────────────────────────────
      const completedRun = await waitForRunStatus(daemon, runId, ['done'], RUN_STATUS_TIMEOUT);
      expect(completedRun.status).toBe('done');
      expect(completedRun.completedAt).toBeDefined();

      // Completion summary available on the Done task
      const doneTasks = await getTasksForNode(daemon, spaceId, runId, 'Done');
      const completedDoneTask = doneTasks.find((t) => t.status === 'done');
      expect(completedDoneTask).toBeDefined();
      expect(completedDoneTask?.result).toBe(completionSummary);
    },
    TEST_TIMEOUT
  );
});
