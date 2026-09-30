# Agent Session Prompt & Tool-Guidance Delivery Map

**Scope:** how every kind of agent session in HyperNeo receives its instructions for *how to use the MCP tools and runtime subsystems*.
**Method:** static read of the post-refactor daemon (`packages/daemon`), the shared prompt library (`packages/prompts`), the SDK option builder, the Space runtime, and the MCP server/tool registries. Version: `0.41.0` tree.
**Related prior work:** `docs/prompt-audit.md` (token audit of prompt builders), `docs/research/node-agent-initial-prompt-size.md` (node kickoff sizing), `docs/research/node-agent-mcp-loss-root-cause.md` (MCP attach/replace semantics), `docs/mcp-audit.md` (MCP registration).

---

## 0. Executive summary

1. **There is no runtime "prompt registry".** A session's understanding of its tools comes from **four independent channels** that are assembled at different times and by different subsystems:
   1. the **system prompt** (`config.systemPrompt`, usually `{preset:'claude_code'}` plus an `append`);
   2. **kickoff / injected user messages** (task brief, `## Runtime Execution Contract`, runtime notices);
   3. **MCP tool schemas** — every attached MCP server contributes its own tool `description` strings automatically;
   4. **skill plugins** (`SKILL.md` + slash commands) plus the SDK's built-in `claude_code` preset tool documentation.
2. **`packages/prompts` is a compile-time library, not a service.** Each `*.md` file has YAML-ish frontmatter with an `id`, and is imported into `mod.ts` with `with { type: 'text' }`. `loader.ts` expands `<!-- include: ... -->` directives and throws on missing includes/cycles/duplicate ids. All consumers import the same frozen `SCREAMING_CASE` constants.
3. **Tool naming convention:** an MCP tool is exposed to the model as `mcp__<mcpServers key>__<tool>`. The two Space keys are `space-agent-tools` (**88 tools**) and `node-agent` (**22 tools**). Additional servers: `space-actions` (dispatcher: `call_action`/`list_actions`/`describe_action`), `agent-memory` (4 tools), `db-query` (3 tools). See Appendix A.
4. **Rename hygiene is mostly clean.** No `send_feedback`, `step-agent`, `WorkflowStep`, or `report_result` tool remnants exist in `packages/` (only historical `docs/plans/` references). The `send_feedback → send_message` and `step → node` migrations landed.
5. **The biggest coverage gap after the refactor:** *ad-hoc Space member* sessions are given the entire `space-agent-tools` surface with **no narrative prompt at all** — only the per-tool descriptions. The always-on space surface is narrated for `space_chat` and long-term agents, but not for members.
6. **Residual drift worth fixing** (ranked in §5): a dual `space-agent` vs `@space-manager` identity in tool text and prompts; a `swe` vs `coder` vocabulary split; dispatcher guidance baked into prompts while the dispatcher server is behind an env flag; and an internal MCP server `name: 'space-agent'` that does not match its registered key `space-agent-tools`.

---

## 1. The four prompt channels (mechanism)

### 1.1 System prompt (per query)
`QueryOptionsBuilder.buildSystemPrompt()` (`packages/daemon/src/lib/agent/query-options-builder.ts:693`) resolves in this order:

| Case | Result |
| --- | --- |
| `config.systemPrompt` is a **string** | the string (plus worktree-isolation text if the session is a worktree) |
| `config.systemPrompt` is `{type:'preset', preset:'claude_code', append?}` | preset + `append` (+ worktree text) |
| `config.systemPrompt` undefined, `tools.useClaudeCodePreset !== false` | bare `{preset:'claude_code'}` (+ worktree text) |
| `config.systemPrompt` undefined, `useClaudeCodePreset === false` | worktree text only, else `undefined` |

`buildCustomSystemPrompt()` (line 726) is the same for explicit configs. `joinSystemPromptAppendParts()` (line 754) joins non-empty parts with `\n\n`.

