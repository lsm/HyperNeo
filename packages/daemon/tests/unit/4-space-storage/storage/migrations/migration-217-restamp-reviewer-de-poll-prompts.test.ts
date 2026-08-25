import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { computeAgentTemplateHash } from '../../../../../src/lib/space/agents/agent-template-hash.ts';
import { getPresetAgentTemplates } from '../../../../../src/lib/space/agents/seed-agents.ts';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';
import {
  OLD_REVIEWER_PROMPT_PRE_DE_POLL,
  runMigration217,
} from '../../../../../src/storage/schema/m217-restamp-reviewer-de-poll-prompts.ts';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';

interface AgentRow {
  id: string;
  name: string;
  template_name: string | null;
  template_hash: string | null;
  description: string | null;
  custom_prompt: string | null;
}

const REVIEWER_PRESET = getPresetAgentTemplates().find((p) => p.name === 'Reviewer')!;

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
    customPrompt?: string | null;
    description?: string | null;
    tools?: string | null;
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
    opts.name.toLowerCase(),
    opts.tools ?? JSON.stringify(REVIEWER_PRESET.tools ?? []),
    opts.customPrompt ?? null,
    opts.description ?? null,
    opts.templateName ?? null,
    opts.templateHash ?? null,
    now,
    now
  );
}

function getAgentRow(db: BunDatabase, id: string): AgentRow {
  return db
    .prepare(
      `SELECT id, name, template_name, template_hash, description, custom_prompt
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

describe('migration 217 — reviewer de-poll-polling contract restamp', () => {
  test('re-stamps a pristine Reviewer row carrying the pre-de-poll-polling contract', () => {
    const spaceId = 'space-m217-a';
    insertSpace(db, spaceId);
    insertAgent(db, {
      id: 'agent-reviewer',
      spaceId,
      name: 'Reviewer',
      customPrompt: OLD_REVIEWER_PROMPT_PRE_DE_POLL,
      description: REVIEWER_PRESET.description,
      templateName: 'Reviewer',
      templateHash: 'stale-hash',
    });

    runMigration217(db);

    const row = getAgentRow(db, 'agent-reviewer');
    expect(row.custom_prompt).toBe(REVIEWER_PRESET.customPrompt);
    expect(row.custom_prompt).toContain('Wait for delivered PR events');
    expect(row.custom_prompt).not.toContain('Poll the gate every 60 seconds');
    expect(row.template_hash).toBe(computeAgentTemplateHash(REVIEWER_PRESET));
    expect(row.description).toBe(REVIEWER_PRESET.description);
  });

  test('the frozen pre-de-poll contract kept the 60-second liveness loop the restamp removes', () => {
    expect(OLD_REVIEWER_PROMPT_PRE_DE_POLL).toContain(
      'Poll the gate every 60 seconds in a bounded loop'
    );
    expect(OLD_REVIEWER_PROMPT_PRE_DE_POLL).not.toContain('Wait for delivered PR events');
    expect(REVIEWER_PRESET.customPrompt).not.toBe(OLD_REVIEWER_PROMPT_PRE_DE_POLL);
  });

  test('re-stamps an orphaned Reviewer row that still carries the retired contract', () => {
    const spaceId = 'space-m217-b';
    insertSpace(db, spaceId);
    insertAgent(db, {
      id: 'agent-orphan',
      spaceId,
      name: 'Reviewer',
      customPrompt: OLD_REVIEWER_PROMPT_PRE_DE_POLL,
      description: REVIEWER_PRESET.description,
    });

    runMigration217(db);

    const row = getAgentRow(db, 'agent-orphan');
    expect(row.custom_prompt).toBe(REVIEWER_PRESET.customPrompt);
    expect(row.template_name).toBe('Reviewer');
    expect(row.template_hash).toBe(computeAgentTemplateHash(REVIEWER_PRESET));
  });

  test('re-stamps a pristine Reviewer row whose tools are stored in a different order', () => {
    const spaceId = 'space-m217-reordered';
    insertSpace(db, spaceId);
    insertAgent(db, {
      id: 'agent-reordered',
      spaceId,
      name: 'Reviewer',
      customPrompt: OLD_REVIEWER_PROMPT_PRE_DE_POLL,
      description: REVIEWER_PRESET.description,
      tools: JSON.stringify([...(REVIEWER_PRESET.tools ?? [])].reverse()),
      templateName: 'Reviewer',
    });

    runMigration217(db);

    const row = getAgentRow(db, 'agent-reordered');
    expect(row.custom_prompt).toBe(REVIEWER_PRESET.customPrompt);
    expect(row.template_hash).toBe(computeAgentTemplateHash(REVIEWER_PRESET));
  });

  test('leaves a Reviewer row with customized tools untouched', () => {
    const spaceId = 'space-m217-e';
    insertSpace(db, spaceId);
    insertAgent(db, {
      id: 'agent-tools-custom',
      spaceId,
      name: 'Reviewer',
      customPrompt: OLD_REVIEWER_PROMPT_PRE_DE_POLL,
      description: REVIEWER_PRESET.description,
      tools: JSON.stringify([...(REVIEWER_PRESET.tools ?? []), 'Bash(git log:*)']),
    });

    runMigration217(db);

    const row = getAgentRow(db, 'agent-tools-custom');
    expect(row.custom_prompt).toBe(OLD_REVIEWER_PROMPT_PRE_DE_POLL);
    expect(row.template_name).toBeNull();
  });

  test('leaves a customized Reviewer row untouched', () => {
    const spaceId = 'space-m217-c';
    insertSpace(db, spaceId);
    insertAgent(db, {
      id: 'agent-custom',
      spaceId,
      name: 'Reviewer',
      customPrompt: `${OLD_REVIEWER_PROMPT_PRE_DE_POLL}\n\nCustom house rules.`,
      description: REVIEWER_PRESET.description,
      templateName: 'Reviewer',
      templateHash: 'custom-hash',
    });
    const otherSpaceId = 'space-m217-c2';
    insertSpace(db, otherSpaceId);
    insertAgent(db, {
      id: 'agent-custom-description',
      spaceId: otherSpaceId,
      name: 'Reviewer',
      customPrompt: OLD_REVIEWER_PROMPT_PRE_DE_POLL,
      description: 'A hand-tuned description',
      templateName: 'Reviewer',
    });

    runMigration217(db);

    expect(getAgentRow(db, 'agent-custom').custom_prompt).toContain('Custom house rules.');
    expect(getAgentRow(db, 'agent-custom').template_hash).toBe('custom-hash');
    expect(getAgentRow(db, 'agent-custom-description').custom_prompt).toBe(
      OLD_REVIEWER_PROMPT_PRE_DE_POLL
    );
  });

  test('ignores non-Reviewer agents', () => {
    const spaceId = 'space-m217-d';
    insertSpace(db, spaceId);
    insertAgent(db, {
      id: 'agent-coder',
      spaceId,
      name: 'Coder',
      customPrompt: OLD_REVIEWER_PROMPT_PRE_DE_POLL,
      description: REVIEWER_PRESET.description,
      templateName: 'Coder',
    });

    runMigration217(db);

    const row = getAgentRow(db, 'agent-coder');
    expect(row.custom_prompt).toBe(OLD_REVIEWER_PROMPT_PRE_DE_POLL);
  });
});
