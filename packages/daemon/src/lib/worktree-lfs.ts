import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const LFS_ATTRIBUTE_PATTERN = /filter\s*=\s*lfs/;

export async function worktreeDeclaresLfsAttributes(
  worktreePath: string,
  listFiles: () => Promise<string>
): Promise<boolean> {
  try {
    const files = (await listFiles())
      .split('\n')
      .map((entry) => entry.trim())
      .filter(Boolean);
    const attrFiles = files.filter(
      (entry) => entry === '.gitattributes' || entry.endsWith('/.gitattributes')
    );
    for (const rel of attrFiles) {
      try {
        const content = await readFile(join(worktreePath, rel), 'utf-8');
        if (LFS_ATTRIBUTE_PATTERN.test(content)) return true;
      } catch {}
    }
  } catch {}
  return false;
}
