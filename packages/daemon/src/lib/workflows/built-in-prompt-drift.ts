import {
  CALL_ACTION_PREFERENCE_GUIDANCE,
  CALL_ACTION_PREFERENCE_GUIDANCE_PRE_OPERATION_NAMES,
  CODER_ONLY_PROMPT,
  CODER_OWNED_MERGE_PROMPT,
  CODER_OWNED_PR_SUBSCRIBE_GUIDANCE,
  CODEX_REACTION_APPROVAL_GUIDANCE,
  EXTERNAL_REVIEW_BOTS_GUIDANCE,
  EXTERNAL_REVIEW_BOTS_GUIDANCE_PRE_CHECK_SEEDING,
  EXTERNAL_REVIEW_BOTS_GUIDANCE_PRE_TYPENAME,
  FULLSTACK_CODING_NOCHANGE_GUIDANCE,
  FULLSTACK_QA_POST_APPROVAL_PARAGRAPH,
  RESEARCH_PROMPT,
  REVIEW_THREAD_RESOLUTION_GUIDANCE,
  REVIEWER_POST_APPROVAL_BLOCKER_PARAGRAPH,
  REVIEWER_ZERO_FINDINGS_GATE,
} from '@hyperneo/prompts';
import type { WorkflowNodeAgentOverride } from '@hyperneo/shared';
import { RETIRED_ESCALATION_FULLSTACK_CODING_NOCHANGE_GUIDANCE } from './built-in-legacy-slot-prompts.ts';
import {
  RETIRED_PRE_BASE_ADVANCE_POLICY_CODER_ONLY_PROMPT,
  RETIRED_PRE_EVENT_DRIVEN_CODER_ONLY_PROMPT,
  RETIRED_PRE_REVIEW_MODES_CODER_ONLY_PROMPT,
} from './built-in-retired-prompts-coder-only.ts';
import {
  RETIRED_PRE_BASE_ADVANCE_POLICY_CODER_OWNED_MERGE_PROMPT,
  RETIRED_PRE_EVENT_DRIVEN_CODER_OWNED_MERGE_PROMPT,
  RETIRED_PRE_REVIEW_MODES_CODER_OWNED_MERGE_PROMPT,
} from './built-in-retired-prompts-coder-owned-merge.ts';
import {
  RETIRED_PRE_BASE_ADVANCE_POLICY_RESEARCH_PROMPT,
  RETIRED_PRE_EVENT_DRIVEN_RESEARCH_PROMPT,
  RETIRED_PRE_REVIEW_MODES_RESEARCH_PROMPT,
} from './built-in-retired-prompts-research.ts';
import {
  RETIRED_INLINE_OPERATION_PROMPT_PAIRS,
  RETIRED_INLINE_EXTERNAL_REVIEW_BOTS_GUIDANCE,
  RETIRED_INLINE_REVIEWER_ZERO_FINDINGS_GATE,
} from './built-in-retired-operation-prompts.ts';

const RETIRED_P3_REVIEWER_ZERO_FINDINGS_GATE =
  '\n\nVerdict gate (hard rule, no exceptions): approve, or forward an approved PR, ONLY ' +
  'when your P0, P1, P2, and P3 counts are all zero. If any finding count is greater than ' +
  'zero, your verdict is REQUEST_CHANGES — send the findings back to the implementer and ' +
  'stop; do not approve, do not hand off an approval, and do not call approve_task or ' +
  'submit_for_approval. There is no optional severity: a filed P2 or P3 is unresolved work ' +
  'that blocks approval exactly like a P0. (If a nit is genuinely not worth a change, do ' +
  'not file it as a finding — note it as a passing observation or omit it.)';

const RETIRED_PREVIOUS_FULLSTACK_CODING_NOCHANGE_GUIDANCE =
  'If the task requires no code changes (validation-only, a diagnostic, or already complete): do NOT create an empty commit or PR. This workflow only completes via a reviewed PR, so a no-change task is misrouted — send a message to `space-agent` explaining that the task produced no code changes and needs re-routing, then stop and wait for guidance.\n\n';

const CURRENT_CODING_WORKFLOW_PR_STEP_PROMPT =
  '5. If code changed: open a PR with `gh pr create` — include a clear title and description. After `gh pr create`, call `subscribe_pr_events({ prUrl: "<PR URL>" })`, passing the PR URL from the `gh pr create` output explicitly (it is not auto-resolved from the run until the PR is recorded). This subscribes you to review comments, CI failures, and reactions for your PR so you receive them directly and can act on them. Do this once per PR.\n';
const RETIRED_CODING_WORKFLOW_PR_STEP_PROMPT =
  '5. If code changed: open a PR with `gh pr create` — include a clear title and description\n';
