/**
 * Migration 170 Tests — Backfill missing preset agents into existing Spaces.
 *
 * seedPresetAgents() runs only at Space creation, so a Space created before a
 * preset was added to PRESET_AGENTS (most recently "PR Merger") never received
 * that preset's `space_agents` row. M170 walks every Space × the live preset
 * list and INSERTs any preset row that is missing (matched by name).
 *
 * Covers:
 *   - Space with no agents → every preset inserted with canonical values
 *   - Space missing only "PR Merger" (the real-world bug) → only it is inserted
 *   - Inserted row matches what seedPresetAgents would have written
 *     (templateName/templateHash/fields) and is readable by the production repo
 *   - Idempotency: re-running inserts nothing
 *   - User-customized same-named row (template_name NULL) → left untouched
 *   - Multiple spaces backfilled independently
 *   - Empty DB / no spaces → safe no-op
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration170 } from '../../../../../src/storage/schema/index.ts';
import { SpaceAgentRepository } from '../../../../../src/storage/repositories/space-agent-repository.ts';
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
const MERGER = PRESETS.find((p) => p.name === 'PR Merger')!;

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
    templateName?: string | null;
    templateHash?: string | null;
  }
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO space_agents
       (id, space_id, name, handle, tools, custom_prompt, template_name, template_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.id,
    opts.spaceId,
    opts.name,
    opts.handle ?? null,
    JSON.stringify(opts.tools ?? []),
    opts.customPrompt ?? null,
    opts.templateName ?? null,
    opts.templateHash ?? null,
    now,
    now
  );
}

function readAgentByName(db: BunDatabase, spaceId: string, name: string): AgentRow | undefined {
  return db
    .prepare(
      `SELECT id, name, handle, template_name, template_hash, description, tools, custom_prompt
         FROM space_agents WHERE space_id = ? AND LOWER(name) = LOWER(?)`
    )
    .get(spaceId, name) as AgentRow | undefined;
}

function countAgents(db: BunDatabase, spaceId: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS c FROM space_agents WHERE space_id = ?`).get(spaceId) as {
      c: number;
    }
  ).c;
}

describe('Migration 170: backfill missing preset agents into existing Spaces', () => {
  let templateDir: string;
  let templateDbPath: string;
  let testDir: string;
  let db: BunDatabase;

  beforeAll(() => {
    templateDir = join(
      process.cwd(),
      'tmp',
      'test-migration-170',
      `template-${Date.now()}-${Math.random()}`
    );
    mkdirSync(templateDir, { recursive: true });
    templateDbPath = join(templateDir, 'template.db');
    const templateDb = new BunDatabase(templateDbPath);
    try {
      templateDb.exec('PRAGMA foreign_keys = ON');
      // Build the full schema once. M170 runs here too, but with no Spaces it
      // is a no-op; the per-test invocation below calls the function directly.
      runMigrations(templateDb, () => {});
    } finally {
      templateDb.close();
    }
  });

  afterAll(() => {
    try {
      rmSync(templateDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  beforeEach(() => {
    testDir = join(
      process.cwd(),
      'tmp',
      'test-migration-170',
      `test-${Date.now()}-${Math.random()}`
    );
    mkdirSync(testDir, { recursive: true });
    const dbPath = join(testDir, 'test.db');
    copyFileSync(templateDbPath, dbPath);
    db = new BunDatabase(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('Space with no agents → every preset inserted with canonical field values', () => {
    insertSpace(db, 'sp-1');

    runMigration170(db);

    expect(countAgents(db, 'sp-1')).toBe(PRESETS.length);
    for (const preset of PRESETS) {
      const row = readAgentByName(db, 'sp-1', preset.name)!;
      expect(row.handle).toBe(preset.handle);
      expect(row.template_name).toBe(preset.name);
      expect(row.template_hash).toBe(computeAgentTemplateHash(preset));
      expect(row.description).toBe(preset.description);
      // tools column preserves the preset's definition order (only the
      // fingerprint/hash sorts); must match seedPresetAgents output verbatim.
      expect(JSON.parse(row.tools ?? '[]')).toEqual(preset.tools);
      expect(row.custom_prompt).toBe(preset.customPrompt);
    }
  });

  test('Space missing only "PR Merger" (the real-world bug) → only it is inserted', () => {
    insertSpace(db, 'sp-1');
    // The six presets that predate "PR Merger" already exist, template-stamped.
    const legacyPresets = PRESETS.filter((p) => p.name !== 'PR Merger');
    for (const preset of legacyPresets) {
      insertAgent(db, {
        id: `existing-${preset.handle}`,
        spaceId: 'sp-1',
        name: preset.name,
        handle: preset.handle,
        templateName: preset.name,
        templateHash: computeAgentTemplateHash(preset),
      });
    }

    runMigration170(db);

    // PR Merger is now present with canonical values.
    const merger = readAgentByName(db, 'sp-1', 'PR Merger')!;
    expect(merger).toBeDefined();
    expect(merger.template_name).toBe('PR Merger');
    expect(merger.template_hash).toBe(computeAgentTemplateHash(MERGER));
    expect(merger.handle).toBe('merger');

    // No duplicates: exactly PRESETS.length rows, and the legacy six are intact.
    expect(countAgents(db, 'sp-1')).toBe(PRESETS.length);
    for (const preset of legacyPresets) {
      const row = readAgentByName(db, 'sp-1', preset.name)!;
      expect(row.id).toBe(`existing-${preset.handle}`); // original row, not replaced
      expect(row.template_hash).toBe(computeAgentTemplateHash(preset));
    }
  });

  test('inserted row is readable by the production repository and matches seedPresetAgents output', () => {
    insertSpace(db, 'sp-1');

    runMigration170(db);

    const repo = new SpaceAgentRepository(db as unknown as InstanceType<typeof BunDatabase>);
    const agents = repo.getBySpaceId('sp-1');
    const merger = agents.find((a) => a.name === 'PR Merger')!;
    expect(merger).toBeDefined();
    // Same fields seedPresetAgents stamps via the manager/repo create path.
    expect(merger.templateName).toBe('PR Merger');
    expect(merger.templateHash).toBe(computeAgentTemplateHash(MERGER));
    expect(merger.handle).toBe('merger');
    expect(merger.description).toBe(MERGER.description);
    expect(merger.customPrompt).toBe(MERGER.customPrompt);
    expect(merger.tools ?? []).toEqual(MERGER.tools);
    expect(merger.status).toBe('active');
  });

  test('idempotent — re-running inserts nothing', () => {
    insertSpace(db, 'sp-1');

    runMigration170(db);
    const idsAfterFirst = (
      db.prepare(`SELECT id FROM space_agents WHERE space_id = 'sp-1'`).all() as Array<{
        id: string;
      }>
    )
      .map((r) => r.id)
      .sort();
    const countAfterFirst = countAgents(db, 'sp-1');

    runMigration170(db);
    const idsAfterSecond = (
      db.prepare(`SELECT id FROM space_agents WHERE space_id = 'sp-1'`).all() as Array<{
        id: string;
      }>
    )
      .map((r) => r.id)
      .sort();

    expect(countAgents(db, 'sp-1')).toBe(countAfterFirst);
    expect(idsAfterSecond).toEqual(idsAfterFirst);
  });

  test('user-customized same-named row (template_name NULL) is left untouched', () => {
    insertSpace(db, 'sp-1');
    // The six legacy presets are present and template-stamped. "PR Merger"
    // exists too, but as a USER-customized row (its own tools, template_name
    // NULL) — the case M106 left alone because "PR Merger" wasn't in its frozen
    // name list. M170 must NOT insert a duplicate PR Merger and must NOT touch
    // the user's row.
    for (const preset of PRESETS.filter((p) => p.name !== 'PR Merger')) {
      insertAgent(db, {
        id: `existing-${preset.handle}`,
        spaceId: 'sp-1',
        name: preset.name,
        handle: preset.handle,
        templateName: preset.name,
        templateHash: computeAgentTemplateHash(preset),
      });
    }
    insertAgent(db, {
      id: 'user-merger',
      spaceId: 'sp-1',
      name: 'PR Merger',
      handle: 'merger',
      tools: ['Read', 'Bash', 'Write'], // user-customized tool set
      customPrompt: 'my own merge procedure',
      templateName: null,
      templateHash: null,
    });

    runMigration170(db);

    // Exactly one row per preset name — no duplicate PR Merger inserted.
    expect(countAgents(db, 'sp-1')).toBe(PRESETS.length);
    const row = readAgentByName(db, 'sp-1', 'PR Merger')!;
    expect(row.id).toBe('user-merger'); // original user row, not replaced
    expect(row.template_name).toBeNull();
    expect(row.template_hash).toBeNull();
    expect(JSON.parse(row.tools ?? '[]')).toEqual(['Read', 'Bash', 'Write']);
    expect(row.custom_prompt).toBe('my own merge procedure');
  });

  test('multiple Spaces are backfilled independently', () => {
    insertSpace(db, 'sp-1');
    insertSpace(db, 'sp-2');
    // sp-1 already has every preset; sp-2 has none.
    for (const preset of PRESETS) {
      insertAgent(db, {
        id: `sp1-${preset.handle}`,
        spaceId: 'sp-1',
        name: preset.name,
        handle: preset.handle,
        templateName: preset.name,
        templateHash: computeAgentTemplateHash(preset),
      });
    }

    runMigration170(db);

    expect(countAgents(db, 'sp-1')).toBe(PRESETS.length); // unchanged
    expect(countAgents(db, 'sp-2')).toBe(PRESETS.length); // fully backfilled
    expect(readAgentByName(db, 'sp-2', 'PR Merger')!.template_name).toBe('PR Merger');
  });

  test('no Spaces → safe no-op', () => {
    expect(() => runMigration170(db)).not.toThrow();
    const count = (db.prepare(`SELECT COUNT(*) AS c FROM space_agents`).get() as { c: number }).c;
    expect(count).toBe(0);
  });
});