The `claude_code` preset is what supplies generic tool-usage doctrine (Edit/Write/Bash/Task/Skill/TodoWrite/…). Space sessions **replace or append to that preset**, they never remove it except in the `space_chat` branch below.

### 1.2 Kickoff / injected user messages (Space node + post-approval agents)
`TaskAgentManager` builds a node agent's **initial user message**, not its system prompt:

- `buildCustomAgentTaskMessage()` (`packages/daemon/src/lib/space/agents/custom-agent.ts:179`) emits `## Your Task`, `## Runtime Location`, optional `## Linked Goal`, `## Relevant Scope Lessons`, `## Your Role in This Workflow` (workflow/node/peers/channels/hook-validated handoffs), `## Previous Work on This Goal`, `## Core Memories`, `## Relevant Memories`, `## Project Context`, `## Standing Instructions` (space + workflow instructions). It warns above a 4 KiB soft limit.
- `TaskAgentManager.buildNodeExecutionRuntimeContract()` (`task-agent-manager.ts:3218`) then produces a `## Runtime Execution Contract` block that names the node/role, lists the available typed node tools (`send_message`, `save_artifact`, `list_artifacts`, `restore_node_agent`, …), the dispatcher line, escalation target, and the end-node `approve_task` vs `submit_for_approval` decision — **including whether autonomy currently unlocks self-approval**.
- The contract is appended to the kickoff message in `spawn-flow.ts` (`task-agent-manager.ts:1119`): `runtimeContract ? \`${kickoffBase}\n\n${runtimeContract}\` : kickoffBase`. It is **not** part of the system prompt, so it is not re-sent when a session is reused.
- Post-approval sessions reuse the same path but the kickoff is the interpolated post-approval template plus `POST_APPROVAL_COMPLETION_INSTRUCTIONS` (`post-approval-router.ts:93`).

Runtime-generated follow-up notices (compaction nag `PROMPT_TOO_LONG_CONTINUE_NAG`, restart-recovery note, pending-message digests, `[TASK_EVENT]` notifications) are delivered later as user messages via the mailbox/injection pipelines.

### 1.3 MCP tool descriptions (always attached)
Every `tool(name, description, schema, handler)` call in `node-agent-tools.ts`, `space-agent-tools.ts`, `agent-memory-tools.ts`, `db-query/tools.ts`, and `space-actions-server.ts` contributes a natural-language description and parameter schema. This is the **only** guidance ad-hoc member sessions receive.

The `space-actions` dispatcher is special: `buildCallActionDescription()` (`packages/daemon/src/lib/space/actions/description-generator.ts:95`) generates the `call_action` tool description **dynamically per role**, listing up to 6 "hot actions" with `Params`/`Returns`/autonomy lines, then points at `list_actions`/`describe_action`.

### 1.4 Skill plugins
`buildPluginsFromSkills()` / `buildPluginsFromBuiltinSkills()` (`query-options-builder.ts:1086/1109`) turn enabled skills into SDK `plugins: [{type:'local', path}]`. Built-in `space-coordination` is `enabled: true, spaceOnly: true` (`packages/daemon/src/lib/builtins.ts:88`) and is therefore injected into **any session with `context.spaceId`**. Its `SKILL.md` is a documented fallback that calls Space RPC over Bash when the MCP surface is missing. MCP-server skills only surface registry servers; they never gate tools (see `docs/features/skills.md`).

---

## 2. Session-type inventory (at a glance)

