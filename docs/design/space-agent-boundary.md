# Space Agent Boundary: Worker Agents vs Long-Horizon Agents

## Developer Note

NeoKai Spaces maintain two distinct agent tables. Keeping them separate prevents accidental coupling between workflow configuration and persistent role-holders.

### Worker Agents (`space_agents`)

- **Purpose**: Workflow configuration rows. Define model, tools, system prompt, and handle for slots in workflow nodes.
- **Lifecycle**: Created/edited via the Space Configure UI or RPC. Deleted only when not referenced by any workflow node.
- **Scope**: Per-space. No cross-space visibility.
- **Key fields**: `name`, `handle`, `model`, `provider`, `tools`, `customPrompt`, `description`.

### Long-Horizon Agents (`space_long_horizon_agents`)

- **Purpose**: Persistent role-holders with goals, Forge scopes, reminders, and event subscriptions.
- **Lifecycle**: Created via MCP tools (`create_agent`), RPC, or UI. Can be paused/archived independently.
- **Scope**: Per-space. Some rows (e.g., Coordinator) are seeded automatically.
- **Key fields**: `displayName`, `handle`, `instructions`, `autonomyLevel`, `templateKey`, plus related tables for goals, scopes, reminders, and subscriptions.

### Why Two Tables?

Previously, `space_agents` attempted to serve both roles. This caused drift: updating a worker's tools would silently affect a long-horizon agent with the same ID, and vice versa. Splitting them lets each subsystem evolve independently while still allowing handle-based UI overlap where desired.

## Migration Notes

### Shared-ID Long-Horizon Rows Are Now Independent

Before the split, some Spaces had `space_agents` rows that shared an ID with a `space_long_horizon_agents` row. After migration (Migration 155), these rows remain linked by ID but are fully independent:

- Updating the **worker agent** does **not** sync to the long-horizon agent.
- Updating the **long-horizon agent** does **not** sync to the worker agent.
- Deleting the worker agent does **not** archive the long-horizon agent.
- Handles are deduplicated across both tables; `SpaceAgentManager.validateHandle` checks `longHorizonHandleTaken()` to prevent collisions.

Operators who want both rows to stay in sync must update each manually.

### Legacy Ownership Rows: Copied or Skipped

Migration 155 backfills `space_long_horizon_agents` from legacy assignment tables (`space_agent_goal_assignments`, `space_agent_forge_scope_assignments`, `space_agent_reminders`):

- **Backfilled**: Every `space_agents` row that had at least one legacy assignment gets a matching long-horizon row.
- **Copied**: Goals, Forge scopes, and reminders tied to a backfilled agent are copied to the new long-horizon tables.
- **Skipped**: Legacy assignments whose `agent_id` does not exist in `space_agents` are skipped (not promoted). These are counted in the migration report but not auto-created.
- **Idempotent**: Running the migration twice is safe. Already-migrated rows are ignored, and deleting a copied goal/scope/reminder after migration will not bring it back on re-run.

### Post-Migration Guidance for Operators

1. Review the migration report for skipped rows. If skipped agents were important, create long-horizon agents for them manually and reassign goals/reminders.
2. Shared-ID agents that previously acted as long-horizon agents are now independent. If the worker side is no longer needed for workflows, it can be deleted without affecting the long-horizon side.
3. New Spaces created after the migration automatically get a seeded Coordinator long-horizon agent. Worker agents are created separately via templates or the UI.
