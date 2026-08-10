/**
 * Built-in Workflow Templates
 *
 * Defines the canonical workflow templates bundled with HyperNeo.
 * These serve as defaults and examples for Space users.
 *
 * Design notes:
 * - Leader is always implicit in SpaceRuntime — never a workflow node.
 * - Templates use placeholder `id` / `spaceId` (empty strings) and role names
 *   as `agentId` placeholders ('planner', 'coder', 'general'). These are
 *   replaced with real SpaceWorkerAgent UUIDs by `seedBuiltInWorkflows`.
 * - Workflows use gated channels for inter-agent communication (agent-centric
 *   model). Transitions are empty for agent-centric workflows; completion is
 *   detected when all agents report done.
 * - At Space creation time, preset SpaceWorkerAgent records are seeded for each
 *   BuiltinAgentRole. `seedBuiltInWorkflows` must be called after those agents
 *   exist so that the `agentId` values resolve correctly.
 * - Channels use node names (e.g. 'Plan', 'Coding') in `from`/`to` so they
 *   resolve correctly at runtime without UUID translation in the seeder.
 *   `resolveChannels()` matches node names via the `nodeNameToAgents` lookup.
 */

import type {
  DeclarativeToolGuard,
  Gate,
  GateField,
  GateScript,
  SpaceWorkflow,
  WorkflowChannel,
  WorkflowNode,
  WorkflowNodeAgentOverride,
} from '@hyperneo/shared';
import { generateUUID, hasEnabledGateFeature, resolveNodeAgents } from '@hyperneo/shared';
import { createHash } from 'node:crypto';
import { Logger } from '../../logger';
import { QA_SYSTEM_CONTRACT } from '../agents/system-contracts.ts';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';
import { isApprovalGate } from '../runtime/gate-features';
import { CODER_OWNED_MERGE_INSTRUCTIONS } from './post-approval-merge-template.ts';
import { computeWorkflowHash } from './template-hash.ts';
import { migrateWorkflowGateProgressionToHooks } from './workflow-migration.ts';

// ---------------------------------------------------------------------------
// Gate writer validation
// ---------------------------------------------------------------------------

export function validateWorkflowTemplateGateWriters(workflow: SpaceWorkflow): string[] {
  const errors: string[] = [];
  const validWriters = new Set<string>(['*']);

  for (const node of workflow.nodes) {
    validWriters.add(node.name);
    for (const agent of node.agents ?? []) {
      validWriters.add(agent.name);
    }
  }

  for (const gate of workflow.gates ?? []) {
    for (const field of gate.fields ?? []) {
      const loc = `${workflow.name}.gates.${gate.id}.fields.${field.name}.writers`;
      validateGateFieldWriters(field, validWriters, loc, errors);
    }
  }

  return errors;
}

function validateGateFieldWriters(
  field: GateField,
  validWriters: ReadonlySet<string>,
  loc: string,
  errors: string[]
): void {
  if (!Array.isArray(field.writers)) {
    errors.push(`${loc}: must be an array`);
    return;
  }

  // Built-in templates require automated writers; [] remains valid only for custom external-only gates.
  if (field.writers.length === 0) {
    errors.push(`${loc}: must contain at least one writer role`);
    return;
  }

  for (const writer of field.writers) {
    if (typeof writer !== 'string' || writer.trim().length === 0) {
      errors.push(`${loc}: writer roles must be non-empty strings`);
      continue;
    }

    if (!validWriters.has(writer)) {
      errors.push(`${loc}: unknown writer role "${writer}"`);
    }
  }
}

const builtInSeederLog = new Logger('seed-built-in-workflows');

const LEGACY_PR_READY_GATE_IDS = new Set([
  'code-ready-gate',
  'research-ready-gate',
  'plan-pr-gate',
  'code-pr-gate',
]);
const LEGACY_PR_READY_TEMPLATE_ROUTES = new Set([
  'code-ready-gate:Coding:Review',
  'research-ready-gate:Research:Review',
  'plan-pr-gate:Planning:Plan Review',
  'code-pr-gate:Coding:Review',
]);

// ---------------------------------------------------------------------------
// Retired declarative tool guard: coder-role agents must not merge
// ---------------------------------------------------------------------------

/**
 * Retired coder no-merge guard. Kept verbatim (NOT applied to any built-in
 * slot) so the restamp logic can recognize legacy seeded coder slots that
 * carried it and clear their `toolGuards` during migration — the stable coder
 * now OWNS the post-approval merge (`gh pr merge`), so a coder no-merge guard
 * would break the coder's own merge. Matches `gh pr merge` and its wrapped
 * forms. (A separate reviewer run-scoping guard was explored and removed per
 * the product decision to govern Reviewer Bash by the System Contract prompt
 * rather than a regex — see the system contract, not this constant.)
 */
const RETIRED_CODER_NO_MERGE_GUARD: DeclarativeToolGuard = {
  matcher: 'Bash',
  pattern:
    '(?:^|[;&|()\\n`])\\s*(?:(?:env\\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=[^\\s;&|()`]+|command)\\s+)*gh[\\s\\\\]+pr[\\s\\\\]+merge\\b',
  decision: 'deny',
  reason:
    'Coder-role agents must not merge PRs. Their job is implementation only; the reviewer handles the merge after approval.',
};

// ---------------------------------------------------------------------------
// Template node ID constants (used as stable IDs for workflow nodes and startNodeId)
// ---------------------------------------------------------------------------

// Plan & Decompose node IDs
const PD_PLANNING_NODE = 'tpl-pd-planning';
const PD_PLAN_REVIEW_NODE = 'tpl-pd-plan-review';
const PD_TASK_DISPATCHER_NODE = 'tpl-pd-task-dispatcher';

/**
 * Review-posted gate.
 *
 * Verifies that the Reviewer has actually posted review evidence on the PR
 * since the workflow run started. This gate guards the Review → Coding feedback
 * channel: the runtime refuses to deliver a "changes requested" message until
 * a formal review or at least one PR comment is visible on GitHub.
 *
 * The check is a declarative reference to the `review_posted` built-in
 * validator — an `external_state` preset over the github connector's
 * `getReviewEvidence` op (see runtime/connectors/presets.ts). The preset
 * encodes: a formal review (APPROVED/CHANGES_REQUESTED) since workflow start as
 * primary evidence, with an own-PR fallback (COMMENTED review / PR comment)
 * since GitHub blocks self-APPROVE. No hand-rolled bash.
 */

/**
 * Reviewer Terminal Action Pre-conditions block.
 *
 * Prepended to every review-style end-node prompt that exposes the terminal
 * task-completion tools (`approve_task`, `submit_for_approval`). Establishes a
 * hard pre-condition: terminal actions are valid ONLY when the review verdict
 * is APPROVE with zero P0–P3 findings. While findings are open, the cycle MUST
 * continue via `send_message(target="<upstream>", ...)` — the reviewer must not
 * close the loop or hand off to a human until the work is actually clean.
 *
 * The wording deliberately equates `submit_for_approval` with `approve_task`
 * (both close the review loop) so the model cannot interpret it as "let a
 * human decide while findings are still open".
 *
 * @param upstreamNodeName - The peer node the reviewer must send feedback to
 *   when posting REQUEST_CHANGES (e.g. "Coding", "Research", "Planning").
 */
function reviewerFeedbackProcedure(upstreamNodeName: string): string {
  return (
    'Follow the Reviewer System Contract and terminal-action tool contract. ' +
    'Before any progression handoff or terminal action, post a visible GitHub review. ' +
    `If requesting changes, send_message(target="${upstreamNodeName}", ...) with ` +
    'pr_url, review_url, and comment_urls, save a result artifact, then stop. '
  );
}

const PD_PLANNING_PROMPT =
  'You are the Planning node in a Plan & Decompose Workflow. Your role is to turn the user goal ' +
  'into a concrete, decomposable plan that a Task Dispatcher can fan out into standalone tasks.\n\n' +
  'Your plan must include:\n' +
  '- Goal summary: what is being built, migrated, or delivered, in one paragraph\n' +
  '- Work items: a numbered list of actionable items — each a unit small enough for one task, ' +
  'with a clear title, 2-4 sentence description, and suggested priority (low/normal/high/urgent)\n' +
  '- Dependencies: between work items (item B depends on item A)\n' +
  '- Out of scope: what is intentionally not included\n' +
  '- Open questions: anything that needs clarification before tasks are dispatched\n\n' +
  'Write the plan to `plan.md` at the repo root, commit it, and open/update a PR targeting the ' +
  'default branch. After the PR is open and mergeable, hand off to Plan Review by calling ' +
  '`send_message(target="Plan Review", message="<short summary>", data: { pr_url: "<plan PR url>" })`. ' +
  'The hook validates the PR is open and mergeable before Plan Review activates. Without this explicit ' +
  '`pr_url` the send is blocked. Always re-supply ' +
  '`data: { pr_url }` on every send to Plan Review — the hook runs on every send, so the ' +
  'URL must be reasserted after every revision.';

const CODEX_REACTION_APPROVAL_GUIDANCE =
  'After posting your approval review, verify the Codex review bot reaction status ' +
  'before closing or handing off. Use the run-scoped GraphQL reaction lookup ' +
  '(the Reviewer contract permits the run-scoped `gh api graphql` lookup; direct `gh api repos/...` ' +
  'REST reads against other repos are forbidden by contract), resolving the PR number and host from the run PR URL and reading `reactions` ' +
  '(parse the host and pass `--hostname` so GitHub Enterprise PRs are queried on the enterprise ' +
  'host, not the default github.com): ' +
  '`PR_URL=<pr_url>; HOST=${PR_URL#https://}; HOST=${HOST%%/*}; gh api graphql --hostname "$HOST" ' +
  "-f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){... on PullRequest {reactions(first:100){nodes{content user{login}}}}}}}' -f owner=<owner> -f name=<repo> -F number=<number>` " +
  'and inspect reactions from any login containing `codex` (case-insensitive — GitHub ' +
  'ships multiple variants such as `codex[bot]` and `chatgpt-codex-connector[bot]`, and ' +
  'the matcher accepts any of them): content `+1` means Codex passed, content `eyes` ' +
  'means Codex is still reviewing, and no such reaction means it has not started or has ' +
  'not reported yet. If no codex login has reacted at all, comment `@codex review` on ' +
  'the PR to trigger its review, then wait for an `eyes` or `+1` reaction. ' +
  'Only a +1 newer than the current PR head commit counts — after a revision push, ' +
  'an older +1 from a previous cycle is stale and will not satisfy the hook. If the +1 ' +
  'looks old, retrigger Codex with a fresh `@codex review` comment. ' +
  'Send the approval handoff to start the Codex timeout window (2 hours by default; ' +
  'configurable per workflow node). If the hook blocks because Codex has not yet posted ' +
  '`+1`, poll every 60 seconds and retry the handoff. If the bot still has not posted ' +
  '`+1` after the timeout window elapses, proceed only with a warning recorded in your ' +
  'result artifact. Do not close the task before the Codex bot has `+1` unless that ' +
  'timeout window has elapsed.';

const PD_PLAN_REVIEW_PROMPT =
  'You are one of four independent Plan Reviewers. Review the plan PR through your lens before ' +
  'tasks are dispatched. Use the Reviewer System Contract for review quality and severity.\n\n' +
  'Plan Review is not the end node: do not call approve_task or submit_for_approval. Your terminal ' +
  'action is sending your `approvals` vote in the Task Dispatcher handoff data. Vote approved only for zero P0-P3 ' +
  'lens findings; otherwise vote rejected and send actionable feedback to Planning.\n\n' +
  CODEX_REACTION_APPROVAL_GUIDANCE +
  '\n\n' +
  'Procedure: read the PR diff with `gh pr diff` / `gh pr view`, post a visible PR review comment, then ' +
  'send_message(target="Task Dispatcher", message: "<short summary>", data: { approvals: { "<your lens>": "approved" }, ' +
  'pr_url: "<plan PR url>" }). Early approvals normally get a hook-blocked response; ' +
  'the hook records each vote until all four approvals are present. On rejection, send ' +
  '`{ "<your lens>": "rejected" }` to Planning with required changes.';

const PD_TASK_DISPATCHER_PROMPT =
  'You are the Task Dispatcher in a Plan & Decompose Workflow. You are the end node. ' +
  'All four Plan Reviewers have approved the plan — your job is to fan the plan out into ' +
  'standalone follow-up tasks using the `create_standalone_task` MCP tool. Each task ' +
  'description must include stacked PR instructions so the downstream coder knows exactly ' +
  'which base branch to target, forming a reviewable PR chain across the plan.\n\n' +
  'Follow the terminal-action tool contract. approve_task/submit_for_approval are final ' +
  'actions; use only after every downstream task is created and every returned task ID is ' +
  'recorded in a result artifact. If dispatch is incomplete, send feedback to Planning and stop.\n\n' +
  'Steps:\n' +
  '1. Read the approved plan from the plan PR (`gh pr diff` or `gh pr view --json files`). ' +
  'Identify each actionable work item in order and record its title, description, priority, ' +
  'and acceptance criteria.\n' +
  '2. Generate a stack prefix from the plan title: a short kebab-case slug derived from the ' +
  'key words, e.g. "Migrate auth to JWT tokens" → "migrate-auth-jwt", "Add file upload ' +
  'support" → "add-file-upload". All branches in the stack share this prefix so they are ' +
  'grouped: `plan/<prefix>/<item-slug>`.\n' +
  '3. Create standalone tasks in BOTTOM-UP order (item 1 first, then item 2, etc.) by ' +
  'calling `create_standalone_task({ title, description, priority, depends_on })` for each. ' +
  'ALWAYS pass `depends_on` as a structured array of prerequisite task IDs so the runtime can ' +
  'enforce ordering, block dependents until prerequisites are done, and cascade-cancel on ' +
  'failure. Do NOT rely on prose-only dependency hints — they are informational, not enforced.\n\n' +
  '   - BOTTOM task (item 1): `depends_on: []` (no prerequisites).\n' +
  '   - MIDDLE / TOP tasks (item N > 1): `depends_on: [<task_id of item N-1>]`.\n\n' +
  'The `description` must contain the original plan item content PLUS a ' +
  '"## Stacked PR Instructions" section appended at the end.\n\n' +
  '   For the BOTTOM task (item 1 — PR base is `dev`):\n' +
  '   ```\n' +
  '   ## Stacked PR Instructions\n' +
  '   This task is the bottom of a stacked PR chain. When creating your PR:\n' +
  '   - Branch name: plan/<stack-prefix>/<item-1-slug>\n' +
  '   - Base branch: dev\n' +
  '   - PR body must include: "Part of stack: <plan title>. PR 1 of N (bottom)."\n' +
  '   ```\n\n' +
  "   For MIDDLE and TOP tasks (item N where N > 1 — PR base is the previous item's branch):\n" +
  '   ```\n' +
  '   ## Stacked PR Instructions\n' +
  '   This task is part of a stacked PR chain. When creating your PR:\n' +
  '   - Branch name: plan/<stack-prefix>/<item-N-slug>\n' +
  '   - Base branch: plan/<stack-prefix>/<item-(N-1)-slug>\n' +
  '   - PR body must include: "Part of stack: <plan title>. PR N of [total]."\n' +
  '   - IMPORTANT: The task below you in the stack (task #<prev-task-id>) must have an ' +
  'open or merged PR on branch plan/<stack-prefix>/<item-(N-1)-slug> before you create ' +
  'yours. Verify with: `gh pr list --head plan/<stack-prefix>/<item-(N-1)-slug>`\n' +
  '   - This task depends on task #<prev-task-id>. Start implementation only after ' +
  "that task's branch exists.\n" +
  '   ```\n\n' +
  '4. Collect the returned task IDs. Build a stack map: ' +
  '{ prefix, items: [{ title, task_id, branch, base_branch, position }] }.\n' +
  '5. Call `save_artifact({ shape: "decision", summary: "Created N tasks from plan: <short list>", ' +
  'data: { recommendation: "dispatched", created_task_ids: [<ids>], stack_prefix: "<prefix>", ' +
  'stack_branches: ["plan/<prefix>/<item-1-slug>", "plan/<prefix>/<item-2-slug>", ...] } })` to record the dispatch outcome.\n' +
  '6. Call `approve_task()` as your final action. If autonomy blocks self-close, call ' +
  '`submit_for_approval({ reason: "..." })` instead.\n\n' +
  'CRITICAL: Do NOT create branches, make commits, push to git, or open PRs yourself — ' +
  "that is the downstream coder's job. Do NOT implement the work items yourself. " +
  'Do NOT create fewer tasks than the plan requires. ' +
  'If the plan is empty or ambiguous, send feedback to Planning before closing the task.';

const REVIEW_THREAD_RESOLUTION_GUIDANCE =
  'After pushing fixes for review feedback, resolve ALL open GitHub review conversation ' +
  'threads — including those where you disagree with the reviewer. When the feedback ' +
  'arrives as an `external_event` review comment essence, use its `replyHandle.commentId` ' +
  'as the REST `{comment_id}` and the PR URL host as `<host>` for ' +
  '`gh api --hostname <host> repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies -f body="<ack>"`. ' +
  'Then resolve the thread with GraphQL ' +
  "`gh api graphql --hostname <host> -f query='mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}' -f threadId=<review-thread-node-id>`, " +
  'where `<host>` is the PR URL host and `<review-thread-node-id>` is the `PullRequestReviewThread.id` found by querying ' +
  '`reviewThreads`; do not use the review comment `node_id`/`commentNodeId` as ' +
  '`threadId`. The PR-ready hook blocks on any unresolved thread, so leaving one ' +
  'open creates a deadlock. If the reviewer disagrees with your reasoning, they can ' +
  're-open the thread. Use `gh api graphql` to verify no unresolved review conversations ' +
  'remain before sending a message to Review again. Never set a PR to auto-merge — ' +
  'auto-merge is not allowed.';

const REVIEW_THREAD_APPROVAL_CHECK_GUIDANCE =
  'Verify the PR is still open, mergeable, and has no unresolved GitHub review ' +
  'conversations. Use `gh api graphql` to inspect `reviewThreads` and confirm every ' +
  'thread has `isResolved: true`; if unresolved conversations remain, request the ' +
  'author to resolve them instead of approving. Never set a PR to auto-merge — ' +
  'auto-merge is not allowed.';

/**
 * Post-approval re-approval paragraph appended to the QA end-node prompt (Fullstack).
 *
 * Appended AFTER the QA slot procedure (the workflow-specific steps that end with
 * "call approve_task()"), so on a blocker resume it is the final applicable
 * behaviour — overriding "call approve_task as your final action" for the blocker
 * cycle (otherwise QA could re-approve the already-approved task and stop without
 * signalling the Merger). The leading space is deliberate: it is the exact
 * substring the retired-prompt patch variant below removes to reconstruct the
 * pre-redesign QA prompt, so existing template-linked workflows whose QA
 * `customPrompt` predates this change get the paragraph back on the next
 * structural re-stamp (`mergeNodeStructuralFieldsFromTemplate`). Keep
 * byte-for-byte stable.
 */