| Session / agent kind | `session.type` | System prompt source | Tool how-to source | MCP servers attached (map key) |
| --- | --- | --- | --- | --- |
| Plain worker chat (no Space) | `worker` | `preset:claude_code` (+ worktree text) | preset tool docs + tool descriptions | registry/skills only (`strictMcpConfig`) |
| Space chat / coordinator | `space_chat` | `buildSpaceChatSystemPrompt()` (string) | `SPACE_CHAT_*` narrative | `space-agent-tools`, `agent-memory`, `db-query`, `space-actions` |
| Workflow node agent | `worker` (sub-session) | `preset:claude_code` + append(template instructions + slot customPrompt) | slot customPrompt + `## Runtime Execution Contract` (kickoff) + tool descriptions | `node-agent`, `agent-memory`, `space-actions` |
| Long-term Space agent | `worker` (`space:<sid>:agent:<aid>`) | `preset:claude_code` + append(agent instructions + Owner Review Contract + Scheduling Guardrail) | those prompts + tool descriptions | `space-agent-tools`, `agent-memory`, `db-query`, `space-actions` |
| Ad-hoc Space member | `worker` (space-scoped) | **none specific** (default preset) | **tool descriptions only** | `space-agent-tools`, `agent-memory`, `db-query`, `space-actions` |
| Universal/global read | any, no `spaceId` | default preset | tool descriptions (`space-actions` only) | `space-actions` |
| Legacy task agent | `space_task_agent` | legacy | legacy | none (owner `none`) |
| Coordinator-mode chat | `worker` + `config.coordinatorMode` | preset + specialists' prompts | coordinator/subagent prompts + preset | registry/skills |
| GitHub router / security | one-shot SDK query | `ROUTER_AGENT_SYSTEM_PROMPT` / `SECURITY_AGENT_SYSTEM_PROMPT` | those prompts | none |
| Post-approval node agent | `worker` (sub-session) | same as node agent | merge instructions + `POST_APPROVAL_COMPLETION_INSTRUCTIONS` (kickoff) | `node-agent`, `agent-memory`, `space-actions` |
| Helper LLM calls | n/a | `WORKFLOW_SELECTOR_INSTRUCTIONS`, `TITLE_GENERATION_PROMPT`, limit classifier | inline | none |
| Retired: `neo` | migrated → `worker` + archived | — | — | — |

Session type authority: `packages/shared/src/types.ts:50` (`SessionType = 'worker' | 'lobby' | 'space_task_agent' | 'space_chat'`); the DB CHECK constraints in `migrations.ts` also carry legacy types (`planner`, `coder`, `leader`, `general`, `lobby`, `spaces_global`, `neo`, `room_chat`).

---

## 3. Per-session-type detail

### 3.1 Space chat / coordinator (`space_chat`)
- **Identity:** `space:chat:<spaceId>` (`space-runtime-service.ts`), role `coordinator`, owner `space-runtime` (`space-mcp-session-policy.ts:54`).
- **System prompt:** `session.setRuntimeSystemPrompt(buildSpaceChatSystemPrompt({...}))` (`space-runtime-service.ts:1848`), stored on `config.systemPrompt` as a **plain string**, so `buildSystemPrompt` returns it verbatim (the `space_chat` restriction block at `query-options-builder.ts:491` only strips a *preset object*, so the narrative prompt survives). Sections: `SPACE_CHAT_INTRO`, workflow/agent summaries, `SPACE_CHAT_WORKFLOW_LISTING_NOTE`, `SPACE_CHAT_WORK_CREATION`, `SPACE_CHAT_SUBAGENTS`, `SPACE_CHAT_EVENT_HANDLING`, autonomy block (`SPACE_CHAT_AUTONOMY_3/4/5/LOW`), escalation (`SPACE_CHAT_ESCALATION_ACT`/`ASK`), `SPACE_CHAT_COORDINATION_INVARIANTS`, then `LONG_HORIZON_OWNER_REVIEW_CONTRACT` and `LONG_HORIZON_SCHEDULING_GUARDRAIL`, then space background/instructions.
- **Tool how-to:** the coordination-invariants line is the only explicit MCP statement: *"space-agent-tools MCP must be available every turn… If coordination tools are missing, tell the user the Space MCP surface is unavailable."* Concrete tool names appear inline: `create_standalone_task`, `suggest_workflow`, `get_workflow_detail`, `get_task_detail`, `get_workflow_run`.
- **Tools/MCP:** `sdkToolsPreset = LONG_HORIZON_AGENT_BUILTIN_TOOLS`; `buildSystemPrompt`/restriction keeps those built-ins and **disallows** `Edit/Write/MultiEdit/NotebookEdit`; MCP map key `space-agent-tools` (from `createSpaceAgentMcpServer`), plus conditional `agent-memory`, `db-query`, `space-actions` (role `coordinator`).
- **Self-heal:** `ensureSpaceChatMcpInvariant()` (`query-runner.ts:1682`) checks the required servers on each query build and calls `onMissingSpaceChatMcpServers` → `setupSpaceAgentSession(space)` re-attaches.

