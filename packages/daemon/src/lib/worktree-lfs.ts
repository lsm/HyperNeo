import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const LFS_ATTRIBUTE_PATTERN = /filter\s*=\s*lfs/;

export async function worktreeDeclaresLfsAttributes(
  worktreePath: string,
  listFiles: () => Promise<string>
): Promise<boolean> {
  const files = (await listFiles())
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const attrFiles = files.filter(
    (entry) => entry === '.gitattributes' || entry.endsWith('/.gitattributes')
  );
  for (const rel of attrFiles) {
    const content = await readFile(join(worktreePath, rel), 'utf-8');
    const activeAttributes = content
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    if (LFS_ATTRIBUTE_PATTERN.test(activeAttributes)) return true;
  }
  return false;
}