const CURRENT_FULLSTACK_CODING_PR_STEP_PROMPT =
  '3. Open or update the PR and ensure it remains mergeable. After `gh pr create`, call `subscribe_pr_events({ prUrl: "<PR URL>" })`, passing the PR URL from the `gh pr create` output explicitly (it is not auto-resolved from the run until the PR is recorded). This subscribes you to review comments, CI failures, and reactions for your PR so you receive them directly and can act on them. Do this once per PR.\n';
const RETIRED_FULLSTACK_CODING_PR_STEP_PROMPT =
  '3. Open or update the PR and ensure it remains mergeable\n';
const CURRENT_RESEARCH_PR_STEP_PROMPT =
  '5. Commit findings and open a PR with `gh pr create`. After `gh pr create`, call `subscribe_pr_events({ prUrl: "<PR URL>" })`, passing the PR URL from the `gh pr create` output explicitly (it is not auto-resolved from the run until the PR is recorded). This subscribes you to review comments, CI failures, and reactions for your PR so you receive them directly and can act on them. Do this once per PR.\n';
const RETIRED_RESEARCH_PR_STEP_PROMPT = '5. Commit findings and open a PR with `gh pr create`\n';
const RETIRED_NOARG_CODING_WORKFLOW_PR_STEP_PROMPT =
  '5. If code changed: open a PR with `gh pr create` — include a clear title and description. After `gh pr create`, call `subscribe_pr_events({})` (no arguments needed — the PR URL is auto-resolved from the run). This subscribes you to review comments, CI failures, and reactions for your PR so you receive them directly and can act on them. Do this once per PR.\n';
const RETIRED_NOARG_FULLSTACK_CODING_PR_STEP_PROMPT =
  '3. Open or update the PR and ensure it remains mergeable. After `gh pr create`, call `subscribe_pr_events({})` (no arguments needed — the PR URL is auto-resolved from the run). This subscribes you to review comments, CI failures, and reactions for your PR so you receive them directly and can act on them. Do this once per PR.\n';
const RETIRED_NOARG_RESEARCH_PR_STEP_PROMPT =
  '5. Commit findings and open a PR with `gh pr create`. After `gh pr create`, call `subscribe_pr_events({})` (no arguments needed — the PR URL is auto-resolved from the run). This subscribes you to review comments, CI failures, and reactions for your PR so you receive them directly and can act on them. Do this once per PR.\n';

const CURRENT_CODING_WORKFLOW_HANDOFF_PROMPT =
  '6. If code changed: hand off by calling `send_message` to the review target ' +
  'with `data: { pr_url: "<url>" }`. Use the current target and required data ' +
  'fields from the Runtime Execution Contract injected into your task prompt. ' +
  '`save_artifact` alone is insufficient; only `send_message` triggers the ' +
  'hook-validated handoff. Always include the PR URL data field on every ' +
  '`send_message` handoff — the hook validates every cycle, so even on round 2+ ' +
  'you must re-supply it.\n';
const RETIRED_CODING_WORKFLOW_HANDOFF_PROMPT =
  '6. If code changed: hand off by sending a message to Review with ' +
  '`data: { pr_url: "<url>" }`. The gate script verifies the PR is open and ' +
  'mergeable, so make sure it actually is before sending. ' +
  '**Always include `data: { pr_url }` on every send_message to Review** — the gate ' +
  'data resets each cycle, so even on round 2+ you must re-supply it.\n';
const RETIRED_HARDCODED_CODING_WORKFLOW_HANDOFF_PROMPT =
  '6. If code changed: hand off by calling ' +
  '`send_message(target="Review", message="<short summary>", data: { pr_url: "<url>" })`. ' +
  'The `data.pr_url` payload is auto-merged into `code-ready-gate`; the gate script verifies ' +
  'the PR is open and mergeable before Review activates. `save_artifact` alone is insufficient; ' +
  'only `send_message` delivers the gated handoff. ' +
  '**Always include `data: { pr_url }` on every send_message to Review** — the gate ' +
  'data resets each cycle, so even on round 2+ you must re-supply it.\n';
const RETIRED_REVIEW_THREAD_RESOLUTION_GUIDANCE =
  'After pushing fixes for review feedback, resolve ALL open GitHub review conversation ' +
  'threads — including those where you disagree with the reviewer. First reply with your ' +
  'reasoning, then resolve the thread with the `resolveReviewThread` mutation. The ' +
  'PR-ready hook blocks on any unresolved thread, so leaving one open creates a deadlock. ' +
  'If the reviewer disagrees with your reasoning, they can re-open the thread. ' +
  'Use `gh api graphql` to verify no unresolved review conversations remain before ' +
  'sending a message to Review again. ' +
  'Never set a PR to auto-merge — auto-merge is not allowed.';
const RETIRED_CODING_WORKFLOW_REPLY_STEP_PROMPT =
  '3. For valid items: make the fix, then reply to that specific thread via ' +
  '`gh api repos/{owner}/{repo}/pulls/{n}/comments/{comment_id}/replies -f body="<ack>"` ' +
  'explaining what changed. One reply per comment creates a visible audit trail.\n';