### 3.2 Workflow node agent
- **Identity:** sub-session of a task (`…:task:<id>:exec:<id>`); role `workflow_worker`, owner `task-agent-manager` (`space-mcp-session-policy.ts:72`).
- **System prompt:** `createCustomAgentInit()`/`resolveAgentInit()` (`custom-agent.ts:448/522`) → `resolveCustomAgentPrompt()` merges the stored agent template `instructions` (base) with the **workflow slot** `customPrompt` (via `buildSlotOverrides`, `spawn-slot-resolution.ts:67`) unless `replaceAgentPrompt`. Result installed as `{preset:'claude_code', append:<merged>}`.
- **Tool how-to:** three layers —
  1. the slot `customPrompt` (e.g. `CODER_OWNED_REVIEW_PROMPT`) names tools directly (`approve_task`, `submit_for_approval`, `send_message`, `save_artifact`, `subscribe_pr_events`);
  2. the kickoff `## Runtime Execution Contract` (autonomy-aware tool list, escalation target, end-node terminal guidance);
  3. the per-tool descriptions on the `node-agent` server.
- **MCP:** `node-agent` (22 tools) + `agent-memory`; plus `space-actions` (`buildSpaceActionsDispatcherServer`, `task-agent-manager.ts:5344`) when `HYPERNEO_SPACE_ACTIONS_DISPATCHER` is enabled → `nodeRole = myAgentName`.
- **Prompt provenance:** `promptProvenance` is recorded (`workflow_node_custom_prompt` / `workflow_node_replaced_prompt` / `space_agent_custom_prompt` / `empty`) and logged.

### 3.3 Long-term Space agent (goal owner, "Space Manager"/"Task Manager" etc.)
- **Identity:** canonical `space:<spaceId>:agent:<agentId>` with `metadata.promptProvenance.agentId`; role `long_term_agent` (`space-mcp-session-policy.ts:97`).
- **System prompt:** `buildAgentSessionConfig()` (`session-resolution/agent-session-config.ts:31`) → `append = instructions + LONG_HORIZON_OWNER_REVIEW_CONTRACT + LONG_HORIZON_SCHEDULING_GUARDRAIL`; `sdkToolsPreset = LONG_HORIZON_AGENT_BUILTIN_TOOLS`; a per-agent SDK subagent keyed from the display name (`agents[agentKey]`), features restricted (`rewind/worktree/coordinator/archive/sessionInfo` off).
- **Tool how-to:** the owner-review contract and scheduling guardrail are the primary tool doctrine (`create_goal`, `trigger_goal_task`, `review_goal_outcome`, `create_scheduled_task`, `create_standalone_task`, `Cron*`/`ScheduleWakeup`/`Monitor`); the agent's own `instructions` (template: **Space Manager** = `LH_COORDINATOR_INSTRUCTIONS`, **Task Manager** = `LH_TASK_MANAGER_INSTRUCTIONS`) name `list_tasks`, `get_task_detail`, `list_goals`, `update_task`, `update_goal`, `send_message_to_task`, `assign_agent_to_goal`, etc.
- **MCP:** `space-agent-tools`, plus `agent-memory`, `db-query`, `space-actions` (role `long_term_agent`). `attachLongTermAgentMcpServersForSession()` also wires the `onMissingMemberSpaceMcpServers` self-heal.

