import type { Database as BunDatabase } from '../storage/sqlite-compat.ts';
import { SHORT_ID_PREFIX, formatShortId } from '@hyperneo/shared';

export class ShortIdAllocator {
  constructor(private db: BunDatabase) {}

  allocate(entityType: 'task' | 'goal', scopeId: string): string {
    const prefix = entityType === 'task' ? SHORT_ID_PREFIX.TASK : SHORT_ID_PREFIX.GOAL;
    const row = this.db
      .prepare(
        `INSERT INTO short_id_counters (entity_type, scope_id, counter)
				 VALUES (?, ?, 1)
				 ON CONFLICT(entity_type, scope_id) DO UPDATE SET counter = counter + 1
				 RETURNING counter`
      )
      .get(entityType, scopeId) as { counter: number } | undefined;
    if (!row) {
      throw new Error(
        `short_id_counters row not found after upsert: entity_type=${entityType}, scope_id=${scopeId}`
      );
    }
    return formatShortId(prefix, row.counter);
  }

  getCounter(entityType: string, scopeId: string): number {
    const row = this.db
      .prepare(`SELECT counter FROM short_id_counters WHERE entity_type = ? AND scope_id = ?`)
      .get(entityType, scopeId) as { counter: number } | undefined;
    return row?.counter ?? 0;
  }
}