const CURRENT_CODING_WORKFLOW_REHANDOFF_PROMPT =
  '6. Verify no unresolved review conversations remain, verify tests still pass, ' +
  'then call `send_message` to the review target again to re-trigger the review ' +
  'cycle. Re-supplying the PR URL data field is required because the hook ' +
  'validates each handoff; `save_artifact` alone will not deliver it.';
const RETIRED_CODING_WORKFLOW_REHANDOFF_PROMPT =
  '6. Verify no unresolved review conversations remain, verify tests still pass, ' +
  'then send_message to Review again (again with `data: { pr_url }`) to ' +
  're-trigger the review cycle';
const RETIRED_HARDCODED_CODING_WORKFLOW_REHANDOFF_PROMPT =
  '6. Verify no unresolved review conversations remain, verify tests still pass, ' +
  'then call `send_message(target="Review", message="<short summary>", data: { pr_url: "<url>" })` ' +
  'again to re-trigger the review cycle. Re-supplying `data.pr_url` is required; ' +
  '`save_artifact` alone will not open `code-ready-gate`.';
const CURRENT_CODING_WORKFLOW_NOCHANGE_STEP_PROMPT =
  '7. If the task requires no code changes (validation-only, a diagnostic, or already ' +
  'complete): do NOT create an empty commit or PR. This workflow only completes via a ' +
  'reviewed PR, so a no-change task is misrouted — record the blocker with ' +
  '`save_artifact({ shape: "note", kind: "no_code_changes", summary: "<why this task needs no code changes>" })` ' +
  'and stop. Do NOT mark the task complete and do NOT wait for a reply: there is no Space-level ' +
  'recipient, and the unfinished task carrying that artifact is the signal a human acts on.\n\n';
const CURRENT_CODER_ONLY_NO_BOT_STOP =
  'an EXPLICIT `external` with no installed bot is likewise never substituted — record the blocker with `save_artifact({ shape: "note", kind: "no_external_review_bot", summary: "the repository has no external reviewer despite an explicit external selection" })` and stop)';
const RETIRED_ESCALATION_CODER_ONLY_NO_BOT =
  'an EXPLICIT `external` with no installed bot is likewise never substituted — escalate saying the repository has no external reviewer)';
const CURRENT_CODER_ONLY_GATE_DIED_STOP =
  '(`both` mode excepted — an emptied gate set there is a blocker: record it with `save_artifact({ shape: "note", kind: "external_gate_died", summary: "every gate-set bot failed and `both` mode forbids the internal fallback" })` and stop)';
const RETIRED_ESCALATION_CODER_ONLY_GATE_DIED =
  '(`both` mode excepted — an emptied gate set there is a blocker: escalate saying the external gate died)';
const CURRENT_CODER_ONLY_NOCHANGE_STEP =
  'do NOT fabricate an empty commit or PR — record the blocker with `save_artifact({ shape: "note", kind: "no_code_changes", summary: "<why this task needs no code changes>" })` and stop. Do NOT wait for a reply: there is no Space-level recipient, and the unfinished task carrying that artifact is the signal a human acts on.';
const RETIRED_ESCALATION_CODER_ONLY_NOCHANGE_STEP =
  'do NOT fabricate an empty commit or PR — escalate via send_message to the escalation target in your Runtime Execution Contract, explain that the task produced no code changes and needs re-routing, and stop and wait for guidance.';
const CURRENT_CODER_ONLY_GATE_FAILURE_STEP =
  'Record the failure with `save_artifact({ shape: "note", kind: "review_gate_failed", summary: "<which gate failed and why>" })` and STOP only when you can run neither an external gate nor a credible internal fallback review (for example, the diff is too large or too risky to self-review). Do NOT wait for a reply: there is no Space-level recipient.';
const RETIRED_ESCALATION_CODER_ONLY_GATE_FAILURE_STEP =
  'Escalate via send_message to the escalation target in your Runtime Execution Contract and STOP only when you can run neither an external gate nor a credible internal fallback review (for example, the diff is too large or too risky to self-review) — say which gate failed and why.';
const RETIRED_ESCALATION_CODING_WORKFLOW_NOCHANGE_STEP_PROMPT =
  '7. If the task requires no code changes (validation-only, a diagnostic, or already ' +
  'complete): do NOT create an empty commit or PR. This workflow only completes via a ' +
  'reviewed PR, so a no-change task is misrouted — escalate via `send_message` to the ' +
  'escalation target listed in your Runtime Execution Contract, explaining that the task ' +
  'produced no code changes and needs re-routing, then stop and wait for guidance.\n\n';
const CURRENT_EXTERNAL_REVIEW_NO_BOT_STOP =
  'save a NON-result artifact describing the blocker (`save_artifact({ shape: "note", kind: "no_external_review_bot", summary: "<why the explicit external selection cannot be satisfied>" })`) and stop; do NOT mark the task complete and do NOT wait for a reply — the unfinished task carrying that artifact is the signal a human acts on. The fallback substitution is for `auto`';