### 3.4 Ad-hoc Space member
- **Identity:** any `worker` session with `context.spaceId` that is neither a node execution nor a long-term agent → role `ad_hoc_member`, `attachGenericSpaceTools: true` (`space-mcp-session-policy.ts:110`).
- **System prompt:** none specific. `buildSystemPrompt` returns the default `claude_code` preset (or a bare worktree prompt); `attachSpaceToolsToMemberSession()` (`space-runtime-service.ts:1596`) only merges MCP servers and never calls `setRuntimeSystemPrompt`.
- **Tool how-to:** **purely the 88 `space-agent-tools` descriptions + the dynamic `call_action` dispatcher description.** Nothing tells the member that it is in a Space, that `space-agent-tools` is the coordination surface, or which tools are hot. This is the main asymmetry introduced/left by the refactor.

### 3.5 Coordinator-mode chat session
- `config.coordinatorMode` sets `queryOptions.agent = 'Coordinator'` and injects the specialist map from `getCoordinatorAgents()` (`coordinator-agents.ts`): `Coordinator`, `Coder`, `Debugger`, `Tester`, `Reviewer`, `VCS`, `Verifier`, each carrying its `packages/prompts/src/coordinator/*.md` prompt. When the session is a worktree, `getWorktreeIsolationText()` is appended to every **specialist** prompt (`query-options-builder.ts:552`). These subagents use SDK built-ins only; no Space MCP servers.

### 3.6 GitHub router / security agents
- One-shot SDK queries with `systemPrompt: ROUTER_AGENT_SYSTEM_PROMPT` (`github/router-agent.ts:218`) and `systemPrompt: SECURITY_AGENT_SYSTEM_PROMPT` (`github/security-agent.ts:178`). They are JSON-classifier prompts with an explicit output schema and no tool usage.

### 3.7 Post-approval session
- Spawned by `PostApprovalRouter` / `TaskAgentManager.spawnPostApprovalSubSession`. Kickoff = `interpolatePostApprovalTemplate(...)` + `appendPostApprovalCompletionInstructions()` → the `CODER_OWNED_MERGE_INSTRUCTIONS` text (which itself `include`s `CALL_ACTION_PREFERENCE_GUIDANCE`) followed by `POST_APPROVAL_COMPLETION_INSTRUCTIONS` (use `mark_complete`; on blockage `send_message(target="space-agent")` and save a non-result note; never `approve_task`). Uses the node-agent MCP surface.

### 3.8 Helper LLM calls
- Workflow selection: `buildSelectionPrompt()` ends with `Instructions:\n${WORKFLOW_SELECTOR_INSTRUCTIONS}` (`llm-workflow-selector.ts:146`).
- Title generation: `TITLE_GENERATION_PROMPT` (`session-lifecycle.ts`).
- Usage-limit classification: `limit-error-llm-classifier.ts`.

### 3.9 Retired / legacy
- `neo` session type is migrated to `worker` + archived (`migrations.ts` ~7510). Legacy types `planner`/`coder`/`leader`/`general`/`lobby`/`spaces_global`/`room_chat` remain in CHECK constraints but have no dedicated prompt path. `space_task_agent` is the legacy task agent (role `legacy_task_agent`, no required servers).

---

## 4. Where the prompt text lives (`packages/prompts`)

