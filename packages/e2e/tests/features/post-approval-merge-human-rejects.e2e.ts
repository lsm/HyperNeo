/**
 * Post-Approval: Human-rejected merge at low autonomy (Level 1) E2E Tests
 *
 * PR 4/5 of
 * `docs/plans/remove-completion-actions-task-agent-as-post-approval-executor.md`
 * §4.6 requires this test: a Level-1 space where the human REJECTS the
 * merge via `request_human_input`. The reviewer session must NOT call
 * `gh pr merge`; the task must still end at `done` (or `approved` with
 * a `postApprovalBlockedReason`) and an audit artifact must record the
 * rejection.
 *
 * This is the counterpart to `post-approval-merge-autonomy-low.e2e.ts`
 * and asserts the "human says no" branch of the merge template at
 * autonomy_level < 4.
 *
 * ## Why this test is currently skipped
 *
 * Same infra blockers as the other `post-approval-merge-*` tests:
 *   - Mock `gh` on PATH (needed to assert `gh pr merge` was NOT called).
 *   - LLM mock / recording for the reviewer agent.
 *   - Multi-turn conversation support so the human rejection reply is
 *     threaded back into the post-approval session.
 *   - Per-spec env override for
 *     `NEOKAI_TASK_AGENT_POST_APPROVAL_ROUTING`.
 *
 * See `post-approval-merge-autonomy-high.e2e.ts` for the full discussion.
 */

import { test, expect } from '../../fixtures';

test.describe
  .skip('Post-approval merge rejected by human at autonomy level 1 (PENDING infra)', () => {
    test('reviewer session respects human rejection — PR is NOT merged; audit records rejection', async ({
      page,
    }) => {
      // 1. Create a space with `autonomyLevel: 1`.
      // 2. Seed a PR fixture via mock `gh`.
      // 3. Start a Coding workflow run; drive to `approved`.
      // 4. Reviewer post-approval session spawns, asks
      //    `request_human_input({ question: "Approve merging PR ..." })`.
      // 5. UI step: post a reply "no, hold off" via composer.
      // 6. Assert: the session does NOT invoke `gh pr merge`. (Inspect
      //    the mock `gh` call log; expect zero `merge` invocations.)
      // 7. Assert: the session saves an artifact of type `result` with
      //    `approval: 'rejected'` (or equivalent), then calls
      //    `mark_complete`. Task ends at `done`.
      // 8. Assert UI: task list row shows "done"; no merge happened.
      expect(page).toBeTruthy();
    });
  });
