/**
 * Data directory resolution.
 *
 * HyperNeo stores all of its on-disk state (database, skills, SDK cache, auth
 * store, worktrees, …) under a single data directory: `~/.hyperneo`.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export const DATA_DIR_NAME = '.hyperneo';

/**
 * Absolute path of the HyperNeo data directory for a given home.
 * Pure — performs no I/O.
 */
export function resolveDataDir(home: string = homedir()): string {
  return join(home, DATA_DIR_NAME);
}

/**
 * Absolute path of the HyperNeo data directory (`~/.hyperneo`).
 */
export function getDataDir(): string {
  return resolveDataDir();
}
