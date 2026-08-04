/**
 * seedPresetAgents Unit Tests
 *
 * Verifies that the six preset SpaceWorkerAgent records are created with correct
 * defaults (role, tools, description) and that seeding is idempotent (errors
 * on name collision are captured but do not abort remaining seeds).
 */

import { Database } from '../../../../src/storage/sqlite-compat';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { KNOWN_TOOLS } from '@hyperneo/shared';
import { setModelsCache } from '../../../../src/lib/model-service';
import {
  getPresetAgentTemplates,
  PRESET_AGENT_TOOLS,
  SUB_SESSION_FEATURES,
  seedPresetAgents,
} from '../../../../src/lib/space/agents/seed-agents';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository';
import { createSpaceAgentSchema, insertSpace } from '../../helpers/space-agent-schema';

describe('seedPresetAgents', () => {
  let db: Database;
  let manager: SpaceAgentManager;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceAgentSchema(db);
    insertSpace(db);
    const repo = new SpaceAgentRepository(db as any);
    manager = new SpaceAgentManager(repo);
    setModelsCache(new Map()); // skip model validation
  });

  afterEach(() => {
    db.close();
    setModelsCache(new Map());
  });

  it('creates exactly seven preset agents', async () => {
    const result = await seedPresetAgents('space-1', manager);

    expect(result.seeded).toHaveLength(7);
    expect(result.errors).toHaveLength(0);
  });

  it('creates agents with correct roles', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);

    const names = seeded.map((a) => a.name.toLowerCase()).sort();
    expect(names).toEqual([
      'coder',
      'general',
      'planner',
      'pr merger',
      'qa',
      'research',
      'reviewer',
    ]);
  });

  it('creates agents with correct names', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);

    const names = seeded.map((a) => a.name).sort();
    // Default sort is UTF-16 code-unit order: uppercase 'R' (82) < lowercase
    // 'l' (108), so 'PR Merger' sorts before 'Planner'.
    expect(names).toEqual([
      'Coder',
      'General',
      'PR Merger',
      'Planner',
      'QA',
      'Research',
      'Reviewer',
    ]);
  });

  it('sets tools on each preset agent', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);

    for (const agent of seeded) {
      expect(Array.isArray(agent.tools)).toBe(true);
    }
  });

  it('reviewer has NO shell — drops Bash, posts reviews via post_review (Option C)', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const reviewer = seeded.find((a) => a.name === 'Reviewer');

    expect(reviewer).toBeDefined();
    // Role separation: the Reviewer is a pure static-review role with no shell.
    expect(reviewer?.tools).not.toContain('Bash');
    expect(reviewer?.tools).not.toContain('Write');
    expect(reviewer?.tools).not.toContain('Edit');
    expect(reviewer?.tools).toContain('Read');
    // post_review is an MCP tool, so it is NOT listed in the tools profile
    // (the profile only holds SDK built-ins). Its usage is taught in the prompt
    // and the tool is registered for the reviewer session at runtime.
    expect(reviewer?.tools).not.toContain('post_review');
    expect(reviewer?.customPrompt).toContain('post_review');
  });

  it('PR Merger is the designated shell agent (Bash present, no Write/Edit)', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const merger = seeded.find((a) => a.name === 'PR Merger');

    expect(merger).toBeDefined();
    expect(merger?.handle).toBe('merger');
    // The Merger holds the only Bash tool in the review/merge split.
    expect(merger?.tools).toContain('Bash');
    expect(merger?.tools).toContain('Read');
    expect(merger?.tools).not.toContain('Write');
    expect(merger?.tools).not.toContain('Edit');
    expect(merger?.customPrompt).toContain('mark_complete');
  });

  it('coder inherits all SDK built-ins and has explicit no-merge prompt', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const coder = seeded.find((a) => a.name === 'Coder');

    expect(coder?.tools).toEqual([]);
    expect(coder?.customPrompt).toContain('Do NOT merge PRs. Your job is implementation only.');
    expect(coder?.customPrompt).toContain('When the reviewer approves, your work is done.');
    expect(coder?.customPrompt).toContain('The reviewer handles the merge.');
  });

  it('research agent inherits all SDK built-ins (Write + Edit for committing findings)', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const research = seeded.find((a) => a.name === 'Research');

    expect(research?.tools).toEqual([]);
  });

  it('sets descriptions on all preset agents', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);

    for (const agent of seeded) {
      expect(typeof agent.description).toBe('string');
      expect((agent.description?.length ?? 0) > 0).toBe(true);
    }
  });

  it('assigns agents to the correct spaceId', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);

    for (const agent of seeded) {
      expect(agent.spaceId).toBe('space-1');
    }
  });

  it('is idempotent — records errors but seeds remaining agents on name collision', async () => {
    // Seed once
    await seedPresetAgents('space-1', manager);

    // Seed again — all seven names are now taken
    const second = await seedPresetAgents('space-1', manager);

    expect(second.seeded).toHaveLength(0);
    expect(second.errors).toHaveLength(7);
    for (const err of second.errors) {
      expect(err.error).toMatch(/already exists/i);
    }
  });

  it('seeds different spaces independently', async () => {
    insertSpace(db, 'space-2');

    const r1 = await seedPresetAgents('space-1', manager);
    const r2 = await seedPresetAgents('space-2', manager);

    expect(r1.seeded).toHaveLength(7);
    expect(r2.seeded).toHaveLength(7);
    expect(r1.errors).toHaveLength(0);
    expect(r2.errors).toHaveLength(0);

    // Each space has its own independent set
    for (const a of r1.seeded) expect(a.spaceId).toBe('space-1');
    for (const a of r2.seeded) expect(a.spaceId).toBe('space-2');
  });

  it('partial collision — seeds succeed for non-conflicting names', async () => {
    // Pre-create just the 'Coder' agent
    await manager.create({ spaceId: 'space-1', name: 'Coder' });

    const result = await seedPresetAgents('space-1', manager);

    // Coder fails, others succeed
    expect(result.seeded).toHaveLength(6);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].name).toBe('Coder');
  });

  it('General agent inherits all SDK built-ins', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const general = seeded.find((a) => a.name === 'General');

    expect(general).toBeDefined();
    expect(general?.tools).toEqual([]);
  });

  it('QA agent has restricted tools (no Write or Edit)', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const qa = seeded.find((a) => a.name === 'QA');

    expect(qa).toBeDefined();
    expect(qa?.tools).not.toContain('Write');
    expect(qa?.tools).not.toContain('Edit');
    expect(qa?.tools).toContain('Read');
    expect(qa?.tools).toContain('Bash');
    expect(qa?.tools).toContain('Grep');
    expect(qa?.tools).toContain('Glob');
  });

  it('all preset agents have a non-empty custom prompt', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);

    for (const agent of seeded) {
      expect(typeof agent.customPrompt).toBe('string');
      expect(agent.customPrompt?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('Coder custom prompt mentions code and PR', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const coder = seeded.find((a) => a.name === 'Coder');

    expect(coder?.customPrompt).toContain('software engineer');
    expect(coder?.customPrompt).toContain('commit');
    expect(coder?.customPrompt).toContain('PR');
  });

  it('Research custom prompt mentions investigation and findings', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const research = seeded.find((a) => a.name === 'Research');

    expect(research?.customPrompt).toContain('research specialist');
    expect(research?.customPrompt).toContain('markdown');
    expect(research?.customPrompt).toContain('PR');
  });

  it('Reviewer custom prompt mentions code review', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const reviewer = seeded.find((a) => a.name === 'Reviewer');

    expect(reviewer?.customPrompt).toContain('Reviewer System Contract');
    expect(reviewer?.customPrompt?.toLowerCase()).toContain('reviewer');
  });

  it('Reviewer custom prompt delegates exploration to the built-in general-purpose sub-agent via the Task tool', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const reviewer = seeded.find((a) => a.name === 'Reviewer');

    // Space reviewer agents now carry Task/TaskOutput/TaskStop and are
    // expected to delegate exploration to the built-in `general-purpose`
    // sub-agent that ships with the `claude_code` preset. Custom reviewer
    // sub-agents (e.g. reviewer-explorer / reviewer-fact-checker) are a
    // planned follow-up and must NOT be referenced yet.
    expect(reviewer?.customPrompt).toContain('multiple Task general-purpose sub-agents');
    // We deliberately do not reference custom reviewer sub-agents that are
    // not yet defined as workflow-template/data.
    expect(reviewer?.customPrompt).not.toContain('reviewer-explorer');
    expect(reviewer?.customPrompt).not.toContain('reviewer-fact-checker');
  });

  it('Reviewer custom prompt includes an identity block', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const reviewer = seeded.find((a) => a.name === 'Reviewer');

    // Identity must appear in every posted PR comment.
    expect(reviewer?.customPrompt).toContain('Review by <your model>');
    expect(reviewer?.customPrompt).toContain('Client:** HyperNeo');
    expect(reviewer?.customPrompt).toMatch(/Model:/);
    expect(reviewer?.customPrompt).toMatch(/Provider:/);
  });

  it('Reviewer custom prompt defines P0–P3 severity levels with decision rules', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const reviewer = seeded.find((a) => a.name === 'Reviewer');

    expect(reviewer?.customPrompt).toContain('P0');
    expect(reviewer?.customPrompt).toContain('P1');
    expect(reviewer?.customPrompt).toContain('P2');
    expect(reviewer?.customPrompt).toContain('P3');
    expect(reviewer?.customPrompt).toContain('REQUEST_CHANGES');
    expect(reviewer?.customPrompt).toContain('APPROVE');
    // Decision rule: request changes when any P0-P3 finding exists.
    expect(reviewer?.customPrompt).toContain('P0-P3');
    expect(reviewer?.customPrompt).toContain('Request changes for any P0-P3 finding');
  });

  it('Reviewer custom prompt fences terminal actions while findings are open (Task #136 regression)', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const reviewer = seeded.find((a) => a.name === 'Reviewer');

    expect(reviewer?.customPrompt).toContain('Terminal-action contract');
    expect(reviewer?.customPrompt).toContain('approve_task/submit_for_approval');
    expect(reviewer?.customPrompt).toContain('zero P0-P3 findings');
    expect(reviewer?.customPrompt).toContain('If findings remain');
  });

  it('Reviewer custom prompt prohibits space-agent merge bypass when submit_for_approval fails (Task #295)', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const reviewer = seeded.find((a) => a.name === 'Reviewer');

    expect(reviewer?.customPrompt).toContain('If findings remain');
    expect(reviewer?.customPrompt).toContain('send actionable upstream feedback');
    expect(reviewer?.customPrompt).toContain('stop');
  });

  it('Reviewer custom prompt includes own-PR detection', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const reviewer = seeded.find((a) => a.name === 'Reviewer');

    expect(reviewer?.customPrompt).toContain('own-PR fallback');
    expect(reviewer?.customPrompt).toContain('COMMENT');
    expect(reviewer?.customPrompt).toContain('match your actual verdict');
  });

  it('Reviewer custom prompt emphasises goal alignment, completeness, and omissions', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const reviewer = seeded.find((a) => a.name === 'Reviewer');

    expect(reviewer?.customPrompt?.toLowerCase()).toContain('goal');
    expect(reviewer?.customPrompt?.toLowerCase()).toContain('completeness');
    expect(reviewer?.customPrompt?.toLowerCase()).toContain('omissions');
    expect(reviewer?.customPrompt?.toLowerCase()).toContain('over-engineering');
  });

  it('Reviewer custom prompt posts reviews via post_review and captures the returned URL', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const reviewer = seeded.find((a) => a.name === 'Reviewer');

    expect(reviewer?.customPrompt).toContain('returned URL');
    expect(reviewer?.customPrompt).toContain('GitHub review procedure');
    // The shell-free tool is the mechanism — never gh api directly.
    expect(reviewer?.customPrompt).toContain('post_review');
    expect(reviewer?.customPrompt).toContain('no shell');
  });

  it('Planner custom prompt mentions planning', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const planner = seeded.find((a) => a.name === 'Planner');

    expect(planner?.customPrompt).toContain('project manager');
    expect(planner?.customPrompt).toContain('plan');
  });

  it('QA custom prompt mentions quality assurance', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const qa = seeded.find((a) => a.name === 'QA');

    expect(qa?.customPrompt).toContain('QA System Contract');
    expect(qa?.customPrompt).toContain('quality assurance');
  });

  it('General custom prompt mentions versatile development', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const general = seeded.find((a) => a.name === 'General');

    expect(general?.customPrompt).toContain('versatile');
    expect(general?.customPrompt).toContain('implement');
  });
});

