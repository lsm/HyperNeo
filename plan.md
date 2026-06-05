# Plan: Redesign Workflow Gates as MCP Action Hooks

## Goal summary

Replace NeoKai workflow gates and gate-side polling with configurable workflow MCP hooks that execute at real MCP action boundaries (`send_message`, `submit_for_approval`, `approve_task`, `save_artifact`, and future node-agent actions). Today gates act as a parallel state machine: agents write gate data, gate scripts validate asynchronously, routing reacts, and pollers can inject synthetic messages even after node work is complete. New hooks will live in the workflow definition, run inside MCP tool handling with bounded typed results, validate or patch the originating action before routing/approval occurs, record hook-local state and recent results, and remove arbitrary workflow mutation or endless background poll behavior. All new schema, prompts, UI labels, and runtime APIs must use `node` terminology, not `role`.

## Work items

### 1. Add shared workflow hook schema, validation, and storage migration

**Priority:** high

**Description:** Add typed hook definitions to `packages/shared/src/types/space.ts` and persisted workflow JSON under `SpaceWorkflow.hooks` (or equivalent), without deleting existing `gates` yet. Model hooks around `enabled`, `sourceNode`, optional `targetNode`, `method`, `templateData`, `validator`, retry/poll settings, and `localState`/recent-result references; include bounded result union types for `allow`, `block`, `retryable_block`, `patch_params`, `emit_follow_up`, and `record_state`. Update workflow create/update validators and repository mappers so malformed hook definitions fail closed and scripts/results are bounded by size/time/type. Add migration/backfill support that leaves legacy gates intact until migration work items convert built-ins.

**Acceptance criteria:** Shared types compile; workflow persistence round-trips hook config; validators reject unknown MCP methods, invalid node references, mixed gate/hook-only fields, unbounded script result shapes, and `role` terminology in new schema names. Schema includes explicit `authorizedCallers` (source node names and optional agent slot names) as the hook replacement for gate field writers; absent/empty caller lists fail closed unless the hook is marked `humanOnly`. Built-in workflow hooks use built-in validator ids rather than custom scripts wherever possible. Custom script hooks initially support only `bash` and run with existing credential-stripped gate-script environment plus an explicit per-hook external lookup allowlist (GitHub-only for PR/Codex validators); `node` and `python3` script hooks are deprecated and not used for new built-ins. Add daemon/shared unit tests for serialization, validation, caller authorization, interpreter narrowing, and external lookup allowlist validation.

### 2. Build runtime hook engine and MCP action integration

**Priority:** high

**Description:** Create a workflow hook engine in `packages/daemon/src/lib/space/runtime/` that receives structured action context before selected node-agent MCP handlers execute. Wire it into `createNodeAgentToolHandlers` around `send_message`, `save_artifact`, `submit_for_approval`, `approve_task`, and `mark_complete` where registered, so hooks can allow/block/patch params, emit controlled follow-up MCP actions, and persist hook-local state/recent results. Context must include method name/params, caller node execution id, node id/name, session id, task id, workflow run id, target node when applicable, workflow definition, run state, current/prior artifacts, hook-local state, and permitted external lookup context. Results must be typed and bounded; scripts can run only through sandboxed executors with explicit timeouts and output caps.

**Acceptance criteria:** Hook engine is deterministic, fail-closed for validation hooks, avoids arbitrary workflow mutation, logs/audits hook decisions, and records recent hook status for UI debugging. Hook chain composition is explicit: hooks run in workflow order by `order` then `id`; all matching hooks run against the current params unless a non-retryable `block` occurs; `block` takes precedence over `retryable_block`, both take precedence over mutations; multiple `patch_params` results apply sequentially and then the final patched params must re-enter the full original tool handler path, including channel topology checks, target resolution, field/writer authorization, autonomy checks, and audit logging. `emit_follow_up` may only enqueue a whitelisted MCP method with typed params and must dispatch through the same public tool handler pipeline as a real call (no direct router/repository mutation); follow-up depth is capped at one per hook evaluation to prevent loops. Hook results map to a single normalized `WorkflowHookUserState` object consumed by MCP errors, task banners, and hook debug UI: `allow` continues silently with optional debug record; `patch_params` continues and records patched keys after full re-validation; `emit_follow_up` continues only after the follow-up action succeeds or fails through the full pipeline and records emitted action ids; `record_state` continues and records state keys; `block` returns a non-retryable MCP error, sets task/node-visible status `blocked_by_hook`, and shows a banner message with hook label, method, reason, remediation, and source node; `retryable_block` returns a retryable MCP error, records next retry time/attempt count, and shows `waiting_on_hook_retry` banner state with a manual "Retry now" action where safe. Unit tests cover allow, block, retryable block, param patch with full re-validation, follow-up action through handler pipeline, local state update, malformed script output, timeout, multiple hooks on one action, conflict precedence, and normalized user-state mapping for each result type.

### 3. Replace channel gate evaluation with hook-driven message validation

