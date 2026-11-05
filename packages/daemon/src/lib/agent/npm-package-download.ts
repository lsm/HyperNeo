import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

// oxlint-disable-next-line no-console
const logWarn = console.warn;

const gunzipAsync = promisify(gunzip);
const TAR_BLOCK_SIZE = 512;
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const NETWORK_CURL_CODES = new Set([5, 6, 7, 18, 28, 35, 52, 55, 56]);
const DISK_CURL_CODE = 23;
const RANGE_NOT_SUPPORTED_CURL_CODE = 33;
const HTTP_ERROR_CURL_CODE = 22;
const STALL_SECONDS = 120;
const CURL_PATIENCE = [
  '--connect-timeout',
  '30',
  '--speed-limit',
  '1',
  '--speed-time',
  String(STALL_SECONDS),
];

export const PACKAGE_DOWNLOAD_WAIT_MS = 45_000;

type CurlFailure = { code?: number | string; stderr: string };

type TarEntry = { path: string; mode: number; data: Buffer };

export function isMusl(): boolean {
  if (process.platform !== 'linux') return false;
  for (const libDir of ['/lib', '/lib64']) {
    try {
      const files = readdirSync(libDir);
      if (files.some((f) => f.startsWith('ld-musl'))) return true;
    } catch {}
  }
  return false;
}

function registryUrl(): string {
  return (process.env.npm_config_registry || DEFAULT_REGISTRY).replace(/\/$/, '');
}

function registryHost(): string {
  return new URL(registryUrl()).hostname;
}

export function describeCurlFailure(failure: CurlFailure, host: string): string {
  const detail = failure.stderr.trim();
  if (failure.code === 'ENOENT') return 'curl is not installed or not on PATH';
  if (failure.code === DISK_CURL_CODE) return `disk full or not writable: ${detail}`;
  if (failure.code === 6) return `cannot reach npm (ENOTFOUND ${host}): ${detail}`;
  if (failure.code === 7) return `cannot reach npm (ECONNREFUSED ${host}:443): ${detail}`;
  if (typeof failure.code === 'number' && NETWORK_CURL_CODES.has(failure.code))
    return `cannot reach npm (ETIMEDOUT ${host}:443): ${detail}`;
  return `npm request failed: ${detail || `curl exited with ${failure.code}`}`;
}

export function describeWriteFailure(err: unknown): string {
  const { code, message } = err as NodeJS.ErrnoException;
  return code === 'ENOSPC' ? `disk full: ${message}` : message;
}

export function mustRestartDownload(failure: CurlFailure): boolean {
  return (
    failure.code === RANGE_NOT_SUPPORTED_CURL_CODE ||
    (failure.code === HTTP_ERROR_CURL_CODE && /\b416\b/.test(failure.stderr))
  );
}

function curl(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'curl',
      ['-sS', ...CURL_PATIENCE, ...args],
      { encoding: 'utf-8' },
      (err, stdout, stderr) =>
        err
          ? reject({ code: (err as { code?: number | string }).code, stderr } as CurlFailure)
          : resolve(String(stdout))
    );
  });
}

async function sha512OfFile(filePath: string): Promise<string> {
  const hash = createHash('sha512');
  const data = await readFile(filePath);
  hash.update(data);
  return `sha512-${hash.digest('base64')}`;
}

async function fetchNpmPackageMeta(
  packageName: string,
  version: string
): Promise<{ tarballUrl: string; integrity: string }> {
  const url = `${registryUrl()}/${encodeURIComponent(packageName)}/${version}`;
  const meta = JSON.parse((await curl(['-f', url])).trim());
  const tarballUrl = meta?.dist?.tarball;
  const integrity = meta?.dist?.integrity;
  if (tarballUrl && integrity) return { tarballUrl, integrity };
  throw new Error(`npm metadata for ${packageName}@${version} has no tarball`);
}

