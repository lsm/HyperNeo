import {
  PRESET_CODER_PROMPT,
  PRESET_RESEARCH_PROMPT,
  QA_SYSTEM_CONTRACT,
  REVIEWER_SYSTEM_CONTRACT,
} from '@hyperneo/prompts';
import type { SpaceLongHorizonAgent } from '@hyperneo/shared';
import type { SpaceLongHorizonAgentRepository } from '../../../storage/repositories/space-long-horizon-agent-repository.ts';

export { LEGACY_REVIEWER_PROMPT } from '@hyperneo/prompts';

export const SUB_SESSION_FEATURES = {
  rewind: false,
  worktree: false,
  coordinator: false,
  archive: false,
  sessionInfo: false,
} as const;

const PERMISSIVE_TOOLS: string[] = [];

const SWE_TOOLS = PERMISSIVE_TOOLS;

const RESEARCH_TOOLS = PERMISSIVE_TOOLS;

const REVIEWER_TOOLS: string[] = [
  'Read',
  'Bash(gh pr view:*)',
  'Bash(gh pr diff:*)',
  'Bash(gh pr checks:*)',
  'Bash(gh api graphql:*)',
  'Bash(gh api repos:*)',
  'Bash(jq:*)',
  'Bash(mktemp:*)',
  'Bash(echo:*)',
  'Bash(cat:*)',
  'Bash(test:*)',
  'Bash(head:*)',
  'Bash(tr:*)',
  'Bash(base64:*)',
  'Bash(exit:*)',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'Skill',
  'ToolSearch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'CronCreate',
  'CronDelete',
  'CronList',
];

const QA_TOOLS: string[] = [
  'Read',
  'Bash',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'Skill',
  'ToolSearch',
];

export const PRESET_AGENT_TOOLS: Record<string, string[]> = {
  swe: SWE_TOOLS,
  research: RESEARCH_TOOLS,
  reviewer: REVIEWER_TOOLS,
  qa: QA_TOOLS,
};

interface PresetDefinition {
  name: string;
  handle: string;
  description: string;
  tools: string[];
  thinkingLevel?: import('@hyperneo/shared').ThinkingLevel;
  customPrompt: string;
}

const REVIEWER_CUSTOM_PROMPT = REVIEWER_SYSTEM_CONTRACT;

const PRESET_AGENTS: PresetDefinition[] = [
  {
    name: 'SWE',
    handle: 'swe',
    description:
      'Implementation worker. Writes code, runs tests, commits changes, and opens pull requests.',
    tools: SWE_TOOLS,
    customPrompt: PRESET_CODER_PROMPT,
  },
  {
    name: 'Research',
    handle: 'research',
    description:
      'Research agent. Investigates topics, gathers information, writes findings to docs, and opens pull requests with research results.',
    tools: RESEARCH_TOOLS,
    customPrompt: PRESET_RESEARCH_PROMPT,
  },
  {
    name: 'Reviewer',
    handle: 'reviewer',
    description:
      'Code review specialist. Reviews pull requests for correctness, style, and test coverage. ' +
      'Bash is permission-scoped to read-only gh PR inspection and review posting.',
    tools: REVIEWER_TOOLS,
    customPrompt: REVIEWER_CUSTOM_PROMPT,
  },
  {
    name: 'QA',
    handle: 'qa',
    description:
      'Quality assurance specialist. Validates the reviewer-approved pull request by exercising real application behavior, not by re-running automated test suites; confirms required CI is green before terminal approval.',
    tools: QA_TOOLS,
    customPrompt: QA_SYSTEM_CONTRACT,
  },
];

export type PresetAgentTemplate = PresetDefinition;

export interface RetireRemovedPresetAgentsDeps {
  agentRepo: Pick<SpaceLongHorizonAgentRepository, 'listBySpaceId' | 'delete'>;
  hasLinkedState: (agentId: string) => boolean;
  referencedAgentIds: ReadonlySet<string>;
  isPristineRetiredRow: (agent: SpaceLongHorizonAgent) => boolean;
}

export function retireRemovedPresetAgents(
  spaceId: string,
  deps: RetireRemovedPresetAgentsDeps
): string[] {
  const retired: string[] = [];
  for (const agent of deps.agentRepo.listBySpaceId(spaceId)) {
    if (!deps.isPristineRetiredRow(agent)) continue;
    if (deps.referencedAgentIds.has(agent.id)) continue;
    if (deps.hasLinkedState(agent.id)) continue;
    try {
      deps.agentRepo.delete(agent.id);
      retired.push(agent.displayName);
    } catch {}
  }
  return retired;
}

export function getPresetAgentTemplates(): PresetAgentTemplate[] {
  return PRESET_AGENTS.map((preset) => ({
    ...preset,
    tools: [...preset.tools],
  }));
}
