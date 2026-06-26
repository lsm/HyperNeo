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
  '      output (it names each conflicted file), or run a trial merge against the',
  '      PR head — NOT local HEAD, which may be on a different branch after a',
  '      daemon restart/cache miss. Fetch BOTH origin/dev and the PR head OBJECT',
  '      (the OID alone is useless if the object is not local), then merge-tree:',
  '        HEAD_OID=$(gh pr view {{pr_url}} --json headRefOid --jq .headRefOid)',
  '        git fetch origin dev && git fetch origin "refs/pull/<number>/head"',
  '        git merge-tree --write-tree --no-messages origin/dev "$HEAD_OID"',
  '      Read the conflicted paths it reports. Do NOT use `gh pr view --json',
  '      files` — that lists every PR file, not the conflict subset.',
  '   b. Record the attempt AND the approved head OID (used later as the diff',
  '      base) as a workflow artifact so the loop is auditable:',
  '        save_artifact({ type: "merge_conflict_loop", append: true,',
  '          summary: "Merge conflict attempt <N> on PR {{pr_url}}",',
  '          data: { pr_url: "{{pr_url}}", base_branch: "dev",',
  '                  approved_head_oid: "<HEAD_OID at conflict time>",',
  '                  conflicting_files: ["..."], attempt: <N> } })',
  '   c. Message the upstream implementation node that opened this PR. Resolve',
  '      the exact target with `list_reachable_agents` (it is `Coding` in a',
  '      Coding workflow, `Research` in a Research workflow). Check',
  '      `list_channels` for the Review → <upstream node> route and gate the',
  '      review_url lookup on what it actually reports: only the Coding workflow',
  '      guards Review → Coding with review-posted-gate (requires both `pr_url`',
  '      and `review_url`, resets each cycle); the Research and Fullstack QA',
  '      back-channels are UNGATED, so they need no review_url.',
  '      If the route is GATED, first look up the permalink of the already-posted',
  '      approval review. `gh pr view --json reviews` does not expose a review',
  '      URL, so use the paginated REST API with the same <host> step 2 extracts,',
  '      so a large review history cannot hide the approval:',
  '        gh api --hostname <host> --paginate repos/<owner>/<repo>/pulls/<number>/reviews',
  '      Take the `html_url` of the latest APPROVED or COMMENTED review (the',
  '      gate accepts a COMMENTED review as own-PR evidence). If there is no',
  '      such review and the reviewer used a PR conversation comment instead,',
  '      fall back to the latest comment permalink — paginated, since the',
  '      newest valid comment can be beyond page 1:',
  '        gh api --hostname <host> --paginate repos/<owner>/<repo>/issues/<number>/comments',
  '      Send the handoff with pr_url, and (ONLY when the route is gated) the',
  '      resolved review/comment URL as review_url so the gate opens:',
  '        send_message(target="<upstream node>", message="<short summary>",',
  '          data: { pr_url: "{{pr_url}}", review_url: "<approval review url>",',
  '                  base_branch: "dev", conflicting_files: ["..."],',
  '                  reason: "merge_conflict" })',
  '      The message body MUST instruct the coder: "Rebase onto latest',
  '      `origin/dev`, resolve the listed conflicts, run the tests that touch',
  '      the conflicted files, then `git push --force-with-lease` to update the',
  '      PR branch (a plain push is rejected as non-fast-forward after a rebase),',
  '      then report back to Review."',
  '   d. Do NOT close the task and do NOT escalate to a human on a conflict',
  '      alone — wait for the coder to confirm the rebase is pushed.',
  '   e. After the coder reports back, do NOT retry the merge immediately. The',
  '      push changed the PR head, so the approval no longer covers the new',
  '      conflict-fix commits. Rerun the pre-merge checks from step 1 (PR',
  '      state, `gh pr checks`) and step 2 (unresolved review conversations).',
  '      Fetch the current PR head and inspect the FULL delta against the',
  '      approved_head_oid from the step-b artifact — NOT local HEAD (the',
  '      workspace may not be on the PR branch) and not `gh pr diff` (no',
  '      base-ref option):',
  '        CUR_HEAD=$(gh pr view {{pr_url}} --json headRefOid --jq .headRefOid)',
  '        git fetch origin "refs/pull/<number>/head"',
  '        git diff "$APPROVED_HEAD_OID".."$CUR_HEAD"',
  '      Check the conflict resolution AND any unrelated changes in the same',
  '      push. If anything is wrong, post a fresh formal CHANGES_REQUESTED review',
  '      (or a fresh PR comment for an own-PR) documenting the issue and request',
  '      coder changes via the step-c send_message shape — repeat BOTH pr_url',
  '      ({{pr_url}}) and the fresh review_url (review-posted-gate resets each',
  '      cycle, so a payload carrying only review_url is blocked). If the fix is',
  '      sound, post a fresh APPROVED review on the',
  '      corrected head before retrying (for an own-PR where GitHub blocks',
  '      self-approval, post a fresh COMMENT review / PR comment stating the',
  '      fix is sound) — any conflict-fix force-push can dismiss stale',
  '      approvals in required-review repos, so re-approve on every retry. Only',
  '      then re-attempt `gh pr merge {{pr_url}} --squash`. New conflicts after',
  '      a rebase are normal, so keep routing conflict rounds back to the coder',
  '      (steps c-e) until the merge succeeds. There is NO fixed conflict-count',
  '      cap — the natural backstop is the cyclic channel cycle budget (step f)',
  '      or a genuine non-conflict blocker.',
  '   f. Conflict handoffs reuse the cyclic Review → <upstream node> channel',
  '      cycle budget (Coding: Review → Coding; Research: Review → Research).',
  '      Base the cap check on the actual channel `list_channels` reports — if',
  '      a handoff is rejected because that channel cycle cap is reached, treat',
  '      it as the end of the loop.',
  '   g. If a genuine NON-CONFLICT blocker is hit, or the cyclic Review →',
  '      <upstream node> channel cycle budget is exhausted (a cycle-cap',
  '      rejection — the natural backstop, which can occur before any coder',
  '      round is delivered), escalate to space-agent — NOT merely because',
  '      conflicts kept occurring; do NOT mark the task complete (the PR is not',
  '      merged). Report the REAL attempt count and the exit reason, then record',
  '      the block as a NON-result artifact (a "result" artifact would be',
  '      picked up as the task result when the task is later marked complete)',
  '      and notify space-agent:',
  '        save_artifact({ type: "merge_blocked", append: true,',
  '          summary: "Merge blocked on PR {{pr_url}} (<N> attempts, <exit>)",',
  '          data: { pr_url: "{{pr_url}}", conflicting_files: ["..."],',
  '                  attempts: <N>, exit_reason: "<cycle_cap|non_conflict_blocker>" } })',
  '        send_message(target="space-agent", message="Merge blocked on PR',
  '          {{pr_url}} (<N> attempts, exit: <cycle_cap|non_conflict_blocker>)",',
  '          data: { pr_url: "{{pr_url}}", conflicting_files: ["..."],',
  '                  attempts: <N>, exit_reason: "<cycle_cap|non_conflict_blocker>" })',
  '      The task then stays in post-approval awaiting operator resolution.',
  '      (The post-approval node-agent surface exposes no block/request-human',
  '      tool, so a true blocked-state transition is a separate tooling change;',
  '      the blocker artifact + space-agent message are the available escalation.)',
  '4. Delete the PR remote branch — ONLY after a successful merge, and as a',
  '   SEPARATE command. Do NOT pass a delete flag to the merge command above;',
  '   and only delete for same-repository heads — forked PRs keep their branch',
  '   in the fork, so deleting from origin would miss or hit an unrelated',
  '   same-named branch. Assign both values with --jq, then branch on the fork',
  '   check before deleting:',
  '     HEAD_REF=$(gh pr view {{pr_url}} --json headRefName --jq .headRefName)',
  '     IS_FORK=$(gh pr view {{pr_url}} --json isCrossRepository --jq .isCrossRepository)',
  '   If IS_FORK is true, SKIP deletion. Otherwise delete the ref:',
  '     git push origin --delete "$HEAD_REF"',
  '   Branch cleanup is BEST-EFFORT: if deletion fails for any reason',
  '   (protected branch, missing delete permission, already gone), record a',
  '   NON-result warning artifact (e.g. type:"cleanup_warning") and continue —',
  '   a "result" artifact would be picked up as the task result on completion.',
  '   The PR is already merged, so do NOT let a cleanup failure block the',
  '   completion step. Do NOT delete `dev`.',
  '5. Sync safely without switching branches in isolated worktrees:',
  '     git fetch origin dev',
  '   If you are already on `dev`, run `git pull --ff-only origin dev`. If you are in a task',
  '   worktree or on any non-dev branch, do NOT `git checkout dev`; leave branch state untouched',
  '   and only fetch. Root repo synchronization is handled outside the isolated worktree.',
  '6. Save an audit artifact:',
  '     save_artifact({ type: "result", append: true,',
  '                     data: { merged_pr_url, merged_at, approval_source: "{{approval_source}}" } })',
].join('\n');