async function resumeTarball(url: string, destPath: string): Promise<void> {
  const download = () => curl(['-fL', '-C', '-', '-o', destPath, url]);
  await download().catch(async (failure: CurlFailure) => {
    if (!mustRestartDownload(failure)) throw failure;
    rmSync(destPath, { force: true });
    await download();
  });
}

async function fetchVerifiedTarball(
  packageName: string,
  version: string,
  destPath: string
): Promise<void> {
  const meta = await fetchNpmPackageMeta(packageName, version);
  if (existsSync(destPath) && (await sha512OfFile(destPath)) === meta.integrity) return;
  await resumeTarball(meta.tarballUrl, destPath);
  const actualIntegrity = await sha512OfFile(destPath);
  if (actualIntegrity === meta.integrity) return;
  rmSync(destPath, { force: true });
  throw new Error(
    `integrity mismatch for ${packageName}@${version}: expected ${meta.integrity}, got ${actualIntegrity}`
  );
}

export async function downloadVerifiedTarball(
  packageName: string,
  version: string,
  destPath: string
): Promise<void> {
  try {
    mkdirSync(dirname(destPath), { recursive: true });
    await fetchVerifiedTarball(packageName, version, destPath);
  } catch (err) {
    const reason =
      err instanceof Error
        ? describeWriteFailure(err)
        : describeCurlFailure(err as CurlFailure, registryHost());
    logWarn(`[npm-package-download] ${packageName}@${version}: ${reason}`);
    throw new Error(reason, { cause: err });
  }
}

export function waitForDownload<T>(download: Promise<T>, waitMs: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    download,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${name} is still downloading (ETIMEDOUT ${registryHost()}:443)`)),
        waitMs
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function* tarFiles(archive: Buffer): Generator<TarEntry> {
  let offset = 0;
  while (offset + TAR_BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((b: number) => b === 0)) return;

    // oxlint-disable-next-line no-control-regex -- tar headers use NUL-padding; \x00 is intentional
    const stripNul = (s: string) => s.replace(/\x00/g, '');
    const field = (start: number, end: number) =>
      stripNul(header.subarray(start, end).toString('utf-8'));
    const name = field(0, 100);
    const prefix = field(345, 500);
    const sizeOctal = field(124, 136).trim();
    const size = sizeOctal ? parseInt(sizeOctal, 8) : 0;
    const typeFlag = header.subarray(156, 157).toString('utf-8');
    const dataStart = offset + TAR_BLOCK_SIZE;

    if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '') {
      yield {
        path: (prefix ? `${prefix}/${name}` : name).replace(/^package\//, ''),
        mode: parseInt(field(100, 108).trim() || '644', 8) & 0o777,
        data: archive.subarray(dataStart, dataStart + size),
      };
    }
    offset = dataStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }
}

export async function extractFileFromTarGz(
  tarballPath: string,
  targetFileName: string,
  destPath: string
): Promise<void> {
  const archive = await gunzipAsync(await readFile(tarballPath));
  for (const entry of tarFiles(archive)) {
    if (entry.path === targetFileName && entry.data.length > 0) {
      await writeFile(destPath, entry.data);
      return;
    }
  }
  throw new Error(`File "${targetFileName}" not found in tarball`);
}

export function isSafeTarPath(path: string): boolean {
  return !path.startsWith('/') && !path.split(/[\\/]/).some((part) => part === '..');
}

export async function extractPackageFromTarGz(tarballPath: string, destDir: string): Promise<void> {
  const archive = await gunzipAsync(await readFile(tarballPath));
  const entries = [...tarFiles(archive)];
  if (!entries.every((entry) => isSafeTarPath(entry.path)))
    throw new Error(`Refusing tarball with an unsafe path: ${tarballPath}`);
  for (const entry of entries) {
    const destPath = join(destDir, entry.path);
    await mkdir(dirname(destPath), { recursive: true });
    await writeFile(destPath, entry.data, { mode: entry.mode });
  }
}
