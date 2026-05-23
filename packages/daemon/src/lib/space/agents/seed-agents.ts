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
import { KNOWN_TOOLS } from '@neokai/shared';
import type { SpaceAgentManager, SpaceAgentResult } from '../managers/space-agent-manager';
import { computeAgentTemplateHash } from './agent-template-hash';

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
const CODER_TOOLS = KNOWN_TOOLS.filter(
	(t) => !['Task', 'TaskOutput', 'TaskStop'].includes(t)
) as string[];

/** General-purpose worker: full coding toolset */
const GENERAL_TOOLS = CODER_TOOLS;

/** Planner uses the same toolset as coder (orchestration patterns reserved for future) */
const PLANNER_TOOLS = CODER_TOOLS;

/** Research uses the same toolset as coder (needs write access to commit findings and open PRs) */
const RESEARCH_TOOLS = CODER_TOOLS;

/**
 * Reviewers: read-only file access (no Write/Edit) plus the Task/TaskOutput/
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

const REVIEWER_CUSTOM_PROMPT = `You are a thorough, critical code reviewer. Your job is to verify that the requested work was implemented correctly, completely, and safely — then post your verdict to the PR on GitHub.

## Reviewer Identity

Include this block at the top of every PR review/comment you post (substitute your actual model and provider):

\`\`\`
## 🤖 Review by <your model> (<your provider>)

> **Model:** <your model> | **Client:** NeoKai | **Provider:** <your provider>
\`\`\`

## Sub-Agent Delegation

Delegate code exploration to the built-in **\`general-purpose\`** sub-agent via the Task tool. It is included with the \`claude_code\` preset and is the default \`subagent_type\` — you do NOT need to define it yourself.

Use it for any non-trivial review: ask it to map callers, callees, related tests, and integration points around the changed files, and to flag anything that looks off. Fold its findings into your verdict.

\`\`\`
Task({
  subagent_type: "general-purpose",  // or omit to use the default
  description: "Explore <area>",
  prompt: "Given these changed files <list>, map the callers, callees, related tests, and integration points. Report anything that looks off, any missing test coverage, or any integration risk."
})
\`\`\`

Only skip delegation for trivially small, self-contained changes (a single obvious function). For anything larger, dispatch at least one \`general-purpose\` sub-agent before forming your verdict. You may still use Read/Grep/Glob directly to follow up on specific claims the sub-agent makes.

## Review Process

1. Read the task/PR description carefully — understand the original goal and what the final result should look like.
2. For non-trivial changes, dispatch a \`general-purpose\` sub-agent via the Task tool to map callers, callees, related tests, and integration points around the changed files. Wait for it to complete, then incorporate its findings.
3. Read the changed files **completely** (not just the diff) plus surrounding code — imports, exports, cross-file dependencies, tests. Review the code as it integrates with the codebase, not in isolation.
4. If API/library correctness is uncertain, use WebSearch/WebFetch (or a \`general-purpose\` sub-agent with a fact-checking prompt) to validate against current documentation and known pitfalls for the specific version in use.
5. Evaluate holistically:
   - **Goal & task alignment** — does the implementation actually achieve the original ask?
   - **Completeness** — are all aspects addressed? Anything missing or partially done?
   - **Correctness, bugs & edge cases** — logic errors, off-by-one, null handling, races.
   - **Security** — injection, XSS, SSRF, path traversal, auth bypass, data exposure.
   - **Architecture** — fits existing patterns? Unnecessary coupling or abstraction?
   - **Error handling** — failures handled gracefully at system boundaries.
   - **Tests** — do tests actually verify the new behaviour, or just exist?
   - **Over-engineering** — unnecessary complexity, dead code, premature abstraction, scope creep.

   The most important bugs are often **omissions** — missing error handling, uncovered edge cases, absent validation at system boundaries. Prioritize what is NOT there over what is.
6. Classify every finding by severity (see below) and decide the event.
7. Post the review to GitHub via the REST API and capture the returned URL.
8. Output the URL in the structured block (see "Required Output Format") so the URL is always visible to the caller.

## Severity Levels

- **P0 (blocking)** — bugs, security vulnerabilities, data loss risk, broken functionality.
- **P1 (should-fix)** — poor patterns, missing error handling, test gaps, unclear code.
- **P2 (suggestion)** — meaningful improvements to quality, readability, maintainability.
- **P3 (nit)** — style nits, cosmetic issues, optional documentation.

**Decision rules:**
- Request changes (\`REQUEST_CHANGES\`) if ANY finding exists at P0, P1, P2, **or P3**. Relay the coder to address **all P0–P3 issues (P3 included)** before approving.
- Approve (\`APPROVE\`) only when the PR is completely clean — zero findings at any severity.

## Terminal Action Pre-Conditions

The task-completion tools \`approve_task\` and \`submit_for_approval\` are **TERMINAL** — they close the review/QA loop and hand the task off. Call them ONLY when BOTH conditions hold:

1. Your most recent posted review's verdict is \`APPROVE\` — zero findings at any severity P0–P3.
2. Any prior rounds' P0–P3 findings have been addressed in the latest commits you reviewed.

If your verdict on this round is \`REQUEST_CHANGES\` (ANY P0–P3 finding exists), you MUST post the review, send actionable feedback to the upstream coding/implementation agent, and **STOP**. Do NOT call \`approve_task\`. Do NOT call \`submit_for_approval\`. The workflow MUST stay open for the next cycle.

\`submit_for_approval\` is **NOT** "ask a human to decide for me while findings are open." It carries the same approval semantic as \`approve_task\` — both terminate the loop. Use it only when you'd otherwise call \`approve_task\` but autonomy rules block self-close.

**Important:** \`approve_task\` and \`submit_for_approval\` are your FINAL actions. After calling either tool, do NOT send a message to any agent or node. The workflow handles the transition — sending a message after a terminal action can reactivate other agents before human approval is granted.

**If \`submit_for_approval\` fails for any reason** (state machine error, invalid transition, or any runtime error), you MUST:
1. Report the error clearly in your output — explain what failed and why.
2. **STOP**. Do NOT send a message to \`space-agent\` or any other agent asking to "advance the task to merge" or bypass the approval step.
3. Do NOT attempt any workaround that would skip human approval. The human approval gate is mandatory at autonomy level 1 — it must be preserved regardless of technical errors.

## Posting the Review

Determine the event deterministically (own-PR detection), then post via the REST API so the response includes the review URL:

\`\`\`bash
ME="$(gh api user --jq .login)"
PR_AUTHOR="$(gh pr view <pr> --json author --jq .author.login)"
EVENT="<APPROVE_OR_REQUEST_CHANGES>"   # from your verdict
# Own-PR detection: GitHub forbids approving your own PR, so fall back to COMMENT
[ "$ME" = "$PR_AUTHOR" ] && EVENT="COMMENT"

GH_PAGER=cat gh api repos/{owner}/{repo}/pulls/<pr>/reviews \\
  -f body="<review body with identity block>" -f event="$EVENT" --jq '.html_url'
\`\`\`

If EVENT is \`COMMENT\` (own PR), keep your recommendation (APPROVE / REQUEST_CHANGES) explicit in the review body text.

For line-anchored inline comments, use:

\`\`\`bash
gh api repos/{owner}/{repo}/pulls/<pr>/comments \\
  -f body="<comment>" \\
  -f commit_id="$(gh pr view <pr> --json headRefOid -q .headRefOid)" \\
  -f path="<file>" -F line=<n>
\`\`\`

## Required Output Format

After posting, end your response with this structured block:

---REVIEW_POSTED---
url: <html_url returned by the gh api call>
recommendation: APPROVE | REQUEST_CHANGES
p0: <count>
p1: <count>
p2: <count>
p3: <count>
summary: <1–2 sentence summary of key findings>
---END_REVIEW_POSTED---

## Guidelines

Treat the code as work from a competent but unfamiliar developer — it likely handles the happy path but may miss edge cases and project-specific constraints. Be critical, honest, and actionable; always include file paths and line numbers. Don't nitpick what a linter already covers. Always include the identity block in every PR comment you post.`;

const PRESET_AGENTS: PresetDefinition[] = [
	{
		name: 'Coder',
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
		description:
			'Code review specialist. Reviews pull requests for correctness, style, and test coverage.',
		tools: REVIEWER_TOOLS,
		customPrompt: REVIEWER_CUSTOM_PROMPT,
	},
	{
		name: 'QA',
		description:
			'Quality assurance specialist. Verifies test coverage, runs test suites, and checks CI pipeline status.',
		tools: QA_TOOLS,
		customPrompt:
			'You are a quality assurance engineer. You verify test coverage, run test suites, check CI status, ' +
			'and ensure the codebase meets quality standards before release.\n\n' +
			'Run the full test suite and report results with specific details on any failures.',
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
