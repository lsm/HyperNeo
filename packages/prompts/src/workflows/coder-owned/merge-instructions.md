---
id: CODER_OWNED_MERGE_INSTRUCTIONS
---
The task has been approved. You are the agent who implemented PR {{pr_url}}; now finish it by merging that PR.

Approval source: {{approval_source}}. This is Space TASK-approval provenance — it records how the task reached `approved` (a human clicked Approve, or an agent approved it). It is NOT evidence that the current PR head was reviewed, and it is NOT a merge authorization on its own — never treat it as one.

## Verify before you merge (do NOT skip)

The merge must satisfy ALL of the following against the PR's CURRENT head before you run `gh pr merge`. Run them in order, in this worktree:
  - the PR is open;
  - required CI / checks are passing;
  - there are zero unresolved review conversations;
  - there is NO effective outstanding `CHANGES_REQUESTED` review — even one on an OLDER head that no other reviewer superseded. A `CHANGES_REQUESTED` from any reviewer blocks the merge until that reviewer dismisses it or requests changes again (repositories that do not enforce changes-requested in branch protection will otherwise accept `gh pr merge` while a requested change is unresolved);
  - a real GitHub `APPROVED` review covers the current head (its commit_id equals the current headRefOid), OR — for an own-PR where GitHub rejects self-approval — a COMMENTED review on the current head carrying the exact body marker "Recommendation: APPROVE", left BY THE PR AUTHOR. A stale approval on an older head does NOT cover the current head.

## Steps

1. Confirm the PR is open, CI is green, and capture the base branch it merges into:
     gh pr view {{pr_url}} --json state,mergeStateStatus,headRefOid
     gh pr checks {{pr_url}} --required  # only REQUIRED checks gate the merge — optional pending/failing checks do not block (mergeStateStatus CLEAN already implies required checks pass)
     BASE=$(gh pr view {{pr_url}} --json baseRefName --jq .baseRefName)
   If state is not OPEN, or a required check is failing or pending, treat it as a blocker per step 4.
   If state is MERGED, the merge already happened (possibly in a prior session). Perform step 6 ONLY (fast-forward the root checkout — a restart after merge must still sync it), then call mark_complete to close the task. Do NOT save the step-7 new-merge audit artifact (no merge happened in this session).
