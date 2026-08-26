import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const LFS_POINTER_SIGNATURE = 'version https://git-lfs.github.com/spec/v1';
const LFS_EXT_LINE_PATTERN = /^ext-(\d)-(\w\S*) sha256:[0-9a-f]{64}$/;
const LFS_OID_LINE_PATTERN = /^oid sha256:[0-9a-f]{64}$/;
const LFS_SIZE_LINE_PATTERN = /^size ([+-]?)(\d+)\s*$/;
const LFS_PROBE_TIMEOUT_MS = 60_000;
const LFS_MAX_LINE_CHARS = 1_048_576;

export const GIT_PROBE_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

export const LFS_ATTR_PATHSPEC = ':(attr:filter=lfs)';

interface PointerScanState {
  phase: 'head' | 'pre-oid' | 'post-oid' | 'done' | 'invalid';
  seenSignificant: boolean;
  pendingWhitespaceOnly: number;
  namesByPriority: Map<number, string>;
  current: string[];
  currentChars: number;
}

function createPointerScanState(): PointerScanState {
  return {
    phase: 'head',
    seenSignificant: false,
    pendingWhitespaceOnly: 0,
    namesByPriority: new Map(),
    current: [],
    currentChars: 0,
  };
}

function recordExtension(state: PointerScanState, line: string): boolean {
  const match = LFS_EXT_LINE_PATTERN.exec(line);
  if (!match) return false;
  const priority = Number(match[1]);
  const name = match[2];
  const knownName = state.namesByPriority.get(priority);
  if (knownName !== undefined) {
    if (knownName !== name) return false;
  } else {
    state.namesByPriority.set(priority, name);
  }
  return true;
}

function scanPointerLine(state: PointerScanState, rawLine: string): boolean {
  if (state.phase === 'invalid') return true;
  if (rawLine === '') return false;
  if (rawLine.trim() === '') {
    if (!state.seenSignificant) return false;
    state.pendingWhitespaceOnly++;
    return false;
  }
  if (state.pendingWhitespaceOnly > 0) {
    state.phase = 'invalid';
    return true;
  }
  state.seenSignificant = true;
  if (state.phase === 'head') {
    const stripped = rawLine.replace(/^\s+/, '');
    if (stripped === LFS_POINTER_SIGNATURE) {
      state.phase = 'pre-oid';
      return false;
    }
    if (!recordExtension(state, stripped)) {
      state.phase = 'invalid';
      return true;
    }
    return false;
  }
  if (state.phase === 'pre-oid') {
    if (recordExtension(state, rawLine)) return false;
    if (LFS_OID_LINE_PATTERN.test(rawLine)) {
      state.phase = 'post-oid';
      return false;
    }
    state.phase = 'invalid';
    return true;
  }
  if (state.phase === 'post-oid') {
    if (recordExtension(state, rawLine)) return false;
    const sizeMatch = LFS_SIZE_LINE_PATTERN.exec(rawLine);
    if (!sizeMatch) {
      state.phase = 'invalid';
      return true;
    }
    const digits = sizeMatch[2].replace(/^0+(?=\d)/, '');
    if (digits.length > 19 || (digits.length === 19 && digits > '9223372036854775807')) {
      state.phase = 'invalid';
      return true;
    }
    if (sizeMatch[1] === '-' && digits !== '0') {
      state.phase = 'invalid';
      return true;
    }
    state.phase = 'done';
    return false;
  }
  state.phase = 'invalid';
  return true;
}

function feedPointerChunk(state: PointerScanState, chunk: Buffer): void {
  if (state.phase === 'invalid') return;
  let start = 0;
  for (let index = 0; index < chunk.length; index++) {
    if (chunk[index] !== 10) continue;
    state.current.push(chunk.subarray(start, index).toString('utf8'));
    const line = state.current.join('');
    state.current = [];
    state.currentChars = 0;
    const invalid = scanPointerLine(state, line.endsWith('\r') ? line.slice(0, -1) : line);
    if (invalid) return;
    start = index + 1;
  }
  const remainder = chunk.subarray(start).toString('utf8');
  if (remainder.length > 0) {
    state.current.push(remainder);
    state.currentChars += remainder.length;
    if (state.currentChars > LFS_MAX_LINE_CHARS) {
      state.phase = 'invalid';
    }
  }
}

function finishPointerScan(state: PointerScanState): boolean {
  if (state.current.length > 0) {
    const line = state.current.join('');
    state.current = [];
    scanPointerLine(state, line.endsWith('\r') ? line.slice(0, -1) : line);
  }
  return state.phase === 'done';
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

function validateBlobStream(
  cwd: string,
  env: Record<string, string>,
  oid: string
): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const child = spawn('git', ['cat-file', '-p', oid], { cwd, env });
    const state = createPointerScanState();
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, LFS_PROBE_TIMEOUT_MS);
    const settle = (value: boolean) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolvePromise(value);
      }
    };
    child.on('error', () => settle(false));
    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled || state.phase === 'invalid') return;
      feedPointerChunk(state, chunk);
    });
    child.on('close', (code) => {
      if (code !== 0 || state.phase === 'invalid') {
        settle(false);
        return;
      }
      settle(finishPointerScan(state));
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
      if (await validateBlobStream(cwd, env, oid)) return true;
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