| Directory | Consumed by |
| --- | --- |
| `agents/presets/*` | `seed-agents.ts` → agent templates; `PRESET_CODER_PROMPT` backs the `swe` worker template, `PRESET_RESEARCH_PROMPT` backs `research`; `PRESET_PLANNER_PROMPT`/`PRESET_GENERAL_PROMPT`/`LEGACY_REVIEWER_PROMPT` are now test/migration-only |
| `agents/system-contracts/*` | Reviewer/QA node slots (`built-in-workflows.ts`, `system-contracts.ts`, `seed-agents.ts`) |
| `agents/long-horizon/*` + `long-horizon-scheduling-guardrail.md` | `buildAgentSessionConfig`, `buildSpaceChatSystemPrompt` |
| `coordinator/*` | coordinator-mode subagents |
| `space-chat/*` | `buildSpaceChatSystemPrompt` |
| `workflows/coder-only|coder-owned|research|review-only/*` | built-in workflow node slots and post-approval templates |
| `workflows/guidance/*` | included into node prompts (call-action, review policy, review-thread, PR-events, zero-findings gate, …); `guidance/retired/*` retained for migration re-stamping equivalence |
| `runtime/*` | `buildNodeExecutionRuntimeContract` (post-approval), `prompt-too-long-recovery.ts`, `llm-workflow-selector.ts` |
| `session/title-generation.md` | `session-lifecycle.ts` |
| `commands/merge-session.md` | `built-in-commands.ts` |
| `github/*` | router/security agents |

`loader.ts` guarantees the library is internally consistent at import time: missing frontmatter, missing `id`, unknown includes, include cycles, and duplicate ids are hard build errors.

---

## 5. Post-refactor drift and risks (ranked)

1. **Ad-hoc Space members get no tool narrative (highest impact).** ~88 typed tools + dispatcher + memory + db-query are attached with only schema descriptions. Compare with `space_chat` (which gets the coordination invariants) and long-term agents (which get the owner-review contract). A member has no statement that a Space MCP surface exists or which tools are canonical.
2. **Dual identity `space-agent` vs `@space-manager`.** Canonical handle is now `space-manager` (`agent-handle.ts:3`, alias `coordinator`). Yet:
   - `node-agent-tools.ts` `list_peers`/`send_message` descriptions and the runtime contract still say *"Use 'space-agent' to escalate"* (`node-agent-tools.ts:342,533,1089`; `task-agent-manager.ts:3265,3292`);
   - `runtime/post-approval-completion.md` says `send_message(target="space-agent")`;
   - `space-coordination/SKILL.md` says *"send the message to `space-agent`"*.
   This still works because `normalizeReplyTargetHandle()` special-cases `'space-agent' → '@space-manager'` (`agent-handle.ts:30`) and `node-agent-tools` appends `'space-agent'` to `permittedTargets`. But the model is taught two names for one actor in the same context window as the `SPACE_CHAT_INTRO`/`LH_COORDINATOR_INSTRUCTIONS` text that says the handle is `@space-manager`.
