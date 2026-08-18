import type { Database as BunDatabase } from '../sqlite-compat';
import { createHash } from 'node:crypto';

const KNOWN_PRESET_NAMES = ['Coder', 'General', 'Planner', 'Research', 'Reviewer', 'QA'] as const;

interface AgentFingerprintInput {
  name: string;
  description: string;
  tools: string[];
  customPrompt: string;
}

function buildAgentFingerprint(input: AgentFingerprintInput): {
  name: string;
  description: string;
  tools: string[];
  customPrompt: string;
} {
  return {
    name: (input.name ?? '').trim().toLowerCase(),
    description: input.description ?? '',
    tools: [...(input.tools ?? [])].sort(),
    customPrompt: input.customPrompt ?? '',
  };
}

function hashAgentFingerprint(input: AgentFingerprintInput): string {
  const fp = buildAgentFingerprint(input);
  const json = JSON.stringify(fp);
  return createHash('sha256').update(json).digest('hex');
}

interface AgentRow {
  id: string;
  name: string;
  description: string | null;
  tools: string | null;
  custom_prompt: string | null;
  template_name: string | null;
  template_hash: string | null;
}

function tableExists(db: BunDatabase, tableName: string): boolean {
  const result = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName);
  return !!result;
}

function tableHasColumn(db: BunDatabase, tableName: string, columnName: string): boolean {
  const result = db
    .prepare(`SELECT name FROM pragma_table_info('${tableName}') WHERE name = ?`)
    .get(columnName);
  return !!result;
}

function parseTools(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed.filter((t) => typeof t === 'string') as string[]) : [];
  } catch {
    return [];
  }
}

export function runMigration106(db: BunDatabase): void {
  if (!tableExists(db, 'space_agents')) return;
  if (!tableHasColumn(db, 'space_agents', 'template_name')) return;
  if (!tableHasColumn(db, 'space_agents', 'template_hash')) return;

  const presetByLowerName = new Map<string, string>(
    KNOWN_PRESET_NAMES.map((n) => [n.toLowerCase(), n])
  );

  const rows = db
    .prepare(
      `SELECT id, name, description, tools, custom_prompt, template_name, template_hash
			   FROM space_agents
			  WHERE template_name IS NULL`
    )
    .all() as AgentRow[];

  if (rows.length === 0) return;

  const update = db.prepare(
    `UPDATE space_agents SET template_name = ?, template_hash = ? WHERE id = ?`
  );

  for (const row of rows) {
    const normalized = (row.name ?? '').trim().toLowerCase();
    const canonicalName = presetByLowerName.get(normalized);
    if (!canonicalName) continue;

    const hash = hashAgentFingerprint({
      name: canonicalName,
      description: row.description ?? '',
      tools: parseTools(row.tools),
      customPrompt: row.custom_prompt ?? '',
    });

    update.run(canonicalName, hash, row.id);
  }
}
