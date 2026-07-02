/**
 * Utility for syncing built-in skill files to ~/.neokai/skills/.
 *
 * Used by the dev server to copy skill files from the packages/skills/ source
 * directory to ~/.neokai/skills/ on startup. Existing files are never overwritten
 * so that user customizations are preserved.
 *
 * The prod (compiled binary) server uses a different path — it reads from Bun's
 * embedded VFS via embeddedBuiltinSkills — but the destination directory and the
 * no-overwrite policy are the same.
 */

import { readdir, readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createLogger } from '@neokai/shared';

const log = createLogger('hyperneo:cli:skill-utils');

/**
 * Recursively copy all files under `sourceDir` to `destDir`, preserving the
 * relative path structure. Files that already exist at the destination are
 * skipped to preserve any user edits.
 *
 * Silently returns if `sourceDir` does not exist (e.g. when running outside
 * the NeoKai monorepo).
 */
export async function syncBuiltinSkillsFromDir(
  sourceDir: string,
  destDir: string
): Promise<number> {
  let count = 0;
  await syncDir(sourceDir, destDir, '', () => {
    count++;
  });
  return count;
}

async function syncDir(
  srcBase: string,
  destBase: string,
  rel: string,
  onWrite: () => void
): Promise<void> {
  const srcDir = rel ? join(srcBase, rel) : srcBase;
  let entries;
  try {
    entries = await readdir(srcDir, { withFileTypes: true });
  } catch {
    // Source directory does not exist — skip silently
    return;
  }

  for (const entry of entries) {
    const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await syncDir(srcBase, destBase, entryRel, onWrite);
    } else if (entry.isFile()) {
      const dest = join(destBase, entryRel);
      const exists = await access(dest)
        .then(() => true)
        .catch(() => false);
      if (!exists) {
        await mkdir(dirname(dest), { recursive: true });
        const content = await readFile(join(srcBase, entryRel));
        await writeFile(dest, content);
        onWrite();
      }
    }
  }
}

/**
 * Ensure built-in skill files are present at `destDir` by copying from `sourceDir`.
 * Logs the result. Errors are caught and logged (never thrown) so that a missing
 * skills source directory never blocks server startup.
 */
export async function ensureBuiltinSkills(sourceDir: string, destDir: string): Promise<void> {
  try {
    const count = await syncBuiltinSkillsFromDir(sourceDir, destDir);
    if (count > 0) {
      log.info(`Synced ${count} built-in skill file(s) from ${sourceDir} to ${destDir}`);
    }
  } catch (err) {
    log.warn(`Failed to sync built-in skills from ${sourceDir}: ${err}`);
  }
}
