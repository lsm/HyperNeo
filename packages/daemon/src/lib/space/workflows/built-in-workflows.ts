/**
 * Built-in Workflow Templates
 *
 * Defines the canonical workflow templates bundled with NeoKai.
 * These serve as defaults and examples for Space users.
 *
 * Design notes:
 * - Leader is always implicit in SpaceRuntime — never a workflow node.
 * - Templates use placeholder `id` / `spaceId` (empty strings) and role names
 *   as `agentId` placeholders ('planner', 'coder', 'general'). These are
 *   replaced with real SpaceAgent UUIDs by `seedBuiltInWorkflows`.
 * - Workflows use gated channels for inter-agent communication (agent-centric
 *   model). Transitions are empty for agent-centric workflows; completion is
 *   detected when all agents report done.
 * - At Space creation time, preset SpaceAgent records are seeded for each
 *   BuiltinAgentRole. `seedBuiltInWorkflows` must be called after those agents
 *   exist so that the `agentId` values resolve correctly.
 * - Channels use node names (e.g. 'Plan', 'Coding') in `from`/`to` so they
 *   resolve correctly at runtime without UUID translation in the seeder.
 *   `resolveChannels()` matches node names via the `nodeNameToAgents` lookup.
 */

import type {
  DeclarativeToolGuard,
  WorkflowNodeAgentOverride,
  GateField,
  GateScript,
  Gate,
  SpaceWorkflow,
  WorkflowChannel,
  WorkflowNode,
} from '@neokai/shared';
import { generateUUID, resolveNodeAgents, hasEnabledGateFeature } from '@neokai/shared';
import { Logger } from '../../logger';
import { isApprovalGate } from '../runtime/gate-features';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';
import { QA_SYSTEM_CONTRACT } from '../agents/system-contracts.ts';
import { PR_MERGE_POST_APPROVAL_INSTRUCTIONS } from './post-approval-merge-template.ts';
import { computeWorkflowHash } from './template-hash.ts';
import { migrateWorkflowGateProgressionToHooks } from './workflow-migration.ts';

// ---------------------------------------------------------------------------
// Declarative tool guard: prevent coder agents from merging PRs
// ---------------------------------------------------------------------------

const CODER_NO_MERGE_GUARD: DeclarativeToolGuard = {
  matcher: 'Bash',
  // Matches `gh pr merge` in all common shell forms:
  // - Direct: gh pr merge ...
  // - Leading whitespace:   gh pr merge ...
  // - After separators: ; gh pr merge | gh pr merge && gh pr merge
  // - Subshell: $(gh pr merge) `gh pr merge`
  // - Env prefix: GH_TOKEN=... gh pr merge
  // - command builtin: command gh pr merge
  // - env wrapper: env GH_TOKEN=... gh pr merge
  // - Line continuation: gh pr \<newline>merge
  pattern:
    '(?:^|[;&|()\\n`])\\s*(?:(?:env\\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=[^\\s;&|()`]+|command)\\s+)*gh[\\s\\\\]+pr[\\s\\\\]+merge\\b',
  decision: 'deny',
  reason:
    'Coder-role agents must not merge PRs. Their job is implementation only; the reviewer handles the merge after approval.',
};

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
// Template node ID constants (used as stable IDs for workflow nodes and startNodeId)
// ---------------------------------------------------------------------------

const CODING_CODE_NODE = 'tpl-coding-code';
const CODING_REVIEW_NODE = 'tpl-coding-review';
const CODING_VALIDATION_NODE = 'tpl-coding-validation';

// Plan & Decompose node IDs
const PD_PLANNING_NODE = 'tpl-pd-planning';
const PD_PLAN_REVIEW_NODE = 'tpl-pd-plan-review';
const PD_TASK_DISPATCHER_NODE = 'tpl-pd-task-dispatcher';

const FULLSTACK_CODING_NODE = 'tpl-fullstack-coding';
const FULLSTACK_REVIEW_NODE = 'tpl-fullstack-review';
const FULLSTACK_QA_NODE = 'tpl-fullstack-qa';

const VALIDATION_NO_CHANGES_BASH_SCRIPT = [
  'if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then',
  '  echo "Workspace is not a git worktree; cannot verify validation-only no-change handoff" >&2',
  '  exit 1',
  'fi',
  'if [ -n "$(git status --porcelain=v1 2>/dev/null)" ]; then',
  '  echo "Validation-only handoff requires a clean worktree; code changes or untracked files are present" >&2',
  '  git status --short >&2 || true',
  '  exit 1',
  'fi',
  'BASE_REF="${VALIDATION_BASE_REF:-${NEOKAI_VALIDATION_BASE_REF:-origin/dev}}"',
  'if ! git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then',
  '  BASE_REF=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed "s#^origin/##" | sed "s#^#origin/#")',
  'fi',
  'if [ -z "$BASE_REF" ] || ! git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then',
  '  echo "Unable to resolve validation base ref (tried VALIDATION_BASE_REF, NEOKAI_VALIDATION_BASE_REF, origin/dev, origin/HEAD)" >&2',
  '  exit 1',
  'fi',
  'if ! MERGE_BASE=$(git merge-base HEAD "$BASE_REF^{}" 2>/dev/null); then',
  '  echo "Unable to compute merge-base against validation base ref $BASE_REF" >&2',
  '  exit 1',
  'fi',
  'if [ -n "$(git diff --name-only "$MERGE_BASE"...HEAD 2>/dev/null)" ]; then',
  '  echo "Validation-only handoff requires no committed changes against $BASE_REF" >&2',
  '  git diff --stat "$MERGE_BASE"...HEAD >&2 || true',
  '  exit 1',
  'fi',
  'jq -n --arg mode "validation_only" --argjson changed_files 0 \'{"completion_mode":$mode,"changed_files":$changed_files}\'',
].join('\n');

