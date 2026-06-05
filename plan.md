# Plan: Redesign Workflow Gates as MCP Action Hooks

## Goal summary

Replace NeoKai workflow gates and gate-side polling with configurable workflow MCP hooks that execute at real MCP action boundaries (`send_message`, `submit_for_approval`, `approve_task`, `save_artifact`, and future node-agent actions). Today gates act as a parallel state machine: agents write gate data, gate scripts validate asynchronously, routing reacts, and pollers can inject synthetic messages even after node work is complete. New hooks will live in the workflow definition, run inside MCP tool handling with bounded typed results, validate or patch the originating action before routing/approval occurs, record hook-local state and recent results, and remove arbitrary workflow mutation or endless background poll behavior. All new schema, prompts, UI labels, and runtime APIs must use `node` terminology, not `role`.

## Work items

### 1. Add shared workflow hook schema, validation, and storage migration

**Priority:** high

**Description:** Add typed hook definitions to `packages/shared/src/types/space.ts` and persisted workflow JSON under `SpaceWorkflow.hooks` (or equivalent), without deleting existing `gates` yet. Model hooks around `enabled`, `sourceNode`, optional `targetNode`, `method`, `templateData`, `validator`, retry/poll settings, and `localState`/recent-result references; include bounded result union types for `allow`, `block`, `retryable_block`, `patch_params`, `emit_follow_up`, and `record_state`. Update workflow create/update validators and repository mappers so malformed hook definitions fail closed and scripts/results are bounded by size/time/type. Add migration/backfill support that leaves legacy gates intact until migration work items convert built-ins.

**Acceptance criteria:** Shared types compile; workflow persistence round-trips hook config; validators reject unknown MCP methods, invalid node references, mixed gate/hook-only fields, unbounded script result shapes, and `role` terminology in new schema names. Add daemon/shared unit tests for serialization and validation.

### 2. Build runtime hook engine and MCP action integration

**Priority:** high

**Description:** Create a workflow hook engine in `packages/daemon/src/lib/space/runtime/` that receives structured action context before selected node-agent MCP handlers execute. Wire it into `createNodeAgentToolHandlers` around `send_message`, `save_artifact`, `submit_for_approval`, `approve_task`, and `mark_complete` where registered, so hooks can allow/block/patch params, emit controlled follow-up MCP actions, and persist hook-local state/recent results. Context must include method name/params, caller node execution id, node id/name, session id, task id, workflow run id, target node when applicable, workflow definition, run state, current/prior artifacts, hook-local state, and permitted external lookup context. Results must be typed and bounded; scripts can run only through sandboxed executors with explicit timeouts and output caps.

**Acceptance criteria:** Hook engine is deterministic, fail-closed for validation hooks, avoids arbitrary workflow mutation, logs/audits hook decisions, and records recent hook status for UI debugging. Unit tests cover allow, block, retryable block, param patch, local state update, follow-up action emission, malformed script output, timeout, and multiple hooks on one action.

### 3. Replace channel gate evaluation with hook-driven message validation

**Priority:** high

**Description:** Refactor message delivery so `send_message` hooks replace gate data writes and gate evaluation for guarded handoffs. `AgentMessageRouter`/`ChannelRouter` should treat channel topology as routing only; action hooks decide whether the originating MCP call may proceed and may patch its params before routing. Keep legacy gate support temporarily for existing custom workflows, but built-in templates should move to hook definitions and prompts should stop telling agents to write gate data. Ensure hook recovery cannot reactivate completed node executions or terminal workflow runs unless an explicit live action triggers valid routing.

**Acceptance criteria:** Gated handoffs still activate target nodes when hook validation passes; blocked/retryable hooks return structured MCP errors to caller without spawning target sessions; terminal/completed node executions are not reopened by stale gate/hook state. Add regression tests for completed/review-state runs not receiving new synthetic messages or reactivation after hook recovery.

### 4. Migrate `code-pr-gate` and plan/research PR-ready gates to `send_message` hooks

**Priority:** high

**Description:** Convert PR-ready gate behavior from `code-ready-gate`, `plan-pr-gate`, `research-ready-gate`, and `code-pr-gate` variants into hooks on source-node `send_message` actions targeting review/planning-review nodes. The hook should require/resolve `pr_url` from template data or params, validate the exact GitHub PR is open and mergeable, check unresolved review threads where the old gate did, and allow or retryably block the original send. Built-in workflow prompts should say “send_message with `data: { pr_url }`; hook validates PR readiness” instead of referencing gate writes or gate resets.

**Acceptance criteria:** Built-in workflows use hook config for PR-ready handoffs; `PR_READY_BASH_SCRIPT` logic is preserved or moved into a typed validator; old poll config is removed from these handoffs. Tests cover missing PR URL, closed PR, unknown mergeability (retryable), non-mergeable PR, unresolved threads, and successful handoff.

### 5. Migrate `review-approval-gate` and plan approval voting to action hooks

**Priority:** high

**Description:** Convert reviewer approval and multi-reviewer voting flows into hooks attached to reviewer-node actions to QA, Task Dispatcher, or approval handoff. The hook should validate the reviewer action context, accumulate typed approval votes in hook-local state when needed, and only allow downstream node activation after configured vote thresholds pass. For review feedback to coder nodes, keep the existing “review posted” validation but move it from gate script checks to a `send_message` hook on Review → Coding.

**Acceptance criteria:** Fullstack Review → QA, Plan Review → Task Dispatcher, and Review → Coding feedback flows work through hooks with no gate writes. Vote accumulation survives daemon restart via persisted hook state and resets only on intentional revision cycles. Tests cover vote deep-merge/race behavior, rejection feedback reset, review evidence validation, and threshold activation.

