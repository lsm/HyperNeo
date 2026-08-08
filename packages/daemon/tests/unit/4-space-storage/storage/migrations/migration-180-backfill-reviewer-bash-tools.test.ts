/**
 * Migration 179 Tests — Backfill Bash + Cron tools onto existing Reviewer preset rows.
 *
 * The Reviewer preset gained `Bash` + `CronCreate`/`CronDelete`/`CronList` when the
 * PR-process MCPs were removed. `seedPresetAgents()` runs only at Space creation, so
 * existing Spaces keep the shell-less Reviewer tool profile. M179 re-stamps ONLY
 * unmodified seed rows (stored tools === the old shell-less profile); customized rows
 * are left to the drift/sync UI.
 *
 * Covers:
 *   - An unmodified Reviewer seed row gains Bash + Cron + re-stamped template_hash
 *   - A customized Reviewer row (different tools) is left untouched
 *   - A Reviewer row that already has the current tools is left untouched (idempotent)
 *   - Non-Reviewer rows are never touched
 *   - Empty / missing space_agents table → safe no-op
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration180 } from '../../../../../src/storage/schema/m180-backfill-reviewer-bash-tools.ts';
import { getPresetAgentTemplates } from '../../../../../src/lib/space/agents/seed-agents.ts';
import { computeAgentTemplateHash } from '../../../../../src/lib/space/agents/agent-template-hash.ts';

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

/** The pre-change shell-less Reviewer profile M179 recognizes as an unmodified seed. */
const OLD_REVIEWER_TOOLS = [
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
 * The pre-change Reviewer system contract (shell-less: "You have no shell in
 * workflow reviewer sessions", posts via the removed post_review tool). M179
 * must replace this obsolete prompt on unmodified seeds, or existing reviewers
 * get contradictory instructions with a hash that hides the drift.
 */
const OLD_REVIEWER_PROMPT =
  '## Reviewer System Contract\n\nYou are a critical reviewer. ' +
  'You have no shell in workflow reviewer sessions — do not run gh, git, test, build, or app commands. ' +
  'Read the PR diff via the get_pr_diff tool and post your review via the post_review tool.';

/** The pre-change Reviewer preset description (still carried by old seed rows). */
const OLD_REVIEWER_DESCRIPTION =
  'Code review specialist. Reviews pull requests for correctness, style, and test coverage. ' +
  'Has no shell — posts reviews via the post_review tool.';

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
  // A raw DB row returns JSON text.
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
  } catch {
    /* ignore */
  }
});

beforeEach(() => {
  // Clean agents + spaces between tests.
  db.prepare(`DELETE FROM space_agents`).run();
  db.prepare(`DELETE FROM spaces`).run();
});

