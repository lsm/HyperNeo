/**
 * Data directory resolution + one-time legacy migration.
 *
 * HyperNeo stores all of its on-disk state (database, skills, SDK cache, auth
 * store, worktrees, …) under a single data directory: `~/.hyperneo`.
 *
 * Pre-rebrand installs used `~/.neokai`. To keep existing data reachable
 * without a destructive copy, the first access to {@link getDataDir} migrates
 * by creating a symlink `~/.hyperneo → ~/.neokai` when the new directory is
 * absent but the legacy one exists. The symlink is safe (no data movement),
 * instant, reversible, and preserves active worktrees that may live under the
 * legacy path.
 *
 * If the symlink cannot be created (e.g. Windows accounts without symlink
 * privileges, or a restricted home filesystem), {@link getDataDir} falls back to
 * the legacy `~/.neokai` path so existing data stays reachable instead of
 * silently starting fresh under an empty `~/.hyperneo`. The migration is
 * idempotent and skipped under `NODE_ENV=test`.
 */

import { existsSync, lstatSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DATA_DIR_NAME = '.hyperneo';
export const LEGACY_DATA_DIR_NAME = '.neokai';

/**
 * Absolute path of the HyperNeo data directory for a given home.
 * Pure — performs no migration. Use {@link getDataDir} from application code.
 */
export function resolveDataDir(home: string = homedir()): string {
  return join(home, DATA_DIR_NAME);
}

/**
 * Absolute path of the legacy (`~/.neokai`) data directory for a given home.
 */
export function resolveLegacyDataDir(home: string = homedir()): string {
  return join(home, LEGACY_DATA_DIR_NAME);
}

export type DataDirMigrationStrategy = 'symlink' | 'legacy-fallback' | 'none';

export interface DataDirMigrationResult {
  migrated: boolean;
  /**
   * `symlink`: new path linked to legacy data.
   * `legacy-fallback`: symlink failed and legacy data exists — callers should
   *   keep using the legacy path.
   * `none`: nothing to do (new path already exists, or no legacy path).
   */
  strategy: DataDirMigrationStrategy;
  /** Legacy path (set when strategy is `symlink` or `legacy-fallback`). */
  legacyPath?: string;
  /** New data directory path (set when strategy is `symlink`). */
  dataPath?: string;
}

function pathEntryExists(path: string): boolean {
  // lstat (not existsSync) so a dangling symlink still counts as "exists" and
  // we never clobber a pre-existing entry of any kind.
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Migrate the legacy `~/.neokai` data directory to `~/.hyperneo` by creating a
 * symlink. Idempotent: no-op when the new path already exists or the legacy
 * path is absent. Never throws — on symlink failure it returns a
 * `legacy-fallback` result so the caller can keep using `~/.neokai`.
 *
 * Pure with respect to the real home when `home` is provided, so it is testable
 * against a temporary HOME without touching the host. `symlink` is injectable
 * for tests; `log` is invoked at most once when migration is attempted.
 */
export function migrateLegacyDataDir(
  options: {
    home?: string;
    log?: (message: string) => void;
    symlink?: (target: string, path: string) => void;
  } = {}
): DataDirMigrationResult {
  const home = options.home ?? homedir();
  const log = options.log ?? (() => {});
  const symlink = options.symlink ?? symlinkSync;
  const dataPath = resolveDataDir(home);
  const legacyPath = resolveLegacyDataDir(home);

  if (pathEntryExists(dataPath)) {
    return { migrated: false, strategy: 'none' };
  }
  if (!existsSync(legacyPath)) {
    return { migrated: false, strategy: 'none' };
  }

  try {
    // symlink(target, path): `path` is the link location, `target` is what it
    // points to. We want ~/.hyperneo (link) → ~/.neokai (real legacy data).
    symlink(legacyPath, dataPath);
    log(`[HyperNeo] Migrated data directory: linked ${dataPath} → ${legacyPath}`);
    return { migrated: true, strategy: 'symlink', legacyPath, dataPath };
  } catch (error) {
    // Symlink unavailable (e.g. Windows without symlink privileges). Keep using
    // the legacy path so existing data/db/skills stay reachable.
    log(
      `[HyperNeo] Data directory symlink failed; using legacy path ${legacyPath}: ${(error as Error).message}`
    );
    return { migrated: false, strategy: 'legacy-fallback', legacyPath, dataPath };
  }
}

let migrationEnsured = false;
// When migration cannot link ~/.hyperneo → ~/.neokai but legacy data exists,
// the effective data directory is the legacy path instead of the new one.
let effectiveDataDir: string | undefined;

/**
 * Run the legacy migration exactly once for the real home (unless
 * `NODE_ENV=test`, where it is skipped so unit tests never mutate the host).
 * Uses stderr directly because the structured-log capture is installed later.
 */
function ensureDataDirMigrated(): void {
  if (migrationEnsured) return;
  migrationEnsured = true;
  if (process.env.NODE_ENV === 'test') return;
  const result = migrateLegacyDataDir({
    log: (message) => process.stderr.write(`${message}\n`),
  });
  if (result.strategy === 'legacy-fallback' && result.legacyPath) {
    effectiveDataDir = result.legacyPath;
  }
}

/**
 * Absolute path of the HyperNeo data directory (`~/.hyperneo`, or `~/.neokai`
 * when a symlink migration failed but legacy data exists).
 *
 * On the first call (outside tests) this ensures the legacy `~/.neokai` →
 * `~/.hyperneo` migration has run, so every caller — regardless of import
 * order — sees a path whose backing data is reachable. Subsequent calls are a
 * cheap memoized return.
 */
export function getDataDir(): string {
  ensureDataDirMigrated();
  return effectiveDataDir ?? resolveDataDir();
}