/**
 * Review-posted gate script.
 *
 * Verifies that the Reviewer has actually posted review evidence on the PR
 * since the workflow run started. This gate guards the Review → Coding feedback
 * channel: the runtime refuses to deliver a "changes requested" message until
 * a formal review or at least one PR comment is visible on GitHub.
 *
 * Primary check: formal GitHub review (gh pr review / pulls/{n}/reviews)
 * with APPROVED or CHANGES_REQUESTED state.
 * Own-PR fallback: COMMENTED reviews or PR conversation comments since workflow
 * start. GitHub blocks APPROVE/REQUEST_CHANGES on your own PR, so comment-only
 * evidence is accepted only when the authenticated GitHub user is the PR author.
 *
 * Environment variables:
 *   NEOKAI_GATE_DATA_JSON       — current gate data; contains `pr_url` (PR URL, preferred)
 *                                 and `review_url` (review permalink, fallback)
 *   NEOKAI_WORKFLOW_START_ISO   — ISO8601 timestamp of workflowRun.createdAt,
 *                                 injected by the gate script runner
 */
const REVIEW_POSTED_BASH_SCRIPT = [
  'PR_URL=$(jq -r \'.pr_url // .review_url // empty\' <<< "${NEOKAI_GATE_DATA_JSON:-{}}" 2>/dev/null || true)',
  'if [ -z "$PR_URL" ]; then',
  '  PR_URL=$(gh pr view --json url -q .url 2>/dev/null || true)',
  'fi',
  'if [ -z "$PR_URL" ]; then',
  '  echo "No PR URL available to verify review" >&2',
  '  exit 1',
  'fi',
  'START_ISO="${NEOKAI_WORKFLOW_START_ISO:-}"',
  'if [ -z "$START_ISO" ]; then',
  '  echo "NEOKAI_WORKFLOW_START_ISO not injected — cannot determine review window" >&2',
  '  exit 1',
  'fi',
  'if ! PR_JSON=$(gh pr view "$PR_URL" --json reviews,comments,author); then',
  '  echo "Failed to fetch review evidence for ${PR_URL}" >&2',
  '  exit 1',
  'fi',
  'FORMAL_REVIEW_COUNT=$(jq --arg since "$START_ISO" \'[.reviews[] | select(.submittedAt > $since) | select(.state == "APPROVED" or .state == "CHANGES_REQUESTED")] | length\' <<< "$PR_JSON")',
  'if [ "$FORMAL_REVIEW_COUNT" != "0" ] && [ -n "$FORMAL_REVIEW_COUNT" ]; then',
  '  jq -n --arg url "$PR_URL" --argjson n "$FORMAL_REVIEW_COUNT" \'{"pr_url":$url,"review_count":$n,"review_evidence":"formal_review"}\'',
  '  exit 0',
  'fi',
  'AUTHOR_LOGIN=$(jq -r \'.author.login // empty\' <<< "$PR_JSON")',
  'VIEWER_LOGIN=$(gh api user --jq .login 2>/dev/null || true)',
  'if [ -z "$AUTHOR_LOGIN" ] || [ -z "$VIEWER_LOGIN" ] || [ "$AUTHOR_LOGIN" != "$VIEWER_LOGIN" ]; then',
  '  echo "No APPROVED or CHANGES_REQUESTED review found on ${PR_URL} since workflow start (${START_ISO}); comment-only evidence is accepted only for own PRs" >&2',
  '  exit 1',
  'fi',
  'COMMENT_REVIEW_COUNT=$(jq --arg since "$START_ISO" \'[.reviews[] | select(.submittedAt > $since) | select(.state == "COMMENTED")] | length\' <<< "$PR_JSON")',
  'PR_COMMENT_COUNT=$(jq --arg since "$START_ISO" \'[.comments[] | select(.createdAt > $since)] | length\' <<< "$PR_JSON")',
  'COMMENT_COUNT=$((COMMENT_REVIEW_COUNT + PR_COMMENT_COUNT))',
  'if [ "$COMMENT_COUNT" = "0" ]; then',
  '  echo "No review or PR comment found on own PR ${PR_URL} since workflow start (${START_ISO})" >&2',
  '  exit 1',
  'fi',
  'jq -n --arg url "$PR_URL" --argjson n "$COMMENT_COUNT" \'{"pr_url":$url,"review_count":$n,"review_evidence":"own_pr_comment"}\'',
].join('\n');

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
  'before closing or handing off. Use `gh api repos/{owner}/{repo}/issues/{number}/reactions` ' +
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
  'Procedure: read `gh pr diff`/`gh pr view`, post a visible PR review comment, then ' +
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
  '5. Call `save_artifact({ type: "result", append: true, summary: "Created N tasks from plan: <short list>", ' +
  'created_task_ids: [<ids>], stack_prefix: "<prefix>", ' +
  'stack_branches: ["plan/<prefix>/<item-1-slug>", "plan/<prefix>/<item-2-slug>", ...] })` to record the dispatch audit entry.\n' +
  '6. Call `approve_task()` as your final action. If autonomy blocks self-close, call ' +
  '`submit_for_approval({ reason: "..." })` instead.\n\n' +
  'CRITICAL: Do NOT create branches, make commits, push to git, or open PRs yourself — ' +
  "that is the downstream coder's job. Do NOT implement the work items yourself. " +
  'Do NOT create fewer tasks than the plan requires. ' +
  'If the plan is empty or ambiguous, send feedback to Planning before closing the task.';

