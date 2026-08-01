/**
 * Known Tools
 *
 * Single source of truth for tool names available to Space agents.
 * Any tool name used in SpaceWorkerAgent.tools must be drawn from this list.
 */

export const KNOWN_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Bash',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'Agent',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
  'NotebookEdit',
  'TodoWrite',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'Skill',
  'ToolSearch',
  'Projects',
  'REPL',
  'Workflow',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'RemoteTrigger',
  'ShowOnboardingRolePicker',
  'Monitor',
  'Artifact',
  'PushNotification',
  'EnterWorktree',
  'ExitWorktree',
] as const;

/**
 * Built-in tools whose availability a worker tool-profile controls.
 *
 * `SpaceWorkerAgent.tools` is a visible override, not an exhaustive allowlist:
 * when a profile is present, these are the built-ins the runtime denies if the
 * profile omits them. Every other built-in and all MCP tools are inherited
 * regardless. An empty profile denies nothing (permissive inheritance).
 *
 * This is the single source of truth shared by the daemon resolver
 * (`deriveWorkerDisallowedTools`) and the web editor (`SpaceAgentEditor`),
 * so the runtime denial set and the UI's deniable toggles cannot drift apart.
 */
export const DENIABLE_TOOLS = ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const;