### 6. Move Codex reaction checking to `submit_for_approval`/approval hooks

**Priority:** high

**Description:** Replace `requireCodexApproval`, `codex_review_bot` gate feature, and Codex poll injection with hooks on `submit_for_approval` and relevant `approve_task`/approval handoff actions. The hook validates the latest PR head, inspects Codex reactions or triggers allowed external lookups, and returns `allow`, `block`, or `retryable_block` with clear structured errors instead of injecting repeated synthetic poll messages. Hook-local state should record latest checked head SHA, Codex reaction state, timeout window, and terminal allow/block outcome.

**Acceptance criteria:** Codex checks never inject endless messages; stale `+1` on old head blocks/retries; `eyes` returns retryable; terminal allow/block stops retries; task entering `review` or pending task-completion approval stops background checking. Tests reproduce task #512-style stale polling and prove no messages arrive after review/pending approval/completion.

### 7. Remove/retire gate poll loops and prevent completed node reactivation

**Priority:** high

**Description:** Delete or disable `GatePollManager` behavior for built-in workflows and replace any needed retry behavior with hook retry state and caller-facing retryable errors. Update runtime recovery and tick handling so completed node executions cannot be reactivated by stale gate open state, poll refresh, or hook recovery; only a valid live MCP action from an active node can cause routing. Clean up gate-open cache behavior and terminal-run handling to avoid resurrecting old gate state.

**Acceptance criteria:** No built-in workflow starts gate-side poll timers; terminal task/run/node states are hard tombstones for hook recovery unless explicit supported reopen path exists. Add regression tests for done/review/approved tasks, cancelled runs, archived tasks, daemon restart with stale hook state, and old poll config in persisted custom workflows.

### 8. Expose hook configuration and recent results in workflow editor UI

**Priority:** normal

**Description:** Evolve the current `GateEditorPanel`/visual workflow editor into hook UI using node terminology. Add toggle on/off, MCP method selector, source node selector, target node selector when applicable, template data editor, validator/script selector or editor, retry/poll knobs, and recent hook result/status display for debugging. Keep legacy gate UI visible only for legacy workflows during migration, or clearly label it deprecated.

**Acceptance criteria:** Users can create/edit hooks from workflow editor, see recent hook status and errors, and never see `role` labels in new hook UI. Component tests cover all required controls, validation errors, target selector behavior, result/status rendering, and migration display for legacy gates.

### 9. Update built-in workflows, prompts, and migration compatibility

**Priority:** high

**Description:** Rewrite built-in workflow definitions in `built-in-workflows.ts` to use hooks for PR readiness, review approval, plan approvals, Codex reaction validation, and review-posted checks. Update prompts to remove gate-writing instructions and describe hook-validated MCP actions. Provide compatibility handling for existing custom workflows still using `gates`: either translate known gate patterns to hooks on load/update or continue legacy gate evaluation with deprecation warnings until a later removal.

**Acceptance criteria:** Built-in workflow tests snapshot the new hook configs and prompts; no built-in prompt asks to write or read gates for progression. Legacy workflows still load, and known built-in clones can be migrated without losing behavior.

### 10. Add end-to-end runtime tests and documentation/changelog

**Priority:** normal

**Description:** Add focused daemon unit/integration tests for hook-driven workflows and update docs/changelog for operators. Cover Coding → Review, Fullstack Review → QA, Plan & Decompose approvals, Codex retry behavior, review feedback cycles, restart recovery, and UI config serialization. Document new hook result contract, script output limits, external lookup policy, migration behavior, and deprecation path for legacy gates/polls.

**Acceptance criteria:** `./scripts/test-daemon.sh` targeted shards pass for updated runtime tests; web component tests pass for editor changes; docs explain how to configure hooks and why gates/polls were replaced. No e2e tests unless explicitly requested later.

## Dependencies

- Work Item 2 depends on Work Item 1.
- Work Items 3, 4, 5, and 6 depend on Work Item 2.
- Work Item 7 depends on Work Items 3 and 6, and should land after built-in workflows no longer depend on polls.
- Work Item 8 depends on Work Item 1 and can proceed in parallel with runtime migration once hook schema is stable.
- Work Item 9 depends on Work Items 4, 5, and 6; it may be split so prompt updates land with each migration.
- Work Item 10 depends on all implementation items but should add targeted tests alongside each PR where practical.

Recommended stacked PR order: schema/storage → hook engine → PR-ready hooks → approval/review hooks → Codex hooks + poll retirement → UI → docs/final cleanup.

## Out of scope

- Removing all legacy gate support for user-authored workflows in the first implementation wave.
- Adding arbitrary workflow mutation from hooks; hook results remain limited to typed actions listed above.
- Supporting arbitrary MCP methods beyond node-agent workflow actions until the core methods are stable.
- Rewriting Space task autonomy or post-approval execution model except where hooks must validate `submit_for_approval`/`approve_task`.
- Adding new E2E tests in this task; current instruction says E2E updates are paused.
- Changing GitHub repo rules, branch protections, or merge policy.

## Open questions

1. Should legacy custom gates be auto-translated to hooks on workflow load, or should they continue to run through legacy gate code with a deprecation warning until users edit them?
2. Should hook-local state live inside the existing workflow-run artifact store, a new hook-state table keyed by `(run_id, hook_id)`, or a JSON column on workflow run state?
3. For scripts, should supported interpreters match existing gate scripts (`bash`, `node`, `python3`) or narrow to `bash`/built-in validators for security?
4. What exact timeout should Codex approval use after hook migration: keep current 10-minute guidance, make it per-hook configurable, or remove timeout and require explicit retry?
5. Should `patch_params` be allowed for all MCP methods, or only `send_message` data/template enrichment until more test coverage exists?
