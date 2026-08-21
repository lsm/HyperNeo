import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { computeAgentTemplateHash } from '../../../../../src/lib/space/agents/agent-template-hash.ts';
import { getPresetAgentTemplates } from '../../../../../src/lib/space/agents/seed-agents.ts';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';
import {
  PRE_SCOPE_REVIEWER_DESCRIPTION,
  PRE_SCOPE_REVIEWER_PROMPT,
  PRE_SCOPE_REVIEWER_TOOLS,
  runMigration196,
} from '../../../../../src/storage/schema/m196-scope-reviewer-bash-patterns.ts';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';

interface AgentRow {
  id: string;
  name: string;
  handle: string | null;
  template_name: string | null;
  template_hash: string | null;
  description: string | null;
  tools: string | null;
  custom_prompt: string | null;
}

const PRESETS = getPresetAgentTemplates();
const REVIEWER_PRESET = PRESETS.find((p) => p.name === 'Reviewer')!;
const CODER_PRESET = PRESETS.find((p) => p.name === 'Coder')!;

function insertSpace(db: BunDatabase, id: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, id, `/ws/${id}`, id, now, now);
}

function insertAgent(
  db: BunDatabase,
  opts: {
    id: string;
    spaceId: string;
    name: string;
    handle?: string | null;
    tools?: string[];
    customPrompt?: string | null;
    description?: string | null;
    templateName?: string | null;
    templateHash?: string | null;
  }
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO space_agents
       (id, space_id, name, handle, tools, custom_prompt, description, template_name, template_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.id,
    opts.spaceId,
    opts.name,
    opts.handle ?? null,
    JSON.stringify(opts.tools ?? []),
    opts.customPrompt ?? null,
    opts.description ?? '',
    opts.templateName ?? null,
    opts.templateHash ?? null,
    now,
    now
  );
}

function parseTools(row: AgentRow): string[] {
  const tools = row.tools;
  if (!tools) return [];
  try {
    const parsed = JSON.parse(tools);
    return Array.isArray(parsed) ? parsed.map((t) => String(t)) : [];
  } catch {
    return [];
  }
}

function getAgentRow(id: string): AgentRow {
  return db
    .prepare(
      `SELECT id, name, handle, template_name, template_hash, description, tools, custom_prompt
       FROM space_agents WHERE id = ?`
    )
    .get(id) as AgentRow;
}

let db: BunDatabase;

beforeAll(() => {
  db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
});

afterAll(() => {
  try {
    db.close();
  } catch {}
});

beforeEach(() => {
  db.prepare(`DELETE FROM space_agents`).run();
  db.prepare(`DELETE FROM spaces`).run();
});