const REVIEW_THREAD_RESOLUTION_GUIDANCE =
  'After pushing fixes for review feedback, resolve ALL open GitHub review conversation ' +
  'threads — including those where you disagree with the reviewer. First reply with your ' +
  'reasoning, then resolve the thread with the `resolveReviewThread` mutation. The ' +
  'PR-ready hook blocks on any unresolved thread, so leaving one open creates a deadlock. ' +
  'If the reviewer disagrees with your reasoning, they can re-open the thread. ' +
  'Use `gh api graphql` to verify no unresolved review conversations remain before ' +
  'sending a message to Review again. ' +
  'Never set a PR to auto-merge — auto-merge is not allowed.';

const REVIEW_THREAD_APPROVAL_CHECK_GUIDANCE =
  'Verify the PR is still open, mergeable, and has no unresolved GitHub review ' +
  'conversations. Use `gh api graphql` to inspect `reviewThreads` and confirm every ' +
  'thread has `isResolved: true`; if unresolved conversations remain, request the ' +
  'author to resolve them instead of approving. Never set a PR to auto-merge — ' +
  'auto-merge is not allowed.';

const FULLSTACK_CODING_PROMPT =
  'You are the Coder in a Fullstack QA Loop workflow. You implement backend + frontend changes, ' +
  'write tests, and keep one PR updated across review and QA cycles.\n\n' +
  'When implementation is ready, ensure the PR is open and mergeable, then call `send_message` ' +
  'to the review target with `data: { pr_url: "<url>" }`. Use the current ' +
  'target and required data fields from the Runtime Execution Contract injected into your task ' +
  'prompt. `save_artifact` alone is insufficient; only `send_message` triggers the hook-validated ' +
  'handoff. Coding is not the end node — the task-completion tools (`approve_task`, ' +
  '`submit_for_approval`) are not available to you.\n\n' +
  REVIEW_THREAD_RESOLUTION_GUIDANCE;

const FULLSTACK_REVIEW_PROMPT =
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
  'Never set a PR to auto-merge.';

const FULLSTACK_QA_PROMPT =
  QA_SYSTEM_CONTRACT +
  '\n\nYou are the QA node in a Fullstack QA Loop workflow. Validate the reviewer-approved PR. ' +
  'If QA fails, send detailed failures and repro steps to Coding, save a failed result artifact, ' +
  'and stop. If all green, save a passing result artifact with pr_url in data, then call ' +
  'approve_task (or submit_for_approval if autonomy blocks self-close). Do not merge or set auto-merge.';

const RESEARCH_RESEARCH_NODE = 'tpl-research-research';
const RESEARCH_REVIEW_NODE = 'tpl-research-review';

const REVIEW_REVIEW_NODE = 'tpl-review-review';

// ---------------------------------------------------------------------------
// Built-in templates
// ---------------------------------------------------------------------------

/**
 * Coding Workflow
 *
 * Two-node iterative graph: Coding ↔ Review (with cycle).
 * - Coding → Review: validated by a `send_message` hook (`pr_ready`) that checks
 *   the PR is open, mergeable, and has no unresolved review threads.
 * - Coding → Validation Complete: gated by `validation-complete-gate` — accepts
 *   no-code-change validation evidence (`completion_mode: "validation_only"`,
 *   `changed_files: 0`, `validation_outcome`) and bypasses PR validation.
 * - Review → Coding: ungated — Reviewer sends back for changes without any gate.
 *   Review approval records PR evidence; validation-only approval records validation
 *   evidence. Either terminal node can close the task.
 */
