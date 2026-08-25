import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const LFS_POINTER_SIGNATURE = 'version https://git-lfs.github.com/spec/v1';
const LFS_PROBE_TIMEOUT_MS = 60_000;

export const GIT_PROBE_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

export const LFS_ATTR_PATHSPEC = ':(attr:filter=lfs)';

function isLfsPointerContent(content: string): boolean {
  const lines = content.split('\n');
  if (lines[0] !== LFS_POINTER_SIGNATURE) return false;
  if (!/^oid sha256:[0-9a-f]{64}$/.test(lines[1] ?? '')) return false;
  if (!/^size \d+$/.test(lines[2] ?? '')) return false;
  return lines.length <= 4 && (lines[3] === undefined || lines[3] === '');
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
