/**
 * Space Preset Agent Seeding
 *
 * Seeds the six default SpaceWorkerAgent records when a new Space is created.
 * Preset agents are regular SpaceWorkerAgent rows — fully editable by users — that
 * have sensible defaults for tools and model.
 * SpaceRuntime resolves all agents by ID at runtime; there is no special
 * builtin code path.
 *
 * Preset agents seeded per Space:
 *   - Coder       — implementation worker
 *   - General     — general-purpose worker
 *   - Planner     — planning/orchestration worker
 *   - Research    — research specialist (investigates topics, writes findings, opens PRs)
 *   - Reviewer    — code review specialist (no shell — posts reviews via `post_review`)
 *   - Merger      — post-approval PR merge specialist (the designated shell agent)
 *   - QA          — quality assurance specialist
 *
 * The Coordinator is a SpaceLongHorizonAgent and is managed separately; it does
 * not appear in the worker-agent preset list.
 */

import type { SpaceWorkerAgent } from '@hyperneo/shared';
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

/**
 * Permissive worker preset: empty tool profile.
 *
 * SpaceWorkerAgent.tools is a visible override, not an exhaustive SDK allowlist.
 * An empty profile means the worker inherits all SDK built-ins and MCP tools
 * at runtime (see deriveWorkerDisallowedTools). The UI shows this as
 * "Inherit defaults".
 */
const PERMISSIVE_TOOLS: string[] = [];

/** Coder inherits all SDK defaults so it can use any built-in tool. */
const CODER_TOOLS = PERMISSIVE_TOOLS;

/** General-purpose worker inherits all SDK defaults. */
const GENERAL_TOOLS = PERMISSIVE_TOOLS;

/** Planner inherits all SDK defaults. */
const PLANNER_TOOLS = PERMISSIVE_TOOLS;

/** Research inherits all SDK defaults (it needs write access to commit findings and open PRs). */
const RESEARCH_TOOLS = PERMISSIVE_TOOLS;

/**
 * Reviewers: explicit non-mutating profile with NO shell.
 *
 * The runtime denies Write/Edit/MultiEdit/NotebookEdit/Bash whenever a
 * non-empty tool profile omits them. The Reviewer is a pure static-review
 * role — it never runs code. It posts PR reviews and line comments through
 * the `post_review` node-agent MCP tool (which calls the GitHub API
 * server-side), NOT via `gh api` in a shell, so Bash is intentionally absent.
 * The `Task`/* tools let the Reviewer dispatch exploration to the built-in
 * `general-purpose` sub-agent that ships with the `claude_code` preset.
 *
 * `post_review` is NOT listed here on purpose: the tools profile only accepts
 * SDK built-ins (KNOWN_TOOLS) and gates deniable built-ins (DENIABLE_TOOLS).
 * MCP tools like `post_review` are inherited regardless of the profile (see
 * DENIABLE_TOOLS), and the tool is registered for the Reviewer session by
 * `TaskAgentManager.buildNodeAgentMcpServerForSession` (detected by handle).
 *
 * Role separation (Option C): the post-approval PR merge — which DOES need a
 * shell — is handled by the dedicated "PR Merger" agent, not the Reviewer.
 */
const REVIEWER_TOOLS: string[] = [
  'Read',
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

/**
 * PR Merger: the designated shell-capable execution agent for post-approval
 * PR merges. It runs `gh pr merge` (+ branch cleanup, worktree sync, conflict
 * routing) via Bash, so Bash is present. It has NO Write/Edit — merging is a
 * git/shell operation, not code editing. The node-agent MCP tools it needs
 * (save_artifact, send_message, mark_complete, list_reachable_agents, etc.)
 * are attached to its post-approval session by `spawnPostApprovalSubSession`
 * and are NOT listed here (the visible profile only gates SDK built-ins).
 *
 * Spawned post-approval only — declared as a dedicated "Post-Approval" node
 * slot in each merge-capable workflow so it is never activated during a normal
 * review cycle.
 */
const MERGER_TOOLS: string[] = ['Bash', 'Read', 'Grep', 'Glob'];

/** QA: read/search/web + bash for running tests — no Write/Edit/MultiEdit/NotebookEdit. */
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
  coder: CODER_TOOLS,
  general: GENERAL_TOOLS,
  planner: PLANNER_TOOLS,
  research: RESEARCH_TOOLS,
  reviewer: REVIEWER_TOOLS,
  merger: MERGER_TOOLS,
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
  thinkingLevel?: import('@hyperneo/shared').ThinkingLevel;
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
 * SpaceWorkerAgent data, not in code.
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
    name: 'Reviewer',
    handle: 'reviewer',
    description:
      'Code review specialist. Reviews pull requests for correctness, style, and test coverage. ' +
      'Has no shell — posts reviews via the post_review tool.',
    tools: REVIEWER_TOOLS,
    customPrompt: REVIEWER_CUSTOM_PROMPT,
  },
  {
    name: 'PR Merger',
    handle: 'merger',
    description:
      'Post-approval PR merge specialist. The designated execution agent: it runs gh pr merge, ' +
      'branch cleanup, worktree sync, and conflict routing. Spawned only after a task is approved.',
    tools: MERGER_TOOLS,
    customPrompt:
      'You are the PR Merger — the designated execution agent for post-approval PR merges. ' +
      'You run after a task has been approved. Your sole job is to merge the approved PR using ' +
      '`gh pr merge`, clean up the branch, sync the worktree, and route any merge conflicts back ' +
      'to the implementation agent. You are given the exact merge procedure as your first message; ' +
      'follow it precisely. Do NOT review code, do NOT write features, and do NOT call approve_task ' +
      'or submit_for_approval — the task is already approved. When the merge and sync are complete, ' +
      'call mark_complete to close the task.',
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
  seeded: SpaceWorkerAgent[];
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
  const seeded: SpaceWorkerAgent[] = [];
  const errors: Array<{ name: string; error: string }> = [];

  for (const preset of PRESET_AGENTS) {
    // Stamp template tracking so the row participates in drift detection /
    // sync from day one. Hash is computed from the same canonical
    // fingerprint that drift detection re-derives later.
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