export const CODING_WORKFLOW: SpaceWorkflow = {
  id: '',
  spaceId: '',
  name: 'Coding Workflow',
  handle: 'coding-workflow',
  description:
    'Iterative coding workflow with Coding ↔ Review loop. Engineer implements and opens a PR; Reviewer reviews and either requests changes or signals completion.',
  nodes: [
    {
      id: CODING_CODE_NODE,
      name: 'Coding',
      agents: [
        {
          agentId: 'Coder',
          name: 'coder',
          customPrompt: {
            value:
              'You are a software engineer in a Coding→Review iterative workflow. Your job is implementation only: ' +
              'implement the task, write tests, commit your changes, and open a pull request. ' +
              'Do NOT merge PRs. When the reviewer approves, your work is done. ' +
              'The reviewer handles the merge.\n\n' +
              'Steps:\n' +
              '1. Read and understand the task requirements\n' +
              '2. Implement the changes with logical, well-described commits\n' +
              '3. Write or update tests to cover new behavior\n' +
              '4. Run the test suite and fix any failures\n' +
              '5. If code changed: open a PR with `gh pr create` — include a clear title and description\n' +
              '6. If code changed: hand off by calling `send_message` to the review target ' +
              'with `data: { pr_url: "<url>" }`. Use the current target and required data ' +
              'fields from the Runtime Execution Contract injected into your task prompt. ' +
              '`save_artifact` alone is insufficient; only `send_message` triggers the ' +
              'hook-validated handoff. Always include the PR URL data field on every ' +
              '`send_message` handoff — the hook validates every cycle, so even on round 2+ ' +
              'you must re-supply it.\n' +
              '7. If the task is validation-only and produced no code changes: do NOT create an empty commit or PR. ' +
              'Instead, call `save_artifact({ type: "result", append: true, summary: "<validation outcome>", data: { completion_mode: "validation_only", changed_files: 0, validation_outcome: "<passed|failed + evidence>" } })`, then ' +
              '`send_message(target="Validation Complete", message="<short outcome>", data: { completion_mode: "validation_only", changed_files: 0, validation_outcome: "<outcome>" })`. ' +
              'That validation-only handoff bypasses the PR-ready hook and closes the task without `pr_url`.\n\n' +
              'If re-activated after review:\n' +
              '1. Read the incoming message `data` — you should find `review_url` and ' +
              '`comment_urls` (an array of comment thread URLs). Open each one; do not rely on ' +
              'a summary.\n' +
              '2. For each comment: evaluate critically — do not blindly accept feedback. Verify ' +
              'against the code and the task requirements. The Reviewer can be wrong.\n' +
              '3. For valid items: make the fix, then reply to that specific thread via ' +
              '`gh api repos/{owner}/{repo}/pulls/{n}/comments/{comment_id}/replies -f body="<ack>"` ' +
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
          },
          toolGuards: [CODER_NO_MERGE_GUARD],
        },
      ],
    },
    {
      id: CODING_VALIDATION_NODE,
      name: 'Validation Complete',
      agents: [
        {
          agentId: 'Coder',
          name: 'validator',
          customPrompt: {
            value:
              'You are the terminal validation-only completion agent in a Coding workflow. This node is only for tasks that produced no code changes: diagnostics, trace validation, manual checks, or other verification work.\n\nYour job is to verify the upstream coder recorded a result artifact with validation evidence, then close the task. Do NOT create commits, branches, or PRs. Do NOT merge anything.\n\nChecklist:\n1. Read the incoming message and list_artifacts({ type: "result" })\n2. Confirm the result artifact says `completion_mode: "validation_only"`, `changed_files: 0`, and includes a concrete validation outcome/evidence\n3. If evidence is missing or indicates code changes were made, send a message back to Coding explaining what is missing; do NOT approve\n4. If evidence is sufficient, call `save_artifact({ type: "result", append: true, summary: "Validation-only completion accepted: <outcome>", data: { completion_mode: "validation_only", changed_files: 0, validation_outcome: "<outcome>" } })`\n5. Call `approve_task({})` as your final action to mark the task done. No `pr_url` is required for this path.',
          },
          toolGuards: [CODER_NO_MERGE_GUARD],
        },
      ],
      postApproval: undefined,
    },
    {
      id: CODING_REVIEW_NODE,
      name: 'Review',
      agents: [
        {
          agentId: 'Reviewer',
          name: 'reviewer',
          customPrompt: {
            value:
              'You are the Reviewer in a Coding→Review iterative workflow. You review the work ' +
              'and either approve it or request changes.\n\n' +
              'You share the same worktree as the engineer — review the codebase as a whole, ' +
              'not just the PR diff. Read related files, check for issues the diff ' +
              'might not surface (e.g. callers of changed functions, integration points).\n' +
              '- All feedback MUST be posted to the PR on GitHub — not just summarized in your ' +
              'response. Use the Reviewer System Contract GitHub review procedure.\n' +
              '- The Review → Coding handoff runs a hook that checks GitHub for a fresh review ' +
              'before releasing your message. If you skip `gh pr review`, the hook will block ' +
              'and the coder will never hear from you.\n\n' +
              reviewerFeedbackProcedure('Coding') +
              'Use save_artifact every cycle. Nest pr_url inside artifact data for post-approval dispatch.\n\n' +
              'Review checklist: inspect PR diff and related worktree context, run tests if uncertain, ' +
              'post visible GitHub review before sending feedback. If changes needed, include pr_url, ' +
              'review_url, and comment_urls when messaging Coding. If approved, ' +
              REVIEW_THREAD_APPROVAL_CHECK_GUIDANCE +
              ' Call save_artifact({ type: "result", data: { pr_url: "<url>" } }) then approve_task() or submit_for_approval. ' +
              'Do NOT attempt to merge the PR yourself. Do not set auto-merge.',
          },
        },
      ],
      // After this node approves, spawn a fresh reviewer session that runs
      // the PR merge using the shared post-approval merge instructions.
      postApproval: {
        targetAgent: 'reviewer',
        instructions: PR_MERGE_POST_APPROVAL_INSTRUCTIONS,
      },
    },
  ],
  startNodeId: CODING_CODE_NODE,
  endNodeId: CODING_REVIEW_NODE,
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
      id: 'validation-complete-gate',
      label: 'Validated',
      description:
        'Validation-only task produced no code changes and recorded completion evidence.',
      fields: [
        {
          name: 'completion_mode',
          type: 'string',
          writers: ['Coding', 'coder'],
          check: { op: '==', value: 'validation_only' },
        },
        {
          name: 'changed_files',
          type: 'number',
          writers: ['Coding', 'coder'],
          check: { op: '==', value: 0 },
        },
        {
          name: 'validation_outcome',
          type: 'string',
          writers: ['Coding', 'coder'],
          check: { op: 'exists' },
        },
      ],
      script: {
        interpreter: 'bash',
        source: VALIDATION_NO_CHANGES_BASH_SCRIPT,
        timeoutMs: 30000,
      },
      resetOnCycle: true,
    },
    {
      id: 'review-posted-gate',
      label: 'Review Posted',
      description:
        'Reviewer has posted a GitHub review or PR comment since the workflow started. ' +
        'Accepts a formal review (via `gh pr review`) as primary evidence; falls back to ' +
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
      script: {
        interpreter: 'bash',
        source: REVIEW_POSTED_BASH_SCRIPT,
        timeoutMs: 30000,
      },
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
      from: 'Coding',
      to: 'Validation Complete',
      gateId: 'validation-complete-gate',
      label: 'Coding → Validation Complete (no code changes)',
    },
    {
      from: 'Validation Complete',
      to: 'Coding',
      gateId: 'validation-complete-gate',
      maxCycles: 5,
      label: 'Validation Complete → Coding (evidence missing)',
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
              '5. Commit findings and open a PR with `gh pr create`\n' +
              '6. Hand off to Review by calling `send_message(target="Review", message="<short summary>", data: { pr_url: "<PR url>" })`. ' +
              'The hook validates the PR is open and mergeable before Review activates. ' +
              'Always re-supply `data: { pr_url }` on every send — the hook runs on every send.\n\n' +
              'If re-activated after review feedback: address each point, expand research where requested, ' +
              'update the documents, and push new commits. ' +
              REVIEW_THREAD_RESOLUTION_GUIDANCE,
          },
        },
      ],
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
              'Use save_artifact every cycle. Nest pr_url inside artifact data for post-approval dispatch.\n\n' +
              'Review checklist: read all research docs in the PR, verify completeness, evidence, ' +
              'accuracy, and clarity. If more research is needed, message Research with specific ' +
              'areas to investigate and stop. If satisfied, post approval review, ' +
              REVIEW_THREAD_APPROVAL_CHECK_GUIDANCE +
              ' Call save_artifact({ type: "result", data: { pr_url: "<url>" } }) then approve_task() or submit_for_approval. ' +
              'Do NOT attempt to merge the PR yourself. Do not set auto-merge.',
          },
        },
      ],
      // After this node approves, spawn a fresh reviewer session that runs
      // the PR merge using the shared post-approval merge instructions.
      postApproval: {
        targetAgent: 'reviewer',
        instructions: PR_MERGE_POST_APPROVAL_INSTRUCTIONS,
      },
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
              'contract: post a visible GitHub review (`gh pr review`) before terminal actions; ' +
              'call save_artifact({ type: "result", data: { pr_url: "<url>" } }) to save a result artifact, then approve_task() or submit_for_approval only on APPROVE, otherwise stop. ' +
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
 * and calls `save_artifact({ type: 'result', append: true, created_task_ids })`
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
              'then save_artifact({ type: "result", append: true, created_task_ids: [...] }).\n\n' +
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
 */
