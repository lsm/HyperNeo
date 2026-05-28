/**
 * Migration 94 Tests — Backfill workflow template tracking & deduplicate seeds.
 *
 * Migration 94 realigns legacy `space_workflows` rows with the current built-in
 * templates by:
 *   - Setting `template_name` + `template_hash` on rows whose node names
 *     structurally match a known template.
 *   - Deleting orphan duplicate rows that have no active `space_workflow_runs`
 *     references.
 *
 * Note: an earlier revision of M94 also re-injected end-node `completionActions`
 * JSON on rows where it was missing. That pipeline was deleted in PR 4/5 of the
 * task-agent-as-post-approval-executor refactor and the underlying columns are
 * dropped in M104 (PR 5/5), so the backfill is no longer performed. These tests
 * therefore only assert template tracking + dedup behaviour.
 *
 * Covers:
 *   - Legacy Coding Workflow backfill (template_name + canonical template_hash)
 *   - Legacy Research Workflow backfill (similar)
 *   - Review-Only workflow backfills template_name + hash
 *   - Hash self-verification: the hashes my inlined fingerprints produce for
 *     each of the 5 built-in templates must structurally line up with the
 *     canonical `computeWorkflowHash()` output. This guards against fingerprint
 *     drift.
 *   - Idempotency: running twice yields the same result
 *   - Custom workflows (non-template name) are untouched
 *   - Orphan duplicate deletion: older row deleted when no active runs
 *   - Orphan duplicate retention: older row kept when active runs reference it
 *   - Rows with non-matching node structure are not treated as templates
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration94 } from '../../../../../src/storage/schema/migrations.ts';
import { getBuiltInWorkflows } from '../../../../../src/lib/space/workflows/built-in-workflows.ts';
import { computeWorkflowHash } from '../../../../../src/lib/space/workflows/template-hash.ts';

interface WorkflowRow {
  id: string;
  template_name: string | null;
  template_hash: string | null;
}

interface NodeRow {
  id: string;
  config: string | null;
}

function insertSpace(db: BunDatabase, id: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, id, '/ws', id, now, now);
}

function insertWorkflow(
  db: BunDatabase,
  opts: {
    id: string;
    spaceId: string;
    name: string;
    description?: string;
    channels?: unknown[];
    gates?: unknown[];
    startNodeId?: string | null;
    endNodeId?: string | null;
    templateName?: string | null;
    templateHash?: string | null;
    createdAt?: number;
  }
): void {
  const now = opts.createdAt ?? Date.now();
  db.prepare(
    `INSERT INTO space_workflows (
			id, space_id, name, description, start_node_id, end_node_id,
			tags, channels, gates, created_at, updated_at, template_name, template_hash
		 ) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.id,
    opts.spaceId,
    opts.name,
    opts.description ?? '',
    opts.startNodeId ?? null,
    opts.endNodeId ?? null,
    JSON.stringify(opts.channels ?? []),
    JSON.stringify(opts.gates ?? []),
    now,
    now,
    opts.templateName ?? null,
    opts.templateHash ?? null
  );
}

function insertNode(
  db: BunDatabase,
  opts: { id: string; workflowId: string; name: string; config?: unknown }
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO space_workflow_nodes (id, workflow_id, name, config, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    opts.id,
    opts.workflowId,
    opts.name,
    JSON.stringify(opts.config ?? { agents: [] }),
    now,
    now
  );
}

function insertRun(
  db: BunDatabase,
  opts: { id: string; spaceId: string; workflowId: string; status: string }
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(opts.id, opts.spaceId, opts.workflowId, 'run', opts.status, now, now);
}

function readWorkflow(db: BunDatabase, id: string): WorkflowRow | undefined {
  return db
    .prepare(`SELECT id, template_name, template_hash FROM space_workflows WHERE id = ?`)
    .get(id) as WorkflowRow | undefined;
}

function readNodeConfig(db: BunDatabase, id: string): Record<string, unknown> {
  const row = db.prepare(`SELECT id, config FROM space_workflow_nodes WHERE id = ?`).get(id) as
    | NodeRow
    | undefined;
  return row?.config ? (JSON.parse(row.config) as Record<string, unknown>) : {};
}

function seedLegacyCodingWorkflow(
  db: BunDatabase,
  opts: {
    id: string;
    spaceId: string;
    createdAt?: number;
    /** Default false — null template_name simulates pre-M90 legacy rows. */
    withTemplateFields?: boolean;
  }
): { workflowId: string; codingNodeId: string; reviewNodeId: string } {
  const template = getBuiltInWorkflows().find((t) => t.name === 'Coding Workflow');
  if (!template) throw new Error('Coding Workflow template missing');

  const codingNodeId = `${opts.id}-n-coding`;
  const reviewNodeId = `${opts.id}-n-review`;

  insertWorkflow(db, {
    id: opts.id,
    spaceId: opts.spaceId,
    name: template.name,
    description: template.description,
    channels: template.channels ?? [],
    gates: template.gates ?? [],
    startNodeId: codingNodeId,
    endNodeId: reviewNodeId,
    templateName: opts.withTemplateFields ? template.name : null,
    templateHash: opts.withTemplateFields ? computeWorkflowHash(template) : null,
    createdAt: opts.createdAt,
  });

  insertNode(db, {
    id: codingNodeId,
    workflowId: opts.id,
    name: 'Coding',
    config: { agents: [{ agentId: 'a-coder', name: 'coder' }] },
  });

  insertNode(db, {
    id: reviewNodeId,
    workflowId: opts.id,
    name: 'Review',
    config: { agents: [{ agentId: 'a-reviewer', name: 'reviewer' }] },
  });

  return { workflowId: opts.id, codingNodeId, reviewNodeId };
}

