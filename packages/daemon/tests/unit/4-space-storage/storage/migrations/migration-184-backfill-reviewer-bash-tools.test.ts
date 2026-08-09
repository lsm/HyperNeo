/**
 * Migration 184 Tests — Backfill Bash + Cron tools onto existing Reviewer preset rows.
 *
 * The Reviewer preset gained `Bash` + `CronCreate`/`CronDelete`/`CronList` when the
 * PR-process MCPs were removed. `seedPresetAgents()` runs only at Space creation, so
 * existing Spaces keep the shell-less Reviewer tool profile. M184 re-stamps ONLY
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
import {
  runMigration184,
  OLD_REVIEWER_PROMPT,
  OLD_REVIEWER_PROMPT_PRE_2365,
  OLD_REVIEWER_DESCRIPTION,
  OLD_REVIEWER_DESCRIPTION_PRE_2365,
  OLD_REVIEWER_TOOLS,
  OLD_REVIEWER_TOOLS_PRE_2365,
} from '../../../../../src/storage/schema/m184-backfill-reviewer-bash-tools.ts';
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

describe('migration 184 — reviewer bash tool backfill', () => {
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

    runMigration184(db);

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

  test('re-stamps a pristine pre-#2365 bash Reviewer seed too', () => {
    // Spaces seeded before the shell-less Reviewer split carry the pre-#2365
    // bash contract — WITH Bash in its tools and a shorter description ending at
    // "test coverage." (no "Has no shell" suffix). Its REST gh api repos/.../
    // reviews posting command is now blocked by the reviewer Bash guard, so a
    // pristine row from that era must be migrated (full tuple match) too.
    const spaceId = 'space-m179-pre2365';
    insertSpace(db, spaceId);
    insertAgent(db, {
      id: 'agent-reviewer-pre2365',
      spaceId,
      name: 'Reviewer',
      handle: 'reviewer',
      tools: OLD_REVIEWER_TOOLS_PRE_2365,
      customPrompt: OLD_REVIEWER_PROMPT_PRE_2365,
      description: OLD_REVIEWER_DESCRIPTION_PRE_2365,
      templateName: 'Reviewer',
      templateHash: computeAgentTemplateHash(REVIEWER_PRESET),
    });

    runMigration184(db);

    const row = getAgentRow('agent-reviewer-pre2365');
    expect(parseTools(row as unknown as AgentRow)).toContain('Bash');
    // The stale pre-#2365 prompt is replaced with the current contract.
    expect((row as unknown as AgentRow).custom_prompt).toBe(REVIEWER_PRESET.customPrompt);
    expect((row as unknown as AgentRow).custom_prompt).not.toContain('Verify goal alignment');
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

    runMigration184(db);

    const row = getAgentRow('agent-reviewer-custom');
    expect(parseTools(row as unknown as AgentRow)).toEqual(customTools);
    expect((row as unknown as AgentRow).custom_prompt).toBe('My custom reviewer prompt');
    expect((row as unknown as AgentRow).template_hash).toBe('some-hash');
  });

  test('does NOT grant Bash to an untracked Reviewer-named agent with custom prose', () => {
    // A user-created agent (template_name NULL) that merely shares the name
    // 'Reviewer' and the old tool set, but has a custom prompt/description,
    // must NOT be granted Bash+Cron or stamped template_name='Reviewer' — that
    // would silently expand an untracked agent's privileges over attacker-
    // controlled PR content. Only a full pristine-seed match is backfilled.
    const spaceId = 'space-m179-untracked';
    insertSpace(db, spaceId);
    insertAgent(db, {
      id: 'agent-reviewer-untracked-custom',
      spaceId,
      name: 'Reviewer',
      handle: 'my-reviewer',
      tools: OLD_REVIEWER_TOOLS,
      customPrompt: 'A user-authored reviewer prompt, not the seed',
      description: 'Custom description',
      templateName: null,
      templateHash: null,
    });

    runMigration184(db);

    const row = getAgentRow('agent-reviewer-untracked-custom');
    // Tools unchanged (NO Bash grant), prose preserved, still untracked.
    expect(parseTools(row as unknown as AgentRow)).toEqual(OLD_REVIEWER_TOOLS);
    expect((row as unknown as AgentRow).template_name).toBeNull();
    expect((row as unknown as AgentRow).custom_prompt).toBe(
      'A user-authored reviewer prompt, not the seed'
    );
  });

  test('backfills an untracked Reviewer-named agent ONLY when it is a full pristine seed', () => {
    // Same shape but with the EXACT pristine seed prompt+description → it IS a
    // genuine legacy preset row, so it is backfilled (granted Bash).
    const spaceId = 'space-m179-untracked-pristine';
    insertSpace(db, spaceId);
    insertAgent(db, {
      id: 'agent-reviewer-untracked-pristine',
      spaceId,
      name: 'Reviewer',
      handle: 'reviewer',
      tools: OLD_REVIEWER_TOOLS,
      customPrompt: OLD_REVIEWER_PROMPT,
      description: OLD_REVIEWER_DESCRIPTION,
      templateName: null,
      templateHash: null,
    });

    runMigration184(db);

    const row = getAgentRow('agent-reviewer-untracked-pristine');
    expect(parseTools(row as unknown as AgentRow)).toEqual(REVIEWER_PRESET.tools);
    expect((row as unknown as AgentRow).template_name).toBe('Reviewer');
  });

  test('backfills old tools while preserving customized Reviewer prose', () => {
    // The reviewer kept the old shell-less tool list but customized prompt and
    // description. The migration must make the tool surface usable without
    // overwriting prose; the stale hash keeps drift/sync available.
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

    runMigration184(db);

    const row = getAgentRow('agent-reviewer-prompt-custom');
    expect(parseTools(row as unknown as AgentRow)).toEqual(REVIEWER_PRESET.tools);
    expect((row as unknown as AgentRow).custom_prompt).toBe('My completely custom reviewer prompt');
    expect((row as unknown as AgentRow).description).toBe('My custom description');
    expect((row as unknown as AgentRow).template_hash).toBe('some-hash');
  });

  test('leaves a Reviewer with old tools + appended prompt untouched (exact-match guard)', () => {
    // The reviewer kept the old tools AND the old prompt but APPENDED custom
    // instructions. The migration must NOT overwrite the appended prompt — it
    // uses exact full-prompt equality (not a substring match), so even a
    // prompt that still contains the old marker is recognized as customized.
    const spaceId = 'space-m179-b3';
    insertSpace(db, spaceId);
    const appended = OLD_REVIEWER_PROMPT + '\n\n### My team instructions\nAlways run extra checks.';
    insertAgent(db, {
      id: 'agent-reviewer-appended',
      spaceId,
      name: 'Reviewer',
      handle: 'reviewer',
      tools: OLD_REVIEWER_TOOLS,
      customPrompt: appended,
      description: OLD_REVIEWER_DESCRIPTION,
      templateName: 'Reviewer',
      templateHash: 'some-hash',
    });

    runMigration184(db);

    const row = getAgentRow('agent-reviewer-appended');
    expect(parseTools(row as unknown as AgentRow)).toEqual(REVIEWER_PRESET.tools);
    // The appended prompt is preserved byte-for-byte (not replaced with the
    // current preset prompt), and the hash is left stale for drift/sync.
    expect((row as unknown as AgentRow).custom_prompt).toBe(appended);
    expect((row as unknown as AgentRow).custom_prompt).not.toBe(REVIEWER_PRESET.customPrompt);
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

    runMigration184(db);
    runMigration184(db);

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

    runMigration184(db);

    const row = getAgentRow('agent-coder');
    expect(parseTools(row as unknown as AgentRow)).toEqual(CODER_PRESET.tools);
  });

  test('safe no-op on empty space_agents', () => {
    runMigration184(db);
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

    runMigration184(db);

    const row = getAgentRow('agent-reviewer-user');
    // Untracked rows are never re-stamped (name is also not 'Reviewer').
    expect(parseTools(row as unknown as AgentRow)).toEqual(OLD_REVIEWER_TOOLS);
    expect((row as unknown as AgentRow).template_hash).toBeNull();
  });
});
