/**
 * Post-Approval: Human-gated merge at low autonomy (Level 1) E2E Tests
 *
 * PR 4/5 of
 * `docs/plans/remove-completion-actions-task-agent-as-post-approval-executor.md`
 * §4.6 requires this test: a Level-1 space running the built-in Coding
 * workflow must reach `approved`, the post-approval reviewer session
 * must spawn, detect `autonomy_level < 4` in the merge template, call
 * `request_human_input` to ask for merge sign-off, wait for the human's
 * answer, then execute `gh pr merge --squash` and `mark_complete`.
 *
 * ## Why this test is currently skipped
 *
 * See the file-level comment in `post-approval-merge-autonomy-high.e2e.ts`
 * for the full infrastructure gap. The same three blockers apply here
 * (mock `gh`, LLM mock/recording, per-spec env override), plus:
 *
 *   4. **Human-input conversation loop.** The post-approval session
 *      pauses at `request_human_input`; the test harness must post a
 *      user reply via the composer UI and confirm the session resumes.
 *      This requires the LLM mock to distinguish "awaiting input" from
 *      "producing output" across a multi-turn conversation, which the
 *      existing E2E mocks do not support.
 *
 * Once the infra is in place, the test body below can be un-skipped.
 */

import { test, expect } from '../../fixtures';

test.describe
  .skip('Post-approval merge at autonomy level 1 — requires human approval (PENDING infra)', () => {
    test('reviewer session requests human input before merging, then completes', async ({
      page,
    }) => {
      // 1. Create a space with `autonomyLevel: 1`.
      // 2. Seed a PR fixture via mock `gh`.
      // 3. Start a Coding workflow run; drive gates + agents via LLM mock.
      // 4. Assert: task transitions to `approved` after the Reviewer calls
      //    approve_task (or submit_for_approval + human approves review).
      // 5. Assert: reviewer post-approval session spawns; the scripted
      //    reply calls `request_human_input` with question mentioning
      //    "Approve merging PR".
      // 6. UI step: post a reply "yes" via the task composer.
      // 7. Assert: reviewer resumes, calls `gh pr merge --squash`, then
      //    `mark_complete`. Task ends at `done`.
      // 8. Assert UI: `PendingTaskCompletionBanner` was visible during
      //    the `request_human_input` pause, then disappeared.
      expect(page).toBeTruthy();
    });
  });
