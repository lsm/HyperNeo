# Plan: Remove `completionActions` — Task Agent as Post-Approval Executor

**Source plan (authoritative):** [`docs/plans/remove-completion-actions-task-agent-as-post-approval-executor.md`](docs/plans/remove-completion-actions-task-agent-as-post-approval-executor.md) (committed to `dev`)

**Space Task:** #75 (plan) → #79 (this decomposition)

---

## Goal summary

Replace the entire `completionActions` pipeline with a single, uniform post-approval executor: the **Task Agent**. End-node agents signal post-approval intent via a structured `send_message` to `task-agent` carrying `{ pr_url, post_approval_action: 'merge_pr' }`, then call `approve_task()` / `submit_for_approval()` as today. The Task Agent receives the signal, waits for a new `[TASK_APPROVED]` runtime injection, and — gated by space autonomy level via a new `merge_pr(pr_url)` MCP tool — either auto-merges (level ≥ 4) or first asks a human via `request_human_input` (level < 4). On completion this deletes the `CompletionAction` union, its runtime pipeline (`resolveCompletionWithActions` / `resumeCompletionActions` / executors), its RPC intercept, its MCP tool (`approve_completion_action`), the `PendingCompletionActionBanner` UI, and the associated DB columns — while keeping `completionAutonomyLevel` (which controls `approve_task` vs `submit_for_approval` and is orthogonal to merge autonomy). Rollout is staged across 5 stacked PRs targeting `dev`, each dependent on the previous being merged and (for Stages 2–3) deployed long enough to validate the new path.

---

## Work items

### 1. Task Agent `merge_pr` MCP tool + handler + script module (behind feature flag)

**Priority:** high

**Description:** Add a new single-purpose `merge_pr({ pr_url, human_approval_reason? })` MCP tool on the Task Agent's MCP server in `packages/daemon/src/lib/space/tools/task-agent-tools.ts`, with a new handler file `packages/daemon/src/lib/space/tools/task-agent-merge-handler.ts`. The handler validates the GitHub PR URL, re-reads live autonomy via the injected `getSpaceAutonomyLevel` resolver (threshold constant `MERGE_AUTONOMY_THRESHOLD = 4`), refuses calls below the threshold that lack `human_approval_reason`, performs artifact-store idempotency (matching `merged_pr_url`), and executes the merge by reusing the existing `PR_MERGE_BASH_SCRIPT` — hoisted into a new helper module `packages/daemon/src/lib/space/tools/pr-merge-script.ts` and invoked with `cwd = space.workspacePath`, env `HYPERNEO_ARTIFACT_DATA_JSON` / `HYPERNEO_WORKSPACE_PATH`, and a 120s timeout. On success write a `task-agent` artifact recording `merged_pr_url`, `status: 'merged'`, `approval` (`auto_policy` | `human`), and `approvalReason`. Gate registration behind `HYPERNEO_TASK_AGENT_MERGE_EXECUTOR` (env var or `Space.experimentalFeatures` bit) so the tool is defined and tested but not yet visible to agents. Ship with the unit tests listed in §4.6 of the source plan (level ≥ 4 happy path, level < 4 refusal, level < 4 with reason, invalid URL, idempotent re-entry, script failure/stderr, timeout). No workflow prompt or user-facing changes.

**Plan Review caveats to address during implementation (security + UX):**

