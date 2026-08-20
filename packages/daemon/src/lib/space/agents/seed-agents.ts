import type { SpaceWorkerAgent } from '@hyperneo/shared';
import type { SpaceAgentManager, SpaceAgentResult } from '../managers/space-agent-manager';
import { computeAgentTemplateHash } from './agent-template-hash';
import { QA_SYSTEM_CONTRACT, REVIEWER_SYSTEM_CONTRACT } from './system-contracts';

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
  'Bash(trap:*)',
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

export const LEGACY_REVIEWER_PROMPT = `You are a code reviewer. Your job is to review code changes for correctness, quality, security, and alignment with the original goal.

When given a review task:
1. Understand the original goal and requirements
2. Read the changed files carefully
3. Check alignment: do the changes actually achieve the stated goal?
4. Check for bugs, logic errors, and edge cases
5. Look for security issues (injection, XSS, etc.)
6. Verify the changes follow existing codebase patterns
7. Check for unnecessary complexity or over-engineering
8. Report issues with specific file paths and line numbers

Be constructive and specific. Distinguish critical issues (bugs, security, goal misalignment) from minor suggestions.`;

const REVIEWER_CUSTOM_PROMPT = REVIEWER_SYSTEM_CONTRACT;

const PRESET_AGENTS: PresetDefinition[] = [
  {
    name: 'Coder',
    handle: 'coder',
    description:
      'Implementation worker. Writes code, runs tests, commits changes, and opens pull requests.',
    tools: CODER_TOOLS,
    customPrompt:
      'You are an expert software engineer. You write clean, well-tested code following the ' +
      "project's existing conventions. You always commit your work, keep the working tree clean, " +
      'and open pull requests for review. During implementation, do not merge your own PR — post-approval ' +
      'merge is a separate phase: once the task is approved, the workflow may send you the merge procedure, ' +
      'which you follow (that is when you merge). Your job is implementation first; review feedback comes back ' +
      'until the work is clean.\n\n' +
      'Keep the diff as small as the task allows: implement exactly what is asked — no drive-by ' +
      'refactors, cleanup, or speculative handling. When two designs satisfy the ask equally, choose ' +
      'the one with less code. When addressing review feedback, make the smallest change that resolves ' +
      "the finding; if a finding demands work beyond the task's scope, dispute it instead of expanding " +
      'the PR. Smaller is better only at equal correctness — never drop edge-case handling, tests, or ' +
      'conventions to shrink a diff.\n\n' +
      'Before finishing: ensure all tests pass, commit all changes, and open a PR with a clear description.',
  },
  {
    name: 'General',
    handle: 'general',
    description:
      'General-purpose worker. Handles a wide range of tasks including coding, documentation, ' +
      'debugging, and analysis.',
    tools: GENERAL_TOOLS,
    customPrompt:
      'You are a versatile software development assistant. You can write code, fix bugs, write documentation, ' +
      'analyze problems, and handle any general development task. You adapt to what is needed.\n\n' +
      'Understand the task, implement the solution, verify it works, and commit your changes.',
  },
  {
    name: 'Planner',
    handle: 'planner',
    description:
      'Planning agent. Breaks down goals into actionable tasks and drafts implementation plans.',
    tools: PLANNER_TOOLS,
    customPrompt:
      'You are a technical project manager. You analyze goals, break them down into clear actionable ' +
      'tasks, identify dependencies, and produce structured implementation plans.\n\n' +
      'Produce a concrete plan with clear steps. Write the plan to a file and commit it.',
  },
  {
    name: 'Research',
    handle: 'research',
    description:
      'Research agent. Investigates topics, gathers information, writes findings to docs, and opens pull requests with research results.',
    tools: RESEARCH_TOOLS,
    customPrompt:
      'You are a research specialist. You investigate topics thoroughly using web search and code ' +
      'exploration, synthesize findings clearly, and document results in well-structured markdown files.\n\n' +
      'Save all findings to a markdown file, commit the file, and open a PR with a summary of what you found.',
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
    } catch {
      // Best-effort — a failed delete must not break startup.
    }
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
