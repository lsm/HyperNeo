/**
 * seedPresetAgents Unit Tests
 *
 * Verifies that the six preset SpaceWorkerAgent records are created with correct
 * defaults (role, tools, description) and that seeding is idempotent (errors
 * on name collision are captured but do not abort remaining seeds).
 */

import { Database } from '../../../../src/storage/sqlite-compat';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { KNOWN_TOOLS, type SpaceWorkerAgent } from '@hyperneo/shared';
import { setModelsCache } from '../../../../src/lib/model-service';
import {
  getPresetAgentTemplates,
  isPristineRetiredPrMergerRow,
  PRESET_AGENT_TOOLS,
  RETIRED_PR_MERGER_DESCRIPTION,
  RETIRED_PR_MERGER_PROMPT,
  RETIRED_PR_MERGER_TOOLS,
  retireRemovedPresetAgents,
  SUB_SESSION_FEATURES,
  seedPresetAgents,
} from '../../../../src/lib/space/agents/seed-agents';
import { computeAgentTemplateHash } from '../../../../src/lib/space/agents/agent-template-hash';
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

  it('creates exactly six preset agents', async () => {
    const result = await seedPresetAgents('space-1', manager);

    expect(result.seeded).toHaveLength(6);
    expect(result.errors).toHaveLength(0);
  });

  it('creates agents with correct roles', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);

    const names = seeded.map((a) => a.name.toLowerCase()).sort();
    expect(names).toEqual(['coder', 'general', 'planner', 'qa', 'research', 'reviewer']);
  });

  it('creates agents with correct names', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);

    const names = seeded.map((a) => a.name).sort();
    expect(names).toEqual(['Coder', 'General', 'Planner', 'QA', 'Research', 'Reviewer']);
  });

  it('sets tools on each preset agent', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);

    for (const agent of seeded) {
      expect(Array.isArray(agent.tools)).toBe(true);
    }
  });

  it('reviewer has Bash for read-only inspection + Cron, but NO Write/Edit (restrained review role)', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const reviewer = seeded.find((a) => a.name === 'Reviewer');

    expect(reviewer).toBeDefined();
    // The Reviewer keeps Bash (for GitHub read-only inspection and posting
    // reviews via the gh CLI) and Cron tools for scheduled follow-ups, but
    // it is restrained: no Write/Edit so it cannot modify code under review.
    expect(reviewer?.tools).toContain('Bash');
    expect(reviewer?.tools).toContain('Read');
    expect(reviewer?.tools).toContain('CronCreate');
    expect(reviewer?.tools).toContain('CronDelete');
    expect(reviewer?.tools).toContain('CronList');
    expect(reviewer?.tools).not.toContain('Write');
    expect(reviewer?.tools).not.toContain('Edit');
    // The reviewer's restraint is taught by its custom prompt (Reviewer System
    // Contract): it must not run the code under review and must not merge.
    expect(reviewer?.customPrompt).toContain('Reviewer System Contract');
    expect(reviewer?.customPrompt).toContain('addPullRequestReview');
  });

  it('Reviewer is the designated inspection-and-review agent (Bash present, no Write/Edit)', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const reviewer = seeded.find((a) => a.name === 'Reviewer');

    expect(reviewer).toBeDefined();
    expect(reviewer?.handle).toBe('reviewer');
    // The Reviewer holds Bash for read-only GitHub inspection and review
    // posting; there is no separate merger agent anymore.
    expect(reviewer?.tools).toContain('Bash');
    expect(reviewer?.tools).toContain('Read');
    expect(reviewer?.tools).not.toContain('Write');
    expect(reviewer?.tools).not.toContain('Edit');
    expect(reviewer?.customPrompt).toContain('Reviewer System Contract');
  });

  it('coder inherits all SDK built-ins and defers merge to the post-approval phase', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const coder = seeded.find((a) => a.name === 'Coder');

    expect(coder?.tools).toEqual([]);
    // The coder implements first and opens a PR; it must not merge during
    // implementation, but (unlike the old preset) it may merge in the
    // post-approval phase when the workflow sends the merge procedure.
    expect(coder?.customPrompt).toMatch(/[Dd]uring implementation, do not merge your own PR/);
    expect(coder?.customPrompt).toContain('post-approval merge is a separate phase');
    expect(coder?.customPrompt).toContain('open pull requests for review');
    expect(coder?.customPrompt).not.toContain('The reviewer handles the merge.');
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

    // Seed again — all six names are now taken
    const second = await seedPresetAgents('space-1', manager);

    expect(second.seeded).toHaveLength(0);
    expect(second.errors).toHaveLength(6);
    for (const err of second.errors) {
      expect(err.error).toMatch(/already exists/i);
    }
  });

  it('seeds different spaces independently', async () => {
    insertSpace(db, 'space-2');

    const r1 = await seedPresetAgents('space-1', manager);
    const r2 = await seedPresetAgents('space-2', manager);

    expect(r1.seeded).toHaveLength(6);
    expect(r2.seeded).toHaveLength(6);
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
    expect(result.seeded).toHaveLength(5);
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
    // No P2/P3 approval leak: every severity blocks, verdict is count-derived.
    expect(reviewer?.customPrompt).toContain('All four severities block approval');
    expect(reviewer?.customPrompt).toContain('no optional severity');
    expect(reviewer?.customPrompt).toContain('pure function of your finding counts');
    expect(reviewer?.customPrompt).toContain('P0=P1=P2=P3=0');
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
    expect(reviewer?.customPrompt).toContain('match your verdict');
  });

  it('Reviewer custom prompt emphasises goal alignment, completeness, and omissions', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const reviewer = seeded.find((a) => a.name === 'Reviewer');

    expect(reviewer?.customPrompt?.toLowerCase()).toContain('goal');
    expect(reviewer?.customPrompt?.toLowerCase()).toContain('completeness');
    expect(reviewer?.customPrompt?.toLowerCase()).toContain('omissions');
    expect(reviewer?.customPrompt?.toLowerCase()).toContain('over-engineering');
  });

  it('Reviewer custom prompt posts reviews via the addPullRequestReview mutation and emits REVIEW_POSTED', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const reviewer = seeded.find((a) => a.name === 'Reviewer');

    expect(reviewer?.customPrompt).toContain('GitHub review procedure');
    expect(reviewer?.customPrompt).toContain('html_url returned by GitHub');
    // The reviewer uses Bash to post a visible review via the gh CLI — there is
    // no post_review MCP tool anymore. The mutation returns the review URL, so
    // the contract never queries the PR-wide latest review (a race).
    expect(reviewer?.customPrompt).toContain('addPullRequestReview');
    expect(reviewer?.customPrompt).not.toContain('REVIEW_BODY_TERMINATOR');
    expect(reviewer?.customPrompt).toContain('REVIEW_POSTED');
    expect(reviewer?.customPrompt).not.toContain('post_review');
  });

  it('Reviewer custom prompt inspects PR diffs via gh pr diff (authed, private repos included)', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const reviewer = seeded.find((a) => a.name === 'Reviewer');

    // The Reviewer reads PR diffs via Bash (gh pr diff / gh pr view / gh api
    // graphql reviewThreads) rather than a post_review MCP tool.
    expect(reviewer?.customPrompt).toContain('gh pr diff');
    expect(reviewer?.customPrompt?.toLowerCase()).toContain('private repos');
    expect(reviewer?.customPrompt).not.toContain('get_pr_diff');
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
  // Reviewer has the read-only toolset PLUS Bash (for read-only GitHub
  // inspection and posting reviews via the gh CLI), PLUS Task/* for
  // `general-purpose` sub-agent delegation, PLUS Cron* for scheduled follow-ups.
  // It still has NO Write/Edit — the reviewer cannot modify the code under review.
  const EXPECTED_REVIEWER_TOOLS = [
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

  it('Reviewer has exact REVIEWER_TOOLS (read-only + Bash + Task/* + Cron*, no Write/Edit)', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const reviewer = seeded.find((a) => a.name === 'Reviewer')!;
    expect(reviewer.tools).toEqual(EXPECTED_REVIEWER_TOOLS);
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
        'and open pull requests for review. During implementation, do not merge your own PR — post-approval ' +
        'merge is a separate phase: once the task is approved, the workflow may send you the merge procedure, ' +
        'which you follow (that is when you merge). Your job is implementation first; review feedback comes back ' +
        'until the work is clean.\n\n' +
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

  it('Reviewer custom prompt posts reviews via the addPullRequestReview mutation and emits REVIEW_POSTED', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const reviewer = seeded.find((a) => a.name === 'Reviewer')!;
    expect(reviewer.customPrompt).toContain('GitHub review procedure');
    expect(reviewer.customPrompt).toContain('html_url returned by GitHub');
    expect(reviewer.customPrompt).toContain('REVIEW_POSTED');
    // The posting mechanism is the `addPullRequestReview` mutation via Bash,
    // which returns the exact review URL (no latest-review query race). The
    // own-PR fallback (APPROVE/REQUEST_CHANGES → COMMENT) is described in the
    // contract.
    expect(reviewer.customPrompt).toContain('addPullRequestReview');
    expect(reviewer.customPrompt).toContain('pullRequestReview.url');
    expect(reviewer.customPrompt).toContain('own-PR fallback');
    expect(reviewer.customPrompt).toContain('COMMENT');
    expect(reviewer.customPrompt).toContain('match your verdict');
    // The post_review MCP tool no longer exists.
    expect(reviewer.customPrompt).not.toContain('post_review');
  });

  // The Reviewer writes review prose to a temp file with a QUOTED heredoc that
  // uses a per-invocation delimiter (never a fixed public terminator), then
  // posts via the `addPullRequestReview` GraphQL mutation with the body loaded
  // through jq --rawfile. The old `-f body="$(heredoc)"` shell trap and the
  // `post_review` MCP tool are gone.
  it('Reviewer custom prompt writes body files with a per-invocation heredoc and posts via the mutation', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const reviewer = seeded.find((a) => a.name === 'Reviewer')!;
    const prompt = reviewer.customPrompt!;
    expect(prompt).toContain('addPullRequestReview');
    expect(prompt).toContain('per-invocation');
    // The old shell-based posting primitives must be gone.
    expect(prompt).not.toContain('-f body=@-');
    expect(prompt).not.toContain("-f body=\"$(cat <<'EOF'");
    expect(prompt).not.toContain('gh api repos/{owner}/{repo}/pulls/{n}/reviews');
    expect(prompt).not.toContain('post_review');
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
        'Has bash for read-only inspection and posts reviews via the gh CLI.',
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
  // Reviewer carries Bash (for read-only GitHub inspection and gh-CLI review
  // posting) + Task/* for built-in `general-purpose` sub-agent delegation +
  // Cron* for scheduled follow-ups. It has NO Write/Edit — it cannot modify the
  // code under review.
  const EXPECTED_REVIEWER_TOOLS = [
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

  it('has entries for all 6 preset roles', () => {
    expect(Object.keys(PRESET_AGENT_TOOLS).sort()).toEqual([
      'coder',
      'general',
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

  it('reviewer role maps to REVIEWER_TOOLS (read-only + Bash + Task/* + Cron*, no Write/Edit)', () => {
    expect(PRESET_AGENT_TOOLS.reviewer).toEqual(EXPECTED_REVIEWER_TOOLS);
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
      // PRESET_AGENT_TOOLS is keyed by handle; every preset handle is a
      // single-word key (coder, reviewer, qa, …), so lookups succeed.
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
  it('returns exactly 6 templates', () => {
    const templates = getPresetAgentTemplates();
    expect(templates).toHaveLength(6);
  });

  it('returns all expected agent names', () => {
    const templates = getPresetAgentTemplates();
    const names = templates.map((t) => t.name).sort();
    expect(names).toEqual(['Coder', 'General', 'Planner', 'QA', 'Research', 'Reviewer']);
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

// ===========================================================================
// Retired preset cleanup (round-11 P2)
// ===========================================================================

describe('retireRemovedPresetAgents', () => {
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

  function seedPristinePrMerger(): Promise<SpaceWorkerAgent> {
    return manager
      .create({
        spaceId: 'space-1',
        name: 'PR Merger',
        handle: 'merger',
        description: RETIRED_PR_MERGER_DESCRIPTION,
        tools: [...RETIRED_PR_MERGER_TOOLS],
        customPrompt: RETIRED_PR_MERGER_PROMPT,
        templateName: 'PR Merger',
        templateHash: computeAgentTemplateHash({
          name: 'PR Merger',
          handle: 'merger',
          description: RETIRED_PR_MERGER_DESCRIPTION,
          tools: [...RETIRED_PR_MERGER_TOOLS],
          customPrompt: RETIRED_PR_MERGER_PROMPT,
        }),
      })
      .then((r) => {
        if (!r.ok) throw new Error(r.error);
        return r.value;
      });
  }

  it('deletes a pristine, unreferenced PR Merger row', async () => {
    const merger = await seedPristinePrMerger();
    const retired = retireRemovedPresetAgents('space-1', {
      agentManager: manager,
      referencedAgentIds: new Set(),
    });
    expect(retired).toEqual(['PR Merger']);
    const remaining = manager.listBySpaceId('space-1').map((a) => a.id);
    expect(remaining).not.toContain(merger.id);
  });

  it('protects a pristine row referenced by a workflow (active run / custom slot)', async () => {
    const merger = await seedPristinePrMerger();
    const retired = retireRemovedPresetAgents('space-1', {
      agentManager: manager,
      referencedAgentIds: new Set([merger.id]),
    });
    expect(retired).toEqual([]);
    expect(manager.listBySpaceId('space-1').map((a) => a.id)).toContain(merger.id);
  });

  it('preserves a customized PR Merger row (renamed prompt)', async () => {
    const merger = await seedPristinePrMerger();
    manager.update(merger.id, { customPrompt: 'My custom merger prompt' });
    const retired = retireRemovedPresetAgents('space-1', {
      agentManager: manager,
      referencedAgentIds: new Set(),
    });
    expect(retired).toEqual([]);
    expect(manager.listBySpaceId('space-1').map((a) => a.id)).toContain(merger.id);
  });

  it('preserves a customized PR Merger row (tools changed)', async () => {
    const merger = await seedPristinePrMerger();
    manager.update(merger.id, { tools: ['Bash'] });
    const retired = retireRemovedPresetAgents('space-1', {
      agentManager: manager,
      referencedAgentIds: new Set(),
    });
    expect(retired).toEqual([]);
    expect(manager.listBySpaceId('space-1').map((a) => a.id)).toContain(merger.id);
  });

  it('never touches non-merger preset rows', async () => {
    const { seeded } = await seedPresetAgents('space-1', manager);
    const before = seeded.map((a) => a.id).sort();
    retireRemovedPresetAgents('space-1', {
      agentManager: manager,
      referencedAgentIds: new Set(),
    });
    const after = manager
      .listBySpaceId('space-1')
      .map((a) => a.id)
      .sort();
    expect(after).toEqual(before);
  });
  it('isPristineRetiredPrMergerRow matches the frozen seed only', async () => {
    const merger = await seedPristinePrMerger();
    expect(isPristineRetiredPrMergerRow(merger)).toBe(true);
    expect(isPristineRetiredPrMergerRow({ ...merger, customPrompt: 'edited' })).toBe(false);
    expect(isPristineRetiredPrMergerRow({ ...merger, tools: ['Bash'] })).toBe(false);
    expect(isPristineRetiredPrMergerRow({ ...merger, name: 'My Merger' })).toBe(false);
    expect(isPristineRetiredPrMergerRow({ ...merger, templateName: null })).toBe(false);

    expect(
      retireRemovedPresetAgents('space-1', {
        agentManager: manager,
        referencedAgentIds: new Set(),
      })
    ).toEqual([merger.name]);
  });
});