const RETIRED_EXTERNAL_REVIEW_NO_BOT_ESCALATION =
  'and escalate per your escalation contract; the fallback substitution is for `auto`';
const RETIRED_PREVIOUS_CODING_WORKFLOW_NOCHANGE_STEP_PROMPT =
  '7. If the task requires no code changes (validation-only, a diagnostic, or already ' +
  'complete): do NOT create an empty commit or PR. This workflow only completes via a ' +
  'reviewed PR, so a no-change task is misrouted — send a message to `space-agent` ' +
  'explaining that the task produced no code changes and needs re-routing, then stop ' +
  'and wait for guidance.\n\n';
const RETIRED_CODING_WORKFLOW_VALIDATION_STEP_PROMPT =
  '7. If the task is validation-only and produced no code changes: do NOT create an empty commit or PR. ' +
  'Instead, call `save_artifact({ type: "result", append: true, summary: "<validation outcome>", data: { completion_mode: "validation_only", changed_files: 0, validation_outcome: "<passed|failed + evidence>" } })`, then ' +
  '`send_message(target="Validation Complete", message="<short outcome>", data: { completion_mode: "validation_only", changed_files: 0, validation_outcome: "<outcome>" })`. ' +
  'That validation-only handoff bypasses the PR-ready hook and closes the task without `pr_url`.\n\n';
const CURRENT_FULLSTACK_CODING_READY_PROMPT =
  'When implementation is ready, ensure the PR is open and mergeable, then call `send_message` ' +
  'to the review target with `data: { pr_url: "<url>" }`. Use the current ' +
  'target and required data fields from the Runtime Execution Contract injected into your task ' +
  'prompt. `save_artifact` alone is insufficient; only `send_message` triggers the hook-validated ' +
  'handoff. Coding is not the end node — the task-completion tools (`approve_task`, ' +
  '`submit_for_approval`) are not available to you.\n\n';
const RETIRED_FULLSTACK_CODING_READY_PROMPT =
  'When implementation is ready, ensure the PR is open and mergeable and write code-pr-gate with ' +
  'field pr_url so Review can activate. Coding is not the end node — the task-completion tools ' +
  '(`approve_task`, `submit_for_approval`) are not available to you.\n\n';
const RETIRED_HARDCODED_FULLSTACK_CODING_READY_PROMPT =
  'When implementation is ready, ensure the PR is open and mergeable, then call ' +
  '`send_message(target="Review", message="<short summary>", data: { pr_url: "<url>" })`. ' +
  'The `data.pr_url` payload is auto-merged into `code-pr-gate`; the gate script verifies ' +
  'the PR is open and mergeable before Review activates. `save_artifact` alone is insufficient; ' +
  'only `send_message` delivers the gated handoff. Coding is not the end node — the ' +
  'task-completion tools (`approve_task`, `submit_for_approval`) are not available to you.\n\n';
const CURRENT_FULLSTACK_CODING_STEP_PROMPT =
  '4. Hand off by calling `send_message` to the review target with ' +
  '`data: { pr_url: "<url>" }`; `save_artifact` alone will not deliver the handoff\n';
const CURRENT_FULLSTACK_REVIEW_HANDOFF_PROMPT =
  'terminal hand-off is sending `data: { approved: true, pr_url: "<url>" }` to QA after an ' +
  'APPROVE verdict with zero P0-P2 findings. Send the handoff to start the Codex review ' +
  'timeout window (2 hours by default), then wait for a Codex bot `+1` reaction or the ' +
  'timeout before proceeding. ';
const RETIRED_P3_FULLSTACK_REVIEW_HANDOFF_PROMPT =
  'terminal hand-off is sending `data: { approved: true, pr_url: "<url>" }` to QA after an ' +
  'APPROVE verdict with zero P0-P3 findings. Send the handoff to start the Codex review ' +
  'timeout window (2 hours by default), then wait for a Codex bot `+1` reaction or the ' +
  'timeout before proceeding. ';
const RETIRED_FULLSTACK_REVIEW_HANDOFF_PROMPT =
  'terminal handoff is to write `review-approval-gate` with approved=true after an APPROVE ' +
  'verdict with zero P0-P3 findings. Wait for codex[bot] `+1` or timeout before proceeding. ';
const RETIRED_HARDCODED_FULLSTACK_REVIEW_HANDOFF_PROMPT =
  'terminal handoff is `send_message(target="QA", message="<approved>", data: { approved: true })` ' +
  'after an APPROVE verdict with zero P0-P3 findings. Wait for codex[bot] `+1` or timeout before proceeding. ';
