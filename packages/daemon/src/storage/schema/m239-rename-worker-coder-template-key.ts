import type { SpaceWorkflow } from '@hyperneo/shared';
import {
  computeDefinitionVersion,
  verifyDefinitionVersion,
} from '../../lib/space/workflows/definition-version.ts';
import { SpaceWorkflowDefinitionVersionRepository } from '../repositories/space-workflow-definition-version-repository.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';

const OLD_TEMPLATE_KEY = 'worker.coder';
const NEW_TEMPLATE_KEY = 'worker.swe';

interface NodeRow {
  id: string;
  workflow_id: string;
  config: string | null;
}

interface WorkflowRow {
  id: string;
  space_id: string;
}

interface RunRow {
  id: string;
  workflow_id: string;
  definition_version: string | null;
}

function tableExists(db: BunDatabase, tableName: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName);
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function rewriteSlotTemplateKey(slot: Record<string, unknown>): boolean {
  if (typeof slot.templateKey !== 'string') return false;
  if (slot.templateKey.trim() !== OLD_TEMPLATE_KEY) return false;
  slot.templateKey = NEW_TEMPLATE_KEY;
  return true;
}

function rewriteRecordAgentSlots(record: Record<string, unknown>): boolean {
  if (!Array.isArray(record.agents)) return false;
  let dirty = false;
  for (const raw of record.agents) {
    const slot = asRecord(raw);
    if (slot && rewriteSlotTemplateKey(slot)) dirty = true;
  }
  return dirty;
}

function renameLiveNodeTemplateKeys(db: BunDatabase, now: number): void {
  const nodes = db
    .prepare(`SELECT id, workflow_id, config FROM space_workflow_nodes ORDER BY rowid ASC`)
    .all() as NodeRow[];
  const updateNode = db.prepare(
    `UPDATE space_workflow_nodes SET config = ?, updated_at = ? WHERE id = ?`
  );
  for (const node of nodes) {
    const parsed = asRecord(parseJson(node.config));
    if (!parsed) continue;
    if (!rewriteRecordAgentSlots(parsed)) continue;
    updateNode.run(JSON.stringify(parsed), now, node.id);
  }
}

function renamePinnedRunDefinitionTemplateKeys(db: BunDatabase, now: number): void {
  if (!tableExists(db, 'space_workflow_runs')) return;
  if (!tableExists(db, 'space_workflow_definition_versions')) return;

  const versionRepo = new SpaceWorkflowDefinitionVersionRepository(db);
  const workflowSpace = db
    .prepare(`SELECT id, space_id FROM space_workflows`)
    .all() as WorkflowRow[];
  const spaceByWorkflow = new Map(workflowSpace.map((wf) => [wf.id, wf.space_id]));

  const runs = db
    .prepare(
      `SELECT id, workflow_id, definition_version FROM space_workflow_runs
        WHERE definition_version IS NOT NULL ORDER BY rowid ASC`
    )
    .all() as RunRow[];
  if (runs.length === 0) return;

  const repointRun = db.prepare(
    `UPDATE space_workflow_runs SET definition_version = ?, updated_at = ? WHERE id = ?`
  );

  for (const run of runs) {
    const spaceId = spaceByWorkflow.get(run.workflow_id);
    const definitionVersion = run.definition_version;
    if (!spaceId || !definitionVersion) continue;
    const version = versionRepo.getVersion(run.workflow_id, definitionVersion);
    if (!version) continue;
    if (!verifyDefinitionVersion(version.payload, definitionVersion)) continue;
    const workflow = asRecord(parseJson(version.payload));
    if (!workflow || !Array.isArray(workflow.nodes)) continue;

    let dirty = false;
    for (const rawNode of workflow.nodes) {
      const node = asRecord(rawNode);
      if (node && rewriteRecordAgentSlots(node)) dirty = true;
    }
    if (!dirty) continue;

    const { versionHash, payload: rewrittenPayload } = computeDefinitionVersion(
      workflow as unknown as SpaceWorkflow
    );
    versionRepo.appendVersion({
      workflowId: run.workflow_id,
      spaceId,
      versionHash,
      payload: rewrittenPayload,
      source: 'backfill',
      createdAt: now,
    });
    repointRun.run(versionHash, now, run.id);
  }
}

function renameAgentRowTemplateKeys(db: BunDatabase, now: number): void {
  if (!tableExists(db, 'space_long_horizon_agents')) return;
  db.prepare(
    `UPDATE space_long_horizon_agents SET template_key = ?, updated_at = ? WHERE template_key = ?`
  ).run(NEW_TEMPLATE_KEY, now, OLD_TEMPLATE_KEY);
}

export function runMigration239(db: BunDatabase): void {
  if (!tableExists(db, 'space_workflow_nodes')) return;
  const now = Date.now();
  db.exec('BEGIN');
  try {
    renameLiveNodeTemplateKeys(db, now);
    renamePinnedRunDefinitionTemplateKeys(db, now);
    renameAgentRowTemplateKeys(db, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
