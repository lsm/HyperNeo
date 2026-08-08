/**
 * Shared "merge the PR" post-approval instructions template.
 *
 * Delivered to the PR Merger post-approval session by `PostApprovalRouter`
 * when a workflow declares `postApproval.targetAgent = 'merger'`. Template
 * tokens follow the §1.6 grammar evaluated by
 * `post-approval-template.ts:interpolatePostApprovalTemplate`. Recognised tokens:
 *
 *   - `{{pr_url}}`             — signalled by the end node via
 *                              `send_message(task-agent, …, data:{ pr_url })`.
 *   - `{{approval_source}}`    — `'human' | 'agent'` (from `SpaceApprovalSource`).
 *   - `{{workspace_path}}`     — absolute path of the Space checkout (for step 4).
 *   - `{{approval_authority}}` — NAME of the node that approved this task (the
 *                              re-approval authority the Merger reports blockers
 *                              to and waits on): "Review" for Coding/Research,
 *                              "QA" for the Fullstack QA Loop.
 *
 * ## The merge is a deterministic GATE, not prompt instructions (task #866)
 *
 * The merge is performed by the `merge_pr` MCP tool, which deterministically
 * verifies — in code, not in the model's reasoning — that the current PR head is
 * covered by a real GitHub approval before it merges, bound to that head via
 * `--match-head-commit`. Raw `gh pr merge` / merge-API calls are BLOCKED on this
 * slot by a declarative Bash guard (defense-in-depth — it catches the direct and
 * common wrapped forms). The authoritative enforcement is `merge_pr` itself: the
 * Merger must merge through it, and the gate cannot be satisfied by a head that
 * lacks a real current-head approval, regardless of model reasoning.
 *
 * This replaces the previous prompt-only "verify the approval covers the current
 * head" step, which the model reasoned around on task #857: it saw the only
 * approval covered the old head `5f5be646` while the current head was
 * `e7be0167`, inferred that `approval_source: human` overrode the current-head
 * requirement, and merged anyway. `approval_source` is Space TASK-approval
 * provenance only — it records how the task reached `approved`; it is NOT
 * evidence that the current PR head was reviewed and must NEVER be treated as a
 * merge authorization. Do not duplicate or second-guess the gate: when
 * `merge_pr` returns blockers, relay them — do not attempt a raw merge or argue
 * that the task approval should let the merge through.
 *
 * If `merge_pr` returns blockers, the Merger captures them and reports them to
 * the approval authority over the ungated `Post-Approval → Review/QA` channel;
 * the authority re-checks, coordinates the coder (a fix-push changes the head),
 * re-approves the new head on GitHub, and signals the Merger to continue. The
 * Merger then re-calls `merge_pr` (it re-validates the current head from
 * scratch). Cycle-cap exhaustion or an unresolvable blocker escalates to
 * space-agent via the `merge_blocked` artifact + message. The
 * `Post-Approval ↔ Review/QA` channels are added to the built-in workflows in
 * `built-in-workflows.ts`.
 *
 * The runtime appends the universal `mark_complete` instruction in
 * `PostApprovalRouter`; keep this workflow data focused on PR-specific work.
 */