3. **`swe` vs `coder` vocabulary split.** `seed-agents.ts` names the preset `SWE`/handle `swe` (and `worker.coder → worker.swe` migration exists), while every built-in workflow still names its slot `coder` and the dispatcher's `ROLE_HOT_ACTIONS` is keyed `coder/general/planner/research/reviewer/qa` (`description-generator.ts:60`). It happens to work (slots are `coder`), but any future slot named `swe` silently falls back to `GENERAL_HOT_ACTIONS`, and `call_action` advertises the role as "Coder" while the template is "SWE".
4. **Dispatcher guidance is baked into prompts; the dispatcher is behind a flag.** `CALL_ACTION_PREFERENCE_GUIDANCE` is included in many node prompts and `built-in-workflows.ts` swaps it in/out during migration (`:1972`). The `space-actions` server only attaches when `HYPERNEO_SPACE_ACTIONS_DISPATCHER` is not `0/false` (default on). The guidance does include a typed-tool fallback sentence, so a disabled flag degrades gracefully — but the primary instruction becomes a no-op.
5. **Space chat can dispatch but is never told about `call_action`.** Role `coordinator` does get a `space-actions` server (`space-runtime-service.ts:1823`), but `SPACE_CHAT_*` never mentions `call_action`; it only names typed tools. Node agents, by contrast, get the dispatcher contract. This is a role asymmetry in the tool doctrine.
6. **Internal MCP server `name` ≠ registered key.** `createSpaceAgentMcpServer` builds `createSdkMcpServer({name:'space-agent', ...})` (`space-agent-tools.ts:5301`) but every attach site stores it under key `space-agent-tools`. The key is what forms `mcp__space-agent-tools__*` (and what `SPACE_*_REQUIRED_MCP_SERVERS` checks), so it is functionally correct but confusing; the same server is referred to by two names in logs/errors/audits (`'space-agent-tools'` vs `'space-agent'`).
7. **Runtime contract is kickoff-only.** Because `## Runtime Execution Contract` lives in the initial message (`task-agent-manager.ts:1119`), a reused session (`createSubSession` reuse path updates `systemPrompt`/model/tools but not the historical kickoff) keeps a stale contract. Autonomy/tool changes will not be reflected until a fresh session is spawned.
8. **Contract duplication (already documented).** `## Your Role in This Workflow` and `## Runtime Execution Contract` both state node, role, channels and gates, and the contract re-describes node tools that already ship full schemas — see `docs/research/node-agent-initial-prompt-size.md`.
9. **`task-agent` terminology survives in file/identifier names** (`task-agent-tool-schemas.ts`, `task-agent-manager.ts`, target `'task-agent'` explicitly rejected at `space-agent-tools.ts:3065`). Post-rename, these are legacy internal names a reader must map to "node/space agent".
10. **Retired prompts still exported and hashed.** `agents/presets/planner.md`, `general.md`, `legacy-reviewer.md` and `workflows/guidance/retired/*` remain in the registry; they are referenced by migration tests and golden hashes (`prompt-extraction-golden.test.ts`), so they are intentional byte-stability anchors, not dead code — but they inflate the apparent surface.

---

## 6. Recommendations

1. **Give ad-hoc members a short tool doctrine.** Either append a compact "Space member" block to `config.systemPrompt` in `attachSpaceToolsToMemberSession`, or extend `SPACE_CHAT_COORDINATION_INVARIANTS`-style text as a shared include used by both roles. At minimum state: the `space-agent-tools` surface, the escalation target, and that the dispatcher (`call_action`) lists the role's catalog.
2. **Pick one manager name.** Canonicalize all tool text, contracts, and the skill to `space-manager`/`@space-manager` while keeping the `space-agent`/`coordinator` aliases as documented compatibility only.
3. **Align role vocabulary with templates.** Add `swe` (and any other new handles) to `ROLE_HOT_ACTIONS`, or make the lookup fall back by template handle as well as slot name; update the seed preset display name or the workflow slot name so "Coder" and "SWE" do not describe the same agent differently.
4. **Make dispatcher guidance conditional.** Only include `CALL_ACTION_PREFERENCE_GUIDANCE` when `isSpaceActionsDispatcherEnabled()` is true (it is already possible to detect at build time), or promote the typed-tool sentence when the dispatcher is off.
5. **Rename the internal server** `createSdkMcpServer({name:'space-agent'})` → `'space-agent-tools'` for consistency with the registered key, required-server constants, logs, and prompts.
6. **Re-assert the runtime contract after reuse.** When reusing a node session, append a refreshed `## Runtime Execution Contract` to the reuse kickoff so autonomy/tool changes propagate.
7. **Add a prompt-coverage test.** A table-driven test enumerating each session kind and asserting the expected narrative prompt + MCP keys (extending `prompt-extraction-golden.test.ts`) would catch this class of drift when tools are renamed.

---

## Appendix A — MCP servers, keys, and tools by session role

