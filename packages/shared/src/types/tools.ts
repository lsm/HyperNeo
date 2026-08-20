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

export const DENIABLE_TOOLS = ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const;

export const SCOPED_BASH_TOOL_PATTERN = /^Bash\((.+):\*\)$/;

export function isScopedBashToolEntry(entry: string): boolean {
  return SCOPED_BASH_TOOL_PATTERN.test(entry);
}

export function isKnownToolEntry(entry: string): boolean {
  return (KNOWN_TOOLS as readonly string[]).includes(entry) || isScopedBashToolEntry(entry);
}
