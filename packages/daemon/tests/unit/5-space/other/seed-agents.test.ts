import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { SpaceLongHorizonAgent } from '@hyperneo/shared';
import {
  getPresetAgentTemplates,
  PRESET_AGENT_TOOLS,
  RETIRED_PR_MERGER_DESCRIPTION,
  RETIRED_PR_MERGER_PROMPT,
  RETIRED_PR_MERGER_TOOLS,
  retireRemovedPresetAgents,
  SUB_SESSION_FEATURES,
  seedUnifiedSpaceAgents,
} from '../../../../src/lib/space/agents/seed-agents';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createSpaceTables } from '../../helpers/space-test-db';
import { insertSpace } from '../../helpers/space-agent-schema';
import { seedWorkerMirror } from '../../helpers/seed-worker-mirror';

function toolsOf(agent: SpaceLongHorizonAgent): string[] {
  const tools = agent.toolPermissions.tools;
  return Array.isArray(tools) ? (tools as string[]) : [];
}

describe('seedUnifiedSpaceAgents', () => {
  let db: Database;
  let repo: SpaceLongHorizonAgentRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    insertSpace(db);
    repo = new SpaceLongHorizonAgentRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('creates exactly six preset agents', () => {
    const result = seedUnifiedSpaceAgents('space-1', repo);

    expect(result.seeded).toHaveLength(6);
    expect(result.errors).toHaveLength(0);
  });

  it('creates agents with correct handles', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);

    const handles = seeded.map((a) => a.handle).sort();
    expect(handles).toEqual(['coder', 'general', 'planner', 'qa', 'research', 'reviewer']);
  });

  it('creates agents with correct display names', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);

    const names = seeded.map((a) => a.displayName).sort();
    expect(names).toEqual(['Coder', 'General', 'Planner', 'QA', 'Research', 'Reviewer']);
  });

  it('seeds tool permissions from each preset profile', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);

    for (const agent of seeded) {
      if (PRESET_AGENT_TOOLS[agent.handle].length > 0) {
        expect(toolsOf(agent)).toEqual(PRESET_AGENT_TOOLS[agent.handle]);
      } else {
        expect(agent.toolPermissions).toEqual({});
      }
    }
  });

  it('reviewer has scoped Bash read-only gh patterns + Cron, but NO bare Bash or Write/Edit (restrained review role)', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const reviewer = seeded.find((a) => a.displayName === 'Reviewer');

    expect(reviewer).toBeDefined();
    expect(toolsOf(reviewer!)).not.toContain('Bash');
    expect(toolsOf(reviewer!)).toContain('Bash(gh pr view:*)');
    expect(toolsOf(reviewer!)).toContain('Bash(gh pr diff:*)');
    expect(toolsOf(reviewer!)).toContain('Bash(gh pr checks:*)');
    expect(toolsOf(reviewer!)).toContain('Bash(gh api graphql:*)');
    expect(toolsOf(reviewer!)).toContain('Read');
    expect(toolsOf(reviewer!)).toContain('CronCreate');
    expect(toolsOf(reviewer!)).toContain('CronDelete');
    expect(toolsOf(reviewer!)).toContain('CronList');
    expect(toolsOf(reviewer!)).not.toContain('Write');
    expect(toolsOf(reviewer!)).not.toContain('Edit');
    expect(reviewer?.instructions).toContain('Reviewer System Contract');
    expect(reviewer?.instructions).toContain('addPullRequestReview');
  });

  it('reviewer Bash entries are scoped command patterns only — no unscoped shell', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const reviewer = seeded.find((a) => a.displayName === 'Reviewer');
    const bashEntries = toolsOf(reviewer!).filter((tool) => tool.startsWith('Bash'));

    expect(bashEntries.length).toBeGreaterThan(0);
    for (const entry of bashEntries) {
      expect(entry).toMatch(/^Bash\((.+):\*\)$/);
    }
    expect(toolsOf(reviewer!)).toContain('Bash(jq:*)');
    expect(toolsOf(reviewer!)).toContain('Bash(mktemp:*)');
    expect(toolsOf(reviewer!)).toContain('Bash(echo:*)');
    expect(toolsOf(reviewer!)).toContain('Bash(cat:*)');
    expect(toolsOf(reviewer!)).toContain('Bash(test:*)');
    expect(toolsOf(reviewer!)).toContain('Bash(head:*)');
    expect(toolsOf(reviewer!)).toContain('Bash(tr:*)');
    expect(toolsOf(reviewer!)).toContain('Bash(base64:*)');
  });

  it('reviewer contract states the Bash scoping is enforced by the permission layer', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const reviewer = seeded.find((a) => a.displayName === 'Reviewer');

    expect(reviewer?.instructions).toContain('scoped by the permission layer');
    expect(reviewer?.instructions).toContain('that is the boundary working as designed');
    expect(reviewer?.instructions).toContain('do NOT retry with command variants');
    expect(reviewer?.instructions).not.toContain('there is no tool guard enforcing it');
  });

  it('reviewer round model pins broad reviews to rounds 1-2 and delta reviews to rounds 3+', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const reviewer = seeded.find((a) => a.displayName === 'Reviewer');

    expect(reviewer?.instructions).toContain(
      'Round model: broad review in rounds 1–2, delta review in rounds 3+'
    );
    expect(reviewer?.instructions).toContain(
      'WHOLE-PR review — the full diff plus its integration surface'
    );
    expect(reviewer?.instructions).toContain('second independent whole-PR sweep');
    expect(reviewer?.instructions).toContain('the delta diff in rounds 3+');
    expect(reviewer?.instructions).not.toContain('the delta diff in rounds 2+');
  });

  it('Reviewer is the designated inspection-and-review agent (scoped Bash present, no Write/Edit)', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const reviewer = seeded.find((a) => a.displayName === 'Reviewer');

    expect(reviewer).toBeDefined();
    expect(reviewer?.handle).toBe('reviewer');
    expect(toolsOf(reviewer!)).toContain('Bash(gh pr view:*)');
    expect(toolsOf(reviewer!)).toContain('Read');
    expect(toolsOf(reviewer!)).not.toContain('Write');
    expect(toolsOf(reviewer!)).not.toContain('Edit');
    expect(reviewer?.instructions).toContain('Reviewer System Contract');
  });

  it('coder inherits all SDK built-ins and defers merge to the post-approval phase', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const coder = seeded.find((a) => a.displayName === 'Coder');

    expect(toolsOf(coder!)).toEqual([]);
    expect(coder?.instructions).toMatch(/[Dd]uring implementation, do not merge your own PR/);
    expect(coder?.instructions).toContain('post-approval merge is a separate phase');
    expect(coder?.instructions).toContain('open pull requests for review');
    expect(coder?.instructions).not.toContain('The reviewer handles the merge.');
  });

  it('research agent inherits all SDK built-ins (Write + Edit for committing findings)', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const research = seeded.find((a) => a.displayName === 'Research');

    expect(toolsOf(research!)).toEqual([]);
  });

  it('assigns agents to the correct spaceId', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);

    for (const agent of seeded) {
      expect(agent.spaceId).toBe('space-1');
    }
  });

  it('records errors but seeds remaining agents on handle collision', () => {
    seedUnifiedSpaceAgents('space-1', repo);

    const second = seedUnifiedSpaceAgents('space-1', repo);

    expect(second.seeded).toHaveLength(0);
    expect(second.errors).toHaveLength(6);
    for (const err of second.errors) {
      expect(err.error).toMatch(/UNIQUE constraint failed/i);
    }
  });

  it('seeds different spaces independently', () => {
    insertSpace(db, 'space-2');

    const r1 = seedUnifiedSpaceAgents('space-1', repo);
    const r2 = seedUnifiedSpaceAgents('space-2', repo);

    expect(r1.seeded).toHaveLength(6);
    expect(r2.seeded).toHaveLength(6);
    expect(r1.errors).toHaveLength(0);
    expect(r2.errors).toHaveLength(0);

    for (const a of r1.seeded) expect(a.spaceId).toBe('space-1');
    for (const a of r2.seeded) expect(a.spaceId).toBe('space-2');
  });

  it('partial collision — seeds succeed for non-conflicting handles', () => {
    repo.create({ spaceId: 'space-1', handle: 'coder', displayName: 'Coder' });

    const result = seedUnifiedSpaceAgents('space-1', repo);

    expect(result.seeded).toHaveLength(5);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].name).toBe('Coder');
  });

  it('General agent inherits all SDK built-ins', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const general = seeded.find((a) => a.displayName === 'General');

    expect(general).toBeDefined();
    expect(toolsOf(general!)).toEqual([]);
  });

  it('QA agent has restricted tools (no Write or Edit)', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const qa = seeded.find((a) => a.displayName === 'QA');

    expect(qa).toBeDefined();
    expect(toolsOf(qa!)).not.toContain('Write');
    expect(toolsOf(qa!)).not.toContain('Edit');
    expect(toolsOf(qa!)).toContain('Read');
    expect(toolsOf(qa!)).toContain('Bash');
    expect(toolsOf(qa!)).toContain('Grep');
    expect(toolsOf(qa!)).toContain('Glob');
  });

  it('all preset agents have a non-empty instruction prompt', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);

    for (const agent of seeded) {
      expect(typeof agent.instructions).toBe('string');
      expect(agent.instructions.length).toBeGreaterThan(0);
    }
  });

  it('Coder custom prompt mentions code and PR', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const coder = seeded.find((a) => a.displayName === 'Coder');

    expect(coder?.instructions).toContain('software engineer');
    expect(coder?.instructions).toContain('commit');
    expect(coder?.instructions).toContain('PR');
  });

  it('Research custom prompt mentions investigation and findings', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const research = seeded.find((a) => a.displayName === 'Research');

    expect(research?.instructions).toContain('research specialist');
    expect(research?.instructions).toContain('markdown');
    expect(research?.instructions).toContain('PR');
  });

  it('Reviewer custom prompt mentions code review', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const reviewer = seeded.find((a) => a.displayName === 'Reviewer');

    expect(reviewer?.instructions).toContain('Reviewer System Contract');
    expect(reviewer?.instructions.toLowerCase()).toContain('reviewer');
  });

  it('Reviewer custom prompt delegates exploration to the built-in general-purpose sub-agent via the Task tool', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const reviewer = seeded.find((a) => a.displayName === 'Reviewer');

    expect(reviewer?.instructions).toContain('dispatch dedicated Task general-purpose sub-agents');
    expect(reviewer?.instructions).not.toContain('reviewer-explorer');
    expect(reviewer?.instructions).not.toContain('reviewer-fact-checker');
  });

  it('Reviewer custom prompt includes an identity block', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const reviewer = seeded.find((a) => a.displayName === 'Reviewer');

    expect(reviewer?.instructions).toContain('Review by <your model>');
    expect(reviewer?.instructions).toContain('Client:** HyperNeo');
    expect(reviewer?.instructions).toMatch(/Model:/);
    expect(reviewer?.instructions).toMatch(/Provider:/);
  });

  it('Reviewer custom prompt defines P0–P2 severity levels with decision rules', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const reviewer = seeded.find((a) => a.displayName === 'Reviewer');

    expect(reviewer?.instructions).toContain('P0');
    expect(reviewer?.instructions).toContain('P1');
    expect(reviewer?.instructions).toContain('P2');
    expect(reviewer?.instructions).toContain('REQUEST_CHANGES');
    expect(reviewer?.instructions).toContain('APPROVE');
    expect(reviewer?.instructions).toContain('P0-P2');
    expect(reviewer?.instructions).toContain('Request changes for any P0-P2 finding');
    expect(reviewer?.instructions).toContain('all three levels block approval');
    expect(reviewer?.instructions).toContain('no optional severity');
    expect(reviewer?.instructions).toContain('pure function of your finding counts');
    expect(reviewer?.instructions).toContain('P0=P1=P2=0');
  });

  it('Reviewer custom prompt fences terminal actions while findings are open (Task #136 regression)', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const reviewer = seeded.find((a) => a.displayName === 'Reviewer');

    expect(reviewer?.instructions).toContain('Terminal-action contract');
    expect(reviewer?.instructions).toContain('approve_task/submit_for_approval');
    expect(reviewer?.instructions).toContain('zero P0-P2 findings');
    expect(reviewer?.instructions).toContain('If findings remain');
  });

  it('Reviewer custom prompt prohibits space-agent merge bypass when submit_for_approval fails (Task #295)', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const reviewer = seeded.find((a) => a.displayName === 'Reviewer');

    expect(reviewer?.instructions).toContain('If findings remain');
    expect(reviewer?.instructions).toContain('send actionable upstream feedback');
    expect(reviewer?.instructions).toContain('stop');
  });

  it('Reviewer custom prompt includes own-PR detection', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const reviewer = seeded.find((a) => a.displayName === 'Reviewer');

    expect(reviewer?.instructions).toContain('own-PR fallback');
    expect(reviewer?.instructions).toContain('COMMENT');
    expect(reviewer?.instructions).toContain('match your verdict');
  });

  it('Reviewer custom prompt emphasises goal alignment, completeness, and omissions', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const reviewer = seeded.find((a) => a.displayName === 'Reviewer');

    expect(reviewer?.instructions.toLowerCase()).toContain('goal');
    expect(reviewer?.instructions.toLowerCase()).toContain('completeness');
    expect(reviewer?.instructions.toLowerCase()).toContain('omissions');
    expect(reviewer?.instructions.toLowerCase()).toContain('over-engineering');
  });

  it('Reviewer custom prompt posts reviews via the addPullRequestReview mutation and emits REVIEW_POSTED', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const reviewer = seeded.find((a) => a.displayName === 'Reviewer');

    expect(reviewer?.instructions).toContain('GitHub review procedure');
    expect(reviewer?.instructions).toContain('html_url returned by GitHub');
    expect(reviewer?.instructions).toContain('addPullRequestReview');
    expect(reviewer?.instructions).not.toContain('REVIEW_BODY_TERMINATOR');
    expect(reviewer?.instructions).toContain('REVIEW_POSTED');
    expect(reviewer?.instructions).not.toContain('post_review');
  });

  it('Reviewer custom prompt inspects PR diffs via gh pr diff (authed, private repos included)', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const reviewer = seeded.find((a) => a.displayName === 'Reviewer');

    expect(reviewer?.instructions).toContain('gh pr diff');
    expect(reviewer?.instructions.toLowerCase()).toContain('private repos');
    expect(reviewer?.instructions).not.toContain('get_pr_diff');
  });

  it('Planner custom prompt mentions planning', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const planner = seeded.find((a) => a.displayName === 'Planner');

    expect(planner?.instructions).toContain('project manager');
    expect(planner?.instructions).toContain('plan');
  });

  it('QA custom prompt mentions quality assurance', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const qa = seeded.find((a) => a.displayName === 'QA');

    expect(qa?.instructions).toContain('QA System Contract');
    expect(qa?.instructions).toContain('quality assurance');
  });

  it('General custom prompt mentions versatile development', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const general = seeded.find((a) => a.displayName === 'General');

    expect(general?.instructions).toContain('versatile');
    expect(general?.instructions).toContain('implement');
  });
});

