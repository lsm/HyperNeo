import type { SpaceAgentManager, SpaceAgentResult } from '../managers/space-agent-manager.ts';
import { computeAgentTemplateHash } from './agent-template-hash.ts';
import type { SpaceWorkerAgent } from '@hyperneo/shared';
import {
  QA_SYSTEM_CONTRACT,
  REVIEWER_SYSTEM_CONTRACT,
  PRESET_CODER_PROMPT,
  PRESET_GENERAL_PROMPT,
  PRESET_PLANNER_PROMPT,
  PRESET_RESEARCH_PROMPT,
} from '@hyperneo/prompts';

export { LEGACY_REVIEWER_PROMPT } from '@hyperneo/prompts';

export const SUB_SESSION_FEATURES = {
  rewind: false,
  worktree: false,
  coordinator: false,
  archive: false,
  sessionInfo: false,
} as const;

const PERMISSIVE_TOOLS: string[] = [];

const CODER_TOOLS = PERMISSIVE_TOOLS;

const GENERAL_TOOLS = PERMISSIVE_TOOLS;

const PLANNER_TOOLS = PERMISSIVE_TOOLS;

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
  coder: CODER_TOOLS,
  general: GENERAL_TOOLS,
  planner: PLANNER_TOOLS,
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
    name: 'Coder',
    handle: 'coder',
    description:
      'Implementation worker. Writes code, runs tests, commits changes, and opens pull requests.',
    tools: CODER_TOOLS,
    customPrompt: PRESET_CODER_PROMPT,
  },
  {
    name: 'General',
    handle: 'general',
    description:
      'General-purpose worker. Handles a wide range of tasks including coding, documentation, ' +
      'debugging, and analysis.',
    tools: GENERAL_TOOLS,
    customPrompt: PRESET_GENERAL_PROMPT,
  },
  {
    name: 'Planner',
    handle: 'planner',
    description:
      'Planning agent. Breaks down goals into actionable tasks and drafts implementation plans.',
    tools: PLANNER_TOOLS,
    customPrompt: PRESET_PLANNER_PROMPT,
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
      'Quality assurance specialist. Verifies test coverage, runs test suites, and checks CI pipeline status.',
    tools: QA_TOOLS,
    customPrompt: QA_SYSTEM_CONTRACT,
  },
];

export type PresetAgentTemplate = PresetDefinition;

export function getPresetAgentTemplates(): PresetAgentTemplate[] {
  return PRESET_AGENTS.map((preset) => ({
    ...preset,
    tools: [...preset.tools],
  }));
}

export const RETIRED_PR_MERGER_TOOLS: readonly string[] = ['Bash', 'Read', 'Grep', 'Glob'];
export const RETIRED_PR_MERGER_DESCRIPTION =
  'Post-approval PR merge specialist. The designated execution agent: it runs gh pr merge, ' +
  'branch cleanup, worktree sync, and conflict routing. Spawned only after a task is approved.';
export const RETIRED_PR_MERGER_PROMPT =
  'You are the PR Merger — the designated execution agent for post-approval PR merges. ' +
  'You run after a task has been approved. Your sole job is to merge the approved PR using ' +
  '`gh pr merge`, clean up the branch, sync the worktree, and route any merge conflicts back ' +
  'to the implementation agent. You are given the exact merge procedure as your first message; ' +
  'follow it precisely. Do NOT review code, do NOT write features, and do NOT call approve_task ' +
  'or submit_for_approval — the task is already approved. When the merge and sync are complete, ' +
  'call mark_complete to close the task.';

function arraysEqual(a: string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function isPristineRetiredPrMergerRow(agent: SpaceWorkerAgent): boolean {
  return (
    agent.name === 'PR Merger' &&
    agent.handle === 'merger' &&
    agent.templateName === 'PR Merger' &&
    agent.description === RETIRED_PR_MERGER_DESCRIPTION &&
    agent.customPrompt === RETIRED_PR_MERGER_PROMPT &&
    arraysEqual(agent.tools ?? [], RETIRED_PR_MERGER_TOOLS) &&
    agent.model === undefined &&
    agent.thinkingLevel === undefined &&
    agent.provider === undefined &&
    agent.settingSources === undefined &&
    (agent.status === undefined || agent.status === 'active')
  );
}

export interface RetireRemovedPresetAgentsDeps {
  agentManager: Pick<SpaceAgentManager, 'listBySpaceId' | 'delete'>;
  referencedAgentIds: ReadonlySet<string>;
}

export function retireRemovedPresetAgents(
  spaceId: string,
  deps: RetireRemovedPresetAgentsDeps
): string[] {
  const retired: string[] = [];
  for (const agent of deps.agentManager.listBySpaceId(spaceId)) {
    if (!isPristineRetiredPrMergerRow(agent)) continue;
    if (deps.referencedAgentIds.has(agent.id)) continue;
    try {
      deps.agentManager.delete(agent.id);
      retired.push(agent.name);
    } catch {}
  }
  return retired;
}

export interface SeedPresetAgentsResult {
  seeded: SpaceWorkerAgent[];
  errors: Array<{ name: string; error: string }>;
}

export async function seedPresetAgents(
  spaceId: string,
  agentManager: SpaceAgentManager
): Promise<SeedPresetAgentsResult> {
  const seeded: SpaceWorkerAgent[] = [];
  const errors: Array<{ name: string; error: string }> = [];

  for (const preset of PRESET_AGENTS) {
    const templateHash = computeAgentTemplateHash(preset);
    const result: SpaceAgentResult<SpaceWorkerAgent> = await agentManager.create({
      spaceId,
      name: preset.name,
      handle: preset.handle,
      description: preset.description,
      tools: preset.tools,
      thinkingLevel: preset.thinkingLevel,
      customPrompt: preset.customPrompt,
      templateName: preset.name,
      templateHash,
    });

    if (result.ok) {
      seeded.push(result.value);
    } else {
      errors.push({ name: preset.name, error: result.error });
    }
  }

  return { seeded, errors };
}
