---
id: CODER_ONLY_MERGE_INSTRUCTIONS
---
The task has been approved. You are the agent who implemented PR {{pr_url}}; now finish it by merging that PR.

Approval source: {{approval_source}}. Approval was granted by a human after the external review bots in your recorded gate set passed the current head and your informal review recorded a clean gate. The gate artifacts (per-bot verdict evidence, head OID, base ref) were recorded before approval.

## Verify before you merge (do NOT skip)

The merge must satisfy ALL of the following against the PR's CURRENT head before you run `gh pr merge`. Run them in order, in this worktree:
  - the PR is open;
  - required CI / checks are passing (every required check green under `gh pr checks {{pr_url}} --required`; check names vary per repository, so do not gate on a hard-coded check name; a base that defines no required checks reports exactly that and counts as green);
  - there are zero unresolved review conversations;
  - there is NO effective outstanding `CHANGES_REQUESTED` review — even one on an OLDER head that no other reviewer superseded. A `CHANGES_REQUESTED` from any bot or from a human reviewer blocks the merge until that reviewer dismisses it or approves;
  - if the base repository requires approving GitHub reviews (`reviewDecision` is `REVIEW_REQUIRED`), that is an ADMINISTRATIVE blocker — this gate does not supply GitHub approvals, so escalate per step 4 and never bypass it with `--admin`;
  - every bot in your recorded gate set passes on the CURRENT head: reaction-signaling bots (Codex) via a `THUMBS_UP` (+1) reaction from a review cycle started on the CURRENT head — posted after a trigger that itself postdates the last push, with the head unchanged since that trigger (a late `THUMBS_UP` from a cycle begun on an older head does not count) — and review-signaling bots via a review covering the CURRENT head (`commit.oid` equality) that carries an EXPLICIT clean verdict (APPROVED state or an unambiguous no-findings body) and does NOT request changes or flag any issue;
  - your informal-review gate artifact (`external-review-gate`) was recorded for the CURRENT head (or an earlier head with no intervening push) AND for the CURRENT base branch — retargeting the PR to a different base changes the reviewed diff without changing the head, so a base change also stales the gate and the human approval;

Derive the GitHub-approval requirement from the PR itself, not from any repository-specific assumption: an empty or APPROVED `reviewDecision` means the base requires no approving GitHub review beyond this gate, while REVIEW_REQUIRED is the administrative blocker above.

## Steps

1. Confirm the PR is open and CI is green, and capture the base branch:
     gh pr view {{pr_url}} --json state,mergeStateStatus,headRefOid
     gh pr checks {{pr_url}} --required
     BASE=$(gh pr view {{pr_url}} --json baseRefName --jq .baseRefName)
   If state is not OPEN, or a required check is failing or pending, treat it as a blocker per step 4. A report that the base has no required checks counts as green. If state is MERGED, the merge already happened (possibly in a prior session that died before cleanup); first confirm your gate artifact `head_oid` still equals the PR headRefOid AND its `base_ref` equals the final baseRefName — if either does not, a different, unverified head or base was merged by another actor, so do NOT record a success audit: escalate to space-agent with the mismatch and stop. Otherwise recover idempotently — run step 5 (branch deletion is a no-op if the branch is already gone), run step 6 (fast-forward the root checkout — a restart after merge must still sync it), record the step-7 audit artifact if it is absent, and call mark_complete to close the task.