describe('preset agent exact definitions', () => {
  let db: Database;
  let repo: SpaceLongHorizonAgentRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    insertSpace(db);
    repo = new SpaceLongHorizonAgentRepository(db);
  });

  afterEach(() => {
    db.close();
  });

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
  const EXPECTED_REVIEWER_TOOLS = [
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

  it('general inherits all SDK built-ins (empty permissive profile)', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const general = seeded.find((a) => a.displayName === 'General')!;
    expect(toolsOf(general)).toEqual(EXPECTED_CODER_TOOLS);
  });

  it('Coder inherits all SDK built-ins (empty permissive profile)', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const coder = seeded.find((a) => a.displayName === 'Coder')!;
    expect(toolsOf(coder)).toEqual(EXPECTED_CODER_TOOLS);
  });

  it('Planner inherits all SDK built-ins (empty permissive profile)', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const planner = seeded.find((a) => a.displayName === 'Planner')!;
    expect(toolsOf(planner)).toEqual(EXPECTED_CODER_TOOLS);
  });

  it('Research inherits all SDK built-ins (empty permissive profile)', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const research = seeded.find((a) => a.displayName === 'Research')!;
    expect(toolsOf(research)).toEqual(EXPECTED_CODER_TOOLS);
  });

  it('Reviewer has exact REVIEWER_TOOLS (read-only + scoped gh Bash + Task/* + Cron*, no bare Bash/Write/Edit)', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const reviewer = seeded.find((a) => a.displayName === 'Reviewer')!;
    expect(toolsOf(reviewer)).toEqual(EXPECTED_REVIEWER_TOOLS);
  });

  it('QA has exact QA_TOOLS', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const qa = seeded.find((a) => a.displayName === 'QA')!;
    expect(toolsOf(qa)).toEqual(EXPECTED_QA_TOOLS);
  });

  it('Coder has exact custom prompt', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const coder = seeded.find((a) => a.displayName === 'Coder')!;
    expect(coder.instructions).toBe(
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
        'Before finishing: ensure all tests pass, commit all changes, and open a PR with a clear description.'
    );
  });

  it('General has exact custom prompt', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const general = seeded.find((a) => a.displayName === 'General')!;
    expect(general.instructions).toBe(
      'You are a versatile software development assistant. You can write code, fix bugs, write documentation, ' +
        'analyze problems, and handle any general development task. You adapt to what is needed.\n\n' +
        'Understand the task, implement the solution, verify it works, and commit your changes.'
    );
  });

  it('Planner has exact custom prompt', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const planner = seeded.find((a) => a.displayName === 'Planner')!;
    expect(planner.instructions).toBe(
      'You are a technical project manager. You analyze goals, break them down into clear actionable ' +
        'tasks, identify dependencies, and produce structured implementation plans.\n\n' +
        'Produce a concrete plan with clear steps. Write the plan to a file and commit it.'
    );
  });

  it('Research has exact custom prompt', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const research = seeded.find((a) => a.displayName === 'Research')!;
    expect(research.instructions).toBe(
      'You are a research specialist. You investigate topics thoroughly using web search and code ' +
        'exploration, synthesize findings clearly, and document results in well-structured markdown files.\n\n' +
        'Save all findings to a markdown file, commit the file, and open a PR with a summary of what you found.'
    );
  });

  it('Reviewer custom prompt matches the template exported from seed-agents', () => {
    const templates = getPresetAgentTemplates();
    const reviewerTemplate = templates.find((t) => t.name === 'Reviewer')!;

    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const reviewer = seeded.find((a) => a.displayName === 'Reviewer')!;
    expect(reviewer.instructions).toBe(reviewerTemplate.customPrompt);
  });

  it('Reviewer custom prompt posts reviews via the addPullRequestReview mutation and emits REVIEW_POSTED', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const reviewer = seeded.find((a) => a.displayName === 'Reviewer')!;
    expect(reviewer.instructions).toContain('GitHub review procedure');
    expect(reviewer.instructions).toContain('html_url returned by GitHub');
    expect(reviewer.instructions).toContain('REVIEW_POSTED');
    expect(reviewer.instructions).toContain('addPullRequestReview');
    expect(reviewer.instructions).toContain('pullRequestReview.url');
    expect(reviewer.instructions).toContain('own-PR fallback');
    expect(reviewer.instructions).toContain('COMMENT');
    expect(reviewer.instructions).toContain('match your verdict');
    expect(reviewer.instructions).not.toContain('post_review');
  });

  it('Reviewer custom prompt writes body files with a per-invocation heredoc and posts via the mutation', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const reviewer = seeded.find((a) => a.displayName === 'Reviewer')!;
    const prompt = reviewer.instructions;
    expect(prompt).toContain('addPullRequestReview');
    expect(prompt).toContain('per-invocation');
    expect(prompt).not.toContain('-f body=@-');
    expect(prompt).not.toContain("-f body=\"$(cat <<'EOF'");
    expect(prompt).not.toContain('gh api repos/{owner}/{repo}/pulls/{n}/reviews');
    expect(prompt).not.toContain('post_review');
  });

  it('QA has shared system contract prompt', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const qa = seeded.find((a) => a.displayName === 'QA')!;
    expect(qa.instructions).toContain('QA System Contract');
    expect(qa.instructions).toContain('Load project QA instructions from base-branch content only');
    expect(qa.instructions).toContain("The repo's CI is the test-suite authority");
  });
});