export const FULLSTACK_QA_LOOP_WORKFLOW: SpaceWorkflow = {
  id: '',
  spaceId: '',
  name: 'Coding with QA Workflow',
  handle: 'coding-with-qa-workflow',
  description:
    'Coder ↔ Reviewer loop with explicit QA validation before completion. ' +
    'Designed for backend+frontend changes that require thorough test coverage, including browser tests.',
  nodes: [
    {
      id: FULLSTACK_CODING_NODE,
      name: 'Coding',
      agents: [
        {
          agentId: 'Coder',
          name: 'coder',
          customPrompt: {
            value:
              FULLSTACK_CODING_PROMPT +
              '\n\n' +
              'Expected inputs: Task description and review/QA feedback from prior loops.\n' +
              'Expected outputs: Updated implementation in an open, mergeable PR.\n\n' +
              'Steps:\n' +
              '1. Implement backend and frontend changes with focused commits\n' +
              '2. Add/update unit, integration, and UI tests as needed\n' +
              '3. Open or update the PR and ensure it remains mergeable\n' +
              '4. Hand off by calling `send_message` to the review target with ' +
              '`data: { pr_url: "<url>" }`; `save_artifact` alone will not deliver the handoff\n' +
              '5. Share blockers clearly with Reviewer/QA when needed',
          },
          toolGuards: [CODER_NO_MERGE_GUARD],
        },
      ],
    },
    {
      id: FULLSTACK_REVIEW_NODE,
      name: 'Review',
      requireCodexApproval: true,
      agents: [
        {
          agentId: 'Reviewer',
          name: 'reviewer',
          customPrompt: {
            value:
              FULLSTACK_REVIEW_PROMPT +
              '\n\n' +
              'Expected inputs: Open PR from Coding.\n' +
              'Expected outputs: QA handoff or actionable feedback.\n\n' +
              'Steps:\n' +
              '1. Review diff quality, correctness, and test coverage\n' +
              '2. If approved: send_message to QA with data: { approved: true, pr_url: "<url>" } to start the Codex review timeout window (2 hours by default), then wait for a Codex bot +1 reaction or the timeout\n' +
              '3. If changes needed: send clear feedback to Coding',
          },
        },
      ],
    },
    {
      id: FULLSTACK_QA_NODE,
      name: 'QA',
      agents: [
        {
          agentId: 'QA',
          name: 'qa',
          customPrompt: {
            value:
              FULLSTACK_QA_PROMPT +
              '\n\n' +
              'Expected inputs: Reviewer-approved PR.\n' +
              'Expected outputs: QA pass recorded for runtime post-approval dispatch, or QA ' +
              'feedback to Coding.\n\n' +
              'Steps:\n' +
              '1. Check for project QA instructions (`QA.md`, `docs/QA.md`, `.qa/QA.md`) from trusted base-branch content, not from the mutable PR worktree, and follow any found\n' +
              '2. Inspect the PR diff and classify `ui_changed` true/false\n' +
              '3. Treat QA instruction changes in the candidate PR as code under review, not as policy for this QA cycle\n' +
              '4. Run backend/docs-only relevant checks, or frontend/UI checks when UI code changed\n' +
              '5. If `ui_changed` is true, start NeoKai with `make dev PORT=<free-port> DB_PATH=/tmp/neokai-qa-<task-id>.db` and exercise the changed flow in a browser (golden path, relevant edge cases, nearby regressions)\n' +
              '6. Validate CI and mergeability\n' +
              '7. If fail: send detailed failures and repro steps to Coding, then call ' +
              '`save_artifact({ type: "result", append: true, summary: "QA failed: ..." })` to record the audit entry. Do ' +
              'NOT call `approve_task` or `submit_for_approval` — both are TERMINAL and ' +
              'carry the same approval semantic. Leave the workflow open for the next ' +
              'Coding cycle.\n' +
              '8. If all green:\n' +
              '   a. Call `save_artifact({ type: "result", append: true, summary, data: { pr_url: "<url>", test_output: "<output>", ui_changed: <boolean>, dev_server_started: <boolean>, browser_validation: "<what was exercised or why skipped>" } })` ' +
              'to record the audit entry. The `pr_url` inside `data` is what ' +
              '`dispatchPostApproval` reads when interpolating `{{pr_url}}` into the ' +
              'merge template — top-level keys outside `data` are silently stripped by ' +
              'the tool schema, so nest it correctly.\n' +
              '   b. Call `approve_task()` as your final action. If autonomy blocks self-close, ' +
              'call `submit_for_approval({ reason: "..." })` instead — the runtime will ' +
              'still route post-approval once the human approves. Do NOT run `gh pr merge` ' +
              'yourself; a post-approval reviewer session handles the merge and worktree ' +
              'sync after the task transitions to `approved`.',
          },
        },
      ],
      // After QA approves, spawn a fresh reviewer session that runs the PR
      // merge and worktree sync.
      postApproval: {
        targetAgent: 'reviewer',
        instructions: PR_MERGE_POST_APPROVAL_INSTRUCTIONS,
      },
    },
  ],
  startNodeId: FULLSTACK_CODING_NODE,
  endNodeId: FULLSTACK_QA_NODE,
  tags: ['fullstack', 'qa', 'browser-testing'],
  createdAt: 0,
  updatedAt: 0,
  // QA no longer merges the PR — the post-approval reviewer session does that.
  // Aligned with Coding's autonomy tier (3) since QA-approve is now a plain
  // "work is good" signal. Post-approval runs only after that approval has
  // already happened.
  completionAutonomyLevel: 3,
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
  ],
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
    [FULLSTACK_CODING_NODE]: { x: 80, y: 160 },
    [FULLSTACK_REVIEW_NODE]: { x: 420, y: 80 },
    [FULLSTACK_QA_NODE]: { x: 760, y: 160 },
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
      maxCycles: 6,
      label: 'Review → Coding (feedback)',
    },
    {
      from: 'QA',
      to: 'Coding',
      maxCycles: 6,
      label: 'QA → Coding (issues found)',
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
  const template = [
    CODING_WORKFLOW,
    PLAN_AND_DECOMPOSE_WORKFLOW,
    FULLSTACK_QA_LOOP_WORKFLOW,
    RESEARCH_WORKFLOW,
    REVIEW_ONLY_WORKFLOW,
  ].find((t) => t.name === templateName);
  if (!template) return undefined;
  const gate = (template.gates ?? []).find((g) => g.id === gateId);
  return gate?.script;
}

