import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const LFS_POINTER_SIGNATURE = 'version https://git-lfs.github.com/spec/v1';
const LFS_EXT_LINE_PATTERN = /^ext-(\d)-\S+ sha256:[0-9a-f]{64}$/;
const LFS_PROBE_TIMEOUT_MS = 60_000;

export const GIT_PROBE_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

export const LFS_ATTR_PATHSPEC = ':(attr:filter=lfs)';

function lfsExtensionPriority(line: string): number | undefined {
  const match = LFS_EXT_LINE_PATTERN.exec(line);
  if (!match) return undefined;
  return Number(match[1]);
}

function isLfsPointerContent(content: string): boolean {
  const lines = content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => line.trim() !== '');
  if (lines[0] !== LFS_POINTER_SIGNATURE) return false;
  const seenPriorities = new Set<number>();
  let index = 1;
  while (index < lines.length) {
    const priority = lfsExtensionPriority(lines[index]);
    if (priority === undefined) break;
    if (seenPriorities.has(priority)) return false;
    seenPriorities.add(priority);
    index++;
  }
  if (!/^oid sha256:[0-9a-f]{64}$/.test(lines[index] ?? '')) return false;
  if (!/^size \+?\d+\s*$/.test(lines[index + 1] ?? '')) return false;
  return index + 2 === lines.length;
}

export async function indexContainsLfsPointer(
  cwd: string,
  env: Record<string, string>
): Promise<boolean> {
  let candidates: string;
  try {
    const result = await execFileAsync(
      'git',
      ['grep', '-lz', '--cached', '-F', LFS_POINTER_SIGNATURE],
      {
        cwd,
        encoding: 'utf8',
        timeout: LFS_PROBE_TIMEOUT_MS,
        env,
        maxBuffer: GIT_PROBE_MAX_BUFFER_BYTES,
      }
    );
    candidates = result.stdout;
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 1) return false;
    throw err;
  }
  for (const rel of candidates.split('\0').filter(Boolean)) {
    const { stdout } = await execFileAsync('git', ['show', `:${rel}`], {
      cwd,
      encoding: 'utf8',
      timeout: LFS_PROBE_TIMEOUT_MS,
      env,
      maxBuffer: GIT_PROBE_MAX_BUFFER_BYTES,
    });
    if (isLfsPointerContent(stdout)) return true;
  }
  return false;
}

export async function worktreeDeclaresLfsAttributes(
  listLfsTrackedFiles: () => Promise<string>,
  hasPointerBlob?: () => Promise<boolean>
): Promise<boolean> {
  const lfsTracked = (await listLfsTrackedFiles()).split('\0').filter(Boolean);
  if (lfsTracked.length > 0) return true;
  if (hasPointerBlob) return hasPointerBlob();
  return false;
}