const RETIRED_PRE_FIX_FULLSTACK_REVIEW_HANDOFF_PROMPT =
  'terminal hand-off is sending `data: { approved: true, pr_url: "<url>" }` to QA after an ' +
  'APPROVE verdict with zero P0-P3 findings. Send the handoff to start the 10-minute ' +
  'Codex timeout, then wait for codex[bot] `+1` or timeout before proceeding. ';
const RETIRED_FULLSTACK_CODING_STEP_PROMPT =
  '4. Write code-pr-gate with field pr_url so Review can activate\n';
const RETIRED_HARDCODED_FULLSTACK_CODING_STEP_PROMPT =
  '4. Hand off to Review by calling ' +
  '`send_message(target="Review", message="<short summary>", data: { pr_url: "<url>" })`; ' +
  '`save_artifact` alone will not open `code-pr-gate`\n';

const RETIRED_CODEX_REACTION_APPROVAL_GUIDANCE =
  'After posting your approval review, verify codex[bot] reaction status before ' +
  'closing or handing off. Use `gh api repos/{owner}/{repo}/issues/{number}/reactions` ' +
  'and inspect reactions from `user.login == "codex[bot]"`: content `+1` means ' +
  'Codex passed, content `eyes` means Codex is still reviewing, and no codex[bot] ' +
  'reaction means it has not started or has not reported yet. If codex[bot] has not ' +
  'reacted at all, comment `@codex review` on the PR to trigger its review, then wait ' +
  'for an `eyes` or `+1` reaction. ' +
  'Only a +1 newer than the current PR head commit counts — after a revision push, ' +
  'an older +1 from a previous cycle is stale and will not satisfy the hook. If the +1 ' +
  'looks old, retrigger Codex with a fresh `@codex review` comment. ' +
  'Send the approval handoff to start the Codex timeout (10 minutes). If the hook ' +
  'blocks because Codex has not yet posted `+1`, poll every 60 seconds and retry the ' +
  'handoff. If codex[bot] still has not posted `+1` after the timeout, proceed ' +
  'only with a warning recorded in your result artifact. Do not close the task ' +
  'before codex[bot] has `+1` unless that timeout has elapsed.';

const SHAPE_PR_LINK = 'save_artifact({ shape: "link", kind: "pr", data: { url: "<url>" } })';
const RETIRED_TYPE_RESULT_PR_LINK = 'save_artifact({ type: "result", data: { pr_url: "<url>" } })';
const SHAPE_PR_EVERY_CYCLE =
  'Use save_artifact every cycle to record the PR as a `link` so post-approval dispatch can resolve it.\n\n';
const RETIRED_TYPE_RESULT_EVERY_CYCLE =
  'Use save_artifact every cycle. Nest pr_url inside artifact data for post-approval dispatch.\n\n';
const CURRENT_REVIEW_ONLY_TERMINAL_ACTIONS =
  'invoke(name="artifact.save", input={ shape: "link", kind: "pr", data: { url: "<url>" } }) ' +
  'to record the PR, then invoke(name="task.resolvePendingCompletion", input={ taskId: "<task id>", approved: true }) ' +
  'or invoke(name="task.submitForReview", input={ taskId: "<task id>" }) only on APPROVE';
const RETIRED_TYPED_TOOL_REVIEW_ONLY_TERMINAL_ACTIONS =
  'save_artifact({ shape: "link", kind: "pr", data: { url: "<url>" } }) to record the PR, ' +
  'then approve_task() or submit_for_approval only on APPROVE';
const SHAPE_PR_LINK_REVIEW_ONLY =
  'save_artifact({ shape: "link", kind: "pr", data: { url: "<url>" } }) to record the PR';
const RETIRED_TYPE_RESULT_PR_LINK_REVIEW_ONLY =
  'save_artifact({ type: "result", data: { pr_url: "<url>" } }) to save a result artifact';
const SHAPE_NOTE_QA_FAILED =
  '`save_artifact({ shape: "note", kind: "qa", key: "cycle-<N>", summary: "QA failed (cycle <N>): ..." })` to record the audit entry — a note, never a terminal decision, and keyed per cycle (<N> = this QA round, 1-based) so each failure cycle keeps its own repro evidence instead of overwriting the last. Do ';
const RETIRED_TYPE_RESULT_QA_FAILED =
  '`save_artifact({ type: "result", append: true, summary: "QA failed: ..." })` to record the audit entry. Do ';
const SHAPE_QA_ALL_GREEN =
  'a. Record the PR and the terminal QA outcome as two artifacts: ' +
  '`save_artifact({ shape: "link", kind: "pr", data: { url: "<url>" } })` ' +
  '(the canonical PR record the post-approval merge step resolves as the ' +
  'primary link) and `save_artifact({ shape: "decision", summary, data: { ' +
  'recommendation: "pass", test_output: "<output>", ui_changed: <boolean>, dev_server_started: <boolean>, ' +
  'browser_validation: "<what was exercised or why skipped>" } })` (the terminal ' +
  'outcome summary). Top-level keys outside `data` are silently stripped by the ' +
  'tool schema, so nest fields correctly.\n';
