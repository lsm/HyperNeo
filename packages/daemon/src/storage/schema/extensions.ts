import type { PromptProvenanceInit } from '../../lib/agent/agent-session.ts';
import type { NamedQuery } from '../../lib/live-query/types.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';

export interface SchemaExtension {
  id: string;
  tables(db: BunDatabase): void;
  indexes?(db: BunDatabase): void;
  baseline?: { statements: readonly string[]; presentWhenTable: string };
  migrations?: Readonly<Record<string, (db: BunDatabase) => void>>;
  sessionSkillVetoes?(db: BunDatabase, provenance: PromptProvenanceInit): string[];
  workspaceSources?(db: BunDatabase): { path: string; label: string }[];
  liveQueries?: Record<string, NamedQuery>;
}

const schemaExtensions = new Map<string, SchemaExtension>();

export function registerSchemaExtension(extension: SchemaExtension): void {
  schemaExtensions.set(extension.id, extension);
}

export function createExtensionTables(db: BunDatabase): void {
  for (const extension of schemaExtensions.values()) extension.tables(db);
}

export function createExtensionIndexes(db: BunDatabase): void {
  for (const extension of schemaExtensions.values()) extension.indexes?.(db);
}

export function extensionMigration(key: string): ((db: BunDatabase) => void) | undefined {
  for (const extension of schemaExtensions.values()) {
    const migration = extension.migrations?.[key];
    if (migration) return migration;
  }
  return undefined;
}

export function extensionSessionSkillVetoes(
  db: BunDatabase,
  provenance: PromptProvenanceInit
): string[] {
  return [...schemaExtensions.values()].flatMap(
    (extension) => extension.sessionSkillVetoes?.(db, provenance) ?? []
  );
}

export function extensionWorkspaceSources(db: BunDatabase): { path: string; label: string }[] {
  return [...schemaExtensions.values()].flatMap(
    (extension) => extension.workspaceSources?.(db) ?? []
  );
}

export function extensionLiveQueries(): Record<string, NamedQuery> {
  return Object.assign(
    {},
    ...[...schemaExtensions.values()].map((extension) => extension.liveQueries ?? {})
  );
}

export function isSpaceEnabled(): boolean {
  return process.env.HYPERNEO_SPACE === 'on';
}

export function schemaTableExists(db: BunDatabase, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table);
}

export function applyExtensionBaselines(
  db: BunDatabase,
  markers: { baselineDone: boolean; applied(key: string): boolean; mark(key: string): void }
): void {
  if (!markers.baselineDone) return;
  for (const { id, baseline } of schemaExtensions.values()) {
    const key = `schema_baseline_${id}`;
    if (!baseline || markers.applied(key)) continue;
    const present = schemaTableExists(db, baseline.presentWhenTable);
    db.transaction(() => {
      if (!present) for (const sql of baseline.statements) db.exec(sql);
      markers.mark(key);
    })();
  }
}
