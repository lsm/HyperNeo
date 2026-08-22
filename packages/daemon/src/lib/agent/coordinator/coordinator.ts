import { COORDINATOR_PROMPT } from '@hyperneo/prompts';
import type { AgentDefinition } from '@hyperneo/shared';

export const COORDINATOR_AGENT: AgentDefinition = {
  description: 'Coordinator agent that delegates all work to specialists',
  tools: [
    'Agent',
    'Task',
    'TaskOutput',
    'TaskStop',
    'TodoWrite',
    'AskUserQuestion',
    'EnterPlanMode',
    'ExitPlanMode',
  ],
  model: 'opus',
  prompt: COORDINATOR_PROMPT,
};