describe('migration 179 — reviewer bash tool backfill', () => {
  test('re-stamps an unmodified Reviewer seed row with Bash + Cron AND the current prompt', () => {
    const spaceId = 'space-m179-a';
    insertSpace(db, spaceId);
    insertAgent(db, {
      id: 'agent-reviewer',
      spaceId,
      name: 'Reviewer',
      handle: 'reviewer',
      tools: OLD_REVIEWER_TOOLS,
      customPrompt: OLD_REVIEWER_PROMPT,
      description: OLD_REVIEWER_DESCRIPTION,
      templateName: 'Reviewer',
      templateHash: computeAgentTemplateHash(REVIEWER_PRESET),
    });

    runMigration180(db);

    const row = getAgentRow('agent-reviewer');
    const tools = parseTools(row as unknown as AgentRow);
    // Bash + Cron added; Write/Edit still absent.
    expect(tools).toContain('Bash');
    expect(tools).toContain('CronCreate');
    expect(tools).toContain('CronDelete');
    expect(tools).toContain('CronList');
    expect(tools).not.toContain('Write');
    expect(tools).not.toContain('Edit');
    // The obsolete shell-less prompt is replaced with the current contract, so
    // the reviewer no longer gets "no shell / use post_review" instructions
    // while the stored hash claims the row is up to date.
    const migratedPrompt = (row as unknown as AgentRow).custom_prompt;
    expect(migratedPrompt).toBe(REVIEWER_PRESET.customPrompt);
    expect(migratedPrompt).not.toContain('You have no shell in workflow reviewer sessions');
    expect(migratedPrompt).not.toContain('post_review');
    expect((row as unknown as AgentRow).description).toBe(REVIEWER_PRESET.description);
    // template_hash re-stamped to the current preset hash.
    expect((row as unknown as AgentRow).template_hash).toBe(
      computeAgentTemplateHash(REVIEWER_PRESET)
    );
  });

  test('leaves a customized Reviewer row untouched', () => {
    const spaceId = 'space-m179-b';
    insertSpace(db, spaceId);
    const customTools = ['Read', 'Grep']; // user trimmed the profile
    insertAgent(db, {
      id: 'agent-reviewer-custom',
      spaceId,
      name: 'Reviewer',
      handle: 'reviewer',
      tools: customTools,
      customPrompt: 'My custom reviewer prompt',
      templateName: 'Reviewer',
      templateHash: 'some-hash',
    });

    runMigration180(db);

    const row = getAgentRow('agent-reviewer-custom');
    expect(parseTools(row as unknown as AgentRow)).toEqual(customTools);
    expect((row as unknown as AgentRow).custom_prompt).toBe('My custom reviewer prompt');
    expect((row as unknown as AgentRow).template_hash).toBe('some-hash');
  });

  test('leaves a Reviewer with old tools but a customized prompt untouched', () => {
    // The reviewer kept the old shell-less tool list but the user customized the
    // prompt and description. The migration must NOT overwrite them (matching
    // tools alone is not proof the prompt/description are unmodified) — the row
    // is left for the drift/sync UI.
    const spaceId = 'space-m179-b2';
    insertSpace(db, spaceId);
    insertAgent(db, {
      id: 'agent-reviewer-prompt-custom',
      spaceId,
      name: 'Reviewer',
      handle: 'reviewer',
      tools: OLD_REVIEWER_TOOLS,
      customPrompt: 'My completely custom reviewer prompt',
      description: 'My custom description',
      templateName: 'Reviewer',
      templateHash: 'some-hash',
    });

    runMigration180(db);

    const row = getAgentRow('agent-reviewer-prompt-custom');
    expect(parseTools(row as unknown as AgentRow)).toEqual(OLD_REVIEWER_TOOLS);
    expect((row as unknown as AgentRow).custom_prompt).toBe('My completely custom reviewer prompt');
    expect((row as unknown as AgentRow).description).toBe('My custom description');
    expect((row as unknown as AgentRow).template_hash).toBe('some-hash');
  });

  test('idempotent — a Reviewer row already at the current profile is untouched', () => {
    const spaceId = 'space-m179-c';
    insertSpace(db, spaceId);
    insertAgent(db, {
      id: 'agent-reviewer-current',
      spaceId,
      name: 'Reviewer',
      handle: 'reviewer',
      tools: REVIEWER_PRESET.tools,
      customPrompt: REVIEWER_PRESET.customPrompt,
      templateName: 'Reviewer',
      templateHash: computeAgentTemplateHash(REVIEWER_PRESET),
    });

    runMigration180(db);
    runMigration180(db);

    const row = getAgentRow('agent-reviewer-current');
    expect(parseTools(row as unknown as AgentRow)).toEqual(REVIEWER_PRESET.tools);
  });

  test('never touches non-Reviewer preset rows', () => {
    const spaceId = 'space-m179-d';
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

    runMigration180(db);

    const row = getAgentRow('agent-coder');
    expect(parseTools(row as unknown as AgentRow)).toEqual(CODER_PRESET.tools);
  });

  test('safe no-op on empty space_agents', () => {
    runMigration180(db);
    // No throw; nothing to update.
    expect(true).toBe(true);
  });

  test('leaves a reviewer row with a null template_name alone (user-created)', () => {
    const spaceId = 'space-m179-e';
    insertSpace(db, spaceId);
    insertAgent(db, {
      id: 'agent-reviewer-user',
      spaceId,
      name: 'My Reviewer',
      handle: 'my-reviewer',
      tools: OLD_REVIEWER_TOOLS, // same tools but NOT preset-tracked
      customPrompt: 'user prompt',
      templateName: null,
      templateHash: null,
    });

    runMigration180(db);

    const row = getAgentRow('agent-reviewer-user');
    // Untracked rows are never re-stamped (name is also not 'Reviewer').
    expect(parseTools(row as unknown as AgentRow)).toEqual(OLD_REVIEWER_TOOLS);
    expect((row as unknown as AgentRow).template_hash).toBeNull();
  });
});