describe('PRESET_AGENT_TOOLS export', () => {
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
  const EXPECTED_REVIEWER_TOOLS = [
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

  it('reviewer role maps to REVIEWER_TOOLS (read-only + scoped gh Bash + Task/* + Cron*, no bare Bash)', () => {
    expect(PRESET_AGENT_TOOLS.reviewer).toEqual(EXPECTED_REVIEWER_TOOLS);
  });

  it('qa role maps to QA_TOOLS', () => {
    expect(PRESET_AGENT_TOOLS.qa).toEqual(EXPECTED_QA_TOOLS);
  });

  it('PRESET_AGENT_TOOLS matches what seedUnifiedSpaceAgents actually seeds', () => {
    const db = new Database(':memory:');
    createSpaceTables(db);
    insertSpace(db);
    const repo = new SpaceLongHorizonAgentRepository(db);

    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);

    for (const agent of seeded) {
      const roleKey = agent.handle;
      expect(PRESET_AGENT_TOOLS[roleKey]).toBeDefined();
      expect(toolsOf(agent)).toEqual(PRESET_AGENT_TOOLS[roleKey]);
    }

    db.close();
  });
});

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
      const roleKey = t.handle;
      expect(t.tools).toEqual(PRESET_AGENT_TOOLS[roleKey]);
    }
  });
});

