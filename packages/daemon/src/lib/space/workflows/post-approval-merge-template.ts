/**
 * Shared "merge the PR" post-approval instructions template.
 *
 * Referenced verbatim from
 * `docs/plans/remove-completion-actions-task-agent-as-post-approval-executor.md`
 * §5 — "Merge-template `instructions` string (shared across Coding, Research,
 * QA)."
 *
 * Delivered to the PR Merger post-approval session by `PostApprovalRouter`
 * when a workflow declares `postApproval.targetAgent = 'merger'`. (The
 * instructions string still reads "reviewer" in places — legacy prose from
 * when the reviewer ran the merge; the merger is now the actor. The string is
 * unchanged because the merge LOGIC is unchanged.) Template tokens
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
 * conflict with the base branch ($BASE, derived from the PR's baseRefName), the merger does NOT escalate to a
 * human. Conflicts are routine coder work — step 3 routes them back to the
 * upstream implementation node (coder) over the ungated `Post-Approval →
 * <upstream>` channel with the conflicting files, records each attempt as a
 * workflow artifact (`merge_conflict_loop`), and caps the loop on the cyclic
 * channel budget (no fixed attempt count). The coder replies over the
 * `<upstream> → Post-Approval` channel. The handoff carries `pr_url`; no
 * `review_url` is needed (the conflict route is ungated — `review-posted-gate`
 * guards the Review → Coding phase, not this post-approval loop).
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
  '1. Verify the PR is still open and passes CI, and capture the base branch it merges into:',
  '     gh pr view {{pr_url}} --json state,mergeStateStatus,statusCheckRollup',
  '     gh pr checks {{pr_url}}',
  '     BASE=$(gh pr view {{pr_url}} --json baseRefName --jq .baseRefName)',
  '   BASE is the branch this PR merges INTO (its baseRefName — NOT the repo default, which',
  '   can differ, e.g. a release branch). Use $BASE everywhere below instead of a hard-coded',
  '   branch name: this built-in runs against arbitrary repos (dev/main/master/...). $BASE is a',
  '   shell variable — in tool-call payloads (send_message/save_artifact) substitute its actual',
  '   value (shown as <base branch>), never the literal "$BASE". Each Bash tool call runs in a',
  '   fresh shell, so $BASE does NOT persist across calls — re-derive it at the top of any later',
  '   command block that uses it (the gh pr view call is idempotent).',
  '   If state is MERGED, the merge already happened (possibly in a prior session). Record an',
  '   audit artifact, then perform step 5 ONLY (fast-forward the root repository — a restart',
  '   after merge must still sync it, or the root checkout stays stale and every later task',
  '   branched from it inherits the stale base branch), then exit. Do NOT redo steps 2–4 and',
  '   do NOT save the step-6 merge artifact (no merge happened in this session).',
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
  '      daemon restart/cache miss. Fetch BOTH origin/$BASE and the PR head OBJECT',
  '      (the OID alone is useless if the object is not local), then merge-tree:',
  '        BASE=$(gh pr view {{pr_url}} --json baseRefName --jq .baseRefName)',
  '        HEAD_OID=$(gh pr view {{pr_url}} --json headRefOid --jq .headRefOid)',
  '        git fetch origin "$BASE" && git fetch origin "refs/pull/<number>/head"',
  '        git merge-tree --write-tree --no-messages "origin/$BASE" "$HEAD_OID"',
  '      Read the conflicted paths it reports. Do NOT use `gh pr view --json',
  '      files` — that lists every PR file, not the conflict subset.',
  '   b. Record the attempt AND the approved head OID (used later as the diff',
  '      base) as a workflow artifact so the loop is auditable:',
  '        save_artifact({ type: "merge_conflict_loop", append: true,',
  '          summary: "Merge conflict attempt <N> on PR {{pr_url}}",',
  '          data: { pr_url: "{{pr_url}}", base_branch: "<base branch>",',
  '                  approved_head_oid: "<HEAD_OID at conflict time>",',
  '                  conflicting_files: ["..."], attempt: <N> } })',
  '   c. Message the upstream implementation node that opened this PR. Resolve',
  '      the exact target with `list_reachable_agents` (it is `Coding` in a',
  '      Coding or Coding-with-QA workflow, `Research` in a Research workflow).',
  '      You run in the Post-Approval node, so route via the',
  '      `Post-Approval → <upstream node>` channel — it is UNGATED, so no',
  '      review_url is needed for the conflict handoff (you are the post-approval',
  '      authority and post your own fresh review at step e before re-merge).',
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
  '                  base_branch: "<base branch>", conflicting_files: ["..."],',
  '                  reason: "merge_conflict" })',
  '      The message body MUST instruct the coder: "Rebase onto latest',
  '      `origin/<base branch>`, resolve the listed conflicts, run the tests that touch',
  '      the conflicted files, then `git push --force-with-lease` to update the',
  '      PR branch (a plain push is rejected as non-fast-forward after a rebase),',
  '      then report back to the merger (the Post-Approval agent that sent this',
  '      handoff) via the `Coding → Post-Approval` (or `Research → Post-Approval`)',
  '      channel. Do NOT mark the task complete or call the completion tool —',
  '      this is a conflict-fix round under post-approval, not a completion;',
  '      only the merger merges and closes the task."',
  '   d. Do NOT close the task and do NOT escalate to a human on a conflict',
  '      alone — wait for the coder to confirm the rebase is pushed.',
  '   e. After the coder reports back, do NOT retry the merge immediately. The',
  '      push changed the PR head, so the approval no longer covers the new',
  '      conflict-fix commits. Rerun the pre-merge checks from step 1 (PR',
  '      state, `gh pr checks`) and step 2 (unresolved review conversations).',
  '      Fetch the current PR head and inspect the FULL delta against the',
  '      approved_head_oid from the step-b artifact — NOT local HEAD (the',
  '      workspace may not be on the PR branch) and not `gh pr diff` (no',
  '      base-ref option). Fetch BOTH the old approved head and the current PR',
  '      ref — the approved SHA may no longer be local after a restart/cache',
  '      miss, so the diff would fail on an unknown old object:',
  '        CUR_HEAD=$(gh pr view {{pr_url}} --json headRefOid --jq .headRefOid)',
  '        git fetch origin "$APPROVED_HEAD_OID" "refs/pull/<number>/head"',
  '        git diff "$APPROVED_HEAD_OID".."$CUR_HEAD"',
  '      Check the conflict resolution AND any unrelated changes in the same',
  '      push. If anything is wrong, post a fresh formal CHANGES_REQUESTED review',
  '      (or a fresh PR comment for an own-PR) documenting the issue and request',
  '      coder changes via the step-c send_message shape — always re-supply',
  '      pr_url ({{pr_url}}) on every send. If the fix is',
  '      sound, post a fresh APPROVED review on the',
  '      corrected head before retrying (for an own-PR where GitHub blocks',
  '      self-approval, post a fresh COMMENT review / PR comment stating the',
  '      fix is sound) — any conflict-fix force-push can dismiss stale',
  '      approvals in required-review repos, so re-approve on every retry. Only',
  '      then re-attempt `gh pr merge {{pr_url}} --squash`. New conflicts after',
  '      a rebase are normal, so keep looping until the merge succeeds. On each',
  '      failed retry RESTART at steps a/b — recompute the conflicting paths',
  '      (step a) and record a fresh artifact (step b) before re-handoff to the',
  '      coder, so a later round never reuses stale conflicting_files after the',
  '      base branch or PR head has changed. There is NO fixed conflict-count',
  '      cap — the natural backstop is the cyclic channel cycle budget (step f)',
  '      or a genuine non-conflict blocker.',
  '   f. Conflict handoffs reuse the cyclic Post-Approval → <upstream node>',
  '      channel cycle budget (Coding: Post-Approval → Coding; Research:',
  '      Post-Approval → Research). Base the cap check on the actual channel',
  '      `list_channels` reports — if a handoff is rejected because that channel',
  '      cycle cap is reached, treat it as the end of the loop.',
  '   g. If a genuine NON-CONFLICT blocker is hit, or the cyclic Post-Approval →',
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
  '   completion step. Do NOT delete `$BASE`.',
  '5. Sync so both this isolated worktree AND the Space checkout track the freshly-merged $BASE.',
  '   The reviewer session is the ONLY actor that fast-forwards the separate Space checkout —',
  '   do NOT skip step b, or every later task branched from a stale checkout inherits the stale base branch.',
  '   a. In this isolated worktree, do NOT `git checkout $BASE` and do NOT switch branches — the',
  '      worktree must stay on its task branch. Just fetch:',
  '        BASE=$(gh pr view {{pr_url}} --json baseRefName --jq .baseRefName)',
  '        git fetch origin "$BASE"',
  '   b. The reviewer session is ALSO responsible for fast-forwarding the separate Space checkout',
  '      that future task worktrees branch from (createTaskWorktree bases them on its HEAD). Its',
  '      absolute path is supplied below as the configured workspace — use it directly rather than',
  '      inferring a path from git: `git rev-parse --git-common-dir` resolves to the shared',
  '      main-repo `.git`, whose parent is a DIFFERENT checkout when the workspace is itself a',
  '      linked worktree, and the session gets no worktree banner either. Guard the checkout',
  '      before pulling:',
  '        BASE=$(gh pr view {{pr_url}} --json baseRefName --jq .baseRefName)',
  "        SPACE_WS='{{workspace_path}}'",
  '      `git pull --ff-only origin "$BASE"` fast-forwards the CURRENTLY checked-out branch,',
  '      so a checkout not on $BASE would be moved or silently left behind, and a local $BASE',
  '      ahead of origin/$BASE prints "Already up to date" while hiding stray unmerged commits',
  '      that later task worktrees would inherit. Each guard records a NON-result',
  '      cleanup_warning artifact (never a "result") and continues:',
  '        if [ "$(git -C "$SPACE_WS" rev-parse --abbrev-ref HEAD)" != "$BASE" ]; then',
  '          # checkout on a different branch — do NOT move it; warn and skip.',
  '          record a NON-result cleanup_warning artifact (space not on $BASE) and continue.',
  '        fi',
  '        git -C "$SPACE_WS" fetch origin "$BASE"',
  '        git -C "$SPACE_WS" pull --ff-only origin "$BASE"',
  '        if [ "$(git -C "$SPACE_WS" rev-parse HEAD)" != "$(git -C "$SPACE_WS" rev-parse "origin/$BASE")" ]; then',
  '          # pull said "Already up to date" but local $BASE is AHEAD of origin/$BASE — stray',
  '          # commits remain at HEAD; do NOT claim the checkout is synchronized.',
  '          record a NON-result cleanup_warning artifact (space $BASE ahead of origin/$BASE) and continue.',
  '        fi',
  '      If the pull itself fails (divergence, permissions), do NOT force it — record a',
  '      NON-result cleanup_warning artifact and continue (the PR is already merged; this',
  '      mirrors step 4 best-effort handling).',
  '6. Save an audit artifact:',
  '     save_artifact({ type: "result", append: true,',
  '                     data: { merged_pr_url, merged_at, approval_source: "{{approval_source}}" } })',
].join('\n');