export const FULLSTACK_QA_POST_APPROVAL_PARAGRAPH =
  ' Post-approval merge support: after you approve, the Merger may report merge blockers. ' +
  'When it does: re-check the PR; coordinate the implementation author to fix and push; once ' +
  'the PR is mergeable AND you have re-approved the CURRENT head on GitHub, signal the Merger ' +
  'to continue — this overrides the green-path "call approve_task as your final action" step, ' +
  'which does not apply during a blocker cycle (the task is already approved). You are the ' +
  're-approval authority for changed heads; the Merger never approves. Do not mark the task ' +
  'complete — only the Merger merges and closes. Use the Runtime Execution Contract for the ' +
  'exact channel target and required data fields. Re-approve by requesting APPROVE via the ' +
  'post_review tool — on an own-PR where GitHub rejects your self-APPROVE, the tool ' +
  'automatically retries as a marked COMMENT review (Recommendation: APPROVE) which the Merger ' +
  'accepts as covering the head; do NOT request COMMENT directly (that lands an unmarked ' +
  'comment the Merger rejects). If the blocker is administrative (missing merge permission, ' +
  'squash merging disabled, a branch-protection/ruleset change) and you cannot make the PR ' +
  'mergeable, reply to the Merger with data reason: "unresolvable" so it escalates to ' +
  'space-agent instead of both sessions waiting indefinitely.';

/**
 * Post-approval re-approval paragraph appended to the Reviewer end-node prompt
 * (Coding + Research). Same role as {@link FULLSTACK_QA_POST_APPROVAL_PARAGRAPH}
 * but addressed to the Reviewer (the authority there) and more detailed about
 * the GitHub re-review mechanics. The leading `\n\n` reconstructs the
 * pre-redesign reviewer prompt when removed by the retired-prompt patch variant
 * below. Keep byte-for-byte stable; it is shared verbatim by both workflows.
 *
 * Exported so the re-stamp backfill test can remove the exact paragraph the
 * production retired-prompt variant removes (the QA paragraph sits mid-prompt,
 * with QA steps appended after it, so a naive slice would also drop the steps).
 */
export const REVIEWER_POST_APPROVAL_BLOCKER_PARAGRAPH =
  '\n\nPost-approval merge support: after you approve, the Merger may report merge ' +
  'blockers (a "merge_blocked" message with a blockers list). When it does: ' +
  're-check the PR; for code-work blockers (conflicts, failing checks, signatures, ' +
  'stale base), coordinate the implementation author to fix and push; once the PR is mergeable AND ' +
  'you have re-approved the CURRENT head on GitHub (request APPROVE via post_review on the new ' +
  'head — for an own-PR where GitHub rejects self-approval, the tool automatically retries as a ' +
  'marked COMMENT review carrying "Recommendation: APPROVE"; the Merger accepts that fallback), ' +
  'signal the Merger to continue. A coder fix-push changed the head, so a stale approval does ' +
  'not cover it. You are the re-approval authority for changed heads; the Merger ' +
  'never approves. Do not mark the task complete — only the Merger merges and ' +
  'closes. Use the Runtime Execution Contract for the exact channel target and ' +
  'required data fields. If the blocker is administrative (missing merge permission, ' +
  'squash merging disabled, a branch-protection/ruleset change) and you cannot make ' +
  'the PR mergeable, reply to the Merger with data reason: "unresolvable" so it ' +
  'escalates to space-agent instead of both sessions waiting indefinitely.';

const FULLSTACK_CODING_NOCHANGE_GUIDANCE =
  'If the task requires no code changes (validation-only, a diagnostic, or already complete): do NOT create an empty commit or PR. This workflow only completes via a reviewed PR, so a no-change task is misrouted — escalate via `send_message` to the escalation target listed in your Runtime Execution Contract, explaining that the task produced no code changes and needs re-routing, then stop and wait for guidance.\n\n';
// Immediate predecessor of the Fullstack no-code guidance (hard-coded `space-agent`).
// Existing seeded spaces from that revision must be restamped to the
// runtime-contract reference above.
const RETIRED_PREVIOUS_FULLSTACK_CODING_NOCHANGE_GUIDANCE =
  'If the task requires no code changes (validation-only, a diagnostic, or already complete): do NOT create an empty commit or PR. This workflow only completes via a reviewed PR, so a no-change task is misrouted — send a message to `space-agent` explaining that the task produced no code changes and needs re-routing, then stop and wait for guidance.\n\n';

const RESEARCH_RESEARCH_NODE = 'tpl-research-research';
const RESEARCH_REVIEW_NODE = 'tpl-research-review';

const REVIEW_REVIEW_NODE = 'tpl-review-review';

// ---------------------------------------------------------------------------
// Built-in templates
// ---------------------------------------------------------------------------

/**
 * Stable Coding Workflow
 *
 * Two-node iterative graph: Coding ↔ Review (with cycle).
 * - Coding → Review: a `send_message` hook (`pr_ready`) checks the PR is open,
 *   mergeable, and has no unresolved review threads before Review activates.
 * - Review → Coding: a review-posted hook ensures the reviewer posted a visible
 *   GitHub review before changes-requested feedback is delivered.
 *
 * The coder owns the post-approval merge (see `postApproval` on the Coding node):
 * after approval, the coder receives the merge procedure and merges via
 * `gh pr merge` — there is no dedicated merger agent.
 *
 * For tasks that produce code changes (a PR). Validation-only tasks (no code
 * changes) belong in the Review-Only workflow, not here.
 */
// Behavioral only (CLAUDE.md L170): it does NOT name the Review peer or the
// pr_url handoff field — buildCustomAgentTaskMessage injects those centrally
// via "Outbound gated handoffs" (buildHookValidatedHandoffLines), since the
// stable workflows' Coding → Review channel carries the inherited code-pr-ready
// pr_ready hook. Restating the target/field here would create a second source of
// truth that drifts (same issue fixed for CODER_OWNED_QA_REVIEW_PROMPT).
const CODER_OWNED_MERGE_PROMPT =
  'You are the Coder. Implement the task, add focused tests, and keep one pull request updated. ' +
  'When the PR is ready for review, hand it off via the gated handoff described in Your Role in This ' +
  'Workflow — the runtime supplies the target and the pr_url field, so follow that contract exactly ' +
  'and do not restate or assume it here. Address each valid review comment, reply on the PR, resolve ' +
  'review threads, rerun relevant tests, then resend the PR for review the same way. During ' +
  'implementation and review, do not merge or call task-completion tools. After the task is approved, ' +
  'the runtime may send you the post-approval merge procedure. In that phase only, merge the PR ' +
  'with the `gh pr merge` steps in that procedure, complete its cleanup and workspace-sync steps, and ' +
  'call mark_complete. Never approve your own ' +
  'changed head; the approval and re-approval authority is named in your Runtime Execution Contract ' +
  'and the post-approval merge procedure (it differs by workflow), so never assume a specific one.';

// Behavioral only (CLAUDE.md L170): does not name the Coding peer or the
// pr_url/review_url gate fields — buildGatedHandoffLines injects the Review→Coding
// feedback handoff centrally (the channel is gated by review-posted-gate, whose
// pr_url/review_url fields are writable by Review). comment_urls is NOT a gate
// field, so it is kept here as behavioral guidance (which threads to raise).
const CODER_OWNED_REVIEW_PROMPT =
  'You are the Reviewer. Inspect the pull request and relevant code and post a visible GitHub review ' +
  'per the Reviewer system contract (which specifies the posting procedure). If changes are needed, send the implementer actionable feedback via the gated ' +
  'feedback handoff in Your Role in This Workflow — the runtime supplies the target and the payload ' +
  'fields, so follow that contract exactly and do not restate or assume them here; include the specific ' +
  'thread URLs you are raising. Then ' +
  'stop. When the current head is clean and all review threads are resolved, save the PR link artifact ' +
  'and call approve_task, or submit_for_approval when autonomy requires human approval. Do not merge. ' +
  'If the implementer later reports a post-approval merge blocker, re-check the current head, ' +
  'coordinate any fix, post a fresh approval, and signal them to continue.';

// Reviewer prompt for the stable `Coding with QA` workflow, where Review is an
// INTERMEDIATE node (QA is the end node / approval authority). Behavioral only:
// it does NOT re-state the QA target or the `review-approval-gate` field —
// `buildCustomAgentTaskMessage` injects those centrally via "Outbound gated
// handoffs" (see `buildGatedHandoffLines`), so restating them here would create
// a second source of truth that drifts (CLAUDE.md L170). The prompt only tells
// the Reviewer that it is intermediate (no approve_task) and to hand the
// approved PR to the final approval authority through that injected handoff.
const CODER_OWNED_QA_REVIEW_PROMPT =
  'You are the Reviewer in a workflow where a separate QA step owns final approval. Review is an ' +
  'intermediate step, not the end node, so you do NOT call approve_task or submit_for_approval. ' +
  'Inspect the pull request and relevant code and post a visible GitHub review per the Reviewer ' +
  'system contract (which specifies the posting procedure). If ' +
  'changes are needed, send the implementer actionable feedback via the feedback handoff described in ' +
  'Your Role in This Workflow — the runtime supplies the target and the required payload fields, so follow ' +
  'that contract exactly and do not restate or assume them here. Then stop. When the current head is ' +
  'clean and all review threads are resolved, hand the approved PR to ' +
  'the final approval authority via the gated handoff described in Your Role in This Workflow — the ' +
  'runtime supplies the channel, target, and gate field, so follow that contract exactly and do not ' +
  'restate or assume it here. Then stop and wait. Do not merge. If the implementer later reports a ' +
  'post-approval merge blocker, re-check the current head, coordinate any fix, post a fresh approval, ' +
  'and signal them to continue.';

/**
 * Legacy built-in slot prompts from the pre-split era, keyed by
 * `<nodeName>|<agentName>`.
 *
 * Existing spaces seeded before the pivot carry these prompts on their
 * `Coding Workflow` / `Coding with QA Workflow` rows. The identity migration
 * renames those rows to the stable templates, but restamp preserves
 * user-customisable prompts — so without an explicit reset the legacy coder
 * prompt ("Do NOT merge PRs … the reviewer handles the merge") would survive
 * onto a coder-owned workflow where the coder MUST merge, and the legacy
 * reviewer prompt would tell the reviewer to use the now-removed `post_review`
 * tool. Exact-match only: a prompt that no longer equals a known legacy seed
 * is a user customization and is left untouched.
 *
 * Values are the fully-interpolated prompt text of the legacy built-ins (the
 * same text `getBuiltInWorkflows()` produced before the pivot).
 */
const LEGACY_CODING_SLOT_PROMPTS: Record<string, string[]> = {
  'Coding|coder': [
    'You are a software engineer in a Coding→Review iterative workflow. Your job is implementation only: ' +
      'implement the task, write tests, commit your changes, and open a pull request. ' +
      'Do NOT merge PRs. When the reviewer approves, your work is done. ' +
      'The reviewer handles the merge.\n\n' +
      'Steps:\n' +
      '1. Read and understand the task requirements\n' +
      '2. Implement the changes with logical, well-described commits\n' +
      '3. Write or update tests to cover new behavior\n' +
      '4. Run the test suite and fix any failures\n' +
      '5. If code changed: open a PR with `gh pr create` — include a clear title and description. After `gh pr create`, call `subscribe_pr_events({})` (no arguments needed — the PR URL is auto-resolved from the run). This subscribes you to review comments, CI failures, and reactions for your PR so you receive them directly and can act on them. Do this once per PR.\n' +
      '6. If code changed: hand off by calling `send_message` to the review target ' +
      'with `data: { pr_url: "<url>" }`. Use the current target and required data ' +
      'fields from the Runtime Execution Contract injected into your task prompt. ' +
      '`save_artifact` alone is insufficient; only `send_message` triggers the ' +
      'hook-validated handoff. Always include the PR URL data field on every ' +
      '`send_message` handoff — the hook validates every cycle, so even on round 2+ ' +
      'you must re-supply it.\n' +
      '7. If the task requires no code changes (validation-only, a diagnostic, or already ' +
      'complete): do NOT create an empty commit or PR. This workflow only completes via a ' +
      'reviewed PR, so a no-change task is misrouted — escalate via `send_message` to the ' +
      'escalation target listed in your Runtime Execution Contract, explaining that the task ' +
      'produced no code changes and needs re-routing, then stop and wait for guidance.\n\n' +
      'If re-activated after review:\n' +
      '1. Read the incoming message `data` — you should find `review_url` and ' +
      '`comment_urls` (an array of comment thread URLs). Open each one; do not rely on ' +
      'a summary.\n' +
      '2. For each comment: evaluate critically — do not blindly accept feedback. Verify ' +
      'against the code and the task requirements. The Reviewer can be wrong.\n' +
      '3. For valid items: make the fix, then reply to that specific thread. Prefer the ' +
      '`external_event` essence handle: use `replyHandle.commentId` as the REST ' +
      '`{comment_id}` and the PR URL host as `<host>` in ' +
      '`gh api --hostname <host> repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies -f body="<ack>"` ' +
      'explaining what changed. One reply per comment creates a visible audit trail.\n' +
      '4. For items you disagree with: reply on the same thread explaining why, with ' +
      'evidence from the code or tests. Do not change code you believe is correct.\n' +
      '5. ' +
      REVIEW_THREAD_RESOLUTION_GUIDANCE +
      '\n' +
      '6. Verify no unresolved review conversations remain, verify tests still pass, ' +
      'then call `send_message` to the review target again to re-trigger the review ' +
      'cycle. Re-supplying the PR URL data field is required because the hook ' +
      'validates each handoff; `save_artifact` alone will not deliver it.',
  ],
  'Coding|reviewer': [
    'You are the Reviewer in a Coding→Review iterative workflow. You review the work ' +
      'and either approve it or request changes.\n\n' +
      'You share the same worktree as the engineer — review the codebase as a whole, ' +
      'not just the PR diff. Read related files, check for issues the diff ' +
      'might not surface (e.g. callers of changed functions, integration points).\n' +
      '- All feedback MUST be posted to the PR on GitHub — not just summarized in your ' +
      'response. Use the Reviewer System Contract GitHub review procedure.\n' +
      '- The Review → Coding handoff runs a hook that checks GitHub for a fresh review ' +
      'before releasing your message. If you skip posting a visible review, the hook will block ' +
      'and the coder will never hear from you.\n\n' +
      reviewerFeedbackProcedure('Coding') +
      'Use save_artifact every cycle to record the PR as a `link` so post-approval dispatch ' +
      'can resolve it.\n\n' +
      'Review checklist: inspect PR diff and related worktree context, run tests if uncertain, ' +
      'post visible GitHub review before sending feedback. If changes needed, include pr_url, ' +
      'review_url, and comment_urls when messaging Coding. If approved, ' +
      REVIEW_THREAD_APPROVAL_CHECK_GUIDANCE +
      ' Call save_artifact({ shape: "link", kind: "pr", data: { url: "<url>" } }) then approve_task() or submit_for_approval. ' +
      'Do NOT attempt to merge the PR yourself. Do not set auto-merge.' +
      REVIEWER_POST_APPROVAL_BLOCKER_PARAGRAPH,
  ],
  'Coding with QA|coder': [
    'You are the Coder in a Fullstack QA Loop workflow. You implement backend + frontend changes, ' +
      'write tests, and keep one PR updated across review and QA cycles.\n\n' +
      'When implementation is ready, ensure the PR is open and mergeable, then call `send_message` ' +
      'to the review target with `data: { pr_url: "<url>" }`. Use the current ' +
      'target and required data fields from the Runtime Execution Contract injected into your task ' +
      'prompt. `save_artifact` alone is insufficient; only `send_message` triggers the hook-validated ' +
      'handoff. Coding is not the end node — the task-completion tools (`approve_task`, ' +
      '`submit_for_approval`) are not available to you.\n\n' +
      REVIEW_THREAD_RESOLUTION_GUIDANCE +
      '\n\n' +
      'Expected inputs: Task description and review/QA feedback from prior loops.\n' +
      'Expected outputs: Updated implementation in an open, mergeable PR.\n\n' +
      'Steps:\n' +
      '1. Implement backend and frontend changes with focused commits\n' +
      '2. Add/update unit, integration, and UI tests as needed\n' +
      '3. Open or update the PR and ensure it remains mergeable. After `gh pr create`, call `subscribe_pr_events({})` (no arguments needed — the PR URL is auto-resolved from the run). This subscribes you to review comments, CI failures, and reactions for your PR so you receive them directly and can act on them. Do this once per PR.\n' +
      '4. Hand off by calling `send_message` to the review target with ' +
      '`data: { pr_url: "<url>" }`; `save_artifact` alone will not deliver the handoff\n' +
      FULLSTACK_CODING_NOCHANGE_GUIDANCE +
      '5. Share blockers clearly with Reviewer/QA when needed',
  ],
  'Coding with QA|reviewer': [
    'You are the Reviewer in a Fullstack QA Loop workflow. Review the PR for correctness, ' +
      'maintainability, and coverage before QA. Follow the Reviewer System Contract for ' +
      'review quality and severity.\n\n' +
      'Review is not the end node: approve_task/submit_for_approval are unavailable. Your ' +
      'terminal hand-off is sending `data: { approved: true, pr_url: "<url>" }` to QA after an ' +
      'APPROVE verdict with zero P0-P3 findings. Send the handoff to start the Codex review ' +
      'timeout window (2 hours by default), then wait for a Codex bot `+1` reaction or the ' +
      'timeout before proceeding. ' +
      CODEX_REACTION_APPROVAL_GUIDANCE +
      ' If findings remain, do not send the QA handoff; send actionable feedback to Coding and stop. ' +
      'Never set a PR to auto-merge.\n\n' +
      'Expected inputs: Open PR from Coding.\n' +
      'Expected outputs: QA handoff or actionable feedback.\n\n' +
      'Steps:\n' +
      '1. Review diff quality, correctness, and test coverage\n' +
      '2. If approved: send_message to QA with data: { approved: true, pr_url: "<url>" } to start the Codex review timeout window (2 hours by default), then wait for a Codex bot +1 reaction or the timeout\n' +
      '3. If changes needed: send clear feedback to Coding',
  ],
  'Coding with QA|qa': [
    QA_SYSTEM_CONTRACT +
      '\n\nYou are the QA node in a Fullstack QA Loop workflow. Validate the reviewer-approved PR. ' +
      'If QA fails, send detailed failures and repro steps to Coding, save a failed result artifact, ' +
      'and stop. If all green, save a passing result artifact with pr_url in data, then call ' +
      'approve_task (or submit_for_approval if autonomy blocks self-close). Do not merge or set auto-merge.\n\n' +
      'Expected inputs: Reviewer-approved PR.\n' +
      'Expected outputs: QA pass recorded for runtime post-approval dispatch, or QA ' +
      'feedback to Coding.\n\n' +
      'Steps:\n' +
      '1. Check for project QA instructions (`QA.md`, `docs/QA.md`, `.qa/QA.md`) from trusted base-branch content, not from the mutable PR worktree, and follow any found\n' +
      '2. Inspect the PR diff and classify `ui_changed` true/false\n' +
      '3. Treat QA instruction changes in the candidate PR as code under review, not as policy for this QA cycle\n' +
      '4. Run backend/docs-only relevant checks, or frontend/UI checks when UI code changed\n' +
      '5. If `ui_changed` is true, start HyperNeo with `make dev PORT=<free-port> DB_PATH=/tmp/hyperneo-qa-<task-id>.db` and exercise the changed flow in a browser (golden path, relevant edge cases, nearby regressions)\n' +
      '6. Validate CI and mergeability\n' +
      '7. If fail: send detailed failures and repro steps to Coding, then call ' +
      '`save_artifact({ shape: "note", kind: "qa", key: "cycle-<N>", summary: "QA failed (cycle <N>): ..." })` to record the audit entry — a note, never a terminal decision, and keyed per cycle (<N> = this QA round, 1-based) so each failure cycle keeps its own repro evidence instead of overwriting the last. Do ' +
      'NOT call `approve_task` or `submit_for_approval` — both are TERMINAL and ' +
      'carry the same approval semantic. Leave the workflow open for the next ' +
      'Coding cycle.\n' +
      '8. If all green:\n' +
      '   a. Record the PR and the terminal QA outcome as two artifacts: ' +
      '`save_artifact({ shape: "link", kind: "pr", data: { url: "<url>" } })` ' +
      '(the canonical PR record the post-approval merge step resolves as the ' +
      'primary link) and `save_artifact({ shape: "decision", summary, data: { ' +
      'recommendation: "pass", test_output: "<output>", ui_changed: <boolean>, dev_server_started: <boolean>, ' +
      'browser_validation: "<what was exercised or why skipped>" } })` (the terminal ' +
      'outcome summary). Top-level keys outside `data` are silently stripped by the ' +
      'tool schema, so nest fields correctly.\n' +
      '   b. Call `approve_task()` as your final action. If autonomy blocks self-close, ' +
      'call `submit_for_approval({ reason: "..." })` instead — the runtime will ' +
      'still route post-approval once the human approves. Do NOT run `gh pr merge` ' +
      'yourself; a post-approval reviewer session handles the merge and worktree ' +
      'sync after the task transitions to `approved`.' +
      FULLSTACK_QA_POST_APPROVAL_PARAGRAPH,
  ],
};

