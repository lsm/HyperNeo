/**
 * Curated read-only tool surface for long-horizon (LH) Space agents.
 *
 * Replaces the blunt `claude_code` preset (PR #2294), which bundled
 * interactive-CLI tooling LH agents don't need AND included `Write`/`Edit`/
 * `MultiEdit` — reversing the deliberate read-only-coordinator design (PR #1567):
 * LH/coordinator agents delegate file mutation to worker agents; their write
 * surface is the `space-agent-tools` MCP, not direct file edits.
 *
 * This module is import-free so it can be shared by both the Space runtime
 * (`space-runtime-service.ts`) and the query-time builder
 * (`query-options-builder.ts`) without creating an import cycle.
 *
 * 24 built-ins — outputs go via the `space-agent-tools` MCP or worker
 * delegation; durable scheduling goes via the MCP, transient self-pacing via
 * the SDK cron/wakeup tools.
 */

/**
 * The curated built-in tool list exposed to long-horizon Space agents.
 *
 * Read-only on workspace files: NO `Write`/`Edit`/`MultiEdit`/`NotebookEdit`.
 * The always-attached `space-agent-tools` MCP provides durable write
 * coordination (tasks, goals, gates, scheduling).
 */
export const LONG_HORIZON_AGENT_BUILTIN_TOOLS = [
  // read / search / shell / web
  'Read',
  'Grep',
  'Glob',
  'Bash',
  'WebFetch',
  'WebSearch',
  // subagents (parallel investigation)
  'Agent',
  'Task',
  'TaskOutput',
  'TaskStop',
  // planning / UX
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  // local within-turn task tracking
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
  // dispatch / meta
  'Skill',
  'ToolSearch',
  // scheduling / self-pacing / background-watch
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'Monitor',
] as const;

/**
 * Standing guardrail appended to every long-horizon agent's prompt.
 *
 * Resolves the layering confusion where an agent reached for the MCP scheduler
 * (`create_scheduled_task`) when a transient SDK cron/wakeup was expected (and
 * vice-versa). The two scheduling surfaces pick by horizon, not by guess; and
 * the two task systems (local within-turn `Task*` vs durable MCP SpaceTasks)
 * are kept distinct so the agent doesn't conflate them.
 */
export const LONG_HORIZON_SCHEDULING_GUARDRAIL = `## Scheduling & Task Systems

You have two scheduling surfaces and two task systems. Pick by horizon and durability, not by guess:

- **Durable / >7-day / goal- or forge-linked schedules** → \`create_scheduled_task\` (space-agent-tools MCP). These persist across sessions and daemon restarts.
- **Transient self-pacing / short self-checks / live background-watch** → \`Cron*\` / \`ScheduleWakeup\` / \`Monitor\` (SDK built-ins). These live only within this turn's session.

Distinguish the two task systems:
- **Local \`Task*\`** (\`TaskCreate\`/\`TaskGet\`/\`TaskUpdate\`/\`TaskList\`) = within-turn planning scratchpad; not durable, not visible to other agents.
- **MCP SpaceTasks** (\`create_standalone_task\`) = durable, dispatched work that other agents execute and that survives restarts.`;
