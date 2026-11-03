import type { Database as BunDatabase } from '../sqlite-compat.ts';

export interface SchemaExtension {
  id: string;
  tables(db: BunDatabase): void;
  indexes?(db: BunDatabase): void;
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