2. Verify all GitHub review conversations are resolved before merging:
   Extract <host>, <owner>, <repo>, and <number> from {{pr_url}} (format: https://<host>/<owner>/<repo>/pull/<number>).
     gh api graphql --hostname <host> -f query='query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{id isResolved comments(first:20){nodes{url}}} pageInfo{hasNextPage endCursor}}}}}' -f owner=<owner> -f name=<repo> -F number=<number>
   If pageInfo.hasNextPage is true, paginate using the endCursor until all pages have been fetched. If any reviewThread has isResolved=false, do NOT merge. Resolve the threads you own by replying on the PR (see the review-thread resolution guidance from the coding phase), and report any remaining threads you cannot resolve per step 4. Auto-resolving conversations is NOT allowed.
3. Verify the external gate covers the CURRENT head, then merge bound to it:
     HEAD_OID=$(gh pr view {{pr_url}} --json headRefOid --jq .headRefOid)
     REVIEW_DECISION=$(gh pr view {{pr_url}} --json reviewDecision --jq .reviewDecision)
     case "$REVIEW_DECISION" in CHANGES_REQUESTED) echo "GitHub reviewDecision is CHANGES_REQUESTED — an outstanding change request stands; do NOT merge." >&2; exit 1;; REVIEW_REQUIRED) echo "GitHub reviewDecision is REVIEW_REQUIRED — the base repository requires an approving GitHub review this gate cannot supply; treat it as an ADMINISTRATIVE blocker per step 4 and never use --admin." >&2; exit 1;; esac
   Re-run the external gate from the coding phase against the CURRENT head: for each bot in your recorded gate set, re-verify its pass — a reaction-signaling bot (Codex) needs a `THUMBS_UP` from a cycle triggered after the last push with the head unchanged since (see the coding-phase gate), and a review-signaling bot needs a review covering the current head (commit.oid equality) with an explicit clean verdict and no changes-requested. Also scan the paginated reviews lookup for any outstanding `CHANGES_REQUESTED` review by ANY author (human or bot) that has not been superseded by a later `APPROVED` from that same author — `reviewDecision` can miss reviews from reviewers outside branch protection, and such a review blocks the merge even when it opened no inline thread. If any verdict is stale or missing, re-trigger that bot (per the coding-phase trigger knowledge), re-wait for it to pass, and do NOT merge until every gate-set bot is fresh on the CURRENT head.
   Confirm your keyed `external-review-gate` note artifact (key "gate") exists, its head OID equals $HEAD_OID, and its recorded base_ref equals the current baseRefName; if the head OR the base changed after approval, BOTH the gate AND the human approval are stale — re-run the FULL external gate and your informal review against the CURRENT head, re-record the artifact, and obtain fresh human sign-off on the new head via space-agent (as in step 4b) BEFORE merging.
   Otherwise merge, bound to the verified head:
     gh pr merge {{pr_url}} --squash --match-head-commit "$HEAD_OID"
   A zero exit does NOT always mean merged — on a merge-queue-required base it only ENQUEUES the PR. Re-query until the PR `state` is MERGED (about once a minute, up to ~10 attempts). If the queue entry is removed or its merge-group check fails (PR open, never MERGED), treat it as a blocker per step 4.
4. On any blocker (merge failed, CI not passing, unresolved threads, stale or missing external gate, DIRTY conflict, BEHIND rebase, BLOCKED ruleset, permissions, merge queue):
   a. Capture WHY — the failure output plus a fresh state snapshot:
        gh pr view {{pr_url}} --json state,mergeable,mergeStateStatus,headRefOid,reviewDecision
        gh pr checks {{pr_url}}
   b. Then EITHER fix it yourself OR escalate:
      - FIXABLE blocker (DIRTY conflict, BEHIND rebase, UNSTABLE because the code fails a required check, an unresolved review thread you can resolve, or a stale external gate): fix it in this PR and push the new head. A push changes the head, so neither the external gate nor the human approval covers it — re-run the FULL gate against the new head (re-trigger the gate-set bots, re-wait for every one to pass, re-run your informal review, re-record the `external-review-gate` artifact), then obtain fresh human sign-off on the new head before merging:
          send_message(target="space-agent",
            message="Post-approval fix on {{pr_url}}: <one-line summary of the fix>. New head <headRefOid> passed the external gate; please re-review and re-approve the CURRENT head, then reply to continue the merge.",
            data: { pr_url: "{{pr_url}}", headRefOid: "<new headRefOid>", reason: "merge_fix_pushed" })
        Then WAIT. When space-agent replies to continue, go to step 3 again and merge bound to the re-verified head. The prior human approval never carries over to a head it was not given.
      - ADMINISTRATIVE blocker (mergeStateStatus BLOCKED or CLEAN = permissions, ruleset, merge queue, or a check failing for reasons outside this PR): you cannot fix these by editing the PR. There is no internal reviewer to re-approve; escalate to space-agent and WAIT:
          send_message(target="space-agent",
            message="Merge blocked on {{pr_url}}: <one-line summary>. The external gate passed but the merge requires something outside the PR (permissions / ruleset / queue). Please resolve or dismiss.",
            data: { pr_url: "{{pr_url}}", blockers: ["<kind: detail>"], headRefOid: "<headRefOid>", reason: "merge_blocked" })
        Then STOP. Do NOT run `gh pr merge` again until space-agent tells you to continue.
   c. When space-agent replies to continue: the head may have changed, so re-run step 1 (state/CI), step 2 (unresolved threads), and step 3 (the external gate covering the CURRENT head). A stale gate on the old head does NOT cover the new one. Only then re-attempt the merge bound to the head you just verified.
