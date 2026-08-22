import { SUBAGENT_DEBUGGER_PROMPT } from '@hyperneo/prompts';
import type { AgentDefinition } from '@hyperneo/shared';

export const debuggerAgent: AgentDefinition = {
  description: 'Reproduce and diagnose bugs. Writes a failing test first, then traces root cause.',
  tools: [
    'Read',
    'Write',
    'Edit',
    'MultiEdit',
    'Grep',
    'Glob',
    'Bash',
    'WebFetch',
    'WebSearch',
    'Skill',
    'Agent',
    'Task',
    'TodoWrite',
    'TaskOutput',
    'TaskStop',
    'EnterPlanMode',
    'ExitPlanMode',
    'NotebookEdit',
    'ToolSearch',
  ],
  model: 'sonnet',
  prompt: SUBAGENT_DEBUGGER_PROMPT,
};