export const PR_MERGE_POST_APPROVAL_INSTRUCTIONS: string = [
  'The task has been approved. Your job is to merge PR {{pr_url}}.',
  '',
  'Approval source: {{approval_source}}. This is Space TASK-approval provenance —',
  'it records how the task reached `approved` (a human clicked Approve, or an agent',
  'approved it). It is NOT evidence that the current PR head was reviewed, and it is',
  'NOT a merge authorization — never treat it as one.',
  '',
  'You are the Merger. Your ONLY job is to merge the PR through the deterministic',
  '`merge_pr` tool. You have NO review authority — never approve, never push commits,',
  'never resolve review threads. If the merge is blocked, report the blockers to the',
  'approval authority and wait.',
  '',
  '## The merge gate (do NOT work around it)',
  '',
  '`merge_pr` is a deterministic gate enforced in code, not instructions you interpret.',
  'It verifies, before any merge is allowed, that ALL of the following hold against the',
  "PR's CURRENT head:",
  '  - the PR is open;',
  '  - a real GitHub `APPROVED` review covers the current head (commit_id == headRefOid),',
  '    OR — for an own-PR where GitHub rejects self-approval — a COMMENTED review on the',
  '    current head carrying the exact body marker "Recommendation: APPROVE", left BY THE',
  '    PR AUTHOR (the fallback is own-PR-only; a marker from anyone else does not count);',
  '  - there is no outstanding CHANGES_REQUESTED review on the current head',
  '    (even if another reviewer approved — dismiss or resolve it first);',
  '  - required CI / checks are passing (not pending or failing);',
  '  - there are zero unresolved review conversations;',
  '  - branch-protection review requirements are satisfied (reviewDecision APPROVED).',
  'It then merges with `--squash --match-head-commit <validatedHead>`, so a push that',
  'moves the head after validation fails the merge instead of merging an unreviewed head.',
  'Raw `gh pr merge` / GraphQL `mergePullRequest` / REST `pulls/<n>/merge` are BLOCKED',
  'on this slot (the guard catches the direct and common wrapped forms). It is',
  'defense-in-depth, not the enforcement — the authoritative gate is merge_pr, so',
  'always merge through it. No `approval_source`, admin, or human signal overrides',
  'a missing current-head approval.',
  'When `merge_pr` returns blockers, accept them; do not argue, self-approve, push,',
  'resolve threads, or retry with a raw merge command.',
  '',
  'Steps:',
  '1. Call the merge gate:',
  '     merge_pr(pr_url="{{pr_url}}", task_id="{{task_id}}")',
  '   It returns { ok, merged, state, headRefOid, blockers: [{kind, detail}] }.',
  '   - If the PR was already MERGED in a prior session, `merge_pr` reports it (ok with',
  '     merged=true, or a pr_not_open blocker noting state=MERGED). Record an audit',
  '     artifact, perform step 4 ONLY (fast-forward the root repository — a restart',
  '     after merge must still sync it, or the root checkout stays stale and every',
  '     later task branched from it inherits the stale base branch), then exit. Do NOT',
  '     save the step-5 merge artifact (no merge happened in this session).',
  '2. Interpret the result:',
  '   a. `ok:true, merged:true` → success. Go to step 3.',
  '   b. `ok:true, merged:false` (state OPEN / queued) → the merge command was accepted',
  '      but GitHub has not reported MERGED yet (a merge-queue-required base only',
  '      ENQUEUES on `gh pr merge`). Poll until the PR state is MERGED, then go to step 3:',
  '        gh pr view {{pr_url}} --json state --jq .state',
  '      MERGED -> step 3. Still open but queued/processing -> keep re-querying. If the',
  '      queue entry is removed or its merge-group check fails (PR open, never MERGED),',
  '      treat that as a blocker and report it per 2c.',
  '   c. `ok:false` (blockers present, OR the merge attempt failed) → capture the',
  '      blockers and a fresh state snapshot for context (do NOT use this analysis to',
  '      override the gate — it is only so your report is actionable):',
  '        gh pr view {{pr_url}} --json state,mergeable,mergeStateStatus,headRefOid,reviewDecision',
  '        gh pr checks {{pr_url}}',
  '      (mergeStateStatus hints: BLOCKED = a branch-protection / ruleset rule;',
  '      BEHIND = head needs a rebase onto the base; UNSTABLE = a required check pending',
  '      or failing; DIRTY = merge conflict; CLEAN = mergeable, so the blocker is',
  '      permissions / merge method / merge queue; UNKNOWN = GitHub recomputing',
  '      mergeability — re-query in ~30s before reporting.)',
  '      Report the blockers to the approval authority: {{approval_authority}} (the node',
  '      that approved this task — "Review" for Coding/Research, "QA" for Fullstack). It',
  '      is the peer over the Post-Approval → {{approval_authority}} channel; confirm it',
  '      is reachable via `list_reachable_agents` before sending (when both Review and',
  '      QA are reachable, as in Fullstack, address {{approval_authority}} specifically',
  '      — do NOT default to Review). Make the message self-instructing so it works even',
  '      if the authority was seeded from an older prompt:',
  '        send_message(target="{{approval_authority}}",',
  '          message="Merge blocked on {{pr_url}}: <one-line summary of the blocker(s).',
  '            The merge_pr gate requires a current-head GitHub approval. Re-check the',
  '            PR, coordinate the implementation author to fix and push, re-approve the',
  '            CURRENT head on GitHub (a real APPROVED review, or — for an own-PR, a',
  "            COMMENTED review from the PR AUTHOR with the body marker 'Recommendation: APPROVE'),",
  '            then reply to me (the Merger) to continue.">',
  '          data: { pr_url: "{{pr_url}}",',
  '                  blockers: ["<kind: detail from merge_pr, e.g. stale_approval: ...>",',
  '                             "<e.g. ci_not_passing: required check CI failing>"],',
  '                  headRefOid: "<headRefOid reported by merge_pr>",',
  '                  reason: "merge_blocked" })',
  '      Then STOP. Do NOT approve, push, resolve threads, or call merge_pr again',
  '      until the approval authority tells you to continue. If the authority replies that the',
  '      blocker is unresolvable (data reason: "unresolvable" — an administrative',
  '      blocker like missing merge permission or a ruleset change it cannot fix), skip',
  '      to 2e and escalate to space-agent instead of continuing to wait.',
  '   d. When the approval authority replies to continue: the head likely changed, so',
  '      re-call `merge_pr` (it re-validates the CURRENT head from scratch — a stale',
  '      approval on the old head does not cover the new one). Interpret the fresh',
  '      result per 2a–2c. If it is blocked again, report the fresh blockers (never',
  '      reuse stale ones).',
  '   e. Cycle cap / genuinely stuck: this Post-Approval ↔ {{approval_authority}} loop',
  '      is bounded by the channel cycle budget (check `list_channels` — the',
  '      Post-Approval ↔ {{approval_authority}} budget specifically; do NOT read an',
  '      unrelated route such as a separate Review channel). If a handoff is rejected',
  '      because the cap is reached, or the approval authority reports a blocker',
  '      neither of you can resolve, escalate to space-agent (NOT merely because',
  '      merges kept failing) — record a NON-result artifact and notify:',
  '        save_artifact({ shape: "note", kind: "merge_blocked",',
  '          summary: "Merge blocked on PR {{pr_url}} (<N> attempts, <exit>)",',
  '          data: { pr_url: "{{pr_url}}", blockers: ["..."], attempts: <N>,',
  '                  exit_reason: "<cycle_cap|unresolvable>" } })',
  '        send_message(target="space-agent", message="Merge blocked on PR',
  '          {{pr_url}} (<N> attempts, exit: <cycle_cap|unresolvable>)",',
  '          data: { pr_url: "{{pr_url}}", blockers: ["..."], attempts: <N>,',
  '                  exit_reason: "<cycle_cap|unresolvable>" })',
  '      Do NOT mark the task complete (the PR is not merged).',
  '3. Delete the PR remote branch — ONLY after a successful merge, and as a SEPARATE',
  '   command. Do NOT pass a delete flag to a merge command; and only delete for',
  '   same-repository heads — forked PRs keep their branch in the fork, so deleting',
  '   from origin would miss or hit an unrelated same-named branch. Assign both values',
  '   with --jq, then branch on the fork check before deleting:',
  '     HEAD_REF=$(gh pr view {{pr_url}} --json headRefName --jq .headRefName)',
  '     IS_FORK=$(gh pr view {{pr_url}} --json isCrossRepository --jq .isCrossRepository)',
  '   If IS_FORK is true, SKIP deletion. Otherwise delete the ref:',
  '     git push origin --delete "$HEAD_REF"',
  '   Branch cleanup is BEST-EFFORT: if deletion fails for any reason (protected',
  '   branch, missing delete permission, already gone), record a NON-result warning',
  '   artifact (e.g. shape:"note", kind:"cleanup_warning", key:"branch-delete") and continue — a kindless `decision` would',
  '   be picked up as the task result on completion. The PR is already merged, so do',
  '   NOT let a cleanup failure block the completion step.',
  '4. Sync so both this isolated worktree AND the Space checkout track the freshly-merged',
  '   base branch. Do NOT skip step b, or every later task branched from a stale',
  '   checkout inherits the stale base branch.',
  '   a. In this isolated worktree, do NOT `git checkout $BASE` and do NOT switch',
  '      branches — the worktree must stay on its task branch. Just fetch:',
  '        BASE=$(gh pr view {{pr_url}} --json baseRefName --jq .baseRefName)',
  '        git fetch origin "$BASE"',
  '   b. ALSO fast-forward the separate Space checkout that future task worktrees',
  '      branch from (createTaskWorktree bases them on its HEAD). Its absolute path is',
  '      supplied below as the configured workspace — use it directly rather than',
  '      inferring a path from git:',
  '        BASE=$(gh pr view {{pr_url}} --json baseRefName --jq .baseRefName)',
  "        SPACE_WS='{{workspace_path}}'",
  '      `git pull --ff-only origin "$BASE"` fast-forwards the CURRENTLY checked-out',
  '      branch, so a checkout not on $BASE would be moved or silently left behind. Guard',
  '      before pulling (each guard records a NON-result cleanup_warning artifact and',
  '      continues):',
  '        if [ "$(git -C "$SPACE_WS" rev-parse --abbrev-ref HEAD)" != "$BASE" ]; then',
  '          # checkout on a different branch — do NOT move it; warn and skip.',
  '          record a NON-result `note` cleanup_warning artifact (key "space-checkout-base"; space not on $BASE) and continue.',
  '        fi',
  '        git -C "$SPACE_WS" fetch origin "$BASE"',
  '        git -C "$SPACE_WS" pull --ff-only origin "$BASE"',
  '        if [ "$(git -C "$SPACE_WS" rev-parse HEAD)" != "$(git -C "$SPACE_WS" rev-parse "origin/$BASE")" ]; then',
  '          # pull said "Already up to date" but local $BASE is AHEAD of origin/$BASE —',
  '          # stray commits remain at HEAD; do NOT claim the checkout is synchronized.',
  '          record a NON-result `note` cleanup_warning artifact (key "space-checkout-ahead"; space $BASE ahead of origin/$BASE) and continue.',
  '        fi',
  '      If the pull itself fails (divergence, permissions), do NOT force it — record a',
  '      NON-result `note` cleanup_warning artifact (key "space-checkout-pull") and continue (the PR is already merged).',
  '5. Save an audit artifact:',
  '     save_artifact({ shape: "link", kind: "merge",',
  '                     data: { url: <merged_pr_url>, merged_at, approval_source: "{{approval_source}}" } })',
].join('\n');