describe('retireRemovedPresetAgents', () => {
  let db: Database;
  let repo: SpaceLongHorizonAgentRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    insertSpace(db);
    repo = new SpaceLongHorizonAgentRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function isPristineUnifiedRetiredPresetTwin(agent: SpaceLongHorizonAgent): boolean {
    const tools = Array.isArray(agent.toolPermissions.tools)
      ? agent.toolPermissions.tools.filter((tool): tool is string => typeof tool === 'string')
      : [];
    return (
      agent.displayName === 'PR Merger' &&
      agent.handle === 'merger' &&
      agent.templateKey === 'migration.legacy_space_agent' &&
      agent.instructions === RETIRED_PR_MERGER_PROMPT &&
      tools.length === RETIRED_PR_MERGER_TOOLS.length &&
      RETIRED_PR_MERGER_TOOLS.every((tool, i) => tools[i] === tool) &&
      agent.model === null &&
      agent.thinkingLevel === null &&
      agent.provider === null &&
      agent.settingSources === null &&
      (agent.description === undefined ||
        agent.description === null ||
        agent.description === RETIRED_PR_MERGER_DESCRIPTION) &&
      agent.status === 'active'
    );
  }

  function seedPristinePrMerger(): string {
    const id = 'pr-merger';
    seedWorkerMirror(db, {
      id,
      spaceId: 'space-1',
      name: 'PR Merger',
      handle: 'merger',
      instructions: RETIRED_PR_MERGER_PROMPT,
      tools: [...RETIRED_PR_MERGER_TOOLS],
      description: RETIRED_PR_MERGER_DESCRIPTION,
    });
    return id;
  }

  it('deletes a pristine, unreferenced PR Merger row', () => {
    const mergerId = seedPristinePrMerger();
    const retired = retireRemovedPresetAgents('space-1', {
      agentRepo: repo,
      referencedAgentIds: new Set(),
      isPristineRetiredRow: isPristineUnifiedRetiredPresetTwin,
    });
    expect(retired).toEqual(['PR Merger']);
    expect(repo.listBySpaceId('space-1').map((a) => a.id)).not.toContain(mergerId);
  });

  it('protects a pristine row referenced by a workflow (active run / custom slot)', () => {
    const mergerId = seedPristinePrMerger();
    const retired = retireRemovedPresetAgents('space-1', {
      agentRepo: repo,
      referencedAgentIds: new Set([mergerId]),
      isPristineRetiredRow: isPristineUnifiedRetiredPresetTwin,
    });
    expect(retired).toEqual([]);
    expect(repo.listBySpaceId('space-1').map((a) => a.id)).toContain(mergerId);
  });

  it('preserves a customized PR Merger row (renamed prompt)', () => {
    const mergerId = seedPristinePrMerger();
    repo.update(mergerId, { instructions: 'My custom merger prompt' });
    const retired = retireRemovedPresetAgents('space-1', {
      agentRepo: repo,
      referencedAgentIds: new Set(),
      isPristineRetiredRow: isPristineUnifiedRetiredPresetTwin,
    });
    expect(retired).toEqual([]);
    expect(repo.listBySpaceId('space-1').map((a) => a.id)).toContain(mergerId);
  });

  it('preserves a customized PR Merger row (tools changed)', () => {
    const mergerId = seedPristinePrMerger();
    repo.update(mergerId, { toolPermissions: { tools: ['Bash'] } });
    const retired = retireRemovedPresetAgents('space-1', {
      agentRepo: repo,
      referencedAgentIds: new Set(),
      isPristineRetiredRow: isPristineUnifiedRetiredPresetTwin,
    });
    expect(retired).toEqual([]);
    expect(repo.listBySpaceId('space-1').map((a) => a.id)).toContain(mergerId);
  });

  it('never touches non-merger preset rows', () => {
    const { seeded } = seedUnifiedSpaceAgents('space-1', repo);
    const before = seeded.map((a) => a.id).sort();
    retireRemovedPresetAgents('space-1', {
      agentRepo: repo,
      referencedAgentIds: new Set(),
      isPristineRetiredRow: isPristineUnifiedRetiredPresetTwin,
    });
    const after = repo
      .listBySpaceId('space-1')
      .map((a) => a.id)
      .sort();
    expect(after).toEqual(before);
  });
});