**Priority:** high

**Description:** Refactor message delivery so `send_message` hooks replace gate data writes and gate evaluation for guarded handoffs. `AgentMessageRouter`/`ChannelRouter` should treat channel topology as routing only; action hooks decide whether the originating MCP call may proceed and may patch its params before routing. Keep legacy gate support temporarily for existing custom workflows, but built-in templates should move to hook definitions and prompts should stop telling agents to write gate data. Ensure hook recovery cannot reactivate completed node executions or terminal workflow runs unless an explicit live action triggers valid routing.

**Acceptance criteria:** Gated handoffs still activate target nodes when hook validation passes; blocked/retryable hooks return structured MCP errors to caller without spawning target sessions; terminal/completed node executions are not reopened by stale gate/hook state. Add regression tests for completed/review-state runs not receiving new synthetic messages or reactivation after hook recovery.

### 4. Migrate `code-pr-gate` and plan/research PR-ready gates to `send_message` hooks

**Priority:** high

**Description:** Convert PR-ready gate behavior from `code-ready-gate`, `plan-pr-gate`, `research-ready-gate`, and `code-pr-gate` variants into hooks on source-node `send_message` actions targeting review/planning-review nodes. The hook should require/resolve `pr_url` from template data or params, validate the exact GitHub PR is open and mergeable, check unresolved review threads where the old gate did, and allow or retryably block the original send. Built-in workflow prompts should say “send_message with `data: { pr_url }`; hook validates PR readiness” instead of referencing gate writes or gate resets. User-visible mapping: missing/closed/non-mergeable PR produces `blocked_by_hook` with banner copy “PR is not ready for Review” plus exact GitHub reason and fix; GitHub mergeability/status `UNKNOWN` produces `waiting_on_hook_retry` with “Waiting for GitHub mergeability/checks” and next retry time; unresolved review threads produce `blocked_by_hook` with unresolved thread URLs.

**Acceptance criteria:** Built-in workflows use hook config for PR-ready handoffs; `PR_READY_BASH_SCRIPT` logic is preserved or moved into a typed validator; old poll config is removed from these handoffs. Tests cover missing PR URL, closed PR, unknown mergeability (retryable), non-mergeable PR, unresolved threads, successful handoff, MCP error payload copy, and task-banner state for block vs retryable block.

### 5. Migrate `review-approval-gate` and plan approval voting to action hooks

**Priority:** high

**Description:** Convert reviewer approval and multi-reviewer voting flows into hooks attached to reviewer-node actions to QA, Task Dispatcher, or approval handoff. The hook should validate the reviewer action context, accumulate typed approval votes in hook-local state when needed, and only allow downstream node activation after configured vote thresholds pass. For review feedback to coder nodes, keep the existing “review posted” validation but move it from gate script checks to a `send_message` hook on Review → Coding.

**Acceptance criteria:** Fullstack Review → QA, Plan Review → Task Dispatcher, and Review → Coding feedback flows work through hooks with no gate writes. Vote accumulation survives daemon restart via persisted hook state and resets only on intentional revision cycles. Tests cover vote deep-merge/race behavior, rejection feedback reset, review evidence validation, and threshold activation.

### 6. Move Codex reaction checking to `submit_for_approval`/approval hooks

**Priority:** high

**Description:** Replace `requireCodexApproval`, `codex_review_bot` gate feature, and Codex poll injection with hooks on `submit_for_approval` and relevant `approve_task`/approval handoff actions. The hook validates the latest PR head, inspects Codex reactions or triggers allowed external lookups, and returns `allow`, `block`, or `retryable_block` with clear structured errors instead of injecting repeated synthetic poll messages. Hook-local state should record latest checked head SHA, Codex reaction state, timeout window, and terminal allow/block outcome.

**Acceptance criteria:** Codex checks never inject endless messages; stale `+1` on old head blocks/retries; `eyes` returns retryable; terminal allow/block stops retries; task entering `review` or pending task-completion approval stops background checking. User-visible retry state says “Waiting for Codex review on latest PR head” with head SHA, last reaction (`none`, `eyes`, stale `+1`, current `+1`), next retry time, elapsed timeout, and “Retry now” action; terminal block says “Codex review did not pass” with exact reason and latest checked head. Tests reproduce task #512-style stale polling and prove no messages arrive after review/pending approval/completion.

### 7. Remove/retire gate poll loops and prevent completed node reactivation

**Priority:** high

**Description:** Delete or disable `GatePollManager` behavior for built-in workflows and replace any needed retry behavior with hook retry state and caller-facing retryable errors. Update runtime recovery and tick handling so completed node executions cannot be reactivated by stale gate open state, poll refresh, or hook recovery; only a valid live MCP action from an active node can cause routing. Clean up gate-open cache behavior and terminal-run handling to avoid resurrecting old gate state.

