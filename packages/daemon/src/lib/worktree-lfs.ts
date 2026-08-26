import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const LFS_POINTER_SIGNATURE = 'version https://git-lfs.github.com/spec/v1';
const LFS_EXT_LINE_PATTERN = /^ext-(\d)-\w[\w.-]* sha256:[0-9a-f]{64}$/;
const LFS_PROBE_TIMEOUT_MS = 60_000;

export const GIT_PROBE_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

const LFS_CANDIDATE_MAX_BYTES = 65_536;

export const LFS_ATTR_PATHSPEC = ':(attr:filter=lfs)';

function scanExtensionRun(
  lines: string[],
  start: number,
  seenPriorities: Set<number>
): number | undefined {
  let index = start;
  while (index < lines.length) {
    const match = LFS_EXT_LINE_PATTERN.exec(lines[index]);
    if (!match) break;
    const priority = Number(match[1]);
    if (seenPriorities.has(priority)) return undefined;
    seenPriorities.add(priority);
    index++;
  }
  return index;
}

function isLfsPointerContent(content: string): boolean {
  const lines = content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => line !== '');
  const seenPriorities = new Set<number>();

  const beforeVersion = scanExtensionRun(lines, 0, seenPriorities);
  if (beforeVersion === undefined) return false;
  if (lines[beforeVersion] !== LFS_POINTER_SIGNATURE) return false;

  const afterHeadExtensions = scanExtensionRun(lines, beforeVersion + 1, seenPriorities);
  if (afterHeadExtensions === undefined) return false;
  if (!/^oid sha256:[0-9a-f]{64}$/.test(lines[afterHeadExtensions] ?? '')) return false;

  const beforeSize = scanExtensionRun(lines, afterHeadExtensions + 1, seenPriorities);
  if (beforeSize === undefined) return false;
  const sizeRecord = /^size \+?(\d+)\s*$/.exec(lines[beforeSize] ?? '');
  if (!sizeRecord) return false;
  const digits = sizeRecord[1].replace(/^0+(?=\d)/, '');
  if (digits.length > 19 || (digits.length === 19 && digits > '9223372036854775807')) {
    return false;
  }
  return beforeSize + 1 === lines.length;
}

function splitCandidatePaths(stdout: string | Buffer): string[] {
  const buf = typeof stdout === 'string' ? Buffer.from(stdout, 'utf8') : stdout;
  const paths: string[] = [];
  let start = 0;
  for (let index = 0; index <= buf.length; index++) {
    if (index !== buf.length && buf[index] !== 0) continue;
    if (index > start) {
      const segment = buf.subarray(start, index);
      const utf8 = segment.toString('utf8');
      paths.push(utf8);
      const raw = segment.toString('latin1');
      if (raw !== utf8) paths.push(raw);
    }
    start = index + 1;
  }
  return paths;
}

export async function indexContainsLfsPointer(
  cwd: string,
  env: Record<string, string>
): Promise<boolean> {
  let candidates: Buffer;
  try {
    const result = await execFileAsync(
      'git',
      ['grep', '-lz', '--cached', '-F', LFS_POINTER_SIGNATURE],
      {
        cwd,
        encoding: 'buffer',
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
  for (const rel of splitCandidatePaths(candidates)) {
    const spec = `:./${rel}`;
    try {
      const { stdout: sizeOut } = await execFileAsync('git', ['cat-file', '-s', spec], {
        cwd,
        encoding: 'utf8',
        timeout: LFS_PROBE_TIMEOUT_MS,
        env,
        maxBuffer: GIT_PROBE_MAX_BUFFER_BYTES,
      });
      if (Number(sizeOut.trim()) > LFS_CANDIDATE_MAX_BYTES) continue;
      const { stdout } = await execFileAsync('git', ['show', spec], {
        cwd,
        encoding: 'utf8',
        timeout: LFS_PROBE_TIMEOUT_MS,
        env,
        maxBuffer: GIT_PROBE_MAX_BUFFER_BYTES,
      });
      if (isLfsPointerContent(stdout)) return true;
    } catch {
      continue;
    }
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