- **Cross-check `pr_url` against the task's signalled URL.** Before executing, resolve the end-node's `send_message(target: 'task-agent', data: { pr_url, post_approval_action })` payload for the current `taskId` (from the artifact store and/or the structured-data transcript) and refuse the call if `args.pr_url` does not equal the signalled URL. This turns the "narrow tool" promise into an enforced invariant — a prompt-injected or hallucinated URL cannot be merged even at autonomy ≥ 4. Add unit tests: `pr_url mismatch with end-node signal → refused`; `no end-node signal for this task → refused`.
- **Verify a real `request_human_input` response when level < 4.** The current contract (refuse when `human_approval_reason` missing) is model-attestable and can be bypassed by a hallucinating agent inventing a reason string. Preferred: the handler checks that a recent `request_human_input` artifact exists for this task with a non-rejecting response written **after** the `[TASK_APPROVED]` injection, and refuses otherwise. Acceptable fallback if implementation cost is too high: explicitly document the model-attestation limitation in the handler code + Work Item 1 PR description, and rely on the audit log (see bullet below) for forensic detection. Add unit tests: `level < 4 with fabricated reason but no human_input artifact → refused`; `level < 4 with reason + matching artifact → runs`.
- **Env-var parsing in the hoisted bash script.** `pr-merge-script.ts` must parse `HYPERNEO_ARTIFACT_DATA_JSON` via `jq -r` (or equivalent) — never `eval` / `$(…)` expansion of the raw JSON string. `pr_url` is regex-validated upstream, but lock the invariant in the hoisted module so future edits don't regress it.
- **Structured logging for the audit line.** Emit the `task-agent.merge_pr: spaceId=... taskId=... prUrl=... level=... autoApproved=... outcome=... reason=...` line via the structured key-value logger — not format-string concatenation — so `approvalReason` (agent-generated, potentially containing newlines / ANSI) cannot forge adjacent log lines.
- **Snapshot-test the `request_human_input` question format.** §3.3 of the source plan specifies the question template ("Approve merging PR `<pr_url>`?" plus context block). Add a snapshot test that exercises the level < 4 code path end-to-end and pins the question string the Task Agent produces, so prompt drift is caught.
- **Idempotency implementation note (correctness #2).** The `workflow-run-artifact-repository.ts` `listByRun(runId, { nodeId, artifactType })` API filters by `nodeId` + `artifactType` only — it does not support `json_extract` field filters. The idempotency check therefore calls `listByRun(runId, { nodeId: 'task-agent', artifactType: 'result' })` and scans the returned rows in-memory for `record.data.merged_pr_url === pr_url`. Do **not** add a new SQLite index or column to satisfy a literal reading of "query for matching URL". Add a unit test that mocks `listByRun` to return a row with matching `merged_pr_url` and asserts the handler short-circuits without executing the script.

### 2. End-node handoff protocol: prompt changes, Task Agent prompt addition, `[TASK_APPROVED]` injection, feature-flag flip

**Priority:** high

**Description:** Update all five built-in workflows in `packages/daemon/src/lib/space/workflows/built-in-workflows.ts` so every end-node issues `send_message({ target: 'task-agent', message, data: { pr_url, post_approval_action: 'merge_pr' } })` before calling `approve_task()` / `submit_for_approval()`. Concretely: CODING_WORKFLOW Reviewer step 5, RESEARCH_WORKFLOW Review step 6, FULLSTACK_QA_LOOP_WORKFLOW QA steps 5–6 (remove the inline `gh pr merge --squash` and worktree sync entirely — QA no longer merges), REVIEW_ONLY_WORKFLOW step 6 (no merge signal; trim verify-review-posted boilerplate), and PLAN_AND_DECOMPOSE_WORKFLOW (no prompt change required — Dispatcher artifact is evidence). Also update the duplicate `FULLSTACK_QA_PROMPT` constant. Append a new `## Post-Approval Actions` section to the Task Agent system prompt (`packages/daemon/src/lib/space/agents/task-agent.ts`, `buildTaskAgentSystemPrompt`) that teaches the autonomy-gated merge flow (≥4 → `merge_pr` directly; <4 → `request_human_input` first, then `merge_pr` with `human_approval_reason`). Add a new runtime injection `[TASK_APPROVED]` in `packages/daemon/src/lib/space/runtime/space-runtime.ts` at both the auto-approve and `approvePendingCompletion` transition sites, delivered into the task's Task Agent session. Flip `HYPERNEO_TASK_AGENT_MERGE_EXECUTOR` to on. Snapshot-test end-node prompts to lock in the new instruction and assert the legacy `gh pr merge` / completion-action references are gone. Depends on Work Item 1 being deployed.

**User-visible changes to call out in the PR description:**

- **QA-loop workflow:** QA agents no longer invoke `gh pr merge` directly. Post-approval merge is now performed by the Task Agent under a separate autonomy check (level ≥ 4 for auto-merge; otherwise `request_human_input` surfaces a banner). Operators running Coding-with-QA at space level 3 will observe that QA's `approve_task` closes the work but the PR is **not** auto-merged — a human-merge prompt appears instead. This is the intended behaviour post-refactor; it is the same decoupling the source plan describes in §5.
- **Coding + Research workflows:** Reviewer/Research end-nodes still call `approve_task`, but the actual merge now happens asynchronously through the Task Agent after the signal is received. Operators may observe a small latency (seconds) between `approve_task` completing and the PR showing as merged in GitHub.

**Acceptance criteria — critical (correctness #1, #3, #7, #8):**

- **Storage for the `post_approval_action` signal.** Add a transient field `SpaceTask.pendingPostApprovalAction: { action: 'merge_pr'; pr_url: string } | null` to the task row (mapper + repo + shared type). When `agent-message-router` routes a `send_message({ target: 'task-agent', data: { pr_url, post_approval_action } })` from an end-node session, persist that signal onto the currently-active task's `pendingPostApprovalAction`. Clear it once `[TASK_APPROVED]` is injected (or on explicit task reset). This makes the injection **deterministic and restartable** — an in-memory map in `TaskAgentManager` would lose the signal on daemon restart; always-injecting would produce spurious notifications. The new column can piggy-back on Work Item 4's migration (TEXT JSON nullable, no backfill needed since no live rows will have it when migration runs).
- **`[TASK_APPROVED]` injection is gated by `pendingPostApprovalAction != null`.** When a task transitions to `done` with no signal stored, the injection is skipped entirely — matching the source plan §2.3 "Verify NOT injected when no `post_approval_action` was signalled" test case.
- **`[TASK_APPROVED]` text includes `pr_url` and `action`.** Even though the Task Agent also has the structured-data appendix in its context, include the URL + action in the injection body so a test can assert deterministic content.
- **Silent-skip path test.** Add a runtime test: "End node calls `approve_task` without prior `send_message` → task transitions to `done`, `pendingPostApprovalAction` is null, `[TASK_APPROVED]` is **not** injected, Task Agent does not call `merge_pr`." Graceful degradation: the work is approved, merge is the operator's responsibility.
- **Session-wake parity with `[NODE_COMPLETE]`.** The `[TASK_APPROVED]` injection path must resume/wake the Task Agent session if idle — reuse whatever mechanism `[NODE_COMPLETE]` uses (see `task-agent-manager.ts:1822-1834`). AC check: "Task Agent session idle before injection; after injection, the SDK turn completes and the agent calls `merge_pr` or `request_human_input` within the usual turn timeout."
- **`FULLSTACK_QA_PROMPT` duplicate-constant checklist item.** Explicit checkbox in the PR checklist that the QA end-node prompt changes are mirrored in the `FULLSTACK_QA_PROMPT` constant at `built-in-workflows.ts:384-396`. The prompt-snapshot test must cover this constant alongside the per-node `customPrompt`.

### 3. Delete completion-action runtime pipeline, RPC intercept, MCP tool, and UI banner

**Priority:** high

**Description:** Net-negative removal PR (~1500 LOC). Delete `resolveCompletionWithActions`, `resumeCompletionActions`, `executeCompletionAction`, `resolveArtifactData`, `buildAwaitingApprovalReason`, `emitTaskAwaitingApproval` from `packages/daemon/src/lib/space/runtime/space-runtime.ts`; collapse the two call sites (~lines 613 and 1561) to a new small helper `resolveTaskCompletion(workflow, spaceLevel)` that handles only the now-universal "no actions" case. Delete `packages/daemon/src/lib/space/runtime/completion-action-executors.ts` and `packages/daemon/src/lib/space/runtime/pending-action.ts` in their entirety. Remove the `resumeCompletionActions` public API from `space-runtime-service.ts`. Delete the `approve_completion_action` handler + tool registration in `packages/daemon/src/lib/space/tools/space-agent-tools.ts`. Delete the `pendingCheckpointType === 'completion_action'` intercept inside `spaceTask.update` in `packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts`. Update the `approve_task` tool description string in `task-agent-tools.ts` to stop referencing the removed pipeline. Delete `packages/web/src/components/space/PendingCompletionActionBanner.tsx` and remove all mount / routing references in `TaskStatusActions.tsx`, `SpaceTaskPane.tsx`, and `packages/web/src/lib/space-store.ts`. Remove all `completionActions: [...]` node entries and the `MERGE_PR_*`, `VERIFY_PR_MERGED_*`, `VERIFY_REVIEW_POSTED_*`, `PLAN_AND_DECOMPOSE_VERIFY_*` constants + scripts from `built-in-workflows.ts` (preserving the hoisted `PR_MERGE_BASH_SCRIPT` in `pr-merge-script.ts` from Work Item 1). Drop the tests enumerated in §4.5 of the source plan and update the surviving tests (`space-agent-tools.test.ts`, `end-node-handlers.test.ts`, `built-in-workflows.test.ts`, `space-task-handlers.test.ts`, `space-store.test.ts`, plus prompt-text assertions). Depends on Work Item 2 being deployed long enough to confirm the new path works in practice.

**User-visible regressions to call out in the PR description (Plan Review has given explicit sign-off on these as acceptable tradeoffs — see Open Questions §4):**

- **Review-Only workflow — `verify-review-posted` removed.** Today: if a Reviewer calls `approve_task` without actually posting a review on GitHub, the runtime's verify script catches the lie and blocks the task. After this change: the task closes cleanly with no warning — an operator who wants to confirm the review exists must inspect GitHub manually. At autonomy level 1 the `submit_for_approval` path gives the operator a chance to catch the lie; at level ≥ 2 (where `approve_task` auto-closes) there is no runtime gate. Mitigation is deferred; revisit as a follow-up `verify_review_posted` Task Agent tool if operator feedback indicates the check was load-bearing.
- **Plan-and-Decompose workflow — `verify-tasks-created` removed.** Same shape as above. Today: the runtime refuses to mark the Dispatcher task `done` unless at least one task was created. After this change: the task closes cleanly even if no tasks were dispatched. The Dispatcher already calls `save_artifact({ created_task_ids })`, which stands as an audit trail but not a gate. Mitigation deferred (optional follow-up `verify_tasks_created` Task Agent tool).
- **Post-action approval UX change.** The `Awaiting Human Approval` banner (per-action modal with Approve/Reject buttons) is gone. Operators now answer the Task Agent's `request_human_input` question in free text via the standard conversation input, with the `TaskBlockedBanner` providing the visual cue. This is a simplification, not a regression, but it is a visible workflow change for existing users.

**Security follow-ups for the deletion sweep:**

- Add a `rg "merge_pr"` grep step to the PR checklist and confirm the symbol is not inadvertently registered by `createNodeAgentMcpServer` or `createSpaceAgentMcpServer` (`packages/daemon/src/lib/space/tools/`). The only registration site must remain `createTaskAgentMcpServer`.

**Architecture note (architecture-reviewer observation):**

- Keep the new `resolveTaskCompletion(workflow, spaceLevel)` helper as a **private method inside `space-runtime.ts`** near the two collapsed call sites — do **not** extract it to a new file. It is an implementation detail of the completion resolution path, not a public API.

### 4. Schema cleanup + shared types + DB migration

**Priority:** high

**Description:** Remove the `CompletionAction` union, `ScriptCompletionAction`, `InstructionCompletionAction`, `McpCallCompletionAction`, `CompletionActionBase`, `McpCallExpectation`, and `WorkflowNode.completionActions` from `packages/shared/src/types/space.ts`. Drop `SpaceTask.pendingActionIndex` / `pendingAction`, the `'completion_action'` variant of `SpaceTask.pendingCheckpointType`, and `SpaceWorkflowRun.completionActionsFiredAt`. Simplify `packages/shared/src/space/workflow-autonomy.ts`: delete `EMPTY_ACTIONS_AUTONOMY_THRESHOLD`, `isAutonomousWithoutActions`, `BlockingAction`, `BlockingWorkflow`, `AutonomousWorkflowCount`, `isWorkflowAutonomousAtLevel`, `countAutonomousWorkflows`, `collectCompletionActions`, and replace with a single `isWorkflowAutoClosingAtLevel(wf, level)` that checks only `level >= (wf.completionAutonomyLevel ?? 5)`. Update the UI summary copy to "N of M auto-close at level X". Add a new SQLite migration in `packages/daemon/src/storage/schema/migrations.ts` that: (1) rewrites any live `pending_checkpoint_type = 'completion_action'` rows to `'task_completion'` with `pending_action_index = NULL` (defensive — Work Item 3 stopped producing them), (2) drops the `pending_action_index` column via the table-rebuild pattern used by migration 99, (3) tightens the `CHECK` constraint to `IN ('gate', 'task_completion')`, (4) drops `completion_actions_fired_at` from `space_workflow_runs`. Strip unknown `completionActions` fields from any user-authored workflow JSON on load (soft-migration) and emit a `workflow.migrated` notification. Update `space-task-repository.ts` and `space-workflow-run-repository.ts` mappers. Also lower `FULLSTACK_QA_LOOP_WORKFLOW.completionAutonomyLevel` from 4 → 3 (QA no longer merges; auto-merge autonomy is now enforced by the `merge_pr` tool handler) with an inline comment explaining the rationale. Rewrite `packages/shared/tests/workflow-autonomy.test.ts`. Can be squashed into Work Item 3 if the combined diff remains reviewable. Depends on Work Item 3.

**In-flight run migration UX — describe in the PR description and implement:**

- **What operators see.** A task paused at `pendingCheckpointType = 'completion_action'` at the moment the daemon upgrades will be rewritten to `'task_completion'` (step 1 of the migration). In the UI, the task transitions from the now-deleted `PendingCompletionActionBanner` (which showed the specific action — e.g. "Approve merge of PR #123") to the generic `PendingTaskCompletionBanner` ("Submit for Approval" / "Approve work"). The action-specific context — which PR was about to be merged, which review was expected — is **lost** in the migration; the operator sees only the reviewer's original `submit_for_approval` reason string (or a generic "completion_action migrated" placeholder if that field is empty).
- **Emit a one-time `task.migrated` notification** on the affected task(s): a transient toast delivered via the existing `notification` LiveQuery, with body `"A pending post-approval action on task '<title>' was converted to a standard approval request during the upgrade. Review the PR manually before approving."` This gives operators a visible cue that migration rewrote state and prompts them to inspect GitHub before clicking Approve.
- **Runbook note in the changelog entry** (cross-reference with Work Item 5): document the migration window, suggest operators drain completion-action-paused tasks before upgrading if practical, and describe the `task.migrated` notification so the support channel knows the expected user report.

**`workflow.migrated` notification — specify format and UX:**

- **Trigger:** `SpaceWorkflowManager` load-time strip of unknown `completionActions` fields on a user-authored workflow JSON.
- **Surface:** one-time banner **on the affected workflow's editor page** (not a global toast — the event is workflow-scoped and should persist until the user acknowledges). Use the existing banner pattern from `WorkflowEditor` with a dismiss button that stores ack in the workflow row (e.g. `workflow.migration_acked_at`).
- **Body copy:** `"This workflow was migrated: the deprecated 'completionActions' field was removed. The workflow will continue to run; if you previously relied on a merge/verify action, the Task Agent now handles post-approval merging automatically based on space autonomy level. <a>Learn more</a>"` with a link to the Work Item 5 changelog section.
- **Behaviour:** the workflow **continues to run** during and after the migration — no manual re-save required. If the workflow JSON also fails schema validation after the strip (should not happen in practice but possible if the user had other custom fields), surface a second `workflow.validation_failed` notification with the specific field name.

**QA workflow autonomy drop 4 → 3 — PR description callout:**

- **Behavioural intent change.** Before: Coding-with-QA required space level 4 to self-close because the QA agent was the merger. After: the QA agent no longer merges (that moved to the Task Agent `merge_pr` tool in Work Items 1–3), so self-close threshold lowers to 3 — aligned with Coding. Auto-merge still requires level 4 (enforced by the `merge_pr` handler, not the workflow). Net effect: spaces at level 3 running Coding-with-QA will now see QA tasks self-close without human intervention where they previously required human approval; merge still requires human approval at level 3. Call this out in the migration notes and changelog.
- **Operator-facing migration note** (enforced via Work Item 5 changelog entry): `"If your space runs the QA workflow at autonomy level 3, tasks will now auto-close without human approval on work quality (auto-merge still requires level 4). To preserve the old behaviour, copy the built-in workflow into a custom one and set completionAutonomyLevel: 4."`

**DB migration acceptance criteria (correctness #5):**

- The entire migration — step 1 (UPDATE of legacy `completion_action` rows), step 2 (table rebuild to drop `pending_action_index`), step 3 (CHECK-constraint tightening), step 4 (drop `completion_actions_fired_at`) — must be wrapped in a **single `BEGIN … COMMIT` transaction**. A daemon crash mid-rebuild with partial steps applied leaves the DB with the old CHECK constraint and partially-modified rows. Follow the transaction pattern already used by the existing migrations in `packages/daemon/src/storage/schema/migrations.ts`.
- The new `SpaceTask.pendingPostApprovalAction` column (added per Work Item 2's AC) should land in the same migration as a nullable `TEXT` column storing JSON `{ action, pr_url }`, no backfill needed.

**Soft-migration implementation specifics (correctness #6):**

- The unknown-field stripping pass lives in `SpaceWorkflowManager.loadWorkflow()` (or the equivalent load-time entry point in `packages/daemon/src/lib/space/managers/space-workflow-manager.ts`) — **not** in the shared-types validator. Implement it as an `unknownFieldStripper(workflow, schema)` helper that removes any top-level or `nodes[].*` field absent from the current schema, returning the stripped payload plus a `strippedFields: string[]` list.
- `workflow.migrated` is a **structured daemon log line**, not an RPC event or in-app notification: `workflow.migrated: workflowId=<id> workflowName=<name> strippedFields=[completionActions,…]`. The user-facing banner described above (per-workflow editor banner with dismiss) is a **separate** UX surface driven from a new `workflow.migration_acked_at` column on the workflow row; the daemon log line is for operator observability / CI / log aggregation.

### 5. Docs refresh, E2E coverage, changelog, and rollout closeout

**Priority:** normal

**Description:** Include an operator-facing migration note in the changelog entry for the QA workflow behavioural change: `"If your space runs the QA workflow at autonomy level 3, tasks will now auto-close without human approval on work quality (auto-merge still requires level 4). To preserve the old behaviour, copy the built-in QA workflow into a custom one and set completionAutonomyLevel: 4."` Add a closing section to `docs/research/pr-merging-completion-actions.md` pointing at this plan and its PR chain. Update `docs/design/autonomy-levels-and-completion-actions.md` to reflect the removal. Add a changelog entry describing the breaking change (shared types, built-in workflow schema, DB columns) and the new `HYPERNEO_TASK_AGENT_MERGE_EXECUTOR` flag default. Sweep the repo for other stale references (grep for `completionActions`, `CompletionAction`, `approve_completion_action`, `pendingActionIndex`, `PendingCompletionActionBanner`, `completionActionsFiredAt`, `MERGE_PR_COMPLETION_ACTION`, `VERIFY_PR_MERGED_COMPLETION_ACTION`, `VERIFY_REVIEW_POSTED_COMPLETION_ACTION`, `PLAN_AND_DECOMPOSE_VERIFY_COMPLETION_ACTION`, `resolveCompletionWithActions`, `resumeCompletionActions`, `executeCompletionAction`, `EMPTY_ACTIONS_AUTONOMY_THRESHOLD`). Add the three E2E tests from §4.6 of the source plan: `task-agent-merge-autonomy-high.e2e.ts` (level 4 auto-merge), `task-agent-merge-autonomy-low.e2e.ts` (level 1 human-approves-through-`request_human_input` path), and `task-agent-merge-human-rejects.e2e.ts` (level 1 human rejection — merge skipped, task stays `done`, audit artifact written). Provide a `tests/e2e/helpers/mock-gh.sh` PATH shim for the mock GitHub CLI if the existing E2E fixture infrastructure doesn't already cover it. Add online-test runs under `packages/daemon/tests/online/space/` simulating full Coding / Research / QA runs with dev-proxy at representative autonomy levels. Add the structured daemon log line `task-agent.merge_pr: spaceId=... taskId=... prUrl=... level=... autoApproved=bool outcome=... reason=...` described in §6.4. Manually trigger E2E in CI for UI changes (`PendingCompletionActionBanner` removal) per the workflow_dispatch pattern. Depends on Work Item 4.

---

## Dependencies

- Work Item 2 depends on Work Item 1 being **deployed** (not just merged) so the `merge_pr` tool is live when prompts start emitting the signal.
- Work Item 3 depends on Work Item 2 being **deployed long enough to validate** the new path in practice (catches any prompt regressions before the old pipeline is deleted).
- Work Item 4 depends on Work Item 3 being merged. May be squashed into Work Item 3 at the author's discretion if the combined diff remains reviewable, but keeping them separate keeps the migration safer.
- Work Item 5 depends on Work Item 4.

All PRs stack linearly: 1 → 2 → 3 → 4 → 5. Each targets `dev` and uses squash merge.

---

## Out of scope

- **Renaming `completionAutonomyLevel`.** It stays — it independently controls `approve_task` vs `submit_for_approval`, orthogonal to merge autonomy. A rename (e.g. to `workApprovalAutonomyLevel`) would cost a schema migration without user-visible benefit; defer indefinitely.
- **Reintroducing verification hooks as post-approval actions.** `verify-review-posted` (Review-Only) and `verify-tasks-created` (Plan-and-Decompose) are deleted as part of Work Item 3; regressions are accepted per §4.3 of the source plan. A follow-up `verify_tasks_created` Task Agent tool can be added later if operator feedback says the check was load-bearing.
- **Dropping `space_task_report_results` table.** Confirmed orphaned but kept in place; a later cleanup migration can drop it once a full-repo audit confirms no writers remain.
- **Exposing `merge_pr` to node-agent or space-agent sessions.** Intentional: the tool is registered solely via `createTaskAgentMcpServer`. Do not add it to `createNodeAgentMcpServer` / `createSpaceAgentMcpServer`.
- **Arbitrary shell access for the Task Agent.** `merge_pr` is a deliberate, documented, single-purpose policy exception. The "orchestrator only" contract in the Task Agent prompt is preserved for every other action.
- **Migrating user workflows that declare `completionActions[…]`.** Handled by a soft-migration (strip unknown fields, emit `workflow.migrated` notification). A one-shot data migration is only added in Stage 4 if the soft-migration assumption proves wrong.
- **Documentation for user-authored post-approval actions beyond `merge_pr`.** The MCP tool only supports `merge_pr` at launch; other `post_approval_action` values are treated as unsupported and escalated via `request_human_input` per the Task Agent prompt.

---

## Plan Review feedback addressed

All 4 reviewers (ux, security, architecture, correctness) on PR #1592 voted **APPROVE**. Their caveats have been folded into the relevant work item descriptions above and do **not** require re-opening the plan:

**UX reviewer (4 caveats):**
- **ux #1 (regressions):** Review-Only / Plan-and-Decompose verification loss surfaced in Work Item 3; QA autonomy drop surfaced in Work Items 2 and 4.
- **ux #2 (in-flight run migration UX):** Folded into Work Item 4 — `PendingCompletionActionBanner` → `PendingTaskCompletionBanner` transition described; `task.migrated` notification specified.
- **ux #3 (`workflow.migrated` notification):** Folded into Work Item 4 — per-workflow banner, copy, dismiss behaviour, and schema-validation fallback specified.
- **ux #4 (snapshot-test `request_human_input` question):** Folded into Work Item 1.

**Security reviewer (5 recommendations):**
- **security #1 (bind `pr_url` to signalled URL):** Folded into Work Item 1.
- **security #2 (verify real `request_human_input` response at level < 4):** Folded into Work Item 1 with acceptable-fallback path described.
- **security #3 (`jq`-based env-var parsing):** Folded into Work Item 1.
- **security #4 (structured logging for audit line):** Folded into Work Item 1.
- **security #5 (grep sweep for stray `merge_pr` registrations):** Folded into Work Item 3.

**Architecture reviewer (clean approve + 3 minor observations):**
- **arch #1 (`resolveTaskCompletion` stays private in `space-runtime.ts`, no new file):** Folded into Work Item 3.
- arch #2 + #3 (WI 2 cross-cutting kept-together, soft-migration defensive) were already the plan's posture — no edit needed.

**Correctness reviewer (1 critical + 5 notable + 2 minor):**
- **correctness #1 (`[TASK_APPROVED]` storage mechanism — critical):** Folded into Work Item 2 as an AC — new `SpaceTask.pendingPostApprovalAction` JSON column, survives daemon restart, gated injection.
- **correctness #2 (idempotency is in-memory scan, not direct SQL):** Folded into Work Item 1.
- **correctness #3 (silent-skip test for missing `send_message`):** Folded into Work Item 2.
- **correctness #4 (QA autonomy-drop operator migration note in changelog):** Folded into Work Items 4 and 5.
- **correctness #5 (DB migration transactional):** Folded into Work Item 4.
- **correctness #6 (soft-migration location specificity):** Folded into Work Item 4 — `SpaceWorkflowManager.loadWorkflow` + structured daemon log line `workflow.migrated`.
- **correctness #7 (`FULLSTACK_QA_PROMPT` duplicate checklist):** Folded into Work Item 2.
- **correctness #8 (session wake-up parity on `[TASK_APPROVED]`):** Folded into Work Item 2.

## Open questions

Carried forward verbatim from §7 of the source plan — each has a recommended decision; flagged here in case Plan Review wants to override before dispatch.

1. **Artifact-based idempotency vs. a new `space_task_merges` table.** Source plan recommends the artifact store (`type: 'result', data.merged_pr_url`). Low risk, zero schema cost. Accept the recommendation unless a reviewer calls it out.
2. **`merge_pr` artifact namespace.** Recommended: `nodeId: 'task-agent'` (provenance-clear, matches `task-agent-tools.ts:294`). No expected pushback.
3. **FULLSTACK_QA_LOOP_WORKFLOW `completionAutonomyLevel` drop 4 → 3.** Recommended in Work Item 4 and Appendix B of the source plan. Call out in the Work Item 4 PR description as a behavioural intent change so Plan Review can sign off.
4. **Verification regressions for Review-Only and Plan-and-Decompose.** Recommended: accept the regression in Stage 3; revisit as a follow-up if operator feedback demands it.
5. **Runtime enrichment of `request_human_input` context.** Recommended: no — let the Task Agent use the `pr_url` the end-node supplied plus the artifact trail. Re-evaluate if the human-facing question text is too thin in practice.
6. **Should `merge_pr` ever be exposed to non-Task-Agent sessions?** No — keep it registered solely on `createTaskAgentMcpServer`.

If any of these need to be flipped, adjust the affected work item's description before dispatch.
