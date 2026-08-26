import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const LFS_POINTER_SIGNATURE = 'version https://git-lfs.github.com/spec/v1';
const LFS_EXT_LINE_PATTERN = /^ext-(\d)-(\w\S*) sha256:[0-9a-f]{64}$/;
const LFS_PROBE_TIMEOUT_MS = 60_000;

export const GIT_PROBE_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

const LFS_CANDIDATE_MAX_BYTES = 65_536;

export const LFS_ATTR_PATHSPEC = ':(attr:filter=lfs)';

function stripLeadingWhitespace(line: string): string {
  return line.replace(/^\s+/, '');
}

function scanExtensionRun(
  lines: string[],
  start: number,
  namesByPriority: Map<number, string>,
  stripLeading: boolean
): number | undefined {
  let index = start;
  while (index < lines.length) {
    const candidate = stripLeading ? stripLeadingWhitespace(lines[index]) : lines[index];
    const match = LFS_EXT_LINE_PATTERN.exec(candidate);
    if (!match) break;
    const priority = Number(match[1]);
    const name = match[2];
    const knownName = namesByPriority.get(priority);
    if (knownName !== undefined) {
      if (knownName !== name) return undefined;
    } else {
      namesByPriority.set(priority, name);
    }
    index++;
  }
  return index;
}

function isLfsPointerContent(content: string): boolean {
  const allLines = content.replace(/\r\n/g, '\n').split('\n');
  let start = 0;
  while (start < allLines.length && allLines[start].trim() === '') start++;
  let end = allLines.length;
  while (end > start && allLines[end - 1].trim() === '') end--;
  const lines = allLines.slice(start, end).filter((line) => line !== '');
  if (lines.length === 0) return false;
  const namesByPriority = new Map<number, string>();

  const beforeVersion = scanExtensionRun(lines, 0, namesByPriority, true);
  if (beforeVersion === undefined) return false;
  if (stripLeadingWhitespace(lines[beforeVersion] ?? '') !== LFS_POINTER_SIGNATURE) return false;

  const afterHeadExtensions = scanExtensionRun(lines, beforeVersion + 1, namesByPriority, false);
  if (afterHeadExtensions === undefined) return false;
  if (!/^oid sha256:[0-9a-f]{64}$/.test(lines[afterHeadExtensions] ?? '')) return false;

  const beforeSize = scanExtensionRun(lines, afterHeadExtensions + 1, namesByPriority, false);
  if (beforeSize === undefined) return false;
  const sizeRecord = /^size ([+-]?)(\d+)\s*$/.exec(lines[beforeSize] ?? '');
  if (!sizeRecord) return false;
  const digits = sizeRecord[2].replace(/^0+(?=\d)/, '');
  if (digits.length > 19 || (digits.length === 19 && digits > '9223372036854775807')) {
    return false;
  }
  if (sizeRecord[1] === '-' && digits !== '0') return false;
  return beforeSize + 1 === lines.length;
}

function nulSeparatedSegments(stdout: string | Buffer): Buffer[] {
  const buf = typeof stdout === 'string' ? Buffer.from(stdout, 'utf8') : stdout;
  const segments: Buffer[] = [];
  let start = 0;
  for (let index = 0; index <= buf.length; index++) {
    if (index !== buf.length && buf[index] !== 0) continue;
    if (index > start) segments.push(buf.subarray(start, index));
    start = index + 1;
  }
  return segments;
}

function parseIndexRecord(
  record: Buffer,
  candidateKeys: Set<string>,
  oidsByPath: Map<string, string[]>
): void {
  const tab = record.indexOf(9);
  if (tab <= 0) return;
  const oid = record.subarray(0, tab).toString('utf8').split(' ')[1];
  if (!oid) return;
  const pathKey = record.subarray(tab + 1).toString('latin1');
  if (!candidateKeys.has(pathKey)) return;
  const existing = oidsByPath.get(pathKey);
  if (existing) existing.push(oid);
  else oidsByPath.set(pathKey, [oid]);
}

function resolveCandidateOids(
  cwd: string,
  env: Record<string, string>,
  candidateKeys: Set<string>
): Promise<Map<string, string[]>> {
  const oidsByPath: Map<string, string[]> = new Map();
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', ['ls-files', '-z', '-s'], { cwd, env });
    let pending = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, LFS_PROBE_TIMEOUT_MS);
    const settleOnce = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
      }
    };
    const fail = (error: Error) => {
      const alreadySettled = settled;
      settleOnce();
      if (!alreadySettled) rejectPromise(error);
    };
    const finish = () => {
      const alreadySettled = settled;
      settleOnce();
      if (!alreadySettled) resolvePromise(oidsByPath);
    };
    child.on('error', fail);
    child.stdout?.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      let nul = pending.indexOf(0);
      while (nul !== -1) {
        parseIndexRecord(pending.subarray(0, nul), candidateKeys, oidsByPath);
        pending = pending.subarray(nul + 1);
        nul = pending.indexOf(0);
      }
    });
    child.on('close', (code) => {
      if (code === 0) {
        parseIndexRecord(pending, candidateKeys, oidsByPath);
        finish();
      } else {
        fail(new Error(`git ls-files exited with code ${code ?? 'signal'}`));
      }
    });
  });
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
  const candidateKeys = new Set<string>();
  for (const segment of nulSeparatedSegments(candidates)) {
    candidateKeys.add(segment.toString('latin1'));
  }
  const oidsByPath = await resolveCandidateOids(cwd, env, candidateKeys);
  for (const key of candidateKeys) {
    const oids = [...new Set(oidsByPath.get(key) ?? [])];
    for (const oid of oids) {
      try {
        const { stdout: sizeOut } = await execFileAsync('git', ['cat-file', '-s', oid], {
          cwd,
          encoding: 'utf8',
          timeout: LFS_PROBE_TIMEOUT_MS,
          env,
          maxBuffer: GIT_PROBE_MAX_BUFFER_BYTES,
        });
        if (Number(sizeOut.trim()) > LFS_CANDIDATE_MAX_BYTES) continue;
        const { stdout } = await execFileAsync('git', ['show', oid], {
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