const RETIRED_TYPE_RESULT_QA_ALL_GREEN =
  'a. Call `save_artifact({ type: "result", append: true, summary, data: { ' +
  'pr_url: "<url>", test_output: "<output>", ui_changed: <boolean>, dev_server_started: <boolean>, ' +
  'browser_validation: "<what was exercised or why skipped>" } })` to record the audit entry. The ' +
  '`pr_url` inside `data` is what `dispatchPostApproval` reads when interpolating `{{pr_url}}` into the ' +
  'merge template — top-level keys outside `data` are silently stripped by the tool schema, so nest it ' +
  'correctly.\n';

const BUILT_IN_PROMPT_PATCH_VARIANTS = [
  ...RETIRED_INLINE_OPERATION_PROMPT_PAIRS.map((pair) => [pair]),
  [[REVIEW_THREAD_RESOLUTION_GUIDANCE, RETIRED_REVIEW_THREAD_RESOLUTION_GUIDANCE]],
  [
    [
      '3. For valid items: make the fix, then reply to that specific thread. Prefer the ' +
        '`external_event` essence handle: use `replyHandle.commentId` as the REST ' +
        '`{comment_id}` and the PR URL host as `<host>` in ' +
        '`gh api --hostname <host> repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies -f body="<ack>"` ' +
        'explaining what changed. One reply per comment creates a visible audit trail.\n',
      RETIRED_CODING_WORKFLOW_REPLY_STEP_PROMPT,
    ],
  ],
  [
    [
      '3. For valid items: make the fix, then reply to that specific thread. Prefer the ' +
        '`external_event` essence handle: use `replyHandle.commentId` as the REST ' +
        '`{comment_id}` and the PR URL host as `<host>` in ' +
        '`gh api --hostname <host> repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies -f body="<ack>"` ' +
        'explaining what changed. One reply per comment creates a visible audit trail.\n',
      RETIRED_CODING_WORKFLOW_REPLY_STEP_PROMPT,
    ],
    [REVIEW_THREAD_RESOLUTION_GUIDANCE, RETIRED_REVIEW_THREAD_RESOLUTION_GUIDANCE],
  ],
  [[CURRENT_CODING_WORKFLOW_PR_STEP_PROMPT, RETIRED_CODING_WORKFLOW_PR_STEP_PROMPT]],
  [[CURRENT_CODING_WORKFLOW_PR_STEP_PROMPT, RETIRED_NOARG_CODING_WORKFLOW_PR_STEP_PROMPT]],
  [[CURRENT_FULLSTACK_CODING_PR_STEP_PROMPT, RETIRED_NOARG_FULLSTACK_CODING_PR_STEP_PROMPT]],
  [[CURRENT_RESEARCH_PR_STEP_PROMPT, RETIRED_NOARG_RESEARCH_PR_STEP_PROMPT]],
  [[CODER_OWNED_PR_SUBSCRIBE_GUIDANCE, '']],
  [[CALL_ACTION_PREFERENCE_GUIDANCE, CALL_ACTION_PREFERENCE_GUIDANCE_PRE_OPERATION_NAMES]],
  [[CURRENT_REVIEW_ONLY_TERMINAL_ACTIONS, RETIRED_TYPED_TOOL_REVIEW_ONLY_TERMINAL_ACTIONS]],
  [[CALL_ACTION_PREFERENCE_GUIDANCE, '']],
  [[`\n${CALL_ACTION_PREFERENCE_GUIDANCE}`, '']],
  [[REVIEWER_ZERO_FINDINGS_GATE, '']],
  [[REVIEWER_ZERO_FINDINGS_GATE, RETIRED_P3_REVIEWER_ZERO_FINDINGS_GATE]],
  [[CURRENT_FULLSTACK_REVIEW_HANDOFF_PROMPT, RETIRED_P3_FULLSTACK_REVIEW_HANDOFF_PROMPT]],
  [
    [CURRENT_CODING_WORKFLOW_PR_STEP_PROMPT, RETIRED_CODING_WORKFLOW_PR_STEP_PROMPT],
    [CURRENT_CODING_WORKFLOW_HANDOFF_PROMPT, RETIRED_CODING_WORKFLOW_HANDOFF_PROMPT],
    [CURRENT_CODING_WORKFLOW_REHANDOFF_PROMPT, RETIRED_CODING_WORKFLOW_REHANDOFF_PROMPT],
  ],
  [
    [CURRENT_CODING_WORKFLOW_PR_STEP_PROMPT, RETIRED_CODING_WORKFLOW_PR_STEP_PROMPT],
    [CURRENT_CODING_WORKFLOW_HANDOFF_PROMPT, RETIRED_HARDCODED_CODING_WORKFLOW_HANDOFF_PROMPT],
    [CURRENT_CODING_WORKFLOW_REHANDOFF_PROMPT, RETIRED_HARDCODED_CODING_WORKFLOW_REHANDOFF_PROMPT],
  ],
  [[CURRENT_CODING_WORKFLOW_NOCHANGE_STEP_PROMPT, RETIRED_CODING_WORKFLOW_VALIDATION_STEP_PROMPT]],
  [
    [
      CURRENT_CODING_WORKFLOW_NOCHANGE_STEP_PROMPT,
      RETIRED_PREVIOUS_CODING_WORKFLOW_NOCHANGE_STEP_PROMPT,
    ],
  ],
  [
    [
      CURRENT_CODING_WORKFLOW_NOCHANGE_STEP_PROMPT,
      RETIRED_ESCALATION_CODING_WORKFLOW_NOCHANGE_STEP_PROMPT,
    ],
  ],
  [[FULLSTACK_CODING_NOCHANGE_GUIDANCE, RETIRED_ESCALATION_FULLSTACK_CODING_NOCHANGE_GUIDANCE]],
  [[CURRENT_EXTERNAL_REVIEW_NO_BOT_STOP, RETIRED_EXTERNAL_REVIEW_NO_BOT_ESCALATION]],
  [[CURRENT_CODER_ONLY_NOCHANGE_STEP, RETIRED_ESCALATION_CODER_ONLY_NOCHANGE_STEP]],
  [[CURRENT_CODER_ONLY_GATE_FAILURE_STEP, RETIRED_ESCALATION_CODER_ONLY_GATE_FAILURE_STEP]],
  [[CURRENT_CODER_ONLY_NO_BOT_STOP, RETIRED_ESCALATION_CODER_ONLY_NO_BOT]],
  [[CURRENT_CODER_ONLY_GATE_DIED_STOP, RETIRED_ESCALATION_CODER_ONLY_GATE_DIED]],
  [[CURRENT_FULLSTACK_CODING_PR_STEP_PROMPT, RETIRED_FULLSTACK_CODING_PR_STEP_PROMPT]],
  [
    [CURRENT_FULLSTACK_CODING_PR_STEP_PROMPT, RETIRED_FULLSTACK_CODING_PR_STEP_PROMPT],
    [CURRENT_FULLSTACK_CODING_READY_PROMPT, RETIRED_FULLSTACK_CODING_READY_PROMPT],
    [CURRENT_FULLSTACK_CODING_STEP_PROMPT, RETIRED_FULLSTACK_CODING_STEP_PROMPT],
  ],
  [
    [CURRENT_FULLSTACK_CODING_PR_STEP_PROMPT, RETIRED_FULLSTACK_CODING_PR_STEP_PROMPT],
    [CURRENT_FULLSTACK_CODING_READY_PROMPT, RETIRED_HARDCODED_FULLSTACK_CODING_READY_PROMPT],
    [CURRENT_FULLSTACK_CODING_STEP_PROMPT, RETIRED_HARDCODED_FULLSTACK_CODING_STEP_PROMPT],
  ],
  [[FULLSTACK_CODING_NOCHANGE_GUIDANCE, '']],
  [[FULLSTACK_CODING_NOCHANGE_GUIDANCE, RETIRED_PREVIOUS_FULLSTACK_CODING_NOCHANGE_GUIDANCE]],
  [[CURRENT_RESEARCH_PR_STEP_PROMPT, RETIRED_RESEARCH_PR_STEP_PROMPT]],
  [[CURRENT_FULLSTACK_REVIEW_HANDOFF_PROMPT, RETIRED_FULLSTACK_REVIEW_HANDOFF_PROMPT]],
  [[CURRENT_FULLSTACK_REVIEW_HANDOFF_PROMPT, RETIRED_HARDCODED_FULLSTACK_REVIEW_HANDOFF_PROMPT]],
  [[CODEX_REACTION_APPROVAL_GUIDANCE, RETIRED_CODEX_REACTION_APPROVAL_GUIDANCE]],
  [
    [CURRENT_FULLSTACK_REVIEW_HANDOFF_PROMPT, RETIRED_FULLSTACK_REVIEW_HANDOFF_PROMPT],
    [CODEX_REACTION_APPROVAL_GUIDANCE, RETIRED_CODEX_REACTION_APPROVAL_GUIDANCE],
  ],
  [
    [CURRENT_FULLSTACK_REVIEW_HANDOFF_PROMPT, RETIRED_HARDCODED_FULLSTACK_REVIEW_HANDOFF_PROMPT],
    [CODEX_REACTION_APPROVAL_GUIDANCE, RETIRED_CODEX_REACTION_APPROVAL_GUIDANCE],
  ],
  [
    [CURRENT_FULLSTACK_REVIEW_HANDOFF_PROMPT, RETIRED_PRE_FIX_FULLSTACK_REVIEW_HANDOFF_PROMPT],
    [CODEX_REACTION_APPROVAL_GUIDANCE, RETIRED_CODEX_REACTION_APPROVAL_GUIDANCE],
  ],
  [[CURRENT_FULLSTACK_REVIEW_HANDOFF_PROMPT, RETIRED_PRE_FIX_FULLSTACK_REVIEW_HANDOFF_PROMPT]],
  [[REVIEWER_POST_APPROVAL_BLOCKER_PARAGRAPH, '']],
  [[FULLSTACK_QA_POST_APPROVAL_PARAGRAPH, '']],
  [[SHAPE_PR_LINK, RETIRED_TYPE_RESULT_PR_LINK]],
  [
    [SHAPE_PR_EVERY_CYCLE, RETIRED_TYPE_RESULT_EVERY_CYCLE],
    [SHAPE_PR_LINK, RETIRED_TYPE_RESULT_PR_LINK],
  ],
  [[SHAPE_PR_LINK_REVIEW_ONLY, RETIRED_TYPE_RESULT_PR_LINK_REVIEW_ONLY]],
  [[SHAPE_NOTE_QA_FAILED, RETIRED_TYPE_RESULT_QA_FAILED]],
  [[SHAPE_QA_ALL_GREEN, RETIRED_TYPE_RESULT_QA_ALL_GREEN]],
  [[CODER_OWNED_MERGE_PROMPT, RETIRED_PRE_REVIEW_MODES_CODER_OWNED_MERGE_PROMPT]],
  [[CODER_ONLY_PROMPT, RETIRED_PRE_REVIEW_MODES_CODER_ONLY_PROMPT]],
  [[RESEARCH_PROMPT, RETIRED_PRE_REVIEW_MODES_RESEARCH_PROMPT]],
  [[CODER_OWNED_MERGE_PROMPT, RETIRED_PRE_BASE_ADVANCE_POLICY_CODER_OWNED_MERGE_PROMPT]],
  [[CODER_ONLY_PROMPT, RETIRED_PRE_BASE_ADVANCE_POLICY_CODER_ONLY_PROMPT]],
  [[RESEARCH_PROMPT, RETIRED_PRE_BASE_ADVANCE_POLICY_RESEARCH_PROMPT]],
  [[CODER_OWNED_MERGE_PROMPT, RETIRED_PRE_EVENT_DRIVEN_CODER_OWNED_MERGE_PROMPT]],
  [[CODER_ONLY_PROMPT, RETIRED_PRE_EVENT_DRIVEN_CODER_ONLY_PROMPT]],
  [[RESEARCH_PROMPT, RETIRED_PRE_EVENT_DRIVEN_RESEARCH_PROMPT]],
  [[RETIRED_INLINE_REVIEWER_ZERO_FINDINGS_GATE, '']],
  [[RETIRED_INLINE_REVIEWER_ZERO_FINDINGS_GATE, RETIRED_P3_REVIEWER_ZERO_FINDINGS_GATE]],
  [[RETIRED_INLINE_EXTERNAL_REVIEW_BOTS_GUIDANCE, EXTERNAL_REVIEW_BOTS_GUIDANCE_PRE_CHECK_SEEDING]],
  [[EXTERNAL_REVIEW_BOTS_GUIDANCE, EXTERNAL_REVIEW_BOTS_GUIDANCE_PRE_CHECK_SEEDING]],
  [[EXTERNAL_REVIEW_BOTS_GUIDANCE_PRE_CHECK_SEEDING, EXTERNAL_REVIEW_BOTS_GUIDANCE_PRE_TYPENAME]],
] as const;

