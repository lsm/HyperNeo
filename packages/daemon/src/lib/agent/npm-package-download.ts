import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

const isVerbose = process.env.HYPERNEO_VERBOSE;
// oxlint-disable-next-line no-console
const logWarn = isVerbose ? console.warn : () => {};

const gunzipAsync = promisify(gunzip);
const TAR_BLOCK_SIZE = 512;

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

function curl(args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('curl', args, { encoding: 'utf-8', timeout }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout))
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
): Promise<{ tarballUrl: string; integrity: string } | undefined> {
  const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${version}`;
  try {
    const result = (await curl(['-sf', url], 15_000)).trim();
    const meta = JSON.parse(result);
    const tarballUrl = meta?.dist?.tarball;
    const integrity = meta?.dist?.integrity;
    if (tarballUrl && integrity) return { tarballUrl, integrity };
    logWarn(
      `[npm-package-download] npm registry metadata missing dist.tarball for ${packageName}@${version}`
    );
    return undefined;
  } catch (err) {
    logWarn(
      `[npm-package-download] Could not fetch npm metadata for ${packageName}@${version}: ${err}`
    );
    return undefined;
  }
}

async function downloadTarball(url: string, destPath: string): Promise<boolean> {
  try {
    await curl(['-sfL', '-o', destPath, url], 120_000);
    if (existsSync(destPath)) return true;
    logWarn(`[npm-package-download] Download succeeded but file missing: ${destPath}`);
    return false;
  } catch (err) {
    logWarn(`[npm-package-download] Download failed for ${url}: ${err}`);
    return false;
  }
}

export async function downloadVerifiedTarball(
  packageName: string,
  version: string,
  destPath: string
): Promise<boolean> {
  const meta = await fetchNpmPackageMeta(packageName, version);
  if (!meta || !(await downloadTarball(meta.tarballUrl, destPath))) return false;
  const actualIntegrity = await sha512OfFile(destPath);
  if (actualIntegrity === meta.integrity) return true;
  logWarn(
    `[npm-package-download] Integrity mismatch for ${packageName}@${version}: expected ${meta.integrity}, got ${actualIntegrity}`
  );
  return false;
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
): Promise<string | undefined> {
  try {
    const archive = await gunzipAsync(await readFile(tarballPath));
    for (const entry of tarFiles(archive)) {
      if (entry.path === targetFileName && entry.data.length > 0) {
        await writeFile(destPath, entry.data);
        return destPath;
      }
    }
    logWarn(`[npm-package-download] File "${targetFileName}" not found in tarball`);
    return undefined;
  } catch (err) {
    logWarn(`[npm-package-download] Tar extraction failed: ${err}`);
    return undefined;
  }
}

export function isSafeTarPath(path: string): boolean {
  return !path.startsWith('/') && !path.split(/[\\/]/).some((part) => part === '..');
}

export async function extractPackageFromTarGz(
  tarballPath: string,
  destDir: string
): Promise<boolean> {
  try {
    const archive = await gunzipAsync(await readFile(tarballPath));
    const entries = [...tarFiles(archive)];
    if (!entries.every((entry) => isSafeTarPath(entry.path))) {
      logWarn(`[npm-package-download] Refusing tarball with an unsafe path: ${tarballPath}`);
      return false;
    }
    for (const entry of entries) {
      const destPath = join(destDir, entry.path);
      await mkdir(dirname(destPath), { recursive: true });
      await writeFile(destPath, entry.data, { mode: entry.mode });
    }
    return entries.length > 0;
  } catch (err) {
    logWarn(`[npm-package-download] Tar extraction failed: ${err}`);
    return false;
  }
}
