import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import type { TableChangeScope } from '../../storage/reactive-database.ts';

export interface NamedQuery {
  expandRows?: (
    rows: Record<string, unknown>[],
    params: ReadonlyArray<unknown>,
    db: BunDatabase
  ) => Record<string, unknown>[];
  sql: string;
  paramCount: number;
  debounceMs?: number;
  mapRow?: (row: Record<string, unknown>) => Record<string, unknown>;
  mapResult?: (
    rawRows: Record<string, unknown>[],
    params: ReadonlyArray<unknown>
  ) => Record<string, unknown> | undefined;
  buildScopeFilter?: (
    params: ReadonlyArray<unknown>,
    db: BunDatabase
  ) => ((scope: TableChangeScope) => boolean) | undefined;
  metadataScopeFilter?: (scope: TableChangeScope) => boolean;
  rowFingerprint?: (row: Record<string, unknown>) => unknown;
}