export function patchKnownBuiltInPromptDrift<T extends WorkflowNodeAgentOverride | undefined>(
  existingPrompt: T,
  templatePrompt: T
): T {
  const existingValue = existingPrompt?.value;
  const templateValue = templatePrompt?.value;
  if (!existingValue || !templateValue || existingValue === templateValue) return existingPrompt;
  if (!isExactRetiredBuiltInPrompt(existingValue, templateValue)) return existingPrompt;
  return { ...existingPrompt, value: templateValue } as T;
}

function isExactRetiredBuiltInPrompt(existingValue: string, templateValue: string): boolean {
  return buildRetiredBuiltInPromptValues(templateValue).some((value) => existingValue === value);
}

function buildRetiredBuiltInPromptValues(templateValue: string): string[] {
  const values = new Set<string>();
  let candidates = new Set([templateValue]);

  for (const replacements of BUILT_IN_PROMPT_PATCH_VARIANTS) {
    const nextCandidates = new Set(candidates);
    for (const candidate of candidates) {
      let value = candidate;
      for (const [currentText, retiredText] of replacements) {
        if (!value.includes(currentText)) {
          value = candidate;
          break;
        }
        value = value.replace(currentText, retiredText);
      }
      if (value !== candidate) {
        values.add(value);
        nextCandidates.add(value);
      }
    }
    candidates = nextCandidates;
  }

  return [...values];
}
