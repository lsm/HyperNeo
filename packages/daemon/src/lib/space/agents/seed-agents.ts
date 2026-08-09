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
 *   - Reviewer    — code review specialist (bash for read-only inspection; posts reviews via gh)
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
 * Reviewers: non-mutating profile that keeps Bash for read-only inspection.
 *
 * The Reviewer uses Bash for GitHub inspection (`gh pr view`, `gh pr diff`,
 * `gh pr checks`, `gh api graphql` reviewThreads) and for posting reviews via
 * the gh CLI (`addPullRequestReview` GraphQL mutation) — there are no PR-process
 * MCP tools (get_pr_diff / post_review were removed; the reviewer uses the CLI
 * directly). The runtime
 * denies Write/Edit/MultiEdit/NotebookEdit whenever a non-empty tool profile
 * omits them, so the Reviewer still cannot edit code. The prompt (Reviewer
 * System Contract) restrains it from running the code under review (tests,
 * builds, app) and from merging. `Task`/* tools dispatch exploration to the
 * built-in `general-purpose` sub-agent, and Cron* allow scheduled follow-ups.
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
  'CronCreate',
  'CronDelete',
  'CronList',
];

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
      'and open pull requests for review. During implementation, do not merge your own PR — post-approval ' +
      'merge is a separate phase: once the task is approved, the workflow may send you the merge procedure, ' +
      'which you follow (that is when you merge). Your job is implementation first; review feedback comes back ' +
      'until the work is clean.\n\n' +
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
      'Has bash for read-only inspection and posts reviews via the gh CLI.',
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
// Retired preset cleanup
// ---------------------------------------------------------------------------

/**
 * The EXACT pristine `PR Merger` preset seed, frozen from the era when the
 * dedicated PR-merger agent existed (migration 170 backfilled it into every
 * pre-existing Space; `seedPresetAgents()` seeded it into every Space created
 * before the pivot). The pivot removed the preset and gave the merge to the
 * coder/research agent, but existing `space_agents` rows were never deleted —
 * migration 170 won't replay, and m180 touches only `Reviewer` rows. A pristine
 * row is retired by {@link retireRemovedPresetAgents}; a customized row (any
 * field differs from these constants) is the user's own and is preserved.
 */
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

/**
 * Whether an agent row is an UNMODIFIED retired `PR Merger` seed. Every field
 * must match the frozen seed exactly — a user who renamed the agent, changed
 * its tools, edited its prompt/description, or dropped the preset tracking is
 * the user's own and must NOT be deleted.
 */
export function isPristineRetiredPrMergerRow(agent: SpaceWorkerAgent): boolean {
  return (
    agent.name === 'PR Merger' &&
    agent.handle === 'merger' &&
    agent.templateName === 'PR Merger' &&
    agent.description === RETIRED_PR_MERGER_DESCRIPTION &&
    agent.customPrompt === RETIRED_PR_MERGER_PROMPT &&
    arraysEqual(agent.tools ?? [], RETIRED_PR_MERGER_TOOLS)
  );
}

export interface RetireRemovedPresetAgentsDeps {
  agentManager: Pick<SpaceAgentManager, 'listBySpaceId' | 'delete'>;
  /**
   * Agent ids still referenced by ANY workflow node in the space. A pristine
   * row is retired ONLY when nothing references it — an in-flight run whose
   * merger node was deferred by `hasActiveRuns`, or a user-customized workflow
   * that kept its merger slot, still resolves the agent by id, so deleting it
   * would orphan that workflow. (Call after the re-stamp has stripped retired
   * merger nodes from non-active-run workflows.)
   */
  referencedAgentIds: ReadonlySet<string>;
}

/**
 * Delete pristine retired `PR Merger` preset rows that no workflow references.
 * Customized rows and rows referenced by an active run / customized workflow are
 * preserved. Returns the names of the retired agents.
 */
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
