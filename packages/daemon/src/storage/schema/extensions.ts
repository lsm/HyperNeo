import type { PromptProvenanceInit } from '../../lib/agent/agent-session.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';

export interface SchemaExtension {
  id: string;
  tables(db: BunDatabase): void;
  indexes?(db: BunDatabase): void;
  baseline?: { statements: readonly string[]; presentWhenTable: string };
  baselineEffect?(db: BunDatabase): void;
  migrations?: Readonly<Record<string, (db: BunDatabase) => void>>;
  sessionSkillVetoes?(db: BunDatabase, provenance: PromptProvenanceInit): string[];
  workspaceSources?(db: BunDatabase): { path: string; label: string }[];
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
  for (const extension of schemaExtensions.values()) {
    const { id, baseline } = extension;
    const key = `schema_baseline_${id}`;
    if ((!baseline && !extension.baselineEffect) || markers.applied(key)) continue;
    const present = baseline ? schemaTableExists(db, baseline.presentWhenTable) : false;
    db.transaction(() => {
      if (!present) {
        for (const sql of baseline?.statements ?? []) db.exec(sql);
        extension.baselineEffect?.(db);
      }
      markers.mark(key);
    })();
  }
}
