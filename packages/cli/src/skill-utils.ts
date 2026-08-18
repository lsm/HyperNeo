import { readdir, readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createLogger } from '@hyperneo/shared';

const log = createLogger('hyperneo:cli:skill-utils');

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