**Acceptance criteria:** No built-in workflow starts gate-side poll timers; terminal task/run/node states are hard tombstones for hook recovery unless explicit supported reopen path exists. Add regression tests for done/review/approved tasks, cancelled runs, archived tasks, daemon restart with stale hook state, and old poll config in persisted custom workflows.

### 8. Expose hook configuration, human approval, and recent results in workflow editor/UI

**Priority:** high

**Description:** Evolve the current `GateEditorPanel`/visual workflow editor and task banner surfaces into hook UI using node terminology. Add toggle on/off, MCP method selector, source node selector, target node selector when applicable, template data editor, validator/script selector or editor, authorized callers editor, external lookup allowlist display, retry/poll knobs, and recent hook result/status display for debugging. Replace `PendingGateBanner` for hook-driven human approval with `PendingHookBanner`: shows hook label, source/target node, blocked action, reason, remediation, last result, retry controls for `retryable_block`, and Approve/Reject controls only for hooks whose typed result requests human approval. Keep legacy gate UI visible only for legacy workflows during migration, clearly label it deprecated, and show how legacy gates map to hooks.

**Acceptance criteria:** Users can create/edit hooks from workflow editor, approve/reject human hook checkpoints from the task banner, retry safe retryable hook blocks, see recent hook status and errors, and never see `role` labels in new hook UI. Component tests cover all required controls, validation errors, target selector behavior, result/status rendering, `PendingHookBanner` approve/reject/retry states, PR-ready block copy, Codex retry copy, and migration display for legacy gates.

### 9. Update built-in workflows, prompts, and migration compatibility

**Priority:** high

**Description:** Rewrite built-in workflow definitions in `built-in-workflows.ts` to use hooks for PR readiness, review approval, plan approvals, Codex reaction validation, and review-posted checks. Update prompts to remove gate-writing instructions and describe hook-validated MCP actions. Make the custom workflow migration decision in this work item rather than leaving it to dispatch: known built-in gate patterns are auto-translated to equivalent hook configs on load/update with a structured migration warning; unknown custom gates continue on the legacy gate path for one release with a deprecated badge and docs link, then become read-only until manually converted.

**Acceptance criteria:** Built-in workflow tests snapshot the new hook configs and prompts; no built-in prompt asks to write or read gates for progression. Legacy workflows still load; known built-in clones migrate without behavior loss; unknown custom gates show deprecation UX and remain functional for one release.

### 10. Add end-to-end runtime tests and documentation/changelog

**Priority:** normal

**Description:** Add focused daemon unit/integration tests for hook-driven workflows and update docs/changelog for operators. Cover Coding → Review, Fullstack Review → QA, Plan & Decompose approvals, Codex retry behavior, review feedback cycles, restart recovery, and UI config serialization. Document new hook result contract, script output limits, external lookup policy, migration behavior, and deprecation path for legacy gates/polls.

**Acceptance criteria:** `./scripts/test-daemon.sh` targeted shards pass for updated runtime tests; web component tests pass for editor changes; docs explain how to configure hooks and why gates/polls were replaced. Operator docs include hook result-to-banner mapping, human approval flow, retryable block behavior, legacy custom-gate migration/deprecation timeline, script credential-stripping policy, external lookup host allowlists, and troubleshooting via recent hook results. No e2e tests unless explicitly requested later.

## Dependencies

- Work Item 2 depends on Work Item 1.
- Work Items 3, 4, 5, and 6 depend on Work Item 2.
- Work Item 7 depends on Work Items 3 and 6, and should land after built-in workflows no longer depend on polls.
- Work Item 8 depends on Work Items 1 and 2 and must land before built-in hook migration is considered complete, because task banners are required for human approval and retryable-block UX.
- Work Item 9 depends on Work Items 4, 5, and 6; it may be split so prompt updates land with each migration.
- Work Item 10 depends on all implementation items but should add targeted tests alongside each PR where practical.

Recommended stacked PR order: schema/storage → hook engine → UI/task banners → PR-ready hooks → approval/review hooks → Codex hooks + poll retirement → built-in workflow migration → docs/final cleanup.

## Out of scope

- Removing all legacy gate support for user-authored workflows in the first implementation wave.
- Adding arbitrary workflow mutation from hooks; hook results remain limited to typed actions listed above.
- Supporting arbitrary MCP methods beyond node-agent workflow actions until the core methods are stable.
- Rewriting Space task autonomy or post-approval execution model except where hooks must validate `submit_for_approval`/`approve_task`.
- Adding new E2E tests in this task; current instruction says E2E updates are paused.
- Changing GitHub repo rules, branch protections, or merge policy.

## Open questions

1. Should hook-local state use a new table keyed by `(run_id, hook_id)` or be stored as workflow-run artifacts? Recommended: new table for current state plus append-only artifacts for audit/history.
2. Should Codex approval keep the current 10-minute timeout as default while allowing per-hook override? Recommended: yes, default 10 minutes with bounded min/max.
3. Should `patch_params` launch with all MCP methods or only `send_message`? Recommended: only `send_message` in first release, with full re-validation; expand after more tests.
