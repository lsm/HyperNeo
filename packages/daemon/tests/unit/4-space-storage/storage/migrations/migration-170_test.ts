/**
 * Migration 170 Tests — Re-backfill orphaned preset agent template tracking.
 *
 * Migration 170 is a second-pass backfill (M106 is one-shot/marked). It walks
 * every `space_agents` row whose `template_name IS NULL` and, when the row's
 * normalized name matches a known preset (case-insensitive), stamps:
 *   - `template_name` = canonical preset name
 *   - `template_hash` = SHA-256 of the row's CURRENT field values
 *
 * Hashing the row (not the live preset) is what keeps this safe:
 *   - A row that already matches the preset hashes equal → drift reads in-sync.
 *   - A divergent row hashes different from the live preset → drift reads
 *     `updateAvailable` (the NeoKai→HyperNeo staleness surfaces an Apply
 *     affordance), never silently in-sync.
 *
 * Covers:
 *   - Canonical preset name → backfilled
 *   - Idempotency: second run is a no-op
 *   - No-op on already-tracked rows (template_name already set)
 *   - User-created agent → untouched
 *   - Matching row → drift reads in-sync (storedHash === preset hash)
 *   - Divergent row → row hash stamped (not preset hash), drift reads
 *     updateAvailable without clobbering the row
 *   - End-to-end: after backfill, syncFromTemplate fixes the staleness
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import { rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration170 } from '../../../../../src/storage/schema/migrations.ts';
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

describe('Migration 170: re-backfill orphaned preset agent template tracking', () => {
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

  test('canonical preset name → template_name + template_hash backfilled', () => {
    insertAgent(db, {
      id: 'a-1',
      spaceId: 'sp-1',
      name: 'Coder',
      description: 'whatever',
      tools: ['Read'],
      customPrompt: 'old prompt',
    });

    runMigration170(db);

    const row = readAgent(db, 'a-1')!;
    expect(row.template_name).toBe('Coder');
    expect(row.template_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('idempotent — second run does not change rows', () => {
    insertAgent(db, { id: 'a-1', spaceId: 'sp-1', name: 'Coder' });

    runMigration170(db);
    const after1 = readAgent(db, 'a-1')!;

    runMigration170(db);
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

    runMigration170(db);

    const row = readAgent(db, 'a-1')!;
    expect(row.template_name).toBe('Coder');
    expect(row.template_hash).toBe('preexisting-hash');
  });

  test('user-created agent (non-preset name) → untouched', () => {
    insertAgent(db, { id: 'a-custom', spaceId: 'sp-1', name: 'CustomBot' });
    runMigration170(db);

    const row = readAgent(db, 'a-custom')!;
    expect(row.template_name).toBeNull();
    expect(row.template_hash).toBeNull();
  });

  test('matching row → stamped hash equals the preset hash (drift reads in-sync)', () => {
    const coder = getPresetAgentTemplates().find((p) => p.name === 'Coder')!;
    // Row fields exactly match the current preset, but tracking is missing.
    insertAgent(db, {
      id: 'a-match',
      spaceId: 'sp-1',
      name: 'Coder',
      description: coder.description,
      tools: coder.tools,
      customPrompt: coder.customPrompt,
    });

    runMigration170(db);

    const row = readAgent(db, 'a-match')!;
    const presetHash = computeAgentTemplateHash(coder);
    // Row hash === preset hash for a matching row → drift reads in-sync.
    expect(row.template_hash).toBe(presetHash);

    const manager = new SpaceAgentManager(new SpaceAgentRepository(db as any));
    const entry = manager.getAgentDriftReport('sp-1').agents[0];
    expect(entry.updateAvailable).toBe(false);
    expect(entry.customized).toBe(false);
    expect(entry.orphaned).toBe(false);
  });

  test('divergent row → row hash stamped (not preset hash), drift reads updateAvailable', () => {
    const reviewer = getPresetAgentTemplates().find((p) => p.name === 'Reviewer')!;
    const presetHash = computeAgentTemplateHash(reviewer);

    // A stale Reviewer row (e.g. NeoKai-era prompt) that diverges from the
    // current HyperNeo preset, with tracking missing.
    insertAgent(db, {
      id: 'a-stale',
      spaceId: 'sp-1',
      name: 'Reviewer',
      description: reviewer.description,
      tools: reviewer.tools,
      customPrompt: 'You are a reviewer. **Client:** NeoKai',
    });

    runMigration170(db);

    const row = readAgent(db, 'a-stale')!;
    expect(row.template_name).toBe('Reviewer');
    // The stamped hash is the ROW's fingerprint, NOT the live preset hash —
    // so the row is never silently read as in-sync.
    const rowHash = computeAgentTemplateHash({
      name: 'Reviewer',
      description: reviewer.description,
      tools: reviewer.tools,
      customPrompt: 'You are a reviewer. **Client:** NeoKai',
    });
    expect(row.template_hash).toBe(rowHash);
    expect(row.template_hash).not.toBe(presetHash);

    const manager = new SpaceAgentManager(new SpaceAgentRepository(db as any));
    const entry = manager.getAgentDriftReport('sp-1').agents[0];
    // Stored (row) hash differs from the live preset hash → update available,
    // which is exactly what surfaces the Apply affordance that fixes the
    // staleness. Not silently in-sync.
    expect(entry.updateAvailable).toBe(true);
    expect(entry.orphaned).toBe(false);
    // The row content is untouched — only tracking was stamped.
    expect(manager.getById('a-stale')?.customPrompt).toBe('You are a reviewer. **Client:** NeoKai');
  });

  test('end-to-end: backfill then syncFromTemplate fixes the stale prompt', async () => {
    const reviewer = getPresetAgentTemplates().find((p) => p.name === 'Reviewer')!;
    insertAgent(db, {
      id: 'a-stale',
      spaceId: 'sp-1',
      name: 'Reviewer',
      description: reviewer.description,
      tools: reviewer.tools,
      customPrompt: 'You are a reviewer. **Client:** NeoKai',
    });

    runMigration170(db);

    const manager = new SpaceAgentManager(new SpaceAgentRepository(db as any));
    // Drift now surfaces the row as update-available.
    expect(manager.getAgentDriftReport('sp-1').agents[0].updateAvailable).toBe(true);

    const result = await manager.syncFromTemplate('a-stale');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('sync failed');
    // The HyperNeo rebrand is now applied.
    expect(result.value.customPrompt).toBe(reviewer.customPrompt);
    expect(result.value.customPrompt).toContain('HyperNeo');
    expect(result.value.customPrompt).not.toContain('NeoKai');
  });
});
