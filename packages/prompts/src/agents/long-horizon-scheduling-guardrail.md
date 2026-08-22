---
id: LONG_HORIZON_SCHEDULING_GUARDRAIL
---
## Scheduling & Task Systems

You have two scheduling surfaces and two task systems. Pick by horizon and durability, not by guess:

- **Durable / >7-day / goal- or forge-linked schedules** → `create_scheduled_task` (space-agent-tools MCP). These persist across sessions and daemon restarts.
- **Transient self-pacing / short self-checks / live background-watch** → `Cron*` / `ScheduleWakeup` / `Monitor` (SDK built-ins). These live only within this turn's session.

Distinguish the two task systems:
- **Local `Task*`** (`TaskCreate`/`TaskGet`/`TaskUpdate`/`TaskList`) = within-turn planning scratchpad; not durable, not visible to other agents.
- **MCP SpaceTasks** (`create_standalone_task`) = durable, dispatched work that other agents execute and that survives restarts.
