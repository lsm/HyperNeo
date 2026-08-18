import type { Database as BunDatabase } from '../sqlite-compat';
import { generateUUID } from '@hyperneo/shared';
import { getPresetAgentTemplates } from '../../lib/space/agents/seed-agents';
import { computeAgentTemplateHash } from '../../lib/space/agents/agent-template-hash';
import { Logger } from '../../lib/logger';

const log = new Logger('migration-170');

interface SpaceRow {
  id: string;
}

interface AgentNameHandleRow {
  name: string;
  handle: string | null;
}

function tableExists(db: BunDatabase, tableName: string): boolean {
  const result = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName);
  return !!result;
}

export function runMigration170(db: BunDatabase): void {
  if (!tableExists(db, 'spaces')) return;
  if (!tableExists(db, 'space_agents')) return;

  const presets = getPresetAgentTemplates();
  if (presets.length === 0) return;

  const spaces = db.prepare(`SELECT id FROM spaces`).all() as SpaceRow[];
  if (spaces.length === 0) return;

  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO space_agents (
       id, space_id, name, handle, status, description, model, thinking_level, provider,
       tools, custom_prompt, setting_sources, template_name, template_hash, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  let totalInserted = 0;
  const perSpaceLog: string[] = [];

  for (const space of spaces) {
    const existing = db
      .prepare(`SELECT name, handle FROM space_agents WHERE space_id = ?`)
      .all(space.id) as AgentNameHandleRow[];
    const existingNames = new Set<string>();
    const existingHandles = new Set<string>();
    for (const row of existing) {
      existingNames.add((row.name ?? '').trim().toLowerCase());
      if (row.handle) existingHandles.add(row.handle);
    }

    const insertedNames: string[] = [];
    for (const preset of presets) {
      const lowerName = preset.name.trim().toLowerCase();
      if (existingNames.has(lowerName)) continue;
      if (preset.handle && existingHandles.has(preset.handle)) {
        log.warn(
          `[backfill] Skipped preset "${preset.name}" in space ${space.id}: ` +
            `handle "${preset.handle}" is already in use by another agent.`
        );
        continue;
      }

      insert.run(
        generateUUID(),
        space.id,
        preset.name,
        preset.handle,
        'active',
        preset.description,
        null,
        preset.thinkingLevel ?? null,
        null,
        JSON.stringify(preset.tools),
        preset.customPrompt,
        null,
        preset.name,
        computeAgentTemplateHash(preset),
        now,
        now
      );

      existingNames.add(lowerName);
      if (preset.handle) existingHandles.add(preset.handle);
      insertedNames.push(preset.name);
      totalInserted++;
    }

    if (insertedNames.length > 0) {
      perSpaceLog.push(`space ${space.id}: ${insertedNames.join(', ')}`);
    }
  }

  if (totalInserted > 0) {
    log.info(
      `[backfill] Inserted ${totalInserted} missing preset agent row(s) across ` +
        `${perSpaceLog.length} space(s).`
    );
    for (const line of perSpaceLog) {
      log.info(`[backfill] ${line}`);
    }
  }
}