2. Verify all GitHub review conversations are resolved before merging:
   Extract <host>, <owner>, <repo>, and <number> from {{pr_url}} (format: https://<host>/<owner>/<repo>/pull/<number>).
     gh api graphql --hostname <host> -f query='query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{id isResolved comments(first:20){nodes{url}}} pageInfo{hasNextPage endCursor}}}}}' -f owner=<owner> -f name=<repo> -F number=<number>
   If pageInfo.hasNextPage is true, paginate using the endCursor until all pages have been fetched.
   If any reviewThread has isResolved=false, do NOT merge. Resolve the threads you own by replying on the PR (see the review-thread resolution guidance from the coding phase), and report any remaining threads you cannot resolve to the approval authority per step 4. Auto-resolving conversations is NOT allowed.
3. Verify the review state covers the current head with NO effective changes-requested and an AUTHORIZED approver, then merge bound to it:
     HEAD_OID=$(gh pr view {{pr_url}} --json headRefOid --jq .headRefOid)
     PR_AUTHOR=$(gh pr view {{pr_url}} --json author --jq .author.login)
     REVIEW_DECISION=$(gh pr view {{pr_url}} --json reviewDecision --jq .reviewDecision)
     case "$REVIEW_DECISION" in REVIEW_REQUIRED|CHANGES_REQUESTED) echo "GitHub reviewDecision is $REVIEW_DECISION — required approvals / code-owner rules not met, or an outstanding AUTHORIZED change request; do NOT merge." >&2; exit 1;; esac
   REVIEW_DECISION is the aggregate per branch protection: it counts only AUTHORIZED reviews (authorAssociation OWNER/MEMBER/COLLABORATOR) and enforces required-approvals / code-owner rules. Reject REVIEW_REQUIRED or CHANGES_REQUESTED. An empty/unset decision (repos without a required-review rule, including the own-PR fallback where the approval lands as a COMMENTED review with "Recommendation: APPROVE") is allowed to proceed to the manual authorized-review check below.
   For the head-binding detail, fetch ALL reviews via paginated GraphQL (`gh pr view --json reviews` returns only the first 100 and can omit a later change request). Extract <host>, <owner>, <repo>, <number> from {{pr_url}} (format: https://<host>/<owner>/<repo>/pull/<number>):
     gh api graphql --hostname <host> -f query='query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviews(first:100,after:$cursor){nodes{state commit{oid} author{login} authorAssociation body submittedAt} pageInfo{hasNextPage endCursor}}}}}' -f owner=<owner> -f name=<repo> -F number=<number>
   If pageInfo.hasNextPage is true, paginate using the endCursor until all pages are fetched, then combine all nodes into the review list.
   First, reject any effective AUTHORIZED change request: for each review in the list, it is an effective `CHANGES_REQUESTED` only if its author is AUTHORIZED (authorAssociation is OWNER, MEMBER, or COLLABORATOR — an outside contributor has no merge authority and is ignored) AND (its state is CHANGES_REQUESTED, OR its state is COMMENTED AND its author is the PR author (login equals $PR_AUTHOR) AND its body carries the exact marker line "Recommendation: REQUEST_CHANGES" (the own-PR fallback for requesting changes — GitHub rejects REQUEST_CHANGES from the PR owner)). Such a review is blocking unless the SAME author has since left a LATER `APPROVED` review with a LATER `submittedAt` (or the marked own-PR approval-fallback COMMENTED review — a plain COMMENTED review does NOT withdraw requested changes, and a REQUEST_CHANGES marker from the PR author is a blocking verdict, not a plain comment). If any effective AUTHORIZED change request stands, the merge is blocked — report per step 4 and wait (the author must dismiss or re-approve). Do NOT merge while an authorized changes-requested stands, even if another reviewer approved (the deleted merge-pr gate rejected these too).
   Then confirm a real approval covers the current head — its commit_id equals $HEAD_OID, its submittedAt is AFTER any same-author CHANGES_REQUESTED, AND its author is AUTHORIZED (`authorAssociation` is OWNER, MEMBER, or COLLABORATOR — an outside contributor's APPROVED review does NOT authorize the merge; the deleted merge-pr gate required this too). Normally that is an APPROVED review; for an own-PR where GitHub rejects self-approval (the review author's login equals $PR_AUTHOR), it is the approval authority's COMMENTED approval-fallback review, which MUST carry the body marker "Recommendation: APPROVE" (GitHub stores APPROVE from the PR owner as COMMENTED, so without that marker a changes-requested review or a plain comment would look identical and an unapproved/rejected head could be merged). If no authorized approval covers the current head, do NOT merge — report per step 4 and wait. Otherwise merge, bound to the verified head:
     gh pr merge {{pr_url}} --squash --match-head-commit "$HEAD_OID"
   A zero exit does NOT always mean merged — on a merge-queue-required base it only ENQUEUES the PR. Re-query until the PR `state` is MERGED:
     gh pr view {{pr_url}} --json state,mergeStateStatus --jq .
   MERGED -> continue to step 5 (cleanup + sync + audit). Still open but queued/processing -> keep re-querying roughly once a minute, up to ~10 attempts. If the queue entry is removed or its merge-group check fails (PR open, never MERGED), treat it as a blocker per step 4. Do NOT treat a null autoMergeRequest as failure (a PR added directly to the queue with checks passing legitimately has it null).
4. On any blocker (merge failed, CI not passing, unresolved threads, missing current-head approval, DIRTY conflict, BEHIND rebase, BLOCKED ruleset, permissions, merge queue):
   a. Capture WHY — the failure output plus a fresh state snapshot:
        gh pr view {{pr_url}} --json state,mergeable,mergeStateStatus,headRefOid,reviewDecision
        gh pr checks {{pr_url}}
      (mergeStateStatus hints: BLOCKED = a branch-protection / ruleset rule; BEHIND = head needs a rebase onto $BASE; UNSTABLE = a required check pending or failing; DIRTY = merge conflict; CLEAN = mergeable, so the blocker is permissions / merge method / merge queue; UNKNOWN = GitHub recomputing mergeability — re-query in ~30s before acting.)
   b. Then EITHER fix it yourself OR report it:
      - FIXABLE blocker (DIRTY conflict, BEHIND rebase, UNSTABLE because the code fails a required check, or an unresolved review thread you can resolve by replying on the PR): fix it in this PR and push the new head. A push changes the head, so the prior approval no longer covers it — do NOT merge the new head until it is re-approved. Reply on any review thread you resolve, then ask {{approval_authority}} to re-approve the CURRENT head and continue:
          send_message(target="{{approval_authority}}",
            message="Post-approval fix on {{pr_url}}: <one-line summary of the fix and the new need>. I pushed a new head to satisfy the merge (mergeStateStatus was <DIRTY|BEHIND|UNSTABLE>). Please re-check and re-approve the CURRENT head on GitHub (a real APPROVED review, or — for an own-PR — a COMMENTED review from the PR AUTHOR with body marker 'Recommendation: APPROVE'), then reply to me to continue the merge.",
            data: { pr_url: "{{pr_url}}", blockers: ["<kind: detail>"], headRefOid: "<new headRefOid>", reason: "merge_fix_pushed" })
        Then STOP and wait. After {{approval_authority}} replies to continue, go to step 3 again (re-verify against the CURRENT head). When the review policy routed this run's gate to external bots (`external`/`both`, or `auto` with bots), the fix push also made that gate stale: before merging, re-trigger the gate-set bots and wait for fresh current-head passes exactly as in the coding-phase gate, and when the policy requires the internal review (`internal`/`both`), the re-approval must come from a current-head review by the Reviewer — a test-only re-approval from a QA authority never substitutes for the review source's gate on a changed head.
      - ADMINISTRATIVE blocker (mergeStateStatus BLOCKED or CLEAN = permissions, ruleset, merge queue, or a check failing for reasons outside this PR; OR a stale approval you cannot self-approve): you cannot fix these by editing the PR. Report to {{approval_authority}} and WAIT. Confirm it is reachable via `list_reachable_agents` first (when both Review and QA are reachable, as in Coding with QA, address {{approval_authority}} specifically — do NOT default to Review):
          send_message(target="{{approval_authority}}",
            message="Merge blocked on {{pr_url}}: <one-line summary>. The merge requires a current-head GitHub approval. Re-check the PR, re-approve the CURRENT head on GitHub (a real APPROVED review, or — for an own-PR — a COMMENTED review from the PR AUTHOR with body marker 'Recommendation: APPROVE'), then reply to me to continue.",
            data: { pr_url: "{{pr_url}}", blockers: ["<kind: detail>"], headRefOid: "<headRefOid>", reason: "merge_blocked" })
        Then STOP. Do NOT self-approve, resolve others' threads, or run gh pr merge again until {{approval_authority}} tells you to continue.
   c. When {{approval_authority}} replies to continue: the head likely changed (or you just pushed a fix), so re-verify from scratch — re-run step 1 (state/CI), step 2 (unresolved threads), and step 3 (a real approval covering the CURRENT head). A stale approval on the old head does NOT cover the new one. Only then re-attempt the merge bound to the head you just verified. If it fails again, loop to 4a with the fresh reasons (never reuse stale blockers or headRefOid).
   d. Cycle cap / genuinely stuck: this implementer ↔ {{approval_authority}} loop is bounded by the channel cycle budget (check `list_channels` — the Coding ↔ {{approval_authority}} budget specifically; do NOT read an unrelated route). If a handoff is rejected because the cap is reached, or the blocker is unresolvable (data reason "unresolvable" — administrative, neither of you can fix it), escalate to space-agent — record a NON-result artifact and notify:
        save_artifact({ shape: "note", kind: "merge_blocked",
          summary: "Merge blocked on PR {{pr_url}} (<N> attempts, <exit>)",
          data: { pr_url: "{{pr_url}}", blockers: ["..."], attempts: <N>,
                  exit_reason: "<cycle_cap|unresolvable>" } })
        send_message(target="space-agent", message="Merge blocked on PR
          {{pr_url}} (<N> attempts, exit: <cycle_cap|unresolvable>)",
          data: { pr_url: "{{pr_url}}", blockers: ["..."], attempts: <N>,
                  exit_reason: "<cycle_cap|unresolvable>" })
      Do NOT mark the task complete (the PR is not merged).
5. Delete the PR remote branch — ONLY after a successful merge, and as a SEPARATE command. Do NOT pass a delete flag to the merge command; and only delete for same-repository heads — forked PRs keep their branch in the fork:
     HEAD_REF=$(gh pr view {{pr_url}} --json headRefName --jq .headRefName)
     IS_FORK=$(gh pr view {{pr_url}} --json isCrossRepository --jq .isCrossRepository)
   If IS_FORK is true, SKIP deletion. Otherwise delete the ref:
     git push origin --delete "$HEAD_REF"
   Branch cleanup is BEST-EFFORT: on any failure (protected branch, missing delete permission, already gone), record a NON-result `note` cleanup_warning artifact (key "branch-delete") and continue — the PR is already merged, so do NOT let a cleanup failure block completion.
6. Sync so both this isolated worktree AND the Space checkout track the freshly-merged base branch. Do NOT skip step b, or every later task branched from a stale checkout inherits the stale base branch.
   a. In this isolated worktree, do NOT `git checkout $BASE` and do NOT switch branches — the worktree must stay on its task branch. Just fetch:
        BASE=$(gh pr view {{pr_url}} --json baseRefName --jq .baseRefName)
        git fetch origin "$BASE"
   b. ALSO fast-forward the separate Space checkout that future task worktrees branch from. Its absolute path is supplied below as the configured workspace:
        BASE=$(gh pr view {{pr_url}} --json baseRefName --jq .baseRefName)
        SPACE_WS={{workspace_path_sh}}
      Guard before pulling (each guard records a NON-result cleanup_warning artifact and skips):
        if [ "$(git -C "$SPACE_WS" rev-parse --abbrev-ref HEAD)" != "$BASE" ]; then
          # Checkout is on a DIFFERENT branch — pulling origin/$BASE here would move or merge it
          # into the wrong branch. Record a NON-result `note` (key "space-checkout-base") and SKIP
          # the fetch+pull entirely (the PR is already merged; the stale base only affects future
          # task worktrees, and moving this checkout is worse than leaving it).
          record a NON-result `note` cleanup_warning artifact (key "space-checkout-base"; space not on $BASE) and skip the rest of step b.
        else
          git -C "$SPACE_WS" fetch origin "$BASE"
          if ! git -C "$SPACE_WS" pull --ff-only origin "$BASE"; then
            # Pull failed (divergence, permissions) — record a NON-result `note` (key "space-checkout-pull") and continue (the PR is already merged).
            record a NON-result `note` cleanup_warning artifact (key "space-checkout-pull") and skip the ahead-check below.
          else
            if [ "$(git -C "$SPACE_WS" rev-parse HEAD)" != "$(git -C "$SPACE_WS" rev-parse "origin/$BASE")" ]; then
              # pull said "Already up to date" but local $BASE is AHEAD of origin/$BASE —
              # stray commits remain at HEAD; do NOT claim the checkout is synchronized.
              record a NON-result `note` cleanup_warning artifact (key "space-checkout-ahead"; space $BASE ahead of origin/$BASE).
            fi
          fi
        fi
7. Save an audit artifact:
     save_artifact({ shape: "link", kind: "merge",
                     data: { url: <merged_pr_url>, merged_at, approval_source: "{{approval_source}}" } })
