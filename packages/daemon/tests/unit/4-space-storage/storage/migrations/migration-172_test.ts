import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import { rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration172 } from '../../../../../src/storage/schema/migrations.ts';
import { SpaceAgentRepository } from '../../../../../src/storage/repositories/space-agent-repository.ts';
import { SpaceAgentManager } from '../../../../../src/lib/space/managers/space-agent-manager.ts';
import { getPresetAgentTemplates } from '../../../../../src/lib/space/agents/seed-agents.ts';
import { computeAgentTemplateHash } from '../../../../../src/lib/space/agents/agent-template-hash.ts';

interface AgentRow {
  id: string;
  name: string;
  template_name: string | null;
  template_hash: string | null;
  description: string | null;
  tools: string | null;
  custom_prompt: string | null;
}

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
    description?: string;
    tools?: string[];
    customPrompt?: string | null;
    templateName?: string | null;
    templateHash?: string | null;
  }
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO space_agents (
			id, space_id, name, description, tools, custom_prompt, thinking_level, template_name, template_hash, created_at, updated_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.id,
    opts.spaceId,
    opts.name,
    opts.description ?? '',
    JSON.stringify(opts.tools ?? []),
    opts.customPrompt ?? null,
    null,
    opts.templateName ?? null,
    opts.templateHash ?? null,
    now,
    now
  );
}

function readAgent(db: BunDatabase, id: string): AgentRow | undefined {
  return db
    .prepare(
      `SELECT id, name, template_name, template_hash, description, tools, custom_prompt
			   FROM space_agents WHERE id = ?`
    )
    .get(id) as AgentRow | undefined;
}

describe('Migration 172: re-backfill orphaned preset agent template tracking', () => {
  let templateDir: string;
  let templateDbPath: string;
  let testDir: string;
  let db: BunDatabase;

  beforeAll(() => {
    templateDir = join(
      process.cwd(),
      'tmp',
      'test-migration-172',
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
    } catch {
      // ignore
    }
  });

  beforeEach(() => {
    testDir = join(
      process.cwd(),
      'tmp',
      'test-migration-172',
      `test-${Date.now()}-${Math.random()}`
    );
    mkdirSync(testDir, { recursive: true });
    const dbPath = join(testDir, 'test.db');
    copyFileSync(templateDbPath, dbPath);
    db = new BunDatabase(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    insertSpace(db, 'sp-1');
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

  test('preset-named row that diverges → left as an orphan (not re-attached)', () => {
    insertAgent(db, {
      id: 'a-1',
      spaceId: 'sp-1',
      name: 'Coder',
      description: 'whatever',
      tools: ['Read'],
      customPrompt: 'old prompt',
    });

    runMigration172(db);

    const row = readAgent(db, 'a-1')!;
    expect(row.template_name).toBeNull();
    expect(row.template_hash).toBeNull();
  });

  test('idempotent — matching row re-attached on run 1, no-op on run 2', () => {
    const coder = getPresetAgentTemplates().find((p) => p.name === 'Coder')!;
    insertAgent(db, {
      id: 'a-1',
      spaceId: 'sp-1',
      name: 'Coder',
      description: coder.description,
      tools: coder.tools,
      customPrompt: coder.customPrompt,
    });

    runMigration172(db);
    const after1 = readAgent(db, 'a-1')!;
    expect(after1.template_name).toBe('Coder');
    expect(after1.template_hash).toMatch(/^[0-9a-f]{64}$/);

    runMigration172(db);
    const after2 = readAgent(db, 'a-1')!;

    expect(after2).toEqual(after1);
  });

  test('no-op on already-tracked rows (template_name already set)', () => {
    insertAgent(db, {
      id: 'a-1',
      spaceId: 'sp-1',
      name: 'Coder',
      templateName: 'Coder',
      templateHash: 'preexisting-hash',
    });

    runMigration172(db);

    const row = readAgent(db, 'a-1')!;
    expect(row.template_name).toBe('Coder');
    expect(row.template_hash).toBe('preexisting-hash');
  });

  test('user-created agent (non-preset name) → untouched', () => {
    insertAgent(db, { id: 'a-custom', spaceId: 'sp-1', name: 'CustomBot' });
    runMigration172(db);

    const row = readAgent(db, 'a-custom')!;
    expect(row.template_name).toBeNull();
    expect(row.template_hash).toBeNull();
  });

  test('matching row → stamped hash equals the preset hash (drift reads in-sync)', () => {
    const coder = getPresetAgentTemplates().find((p) => p.name === 'Coder')!;
    insertAgent(db, {
      id: 'a-match',
      spaceId: 'sp-1',
      name: 'Coder',
      description: coder.description,
      tools: coder.tools,
      customPrompt: coder.customPrompt,
    });

    runMigration172(db);

    const row = readAgent(db, 'a-match')!;
    const presetHash = computeAgentTemplateHash(coder);
    expect(row.template_hash).toBe(presetHash);

    const manager = new SpaceAgentManager(new SpaceAgentRepository(db as any));
    const entry = manager.getAgentDriftReport('sp-1').agents[0];
    expect(entry.updateAvailable).toBe(false);
    expect(entry.customized).toBe(false);
    expect(entry.orphaned).toBe(false);
  });

  test('divergent row → left as orphan, drift forces diff review (customized:true)', () => {
    const reviewer = getPresetAgentTemplates().find((p) => p.name === 'Reviewer')!;

    insertAgent(db, {
      id: 'a-stale',
      spaceId: 'sp-1',
      name: 'Reviewer',
      description: reviewer.description,
      tools: reviewer.tools,
      customPrompt: 'You are a reviewer. **Client:** NeoKai',
    });

    runMigration172(db);

    const row = readAgent(db, 'a-stale')!;
    expect(row.template_name).toBeNull();
    expect(row.template_hash).toBeNull();

    const manager = new SpaceAgentManager(new SpaceAgentRepository(db as any));
    const entry = manager.getAgentDriftReport('sp-1').agents[0];
    expect(entry.updateAvailable).toBe(true);
    expect(entry.customized).toBe(true);
    expect(entry.orphaned).toBe(true);
    expect(manager.getById('a-stale')?.customPrompt).toBe('You are a reviewer. **Client:** NeoKai');
  });

  test('end-to-end: orphaned stale row → syncFromTemplate re-attach fixes the prompt', async () => {
    const reviewer = getPresetAgentTemplates().find((p) => p.name === 'Reviewer')!;
    insertAgent(db, {
      id: 'a-stale',
      spaceId: 'sp-1',
      name: 'Reviewer',
      description: reviewer.description,
      tools: reviewer.tools,
      customPrompt: 'You are a reviewer. **Client:** NeoKai',
    });

    runMigration172(db);

    const manager = new SpaceAgentManager(new SpaceAgentRepository(db as any));
    const entry = manager.getAgentDriftReport('sp-1').agents[0];
    expect(entry.updateAvailable).toBe(true);
    expect(entry.orphaned).toBe(true);

    const result = await manager.syncFromTemplate('a-stale');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('sync failed');
    expect(result.value.customPrompt).toBe(reviewer.customPrompt);
    expect(result.value.customPrompt).toContain('HyperNeo');
    expect(result.value.customPrompt).not.toContain('NeoKai');
  });
});