// ---------------------------------------------------------------------------
// Exact tool sets, system prompts, instructions, and exports
// ---------------------------------------------------------------------------

describe('preset agent exact definitions', () => {
  let db: Database;
  let manager: SpaceAgentManager;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceAgentSchema(db);
    insertSpace(db);
    const repo = new SpaceAgentRepository(db as any);
    manager = new SpaceAgentManager(repo);
    setModelsCache(new Map());
  });

  afterEach(() => {
    db.close();
    setModelsCache(new Map());
  });

  // --- Exact tool sets ---

  /** Permissive presets inherit all SDK built-ins; the seeded profile is empty. */
  const EXPECTED_CODER_TOOLS: string[] = [];

  const EXPECTED_REVIEWER_BASE_TOOLS = [
    'Read',
    'Grep',
    'Glob',
    'WebFetch',
    'WebSearch',
    'Skill',
    'ToolSearch',
  ];
  const EXPECTED_QA_TOOLS = [
    'Read',
    'Bash',
    'Grep',
    'Glob',
    'WebFetch',
    'WebSearch',
    'Skill',
    'ToolSearch',
  ];
  // Reviewer has the read-only toolset PLUS Task/TaskOutput/TaskStop so it can
  // dispatch the built-in `general-purpose` sub-agent for exploration. It has
  // NO Bash (Option C: the Merger is the designated shell agent). post_review is
  // an MCP tool, so it is intentionally absent from this profile.
  const EXPECTED_REVIEWER_TOOLS = [
    ...EXPECTED_REVIEWER_BASE_TOOLS,
    'Task',
    'TaskOutput',
    'TaskStop',
  ];

  /** PR Merger: Bash + read tools (the designated shell agent). */
  const EXPECTED_MERGER_TOOLS = ['Bash', 'Read', 'Grep', 'Glob'];

  it('general inherits all SDK built-ins (empty permissive profile)', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const general = seeded.find((a) => a.name === 'General')!;
    expect(general.tools).toEqual(EXPECTED_CODER_TOOLS);
  });

  it('Coder inherits all SDK built-ins (empty permissive profile)', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const coder = seeded.find((a) => a.name === 'Coder')!;
    expect(coder.tools).toEqual(EXPECTED_CODER_TOOLS);
  });

  it('General inherits all SDK built-ins (empty permissive profile)', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const general = seeded.find((a) => a.name === 'General')!;
    expect(general.tools).toEqual(EXPECTED_CODER_TOOLS);
  });

  it('Planner inherits all SDK built-ins (empty permissive profile)', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const planner = seeded.find((a) => a.name === 'Planner')!;
    expect(planner.tools).toEqual(EXPECTED_CODER_TOOLS);
  });

  it('Research inherits all SDK built-ins (empty permissive profile)', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const research = seeded.find((a) => a.name === 'Research')!;
    expect(research.tools).toEqual(EXPECTED_CODER_TOOLS);
  });

  it('Reviewer has exact REVIEWER_TOOLS (read-only + Task/*, NO Bash, NO post_review in profile)', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const reviewer = seeded.find((a) => a.name === 'Reviewer')!;
    expect(reviewer.tools).toEqual(EXPECTED_REVIEWER_TOOLS);
  });

  it('PR Merger has exact MERGER_TOOLS (Bash + read tools, no Write/Edit)', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const merger = seeded.find((a) => a.name === 'PR Merger')!;
    expect(merger.tools).toEqual(EXPECTED_MERGER_TOOLS);
  });

  it('QA has exact QA_TOOLS', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const qa = seeded.find((a) => a.name === 'QA')!;
    expect(qa.tools).toEqual(EXPECTED_QA_TOOLS);
  });

  // --- Exact custom prompts ---

  it('Coder has exact custom prompt', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const coder = seeded.find((a) => a.name === 'Coder')!;
    expect(coder.customPrompt).toBe(
      'You are an expert software engineer. You write clean, well-tested code following the ' +
        "project's existing conventions. You always commit your work, keep the working tree clean, " +
        'and open pull requests for review. Do NOT merge PRs. Your job is implementation only. ' +
        'When the reviewer approves, your work is done. The reviewer handles the merge.\n\n' +
        'Before finishing: ensure all tests pass, commit all changes, and open a PR with a clear description.'
    );
  });

  it('General has exact custom prompt', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const general = seeded.find((a) => a.name === 'General')!;
    expect(general.customPrompt).toBe(
      'You are a versatile software development assistant. You can write code, fix bugs, write documentation, ' +
        'analyze problems, and handle any general development task. You adapt to what is needed.\n\n' +
        'Understand the task, implement the solution, verify it works, and commit your changes.'
    );
  });

  it('Planner has exact custom prompt', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const planner = seeded.find((a) => a.name === 'Planner')!;
    expect(planner.customPrompt).toBe(
      'You are a technical project manager. You analyze goals, break them down into clear actionable ' +
        'tasks, identify dependencies, and produce structured implementation plans.\n\n' +
        'Produce a concrete plan with clear steps. Write the plan to a file and commit it.'
    );
  });

  it('Research has exact custom prompt', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const research = seeded.find((a) => a.name === 'Research')!;
    expect(research.customPrompt).toBe(
      'You are a research specialist. You investigate topics thoroughly using web search and code ' +
        'exploration, synthesize findings clearly, and document results in well-structured markdown files.\n\n' +
        'Save all findings to a markdown file, commit the file, and open a PR with a summary of what you found.'
    );
  });

  it('Reviewer custom prompt matches the template exported from seed-agents', async () => {
    // The source-of-truth for the reviewer prompt lives in seed-agents.ts.
    // This test pins "what seeds into a Space" to "what the template says"
    // without hard-coding the full body (which would churn on prose edits).
    const templates = getPresetAgentTemplates();
    const reviewerTemplate = templates.find((t) => t.name === 'Reviewer')!;

    const { seeded } = await seedPresetAgents('space-1', manager);
    const reviewer = seeded.find((a) => a.name === 'Reviewer')!;
    expect(reviewer.customPrompt).toBe(reviewerTemplate.customPrompt);
  });

  it('Reviewer custom prompt posts reviews via post_review and emits REVIEW_POSTED', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const reviewer = seeded.find((a) => a.name === 'Reviewer')!;
    expect(reviewer.customPrompt).toContain('GitHub review procedure');
    expect(reviewer.customPrompt).toContain('returned URL');
    expect(reviewer.customPrompt).toContain('REVIEW_POSTED');
    // The shell-free contract: post_review is the only posting mechanism, and
    // the own-PR fallback (APPROVE/REQUEST_CHANGES → COMMENT) is handled inside it.
    expect(reviewer.customPrompt).toContain('post_review');
    expect(reviewer.customPrompt).toContain('own-PR fallback');
    expect(reviewer.customPrompt).toContain('COMMENT');
    expect(reviewer.customPrompt).toContain('match your actual verdict');
  });

  // Regression guard for the role separation: the Reviewer contract must NOT
  // teach any `gh api` shell pattern — the Reviewer has no Bash. The previous
  // contract leaned on a `gh api … -f body="$(heredoc)"` procedure (with its
  // notorious `-f body=@-` trap); that entire liability is deleted in favour of
  // the post_review tool.
  it('Reviewer custom prompt teaches no gh api / heredoc posting pattern', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const reviewer = seeded.find((a) => a.name === 'Reviewer')!;
    const prompt = reviewer.customPrompt!;
    expect(prompt).toContain('never call gh api directly');
    // The old shell-based posting primitives must be gone.
    expect(prompt).not.toContain('-f body=@-');
    expect(prompt).not.toContain("-f body=\"$(cat <<'EOF'");
    expect(prompt).not.toContain('gh api repos/{owner}/{repo}/pulls/{n}/reviews');
  });

  it('QA has shared system contract prompt', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const qa = seeded.find((a) => a.name === 'QA')!;
    expect(qa.customPrompt).toContain('QA System Contract');
    expect(qa.customPrompt).toContain('trusted project QA instructions');
  });

  // --- Exact descriptions ---

  it('each agent has the exact description from PRESET_AGENTS', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);

    const expected: Record<string, string> = {
      Coder:
        'Implementation worker. Writes code, runs tests, commits changes, and opens pull requests.',
      General:
        'General-purpose worker. Handles a wide range of tasks including coding, documentation, ' +
        'debugging, and analysis.',
      Planner:
        'Planning agent. Breaks down goals into actionable tasks and drafts implementation plans.',
      Research:
        'Research agent. Investigates topics, gathers information, writes findings to docs, and opens pull requests with research results.',
      Reviewer:
        'Code review specialist. Reviews pull requests for correctness, style, and test coverage. ' +
        'Has no shell — posts reviews via the post_review tool.',
      'PR Merger':
        'Post-approval PR merge specialist. The designated execution agent: it runs gh pr merge, ' +
        'branch cleanup, worktree sync, and conflict routing. Spawned only after a task is approved.',
      QA: 'Quality assurance specialist. Verifies test coverage, runs test suites, and checks CI pipeline status.',
    };

    for (const agent of seeded) {
      expect(agent.description).toBe(expected[agent.name]);
    }
  });
});