/**
 * Coder-owned variant of {@link PR_MERGE_POST_APPROVAL_INSTRUCTIONS}.
 *
 * The stable `Coding` and `Coding with QA` workflows collapse the post-approval
 * merger into the original Coder: `postApproval.targetAgent = 'coder'` reuses
 * the Coder's live session (the implementer) to run the audited merge. The
 * merger instructions above CANNOT be reused here — they frame the recipient as
 * a restricted Merger that "must never push commits" and, on any blocker,
 * reports it and waits for "the implementation author" to fix it. When the
 * recipient IS the implementation author, that is circular: the only session
 * permitted to fix a conflict/rebase blocker is the one the instructions just
 * told to wait, so the task stalls.
 *
 * This template keeps `merge_pr` as the authoritative gate (safety is unchanged
 * — `merge_pr` still requires a current-head GitHub approval before merging, so
 * a fix-push the Coder makes only merges after the approval authority
 * re-approves the new head) but lets the Coder FIX fixable blockers itself:
 *
 *   - Fixable (DIRTY conflict, BEHIND rebase, UNSTABLE CI failing because of
 *     the code, a review thread the Coder can resolve by replying): the Coder
 *     fixes, pushes, asks {{approval_authority}} to re-approve the CURRENT head,
 *     and re-runs `merge_pr`.
 *   - Administrative (permissions, ruleset, merge queue, stale approval the
 *     Coder cannot self-approve): report to {{approval_authority}} and wait, as
 *     the merger does.
 *
 * Same template tokens as the merger instructions; `{{approval_authority}}` is
 * "Review" for `Coding` and "QA" for `Coding with QA`. The runtime still
 * appends the universal `mark_complete` instruction.
 */