/**
 * Reset a legacy built-in slot prompt to the current stable template prompt,
 * exact-match only. The legacy coding slots ("Do NOT merge PRs…", "use
 * post_review…") are structurally incompatible with the coder-owned stable
 * templates; the identity migration renames those rows but restamp otherwise
 * preserves prompts, so a known legacy seed must be swapped to the template's
 * prompt. Returns the template prompt when the existing value exactly equals a
 * known legacy seed, else the existing prompt untouched.
 */
function patchLegacyStableSlotPrompt(
  existingValue: string | undefined,
  templateValue: string | undefined,
  nodeName: string,
  agentName: string
): string | undefined {
  if (!existingValue || !templateValue || existingValue === templateValue) return existingValue;
  const legacySeeds = LEGACY_CODING_SLOT_PROMPTS[`${nodeName}|${agentName}`];
  if (!legacySeeds?.some((seed) => seed === existingValue)) return existingValue;
  return templateValue;
}

/** Stable daily coding workflow. The original coder owns the audited post-approval merge. */
export const CODING_WORKFLOW: SpaceWorkflow = {
  id: '',
  spaceId: '',
  name: 'Coding',
  handle: 'coding',
  description:
    'Stable coding workflow with a Coder ↔ Reviewer loop. The coder implements and owns the audited post-approval merge.',
  nodes: [
    {
      id: 'tpl-stable-coding-code',
      name: 'Coding',
      agents: [
        {
          agentId: 'Coder',
          name: 'coder',
          customPrompt: { value: CODER_OWNED_MERGE_PROMPT },
        },
      ],
      postApproval: {
        targetAgent: 'coder',
        instructions: CODER_OWNED_MERGE_INSTRUCTIONS,
        requirePrMerge: true,
      },
    },
    {
      id: 'tpl-stable-coding-review',
      name: 'Review',
      agents: [
        {
          agentId: 'Reviewer',
          name: 'reviewer',
          // Fresh eyes: wipe the reviewer's model context at the start of each
          // coder handoff so each PR is reviewed independently, without anchor
          // bias from earlier review cycles. UI history is preserved; only the
          // model's in-memory context is reset. Data-driven opt-in — see
          // WorkflowNodeAgent.resetContextPerTurn.
          resetContextPerTurn: true,
          customPrompt: { value: CODER_OWNED_REVIEW_PROMPT },
        },
      ],
    },
  ],
  startNodeId: 'tpl-stable-coding-code',
  endNodeId: 'tpl-stable-coding-review',
  tags: ['coding', 'default'],
  createdAt: 0,
  updatedAt: 0,
  // Default coding loop — reviewer may auto-close when space runs at the
  // standard "trusted but supervised" tier (3).
  completionAutonomyLevel: 3,
  hooks: [
    {
      id: 'code-pr-ready',
      enabled: true,
      label: 'PR Ready',
      sourceNode: 'Coding',
      targetNode: 'Review',
      method: 'send_message',
      classification: 'validation',
      order: 0,
      validator: { kind: 'built_in', id: 'pr_ready' },
      authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
    },
  ],
  gates: [
    {
      id: 'review-posted-gate',
      label: 'Review Posted',
      description:
        'Reviewer has posted a GitHub review or PR comment since the workflow started. ' +
        'Accepts a formal GitHub review as primary evidence; falls back to ' +
        'PR conversation comments for same-account setups where GitHub blocks self-reviews. ' +
        'Blocks the Review → Coding feedback channel until review evidence is visible on the PR.',
      fields: [
        {
          name: 'pr_url',
          type: 'string',
          writers: ['Review'],
          check: { op: 'exists' },
        },
        {
          name: 'review_url',
          type: 'string',
          writers: ['Review'],
          check: { op: 'exists' },
        },
      ],
      validator: { kind: 'built_in', id: 'review_posted' },
      resetOnCycle: true,
    },
  ],
  channels: [
    {
      from: 'Coding',
      to: 'Review',
      label: 'Coding → Review',
    },
    {
      from: 'Review',
      to: 'Coding',
      gateId: 'review-posted-gate',
      maxCycles: 5,
      label: 'Review → Coding (changes requested)',
    },
  ],
};

/**
 * Research Workflow
 *
 * Two-node iterative graph:
 *   Research → Review (validated by a send_message hook that checks PR is open/mergeable)
 *   Review → Research (ungated back-channel, max 5 cycles)
 *
 * Research agent researches thoroughly, commits findings, opens a PR.
 * Reviewer agent reviews the research PR; calls save_artifact() then approve_task() if satisfied,
 * or sends back for more research via the back-channel.
 */
export const RESEARCH_WORKFLOW: SpaceWorkflow = {
  id: '',
  spaceId: '',
  name: 'Research Workflow',
  handle: 'research-workflow',
  description:
    'Iterative research workflow with gated PR verification. Research agent investigates and opens a PR; Reviewer evaluates findings and requests revisions if needed.',
  nodes: [
    {
      id: RESEARCH_RESEARCH_NODE,
      name: 'Research',
      agents: [
        {
          agentId: 'Research',
          name: 'research',
          customPrompt: {
            value:
              'You are the Research agent in a Research→Reviewer iterative workflow. Your job is to ' +
              'investigate the topic thoroughly, document findings, and open a PR.\n\n' +
              'Expected outputs: Well-structured markdown document(s) with findings, committed and PR opened.\n\n' +
              'Steps:\n' +
              '1. Understand the research question and scope\n' +
              '2. Investigate using web search, code exploration, and available documentation\n' +
              '3. Write findings to well-structured markdown file(s)\n' +
              '4. Include sources, evidence, and clear conclusions\n' +
              '5. Commit findings and open a PR with `gh pr create`. After `gh pr create`, call `subscribe_pr_events({ prUrl: "<PR URL>" })`, passing the PR URL from the `gh pr create` output explicitly (it is not auto-resolved from the run until the PR is recorded). This subscribes you to review comments, CI failures, and reactions for your PR so you receive them directly and can act on them. Do this once per PR.\n' +
              '6. Hand off to Review by calling `send_message(target="Review", message="<short summary>", data: { pr_url: "<PR url>" })`. ' +
              'The hook validates the PR is open and mergeable before Review activates. ' +
              'Always re-supply `data: { pr_url }` on every send — the hook runs on every send.\n\n' +
              'If re-activated after review feedback: address each point, expand research where requested, ' +
              'update the documents, and push new commits. ' +
              REVIEW_THREAD_RESOLUTION_GUIDANCE,
          },
        },
      ],
      // The research agent (implementer) owns the post-approval merge: after
      // approval it receives the shared merge procedure and merges via
      // `gh pr merge` — no dedicated merger agent.
      postApproval: {
        targetAgent: 'research',
        instructions: CODER_OWNED_MERGE_INSTRUCTIONS,
        requirePrMerge: true,
      },
    },
    {
      id: RESEARCH_REVIEW_NODE,
      name: 'Review',
      agents: [
        {
          agentId: 'Reviewer',
          name: 'reviewer',
          customPrompt: {
            value:
              'You are the Reviewer in a Research→Reviewer iterative workflow. You review the ' +
              'research findings for completeness, accuracy, and quality.\n\n' +
              reviewerFeedbackProcedure('Research') +
              'Use save_artifact every cycle to record the PR as a `link` so post-approval dispatch ' +
              'can resolve it.\n\n' +
              'Review checklist: read all research docs in the PR, verify completeness, evidence, ' +
              'accuracy, and clarity. If more research is needed, message Research with specific ' +
              'areas to investigate and stop. If satisfied, post approval review, ' +
              REVIEW_THREAD_APPROVAL_CHECK_GUIDANCE +
              ' Call save_artifact({ shape: "link", kind: "pr", data: { url: "<url>" } }) then approve_task() or submit_for_approval. ' +
              'Do NOT attempt to merge the PR yourself. Do not set auto-merge.\n\n' +
              'Post-approval merge support: after you approve, the Research agent may report a ' +
              'post-approval merge blocker (a "merge_blocked" / "merge_fix_pushed" message with a ' +
              'blockers list). When it does: re-check the PR and re-approve the CURRENT head on ' +
              'GitHub (post a fresh APPROVED review per the Reviewer system contract — or, for an own-PR where ' +
              'GitHub rejects self-approval, a COMMENTED review carrying the "Recommendation: ' +
              'APPROVE" marker), then signal the Research agent to continue via the runtime-supplied ' +
              'handoff in Your Role in This Workflow. You are the re-approval authority for changed ' +
              'heads; the Research agent merges. Do not mark the task complete — only the Research ' +
              'agent merges and closes.',
          },
        },
      ],
    },
  ],
  startNodeId: RESEARCH_RESEARCH_NODE,
  endNodeId: RESEARCH_REVIEW_NODE,
  tags: ['research'],
  createdAt: 0,
  updatedAt: 0,
  // Research is low-risk (read-only investigation + PR of findings) — permit
  // auto-close at a more conservative autonomy tier than coding loops.
  completionAutonomyLevel: 2,
  hooks: [
    {
      id: 'research-pr-ready',
      enabled: true,
      label: 'PR Ready',
      sourceNode: 'Research',
      targetNode: 'Review',
      method: 'send_message',
      classification: 'validation',
      order: 0,
      validator: { kind: 'built_in', id: 'pr_ready' },
      authorizedCallers: [{ sourceNode: 'Research', agentSlots: ['research'] }],
    },
  ],
  channels: [
    {
      from: 'Research',
      to: 'Review',
      label: 'Research → Review',
    },
    {
      from: 'Review',
      to: 'Research',
      maxCycles: 5,
      label: 'Review → Research (more research needed)',
    },
  ],
};
/**
 * Review-Only Workflow
 *
 * Single-node graph: Reviewer only (terminal node).
 * No planning phase — used when the task is well-defined and only
 * review is needed. The run completes immediately when advance()
 * is called from the Review node.
 *
 * startNodeId and endNodeId point to the same node (single-node workflow).
 */
export const REVIEW_ONLY_WORKFLOW: SpaceWorkflow = {
  id: '',
  spaceId: '',
  name: 'Review-Only Workflow',
  handle: 'review-only-workflow',
  description:
    'Single-node review workflow with no planning phase. Reviewer evaluates directly; the run completes when done.',
  nodes: [
    {
      id: REVIEW_REVIEW_NODE,
      name: 'Review',
      agents: [
        {
          agentId: 'Reviewer',
          name: 'reviewer',
          customPrompt: {
            value:
              'You are the sole Reviewer in a single-node Review-Only workflow. Review an existing ' +
              'PR or codebase directly. Follow the Reviewer System Contract and terminal-action tool ' +
              'contract: post a visible GitHub review (per the Reviewer System Contract procedure) before terminal actions; ' +
              'call save_artifact({ shape: "link", kind: "pr", data: { url: "<url>" } }) to record the PR, then approve_task() or submit_for_approval only on APPROVE, otherwise stop. ' +
              'Do NOT attempt to merge the PR yourself. Never set a PR to auto-merge.',
          },
        },
      ],
    },
  ],
  startNodeId: REVIEW_REVIEW_NODE,
  endNodeId: REVIEW_REVIEW_NODE,
  tags: ['review'],
  createdAt: 0,
  updatedAt: 0,
  // Review-only is low-risk (no code changes, only feedback posting) — permit
  // auto-close at the same conservative tier as Research.
  completionAutonomyLevel: 2,
};

/**
 * Plan & Decompose Workflow
 *
 * Three-node graph: Planner → 4-Reviewer Plan Review → Task Dispatcher.
 * Useful for multi-task goals ("build X feature", "migrate Y system") that
 * should be broken into smaller standalone tasks before any coding starts.
 *
 * Main progression:
 *   Planning → Plan Review (send_message hook validates plan PR is open/mergeable)
 *   Plan Review → Task Dispatcher (plan-approval-gate: all 4 reviewers approve)
 *
 * Cyclic feedback:
 *   Plan Review → Planning (revision requests, maxCycles: 5)
 *
 * Task Dispatcher (end node) creates follow-up tasks via `create_standalone_task`
 * and calls `save_artifact({ shape: 'decision', data: { created_task_ids } })`
 * before `approve_task()` closes the run.
 */