5. Delete the PR remote branch — ONLY after a successful merge, and as a SEPARATE command. Do NOT pass a delete flag to the merge command:
     HEAD_REF=$(gh pr view {{pr_url}} --json headRefName --jq .headRefName)
     IS_FORK=$(gh pr view {{pr_url}} --json isCrossRepository --jq .isCrossRepository)
   If IS_FORK is true, SKIP deletion — forked PRs keep their branch in the fork. Otherwise lease-bind the deletion so a REUSED branch is never destroyed: compare the remote ref to the merged head first,
     MERGED_OID=$(gh pr view {{pr_url}} --json headRefOid --jq .headRefOid)
     REMOTE_OID=$(git ls-remote origin "refs/heads/$HEAD_REF" | cut -f1)
   If REMOTE_OID is empty the branch is already gone (no-op). If REMOTE_OID differs from MERGED_OID, the branch name was recreated or advanced after the merge — record a NON-result `note` cleanup_warning artifact (key "branch-delete") and do NOT delete it. Only when they match, delete under the observed lease (so a branch advanced between the check and the push is still not destroyed):
     git push origin --force-with-lease="refs/heads/$HEAD_REF:$REMOTE_OID" --delete "$HEAD_REF"
   Branch cleanup is BEST-EFFORT: on any failure (protected branch, missing delete permission, already gone), record a NON-result `note` cleanup_warning artifact (key "branch-delete") and continue — the PR is already merged.
6. Sync so both this isolated worktree AND the Space checkout track the freshly-merged base branch:
   Resolve the base remote first — the squash merge lands in the BASE repository, which is not necessarily this `origin`:
     BASE=$(gh pr view {{pr_url}} --json baseRefName --jq .baseRefName)
     if [ "$(gh pr view {{pr_url}} --json isCrossRepository --jq .isCrossRepository)" = "true" ]; then
       BASE_REMOTE=$(gh pr view {{pr_url}} --json url --jq .url | sed 's|/pull/[0-9]*$||')
     else
       BASE_REMOTE=origin
     fi
   a. In this isolated worktree, do NOT switch branches — just fetch:
        git fetch "$BASE_REMOTE" "$BASE"
   b. ALSO fast-forward the separate Space checkout that future task worktrees branch from — do NOT skip this, or every later task worktree inherits the stale base:
        SPACE_WS={{workspace_path_sh}}
        if [ "$(git -C "$SPACE_WS" rev-parse --abbrev-ref HEAD)" != "$BASE" ]; then
          # Checkout is on a DIFFERENT branch — pulling $BASE here would move the wrong branch.
          record a NON-result `note` cleanup_warning artifact (key "space-checkout-base") and skip the rest of step b.
        else
          git -C "$SPACE_WS" fetch "$BASE_REMOTE" "$BASE"
          if ! git -C "$SPACE_WS" pull --ff-only "$BASE_REMOTE" "$BASE"; then
            # Pull failed (divergence, permissions) — the PR is already merged; do not block on this.
            record a NON-result `note` cleanup_warning artifact (key "space-checkout-pull") and skip the ahead-check.
          elif [ "$(git -C "$SPACE_WS" rev-parse HEAD)" != "$(git -C "$SPACE_WS" rev-parse FETCH_HEAD)" ]; then
            # pull said "Already up to date" but local $BASE is AHEAD of the fetched base. Compare against FETCH_HEAD — fetching a URL remote records the commit in FETCH_HEAD, not in a <URL>/<branch> ref.
            record a NON-result `note` cleanup_warning artifact (key "space-checkout-ahead") — do NOT claim the checkout is synchronized.
          fi
        fi
7. Save an audit artifact:
     save_artifact({ shape: "link", kind: "merge",
                     data: { url: <merged_pr_url>, merged_at, approval_source: "{{approval_source}}" } })
