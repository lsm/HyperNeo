import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

const LFS_ATTRIBUTE_PATTERN = /filter\s*=\s*lfs/;
const LFS_POINTER_SIGNATURE = 'version https://git-lfs.github.com/spec/v1';
const LFS_PROBE_TIMEOUT_MS = 60_000;

export async function indexContainsLfsPointer(
  cwd: string,
  env: Record<string, string>
): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['grep', '-l', '--cached', '-F', LFS_POINTER_SIGNATURE],
      { cwd, encoding: 'utf8', timeout: LFS_PROBE_TIMEOUT_MS, env }
    );
    return stdout.trim().length > 0;
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 1) return false;
    throw err;
  }
}

export async function worktreeDeclaresLfsAttributes(
  worktreePath: string,
  listFiles: () => Promise<string>,
  hasPointerBlob?: () => Promise<boolean>
): Promise<boolean> {
  const files = (await listFiles())
    .split('\0')
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
  if (hasPointerBlob) return hasPointerBlob();
  return false;
}