describe('migration 196 — reviewer scoped bash tool patterns', () => {
  test('re-stamps a pristine Reviewer seed row with the scoped patterns, prompt, and hash', () => {
    const spaceId = 'space-m196-a';
    insertSpace(db, spaceId);
    insertAgent(db, {
      id: 'agent-reviewer',
      spaceId,
      name: 'Reviewer',
      handle: 'reviewer',
      tools: PRE_SCOPE_REVIEWER_TOOLS,
      customPrompt: PRE_SCOPE_REVIEWER_PROMPT,
      description: PRE_SCOPE_REVIEWER_DESCRIPTION,
      templateName: 'Reviewer',
      templateHash: 'pre-scope-hash',
    });

    runMigration196(db);

    const row = getAgentRow('agent-reviewer');
    const tools = parseTools(row);
    expect(tools).toEqual(REVIEWER_PRESET.tools);
    expect(tools).not.toContain('Bash');
    expect(tools).toContain('Bash(gh pr view:*)');
    expect(tools).toContain('Bash(gh api graphql:*)');
    expect(row.custom_prompt).toBe(REVIEWER_PRESET.customPrompt);
    expect(row.custom_prompt).toContain('scoped by the permission layer');
    expect(row.description).toBe(REVIEWER_PRESET.description);
    expect(row.template_hash).toBe(computeAgentTemplateHash(REVIEWER_PRESET));
    expect(row.template_name).toBe('Reviewer');
  });

  test('re-stamps tools on a customized-prose Reviewer row while preserving its prose and hash', () => {
    const spaceId = 'space-m196-b';
    insertSpace(db, spaceId);
    insertAgent(db, {
      id: 'agent-reviewer-custom',
      spaceId,
      name: 'Reviewer',
      handle: 'reviewer',
      tools: PRE_SCOPE_REVIEWER_TOOLS,
      customPrompt: 'My completely custom reviewer prompt',
      description: 'My custom description',
      templateName: 'Reviewer',
      templateHash: 'some-hash',
    });

    runMigration196(db);

    const row = getAgentRow('agent-reviewer-custom');
    expect(parseTools(row)).toEqual(REVIEWER_PRESET.tools);
    expect(row.custom_prompt).toBe('My completely custom reviewer prompt');
    expect(row.description).toBe('My custom description');
    expect(row.template_hash).toBe('some-hash');
  });

  test('leaves a Reviewer row with customized tools untouched', () => {
    const spaceId = 'space-m196-c';
    insertSpace(db, spaceId);
    const customTools = ['Read', 'Bash', 'Grep'];
    insertAgent(db, {
      id: 'agent-reviewer-custom-tools',
      spaceId,
      name: 'Reviewer',
      handle: 'reviewer',
      tools: customTools,
      customPrompt: PRE_SCOPE_REVIEWER_PROMPT,
      description: PRE_SCOPE_REVIEWER_DESCRIPTION,
      templateName: 'Reviewer',
      templateHash: 'some-hash',
    });

    runMigration196(db);

    const row = getAgentRow('agent-reviewer-custom-tools');
    expect(parseTools(row)).toEqual(customTools);
    expect(row.template_hash).toBe('some-hash');
  });

  test('does not touch an untracked Reviewer-named agent with custom prose', () => {
    const spaceId = 'space-m196-d';
    insertSpace(db, spaceId);
    insertAgent(db, {
      id: 'agent-reviewer-untracked',
      spaceId,
      name: 'Reviewer',
      handle: 'my-reviewer',
      tools: PRE_SCOPE_REVIEWER_TOOLS,
      customPrompt: 'A user-authored reviewer prompt, not the seed',
      description: 'Custom description',
      templateName: null,
      templateHash: null,
    });

    runMigration196(db);

    const row = getAgentRow('agent-reviewer-untracked');
    expect(parseTools(row)).toEqual(PRE_SCOPE_REVIEWER_TOOLS);
    expect(row.template_name).toBeNull();
    expect(row.custom_prompt).toBe('A user-authored reviewer prompt, not the seed');
  });

  test('backfills an untracked full pristine seed and links it to the template', () => {
    const spaceId = 'space-m196-e';
    insertSpace(db, spaceId);
    insertAgent(db, {
      id: 'agent-reviewer-untracked-pristine',
      spaceId,
      name: 'Reviewer',
      handle: 'reviewer',
      tools: PRE_SCOPE_REVIEWER_TOOLS,
      customPrompt: PRE_SCOPE_REVIEWER_PROMPT,
      description: PRE_SCOPE_REVIEWER_DESCRIPTION,
      templateName: null,
      templateHash: null,
    });

    runMigration196(db);

    const row = getAgentRow('agent-reviewer-untracked-pristine');
    expect(parseTools(row)).toEqual(REVIEWER_PRESET.tools);
    expect(row.template_name).toBe('Reviewer');
    expect(row.custom_prompt).toBe(REVIEWER_PRESET.customPrompt);
  });

  test('idempotent — a row already at the scoped profile is untouched', () => {
    const spaceId = 'space-m196-f';
    insertSpace(db, spaceId);
    insertAgent(db, {
      id: 'agent-reviewer-current',
      spaceId,
      name: 'Reviewer',
      handle: 'reviewer',
      tools: REVIEWER_PRESET.tools,
      customPrompt: REVIEWER_PRESET.customPrompt,
      description: REVIEWER_PRESET.description,
      templateName: 'Reviewer',
      templateHash: computeAgentTemplateHash(REVIEWER_PRESET),
    });

    runMigration196(db);
    runMigration196(db);

    const row = getAgentRow('agent-reviewer-current');
    expect(parseTools(row)).toEqual(REVIEWER_PRESET.tools);
    expect(row.template_hash).toBe(computeAgentTemplateHash(REVIEWER_PRESET));
  });

  test('never touches non-Reviewer preset rows', () => {
    const spaceId = 'space-m196-g';
    insertSpace(db, spaceId);
    insertAgent(db, {
      id: 'agent-coder',
      spaceId,
      name: 'Coder',
      handle: 'coder',
      tools: CODER_PRESET.tools,
      customPrompt: CODER_PRESET.customPrompt,
      templateName: 'Coder',
      templateHash: computeAgentTemplateHash(CODER_PRESET),
    });

    runMigration196(db);

    const row = getAgentRow('agent-coder');
    expect(parseTools(row)).toEqual(CODER_PRESET.tools);
  });

  test('safe no-op on empty space_agents', () => {
    runMigration196(db);
    expect(true).toBe(true);
  });

  test('pre-scope constants capture the bare-Bash reviewer profile', () => {
    expect(PRE_SCOPE_REVIEWER_TOOLS).toContain('Bash');
    expect(PRE_SCOPE_REVIEWER_TOOLS).not.toContain('Bash(gh pr view:*)');
    expect(PRE_SCOPE_REVIEWER_PROMPT).not.toContain('scoped by the permission layer');
    expect(PRE_SCOPE_REVIEWER_DESCRIPTION).toContain('Has bash for read-only inspection');
  });

  test('pre-scope prompt constant is the evaluated contract, not template-literal source', () => {
    expect(PRE_SCOPE_REVIEWER_PROMPT).not.toContain('\\`');
    expect(PRE_SCOPE_REVIEWER_PROMPT).toContain('`gh pr view`');
    expect(PRE_SCOPE_REVIEWER_PROMPT).toContain('`addPullRequestReview`');
    expect(PRE_SCOPE_REVIEWER_PROMPT.startsWith('## Reviewer System Contract')).toBe(true);
  });
});
