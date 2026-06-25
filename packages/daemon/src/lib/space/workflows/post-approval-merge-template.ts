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
 * Merge-conflict routing (not human escalation): when `gh pr merge` fails on a
 * conflict with the base branch (`dev`), the reviewer does NOT escalate to a
 * human. Conflicts are routine coder work — step 3 routes them back to the
 * upstream implementation node (coder) with the conflicting files, caps the
 * loop at 2 coder attempts, records each attempt as a workflow artifact
 * (`merge_conflict_loop`), and only escalates to `space-agent` after the cap.
 * The conflict handoff carries both `pr_url` and `review_url` so it satisfies
 * `review-posted-gate` on the Review → Coding channel.
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
  '   On a merge conflict, do NOT force the merge and do NOT escalate to a',
  '   human — merge conflicts are routine coder work. Detect a conflict from',
  '   `mergeStateStatus: DIRTY` (step 1) or conflict markers / "merge conflict"',
  '   in the `gh pr merge` failure output, then route it back to the coder:',
  '   a. Derive the ACTUAL conflicting paths. Parse them from the merge failure',
  '      output (it names each conflicted file), or run a local trial merge',
  '      (`git fetch origin dev && git merge-tree --write-tree --no-messages',
  '      origin/dev HEAD`) and read the conflicted paths it reports. Do NOT use',
  '      `gh pr view --json files` — that lists every PR file, not the conflict',
  '      subset.',
  '   b. Record the attempt as a workflow artifact so the loop is auditable:',
  '        save_artifact({ type: "merge_conflict_loop", append: true,',
  '          summary: "Merge conflict attempt <N> of 2 on PR {{pr_url}}",',
  '          data: { pr_url: "{{pr_url}}", base_branch: "dev",',
  '                  conflicting_files: ["..."], attempt: <N> } })',
  '   c. Message the upstream implementation node that opened this PR. Resolve',
  '      the exact target with `list_reachable_agents` (it is `Coding` in a',
  '      Coding workflow, `Research` in a Research workflow). The Review → Coding',
  '      channel is guarded by review-posted-gate, which requires both `pr_url`',
  '      and `review_url` and resets each cycle — so first look up the permalink',
  '      of the already-posted approval review (e.g.',
  '      `gh pr view {{pr_url}} --json reviews`), then include BOTH fields in the',
  '      data payload so the gate opens:',
  '        send_message(target="<upstream node>", message="<short summary>",',
  '          data: { pr_url: "{{pr_url}}", review_url: "<approval review url>",',
  '                  base_branch: "dev", conflicting_files: ["..."],',
  '                  reason: "merge_conflict" })',
  '      The message body MUST instruct the coder: "Rebase onto latest',
  '      `origin/dev`, resolve the listed conflicts, run the tests that touch',
  '      the conflicted files, push, then report back to Review."',
  '   d. Do NOT close the task and do NOT escalate to a human on a conflict',
  '      alone — wait for the coder to confirm the rebase is pushed.',
  '   e. After the coder reports back, do NOT retry the merge immediately: the',
  '      push changed the PR head. Rerun the pre-merge checks from step 1 (PR',
  '      state, `gh pr checks`) and step 2 (unresolved review conversations). If',
  '      the node that approved this task was a QA node and the conflict fix',
  '      touched code it validated, message that node to re-confirm before',
  '      merging. Only when steps 1 and 2 pass again, re-attempt',
  '      `gh pr merge {{pr_url}} --squash`. If it still conflicts, loop once',
  '      more — maximum 2 coder attempts. If the merge still fails after 2',
  '      coder attempts, escalate to space-agent with the accumulated evidence',
  '      and stop:',
  '        send_message(target="space-agent", message="Merge conflict on PR',
  '          {{pr_url}} unresolved after 2 coder attempts",',
  '          data: { pr_url: "{{pr_url}}", conflicting_files: ["..."], attempts: 2 })',
  '4. Sync safely without switching branches in isolated worktrees:',
  '     git fetch origin dev',
  '   If you are already on `dev`, run `git pull --ff-only origin dev`. If you are in a task',
  '   worktree or on any non-dev branch, do NOT `git checkout dev`; leave branch state untouched',
  '   and only fetch. Root repo synchronization is handled outside the isolated worktree.',
  '5. Save an audit artifact:',
  '     save_artifact({ type: "result", append: true,',
  '                     data: { merged_pr_url, merged_at, approval_source: "{{approval_source}}" } })',
].join('\n');
