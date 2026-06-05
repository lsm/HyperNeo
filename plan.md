# Plan: Clarify Space Worker Agents vs Long-Horizon Agents

## Goal summary

Clarify and enforce the product/API boundary between workflow-usable Space worker agents stored in `space_agents` and persistent Space long-horizon agents stored in `space_long_horizon_agents`. The work will rename user-facing worker-agent concepts, repair misleading MCP tool names/descriptions, add explicit long-horizon MCP capabilities for lifecycle and ownership/automation metadata, validate ID types across both agent families, and update UI flows/tests so operators can reliably create worker configs for workflows or persistent long-horizon role-holders for goals, Forges, reminders, and subscriptions without ambiguity.

## Work items

### 1. Establish naming model and shared ID validation helpers

**Priority:** high

**Description:** Add a small shared daemon helper near Space agent repositories that resolves agent IDs as either worker-agent IDs (`space_agents`) or long-horizon-agent IDs (`space_long_horizon_agents`) within a space. The helper should return clear typed outcomes and produce errors like `Expected long-horizon agent id, got worker agent id.` and `Expected worker agent id, got long-horizon agent id.`. Update TypeScript comments and user-facing shared type docs where `SpaceAgent` currently implies persistent long-horizon behavior, while keeping internal type names stable unless a local alias improves clarity.

### 2. Rename worker-agent UI copy and settings affordances

**Priority:** high

**Description:** Update Space Settings / Agents UI that uses `SpaceAgentList` and `SpaceAgentEditor` to label `space_agents` rows as **Space worker agents** or **worker agents**. Copy should explain these are reusable workflow worker configurations, not persistent long-horizon role-holders. Rename buttons, empty states, delete dialogs, workflow usage text, tests, and any user-visible labels that currently say only "Agent" in this worker-agent context.

### 3. Clarify long-horizon agent UI flows and detail pages

**Priority:** high

**Description:** Update the Space Agents page backed by `SpaceLongHorizonAgents` to consistently label **Space long-horizon agents**. Ensure selected-agent detail does not silently show worker agents as if they were long-horizon agents; if worker detail fallback remains needed for old routes, label it explicitly as a worker-agent reference and link users to worker-agent settings. Verify create/update/list/delete flows are backed only by `space_long_horizon_agents`, show goals/Forges/reminders/subscriptions as long-horizon capabilities, and make section names clear if both agent families are visible.

### 4. Add explicit worker-agent MCP aliases and deprecate ambiguous names

**Priority:** high

**Description:** In `space-agent-tools.ts`, add explicit worker-agent tools such as `list_worker_agents`, `get_worker_agent`, `create_worker_agent`, `create_worker_agent_from_template`, `update_worker_agent`, `pause_worker_agent`, and `archive_worker_agent` backed by `SpaceAgentManager`. Change tool descriptions for existing `list_agents`, `create_agent`, and related legacy aliases so they no longer claim to create long-horizon agents; they should either be removed from long-horizon wording or clearly marked as legacy aliases for worker-agent config. Preserve existing workflows and callers by keeping legacy tool names functional during transition, but audit logs should record the new explicit tool name where possible or include legacy alias metadata.

### 5. Add/repair long-horizon MCP lifecycle tools

**Priority:** high

**Description:** Add explicit long-horizon MCP tools backed by `SpaceLongHorizonAgentRepository`: `list_long_horizon_agents`, `get_long_horizon_agent`, `create_long_horizon_agent`, `update_long_horizon_agent`, `pause_long_horizon_agent`, and `archive_long_horizon_agent`. These tools should support handle/display name/instructions/autonomy/model/thinking/tool permissions and call runtime subscription refresh when relevant. Their descriptions must say they create persistent long-horizon agents, not workflow worker configs.

### 6. Move ownership and automation MCP tools to long-horizon IDs only

**Priority:** high

**Description:** Replace ambiguous tools such as `assign_agent_to_goal`, `assign_agent_to_forge_scope`, `create_agent_reminder`, and `subscribe_agent_event` with explicit long-horizon variants such as `assign_long_horizon_agent_to_goal`, `assign_long_horizon_agent_to_forge_scope`, `create_long_horizon_agent_reminder`, and `subscribe_long_horizon_agent_event`. Use existing `space_long_horizon_agent_goals`, `space_long_horizon_agent_forge_scopes`, `space_long_horizon_agent_reminders`, and `space_long_horizon_agent_event_subscriptions` repository methods instead of the older `space_agent_*` tables where possible. Legacy ambiguous aliases may remain briefly for compatibility, but must validate long-horizon IDs only and return the wrong-ID error when given a worker-agent ID.