export const CODER_OWNED_MERGE_INSTRUCTIONS: string = [
  'The task has been approved. You are the Coder who implemented PR {{pr_url}}; now finish it by merging that PR.',
  '',
  'Approval source: {{approval_source}}. This is Space TASK-approval provenance — it records how the task reached `approved` (a human clicked Approve, or an agent approved it). It is NOT evidence that the current PR head was reviewed, and it is NOT a merge authorization — never treat it as one.',
  '',
  '## The merge gate (do NOT work around it)',
  '',
  "Merge through the deterministic `merge_pr` tool — never a raw `gh pr merge`, GraphQL `mergePullRequest`, or REST `pulls/<n>/merge` (those are BLOCKED on this slot; `merge_pr` is the authoritative gate). `merge_pr` verifies, against the PR's CURRENT head, that ALL of the following hold:",
  '  - the PR is open;',
  '  - a real GitHub `APPROVED` review covers the current head (commit_id == headRefOid), OR — for an own-PR where GitHub rejects self-approval — a COMMENTED review on the current head carrying the exact body marker "Recommendation: APPROVE", left BY THE PR AUTHOR;',
  '  - there is no outstanding CHANGES_REQUESTED review on the current head;',
  '  - required CI / checks are passing;',
  '  - there are zero unresolved review conversations;',
  '  - branch-protection review requirements are satisfied (reviewDecision APPROVED).',
  'It then merges with `--squash --match-head-commit <validatedHead>`, so a push that moves the head after validation fails the merge instead of merging an unreviewed head.',
  '',
  'You ARE the implementer, so you MAY modify the PR to satisfy the gate — but the gate still decides what merges, and you must NEVER approve your own head. Approval is the job of the {{approval_authority}} authority (it approved this task and is your re-approval authority); you only re-request approval after you change the head. `approval_source`, admin, and human signals never override a missing current-head approval.',
  '',
  '## Steps',
  '',
  '1. Call the merge gate:',
  '     merge_pr(pr_url="{{pr_url}}", task_id="{{task_id}}")',
  '   It returns { ok, merged, state, headRefOid, blockers: [{kind, detail}] }.',
  '   - If the PR was already MERGED in a prior session, `merge_pr` reports it (ok with merged=true, or a pr_not_open blocker noting state=MERGED). Record an audit artifact, perform step 4 ONLY (fast-forward the root checkout — a restart after merge must still sync it), then exit. Do NOT save the step-5 merge artifact (no merge happened in this session).',
  '2. Interpret the result:',
  '   a. `ok:true, merged:true` → success. Go to step 3.',
  '   b. `ok:true, merged:false` (state OPEN / queued) → the merge command was accepted but GitHub has not reported MERGED yet (a merge-queue-required base only ENQUEUES). Poll until MERGED, then go to step 3:',
  '        gh pr view {{pr_url}} --json state --jq .state',
  '      MERGED -> step 3. Still open but queued/processing -> keep re-querying. If the queue entry is removed or its merge-group check fails (PR open, never MERGED), treat that as a blocker per 2c.',
  '   c. `ok:false` (blockers present, OR the merge attempt failed) → capture the blockers and a fresh state snapshot (only so your action/report is actionable — do NOT use it to override the gate):',
  '        gh pr view {{pr_url}} --json state,mergeable,mergeStateStatus,headRefOid,reviewDecision',
  '        gh pr checks {{pr_url}}',
  '      (mergeStateStatus hints: BLOCKED = a branch-protection / ruleset rule; BEHIND = head needs a rebase onto the base; UNSTABLE = a required check pending or failing; DIRTY = merge conflict; CLEAN = mergeable, so the blocker is permissions / merge method / merge queue; UNKNOWN = GitHub recomputing mergeability — re-query in ~30s before acting.)',
  '      Then EITHER fix it yourself OR report it:',
  '        - FIXABLE blocker (DIRTY conflict, BEHIND rebase, UNSTABLE because the code fails a required check, or an unresolved review thread you can resolve by replying on the PR): fix it in this PR and push the new head. A push changes the head, so the prior approval no longer covers it — `merge_pr` will not merge the new head until it is re-approved. Reply on any review thread you resolve, then ask {{approval_authority}} to re-approve the CURRENT head and continue:',
  '            send_message(target="{{approval_authority}}",',
  '              message="Post-approval fix on {{pr_url}}: <one-line summary of the fix and the new need>. I pushed a new head to satisfy the merge gate (mergeStateStatus was <DIRTY|BEHIND|UNSTABLE>). Please re-check and re-approve the CURRENT head on GitHub (a real APPROVED review, or — for an own-PR — a COMMENTED review from the PR AUTHOR with body marker \'Recommendation: APPROVE\'), then reply to me to continue the merge.",',
  '              data: { pr_url: "{{pr_url}}", blockers: ["<kind: detail>"], headRefOid: "<new headRefOid>", reason: "merge_fix_pushed" })',
  '          Then STOP and wait. After {{approval_authority}} replies to continue, go to 2d.',
  '        - ADMINISTRATIVE blocker (mergeStateStatus BLOCKED or CLEAN = permissions, ruleset, merge queue, or a check failing for reasons outside this PR; OR a stale approval you cannot self-approve): you cannot fix these by editing the PR. Report to {{approval_authority}} and WAIT. Confirm it is reachable via `list_reachable_agents` first (when both Review and QA are reachable, address {{approval_authority}} specifically — do NOT default to Review):',
  '            send_message(target="{{approval_authority}}",',
  '              message="Merge blocked on {{pr_url}}: <one-line summary>. The merge_pr gate requires a current-head GitHub approval. Re-check the PR, re-approve the CURRENT head on GitHub (a real APPROVED review, or — for an own-PR — a COMMENTED review from the PR AUTHOR with body marker \'Recommendation: APPROVE\'), then reply to me to continue.",',
  '              data: { pr_url: "{{pr_url}}", blockers: ["<kind: detail>"], headRefOid: "<headRefOid>", reason: "merge_blocked" })',
  "          Then STOP. Do NOT self-approve, resolve others' threads, or call merge_pr again until {{approval_authority}} tells you to continue.",
  '   d. When {{approval_authority}} replies to continue: the head likely changed (or you just pushed a fix), so re-call `merge_pr` (it re-validates the CURRENT head from scratch — a stale approval on the old head does not cover the new one). Interpret the fresh result per 2a–2c. If it is blocked again, repeat 2c (never reuse stale blockers).',
  '   e. Cycle cap / genuinely stuck: this Post-Approval ↔ {{approval_authority}} loop is bounded by the channel cycle budget (check `list_channels` — the Post-Approval ↔ {{approval_authority}} budget specifically; do NOT read an unrelated route). If a handoff is rejected because the cap is reached, or the blocker is unresolvable (data reason "unresolvable" — administrative, neither of you can fix it), escalate to space-agent — record a NON-result artifact and notify:',
  '        save_artifact({ shape: "note", kind: "merge_blocked",',
  '          summary: "Merge blocked on PR {{pr_url}} (<N> attempts, <exit>)",',
  '          data: { pr_url: "{{pr_url}}", blockers: ["..."], attempts: <N>,',
  '                  exit_reason: "<cycle_cap|unresolvable>" } })',
  '        send_message(target="space-agent", message="Merge blocked on PR',
  '          {{pr_url}} (<N> attempts, exit: <cycle_cap|unresolvable>)",',
  '          data: { pr_url: "{{pr_url}}", blockers: ["..."], attempts: <N>,',
  '                  exit_reason: "<cycle_cap|unresolvable>" })',
  '      Do NOT mark the task complete (the PR is not merged).',
  '3. Delete the PR remote branch — ONLY after a successful merge, and as a SEPARATE command. Do NOT pass a delete flag to a merge command; and only delete for same-repository heads — forked PRs keep their branch in the fork:',
  '     HEAD_REF=$(gh pr view {{pr_url}} --json headRefName --jq .headRefName)',
  '     IS_FORK=$(gh pr view {{pr_url}} --json isCrossRepository --jq .isCrossRepository)',
  '   If IS_FORK is true, SKIP deletion. Otherwise delete the ref:',
  '     git push origin --delete "$HEAD_REF"',
  '   Branch cleanup is BEST-EFFORT: on any failure (protected branch, missing delete permission, already gone), record a NON-result `note` cleanup_warning artifact (key "branch-delete") and continue — the PR is already merged, so do NOT let a cleanup failure block completion.',
  '4. Sync so both this isolated worktree AND the Space checkout track the freshly-merged base branch. Do NOT skip step b, or every later task branched from a stale checkout inherits the stale base branch.',
  '   a. In this isolated worktree, do NOT `git checkout $BASE` and do NOT switch branches — the worktree must stay on its task branch. Just fetch:',
  '        BASE=$(gh pr view {{pr_url}} --json baseRefName --jq .baseRefName)',
  '        git fetch origin "$BASE"',
  '   b. ALSO fast-forward the separate Space checkout that future task worktrees branch from. Its absolute path is supplied below as the configured workspace:',
  '        BASE=$(gh pr view {{pr_url}} --json baseRefName --jq .baseRefName)',
  "        SPACE_WS='{{workspace_path}}'",
  '      Guard before pulling (each guard records a NON-result cleanup_warning artifact and continues):',
  '        if [ "$(git -C "$SPACE_WS" rev-parse --abbrev-ref HEAD)" != "$BASE" ]; then',
  '          # checkout on a different branch — do NOT move it; record a NON-result `note` (key "space-checkout-base") and continue.',
  '        fi',
  '        git -C "$SPACE_WS" fetch origin "$BASE"',
  '        git -C "$SPACE_WS" pull --ff-only origin "$BASE"',
  '      If the pull itself fails (divergence, permissions), record a NON-result `note` cleanup_warning artifact (key "space-checkout-pull") and continue (the PR is already merged).',
  '5. Save an audit artifact:',
  '     save_artifact({ shape: "link", kind: "merge",',
  '                     data: { url: <merged_pr_url>, merged_at, approval_source: "{{approval_source}}" } })',
].join('\n');