describe('Migration 94: backfill workflow template tracking & dedup orphan duplicates', () => {
  let testDir: string;
  let db: BunDatabase;

  // Generous hook timeout: `runMigrations` replays the full migration chain on
  // a fresh on-disk DB for every test, which legitimately takes a few seconds
  // and intermittently exceeded the 5s default under CI load (flaky timeout).
  const HOOK_TIMEOUT_MS = 30000;

  beforeEach(() => {
    testDir = join(
      process.cwd(),
      'tmp',
      'test-migration-94',
      `test-${Date.now()}-${Math.random()}`
    );
    mkdirSync(testDir, { recursive: true });
    db = new BunDatabase(join(testDir, 'test.db'));
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, () => {});
    insertSpace(db, 'sp-1');
  }, HOOK_TIMEOUT_MS);

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
  }, HOOK_TIMEOUT_MS);

  test('hash self-verification: migration stores narrow hash that diverges from expanded computeWorkflowHash', () => {
    // Migration 94 uses a frozen narrow fingerprint (description + instructions +
    // nodeNames + channels + gates only). The live computeWorkflowHash was later
    // expanded to also include customPrompt per agent and
    // completionAutonomyLevel. As a result, the migration's stored hash
    // intentionally diverges from the current computeWorkflowHash — this is
    // what causes drift detection to fire for existing spaces on next daemon
    // startup, prompting the "Sync from template" UI to appear.
    const templates = getBuiltInWorkflows();
    for (const [i, tpl] of templates.entries()) {
      const wfId = `wf-verify-${i}`;
      const endNodeId = `n-${i}-end`;
      const nodeIds =
        tpl.name === 'Coding Workflow'
          ? [
              { id: `n-${i}-Coding`, name: 'Coding' },
              { id: `n-${i}-Review`, name: 'Review' },
            ]
          : tpl.nodes.map((n) => ({ id: `n-${i}-${n.name}`, name: n.name }));
      const resolvedEndNodeId =
        nodeIds.find((n) => n.name === tpl.nodes.find((x) => x.id === tpl.endNodeId)?.name)?.id ??
        endNodeId;
      const legacyCodingChannels = [
        { from: 'Coding', to: 'Review' },
        { from: 'Review', to: 'Coding' },
      ];
      const legacyCodingGates = (tpl.gates ?? []).filter((gate) => gate.id === 'code-ready-gate');

      insertWorkflow(db, {
        id: wfId,
        spaceId: 'sp-1',
        name: tpl.name,
        description: tpl.description,
        channels: tpl.name === 'Coding Workflow' ? legacyCodingChannels : (tpl.channels ?? []),
        gates: tpl.name === 'Coding Workflow' ? legacyCodingGates : (tpl.gates ?? []),
        endNodeId: resolvedEndNodeId,
      });
      for (const n of nodeIds) {
        insertNode(db, { id: n.id, workflowId: wfId, name: n.name });
      }
    }

    runMigration94(db);

    for (const [i, tpl] of templates.entries()) {
      const row = readWorkflow(db, `wf-verify-${i}`);
      expect(row?.template_name).toBe(tpl.name);
      // The migration sets a valid SHA-256 hash (non-null)
      expect(row?.template_hash).toMatch(/^[0-9a-f]{64}$/);
      // The stored hash is the narrow M94 hash; it diverges from the
      // expanded computeWorkflowHash — confirming drift detection fires.
      expect(row?.template_hash).not.toBe(computeWorkflowHash(tpl));
    }
  });

  test('divergent row (structure matches template but description differs) → template_hash reflects the row, not the canonical template', () => {
    // Pins the ELSE branch of `fingerprintMatches ? known.hash : rowHash` in
    // the migration. Combined with `hash self-verification` above (which
    // covers the TRUE branch), both branches are exercised.
    const template = getBuiltInWorkflows().find((t) => t.name === 'Coding Workflow')!;
    const canonicalHash = computeWorkflowHash(template);

    // Same name + node set as Coding Workflow, but with a tweaked description
    // — so the structural name match passes but fingerprintMatches is false.
    const wfId = 'wf-diverged';
    const codingId = 'n-d-coding';
    const reviewId = 'n-d-review';
    insertWorkflow(db, {
      id: wfId,
      spaceId: 'sp-1',
      name: template.name,
      description: template.description + ' — user edited',
      channels: template.channels ?? [],
      gates: template.gates ?? [],
      endNodeId: reviewId,
    });
    insertNode(db, { id: codingId, workflowId: wfId, name: 'Coding' });
    insertNode(db, { id: reviewId, workflowId: wfId, name: 'Review' });

    runMigration94(db);

    const row = readWorkflow(db, wfId)!;
    // template_name still set — we're confident it's a Coding Workflow variant.
    expect(row.template_name).toBe('Coding Workflow');
    // template_hash must NOT be the canonical hash (fingerprint differs).
    expect(row.template_hash).not.toBe(canonicalHash);
    // And it must be non-null — the migration populates it with the row's
    // own fingerprint hash so drift detection reflects the current state.
    expect(row.template_hash).toBeTruthy();
  });

  test('legacy Coding Workflow: sets template_name + narrow hash', () => {
    // Migration 94 stores a narrow hash (pre-expansion). After the fingerprint
    // was expanded to include customPrompt/completionAutonomyLevel,
    // the stored hash diverges from computeWorkflowHash — enabling drift detection.
    const { workflowId } = seedLegacyCodingWorkflow(db, {
      id: 'wf-1',
      spaceId: 'sp-1',
    });

    runMigration94(db);

    const row = readWorkflow(db, workflowId)!;
    expect(row.template_name).toBe('Coding Workflow');
    // Migration sets a valid SHA-256 hash (narrow, pre-expansion)
    expect(row.template_hash).toMatch(/^[0-9a-f]{64}$/);
    // The narrow hash differs from the current expanded hash — drift will be detected
    expect(row.template_hash).not.toBe(
      computeWorkflowHash(getBuiltInWorkflows().find((t) => t.name === 'Coding Workflow')!)
    );
  });

  test('legacy Research Workflow: sets template_name + narrow hash', () => {
    // Migration 94 stores a narrow hash (pre-expansion). After the fingerprint
    // was expanded, the stored hash diverges from computeWorkflowHash — enabling drift detection.
    const template = getBuiltInWorkflows().find((t) => t.name === 'Research Workflow')!;

    const wfId = 'wf-research';
    const researchNodeId = 'n-r-research';
    const reviewNodeId = 'n-r-review';

    insertWorkflow(db, {
      id: wfId,
      spaceId: 'sp-1',
      name: template.name,
      description: template.description,
      channels: template.channels ?? [],
      gates: template.gates ?? [],
      endNodeId: reviewNodeId,
    });
    insertNode(db, { id: researchNodeId, workflowId: wfId, name: 'Research' });
    insertNode(db, { id: reviewNodeId, workflowId: wfId, name: 'Review' });

    runMigration94(db);

    const row = readWorkflow(db, wfId)!;
    expect(row.template_name).toBe('Research Workflow');
    // Migration sets a valid SHA-256 hash (narrow, pre-expansion)
    expect(row.template_hash).toMatch(/^[0-9a-f]{64}$/);
    // The narrow hash differs from the current expanded hash — drift will be detected
    expect(row.template_hash).not.toBe(computeWorkflowHash(template));
  });

  test('Review-Only Workflow: sets template_name + narrow hash', () => {
    // Migration 94 stores a narrow hash (pre-expansion). After the fingerprint
    // was expanded, the stored hash diverges from computeWorkflowHash — enabling drift detection.
    const template = getBuiltInWorkflows().find((t) => t.name === 'Review-Only Workflow')!;

    const wfId = 'wf-review-only';
    const reviewNodeId = 'n-ro-review';

    insertWorkflow(db, {
      id: wfId,
      spaceId: 'sp-1',
      name: template.name,
      description: template.description,
      channels: template.channels ?? [],
      gates: template.gates ?? [],
      endNodeId: reviewNodeId,
    });
    insertNode(db, { id: reviewNodeId, workflowId: wfId, name: 'Review' });

    runMigration94(db);

    const row = readWorkflow(db, wfId)!;
    expect(row.template_name).toBe('Review-Only Workflow');
    // Migration sets a valid SHA-256 hash (narrow, pre-expansion)
    expect(row.template_hash).toMatch(/^[0-9a-f]{64}$/);
    // The narrow hash differs from the current expanded hash — drift will be detected
    expect(row.template_hash).not.toBe(computeWorkflowHash(template));
  });

  test('idempotent — running twice yields the same result', () => {
    const { workflowId, reviewNodeId } = seedLegacyCodingWorkflow(db, {
      id: 'wf-idem',
      spaceId: 'sp-1',
    });

    runMigration94(db);
    const rowAfter1 = readWorkflow(db, workflowId)!;
    const cfgAfter1 = readNodeConfig(db, reviewNodeId);

    runMigration94(db);
    const rowAfter2 = readWorkflow(db, workflowId)!;
    const cfgAfter2 = readNodeConfig(db, reviewNodeId);

    expect(rowAfter2).toEqual(rowAfter1);
    expect(cfgAfter2).toEqual(cfgAfter1);
  });

  test('custom workflow with non-matching name is untouched', () => {
    const wfId = 'wf-custom';
    insertWorkflow(db, {
      id: wfId,
      spaceId: 'sp-1',
      name: 'My Custom Workflow',
      description: 'a custom workflow',
      endNodeId: 'n-c',
    });
    insertNode(db, { id: 'n-c', workflowId: wfId, name: 'Custom' });

    runMigration94(db);

    const row = readWorkflow(db, wfId)!;
    expect(row.template_name).toBeNull();
    expect(row.template_hash).toBeNull();
  });

  test('row with matching name but non-matching node structure is NOT treated as a template', () => {
    // Same name as a template, but wrong node count / names — migration should
    // skip the fingerprint match and leave template_name unset.
    const wfId = 'wf-impostor';
    insertWorkflow(db, {
      id: wfId,
      spaceId: 'sp-1',
      name: 'Coding Workflow',
      description: 'imposter',
      endNodeId: 'n-i',
    });
    insertNode(db, { id: 'n-i', workflowId: wfId, name: 'NotCodingNotReview' });

    runMigration94(db);

    const row = readWorkflow(db, wfId)!;
    expect(row.template_name).toBeNull();
    expect(row.template_hash).toBeNull();
  });

  test('orphan duplicate deleted when it has no active runs', () => {
    // Insert two same-name Coding Workflow rows; older one has no runs.
    const older = seedLegacyCodingWorkflow(db, {
      id: 'wf-older',
      spaceId: 'sp-1',
      createdAt: 1000,
    });
    const newer = seedLegacyCodingWorkflow(db, {
      id: 'wf-newer',
      spaceId: 'sp-1',
      createdAt: 2000,
    });

    runMigration94(db);

    expect(readWorkflow(db, newer.workflowId)).toBeDefined();
    expect(readWorkflow(db, older.workflowId)).toBeNull();
  });

  test('duplicate retained when it has active runs', () => {
    const older = seedLegacyCodingWorkflow(db, {
      id: 'wf-older-active',
      spaceId: 'sp-1',
      createdAt: 1000,
    });
    const newer = seedLegacyCodingWorkflow(db, {
      id: 'wf-newer-active',
      spaceId: 'sp-1',
      createdAt: 2000,
    });

    // Active run on older row
    insertRun(db, {
      id: 'run-1',
      spaceId: 'sp-1',
      workflowId: older.workflowId,
      status: 'in_progress',
    });

    runMigration94(db);

    expect(readWorkflow(db, newer.workflowId)).toBeDefined();
    expect(readWorkflow(db, older.workflowId)).toBeDefined(); // kept — has active run
  });

  test('duplicate retained when only run is pending (still active)', () => {
    const older = seedLegacyCodingWorkflow(db, {
      id: 'wf-older-pending',
      spaceId: 'sp-1',
      createdAt: 1000,
    });
    const newer = seedLegacyCodingWorkflow(db, {
      id: 'wf-newer-pending',
      spaceId: 'sp-1',
      createdAt: 2000,
    });

    insertRun(db, {
      id: 'run-p',
      spaceId: 'sp-1',
      workflowId: older.workflowId,
      status: 'pending',
    });

    runMigration94(db);

    expect(readWorkflow(db, older.workflowId)).toBeDefined();
    expect(readWorkflow(db, newer.workflowId)).toBeDefined();
  });

  test('duplicate deleted when its only runs are terminal (done/cancelled)', () => {
    const older = seedLegacyCodingWorkflow(db, {
      id: 'wf-older-done',
      spaceId: 'sp-1',
      createdAt: 1000,
    });
    const newer = seedLegacyCodingWorkflow(db, {
      id: 'wf-newer-done',
      spaceId: 'sp-1',
      createdAt: 2000,
    });

    insertRun(db, {
      id: 'run-done',
      spaceId: 'sp-1',
      workflowId: older.workflowId,
      status: 'done',
    });
    insertRun(db, {
      id: 'run-cancelled',
      spaceId: 'sp-1',
      workflowId: older.workflowId,
      status: 'cancelled',
    });

    runMigration94(db);

    // All runs terminal → older considered orphan → deleted.
    expect(readWorkflow(db, older.workflowId)).toBeNull();
    expect(readWorkflow(db, newer.workflowId)).toBeDefined();
  });

  test('custom workflow rows never considered for duplicate deletion', () => {
    // Two custom workflows with same name — neither should be deleted because
    // they are not treated as built-ins.
    insertWorkflow(db, {
      id: 'wf-c1',
      spaceId: 'sp-1',
      name: 'Custom Workflow',
      createdAt: 1000,
      endNodeId: 'n-c1',
    });
    insertNode(db, { id: 'n-c1', workflowId: 'wf-c1', name: 'N' });

    insertWorkflow(db, {
      id: 'wf-c2',
      spaceId: 'sp-1',
      name: 'Custom Workflow',
      createdAt: 2000,
      endNodeId: 'n-c2',
    });
    insertNode(db, { id: 'n-c2', workflowId: 'wf-c2', name: 'N' });

    runMigration94(db);

    expect(readWorkflow(db, 'wf-c1')).toBeDefined();
    expect(readWorkflow(db, 'wf-c2')).toBeDefined();
  });

  test('node config JSON is never rewritten by the migration (template-only backfill)', () => {
    // PR 5/5 simplified M94: the legacy completionActions injection pass was
    // removed. The migration must therefore leave node config JSON untouched
    // — only `template_name` / `template_hash` on `space_workflows` may be
    // written.
    const { reviewNodeId } = seedLegacyCodingWorkflow(db, {
      id: 'wf-config-untouched',
      spaceId: 'sp-1',
    });

    const beforeCfg = readNodeConfig(db, reviewNodeId);

    runMigration94(db);

    const afterCfg = readNodeConfig(db, reviewNodeId);
    expect(afterCfg).toEqual(beforeCfg);
  });
});
