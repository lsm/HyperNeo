import type { Database as BunDatabase } from '../sqlite-compat';

export interface MigrationSpaceReclaimRequest {
  migrationKey: string;
}

export type MigrationSpaceReclaimResult =
  | { kind: 'not-pending' }
  | { kind: 'deferred' }
  | {
      kind: 'reclaimed';
      vacuumed: boolean;
      freelistBefore: number;
      reclaimedMigrations: number;
    };

export function findPendingMigrationSpaceReclaims(
  db: BunDatabase,
  migrationKeys: readonly string[]
): MigrationSpaceReclaimRequest[] {
  if (migrationKeys.length === 0) return [];

  const placeholders = migrationKeys.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT markers.key AS migrationKey
         FROM migration_markers markers
         LEFT JOIN migration_space_reclaims reclaims
           ON reclaims.migration_key = markers.key
        WHERE markers.key IN (${placeholders})
          AND reclaims.migration_key IS NULL
        ORDER BY markers.applied_at, markers.key`
    )
    .all(...migrationKeys) as MigrationSpaceReclaimRequest[];
}

export function reclaimPendingMigrationSpace(
  db: BunDatabase,
  requests: readonly MigrationSpaceReclaimRequest[]
): MigrationSpaceReclaimResult {
  if (requests.length === 0) return { kind: 'not-pending' };

  const freelistBefore = readFreelistCount(db);
  const vacuumed = freelistBefore > 0;
  if (vacuumed) db.exec('VACUUM main');

  const freelistAfter = readFreelistCount(db);
  if (freelistAfter !== 0) {
    throw new Error(`Migration space reclaim left ${freelistAfter} pages on the freelist`);
  }

  const checkpoint = db.prepare('PRAGMA main.wal_checkpoint(TRUNCATE)').get() as
    | { busy: number; log: number; checkpointed: number }
    | undefined;
  if (!checkpoint || checkpoint.busy !== 0 || checkpoint.checkpointed < checkpoint.log) {
    return { kind: 'deferred' };
  }

  const hasMarker = db.prepare(`SELECT 1 FROM migration_markers WHERE key = ?`);
  const recordReclaim = db.prepare(`
    INSERT INTO migration_space_reclaims (migration_key, reclaimed_at)
    VALUES (?, ?)
  `);
  const recordReclaims = db.transaction(() => {
    const reclaimedAt = Date.now();
    for (const request of requests) {
      if (!hasMarker.get(request.migrationKey)) {
        throw new Error(`Migration marker missing during space reclaim: ${request.migrationKey}`);
      }
      recordReclaim.run(request.migrationKey, reclaimedAt);
    }
  }, 'immediate');
  recordReclaims();

  return {
    kind: 'reclaimed',
    vacuumed,
    freelistBefore,
    reclaimedMigrations: requests.length,
  };
}

function readFreelistCount(db: BunDatabase): number {
  const row = db.prepare('PRAGMA main.freelist_count').get() as
    | { freelist_count: number }
    | undefined;
  if (!row || !Number.isInteger(row.freelist_count) || row.freelist_count < 0) {
    throw new Error('Failed to read the migration freelist count');
  }
  return row.freelist_count;
}
