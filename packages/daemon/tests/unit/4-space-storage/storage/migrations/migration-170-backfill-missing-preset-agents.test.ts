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
const CANONICAL_PRESET = PRESETS[0];

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
      runMigrations(templateDb, () => {});
    } finally {
      templateDb.close();
    }
  });

  afterAll(() => {
    try {
      rmSync(templateDir, { recursive: true, force: true });
    } catch {}
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
    } catch {}
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
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
      expect(JSON.parse(row.tools ?? '[]')).toEqual(preset.tools);
      expect(row.custom_prompt).toBe(preset.customPrompt);
    }
  });

  test('Space missing only one preset → only it is inserted', () => {
    insertSpace(db, 'sp-1');
    const existingPresets = PRESETS.filter((p) => p !== CANONICAL_PRESET);
    for (const preset of existingPresets) {
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

    const backfilled = readAgentByName(db, 'sp-1', CANONICAL_PRESET.name)!;
    expect(backfilled).toBeDefined();
    expect(backfilled.template_name).toBe(CANONICAL_PRESET.name);
    expect(backfilled.template_hash).toBe(computeAgentTemplateHash(CANONICAL_PRESET));
    expect(backfilled.handle).toBe(CANONICAL_PRESET.handle);

    expect(countAgents(db, 'sp-1')).toBe(PRESETS.length);
    for (const preset of existingPresets) {
      const row = readAgentByName(db, 'sp-1', preset.name)!;
      expect(row.id).toBe(`existing-${preset.handle}`);
      expect(row.template_hash).toBe(computeAgentTemplateHash(preset));
    }
  });

  test('inserted row is readable by the production repository and matches seedPresetAgents output', () => {
    insertSpace(db, 'sp-1');

    runMigration170(db);

    const repo = new SpaceAgentRepository(db as unknown as InstanceType<typeof BunDatabase>);
    const agents = repo.getBySpaceId('sp-1');
    const backfilled = agents.find((a) => a.name === CANONICAL_PRESET.name)!;
    expect(backfilled).toBeDefined();
    expect(backfilled.templateName).toBe(CANONICAL_PRESET.name);
    expect(backfilled.templateHash).toBe(computeAgentTemplateHash(CANONICAL_PRESET));
    expect(backfilled.handle).toBe(CANONICAL_PRESET.handle);
    expect(backfilled.description).toBe(CANONICAL_PRESET.description);
    expect(backfilled.customPrompt).toBe(CANONICAL_PRESET.customPrompt);
    expect(backfilled.tools ?? []).toEqual(CANONICAL_PRESET.tools);
    expect(backfilled.status).toBe('active');
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
    for (const preset of PRESETS.filter((p) => p !== CANONICAL_PRESET)) {
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
      id: 'user-agent',
      spaceId: 'sp-1',
      name: CANONICAL_PRESET.name,
      handle: CANONICAL_PRESET.handle,
      tools: ['Read', 'Bash', 'Write'],
      customPrompt: 'my own custom prompt',
      templateName: null,
      templateHash: null,
    });

    runMigration170(db);

    expect(countAgents(db, 'sp-1')).toBe(PRESETS.length);
    const row = readAgentByName(db, 'sp-1', CANONICAL_PRESET.name)!;
    expect(row.id).toBe('user-agent');
    expect(row.template_name).toBeNull();
    expect(row.template_hash).toBeNull();
    expect(JSON.parse(row.tools ?? '[]')).toEqual(['Read', 'Bash', 'Write']);
    expect(row.custom_prompt).toBe('my own custom prompt');
  });

  test('multiple Spaces are backfilled independently', () => {
    insertSpace(db, 'sp-1');
    insertSpace(db, 'sp-2');
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

    expect(countAgents(db, 'sp-1')).toBe(PRESETS.length);
    expect(countAgents(db, 'sp-2')).toBe(PRESETS.length);
    expect(readAgentByName(db, 'sp-2', CANONICAL_PRESET.name)!.template_name).toBe(
      CANONICAL_PRESET.name
    );
  });

  test('no Spaces → safe no-op', () => {
    expect(() => runMigration170(db)).not.toThrow();
    const count = (db.prepare(`SELECT COUNT(*) AS c FROM space_agents`).get() as { c: number }).c;
    expect(count).toBe(0);
  });
});