// ---------------------------------------------------------------------------
// PRESET_AGENT_TOOLS export
// ---------------------------------------------------------------------------

describe('PRESET_AGENT_TOOLS export', () => {
  /** Permissive presets have an empty visible profile; they inherit all SDK built-ins. */
  const EXPECTED_CODER_TOOLS: string[] = [];

  const EXPECTED_REVIEWER_BASE_TOOLS = [
    'Read',
    'Grep',
    'Glob',
    'WebFetch',
    'WebSearch',
    'Skill',
    'ToolSearch',
  ];
  const EXPECTED_QA_TOOLS = [
    'Read',
    'Bash',
    'Grep',
    'Glob',
    'WebFetch',
    'WebSearch',
    'Skill',
    'ToolSearch',
  ];
  // Reviewer carries Task/TaskOutput/TaskStop for built-in `general-purpose`
  // sub-agent delegation. It has NO Bash (Option C: the Merger is the
  // designated shell agent). post_review is an MCP tool, intentionally absent
  // from the profile (MCP tools are inherited regardless of the profile).
  const EXPECTED_REVIEWER_TOOLS = [
    ...EXPECTED_REVIEWER_BASE_TOOLS,
    'Task',
    'TaskOutput',
    'TaskStop',
  ];
  const EXPECTED_MERGER_TOOLS = ['Bash', 'Read', 'Grep', 'Glob'];

  it('has entries for all 7 preset roles', () => {
    expect(Object.keys(PRESET_AGENT_TOOLS).sort()).toEqual([
      'coder',
      'general',
      'merger',
      'planner',
      'qa',
      'research',
      'reviewer',
    ]);
  });

  it('coder role maps to empty permissive profile', () => {
    expect(PRESET_AGENT_TOOLS.coder).toEqual(EXPECTED_CODER_TOOLS);
  });

  it('general role maps to GENERAL_TOOLS (empty permissive profile)', () => {
    expect(PRESET_AGENT_TOOLS.general).toEqual(EXPECTED_CODER_TOOLS);
  });

  it('planner role maps to PLANNER_TOOLS (empty permissive profile)', () => {
    expect(PRESET_AGENT_TOOLS.planner).toEqual(EXPECTED_CODER_TOOLS);
  });

  it('research role maps to RESEARCH_TOOLS (empty permissive profile)', () => {
    expect(PRESET_AGENT_TOOLS.research).toEqual(EXPECTED_CODER_TOOLS);
  });

  it('reviewer role maps to REVIEWER_TOOLS (read-only + Task/*, NO Bash)', () => {
    expect(PRESET_AGENT_TOOLS.reviewer).toEqual(EXPECTED_REVIEWER_TOOLS);
  });

  it('merger role maps to MERGER_TOOLS (Bash + read tools)', () => {
    expect(PRESET_AGENT_TOOLS.merger).toEqual(EXPECTED_MERGER_TOOLS);
  });

  it('qa role maps to QA_TOOLS', () => {
    expect(PRESET_AGENT_TOOLS.qa).toEqual(EXPECTED_QA_TOOLS);
  });

  it('PRESET_AGENT_TOOLS matches what seedPresetAgents actually seeds', async () => {
    const db = new Database(':memory:');
    createSpaceAgentSchema(db);
    insertSpace(db);
    const repo = new SpaceAgentRepository(db as any);
    const mgr = new SpaceAgentManager(repo);
    setModelsCache(new Map());

    const { seeded } = await seedPresetAgents('space-1', mgr);

    for (const agent of seeded) {
      // PRESET_AGENT_TOOLS is keyed by handle (e.g. 'merger'), which for
      // single-word presets matches name.toLowerCase() but diverges for
      // multi-word names like 'PR Merger' → handle 'merger'.
      const roleKey = agent.handle;
      expect(PRESET_AGENT_TOOLS[roleKey]).toBeDefined();
      expect(agent.tools).toEqual(PRESET_AGENT_TOOLS[roleKey]);
    }

    db.close();
    setModelsCache(new Map());
  });
});