/**
 * Returns all built-in workflow templates.
 *
 * The returned objects have empty `id` and `spaceId` fields and use role names
 * (e.g., `'planner'`, `'coder'`, `'general'`) as `agentId` placeholders.
 * They are templates, not persisted entities. Call `seedBuiltInWorkflows`
 * to persist them with real worker agent IDs for a given space.
 */
export function getBuiltInWorkflows(): SpaceWorkflow[] {
  // CODING_WORKFLOW is first so it becomes the default workflow selected by
  // spaceWorkflowRun.start (which picks workflows[0] ordered by created_at ASC).
  // It is tagged `default` and covers the most common case — a single implementation
  // task with one engineer and one reviewer.
  //
  // PLAN_AND_DECOMPOSE_WORKFLOW is tagged `planning` / `decomposition` (NOT `default`)
  // so the LLM picks it explicitly for multi-task goals that should be broken down
  // before coding starts.
  //
  // Note: this ordering only affects *newly created* spaces. seedBuiltInWorkflows is
  // insert-only (it skips if any workflows already exist), so existing spaces keep
  // whatever ordering was seeded when they were first created.
  const workflows = [
    CODING_WORKFLOW,
    PLAN_AND_DECOMPOSE_WORKFLOW,
    FULLSTACK_QA_LOOP_WORKFLOW,
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
      customPrompt?: WorkflowNodeAgentOverride;
    }
  >();
  for (const node of templateNodes) {
    for (const agent of node.agents) {
      templateAgentsByKey.set(`${node.name}::${agent.name}`, {
        toolGuards: agent.toolGuards,
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
      codexTimeoutSeconds: templateNode
        ? templateNode.codexTimeoutSeconds
        : node.codexTimeoutSeconds,
      agents: node.agents.map((agent) => {
        const key = `${node.name}::${agent.name}`;
        const templateAgent = templateAgentsByKey.get(key);
        if (templateAgent === undefined) return agent;
        // Merge: overwrite structural toolGuards, preserve user custom prompts except
        // for known retired built-in prompt text that would otherwise survive restamp.
        return {
          ...agent,
          ...(templateAgent.toolGuards === undefined
            ? {}
            : { toolGuards: templateAgent.toolGuards }),
          customPrompt: patchKnownBuiltInPromptDrift(
            agent.customPrompt,
            templateAgent.customPrompt
          ),
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
  'verdict with zero P0-P3 findings. Wait for a Codex bot `+1` reaction or the timeout ' +
  'before proceeding. ';
const RETIRED_HARDCODED_FULLSTACK_REVIEW_HANDOFF_PROMPT =
  'terminal handoff is `send_message(target="QA", message="<approved>", data: { approved: true })` ' +
  'after an APPROVE verdict with zero P0-P3 findings. Wait for a Codex bot `+1` reaction or ' +
  'the timeout before proceeding. ';
const RETIRED_FULLSTACK_CODING_STEP_PROMPT =
  '4. Write code-pr-gate with field pr_url so Review can activate\n';
const RETIRED_HARDCODED_FULLSTACK_CODING_STEP_PROMPT =
  '4. Hand off to Review by calling ' +
  '`send_message(target="Review", message="<short summary>", data: { pr_url: "<url>" })`; ' +
  '`save_artifact` alone will not open `code-pr-gate`\n';

const BUILT_IN_PROMPT_PATCH_VARIANTS = [
  [
    [CURRENT_CODING_WORKFLOW_HANDOFF_PROMPT, RETIRED_CODING_WORKFLOW_HANDOFF_PROMPT],
    [CURRENT_CODING_WORKFLOW_REHANDOFF_PROMPT, RETIRED_CODING_WORKFLOW_REHANDOFF_PROMPT],
  ],
  [
    [CURRENT_CODING_WORKFLOW_HANDOFF_PROMPT, RETIRED_HARDCODED_CODING_WORKFLOW_HANDOFF_PROMPT],
    [CURRENT_CODING_WORKFLOW_REHANDOFF_PROMPT, RETIRED_HARDCODED_CODING_WORKFLOW_REHANDOFF_PROMPT],
  ],
  [
    [CURRENT_FULLSTACK_CODING_READY_PROMPT, RETIRED_FULLSTACK_CODING_READY_PROMPT],
    [CURRENT_FULLSTACK_CODING_STEP_PROMPT, RETIRED_FULLSTACK_CODING_STEP_PROMPT],
  ],
  [
    [CURRENT_FULLSTACK_CODING_READY_PROMPT, RETIRED_HARDCODED_FULLSTACK_CODING_READY_PROMPT],
    [CURRENT_FULLSTACK_CODING_STEP_PROMPT, RETIRED_HARDCODED_FULLSTACK_CODING_STEP_PROMPT],
  ],
  [[CURRENT_FULLSTACK_REVIEW_HANDOFF_PROMPT, RETIRED_FULLSTACK_REVIEW_HANDOFF_PROMPT]],
  [[CURRENT_FULLSTACK_REVIEW_HANDOFF_PROMPT, RETIRED_HARDCODED_FULLSTACK_REVIEW_HANDOFF_PROMPT]],
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
  const values: string[] = [];
  for (const replacements of BUILT_IN_PROMPT_PATCH_VARIANTS) {
    let value = templateValue;
    for (const [currentText, retiredText] of replacements) {
      if (!value.includes(currentText)) {
        value = templateValue;
        break;
      }
      value = value.replace(currentText, retiredText);
    }
    if (value !== templateValue) values.push(value);
  }
  return values;
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

function mergeChannelsFromTemplate(
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

  const existingKeys = new Set(
    existingChannels.map((channel) =>
      JSON.stringify({ from: channel.from, to: channel.to, gateId: channel.gateId ?? null })
    )
  );
  const missingTemplateChannels = remappedTemplateChannels.filter(
    (channel) =>
      !existingKeys.has(
        JSON.stringify({ from: channel.from, to: channel.to, gateId: channel.gateId ?? null })
      )
  );

  return [...existingChannels, ...missingTemplateChannels];
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
 * - Missing template channels are appended so newly-added built-in branches become
 *   reachable on pre-existing spaces. Template hooks are copied from the built-in
 *   template so hook-based runtime metadata lands during drift re-stamps. Existing
 *   channels, layout, and node rows are not regenerated. Workflow IDs, node IDs, and persisted node-agent slots
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
  'channels(missing template channels)',
  'hooks(template hooks)',
] as const;

/**
 * Seeds all built-in workflow templates into the given space.
 *
 * Each template node agent's `agentId` placeholder (e.g., `'Planner'`, `'Coder'`,
 * `'General'`) is resolved to a real SpaceAgent UUID via `resolveAgentId`.
 * If any name cannot be resolved, this function throws — persisting a
 * placeholder string as an `agentId` would create broken workflow data.
 *
 * Idempotency & drift re-stamping:
 *   - If NO built-in workflow rows exist yet in this space, all five templates
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
 * NOTE: This function must be called after preset SpaceAgent records have been
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
  resolveAgentId: (name: string) => string | undefined
): SeedBuiltInWorkflowsResult {
  const templates = getBuiltInWorkflows();
  const templatesByName = new Map(templates.map((t) => [t.name, t]));
  const existing = workflowManager.listWorkflows(spaceId);

  // Branch 1 (re-stamp path): rows already exist. Walk them and update any
  // template-seeded rows whose stored `templateHash` no longer matches the
  // current template. This migration path moves built-in post-approval routes
  // onto nodes for spaces that were seeded before node-level routes existed.
  if (existing.length > 0) {
    const restamped: string[] = [];
    const errors: Array<{ name: string; error: string }> = [];

    for (const row of existing) {
      if (!row.templateName) continue;
      const template = templatesByName.get(row.templateName);
      if (!template) continue;
      const expectedHash = computeWorkflowHash(template);
      if (row.templateHash === expectedHash) continue;

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
        const hasNewTemplateChannels =
          (mergedChannels?.length ?? 0) > (existingChannels?.length ?? 0);

        workflowManager.updateWorkflow(row.id, {
          completionAutonomyLevel: template.completionAutonomyLevel,
          // Built-ins now store routes on terminal nodes. Clear any legacy
          // workflow-level value while the node updater writes node routes.
          postApproval: null,
          gates: migratedGates,
          hooks:
            mergeHooksFromTemplate(template.hooks, template.nodes, migratedNodes, row.hooks) ??
            null,
          nodes: migratedNodes,
          ...(hasNewTemplateChannels || removedLegacyPrReadyChannels
            ? { channels: mergedChannels }
            : {}),
          templateHash: expectedHash,
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

    return {
      seeded: [],
      restamped,
      errors,
      skipped: restamped.length === 0 && errors.length === 0,
    };
  }

  // Branch 2 (fresh seed path): no rows yet. Create all five templates.
  //
  // Pre-validate: resolve every agent name needed across ALL templates before
  // persisting anything. This guarantees all-or-nothing behaviour.
  const neededNames = new Set<string>();
  for (const template of templates) {
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
        `seedBuiltInWorkflows: no SpaceAgent found with name '${agentName}' in space '${spaceId}'. ` +
          `Preset agents must be seeded before calling seedBuiltInWorkflows.`
      );
    }
    resolvedIds.set(agentName, agentId);
  }

  // All names resolved — safe to persist.
  const seeded: string[] = [];
  const errors: Array<{ name: string; error: string }> = [];

  for (const template of templates) {
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

  return { seeded, restamped: [], errors, skipped: false };
}
