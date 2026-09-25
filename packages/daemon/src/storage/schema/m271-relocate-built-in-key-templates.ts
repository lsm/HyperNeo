import { RELOCATED_FROM_LABEL_PREFIX } from '../../lib/agents/long-horizon-templates.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';

interface CollidingTemplate {
  space_id: string;
  key: string;
  labels: string | null;
}

function tableExists(db: BunDatabase, tableName: string): boolean {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName);
}

function tableHasColumn(db: BunDatabase, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${JSON.stringify(tableName)})`).all() as Array<{
    name: string;
  }>;
  return rows.some((row) => row.name === columnName);
}

function parseLabels(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((label): label is string => typeof label === 'string')
      : [];
  } catch {
    return [];
  }
}

function relocationTarget(
  db: BunDatabase,
  row: CollidingTemplate,
  builtInKeys: ReadonlySet<string>,
  hasVersionSeq: boolean
): string {
  const taken = (candidate: string): boolean =>
    builtInKeys.has(candidate) ||
    !!db
      .prepare(`SELECT 1 FROM space_agent_templates WHERE space_id = ? AND key = ?`)
      .get(row.space_id, candidate) ||
    (hasVersionSeq &&
      !!db
        .prepare(`SELECT 1 FROM space_agent_template_version_seq WHERE space_id = ? AND key = ?`)
        .get(row.space_id, candidate));
  let target = `${row.key}.migrated`;
  for (let suffix = 2; taken(target); suffix++) target = `${row.key}.migrated-${suffix}`;
  return target;
}

export function runMigration271(db: BunDatabase): void {
  relocateBuiltInKeyTemplates(db, ['task-manager.default']);
}

export function relocateBuiltInKeyTemplates(db: BunDatabase, keys: readonly string[]): void {
  if (!tableExists(db, 'space_agent_templates')) return;
  if (!tableHasColumn(db, 'space_agent_templates', 'space_id')) return;
  const builtInKeys = new Set(keys);
  if (builtInKeys.size === 0) return;
  const placeholders = [...builtInKeys].map(() => '?').join(', ');
  const colliding = db
    .prepare(
      `SELECT space_id, key, labels FROM space_agent_templates
        WHERE key IN (${placeholders}) ORDER BY space_id, key`
    )
    .all(...builtInKeys) as CollidingTemplate[];
  if (colliding.length === 0) return;
  const hasVersionSeq =
    tableExists(db, 'space_agent_template_version_seq') &&
    tableHasColumn(db, 'space_agent_template_version_seq', 'space_id');
  const relocateTemplate = db.prepare(
    `UPDATE space_agent_templates SET key = ?, labels = ?, updated_at = ?
      WHERE space_id = ? AND key = ?`
  );
  const relocateVersionSeq = hasVersionSeq
    ? db.prepare(
        `UPDATE space_agent_template_version_seq SET key = ? WHERE space_id = ? AND key = ?`
      )
    : null;
  const now = Date.now();
  db.exec('BEGIN');
  try {
    for (const row of colliding) {
      const target = relocationTarget(db, row, builtInKeys, hasVersionSeq);
      const marker = `${RELOCATED_FROM_LABEL_PREFIX}${row.key}`;
      const labels = parseLabels(row.labels);
      if (!labels.includes(marker)) labels.push(marker);
      relocateTemplate.run(target, JSON.stringify(labels), now, row.space_id, row.key);
      relocateVersionSeq?.run(target, row.space_id, row.key);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
