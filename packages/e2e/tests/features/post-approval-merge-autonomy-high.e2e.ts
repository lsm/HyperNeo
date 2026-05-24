/**
 * Post-Approval: Auto-merge at high autonomy (Level 4) E2E Tests
 *
 * PR 4/5 of
 * `docs/plans/remove-completion-actions-task-agent-as-post-approval-executor.md`
 * §4.6 requires this test: a Level-4 space running the built-in Coding
 * workflow against a fake PR must reach `approved`, the post-approval
 * reviewer session must spawn, run `gh pr merge --squash`, call
 * `mark_complete`, and the task must end at `done` with no human
 * interaction.
 *
 * ## Why this test is currently skipped
 *
 * Executing the full post-approval path end-to-end requires three pieces
 * of infrastructure that are NOT yet in place in the E2E harness:
 *
 *   1. **Mock `gh` CLI.** The post-approval reviewer session runs
 *      `gh pr view`, `gh pr merge --squash`, and `git pull --ff-only`.
 *      Without a sandboxed mock on `PATH`, the test would either hit
 *      GitHub.com (unacceptable — write side-effect) or abort with
 *      "gh: command not found". The plan (§4.6) calls out
 *      `tests/e2e/helpers/mock-gh.sh` as the intended shim.
 *
 *   2. **LLM mock / recording.** The reviewer session runs an LLM
 *      agent. Existing E2E tests avoid this by either marking tasks as
 *      `done` before the agent spawns, or by testing UI without
 *      spawning an agent at all. This test cannot short-circuit — the
 *      whole point is observing the agent's behaviour. A recording
 *      harness (VCR-style) or an `@neokai/provider/test` mock that
 *      feeds scripted tool-call responses is required.
 *
 *   3. **Feature flag parity.** PR 3/5 defaulted
 *      `NEOKAI_TASK_AGENT_POST_APPROVAL_ROUTING` to ON, but the E2E
 *      fixture does not yet surface environment-level controls for
 *      daemon-side flags — the dev-server is started once and the
 *      env is inherited. Adding a per-spec env override to
 *      `packages/e2e/fixtures.ts` is a blocker.
 *
 * Once (1)–(3) land, the test body below can be un-skipped. The steps
 * are authored inline for clarity so the reviewer of the follow-up PR
 * has a concrete target.
 */

import { test, expect } from '../../fixtures';

// eslint-disable-next-line no-empty-pattern
test.describe
  .skip('Post-approval auto-merge at autonomy level 4 (PENDING infra)', () => {
    test('reviewer session spawns, merges PR, and marks task done without human input', async ({
      page,
    }) => {
      // 1. Create a space with `autonomyLevel: 4` via RPC.
      // 2. Seed a PR fixture: `git init`, `git checkout -b feature/test-high`,
      //    commit a file, push via the mock `gh`'s `gh pr create`.
      // 3. Call `spaceWorkflowRun.start` with workflow="Coding Workflow".
      // 4. Drive the workflow through its gates by short-circuiting the
      //    Coder + Reviewer agents via the LLM mock: the Reviewer's
      //    scripted tool calls must include save_artifact({ prUrl }),
      //    send_message(task-agent, data:{ pr_url }), approve_task().
      // 5. Assert: task transitions `in_progress → approved`.
      // 6. Assert: PostApprovalRouter spawns a reviewer session; the mock
      //    `gh pr merge --squash` runs; the session calls `mark_complete`.
      // 7. Assert: task ends at `done`; no `request_human_input` calls;
      //    `workflow_run_artifacts` has a row with `status: 'merged'`.
      // 8. Assert UI: no `PendingPostApprovalBanner` visible; task list
      //    row shows green "done" indicator.
      expect(page).toBeTruthy();
    });
  });
