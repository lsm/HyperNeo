import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import superpipe, { type PipelineAPI } from 'superpipe';

export interface BinaryIdentity {
  version: string;
  sha256: string;
}

export type BinaryCheck =
  | { ok: true }
  | { ok: false; reason: 'version_mismatch' | 'sha256_mismatch' };

export function decideBinaryCheck(expected: BinaryIdentity, actual: BinaryIdentity): BinaryCheck {
  if (expected.sha256.toLowerCase() !== actual.sha256.toLowerCase()) {
    return { ok: false, reason: 'sha256_mismatch' };
  }
  if (expected.version !== actual.version) return { ok: false, reason: 'version_mismatch' };
  return { ok: true };
}

async function readDigest(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('OAP binary path must be absolute');
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function readVersion(
  path: string,
  expected: BinaryIdentity,
  sha256: string
): Promise<string> {
  if (sha256.toLowerCase() !== expected.sha256.toLowerCase()) return '';
  const { stdout } = await promisify(execFile)(path, ['--version'], { timeout: 5000, env: {} });
  return stdout.trim();
}

function checkIdentity(expected: BinaryIdentity, sha256: string, version: string): BinaryCheck {
  return decideBinaryCheck(expected, { sha256, version });
}

const checkSnapshot = (superpipe({})('check-oap-binary') as PipelineAPI)
  .input(['path', 'expected'])
  .pipe(readDigest, 'path', 'sha256')
  .pipe(readVersion, ['path', 'expected', 'sha256'], 'version')
  .pipe(checkIdentity, ['expected', 'sha256', 'version'], 'result')
  .endAsync('result') as (path: string, expected: BinaryIdentity) => Promise<BinaryCheck>;

export type PreparedOapBinary =
  | { ok: true; path: string; cleanup(): Promise<void> }
  | Extract<BinaryCheck, { ok: false }>;

export async function prepareOapBinary(
  path: string,
  expected: BinaryIdentity,
  stateDirectory: string
): Promise<PreparedOapBinary> {
  if (!isAbsolute(path)) throw new Error('OAP binary path must be absolute');
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(stateDirectory, 'oap-verified-'));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    const verifiedPath = join(directory, basename(path));
    await copyFile(path, verifiedPath, constants.COPYFILE_EXCL);
    await chmod(verifiedPath, 0o500);
    const check = await checkSnapshot(verifiedPath, expected);
    if (!check.ok) {
      await cleanup();
      return check;
    }
    return { ok: true, path: verifiedPath, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function checkOapBinary(path: string, expected: BinaryIdentity): Promise<BinaryCheck> {
  const binary = await prepareOapBinary(path, expected, tmpdir());
  if (!binary.ok) return binary;
  await binary.cleanup();
  return { ok: true };
}
