import {
  SPACE_CHAT_INTRO,
  SPACE_CHAT_WORKFLOW_LISTING_NOTE,
  SPACE_CHAT_WORK_CREATION,
  SPACE_CHAT_SUBAGENTS,
  SPACE_CHAT_EVENT_HANDLING,
  SPACE_CHAT_AUTONOMY_5,
  SPACE_CHAT_AUTONOMY_4,
  SPACE_CHAT_AUTONOMY_3,
  SPACE_CHAT_AUTONOMY_LOW,
  SPACE_CHAT_ESCALATION_ACT,
  SPACE_CHAT_ESCALATION_ASK,
  SPACE_CHAT_COORDINATION_INVARIANTS,
} from '@hyperneo/prompts';
import type { SpaceAutonomyLevel } from '@hyperneo/shared/types/space';
import {
  LONG_HORIZON_OWNER_REVIEW_CONTRACT,
  LONG_HORIZON_SCHEDULING_GUARDRAIL,
} from './long-horizon-agent-tools.ts';

export interface WorkflowSummary {
  id: string;
  handle?: string;
  name: string;
  description?: string;
  tags: string[];
  nodeCount: number;
}

export interface AgentSummary {
  id: string;
  name: string;
  description?: string;
}

export interface SpaceChatAgentContext {
  background?: string;
  instructions?: string;
  workflows?: WorkflowSummary[];
  agents?: AgentSummary[];
  autonomyLevel?: SpaceAutonomyLevel;
}

export function buildSpaceChatSystemPrompt(context: SpaceChatAgentContext = {}): string {
  const sections: string[] = [];

  sections.push(SPACE_CHAT_INTRO);

  if (context.workflows && context.workflows.length > 0) {
    sections.push(`\n## Workflow Summary\n`);
    sections.push(SPACE_CHAT_WORKFLOW_LISTING_NOTE);
    for (const wf of context.workflows) {
      const tagStr = wf.tags.length > 0 ? ` [${wf.tags.join(', ')}]` : '';
      sections.push(`- **${wf.name}** (id: \`${wf.id}\`, ${wf.nodeCount} node(s))${tagStr}`);
    }
  } else {
    sections.push(`\n## Workflow Summary\n\nNo workflows are currently configured in this Space.`);
  }

  if (context.agents && context.agents.length > 0) {
    sections.push(`\n## Agents\n`);
    for (const agent of context.agents) {
      const desc = agent.description ? ` — ${agent.description}` : '';
      sections.push(`- **${agent.name}**${desc}`);
    }
  }

  sections.push(`\n## Work Creation\n`);
  sections.push(SPACE_CHAT_WORK_CREATION);

  sections.push(`\n## Subagents\n`);
  sections.push(SPACE_CHAT_SUBAGENTS);

  sections.push(`\n## Event Handling\n`);
  sections.push(SPACE_CHAT_EVENT_HANDLING);

  const level = context.autonomyLevel ?? 1;
  sections.push(`\n## Autonomy Level\n`);
  sections.push(`This Space is configured at autonomy level **${level}** (scale 1-5).`);
  if (level === 5) {
    sections.push(SPACE_CHAT_AUTONOMY_5);
  } else if (level === 4) {
    sections.push(SPACE_CHAT_AUTONOMY_4);
  } else if (level === 3) {
    sections.push(SPACE_CHAT_AUTONOMY_3);
  } else {
    sections.push(SPACE_CHAT_AUTONOMY_LOW);
  }

  sections.push(`\n## Escalation\n`);
  if (level >= 3) {
    sections.push(SPACE_CHAT_ESCALATION_ACT);
  } else {
    sections.push(SPACE_CHAT_ESCALATION_ASK);
  }

  sections.push(`\n## Coordination Invariants\n`);
  sections.push(SPACE_CHAT_COORDINATION_INVARIANTS);

  sections.push(`\n${LONG_HORIZON_OWNER_REVIEW_CONTRACT}`);

  sections.push(`\n${LONG_HORIZON_SCHEDULING_GUARDRAIL}`);

  if (context.background) {
    sections.push(`\n## Space Background\n\n${context.background}`);
  }

  if (context.instructions) {
    sections.push(`\n## Space Instructions\n\n${context.instructions}`);
  }

  return sections.join('\n');
}
