import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../sqlite-compat.ts';

type DatabaseVersion = { empty: boolean; version: number | null };
type SupportedVersion = { supported: true };
type UnsupportedVersion = { version: number | null };

function readDatabaseVersion(db: Database): DatabaseVersion {
  const objects = db
    .prepare(`SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'`)
    .all() as { name: string }[];
  if (objects.length === 0) return { empty: true, version: null };

  const markers = objects.some(({ name }) => name === 'migration_markers')
    ? (db.prepare('SELECT key FROM migration_markers').all() as { key: string }[])
    : [];
  const version = markers.reduce<number | null>((highest, { key }) => {
    const match = /^migration_(\d+)$/.exec(key);
    const number = match ? Number(match[1]) : NaN;
    return Number.isSafeInteger(number) ? Math.max(highest ?? 0, number) : highest;
  }, null);
  return { empty: false, version };
}

function gateSupportedVersion({
  empty,
  version,
}: DatabaseVersion): { value: SupportedVersion } | { reason: UnsupportedVersion } {
  return empty || (version !== null && version >= 238)
    ? { value: { supported: true } }
    : { reason: { version } };
}

const inspectDatabaseVersion = (superpipe({})('database-upgrade-floor') as PipelineAPI)
  .input(['db'])
  .pipe(readDatabaseVersion, 'db', 'version')
  .pipe(gateSupportedVersion, 'version', 'result:admission')
  .end('admission') as (db: Database) => SupportedVersion | UnsupportedVersion;

export function assertSupportedDatabaseVersion(db: Database): void {
  const admission = inspectDatabaseVersion(db);
  if ('supported' in admission) return;
  const description =
    admission.version === null
      ? 'unknown (no numbered migration markers)'
      : String(admission.version);
  throw new Error(
    `Database migration version ${description} is older than the supported v0.41.0 baseline ` +
      '(migration 238). Upgrade this database through v0.41.0–v0.44.x first before starting this daemon.'
  );
}
