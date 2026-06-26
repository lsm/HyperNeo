/**
 * Space Preset Agent Seeding
 *
 * Seeds the seven default SpaceAgent records when a new Space is created.
 * Preset agents are regular SpaceAgent rows — fully editable by users — that
 * have sensible defaults for tools and model.
 * SpaceRuntime resolves all agents by ID at runtime; there is no special
 * builtin code path.
 *
 * Preset agents seeded per Space:
 *   - Coder       — implementation worker
 *   - Coordinator — built-in long-horizon Space agent
 *   - General     — general-purpose worker
 *   - Planner     — planning/orchestration worker
 *   - Research    — research specialist (investigates topics, writes findings, opens PRs)
 *   - Reviewer    — code review specialist
 *   - QA          — quality assurance specialist
 */

import type { SpaceAgent } from '@neokai/shared';
import type { SpaceAgentManager, SpaceAgentResult } from '../managers/space-agent-manager';
import { computeAgentTemplateHash } from './agent-template-hash';
import { QA_SYSTEM_CONTRACT, REVIEWER_SYSTEM_CONTRACT } from './system-contracts';

// ---------------------------------------------------------------------------
// Sub-session features
// ---------------------------------------------------------------------------

/**
 * Features for all sub-session agents (node agents spawned by the Task Agent).
 * Sub-sessions are internal and should not expose rewind, worktree, coordinator,
 * archive, or sessionInfo UI features.
 */
export const SUB_SESSION_FEATURES = {
  rewind: false,
  worktree: false,
  coordinator: false,
  archive: false,
  sessionInfo: false,
} as const;

// ---------------------------------------------------------------------------
// Tool defaults per preset agent
// ---------------------------------------------------------------------------

/** Full coding toolset: read, write, shell, search, web */
const CODER_TOOLS: string[] = [
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Bash',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
  'TodoWrite',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'Skill',
  'ToolSearch',
];

/** General-purpose worker: full coding toolset */
const GENERAL_TOOLS = CODER_TOOLS;

/** Planner uses the same toolset as coder (orchestration patterns reserved for future) */
const PLANNER_TOOLS = CODER_TOOLS;

/** Research uses the same toolset as coder (needs write access to commit findings and open PRs) */
const RESEARCH_TOOLS = CODER_TOOLS;

/**
 * Reviewers: read-only file access (no Write/Edit/MultiEdit/NotebookEdit) plus the Task/TaskOutput/
 * TaskStop tools so the Reviewer can dispatch exploration to the built-in
 * `general-purpose` sub-agent that ships with the `claude_code` preset.
 * Custom reviewer-specific sub-agents (e.g. reviewer-explorer) are planned
 * but will live in workflow templates / SpaceAgent data, not code.
 */
const REVIEWER_TOOLS: string[] = [
  'Read',
  'Bash',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'Skill',
  'ToolSearch',
  'Task',
  'TaskOutput',
  'TaskStop',
];

/** QA: read-only + bash for running tests — no Write or Edit */
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

/**
 * Tool profiles per preset agent name. Exported for testing and external consumption.
 */
export const PRESET_AGENT_TOOLS: Record<string, string[]> = {
  coordinator: GENERAL_TOOLS,
  coder: CODER_TOOLS,
  general: GENERAL_TOOLS,
  planner: PLANNER_TOOLS,
  research: RESEARCH_TOOLS,
  reviewer: REVIEWER_TOOLS,
  qa: QA_TOOLS,
};

// ---------------------------------------------------------------------------
// Preset definitions
// ---------------------------------------------------------------------------

interface PresetDefinition {
  name: string;
  handle: string;
  description: string;
  tools: string[];
  /** Thinking-level override for sessions created from this preset; unset inherits app default. */
  thinkingLevel?: import('@neokai/shared').ThinkingLevel;
  /** Combined operator-supplied prompt (persona + operating procedure). */
  customPrompt: string;
}

/**
 * Reviewer custom prompt.
 *
 * Mirrors the structure of the Room SDK reviewer (`buildSdkReviewerPrompt` in
 * `packages/daemon/src/lib/room/agents/leader-agent.ts`): identity block,
 * exploration via a sub-agent, numbered review process, severity
 * classification (P0–P3), own-PR detection, and a required structured
 * output block.
 *
 * Sub-agent delegation: the Reviewer has `Task`/`TaskOutput`/`TaskStop` on
 * its tool list and dispatches exploration to the built-in `general-purpose`
 * sub-agent shipped with the `claude_code` preset. Custom reviewer-specific
 * sub-agents (e.g. `reviewer-explorer`, `reviewer-fact-checker` in the Room
 * SDK) are a planned follow-up and will live in workflow templates /
 * SpaceAgent data, not in code.
 */
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
      'and open pull requests for review. Do NOT merge PRs. Your job is implementation only. ' +
      'When the reviewer approves, your work is done. The reviewer handles the merge.\n\n' +
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
    name: 'Coordinator',
    handle: 'space-coordinator',
    description:
      'Built-in long-horizon Space agent. Tracks goals, Forge scope, reminders, and event subscriptions for the Space.',
    tools: GENERAL_TOOLS,
    customPrompt:
      'You are the Coordinator for this Space. Maintain long-horizon context across goals, Forge evidence, reminders, and external events. ' +
      'Use available Space tools to inspect current work, create or update tasks, and route work to specialist agents when useful.\n\n' +
      'Keep managed goals, Forge scopes, reminders, and event subscriptions visible to the operator. Ask for confirmation before destructive changes.',
  },
  {
    name: 'Reviewer',
    handle: 'reviewer',
    description:
      'Code review specialist. Reviews pull requests for correctness, style, and test coverage.',
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

/**
 * Returns canonical preset agent templates from the same source used by seeding.
 * The result is cloned so callers can safely mutate without affecting globals.
 */
export function getPresetAgentTemplates(): PresetAgentTemplate[] {
  return PRESET_AGENTS.map((preset) => ({
    ...preset,
    tools: [...preset.tools],
  }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SeedPresetAgentsResult {
  /** Agents that were successfully created */
  seeded: SpaceAgent[];
  /** Errors for agents that failed to seed (e.g. name already taken) */
  errors: Array<{ name: string; error: string }>;
}

/**
 * Seed the six preset SpaceAgents for a newly-created Space.
 *
 * Idempotent by design: if a preset name is already taken in this Space
 * (e.g. because this was called twice), the error is recorded but does not
 * abort the remaining seeds.
 *
 * @param spaceId - The Space to seed agents into
 * @param agentManager - The SpaceAgentManager to use for creation
 * @returns Summary of seeded agents and any errors
 */
export async function seedPresetAgents(
  spaceId: string,
  agentManager: SpaceAgentManager
): Promise<SeedPresetAgentsResult> {
  const seeded: SpaceAgent[] = [];
  const errors: Array<{ name: string; error: string }> = [];

  for (const preset of PRESET_AGENTS) {
    // Stamp template tracking so the row participates in drift detection /
    // sync from day one. Hash is computed from the same canonical
    // fingerprint that drift detection re-derives later.
    const templateHash = computeAgentTemplateHash(preset);
    const result: SpaceAgentResult<SpaceAgent> = await agentManager.create({
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