### 7. Repair RPC/backend long-horizon coverage gaps

**Priority:** normal

**Description:** Expand `spaceLongHorizonAgent` RPC handlers where UI needs missing operations, especially goal assignment, Forge-scope assignment, reminders, event subscriptions, and list helpers if absent. Reuse repository methods and runtime subscription refresh/remove paths, with consistent space ownership checks. Keep UI RPC names distinct from worker-agent RPC names (`spaceAgent.*`) to prevent future drift.

### 8. Update docs, comments, and product language sweep

**Priority:** normal

**Description:** Sweep docs, comments, tool descriptions, prompt snippets, and changelog-adjacent copy for `space_agents`, "Space Agents", `create_agent`, "custom agent", and long-horizon references. Update only user-facing or operator-facing wording; do not churn internal code comments that clearly refer to implementation details unless they mislead future tool builders. Add short developer note in relevant Space docs explaining: worker agents = workflow configuration rows; long-horizon agents = persistent role-holders with goals/Forges/reminders/subscriptions.

### 9. Add boundary tests for MCP, RPC, repositories, and UI

**Priority:** high

**Description:** Add daemon unit tests covering worker-agent MCP aliases, long-horizon MCP lifecycle tools, and wrong-ID validation for goal/scope/reminder/subscription tools. Update existing `space-agent-tools.test.ts`, `space-agent-repository.test.ts`, `space-long-horizon-agent-repository.test.ts`, and `space-long-horizon-agent-handlers.test.ts` as needed. Add/adjust web component tests for worker-agent settings labels and long-horizon page labels, ensuring `create_worker_agent` does not appear as persistent long-horizon data and `create_long_horizon_agent` does.

### 10. Run focused verification and compatibility checks

**Priority:** high

**Description:** Run focused daemon tests for Space agent tools, Space agent repositories, long-horizon repositories, long-horizon RPC handlers, and existing workflow worker-agent tests to confirm backward compatibility. Run focused web tests for Space worker-agent and long-horizon UI components. Finish with `bun run check` if time permits; do not add E2E tests unless specifically requested.

## Dependencies

- Work Item 2 depends on Work Item 1 for agreed terminology and ID classification.
- Work Item 3 depends on Work Item 1 for long-horizon vs worker-agent ID labeling and validation language.
- Work Item 4 depends on Work Item 1 and should land before or with Work Item 5 so tool naming is unambiguous.
- Work Item 5 depends on Work Item 1 and existing repository/RPC understanding; it can run in parallel with Work Item 2 after naming is settled.
- Work Item 6 depends on Work Item 5 for explicit long-horizon tool namespace and on Work Item 1 for wrong-ID errors.
- Work Item 7 depends on Work Items 5 and 6 because UI/RPC coverage should match final long-horizon capabilities.
- Work Item 8 depends on Work Items 2, 3, 4, and 5 so docs reflect final labels/tool names.
- Work Item 9 depends on each implementation item but should be developed alongside Work Items 4–7 for API boundary coverage.
- Work Item 10 depends on Work Items 2–9.

## Out of scope

- Renaming database tables (`space_agents`, `space_long_horizon_agents`) or shared TypeScript type names in a broad migration.
- Deleting legacy MCP tool aliases immediately if existing workflows or agents still call them.
- Changing workflow orchestration semantics beyond clearer worker-agent naming and compatibility preservation.
- Adding E2E tests for ordinary UI label/API boundary changes unless requested.
- Redesigning the full Space navigation model outside the worker-agent vs long-horizon-agent distinction.

## Open questions

- Should legacy ambiguous MCP tools (`create_agent`, `assign_agent_to_goal`, etc.) remain indefinitely as compatibility aliases, or should they emit deprecation guidance and be removed in a later release?
- Should the Space Agents page show a read-only worker-agent cross-reference section, or should worker agents live only under Space Settings / Agents?
- Are the older `space_agent_goal_assignments`, `space_agent_forge_scope_assignments`, and `space_agent_reminders` tables still needed for migration/backward compatibility after tools move to `space_long_horizon_agent_*` tables?
- Should long-horizon MCP tools be exposed to all Space member sessions or only coordinator/long-horizon sessions?