| Role (`SpaceMcpSessionRole`) | `requiredServers` | Attached servers (map keys) | Narrative prompt |
| --- | --- | --- | --- |
| `coordinator` (`space_chat`) | `space-agent-tools` | `space-agent-tools`, `agent-memory`, `db-query`, `space-actions` | `buildSpaceChatSystemPrompt` |
| `ad_hoc_member` | `space-agent-tools` | `space-agent-tools`, `agent-memory`, `db-query`, `space-actions` | **none** |
| `workflow_worker` | `node-agent` | `node-agent`, `agent-memory`, `space-actions` | slot customPrompt + Runtime Execution Contract |
| `long_term_agent` | `space-agent-tools` | `space-agent-tools`, `agent-memory`, `db-query`, `space-actions` | agent instructions + owner-review + scheduling guardrail |
| `universal_read` (no space) | `space-actions` | `space-actions` | none |
| `legacy_task_agent` (`space_task_agent`) | — | none (owner `none`) | legacy |

Tool inventories (current):
- `space-agent-tools` — **88 tools**: tasks (`create_standalone_task`, `get_task_detail`, `update_task`, `retry_task`, `cancel_task`, `reassign_task`, `publish_task`, `archive_task`, `list_tasks`, `list_task_members`, `approve_task`, `approve_pending_completion`, `send_message_to_task`), sessions (`list_sessions`, `get_session_detail`, `get_session_messages`, `send_session_message`, `update_session_state`, `interrupt_session`), workflows (`list_workflows`, `get_workflow_run`, `get_workflow_detail`, `suggest_workflow`, `change_plan`), agents/templates (`list_agents`, `get_agent`, `create_agent`, `update_agent`, `create_agent_from_template`, `create_agent_template`, `update_agent_template`, `delete_agent_template`, `list_agent_templates`, `archive_agent`, `pause_agent`), goals (`create_goal`, `get_goal`, `update_goal`, `list_goals`, `list_goal_tasks`, `list_goal_events`, `assign_agent_to_goal`, `unassign_agent_from_goal`, `pause_goal`, `resume_goal`, `trigger_goal_task`, `review_goal_outcome`), forge (*`forge_*`), schedules (`create_scheduled_task`, `list_scheduled_tasks`, `get_scheduled_task`, `pause_scheduled_task`, `resume_scheduled_task`, `delete_scheduled_task`), reminders/subscriptions (`create_agent_reminder`, `list_agent_reminders`, `subscribe_agent_event`, `unsubscribe_agent_event`, `list_agent_event_subscriptions`), inactivity (`inactivity_config_*`, `inactivity_run_now`), runtime (`restore_node_agent`, `get_external_event`).
- `node-agent` — **22 tools**: `send_message`, `list_peers`, `list_reachable_agents`, `list_channels`, `save_artifact`, `list_artifacts`, `list_audit_entries`, `list_deliveries`, `list_subscriptions`, `subscribe_external_event`, `unsubscribe_external_event`, `subscribe_pr_events`, `get_external_event`, `get_task`, `list_tasks`, `create_standalone_task`, `publish_task`, `archive_task`, `approve_task`, `submit_for_approval`, `mark_complete`, `restore_node_agent`.
- `space-actions` — `call_action`, `list_actions`, `describe_action` (dispatcher; per-role catalog over the same action registry).
- `agent-memory` — `memory.write`, `memory.search`, `memory.read`, `memory.delete`.
- `db-query` — 3 read-only query tools.

## Appendix B — Rename ledger relevant to prompts

| Retired | Current | Notes |
| --- | --- | --- |
| `send_feedback` | `send_message` | full rename; no remnants |
| `WorkflowStep` / `step` | `WorkflowNode` / `node` | prompts, types, DB |
| `@coordinator` | `@space-manager` | alias retained; prompts mention both |
| `worker.coder` | `worker.swe` | template key + handle; workflow slots still named `coder` |
| `coordinator` role | `space-agent`/`space-manager` | internal role stays `coordinator` |
| `neo` session type | `worker` (archived) | migration-only |
| `planning/planner` preset | retired | prompt constant retained for migration tests |
| `space_workflow_steps`, `current_step_id`, `workflow_step_id` | `space_workflow_nodes`, `current_node_id`, `workflow_node_id` | migrations + repos |
