/**
 * Shared "merge the PR" post-approval instructions template.
 *
 * Referenced verbatim from
 * `docs/plans/remove-completion-actions-task-agent-as-post-approval-executor.md`
 * §5 — "Merge-template `instructions` string (shared across Coding, Research,
 * QA)."
 *
 * Delivered to the reviewer post-approval session by `PostApprovalRouter` when
 * a workflow declares `postApproval.targetAgent = 'reviewer'`. Template tokens
 * follow the §1.6 grammar evaluated by
 * `post-approval-template.ts:interpolatePostApprovalTemplate`. Recognised
 * tokens used below:
 *
 *   - `{{pr_url}}`          — signalled by the end node via
 *                             `send_message(task-agent, …, data:{ pr_url })`.
 *   - `{{approval_source}}` — `'human' | 'agent'` (from
 *                             `SpaceApprovalSource`; `auto_policy` is
 *                             theoretically possible but no caller produces
 *                             it for post-approval).
 * NOTE: The `{{reviewer_name}}` token was intentionally replaced with the
 * static string `[end-node reviewer]` in PR 3/5 because nothing in
 * `dispatchPostApproval` currently resolves the approving agent's slot name
 * into `routeContext.reviewer_name`. Threading the name through from
 * `onApproveTask` is tracked as a follow-up (PR 4/5 / PR 5/5). Leaving the
 * token as a literal `{{reviewer_name}}` would degrade the reviewer
 * sub-session's kickoff, so it is rendered as a stable human-readable label
 * for now.
 *
 * Workflow authors referencing this template MUST ensure their end node signals
 * `{ pr_url }` (inside the `data` payload of `send_message(target:
 * 'task-agent', …)` and/or `save_artifact({ type: 'result', data: { pr_url } })`)
 * before `approve_task()` / `submit_for_approval()`. The earlier §2.1
 * `post_approval_action` discriminator was removed — post-approval routing is
 * declarative on the workflow's `postApproval` field, not signalled at runtime.
 *
 * The runtime appends the universal `mark_complete` instruction in
 * `PostApprovalRouter`; keep this workflow data focused on PR-specific work.
 */
export const PR_MERGE_POST_APPROVAL_INSTRUCTIONS: string = [
	'The task has been approved. Your job is to merge PR {{pr_url}}.',
	'',
	// TODO(PR 4/5 or 5/5): resolve the approving agent's slot name and replace
	// this static label with `{{reviewer_name}}`. See file-level NOTE.
	'Reviewer: [end-node reviewer].',
	'Approval source: {{approval_source}}.',
	'',
	'Steps:',
	'1. Verify the PR is still open and passes CI:',
	'     gh pr view {{pr_url}} --json state,mergeStateStatus,statusCheckRollup',
	'     gh pr checks {{pr_url}}',
	'   If state is MERGED, record an audit artifact and exit — the work is done.',
	'2. Verify all GitHub review conversations are resolved before merging:',
	'   Extract <host>, <owner>, <repo>, and <number> from {{pr_url}} before running the query',
	'   (format: https://<host>/<owner>/<repo>/pull/<number>).',
	"     gh api graphql --hostname <host> -f query='query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{id isResolved comments(first:20){nodes{url author{login} body createdAt}}} pageInfo{hasNextPage endCursor}}}}}' -f owner=<owner> -f name=<repo> -F number=<number>",
	'   If pageInfo.hasNextPage is true, paginate using the endCursor until all pages',
	'   have been fetched. Do NOT stop at the first page — unresolved threads may exist',
	'   beyond page 1.',
	'   If any reviewThread has isResolved=false, do NOT merge. Instead, request',
	'   coder follow-up for those thread URLs and wait for them to be resolved.',
	'   Auto-merging or auto-resolving review conversations is NOT allowed.',
	'3. Merge:',
	'     gh pr merge {{pr_url}} --squash',
	'   On a merge conflict, do NOT force — exit, call request_human_input with',
	'   a clear summary of the conflict, and let the human resolve.',
	'4. Sync safely without switching branches in isolated worktrees:',
	'     git fetch origin dev',
	'   If you are already on `dev`, run `git pull --ff-only origin dev`. If you are in a task',
	'   worktree or on any non-dev branch, do NOT `git checkout dev`; leave branch state untouched',
	'   and only fetch. Root repo synchronization is handled outside the isolated worktree.',
	'5. Save an audit artifact:',
	'     save_artifact({ type: "result", append: true,',
	'                     data: { merged_pr_url, merged_at, approval_source: "{{approval_source}}" } })',
].join('\n');
