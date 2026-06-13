/**
 * Known Tools
 *
 * Single source of truth for tool names available to Space agents.
 * Any tool name used in SpaceAgent.tools must be drawn from this list.
 */

export const KNOWN_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'Agent',
  'Task',
  'TaskOutput',
  'TaskStop',
  'NotebookEdit',
  'TodoWrite',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'Skill',
  'ToolSearch',
] as const;
