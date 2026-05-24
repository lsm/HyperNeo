/**
 * Migration 106 Tests — Backfill preset agent template tracking.
 *
 * Migration 106 walks every `space_agents` row whose `template_name IS NULL`
 * and, when the row's normalized name matches a known preset (case-insensitive),
 * stamps:
 *   - `template_name` = canonical preset name ("Coder", "Reviewer", ...)
 *   - `template_hash` = SHA-256 of the row's CURRENT field values
 *
 * Hashing the row (not the live preset) preserves user customisations: the
 * row's stored hash differs from the live preset's hash, so drift detection
 * surfaces the row as "out of sync" rather than silently overwriting local
 * edits.
 *
 * Covers:
 *   - Canonical preset name (exact match) → backfilled
 *   - Lowercase / surrounding whitespace → matched + canonicalised
 *   - User-created agent (no preset name match) → untouched
 *   - Hash captures the row's current state (preserves customisation)
 *   - Idempotency: running twice is a no-op
 *   - Pre-existing template_name on a row → not overwritten
 *   - Empty `space_agents` table → safe
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration106 } from '../../../../../src/storage/schema/migrations.ts';
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
  thinking_level: string | null;
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
    thinkingLevel?: string | null;
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
    opts.thinkingLevel ?? null,
    opts.templateName ?? null,
    opts.templateHash ?? null,
    now,
    now
  );
}

function readAgent(db: BunDatabase, id: string): AgentRow | undefined {
  return db
    .prepare(
      `SELECT id, name, template_name, template_hash, description, tools, custom_prompt, thinking_level
			   FROM space_agents WHERE id = ?`
    )
    .get(id) as AgentRow | undefined;
}

function readAgentTimestamps(
  db: BunDatabase,
  id: string
): { created_at: number; updated_at: number } | undefined {
  return db.prepare(`SELECT created_at, updated_at FROM space_agents WHERE id = ?`).get(id) as
    | { created_at: number; updated_at: number }
    | undefined;
}

describe('Migration 106: backfill preset agent template tracking', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(
      process.cwd(),
      'tmp',
      'test-migration-106',
      `test-${Date.now()}-${Math.random()}`
    );
    mkdirSync(testDir, { recursive: true });
    db = new BunDatabase(join(testDir, 'test.db'));
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, () => {});
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

    runMigration106(db);

    const row = readAgent(db, 'a-1')!;
    expect(row.template_name).toBe('Coder');
    expect(row.template_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('lowercase / whitespace name → matched and canonicalised to "Coder"', () => {
    insertAgent(db, { id: 'a-1', spaceId: 'sp-1', name: '  coder  ' });
    runMigration106(db);

    const row = readAgent(db, 'a-1')!;
    expect(row.template_name).toBe('Coder');
  });

  test('user-created agent (non-preset name) → untouched', () => {
    insertAgent(db, { id: 'a-custom', spaceId: 'sp-1', name: 'CustomBot' });
    runMigration106(db);

    const row = readAgent(db, 'a-custom')!;
    expect(row.template_name).toBeNull();
    expect(row.template_hash).toBeNull();
  });

  test('all six known presets are matched', () => {
    const presetNames = ['Coder', 'General', 'Planner', 'Research', 'Reviewer', 'QA'];
    presetNames.forEach((name, i) => {
      insertAgent(db, { id: `a-${i}`, spaceId: 'sp-1', name });
    });

    runMigration106(db);

    presetNames.forEach((name, i) => {
      const row = readAgent(db, `a-${i}`)!;
      expect(row.template_name).toBe(name);
      expect(row.template_hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  test('hash captures the row\u2019s current state — two identical rows hash equal', () => {
    insertAgent(db, {
      id: 'a-1',
      spaceId: 'sp-1',
      name: 'Coder',
      description: 'd',
      tools: ['Read', 'Write'],
      customPrompt: 'p',
    });
    insertAgent(db, {
      id: 'a-2',
      spaceId: 'sp-1',
      name: 'Coder',
      description: 'd',
      tools: ['Write', 'Read'], // different ordering — hash should still match
      customPrompt: 'p',
    });

    runMigration106(db);

    const r1 = readAgent(db, 'a-1')!;
    const r2 = readAgent(db, 'a-2')!;
    expect(r1.template_hash).toBe(r2.template_hash);
  });

  test('rows that differ in description hash to different values (drift surface)', () => {
    insertAgent(db, {
      id: 'a-stock',
      spaceId: 'sp-1',
      name: 'Coder',
      description: 'stock description',
      tools: ['Read'],
      customPrompt: 'stock',
    });
    insertAgent(db, {
      id: 'a-edited',
      spaceId: 'sp-1',
      name: 'Coder',
      description: 'user-edited description',
      tools: ['Read'],
      customPrompt: 'stock',
    });

    runMigration106(db);

    const stock = readAgent(db, 'a-stock')!;
    const edited = readAgent(db, 'a-edited')!;
    expect(stock.template_hash).not.toBe(edited.template_hash);
  });

  test('idempotent — second run does not change rows', () => {
    insertAgent(db, { id: 'a-1', spaceId: 'sp-1', name: 'Coder' });

    runMigration106(db);
    const after1 = readAgent(db, 'a-1')!;

    runMigration106(db);
    const after2 = readAgent(db, 'a-1')!;

    expect(after2).toEqual(after1);
  });

  test('pre-existing template_name is NOT overwritten (only NULL rows are touched)', () => {
    insertAgent(db, {
      id: 'a-1',
      spaceId: 'sp-1',
      name: 'Coder',
      templateName: 'Coder',
      templateHash: 'preexisting-hash',
    });

    runMigration106(db);

    const row = readAgent(db, 'a-1')!;
    expect(row.template_name).toBe('Coder');
    expect(row.template_hash).toBe('preexisting-hash');
  });

  test('empty space_agents table → migration is safe (no-op)', () => {
    expect(() => runMigration106(db)).not.toThrow();
    const count = (db.prepare(`SELECT COUNT(*) AS c FROM space_agents`).get() as { c: number }).c;
    expect(count).toBe(0);
  });

  test('restart migrations preserve a Reviewer prompt synced to the current template', async () => {
    const reviewer = getPresetAgentTemplates().find((p) => p.name === 'Reviewer');
    if (!reviewer) throw new Error('Reviewer preset missing');

    insertAgent(db, {
      id: 'reviewer-agent',
      spaceId: 'sp-1',
      name: 'Reviewer',
      description: reviewer.description,
      tools: reviewer.tools,
      customPrompt:
        'You are an expert code reviewer. You review pull requests for correctness, security, performance, style, and test coverage. You give specific, actionable feedback.\n\nReview the code thoroughly. If satisfied, summarize your findings. If changes are needed, provide specific feedback.',
      templateName: 'Reviewer',
      templateHash: 'stale-reviewer-hash',
    });

    const manager = new SpaceAgentManager(new SpaceAgentRepository(db as any));
    const sync = await manager.syncFromTemplate('reviewer-agent');
    expect(sync.ok).toBe(true);
    if (!sync.ok) throw new Error('sync failed');
    expect(sync.value.customPrompt).toBe(reviewer.customPrompt);
    expect(sync.value.templateHash).toBe(computeAgentTemplateHash(reviewer));
    expect(sync.value.customPrompt).not.toContain('You are an expert code reviewer');

    const beforeRestart = readAgent(db, 'reviewer-agent')!;
    const beforeTimestamps = readAgentTimestamps(db, 'reviewer-agent')!;

    // Simulate daemon restart/bootstrap: run the full migration stack again on
    // an already-modern schema. This used to re-add legacy columns, trigger M74's
    // table rebuild, drop custom_prompt, and let M80 repopulate from stale
    // system_prompt/instructions data.
    runMigrations(db, () => {});

    const afterRestart = readAgent(db, 'reviewer-agent')!;
    const afterTimestamps = readAgentTimestamps(db, 'reviewer-agent')!;
    expect(afterRestart.custom_prompt).toBe(reviewer.customPrompt);
    expect(afterRestart.template_hash).toBe(computeAgentTemplateHash(reviewer));
    expect(afterRestart).toEqual(beforeRestart);
    expect(afterTimestamps).toEqual(beforeTimestamps);
  });

  test('restart migrations do not overwrite customized preset prompts', () => {
    const reviewer = getPresetAgentTemplates().find((p) => p.name === 'Reviewer');
    if (!reviewer) throw new Error('Reviewer preset missing');
    const customizedPrompt = `${reviewer.customPrompt}\n\nUser-specific review policy.`;

    insertAgent(db, {
      id: 'customized-reviewer',
      spaceId: 'sp-1',
      name: 'Reviewer',
      description: reviewer.description,
      tools: reviewer.tools,
      customPrompt: customizedPrompt,
      templateName: 'Reviewer',
      templateHash: computeAgentTemplateHash({ ...reviewer, customPrompt: customizedPrompt }),
    });
    const before = readAgent(db, 'customized-reviewer')!;
    const beforeTimestamps = readAgentTimestamps(db, 'customized-reviewer')!;

    runMigrations(db, () => {});

    const after = readAgent(db, 'customized-reviewer')!;
    const afterTimestamps = readAgentTimestamps(db, 'customized-reviewer')!;
    expect(after.custom_prompt).toBe(customizedPrompt);
    expect(after).toEqual(before);
    expect(afterTimestamps).toEqual(beforeTimestamps);
  });
});
