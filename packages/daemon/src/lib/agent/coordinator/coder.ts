import { SUBAGENT_CODER_PROMPT } from '@hyperneo/prompts';
import type { AgentDefinition } from '@hyperneo/shared';

export const coderAgent: AgentDefinition = {
  description:
    'Write and modify code. Use for implementing features, fixing bugs, editing files, and making code changes.',
  tools: [
    'Read',
    'Edit',
    'Write',
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
  prompt: SUBAGENT_CODER_PROMPT,
};