export const PLAN_AND_DECOMPOSE_WORKFLOW: SpaceWorkflow = {
  id: '',
  spaceId: '',
  name: 'Plan & Decompose Workflow',
  handle: 'plan-decompose-workflow',
  description:
    'Planning-only workflow that ends by creating follow-up tasks rather than writing code. ' +
    'A Planner drafts a plan PR, four Reviewers review it through different lenses ' +
    '(architecture, security, correctness, UX), and a Task Dispatcher fans the approved plan ' +
    'out into standalone tasks via create_standalone_task. Each task description includes ' +
    'stacked PR instructions — branch name, base branch, and dependency ordering — so ' +
    'downstream coders automatically produce a reviewable PR chain (each PR targets the ' +
    'branch of the item below it, bottom-up from dev). Use for multi-task goals that ' +
    'should be broken down before any coding starts.',
  nodes: [
    {
      id: PD_PLANNING_NODE,
      name: 'Planning',
      agents: [
        {
          agentId: 'Planner',
          name: 'planner',
          customPrompt: {
            value:
              PD_PLANNING_PROMPT +
              '\n\n' +
              'Expected inputs: A high-level goal from the workflow trigger.\n' +
              'Expected outputs: `plan.md` committed to a PR branch, with an open mergeable PR.\n\n' +
              'Steps:\n' +
              '1. Analyze the goal and explore the relevant codebase\n' +
              '2. Decompose the goal into concrete, small-enough work items\n' +
              '3. Write `plan.md` — one section per work item with title, description, priority\n' +
              '4. Commit and open/update a PR against the default branch\n' +
              '5. Hand off to Plan Review by calling ' +
              '`send_message(target="Plan Review", message="<short summary>", ' +
              'data: { pr_url: "<plan PR url>" })`. The hook validates the PR is open and ' +
              'mergeable before Plan Review activates. Skipping this call or an unready PR ' +
              'blocks the send.\n' +
              '6. Wait for Plan Review feedback. If re-activated, address each reviewer ' +
              'comment, update `plan.md`, push to the same PR branch, then repeat step 5 ' +
              '(re-supply `data: { pr_url }` — the hook runs on every send).',
          },
        },
      ],
    },
    {
      id: PD_PLAN_REVIEW_NODE,
      name: 'Plan Review',
      requireCodexApproval: true,
      agents: [
        {
          agentId: 'Reviewer',
          name: 'architecture-reviewer',
          customPrompt: {
            value:
              PD_PLAN_REVIEW_PROMPT +
              '\n\n' +
              'Your lens: **Architecture**. Focus on module boundaries, coupling between work ' +
              'items, long-term maintainability, and whether the decomposition will hold up as ' +
              'the system grows. Flag items that smuggle unrelated concerns together or create ' +
              'hidden cross-cutting dependencies.\n\n' +
              'When voting, your lens key is `"architecture"` — send ' +
              '`data: { approvals: { architecture: "approved" }, pr_url: "<plan PR url>" }` ' +
              'to Task Dispatcher when approving. Send rejected votes with findings to Planning.',
          },
        },
        {
          agentId: 'Reviewer',
          name: 'security-reviewer',
          customPrompt: {
            value:
              PD_PLAN_REVIEW_PROMPT +
              '\n\n' +
              'Your lens: **Security**. Focus on the threat model, input validation, ' +
              'authentication/authorization, secrets handling, and supply-chain risk for any ' +
              'new dependencies. Flag items that expose user data, bypass existing auth checks, ' +
              'or rely on untrusted input without validation.\n\n' +
              'When voting, your lens key is `"security"` — send ' +
              '`data: { approvals: { security: "approved" }, pr_url: "<plan PR url>" }` ' +
              'to Task Dispatcher when approving. Send rejected votes with findings to Planning.',
          },
        },
        {
          agentId: 'Reviewer',
          name: 'correctness-reviewer',
          customPrompt: {
            value:
              PD_PLAN_REVIEW_PROMPT +
              '\n\n' +
              'Your lens: **Correctness**. Focus on edge cases, error handling, data ' +
              'consistency across failures, idempotency, and race conditions. Flag items ' +
              'whose acceptance criteria are vague, whose failure modes are unclear, or ' +
              'whose tests would not catch the obvious regressions.\n\n' +
              'When voting, your lens key is `"correctness"` — send ' +
              '`data: { approvals: { correctness: "approved" }, pr_url: "<plan PR url>" }` ' +
              'to Task Dispatcher when approving. Send rejected votes with findings to Planning.',
          },
        },
        {
          agentId: 'Reviewer',
          name: 'ux-reviewer',
          customPrompt: {
            value:
              PD_PLAN_REVIEW_PROMPT +
              '\n\n' +
              'Your lens: **UX**. Focus on user-visible behavior, API ergonomics, ' +
              'documentation, error messages, and upgrade/migration experience for ' +
              'existing users. Flag items that change public interfaces without describing ' +
              'what users will see or how docs will be updated.\n\n' +
              'When voting, your lens key is `"ux"` — send ' +
              '`data: { approvals: { ux: "approved" }, pr_url: "<plan PR url>" }` ' +
              'to Task Dispatcher when approving. Send rejected votes with findings to Planning.',
          },
        },
      ],
    },
    {
      id: PD_TASK_DISPATCHER_NODE,
      name: 'Task Dispatcher',
      agents: [
        {
          agentId: 'General',
          name: 'task-dispatcher',
          customPrompt: {
            value:
              PD_TASK_DISPATCHER_PROMPT +
              '\n\n' +
              'Expected inputs: An approved plan PR (all 4 reviewers sent approved votes).\n' +
              'Expected outputs: One standalone task per actionable work item in the plan, ' +
              'then save_artifact({ shape: "decision", summary: "Dispatched N tasks", data: { recommendation: "dispatched", created_task_ids: [...] } }).\n\n' +
              'Tool contract:\n' +
              "- `create_standalone_task` is available from the space's MCP server and " +
              'creates a task owned by the same space as this workflow.',
          },
        },
      ],
    },
  ],
  startNodeId: PD_PLANNING_NODE,
  endNodeId: PD_TASK_DISPATCHER_NODE,
  tags: ['planning', 'decomposition'],
  createdAt: 0,
  updatedAt: 0,
  // Plan & Decompose ends by creating follow-up tasks (no merges, no
  // destructive actions) but does alter the task graph — match the default
  // Coding Workflow tier.
  completionAutonomyLevel: 3,
  hooks: [
    {
      id: 'plan-pr-ready',
      enabled: true,
      label: 'PR Ready',
      sourceNode: 'Planning',
      targetNode: 'Plan Review',
      method: 'send_message',
      classification: 'validation',
      order: 0,
      validator: { kind: 'built_in', id: 'pr_ready' },
      authorizedCallers: [{ sourceNode: 'Planning', agentSlots: ['planner'] }],
    },
  ],
  gates: [
    {
      id: 'plan-approval-gate',
      label: 'Plan Approvals',
      description:
        'All four Plan Reviewers must approve the plan before Task Dispatcher activates. ' +
        'Each reviewer writes to the `approvals` map with their lens name as the key ' +
        '(architecture, security, correctness, ux) and the string `"approved"` as the ' +
        "value. The auto-gate-write deep-merges map fields, so each reviewer's entry " +
        'accumulates without overwriting earlier votes. Gate passes when ≥ 4 entries ' +
        'have value `"approved"`. Note: `resetOnCycle: true` means all approvals are ' +
        'cleared when Plan Review→Planning revision feedback fires — fresh votes are ' +
        'collected after each plan revision because the plan diff has changed.',
      fields: [
        {
          name: 'approvals',
          type: 'map',
          writers: ['Plan Review'],
          check: { op: 'count', match: 'approved', min: 4 },
        },
      ],
      resetOnCycle: true,
    },
  ],
  channels: [
    {
      from: 'Planning',
      to: 'Plan Review',
      label: 'Planning → Plan Review',
    },
    {
      from: 'Plan Review',
      to: 'Task Dispatcher',
      gateId: 'plan-approval-gate',
      label: 'Plan Review → Task Dispatcher',
    },
    {
      from: 'Plan Review',
      to: 'Planning',
      maxCycles: 5,
      label: 'Plan Review → Planning (revision requested)',
    },
  ],
};

/**
 * Coding with QA Workflow
 *
 * Three-node workflow for backend+frontend tasks that need explicit code review
 * and deeper QA validation (including browser-based checks).
 *
 * Main progression:
 *   Coding → Review (send_message hook validates PR is open/mergeable)
 *   Review → QA (review-approval-gate: reviewer approves)
 *
 * Feedback cycles:
 *   Review → Coding (changes requested)
 *   QA → Coding (test failures/regressions)
 *
 * QA is the end node. QA calls save_artifact() then approve_task() on success.
 *
 * For tasks that produce code changes (a PR). Validation-only tasks (no code
 * changes) are misrouted here — the Coder should escalate to space-agent instead.
 */
const CODER_OWNED_QA_PROMPT =
  'You are QA. Validate the reviewer-approved pull request using the project QA instructions and ' +
  'the relevant backend, frontend, browser, and CI checks. If validation fails, send the implementer ' +
  'concrete failures and reproduction steps via the feedback handoff in Your Role in This Workflow — ' +
  'the runtime supplies the target, so follow that contract exactly and do not restate or assume it ' +
  'here — save a non-terminal QA note, and stop. When the current head is ' +
  'green, save the PR link and a passing decision artifact, then call approve_task or ' +
  'submit_for_approval. Do not merge. If the implementer later reports a post-approval merge blocker, ' +
  're-approve the EXACT head you revalidated — a concurrent push must not inherit your approval. Capture ' +
  '`VALIDATED_OID=$(gh pr view <pr_url> --json headRefOid --jq .headRefOid)` and echo it ' +
  '(`echo "VALIDATED_OID=$VALIDATED_OID"`) BEFORE you revalidate; revalidation spans later Bash invocations ' +
  'that do NOT retain shell variables, so copy the echoed OID into the posting step. Immediately before ' +
  'posting, re-check `gh pr view <pr_url> --json headRefOid --jq .headRefOid` still equals the carried ' +
  '`$VALIDATED_OID` — if it changed, revalidate the new head from scratch. Post the approval ' +
  'bound to that head via the GraphQL `addPullRequestReview` mutation with `commitOID: "$VALIDATED_OID"` ' +
  '(do NOT use `gh pr review`, which has no commit binding and would approve a head you never validated): ' +
  '`PR_ID=$(gh pr view <pr_url> --json id --jq .id)`, build a `{query,variables}` JSON with jq ' +
  '(`mutation($id:ID!,$head:GitObjectID!,$event:PullRequestReviewEvent!,$body:String!){addPullRequestReview(input:{pullRequestId:$id,commitOID:$head,event:$event,body:$body}){pullRequestReview{url}}}`), ' +
  'and submit it with `gh api graphql --hostname <host> --input`; use `event:"APPROVE"`, or — on an own-PR ' +
  'where GitHub rejects your self-APPROVE — `event:"COMMENT"` with a body carrying the exact line ' +
  '`Recommendation: APPROVE` (the implementer accepts that marked comment as covering the head, matching ' +
  'the own-PR fallback in the Reviewer System Contract). Then signal them to continue.';

/**
 * Coding with QA Workflow (stable)
 *
 * Three-node graph: Coding → Review (pr_ready hook) → QA (review-approval-gate).
 * Feedback cycles: Review → Coding, QA → Coding. QA is the end node / approval
 * authority. The coder owns the post-approval merge (see `postApproval` on the
 * Coding node): after QA approval the coder receives the merge procedure and
 * merges via `gh pr merge` — no dedicated merger agent.
 *
 * For tasks that produce code changes (a PR). Validation-only tasks (no code
 * changes) are misrouted here — the Coder should escalate to space-agent instead.
 */