// ---------------------------------------------------------------------------
// SUB_SESSION_FEATURES export
// ---------------------------------------------------------------------------

describe('SUB_SESSION_FEATURES export', () => {
  it('has exactly the expected feature flags', () => {
    expect(SUB_SESSION_FEATURES).toEqual({
      rewind: false,
      worktree: false,
      coordinator: false,
      archive: false,
      sessionInfo: false,
    });
  });

  it('all feature values are false', () => {
    for (const [, value] of Object.entries(SUB_SESSION_FEATURES)) {
      expect(value).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// getPresetAgentTemplates export
// ---------------------------------------------------------------------------

describe('getPresetAgentTemplates', () => {
  it('returns exactly 7 templates', () => {
    const templates = getPresetAgentTemplates();
    expect(templates).toHaveLength(7);
  });

  it('returns all expected agent names', () => {
    const templates = getPresetAgentTemplates();
    const names = templates.map((t) => t.name).sort();
    expect(names).toEqual([
      'Coder',
      'General',
      'PR Merger',
      'Planner',
      'QA',
      'Research',
      'Reviewer',
    ]);
  });

  it('each template has name, description, tools, and customPrompt', () => {
    const templates = getPresetAgentTemplates();
    for (const t of templates) {
      expect(typeof t.name).toBe('string');
      expect(t.name.length).toBeGreaterThan(0);
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(0);
      expect(Array.isArray(t.tools)).toBe(true);
      expect(typeof t.customPrompt).toBe('string');
      expect(t.customPrompt.length).toBeGreaterThan(0);
    }
  });

  it('returns cloned arrays — mutating tools does not affect globals', () => {
    const first = getPresetAgentTemplates();
    const coderTools = first.find((t) => t.name === 'Coder')!.tools;
    coderTools.push('FakeTool');

    const second = getPresetAgentTemplates();
    const coderTools2 = second.find((t) => t.name === 'Coder')!.tools;
    expect(coderTools2).not.toContain('FakeTool');
  });

  it('template tools match PRESET_AGENT_TOOLS', () => {
    const templates = getPresetAgentTemplates();
    for (const t of templates) {
      // PRESET_AGENT_TOOLS is keyed by handle, not display name.
      const roleKey = t.handle;
      expect(t.tools).toEqual(PRESET_AGENT_TOOLS[roleKey]);
    }
  });
});