export const CODING_WITH_QA_WORKFLOW: SpaceWorkflow = {
  id: '',
  spaceId: '',
  name: 'Coding with QA',
  handle: 'coding-with-qa',
  description:
    'Stable Coder → Reviewer → QA workflow. The coder owns the audited post-approval merge after QA approval.',
  nodes: [
    {
      id: 'tpl-stable-qa-coding',
      name: 'Coding',
      agents: [
        {
          agentId: 'Coder',
          name: 'coder',
          customPrompt: { value: CODER_OWNED_MERGE_PROMPT },
        },
      ],
      postApproval: {
        targetAgent: 'coder',
        instructions: CODER_OWNED_MERGE_INSTRUCTIONS,
        requirePrMerge: true,
      },
    },
    {
      id: 'tpl-stable-qa-review',
      name: 'Review',
      requireCodexApproval: true,
      agents: [
        {
          agentId: 'Reviewer',
          name: 'reviewer',
          // Review is intermediate here (QA is the end node), so it must hand
          // the approved PR to QA instead of calling the end-node-only
          // approve_task — see CODER_OWNED_QA_REVIEW_PROMPT.
          customPrompt: { value: CODER_OWNED_QA_REVIEW_PROMPT },
        },
      ],
    },
    {
      id: 'tpl-stable-qa-qa',
      name: 'QA',
      agents: [
        {
          agentId: 'QA',
          name: 'qa',
          customPrompt: { value: CODER_OWNED_QA_PROMPT },
        },
      ],
    },
  ],
  startNodeId: 'tpl-stable-qa-coding',
  endNodeId: 'tpl-stable-qa-qa',
  tags: ['fullstack', 'qa', 'browser-testing'],
  createdAt: 0,
  updatedAt: 0,
  // QA-approve is a plain "work is good" signal; post-approval (the coder's
  // merge) runs only after that approval has already happened. Aligned with
  // Coding's autonomy tier (3).
  completionAutonomyLevel: 3,
  gates: [
    {
      id: 'review-approval-gate',
      label: 'Review',
      description:
        'Reviewer approved the PR for QA and the Codex review bot reaction check passed or timed out.',
      fields: [
        {
          name: 'approved',
          type: 'boolean',
          writers: ['Review', 'reviewer'],
          check: { op: '==', value: true },
        },
      ],
      resetOnCycle: true,
    },
  ],
  layout: {
    'tpl-stable-qa-coding': { x: 80, y: 160 },
    'tpl-stable-qa-review': { x: 420, y: 80 },
    'tpl-stable-qa-qa': { x: 760, y: 160 },
  },
  channels: [
    {
      from: 'Coding',
      to: 'Review',
      label: 'Coding → Review',
    },
    {
      from: 'Review',
      to: 'QA',
      gateId: 'review-approval-gate',
      label: 'Review → QA',
    },
    {
      from: 'Review',
      to: 'Coding',
      maxCycles: 50,
      label: 'Review → Coding (feedback)',
    },
    {
      from: 'QA',
      to: 'Coding',
      maxCycles: 50,
      label: 'QA → Coding (issues found)',
    },
    // Post-approval merge-blocker path. With the coder reused as the merger on
    // the Coding node, it needs a Coding → QA channel to report merge blockers
    // to QA (the approval authority for this workflow); QA replies over the
    // existing QA → Coding channel. Without this, the blocker send_message is
    // rejected as unauthorized and the approved task stalls.
    {
      from: 'Coding',
      to: 'QA',
      maxCycles: 5,
      label: 'Coding → QA (post-approval merge blocker)',
    },
  ],
  hooks: [
    {
      id: 'fullstack-code-pr-ready',
      enabled: true,
      label: 'PR Ready',
      sourceNode: 'Coding',
      targetNode: 'Review',
      method: 'send_message',
      classification: 'validation',
      order: 0,
      validator: { kind: 'built_in', id: 'pr_ready' },
      authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
    },
    // Gate the Coding → QA channel to post-approval only. Without this, an
    // in-progress coder could message QA directly, lazily activating the end
    // node and approving without Review ever running. The post_approval_only
    // validator allows the send only while task.status === 'approved' AND the
    // message carries a merge-blocker / fix-push reason.
    {
      id: 'stable-qa-coding-to-qa-post-approval',
      enabled: true,
      label: 'Post-Approval Only',
      sourceNode: 'Coding',
      targetNode: 'QA',
      method: 'send_message',
      classification: 'validation',
      order: 0,
      validator: { kind: 'built_in', id: 'post_approval_only' },
      authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
    },
  ],
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the current gate script for a given built-in template name and gate ID.
 *
 * Gate scripts are stored in the `space_workflows.gates` JSON column at seed time.
 * When a template script is updated, existing workflow instances still carry the old
 * script from when they were seeded. Callers that need the **live** script (e.g. the
 * gate evaluator) should use this function to resolve the script at call time instead
 * of relying on the stored copy.
 *
 * Returns `undefined` when the template or gate is not found, or when the gate has
 * no script (field-only gate). Callers should fall back to the stored gate definition
 * in that case.
 */
export function getBuiltInGateScript(templateName: string, gateId: string): GateScript | undefined {
  const template = resolveBuiltInWorkflowTemplate(templateName);
  if (!template) return undefined;
  const gate = (template.gates ?? []).find((g) => g.id === gateId);
  return gate?.script;
}

/**
 * Outcome of resolving a stored gate's script against its built-in template's
 * live definition. Reported by {@link resolveTemplateGateScript} and consumed
 * by the reload diagnostics at the gate-evaluation call sites.
 */
export type TemplateGateScriptStatus =
  /** The workflow was not seeded from a built-in template — no reload. */
  | 'no-template'
  /**
   * Neither the template nor the stored gate has a script for this gate — a
   * deliberately scriptless (field/validator-only) gate. Nothing to reload.
   */
  | 'no-live-script'
  /**
   * The template carries a live script for this gate, but the stored gate has
   * no script. The live script is NOT applied, so the template update silently
   * fails to take effect until the workflow is resynced. Surfaced as a warning.
   */
  | 'live-ignored-no-stored'
  /**
   * The template no longer defines a script for this gate, but the stored gate
   * still carries one (e.g. a gate retired to a built-in validator, like the
   * old review-posted-gate bash script). The stored — now retired — script
   * keeps executing because template restamping preserves existing scripts.
   * Surfaced as a warning so operators resync and stop running the retired script.
   */
  | 'live-removed-stored-script'
  /** The stored script matches the live template across all executable fields — no-op. */
  | 'in-sync'
  /** The live template script differs from the stored script — reloaded (drift). */
  | 'reloaded';

export interface ResolvedTemplateGateScript {
  gate: Gate;
  status: TemplateGateScriptStatus;
}

/**
 * Resolve the effective gate definition for evaluation, swapping in the live
 * built-in template's gate script whenever both the template and the stored
 * gate carry a script. This is the single source of truth for the "always use
 * the current template's gate script" reload behavior that was previously
 * inlined (and duplicated) at the two gate-evaluation sites
 * (channel-router `doEvaluateGate` and space-runtime restart-recovery).
 *
 * Effective-gate behavior is identical to the former inline logic: when both
 * scripts exist, the live template script is applied. The returned status is
 * purely diagnostic, distinguishing a real source change (`reloaded`) from a
 * no-op reload (`in-sync`) and — importantly — flagging the silent footgun
 * where a live script exists but the stored gate is scriptless
 * (`live-ignored-no-stored`).
 */
export function resolveTemplateGateScript(
  storedGate: Gate,
  workflow: SpaceWorkflow
): ResolvedTemplateGateScript {
  if (!workflow.templateName) return { gate: storedGate, status: 'no-template' };
  return applyTemplateGateScript(
    storedGate,
    getBuiltInGateScript(workflow.templateName, storedGate.id)
  );
}

/**
 * Pure decision core of {@link resolveTemplateGateScript}: combine a stored
 * gate with an optional live template script. Extracted so the live-script
 * branches (`no-live-script`, `live-ignored-no-stored`, `in-sync`, `reloaded`)
 * are unit-testable without mutating the built-in template registry.
 */
export function applyTemplateGateScript(
  storedGate: Gate,
  liveScript: GateScript | undefined
): ResolvedTemplateGateScript {
  if (!liveScript) {
    // Distinguish a template that has REMOVED a script the stored gate still
    // carries (retired script still executing) from a genuinely scriptless gate.
    return {
      gate: storedGate,
      status: storedGate.script ? 'live-removed-stored-script' : 'no-live-script',
    };
  }
  if (!storedGate.script) return { gate: storedGate, status: 'live-ignored-no-stored' };
  // The effective gate substitutes the entire live script object, so a reload
  // changes behavior whenever ANY executable field differs — not just `source`.
  // Comparing interpreter/timeoutMs too surfaces operational changes (e.g. a
  // timeout bump or interpreter switch) as reloads instead of mislabeling them
  // in-sync.
  const drifted = gateScriptsDiffer(liveScript, storedGate.script);
  return {
    gate: { ...storedGate, script: liveScript },
    status: drifted ? 'reloaded' : 'in-sync',
  };
}

/**
 * Whether two gate scripts differ in any field that affects execution
 * (`source`, `interpreter`, `timeoutMs`). Used to decide the reload diagnostic.
 */
function gateScriptsDiffer(a: GateScript, b: GateScript): boolean {
  return a.source !== b.source || a.interpreter !== b.interpreter || a.timeoutMs !== b.timeoutMs;
}

/**
 * Stable identity for a gate-script diagnostic, used to deduplicate emissions
 * across repeated gate evaluations (a persistent mismatch otherwise warns on
 * every retry/delivery attempt). Combines the run, gate, and status so a
 * status transition (e.g. after a resync) re-emits.
 */
export function gateScriptDiagnosticKey(
  runId: string | undefined,
  gateId: string,
  status: TemplateGateScriptStatus
): string {
  return `${runId ?? ''}|${gateId}|${status}`;
}

/**
 * Bounded dedup ledger for gate-script reload diagnostics. Gate evaluation runs
 * on every channel delivery and retries while blocked, so a persistent
 * mismatch (e.g. `live-ignored-no-stored`) would otherwise flood the logs. Each
 * (run, gate, status) diagnostic is emitted at most once; the ledger is capped
 * so a very long-lived process cannot grow it without bound — once the cap is
 * reached it stops recording and emits every call, degrading to the pre-dedup
 * behavior rather than consuming memory.
 */
export class GateScriptDiagnosticLedger {
  private readonly seen = new Set<string>();
  private readonly cap: number;

  constructor(capacity = 8192) {
    this.cap = capacity;
  }

  /** Returns true the first time this key is seen (and records it). */
  shouldEmit(key: string): boolean {
    if (this.seen.has(key)) return false;
    if (this.seen.size >= this.cap) return true;
    this.seen.add(key);
    return true;
  }

  /** Clear recorded keys. Intended for tests that need a deterministic ledger. */
  reset(): void {
    this.seen.clear();
  }
}

/**
 * Process-wide shared ledger for gate-script reload diagnostics. Gate
 * evaluation runs across multiple transient {@link ChannelRouter} instances
 * (one per delivery in some paths) as well as long-lived ones, so the dedup
 * state must outlive any single router. Keys include the run id (globally
 * unique), so there is no cross-run collision; the ledger cap bounds memory.
 */
export const sharedGateScriptDiagnosticLedger = new GateScriptDiagnosticLedger();

/**
 * Minimal logger surface {@link logTemplateGateScriptReload} needs. Accepts the
 * daemon {@link Logger} or any compatible test double.
 */
export interface TemplateGateScriptReloadLogger {
  warn(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

/**
 * Emit reload diagnostics for a resolved template gate script. Warns on the two
 * silent footguns — a live script ignored because the stored gate is scriptless
 * (`live-ignored-no-stored`), and a live template that has removed a script the
 * stored gate still runs (`live-removed-stored-script`) — and logs drift at
 * debug level (`reloaded`). Stays quiet for the common no-template /
 * no-live-script / in-sync paths. Callers should deduplicate via a
 * {@link GateScriptDiagnosticLedger} so persistent mismatches do not flood.
 */
export function logTemplateGateScriptReload(args: {
  log: TemplateGateScriptReloadLogger;
  status: TemplateGateScriptStatus;
  templateName?: string;
  gateId: string;
  runId?: string;
}): void {
  const { log, status, templateName, gateId, runId } = args;
  const where = runId ? ` in run ${runId}` : '';
  const tmpl = templateName ?? '?';
  if (status === 'live-ignored-no-stored') {
    log.warn(
      `Gate "${gateId}"${where}: built-in template "${tmpl}" defines a gate script, but the stored ` +
        'gate has no script — the template script update is NOT applied and will not take effect ' +
        'until the workflow is resynced from the template.'
    );
    return;
  }
  if (status === 'live-removed-stored-script') {
    log.warn(
      `Gate "${gateId}"${where}: built-in template "${tmpl}" no longer defines a gate script, but ` +
        'the stored gate still carries one — the retired stored script is still executing. Resync ' +
        'the workflow from the template to stop running it.'
    );
    return;
  }
  if (status === 'reloaded') {
    log.debug(
      `Gate "${gateId}"${where}: reloaded gate script from live template "${tmpl}" ` +
        '(stored script differed from the template).'
    );
  }
}

/**
 * Returns all built-in workflow templates.
 *
 * The returned objects have empty `id` and `spaceId` fields and use role names
 * (e.g., `'planner'`, `'coder'`, `'general'`) as `agentId` placeholders.
 * They are templates, not persisted entities. Call `seedBuiltInWorkflows`
 * to persist them with real worker agent IDs for a given space.
 */
/**
 * Single source of truth for the pre-split coding-template identities that were
 * renamed when the stable coder-owned workflows replaced the merger-based ones.
 * Used both to resolve legacy `templateName` values to their canonical template
 * (`resolveBuiltInWorkflowTemplate`) and to migrate persisted legacy rows in
 * `seedBuiltInWorkflows`. Keep the two consumers in sync via THIS table.
 *
 * The legacy `Coding Workflow` / `Coding with QA Workflow` names (which carried
 * the dedicated merger node) now resolve to the STABLE coder-owned templates —
 * the merger variants were removed, so there is no separate merger template to
 * migrate into.
 */
export const LEGACY_CODING_TEMPLATE_IDENTITIES = [
  {
    legacyName: 'Coding Workflow',
    legacyHandle: 'coding-workflow',
    name: 'Coding',
    handle: 'coding',
  },
  {
    legacyName: 'Coding with QA Workflow',
    legacyHandle: 'coding-with-qa-workflow',
    name: 'Coding with QA',
    handle: 'coding-with-qa',
  },
] as const;

const LEGACY_BUILT_IN_TEMPLATE_NAMES = new Map<string, string>(
  LEGACY_CODING_TEMPLATE_IDENTITIES.map((identity) => [identity.legacyName, identity.name])
);

export function resolveBuiltInWorkflowTemplate(templateName: string): SpaceWorkflow | undefined {
  const canonicalName = LEGACY_BUILT_IN_TEMPLATE_NAMES.get(templateName) ?? templateName;
  return getBuiltInWorkflows().find((workflow) => workflow.name === canonicalName);
}

/**
 * Whether a built-in workflow's canonical route requires a merged PR before
 * `mark_complete`. Resolve this from template identity rather than persisted
 * instruction text: users may customize that prose without opting out of the
 * workflow's merge safety contract.
 */
export function builtInWorkflowRequiresPrMerge(templateName: string | null | undefined): boolean {
  if (!templateName) return false;
  const template = resolveBuiltInWorkflowTemplate(templateName);
  return (template?.nodes ?? []).some(
    (node) =>
      node.postApproval?.targetAgent !== undefined &&
      node.postApproval.instructions === CODER_OWNED_MERGE_INSTRUCTIONS
  );
}

export function getBuiltInWorkflows(): SpaceWorkflow[] {
  // CODING_WORKFLOW is first so a freshly seeded space persists it earliest
  // (lowest created_at) — and it is the only template tagged `default`. Default
  // selection is tag-driven, not position-driven: both `spaceWorkflowRun.start`
  // (auto-select) and `selectDeterministicWorkflowFallback` prefer a
  // `default`-tagged workflow, so the stable Coding template is the default for
  // newly created AND upgraded spaces.
  //
  // PLAN_AND_DECOMPOSE_WORKFLOW is tagged `planning` / `decomposition` (NOT
  // `default`) so the LLM picks it explicitly for multi-task goals that should
  // be broken down before coding starts.
  //
  // Note: this ordering only affects *newly created* spaces — seedBuiltInWorkflows
  // adds missing templates to existing spaces rather than reordering them, so
  // upgraded spaces keep their historical created_at order (and rely on the
  // `default` tag, not position, to resolve the default).
  const workflows = [
    CODING_WORKFLOW,
    CODING_WITH_QA_WORKFLOW,
    PLAN_AND_DECOMPOSE_WORKFLOW,
    RESEARCH_WORKFLOW,
    REVIEW_ONLY_WORKFLOW,
  ];
  const errors = workflows.flatMap(validateWorkflowTemplateGateWriters);
  if (errors.length > 0) {
    throw new Error(`Built-in workflow gate writer validation failed:\n${errors.join('\n')}`);
  }
  return workflows.map(
    (workflow) =>
      migrateWorkflowGateProgressionToHooks({
        ...workflow,
        templateName: workflow.name,
        templateGates: workflow.gates ?? [],
      }).workflow
  );
}

export interface SeedBuiltInWorkflowsResult {
  /** Workflows that were successfully created */
  seeded: string[];
  /**
   * Workflows whose existing DB row was re-stamped on template drift.
   * PR 3/5 uses this path to land `postApproval` routes, updated
   * `completionAutonomyLevel`, and refreshed `templateHash` values onto
   * existing spaces without rewriting user-customisable fields (node
   * UUIDs, custom prompt text, channels, gates), except for known retired
   * built-in prompt text patched during restamp.
   */
  restamped: string[];
  /** Errors for workflows that failed to seed or re-stamp */
  errors: Array<{ name: string; error: string }>;
  /**
   * True when no new workflows were created AND no drift was detected —
   * i.e. this call was a true no-op.
   */
  skipped: boolean;
}

/**
 * Merge node-level structural fields from template nodes onto matching existing nodes.
 *
 * Unlike `customPrompt` (user-configurable), `toolGuards` are structural enforcement
 * metadata that must stay in sync with the template. `postApproval` is also structural
 * routing metadata for the terminal node. This function only touches `postApproval`
 * on the node and `toolGuards` on each agent slot, with a narrow exception for known
 * retired built-in prompt text that must be re-stamped. All other fields (customPrompt,
 * model, disabledSkillIds, etc.) are preserved from the existing row.
 *
 * Template matching is by node name + agent name. If a user renamed a node,
 * preserve its existing node-level route instead of clearing it.
 */
export function mergeNodeStructuralFieldsFromTemplate(
  existingNodes: WorkflowNode[],
  templateNodes: Pick<
    WorkflowNode,
    | 'name'
    | 'agents'
    | 'postApproval'
    | 'requireCodexApproval'
    | 'codexPollIntervalMs'
    | 'codexTimeoutSeconds'
  >[],
  resolveAgentId: (name: string) => string | undefined
): WorkflowNode[] {
  const templateNodesByName = new Map(templateNodes.map((node) => [node.name, node]));
  const existingNodeNames = new Set(existingNodes.map((node) => node.name));
  const existingAgentNames = new Set(
    existingNodes.flatMap((node) => node.agents.map((agent) => agent.name).filter(Boolean))
  );
  const missingTemplateNodes = templateNodes
    .filter(
      (node) =>
        !existingNodeNames.has(node.name) &&
        !node.agents.some((agent) => agent.name && existingAgentNames.has(agent.name))
    )
    .map((node) => ({
      ...node,
      id: generateUUID(),
      agents: node.agents.map((agent) => ({
        ...agent,
        agentId: resolveAgentId(agent.agentId) ?? agent.agentId,
      })),
    }));
  const templateAgentsByKey = new Map<
    string,
    {
      toolGuards: DeclarativeToolGuard[] | undefined;
      resetContextPerTurn: boolean | undefined;
      customPrompt?: WorkflowNodeAgentOverride;
    }
  >();
  for (const node of templateNodes) {
    for (const agent of node.agents) {
      templateAgentsByKey.set(`${node.name}::${agent.name}`, {
        toolGuards: agent.toolGuards,
        resetContextPerTurn: agent.resetContextPerTurn,
        customPrompt: agent.customPrompt,
      });
    }
  }

  const mergedExistingNodes: WorkflowNode[] = existingNodes.map((node) => {
    const templateNode = templateNodesByName.get(node.name);
    return {
      ...node,
      postApproval: templateNode ? templateNode.postApproval : node.postApproval,
      requireCodexApproval: templateNode
        ? templateNode.requireCodexApproval
        : node.requireCodexApproval,
      codexPollIntervalMs: templateNode
        ? templateNode.codexPollIntervalMs
        : node.codexPollIntervalMs,
      // Preserve an existing operator-/RPC-configured codexTimeoutSeconds when
      // the template does not explicitly set an override. Built-in templates
      // leave this field undefined, so blindly taking templateNode.codexTimeoutSeconds
      // would silently delete any non-default timeout on a seeded node during
      // restamp and revert the Codex hook to the global default window.
      codexTimeoutSeconds: templateNode?.codexTimeoutSeconds ?? node.codexTimeoutSeconds,
      agents: node.agents.map((agent) => {
        const key = `${node.name}::${agent.name}`;
        const templateAgent = templateAgentsByKey.get(key);
        if (templateAgent === undefined) return agent;
        // Merge: overwrite structural toolGuards and the resetContextPerTurn flag,
        // preserve user custom prompts except for known retired built-in prompt
        // text that would otherwise survive restamp, and reset legacy pre-split
        // coding slot prompts to the stable coder-owned template prompts.
        const existingCustomPrompt = patchKnownBuiltInPromptDrift(
          agent.customPrompt,
          templateAgent.customPrompt
        );
        const legacyPromptValue = patchLegacyStableSlotPrompt(
          existingCustomPrompt?.value,
          templateAgent.customPrompt?.value,
          node.name,
          agent.name
        );
        const finalPrompt =
          legacyPromptValue !== undefined && legacyPromptValue !== existingCustomPrompt?.value
            ? { value: legacyPromptValue }
            : existingCustomPrompt;
        // Strip the retired coder no-merge guard when the stable coder template
        // carries no guards; PRESERVE any sibling custom guards. The prior
        // exact-singleton test left the retired guard in place when a user guard
        // was also present (length !== 1), denying the coder's own
        // `gh pr merge` and stalling post-approval work.
        let resolvedToolGuards: DeclarativeToolGuard[] | undefined;
        if (templateAgent.toolGuards !== undefined) {
          resolvedToolGuards = templateAgent.toolGuards;
        } else if (agent.toolGuards?.length) {
          const kept = agent.toolGuards.filter(
            (g) => JSON.stringify(g) !== JSON.stringify(RETIRED_CODER_NO_MERGE_GUARD)
          );
          resolvedToolGuards = kept.length > 0 ? kept : undefined;
        } else {
          resolvedToolGuards = undefined;
        }
        const toolGuardsUnchanged =
          (resolvedToolGuards === undefined && agent.toolGuards === undefined) ||
          (resolvedToolGuards !== undefined &&
            agent.toolGuards !== undefined &&
            JSON.stringify(resolvedToolGuards) === JSON.stringify(agent.toolGuards));
        return {
          ...agent,
          ...(toolGuardsUnchanged ? {} : { toolGuards: resolvedToolGuards }),
          ...(templateAgent.resetContextPerTurn === undefined
            ? {}
            : { resetContextPerTurn: templateAgent.resetContextPerTurn }),
          ...(finalPrompt === existingCustomPrompt ? {} : { customPrompt: finalPrompt }),
        };
      }),
    };
  });

  return [...mergedExistingNodes, ...(missingTemplateNodes as WorkflowNode[])];
}

/**
 * When a gate still carries the legacy `codex_review_bot` feature (preserved
 * during restamp for backward compatibility), set `requireCodexApproval: true`
 * on the source node(s) for that gate's channels so the visual editor toggle
 * reflects reality and the node-level config drives runtime injection.
 *
 * Also strips `codex_review_bot` from the gate features so the node toggle
 * becomes the single source of truth and can be disabled by unchecking it.
 */
function migrateCodexFeatureToNodeToggle(
  nodes: WorkflowNode[],
  channels: WorkflowChannel[],
  gates: Gate[]
): { nodes: WorkflowNode[]; gates: Gate[] } {
  // Only migrate gates that do not have a custom script. For scripted gates,
  // dynamic injection is blocked so the node flag cannot replace the legacy
  // feature; leaving them untouched preserves the legacy feature as the sole
  // mechanism and keeps the checkbox as a single source of truth for
  // non-scripted gates.
  // Only migrate legacy features on approval gates — dynamic Codex injection
  // requires isApprovalGate(), so migrating a non-approval gate would break it.
  const codexGateIds = new Set(
    gates
      .filter((g) => !g.script && isApprovalGate(g) && hasEnabledGateFeature(g, 'codex_review_bot'))
      .map((g) => g.id)
  );
  // Scripted approval gates with legacy codex: strip node toggles so the UI
  // doesn't show a misleading enabled checkbox for gates where dynamic
  // injection is blocked and the legacy feature is the actual mechanism.
  const scriptedCodexGateIds = new Set(
    gates
      .filter((g) => g.script && isApprovalGate(g) && hasEnabledGateFeature(g, 'codex_review_bot'))
      .map((g) => g.id)
  );

  const collectSourceNodes = (gateIdSet: Set<string>): Set<string> => {
    const result = new Set<string>();
    for (const channel of channels) {
      if (!channel.gateId || !gateIdSet.has(channel.gateId)) continue;
      if (channel.from === '*') {
        for (const node of nodes) result.add(node.id);
        continue;
      }
      const nodeByName = nodes.find((n) => n.name === channel.from);
      if (nodeByName) {
        result.add(nodeByName.id);
        continue;
      }
      for (const node of nodes) {
        try {
          const agents = resolveNodeAgents(node);
          if (agents.some((a) => a.name === channel.from)) {
            result.add(node.id);
          }
        } catch {
          // skip malformed nodes
        }
      }
    }
    return result;
  };

  const nodesToFlag = collectSourceNodes(codexGateIds);
  const nodesToUnflag = collectSourceNodes(scriptedCodexGateIds);

  // Also strip toggles for nodes connected to ANY scripted approval gate
  // (even without a legacy codex_review_bot feature). Dynamic Codex injection
  // is blocked for scripted approval gates, so a node toggle is misleading
  // when the node sends through one.
  const allScriptedApprovalGateIds = new Set(
    gates.filter((g) => g.script && isApprovalGate(g)).map((g) => g.id)
  );
  for (const nodeId of collectSourceNodes(allScriptedApprovalGateIds)) {
    nodesToUnflag.add(nodeId);
  }

  const needsNodeChange = nodesToFlag.size > 0 || nodesToUnflag.size > 0;
  const migratedNodes = needsNodeChange
    ? nodes.map((node) => {
        if (nodesToUnflag.has(node.id)) {
          const next = { ...node };
          delete next.requireCodexApproval;
          return next;
        }
        if (nodesToFlag.has(node.id)) {
          return { ...node, requireCodexApproval: true };
        }
        return node;
      })
    : nodes;

  const migratedGateIdsToStrip = new Set<string>();
  for (const gateId of codexGateIds) {
    const sources = collectSourceNodes(new Set([gateId]));
    const hasUnflaggedSource = Array.from(sources).some((nodeId) => nodesToUnflag.has(nodeId));
    if (!hasUnflaggedSource) migratedGateIdsToStrip.add(gateId);
  }

  const migratedGates = gates.map((gate) => {
    if (!gate.features?.codex_review_bot) return gate;
    // Preserve legacy feature on gates that cannot be replaced by dynamic
    // approval-gate injection.
    if (gate.script || gate.poll || !migratedGateIdsToStrip.has(gate.id)) return gate;
    const { codex_review_bot: _ignored, ...restFeatures } = gate.features;
    return {
      ...gate,
      features: Object.keys(restFeatures).length > 0 ? restFeatures : undefined,
    };
  });

  return { nodes: migratedNodes, gates: migratedGates };
}

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
// Immediate predecessor (post-#682): the no-arg subscribe wording, which failed
// to resolve the PR URL before the gated handoff recorded it (#886 P1). Registered
// as a retired variant so stored live-space prompts restamp to the explicit-prUrl
// wording above on the next daemon restart.
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
// Coding Workflow step 7: the Validation Complete escape hatch was removed.
// Existing seeded spaces still carry the old step that handed validation-only
// tasks off to the now-removed "Validation Complete" node; restamp swaps it for
// the current guidance (escalate the misroute via the runtime-provided target,
// no empty PR).
const CURRENT_CODING_WORKFLOW_NOCHANGE_STEP_PROMPT =
  '7. If the task requires no code changes (validation-only, a diagnostic, or already ' +
  'complete): do NOT create an empty commit or PR. This workflow only completes via a ' +
  'reviewed PR, so a no-change task is misrouted — escalate via `send_message` to the ' +
  'escalation target listed in your Runtime Execution Contract, explaining that the task ' +
  'produced no code changes and needs re-routing, then stop and wait for guidance.\n\n';
// Immediate predecessor of the current step-7 wording (hard-coded `space-agent`).
// Existing seeded spaces that carry this literal must be restamped to the
// runtime-contract reference above.
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
  'APPROVE verdict with zero P0-P3 findings. Send the handoff to start the Codex review ' +
  'timeout window (2 hours by default), then wait for a Codex bot `+1` reaction or the ' +
  'timeout before proceeding. ';
const RETIRED_FULLSTACK_REVIEW_HANDOFF_PROMPT =
  'terminal handoff is to write `review-approval-gate` with approved=true after an APPROVE ' +
  'verdict with zero P0-P3 findings. Wait for codex[bot] `+1` or timeout before proceeding. ';
const RETIRED_HARDCODED_FULLSTACK_REVIEW_HANDOFF_PROMPT =
  'terminal handoff is `send_message(target="QA", message="<approved>", data: { approved: true })` ' +
  'after an APPROVE verdict with zero P0-P3 findings. Wait for codex[bot] `+1` or timeout before proceeding. ';
// Pre-fix send_message Fullstack Review handoff (the variant that shipped in
// production immediately before this PR). Distinguished from
// RETIRED_FULLSTACK_REVIEW_HANDOFF_PROMPT (older gate-writing handoff) by
// the send_message phrasing and the "10-minute Codex timeout" + `codex[bot]`
// wording. Persisted prompts from seeded spaces that use this exact sentence
// need a dedicated patch variant so restamp can swap them to the current
// 2-hour / Codex-bot wording.
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

// Retired shared Codex approval guidance (pre codex-bot-rename + 2h timeout
// fix). Used by patchKnownBuiltInPromptDrift to recognize persisted Plan
// Review and Fullstack Review agent prompts that still cite `codex[bot]` and
// the old "10 minutes" timeout, and swap them to the current guidance during
// restamp. Without this, existing seeded spaces keep telling reviewers the
// window is 10 minutes while the migrated gate/hook now blocks for 2 hours.
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

// type→shape save_artifact API migration. `dev` shipped the seeded built-in
// prompts on the legacy freeform-type API; the shape cutover rewrote each call
// site (and expanded the QA all-green step from one result call into a link +
// decision pair). Each pair is `[currentShapeText, retiredTypeResultText]`;
// `buildRetiredBuiltInPromptValues` reverse-applies them (current→retired) to
// recognize a persisted dev-era prompt and swap it to the current template. Only
// an EXACT retired variant swaps, so operator customizations to surrounding
// prose are preserved (a customized prompt that no longer matches a retired
// variant is left untouched).
const SHAPE_PR_LINK = 'save_artifact({ shape: "link", kind: "pr", data: { url: "<url>" } })';
const RETIRED_TYPE_RESULT_PR_LINK = 'save_artifact({ type: "result", data: { pr_url: "<url>" } })';
// Coding + Research reviewer prompts also rewrote the sentence preceding the
// PR-link call ("Nest pr_url inside artifact data…" → "record the PR as a
// link…"). Reversing the call alone leaves the new sentence, so the generated
// variant would not match the real dev prompt — pair the sentence with the call
// so the whole region reconstructs the dev-era reviewer prompt.
const SHAPE_PR_EVERY_CYCLE =
  'Use save_artifact every cycle to record the PR as a `link` so post-approval dispatch can resolve it.\n\n';
const RETIRED_TYPE_RESULT_EVERY_CYCLE =
  'Use save_artifact every cycle. Nest pr_url inside artifact data for post-approval dispatch.\n\n';
// Review-only reviewer prompt also changed the trailing prose ("to save a result
// artifact" → "to record the PR"), so its pair carries that tail to stay exact.
const SHAPE_PR_LINK_REVIEW_ONLY =
  'save_artifact({ shape: "link", kind: "pr", data: { url: "<url>" } }) to record the PR';
const RETIRED_TYPE_RESULT_PR_LINK_REVIEW_ONLY =
  'save_artifact({ type: "result", data: { pr_url: "<url>" } }) to save a result artifact';
const SHAPE_DECISION_DISPATCHER_STACK =
  'save_artifact({ shape: "decision", summary: "Created N tasks from plan: <short list>", ' +
  'data: { recommendation: "dispatched", created_task_ids: [<ids>], stack_prefix: "<prefix>", ' +
  'stack_branches: ["plan/<prefix>/<item-1-slug>", "plan/<prefix>/<item-2-slug>", ...] } })` to record the dispatch outcome';
const RETIRED_TYPE_RESULT_DISPATCHER_STACK =
  'save_artifact({ type: "result", append: true, summary: "Created N tasks from plan: <short list>", ' +
  'created_task_ids: [<ids>], stack_prefix: "<prefix>", ' +
  'stack_branches: ["plan/<prefix>/<item-1-slug>", "plan/<prefix>/<item-2-slug>", ...] })` to record the dispatch audit entry';
const SHAPE_DECISION_DISPATCHER_SHORT =
  'save_artifact({ shape: "decision", summary: "Dispatched N tasks", data: { recommendation: "dispatched", created_task_ids: [...] } })';
const RETIRED_TYPE_RESULT_DISPATCHER_SHORT =
  'save_artifact({ type: "result", append: true, created_task_ids: [...] })';
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
  // Pre-PR-dev Coding Workflow: PR step gained subscribe instruction, all other
  // steps unchanged. Existing seeded spaces have the old step-5 text without
  // subscribe — swap the step text only.
  [[CURRENT_CODING_WORKFLOW_PR_STEP_PROMPT, RETIRED_CODING_WORKFLOW_PR_STEP_PROMPT]],
  // #886 P1: the post-#682 no-arg `subscribe_pr_events({})` wording failed to
  // resolve the PR URL before the gated handoff recorded it. Swap it to the
  // explicit-prUrl wording so stored live-space prompts restamp on restart.
  [[CURRENT_CODING_WORKFLOW_PR_STEP_PROMPT, RETIRED_NOARG_CODING_WORKFLOW_PR_STEP_PROMPT]],
  [[CURRENT_FULLSTACK_CODING_PR_STEP_PROMPT, RETIRED_NOARG_FULLSTACK_CODING_PR_STEP_PROMPT]],
  [[CURRENT_RESEARCH_PR_STEP_PROMPT, RETIRED_NOARG_RESEARCH_PR_STEP_PROMPT]],
  // Gate-era Coding Workflow: PR step + handoff + rehandoff all differ.
  [
    [CURRENT_CODING_WORKFLOW_PR_STEP_PROMPT, RETIRED_CODING_WORKFLOW_PR_STEP_PROMPT],
    [CURRENT_CODING_WORKFLOW_HANDOFF_PROMPT, RETIRED_CODING_WORKFLOW_HANDOFF_PROMPT],
    [CURRENT_CODING_WORKFLOW_REHANDOFF_PROMPT, RETIRED_CODING_WORKFLOW_REHANDOFF_PROMPT],
  ],
  // Hardcoded-era Coding Workflow: PR step + hardcoded handoff + rehandoff.
  [
    [CURRENT_CODING_WORKFLOW_PR_STEP_PROMPT, RETIRED_CODING_WORKFLOW_PR_STEP_PROMPT],
    [CURRENT_CODING_WORKFLOW_HANDOFF_PROMPT, RETIRED_HARDCODED_CODING_WORKFLOW_HANDOFF_PROMPT],
    [CURRENT_CODING_WORKFLOW_REHANDOFF_PROMPT, RETIRED_HARDCODED_CODING_WORKFLOW_REHANDOFF_PROMPT],
  ],
  // Validation Complete removal: step 7 used to hand validation-only tasks to
  // the now-removed "Validation Complete" node. Swapped independently — it
  // composes with the PR/handoff/rehandoff groups above via candidate chaining.
  [[CURRENT_CODING_WORKFLOW_NOCHANGE_STEP_PROMPT, RETIRED_CODING_WORKFLOW_VALIDATION_STEP_PROMPT]],
  // Immediate predecessor of the current step-7 wording: hard-coded `space-agent`.
  // Seeded spaces from that revision restamp to the runtime-contract reference.
  [
    [
      CURRENT_CODING_WORKFLOW_NOCHANGE_STEP_PROMPT,
      RETIRED_PREVIOUS_CODING_WORKFLOW_NOCHANGE_STEP_PROMPT,
    ],
  ],
  // Pre-PR-dev Fullstack Coding: PR step gained subscribe, rest unchanged.
  [[CURRENT_FULLSTACK_CODING_PR_STEP_PROMPT, RETIRED_FULLSTACK_CODING_PR_STEP_PROMPT]],
  // Gate-era Fullstack Coding: PR step + ready prompt + step-4 handoff.
  [
    [CURRENT_FULLSTACK_CODING_PR_STEP_PROMPT, RETIRED_FULLSTACK_CODING_PR_STEP_PROMPT],
    [CURRENT_FULLSTACK_CODING_READY_PROMPT, RETIRED_FULLSTACK_CODING_READY_PROMPT],
    [CURRENT_FULLSTACK_CODING_STEP_PROMPT, RETIRED_FULLSTACK_CODING_STEP_PROMPT],
  ],
  // Hardcoded-era Fullstack Coding: PR step + hardcoded ready + step-4 handoff.
  [
    [CURRENT_FULLSTACK_CODING_PR_STEP_PROMPT, RETIRED_FULLSTACK_CODING_PR_STEP_PROMPT],
    [CURRENT_FULLSTACK_CODING_READY_PROMPT, RETIRED_HARDCODED_FULLSTACK_CODING_READY_PROMPT],
    [CURRENT_FULLSTACK_CODING_STEP_PROMPT, RETIRED_HARDCODED_FULLSTACK_CODING_STEP_PROMPT],
  ],
  // No-code guidance was added to the Fullstack Coder steps. Existing seeded
  // spaces that lack it can be patched by dropping the guidance paragraph.
  [[FULLSTACK_CODING_NOCHANGE_GUIDANCE, '']],
  // Immediate predecessor of the Fullstack no-code guidance hard-coded `space-agent`.
  // Seeded spaces from that revision restamp to the runtime-contract reference.
  [[FULLSTACK_CODING_NOCHANGE_GUIDANCE, RETIRED_PREVIOUS_FULLSTACK_CODING_NOCHANGE_GUIDANCE]],
  // Pre-PR-dev Research: PR step gained subscribe, handoff unchanged.
  [[CURRENT_RESEARCH_PR_STEP_PROMPT, RETIRED_RESEARCH_PR_STEP_PROMPT]],
  [[CURRENT_FULLSTACK_REVIEW_HANDOFF_PROMPT, RETIRED_FULLSTACK_REVIEW_HANDOFF_PROMPT]],
  [[CURRENT_FULLSTACK_REVIEW_HANDOFF_PROMPT, RETIRED_HARDCODED_FULLSTACK_REVIEW_HANDOFF_PROMPT]],
  // Guidance-only swap: covers PD_PLAN_REVIEW_PROMPT and any other persisted
  // prompt that embeds the retired shared Codex guidance but none of the
  // fullstack handoff snippets.
  [[CODEX_REACTION_APPROVAL_GUIDANCE, RETIRED_CODEX_REACTION_APPROVAL_GUIDANCE]],
  // Fullstack review handoff + guidance swap: covers FULLSTACK_REVIEW_PROMPT,
  // which embeds both snippets.
  [
    [CURRENT_FULLSTACK_REVIEW_HANDOFF_PROMPT, RETIRED_FULLSTACK_REVIEW_HANDOFF_PROMPT],
    [CODEX_REACTION_APPROVAL_GUIDANCE, RETIRED_CODEX_REACTION_APPROVAL_GUIDANCE],
  ],
  [
    [CURRENT_FULLSTACK_REVIEW_HANDOFF_PROMPT, RETIRED_HARDCODED_FULLSTACK_REVIEW_HANDOFF_PROMPT],
    [CODEX_REACTION_APPROVAL_GUIDANCE, RETIRED_CODEX_REACTION_APPROVAL_GUIDANCE],
  ],
  // Pre-fix production variant: persisted Fullstack Review prompts seeded
  // immediately before this PR used the send_message handoff with the old
  // "10-minute Codex timeout" + codex[bot] wording AND the old shared
  // guidance. Cover that exact combination so restamp swaps both halves.
  [
    [CURRENT_FULLSTACK_REVIEW_HANDOFF_PROMPT, RETIRED_PRE_FIX_FULLSTACK_REVIEW_HANDOFF_PROMPT],
    [CODEX_REACTION_APPROVAL_GUIDANCE, RETIRED_CODEX_REACTION_APPROVAL_GUIDANCE],
  ],
  // Handoff-only swap for the pre-fix variant (covers the rare case where
  // guidance was already patched but handoff was not).
  [[CURRENT_FULLSTACK_REVIEW_HANDOFF_PROMPT, RETIRED_PRE_FIX_FULLSTACK_REVIEW_HANDOFF_PROMPT]],
  // Plan Review procedure: the reviewer briefly used the authed `get_pr_diff`
  // tool (now removed — the reviewer has bash again). Existing seeded spaces
  // that carried the get_pr_diff line converge back to the gh-based procedure
  // during restamp.
  [
    [
      'Procedure: read the PR diff with `gh pr diff` / `gh pr view`, post a visible PR review comment, then ',
      'Procedure: read the PR diff with the `get_pr_diff` tool, post a visible PR review comment, then ',
    ],
  ],
  // Post-approval redesign: the re-approval paragraph was APPENDED to the
  // Reviewer end-node prompts (Coding + Research) and the Fullstack QA end-node
  // prompt. Existing template-linked workflows retain the pre-redesign prompt
  // (without the paragraph); map each back by removing the appended paragraph
  // so `mergeNodeStructuralFieldsFromTemplate` swaps them to the current
  // template on the next re-stamp. The leading whitespace in each constant is
  // load-bearing — it is the exact gap between the pre-redesign suffix and the
  // new paragraph, so removal reconstructs the prior prompt byte-for-byte.
  [[REVIEWER_POST_APPROVAL_BLOCKER_PARAGRAPH, '']],
  [[FULLSTACK_QA_POST_APPROVAL_PARAGRAPH, '']],
  // type→shape save_artifact API migration (dev→shape cutover). Each swaps a
  // persisted legacy type:"result" call site to its shape equivalent; only an
  // exact retired variant matches, so customizations are preserved.
  [[SHAPE_PR_LINK, RETIRED_TYPE_RESULT_PR_LINK]],
  // Coding + Research reviewer prompts rewrote BOTH the preceding "every cycle"
  // sentence and the PR-link call, so both must reverse together to reconstruct
  // the dev-era prompt.
  [
    [SHAPE_PR_EVERY_CYCLE, RETIRED_TYPE_RESULT_EVERY_CYCLE],
    [SHAPE_PR_LINK, RETIRED_TYPE_RESULT_PR_LINK],
  ],
  [[SHAPE_PR_LINK_REVIEW_ONLY, RETIRED_TYPE_RESULT_PR_LINK_REVIEW_ONLY]],
  [[SHAPE_DECISION_DISPATCHER_STACK, RETIRED_TYPE_RESULT_DISPATCHER_STACK]],
  [[SHAPE_DECISION_DISPATCHER_SHORT, RETIRED_TYPE_RESULT_DISPATCHER_SHORT]],
  [[SHAPE_NOTE_QA_FAILED, RETIRED_TYPE_RESULT_QA_FAILED]],
  [[SHAPE_QA_ALL_GREEN, RETIRED_TYPE_RESULT_QA_ALL_GREEN]],
] as const;

function patchKnownBuiltInPromptDrift<T extends WorkflowNodeAgentOverride | undefined>(
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

function nodeReferences(node: WorkflowNode): Set<string> {
  return new Set([
    node.id,
    node.name,
    ...node.agents.flatMap((agent) => [agent.name, agent.agentId, `${node.id}/${agent.name}`]),
  ]);
}

function remapTemplateChannelRef(
  ref: string,
  templateNodes: WorkflowNode[],
  existingNodes: WorkflowNode[]
): string {
  const templateNode = templateNodes.find((node) => nodeReferences(node).has(ref));
  if (!templateNode) return ref;

  const templateNodeIndex = templateNodes.findIndex((node) => node.id === templateNode.id);
  const existingNode =
    existingNodes.find((node) => node.id === templateNode.id) ??
    existingNodes.find((node) => node.name === templateNode.name) ??
    existingNodes.find((node) =>
      templateNode.agents.some((templateAgent) =>
        node.agents.some(
          (agent) =>
            (agent.name && agent.name === templateAgent.name) ||
            agent.agentId === templateAgent.agentId
        )
      )
    ) ??
    (ref === templateNode.name &&
    templateNodeIndex >= 0 &&
    existingNodes.length === templateNodes.length
      ? existingNodes[templateNodeIndex]
      : undefined);
  return existingNode?.name ?? ref;
}

function remapTemplateChannel(
  channel: NonNullable<SpaceWorkflow['channels']>[number],
  templateNodes: WorkflowNode[],
  existingNodes: WorkflowNode[]
): NonNullable<SpaceWorkflow['channels']>[number] {
  const remapRef = (ref: string) => remapTemplateChannelRef(ref, templateNodes, existingNodes);
  return {
    ...channel,
    from: remapRef(channel.from),
    to: Array.isArray(channel.to) ? channel.to.map(remapRef) : remapRef(channel.to),
  };
}

function removeLegacyPrReadyGateChannels(
  channels: SpaceWorkflow['channels'],
  templateNodes: WorkflowNode[],
  existingNodes: WorkflowNode[]
): SpaceWorkflow['channels'] {
  const legacyRouteKeys = new Set(LEGACY_PR_READY_TEMPLATE_ROUTES);
  for (const route of LEGACY_PR_READY_TEMPLATE_ROUTES) {
    const [gateId, from, to] = route.split(':');
    legacyRouteKeys.add(
      `${gateId}:${remapTemplateChannelRef(from, templateNodes, existingNodes)}:${remapTemplateChannelRef(
        to,
        templateNodes,
        existingNodes
      )}`
    );
  }

  return channels?.filter((channel) => {
    const gateId = channel.gateId;
    if (!gateId || !LEGACY_PR_READY_GATE_IDS.has(gateId)) return true;
    const routeKey = `${gateId}:${channel.from}:${String(channel.to)}`;
    return !legacyRouteKeys.has(routeKey);
  });
}

const RETIRED_POST_APPROVAL_NODE = 'Post-Approval';
const RETIRED_MERGER_SLOT_NAMES = new Set(['merger']);
const RETIRED_MERGE_INSTRUCTIONS_SHA256 =
  '635b45c887a11bd6fcbebf05c5ab8670386532661b54bec25e2815b3854f90ad';
export const RETIRED_MERGER_RAW_MERGE_GUARD: DeclarativeToolGuard = {
  matcher: 'Bash',
  pattern: 'gh\\b[^\\n]*?pr\\s+merge\\b|\\bmergePullRequest\\b|pulls\\/[^\\/\\s"]+\\/merge\\b',
  decision: 'deny',
  reason:
    'Direct PR merges are blocked — use the merge_pr tool instead. merge_pr is the authoritative, audited merge ' +
    'path: it deterministically verifies the approval covers the current head (plus CI, unresolved review ' +
    'threads, and branch protection) before merging bound to that head. This Bash guard is defense-in-depth ' +
    '(it blocks the common/direct raw-merge forms, including wrapped ones); it is not the enforcement — always ' +
    'merge through merge_pr.',
};
// The EXACT retired PR-Merger slot prompt (built-in-workflows.ts pre-pivot). The
// strip guard compares the stored slot prompt to this EXACT value — a substring
// match is insufficient because a user who appended instructions to the seeded
// prompt would still contain any distinctive marker. Any difference means a
// user customization and the node is preserved as drift.
export const RETIRED_PR_MERGER_SLOT_PROMPT =
  'You are the PR Merger — the designated shell-capable agent for post-approval merges. ' +
  'You are spawned only after the task is approved; your first message is the exact merge ' +
  'procedure — follow it step by step. You hold the only Bash tool in this review/merge split ' +
  '(the approval authority posts reviews via post_review and runs no code). You merge the PR ' +
  'ONLY through the `merge_pr` tool — a deterministic gate that verifies the current head is ' +
  'covered by a real GitHub approval (plus CI, unresolved threads, branch protection) before ' +
  'merging bound to that head. Raw `gh pr merge` and merge-API calls are BLOCKED on this slot; ' +
  'do not attempt them. The Space task approval (approval_source) is provenance only and does ' +
  'NOT authorize a merge — never reason that it should let a merge through. Clean up the ' +
  'branch, sync the worktree, and report any merge blocker (including conflicts) to the ' +
  'approval authority — wait for it to re-approve the head and signal you to continue. The ' +
  'approval authority and channel target are named in your first message and the Runtime ' +
  'Execution Contract; they differ by workflow (e.g. Review for some, QA for others), so never ' +
  'assume a specific one. You never approve — the approval authority is the re-approval ' +
  'authority. Do NOT call approve_task or submit_for_approval — the task is already approved. ' +
  'Call mark_complete once the merge and sync are done.';

/**
 * Strips the retired Post-Approval merger node and everything that touched it
 * from a restamped row converging to a stable coder-owned template.
 *
 * The merge helpers (`mergeNodeStructuralFieldsFromTemplate`,
 * `mergeChannelsFromTemplate`, `mergeHooksFromTemplate`,
 * `mergeGateStructuralFieldsFromTemplate`) only ever ADD missing template
 * pieces — they never remove nodes/channels/hooks/gates that exist in the
 * stored row but not in the template. So when the dedicated merger node was
 * removed from the built-in templates, seeded spaces that still carry it (plus
 * the Post-Approval↔* channels and any Post-Approval hooks) would keep them
 * forever. This pass excises the retired pieces so restamp converges to the
 * stable 2-node Coding ↔ Review / 2-node Research ↔ Review / 3-node
 * Coding → Review → QA graphs.
 *
 * Runs for any built-in template that previously carried the merger node —
 * i.e. the stable `Coding`, `Coding with QA`, and `Research` templates, which
 * legacy rows with the legacy templateName migrate into via
 * `LEGACY_CODING_TEMPLATE_IDENTITIES`. User-created workflows never reach
 * restamp (no `templateName`).
 *
 * Precision guard: the node is matched by the relatively generic name
 * "Post-Approval", so the strip only fires when that node's FULL retired seed
 * identity is still intact — an agent slot named `merger` whose customPrompt
 * still carries the retired PR-Merger slot prompt marker, AND a node-level
 * `postApproval` route targeting `merger`. A user who repurposed the name
 * (no `merger` slot), or customized the node (changed the merger prompt /
 * model / assigned agent / added routes / removed the route) is left
 * untouched — the customization is preserved and the row drifts for explicit
 * user-driven sync instead of being silently edited.
 */
function stripRetiredPostApproval({
  templateName,
  nodes,
  channels,
  hooks,
}: {
  templateName: string;
  nodes: WorkflowNode[];
  channels: SpaceWorkflow['channels'];
  hooks: SpaceWorkflow['hooks'];
}): {
  nodes: WorkflowNode[];
  channels: SpaceWorkflow['channels'];
  hooks: SpaceWorkflow['hooks'];
  channelsChanged: boolean;
} {
  const isStableCoderOwnedTemplate = new Set([
    CODING_WORKFLOW.name,
    CODING_WITH_QA_WORKFLOW.name,
    RESEARCH_WORKFLOW.name,
  ]).has(templateName);
  if (!isStableCoderOwnedTemplate) {
    return { nodes, channels, hooks, channelsChanged: false };
  }

  // Only strip when a node named "Post-Approval" still carries the COMPLETE
  // retired seed identity:
  //   - the node has EXACTLY one agent slot: the `merger` slot with the pristine
  //     PR-Merger prompt, NO model override, and NO replaceAgentPrompt (any of
  //     these — prompt text, model, mode — marks a customization; the agentId
  //     is a per-space UUID for persisted rows, so it is not a distinguishing
  //     signal);
  //   - the node's postApproval route targets `merger` (the seeded route).
  // A node that only matches by name, or whose slot/route was customized in any
  // way, is the user's own and must not be touched — leave it as drift for
  // explicit sync instead of silently destroying the customization.
  const isPristineMergerNode = (node: WorkflowNode): boolean => {
    if (node.name !== RETIRED_POST_APPROVAL_NODE) return false;
    if (node.postApproval?.targetAgent !== 'merger') return false;
    const hasRetiredRoute =
      typeof node.postApproval.instructions === 'string' &&
      createHash('sha256').update(node.postApproval.instructions).digest('hex') ===
        RETIRED_MERGE_INSTRUCTIONS_SHA256;
    const hasMigratedDeferredRoute =
      node.postApproval.instructions === CODER_OWNED_MERGE_INSTRUCTIONS;
    if (!hasRetiredRoute && !hasMigratedDeferredRoute) return false;
    const mergerAgents = (node.agents ?? []).filter(
      (agent) => agent.name && RETIRED_MERGER_SLOT_NAMES.has(agent.name)
    );
    // Exactly one merger slot, with the seeded identity.
    return (
      mergerAgents.length === 1 &&
      (node.agents?.length ?? 0) === 1 &&
      mergerAgents[0].model === undefined &&
      mergerAgents[0].thinkingLevel === undefined &&
      mergerAgents[0].replaceAgentPrompt !== true &&
      mergerAgents[0].disabledSkillIds === undefined &&
      mergerAgents[0].extraMcpServers === undefined &&
      mergerAgents[0].resetContextPerTurn === undefined &&
      ((hasRetiredRoute &&
        JSON.stringify(mergerAgents[0].toolGuards) ===
          JSON.stringify([RETIRED_MERGER_RAW_MERGE_GUARD]) &&
        mergerAgents[0].customPrompt?.value === RETIRED_PR_MERGER_SLOT_PROMPT) ||
        (hasMigratedDeferredRoute &&
          mergerAgents[0].toolGuards === undefined &&
          mergerAgents[0].customPrompt?.value === CODER_OWNED_MERGE_PROMPT))
    );
  };
  const hasBuiltInMergerMarker = nodes.some(isPristineMergerNode);
  if (!hasBuiltInMergerMarker) {
    return { nodes, channels, hooks, channelsChanged: false };
  }

  const nodesResult = nodes.filter((node) => node.name !== RETIRED_POST_APPROVAL_NODE);

  const channelsResult = channels?.filter((channel) => {
    if (channel.from === RETIRED_POST_APPROVAL_NODE) return false;
    const targets = Array.isArray(channel.to) ? channel.to : [channel.to];
    return !targets.includes(RETIRED_POST_APPROVAL_NODE);
  });

  const hooksResult = hooks?.filter((hook) => {
    return (
      hook.sourceNode !== RETIRED_POST_APPROVAL_NODE &&
      hook.targetNode !== RETIRED_POST_APPROVAL_NODE
    );
  });

  return {
    nodes: nodesResult,
    channels: channelsResult,
    hooks: hooksResult,
    channelsChanged: (channelsResult?.length ?? 0) !== (channels?.length ?? 0),
  };
}

/** @internal Exported for testing. */
export function mergeChannelsFromTemplate(
  existingChannels: SpaceWorkflow['channels'],
  templateChannels: SpaceWorkflow['channels'],
  templateNodes: WorkflowNode[],
  existingNodes: WorkflowNode[]
): SpaceWorkflow['channels'] {
  if (!templateChannels) return existingChannels;
  const remappedTemplateChannels = templateChannels.map((channel) =>
    remapTemplateChannel(channel, templateNodes, existingNodes)
  );
  if (!existingChannels) return remappedTemplateChannels;

  // Match key mirrors buildWorkflowFingerprint's channel normalization: a
  // single-target `to` array (e.g. ['Coding']) is runtime-equivalent to the
  // scalar form ('Coding'), so normalize before keying. Otherwise an existing
  // array-form back-channel wouldn't match the template's scalar form, leaving
  // the old capped channel in place and appending a capped duplicate.
  const channelKey = (channel: NonNullable<SpaceWorkflow['channels']>[number]) => {
    const normalizedTo = Array.isArray(channel.to)
      ? channel.to.length === 1
        ? channel.to[0]
        : [...channel.to].sort()
      : channel.to;
    return JSON.stringify({
      from: channel.from,
      to: normalizedTo,
      gateId: channel.gateId ?? null,
    });
  };

  const templateChannelByKey = new Map(
    remappedTemplateChannels.map((channel) => [channelKey(channel), channel])
  );

  // In-place merge of structural channel fields (maxCycles, label) onto
  // channels that already exist in the seeded workflow, mirroring the gate
  // (writers/features) and node-agent (toolGuards) merges. Channels are
  // structural topology: {from, to, gateId} is the stable match key and the
  // template owns maxCycles + label. Propagating them keeps structural changes
  // (e.g. raising a cyclic cap 6 → 50) landing on pre-existing spaces; without
  // this, the unconditional templateHash write would stamp the new hash while
  // leaving the old field values in place, then block any future fix from
  // reaching them (the matching hash skips the row on every later startup).
  const mergedExisting = existingChannels.map((channel) => {
    const templateChannel = templateChannelByKey.get(channelKey(channel));
    if (!templateChannel) return channel;
    return {
      ...channel,
      maxCycles: templateChannel.maxCycles,
      label: templateChannel.label,
    };
  });

  const mergedExistingKeys = new Set(mergedExisting.map(channelKey));
  const missingTemplateChannels = remappedTemplateChannels.filter(
    (channel) => !mergedExistingKeys.has(channelKey(channel))
  );

  return [...mergedExisting, ...missingTemplateChannels];
}

function remapTemplateHookAgentSlots(
  templateSourceNodeName: string,
  existingSourceNodeName: string,
  templateSlots: string[] | undefined,
  templateNodes: WorkflowNode[],
  existingNodes: WorkflowNode[]
): string[] | undefined {
  if (!templateSlots || templateSlots.length === 0) return undefined;

  const templateNode = templateNodes.find((node) => node.name === templateSourceNodeName);
  const existingNode = existingNodes.find((node) => node.name === existingSourceNodeName);
  if (!templateNode || !existingNode) return undefined;

  const existingAgentNames = new Set(
    existingNode.agents.map((agent) => agent.name).filter((name): name is string => !!name)
  );
  const mappedSlots: string[] = [];
  for (const slot of templateSlots) {
    if (existingAgentNames.has(slot)) {
      mappedSlots.push(slot);
      continue;
    }

    const templateSlotIndex = templateNode.agents.findIndex((agent) => agent.name === slot);
    const existingSlotName =
      templateSlotIndex >= 0 ? existingNode.agents[templateSlotIndex]?.name : undefined;
    if (existingSlotName) {
      mappedSlots.push(existingSlotName);
    }
  }

  return mappedSlots.length === templateSlots.length ? mappedSlots : undefined;
}

function remapTemplateHook(
  hook: NonNullable<SpaceWorkflow['hooks']>[number],
  templateNodes: WorkflowNode[],
  existingNodes: WorkflowNode[]
): NonNullable<SpaceWorkflow['hooks']>[number] {
  const remapRef = (ref: string) => remapTemplateChannelRef(ref, templateNodes, existingNodes);
  return {
    ...hook,
    sourceNode: remapRef(hook.sourceNode),
    targetNode: hook.targetNode ? remapRef(hook.targetNode) : hook.targetNode,
    authorizedCallers: hook.authorizedCallers?.map((caller) => {
      const sourceNode = remapRef(caller.sourceNode);
      const agentSlots = remapTemplateHookAgentSlots(
        caller.sourceNode,
        sourceNode,
        caller.agentSlots,
        templateNodes,
        existingNodes
      );
      if (agentSlots) return { ...caller, sourceNode, agentSlots };
      const { agentSlots: _agentSlots, ...callerWithoutSlots } = caller;
      return { ...callerWithoutSlots, sourceNode };
    }),
  };
}

function equivalentGeneratedHook(
  existingHook: NonNullable<SpaceWorkflow['hooks']>[number],
  templateHook: NonNullable<SpaceWorkflow['hooks']>[number]
): boolean {
  return (
    existingHook.method === templateHook.method &&
    existingHook.sourceNode === templateHook.sourceNode &&
    existingHook.targetNode === templateHook.targetNode &&
    existingHook.classification === templateHook.classification &&
    existingHook.validator.kind === 'script' &&
    templateHook.validator.kind === 'script' &&
    existingHook.validator.source === templateHook.validator.source &&
    JSON.stringify(existingHook.authorizedCallers ?? []) ===
      JSON.stringify(templateHook.authorizedCallers ?? [])
  );
}

function mergeHooksFromTemplate(
  templateHooks: SpaceWorkflow['hooks'],
  templateNodes: WorkflowNode[],
  existingNodes: WorkflowNode[],
  existingHooks?: SpaceWorkflow['hooks']
): SpaceWorkflow['hooks'] {
  const remappedTemplateHooks =
    templateHooks?.map((hook) => remapTemplateHook(hook, templateNodes, existingNodes)) ?? [];
  if (!existingHooks || existingHooks.length === 0) return remappedTemplateHooks;

  const templateHookIds = new Set(remappedTemplateHooks.map((hook) => hook.id));
  const equivalentTemplateHooks = new Set(
    existingHooks
      .filter((existingHook) =>
        remappedTemplateHooks.some((templateHook) =>
          equivalentGeneratedHook(existingHook, templateHook)
        )
      )
      .map((hook) => hook.id)
  );
  return [
    ...existingHooks.filter(
      (hook) => !templateHookIds.has(hook.id) && !equivalentTemplateHooks.has(hook.id)
    ),
    ...remappedTemplateHooks,
  ];
}

/** @internal Exported for testing. */
export function mergeGateStructuralFieldsFromTemplate(
  existingGates: Gate[] | undefined,
  templateGates: Gate[] | undefined
): Gate[] | undefined {
  if (!templateGates) return existingGates;
  if (!existingGates) return templateGates;

  const templateGatesById = new Map(templateGates.map((gate) => [gate.id, gate]));
  const existingGateIds = new Set(existingGates.map((gate) => gate.id));
  const missingTemplateGates = templateGates.filter((gate) => !existingGateIds.has(gate.id));

  return existingGates
    .map((gate) => {
      const templateGate = templateGatesById.get(gate.id);
      if (!templateGate) return gate;

      const templateFieldsByName = new Map(
        (templateGate.fields ?? []).map((field) => [field.name, field])
      );
      const fields = (gate.fields ?? []).map((field) => {
        const templateField = templateFieldsByName.get(field.name);
        if (!templateField) return field;
        return { ...field, writers: templateField.writers };
      });

      // Skip copying template features if the existing gate already has a custom
      // script or poll, so feature-backed mechanisms do not silently override
      // custom gate logic at runtime. When copying is allowed, propagate the
      // template's features (including undefined when the template removed them).
      // Preserve existing codex_review_bot feature during transition to node-level
      // config so pre-existing workflows that relied on gate-level codex keep working.
      const shouldCopyFeatures = !gate.script && !gate.poll;
      let nextFeatures: Gate['features'] | undefined;
      if (shouldCopyFeatures) {
        if (templateGate.features) {
          nextFeatures = { ...templateGate.features };
        }
        if (hasEnabledGateFeature(gate, 'codex_review_bot')) {
          nextFeatures = { codex_review_bot: true, ...nextFeatures };
        }
      } else {
        nextFeatures = gate.features;
      }
      return {
        ...gate,
        fields,
        features: nextFeatures,
      };
    })
    .concat(missingTemplateGates);
}

/**
 * Fields that the built-in seeder re-stamps when it detects template drift
 * on an already-seeded row.
 *
 * - Node-level `postApproval`, `completionAutonomyLevel`, and `templateHash`
 *   are updated. The legacy workflow-level `postApproval` is cleared. Persisted
 *   node agent `customPrompt.value` is preserved except for known retired built-in
 *   prompt text, so daemon restart / startup seed passes cannot replace user-configured
 *   runtime prompts.
 * - Agent `toolGuards` are merged onto matching agent slots (by node name +
 *   agent name) so structural enforcement metadata stays in sync with the
 *   template when node + agent names still match. Other node fields
 *   (customPrompt, model, disabledSkillIds, etc.) are preserved. Template nodes
 *   missing from an existing workflow are appended so new terminal branches can
 *   land without replacing existing node IDs.
 * - Gate field `writers` are merged onto matching gate fields (by gate id +
 *   field name) so structural authorization changes land on pre-existing spaces.
 *   Gate `features` are copied from matching template gates so data-driven runtime
 *   checks land on pre-existing spaces. Missing template gates are appended.
 *   Existing checks, scripts, and gate topology remain untouched.
 * - Structural channel fields (maxCycles, label) are merged in-place onto channels matched by
 *   {from, to, gateId}, and missing template channels are appended so newly-added built-in
 *   branches become reachable on pre-existing spaces. This is how a raised cyclic cap (e.g.
 *   maxCycles 6 → 50) lands on pre-existing spaces instead of only newly-created ones. Like the
 *   other template-owned structural fields (completionAutonomyLevel, gate writers/features, node
 *   toolGuards, hooks), built-in channel maxCycles/label are template-managed: a user-customized
 *   value (editable via the visual editor) is reset to the template value when drift triggers a
 *   re-stamp — clone to a custom (non-re-stamped) workflow for a persistent custom cap. Template
 *   hooks are copied from the built-in template so hook-based runtime metadata lands during
 *   drift re-stamps. Existing channels, layout, and node rows are not regenerated. Workflow IDs, node IDs, and persisted node-agent slots
 *   are stable identifiers for in-flight runs, so template drift must never
 *   replace node rows. Agent `toolGuards` are updated in-place on existing node
 *   configs instead.
 */
const RESTAMP_FIELDS = [
  'legacy postApproval(clear)',
  'completionAutonomyLevel',
  'templateHash',
  'nodes(postApproval + toolGuards in-place + missing template nodes)',
  'gates(field writers + features in-place + missing template gates)',
  'channels(maxCycles + label in-place on matched channels + missing template channels)',
  'hooks(template hooks)',
] as const;

/**
 * Seeds all built-in workflow templates into the given space.
 *
 * Each template node agent's `agentId` placeholder (e.g., `'Planner'`, `'Coder'`,
 * `'General'`) is resolved to a real SpaceWorkerAgent UUID via `resolveAgentId`.
 * If any name cannot be resolved, this function throws — persisting a
 * placeholder string as an `agentId` would create broken workflow data.
 *
 * Idempotency & drift re-stamping:
 *   - If NO built-in workflow rows exist yet in this space, all seven templates
 *     are created from scratch.
 *   - If rows already exist that were seeded from a built-in template
 *     (matched via `templateName`), their stored `templateHash` is compared
 *     to the current template hash. On mismatch, the row is re-stamped
 *     with the narrow field set listed in {@link RESTAMP_FIELDS} — see the
 *     constant's doc-comment for details. Agent `toolGuards` are merged onto
 *     matching slots (preserving user-configured prompts). This is how new
 *     node-level `postApproval` routes and `toolGuards` land on pre-existing spaces.
 *   - Rows without a `templateName` (user-created workflows) are ignored.
 *
 * Individual workflow creation / re-stamp errors are captured per-workflow
 * and do not abort the remaining operations.
 *
 * `hasActiveRuns` (optional): a predicate returning whether a non-terminal
 * workflow run currently references the given workflow row. When it returns
 * true for a row, the re-stamp is DEFERRED for that row — the topology is left
 * byte-for-byte untouched so an in-flight run (reloaded by `run.workflowId`
 * on restart) does not resume against a graph whose retired nodes/tools were
 * just stripped. The stale hash re-triggers the re-stamp on a later pass once
 * the run is terminal. Omit it (or always return false) when no runs can
 * exist (e.g. seeding a fresh space).
 *
 * NOTE: This function must be called after preset SpaceWorkerAgent records have been
 * seeded (inside the `space.create` RPC handler).
 *
 * Example call site:
 * ```ts
 * const agents = spaceAgentManager.listBySpaceId(spaceId);
 * seedBuiltInWorkflows(spaceId, workflowManager, (name) =>
 *   agents.find(a => a.name.toLowerCase() === name.toLowerCase())?.id
 * );
 * ```
 */
export function seedBuiltInWorkflows(
  spaceId: string,
  workflowManager: SpaceWorkflowManager,
  resolveAgentId: (name: string) => string | undefined,
  hasActiveRuns?: (workflowId: string) => boolean
): SeedBuiltInWorkflowsResult {
  const templates = getBuiltInWorkflows();
  const templatesByName = new Map(templates.map((t) => [t.name, t]));
  let existing = workflowManager.listWorkflows(spaceId);
  const identityErrors: Array<{ name: string; error: string }> = [];

  // Rename pre-split legacy coding templates to their canonical merger identity.
  // `LEGACY_CODING_TEMPLATE_IDENTITIES` is the single source of truth shared with
  // `resolveBuiltInWorkflowTemplate`. Process EVERY row carrying a legacy
  // templateName: a space can hold duplicate legacy seeds (the condition the
  // duplicate-drift cleanup exists for), and renaming only the first (`find`)
  // would strand the rest under a name no built-in recognises —
  // `detectDuplicateDrift` filters out non-canonical templateNames, so they would
  // never group for cleanup.
  for (const identity of LEGACY_CODING_TEMPLATE_IDENTITIES) {
    const legacyRows = existing.filter((workflow) => workflow.templateName === identity.legacyName);
    if (legacyRows.length === 0) continue;
    const canonicalTemplate = templatesByName.get(identity.name);
    // The merger variants are no longer `default` (the stable Coding workflow
    // is). Strip a stale `default` tag from migrated rows so the deterministic
    // workflow fallback (selectDeterministicWorkflowFallback, which ranks
    // `default`-tagged workflows by updatedAt) does not pick the legacy merger
    // flow over the stable coder-owned flow.
    const canonicalIsDefault = (canonicalTemplate?.tags ?? []).includes('default');
    // Newest first: the dedup machinery keeps the newest row, so it gets the
    // full canonical identity. Older duplicates cannot take the (unique)
    // name/handle, but we still point their templateName at the canonical
    // template so they group under it for duplicate cleanup rather than being
    // stranded under the legacy name.
    const sorted = [...legacyRows].sort((a, b) => b.createdAt - a.createdAt);
    for (const row of sorted) {
      let migrated: SpaceWorkflow | null = row;
      // Apply the full canonical rename ONLY when the row still carries the
      // seeded legacy display name AND the seeded legacy handle. A user who
      // customized either (renamed the row, or kept the name but changed the
      // handle) keeps their value — the templateName-only stamp below writes
      // neither — so we repoint only templateName and the row still groups
      // under the canonical template for duplicate cleanup, without clobbering
      // the customization. (Same templateName-only fallback used below for
      // name/handle collisions.)
      const rowIsUnmodifiedSeed =
        row.name === identity.legacyName && row.handle === identity.legacyHandle;
      try {
        if (rowIsUnmodifiedSeed) {
          migrated = workflowManager.updateBuiltInIdentity(row.id, {
            name: identity.name,
            handle: identity.handle,
            templateName: identity.name,
          });
        } else {
          migrated = workflowManager.stampBuiltInTemplateName(row.id, identity.name);
        }
      } catch {
        // Name/handle clash (an older duplicate, or a user workflow already
        // holding the canonical name) — stamp templateName only so the row
        // still groups under the canonical template for dedup.
        try {
          migrated = workflowManager.stampBuiltInTemplateName(row.id, identity.name);
        } catch (innerErr) {
          migrated = null;
          identityErrors.push({
            name: identity.legacyName,
            error: innerErr instanceof Error ? innerErr.message : String(innerErr),
          });
        }
      }
      // Drop a stale `default` tag (best-effort — non-fatal if it fails).
      if (migrated && !canonicalIsDefault && (migrated.tags ?? []).includes('default')) {
        try {
          workflowManager.stampBuiltInTags(
            row.id,
            migrated.tags!.filter((tag) => tag !== 'default')
          );
        } catch {
          // Non-fatal: tag normalization does not block the migration.
        }
      }
    }
  }
  existing = workflowManager.listWorkflows(spaceId);

  const restamped: string[] = [];
  const errors: Array<{ name: string; error: string }> = [...identityErrors];

  // Re-stamp template-seeded rows whose stored hash no longer matches.
  if (existing.length > 0) {
    for (const row of existing) {
      if (!row.templateName) continue;
      const template = templatesByName.get(row.templateName);
      if (!template) continue;
      const expectedHash = computeWorkflowHash(template);
      if (row.templateHash === expectedHash) continue;

      // Defer the whole re-stamp while an active (non-terminal) workflow run
      // references this row: runtime recovery reloads the workflow by
      // run.workflowId, so mutating the topology under an in-flight run (e.g.
      // stripping the retired Post-Approval merger node) would leave it resuming
      // against a graph that no longer contains its active worker and it could
      // not finish. Leave the row byte-for-byte untouched; once the run
      // reaches a terminal state, the stale hash re-triggers this re-stamp and
      // the merge + strip run then.
      if (hasActiveRuns?.(row.id)) {
        // Keep the legacy node/agent identities so a live post-approval session
        // can resume, but migrate its exact retired merge contract away from the
        // removed merge_pr tool. This is deliberately narrower than restamping:
        // customized merger prompts/guards/routes remain byte-for-byte untouched.
        const templateNodesByName = new Map(template.nodes.map((node) => [node.name, node]));
        const nodes = row.nodes.map((node) => {
          const templateNode = templateNodesByName.get(node.name);
          const agents = node.agents.map((agent) => {
            const templateAgent = templateNode?.agents.find(
              (candidate) => candidate.name === agent.name
            );
            if (!templateAgent) return agent;
            const prompt = patchLegacyStableSlotPrompt(
              agent.customPrompt?.value,
              templateAgent.customPrompt?.value,
              node.name,
              agent.name
            );
            return prompt === agent.customPrompt?.value
              ? agent
              : { ...agent, customPrompt: prompt === undefined ? undefined : { value: prompt } };
          });
          if (node.name !== RETIRED_POST_APPROVAL_NODE) {
            return JSON.stringify(agents) === JSON.stringify(node.agents)
              ? node
              : { ...node, agents };
          }
          const merger = agents.find((agent) => RETIRED_MERGER_SLOT_NAMES.has(agent.name));
          if (
            !merger ||
            merger.customPrompt?.value !== RETIRED_PR_MERGER_SLOT_PROMPT ||
            merger.model !== undefined ||
            merger.thinkingLevel !== undefined ||
            merger.replaceAgentPrompt === true ||
            merger.disabledSkillIds !== undefined ||
            merger.extraMcpServers !== undefined ||
            merger.resetContextPerTurn !== undefined ||
            JSON.stringify(merger.toolGuards) !==
              JSON.stringify([RETIRED_MERGER_RAW_MERGE_GUARD]) ||
            node.postApproval?.targetAgent !== merger.name ||
            typeof node.postApproval.instructions !== 'string' ||
            createHash('sha256').update(node.postApproval.instructions).digest('hex') !==
              RETIRED_MERGE_INSTRUCTIONS_SHA256
          ) {
            return node;
          }
          return {
            ...node,
            agents: agents.map((agent) =>
              agent === merger
                ? {
                    ...agent,
                    customPrompt: { value: CODER_OWNED_MERGE_PROMPT },
                    toolGuards: undefined,
                  }
                : agent
            ),
            postApproval: {
              ...node.postApproval,
              instructions: CODER_OWNED_MERGE_INSTRUCTIONS,
            },
          };
        });
        if (JSON.stringify(nodes) !== JSON.stringify(row.nodes)) {
          workflowManager.updateWorkflow(row.id, { nodes });
        }
        builtInSeederLog.info(
          `deferred re-stamp of built-in workflow '${template.name}' (id=${row.id}) ` +
            `in space ${spaceId}: an active workflow run still references it`
        );
        continue;
      }

      try {
        // Targeted merge of structural template fields that must stay in sync while
        // preserving user-configurable prompts and workflow topology.
        const mergedNodes = mergeNodeStructuralFieldsFromTemplate(
          row.nodes,
          template.nodes,
          resolveAgentId
        );
        const existingChannels = removeLegacyPrReadyGateChannels(
          row.channels,
          template.nodes,
          row.nodes
        );
        const mergedChannels = mergeChannelsFromTemplate(
          existingChannels,
          template.channels,
          template.nodes,
          row.nodes
        );
        const mergedGates = mergeGateStructuralFieldsFromTemplate(row.gates, template.gates);
        const { nodes: migratedNodes, gates: migratedGates } = migrateCodexFeatureToNodeToggle(
          mergedNodes,
          mergedChannels ?? row.channels ?? [],
          mergedGates ?? row.gates ?? []
        );
        const removedLegacyPrReadyChannels =
          (existingChannels?.length ?? 0) !== (row.channels?.length ?? 0);
        const mergedHooks = mergeHooksFromTemplate(
          template.hooks,
          template.nodes,
          migratedNodes,
          row.hooks
        );
        // The merge helpers above only ADD missing template pieces — they never
        // drop nodes/channels/hooks/gates the stored row still has but the
        // template no longer does. Strip the retired Post-Approval merger node,
        // its channels, and any Post-Approval hooks so restamp converges to the
        // stable 2-node / 3-node coder-owned graph.
        const stripped = stripRetiredPostApproval({
          templateName: template.name,
          nodes: migratedNodes,
          channels: mergedChannels,
          hooks: mergedHooks,
        });
        // mergeChannelsFromTemplate propagates structural fields (maxCycles,
        // label) in-place on matched channels in addition to appending any
        // missing template channels. Detect whether the merge changed anything
        // — added channels OR updated structural fields — so the result is
        // persisted even when the channel count is unchanged (e.g. raising a
        // cyclic cap 6 → 50 on an already-seeded workflow). channelsChanged
        // subsumes the new-channel and legacy-removal cases;
        // stripped.channelsChanged covers the Validation Complete strip above.
        const channelsChanged =
          removedLegacyPrReadyChannels ||
          JSON.stringify(mergedChannels) !== JSON.stringify(existingChannels);
        const writeChannels = channelsChanged || stripped.channelsChanged;

        // Stamp the hash of the ACTUALLY-merged row, then advance the stored
        // hash ONLY when the merge fully converged the row to the current
        // template (mergedHash === expectedHash). The merge above reconciles
        // structural fields (nodes, channels, gates, hooks, post-approval,
        // autonomy) and patches prompts that match known retired template text,
        // but it deliberately preserves genuine user prompts, description, and
        // instructions. If those still differ from the template, stamping
        // `expectedHash` would falsely claim the row is fully up-to-date,
        // collapse `updateAvailable` to false, and permanently hide the
        // remaining template update (the matching hash skips the row on every
        // later restart). Preserving the prior (stale) hash keeps the row
        // honestly flagged "not up to date" so drift detection still surfaces a
        // sync action — and because the merged content now differs from that
        // prior hash, the row also reads as customized, routing the apply
        // through review so a preserved edit isn't silently lost. This
        // generalizes the per-channel maxCycles merge philosophy above
        // (reconcile the field, then let the stamped hash reflect reality).
        const mergedHash = computeWorkflowHash({
          ...row,
          nodes: stripped.nodes,
          gates: migratedGates,
          // computeWorkflowHash treats null/undefined identically (?? [], truthy
          // check), so normalizing to undefined just satisfies the SpaceWorkflow
          // shape — the hashed value matches the persisted row either way.
          hooks: stripped.hooks ?? undefined,
          channels: writeChannels ? stripped.channels : row.channels,
          completionAutonomyLevel: template.completionAutonomyLevel,
          postApproval: undefined,
        });
        const stampedHash = mergedHash === expectedHash ? expectedHash : row.templateHash;

        workflowManager.updateWorkflow(row.id, {
          completionAutonomyLevel: template.completionAutonomyLevel,
          // Built-ins now store routes on terminal nodes. Clear any legacy
          // workflow-level value while the node updater writes node routes.
          postApproval: null,
          gates: migratedGates,
          hooks: stripped.hooks ?? null,
          nodes: stripped.nodes,
          ...(writeChannels ? { channels: stripped.channels } : {}),
          templateHash: stampedHash,
        });
        restamped.push(template.name);
        builtInSeederLog.info(
          `re-stamped built-in workflow '${template.name}' (id=${row.id}) ` +
            `in space ${spaceId}: fields=${RESTAMP_FIELDS.join(',')}`
        );
      } catch (err) {
        errors.push({
          name: template.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Create canonical templates missing from either a fresh or an existing space.
  const installedTemplateNames = new Set(
    workflowManager
      .listWorkflows(spaceId)
      .map((workflow) => workflow.templateName)
      .filter((name): name is string => !!name)
  );
  const templatesToCreate = templates.filter(
    (template) => !installedTemplateNames.has(template.name)
  );
  if (templatesToCreate.length === 0) {
    return {
      seeded: [],
      restamped,
      errors,
      skipped: restamped.length === 0 && errors.length === 0,
    };
  }

  // Create missing templates.
  //
  // Pre-validate: resolve every agent name needed across ALL templates before
  // persisting anything. This guarantees all-or-nothing behaviour.
  const neededNames = new Set<string>();
  for (const template of templatesToCreate) {
    for (const node of template.nodes) {
      for (const agent of node.agents) {
        if (agent.agentId) neededNames.add(agent.agentId);
      }
    }
  }
  const resolvedIds = new Map<string, string>();
  for (const agentName of neededNames) {
    const agentId = resolveAgentId(agentName);
    if (!agentId) {
      throw new Error(
        `seedBuiltInWorkflows: no SpaceWorkerAgent found with name '${agentName}' in space '${spaceId}'. ` +
          `Preset agents must be seeded before calling seedBuiltInWorkflows.`
      );
    }
    resolvedIds.set(agentName, agentId);
  }

  // All names resolved — safe to persist.
  const seeded: string[] = [];

  for (const template of templatesToCreate) {
    try {
      // Assign real UUIDs to template node IDs
      const nodeIdMap = new Map<string, string>(); // templateId -> realUUID
      for (const node of template.nodes) {
        nodeIdMap.set(node.id, generateUUID());
      }

      const nodes = template.nodes.map((s) => ({
        id: nodeIdMap.get(s.id)!,
        name: s.name,
        agents: s.agents.map((a) => ({
          ...a,
          agentId: resolvedIds.get(a.agentId)!,
        })),
        ...(s.postApproval ? { postApproval: { ...s.postApproval } } : {}),
        ...(s.requireCodexApproval ? { requireCodexApproval: true } : {}),
      }));

      const startNodeId = nodeIdMap.get(template.startNodeId);
      if (!startNodeId) {
        throw new Error(
          `seedBuiltInWorkflows: template '${template.name}' has invalid startNodeId '${template.startNodeId}'.`
        );
      }

      if (!template.endNodeId) {
        throw new Error(
          `seedBuiltInWorkflows: template '${template.name}' is missing required endNodeId.`
        );
      }
      const endNodeId = nodeIdMap.get(template.endNodeId);
      if (!endNodeId) {
        throw new Error(
          `seedBuiltInWorkflows: template '${template.name}' has invalid endNodeId '${template.endNodeId}'.`
        );
      }

      workflowManager.createWorkflow({
        spaceId,
        name: template.name,
        description: template.description,
        nodes,
        startNodeId,
        endNodeId,
        tags: [...template.tags],
        // Assign UUIDs to channels that don't have IDs — WorkflowCanvas filters
        // channels without an id (ch.id must be truthy) so they would be invisible.
        channels: template.channels
          ? template.channels.map((ch) => ({ ...ch, id: ch.id ?? generateUUID() }))
          : undefined,
        gates: template.gates ? [...template.gates] : undefined,
        hooks: template.hooks ? [...template.hooks] : undefined,
        layout: template.layout
          ? Object.fromEntries(
              Object.entries(template.layout).map(([templateNodeId, position]) => [
                nodeIdMap.get(templateNodeId) ?? templateNodeId,
                position,
              ])
            )
          : undefined,
        completionAutonomyLevel: template.completionAutonomyLevel,
        // Pin the canonical handle so it is stable even if the name is later reworded.
        ...(template.handle ? { handle: template.handle } : {}),
        templateName: template.name,
        templateHash: computeWorkflowHash(template),
      });

      seeded.push(template.name);
    } catch (err) {
      errors.push({
        name: template.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { seeded, restamped, errors, skipped: false };
}
