import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { getDataDir } from '../data-dir';

const isVerbose = process.env.HYPERNEO_VERBOSE;
// oxlint-disable-next-line no-console
const logWarn = isVerbose ? console.warn : () => {};

// oxlint-disable-next-line no-console
const logStartup = (...args: unknown[]) => console.log(...args);

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

const SDK_CACHE_DIR = join(getDataDir(), 'sdk');

function isMusl(): boolean {
  if (process.platform !== 'linux') return false;
  for (const libDir of ['/lib', '/lib64']) {
    try {
      const files = readdirSync(libDir);
      if (files.some((f) => f.startsWith('ld-musl'))) return true;
    } catch {
      // Directory doesn't exist or isn't readable
    }
  }
  return false;
}

/**
 * Platform suffix for the SDK's native CLI binary package.
 * Follows the naming convention: `@anthropic-ai/claude-agent-sdk-{os}-{arch}[-musl]`
 * @public Exported for use by build scripts.
 */
export function getPlatformPackageName(): string | undefined {
  const { platform, arch } = process;
  if (platform === 'win32' && arch === 'x64') return `${SDK_PACKAGE}-win32-x64`;
  if (platform === 'win32' && arch === 'arm64') return `${SDK_PACKAGE}-win32-arm64`;
  if (platform === 'darwin' && arch === 'x64') return `${SDK_PACKAGE}-darwin-x64`;
  if (platform === 'darwin' && arch === 'arm64') return `${SDK_PACKAGE}-darwin-arm64`;
  if (platform === 'linux' && arch === 'x64')
    return isMusl() ? `${SDK_PACKAGE}-linux-x64-musl` : `${SDK_PACKAGE}-linux-x64`;
  if (platform === 'linux' && arch === 'arm64')
    return isMusl() ? `${SDK_PACKAGE}-linux-arm64-musl` : `${SDK_PACKAGE}-linux-arm64`;
  return undefined;
}

/**
 * Native CLI binary name (platform-dependent).
 * @public Exported for use by build scripts.
 */
export function getCliBinaryName(): string {
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

export function isBundledBinary(): boolean {
  return import.meta.url.includes('/$bunfs/root/');
}

export function isRunningUnderBun(): boolean {
  return typeof globalThis.Bun !== 'undefined';
}

let cachedCliPath: string | undefined;

function getSdkVersion(): string {
  try {
    const daemonPkgPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'package.json'
    );
    const pkg = JSON.parse(readFileSync(daemonPkgPath, 'utf-8'));
    const dep = pkg.dependencies?.[SDK_PACKAGE];
    if (dep) return dep.replace(/^(workspace:|npm:|\^|~)/, '');
  } catch {
    // Fallback for compiled binary where relative paths differ
  }

  try {
    const resolved = import.meta.resolve?.(SDK_PACKAGE);
    if (resolved) {
      const sdkPath = resolved.startsWith('file://') ? fileURLToPath(resolved) : resolved;
      const sdkPkgPath = join(dirname(sdkPath), 'package.json');
      const sdkPkg = JSON.parse(readFileSync(sdkPkgPath, 'utf-8'));
      if (sdkPkg.version) return sdkPkg.version;
    }
  } catch {
    // SDK package.json not accessible
  }

  return '0.3.233';
}

function getCachePath(): string {
  const platformPkg = getPlatformPackageName();
  if (!platformPkg) return '';
  const version = getSdkVersion();
  const platformPart = platformPkg.replace(`${SDK_PACKAGE}-`, '');
  const binaryName = getCliBinaryName();
  return join(SDK_CACHE_DIR, `claude-${version}-${platformPart}`, binaryName);
}

function resolveFromNodeModules(): string | undefined {
  const binaryName = getCliBinaryName();
  const platformPkg = getPlatformPackageName();

  if (platformPkg) {
    try {
      const resolved = import.meta.resolve?.(platformPkg);
      if (resolved) {
        const pkgPath = resolved.startsWith('file://') ? fileURLToPath(resolved) : resolved;
        const binPath = join(dirname(pkgPath), binaryName);
        if (existsSync(binPath)) return binPath;
      }
    } catch {
      // import.meta.resolve might not be available or package not installed
    }
  }

  if (platformPkg) {
    try {
      const sdkModulePath = import.meta.resolve?.(SDK_PACKAGE);
      if (sdkModulePath) {
        const sdkPath = sdkModulePath.startsWith('file://')
          ? fileURLToPath(sdkModulePath)
          : sdkModulePath;
        const bunDir = dirname(dirname(dirname(dirname(dirname(sdkPath)))));
        const hoistedPath = join(bunDir, 'node_modules', platformPkg, binaryName);
        if (existsSync(hoistedPath)) return hoistedPath;
      }
    } catch {
      // import.meta.resolve might not be available
    }
  }

  if (platformPkg) {
    try {
      let currentDir = dirname(fileURLToPath(import.meta.url));
      for (let i = 0; i < 10; i++) {
        const candidate = join(currentDir, 'node_modules', platformPkg, binaryName);
        if (existsSync(candidate)) return candidate;
        const parentDir = dirname(currentDir);
        if (parentDir === currentDir) break;
        currentDir = parentDir;
      }
    } catch {
      // fileURLToPath might fail for virtual paths
    }
  }

  try {
    const sdkModulePath = import.meta.resolve?.(SDK_PACKAGE);
    if (sdkModulePath) {
      const sdkPath = sdkModulePath.startsWith('file://')
        ? fileURLToPath(sdkModulePath)
        : sdkModulePath;
      const cliPath = join(dirname(sdkPath), 'cli.js');
      if (existsSync(cliPath)) return cliPath;
    }
  } catch {
    // import.meta.resolve might not be available
  }

  try {
    let currentDir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 10; i++) {
      const candidate = join(currentDir, 'node_modules', SDK_PACKAGE, 'cli.js');
      if (existsSync(candidate)) return candidate;
      const parentDir = dirname(currentDir);
      if (parentDir === currentDir) break;
      currentDir = parentDir;
    }
  } catch {
    // fileURLToPath might fail for virtual paths
  }

  return undefined;
}

function resolveFromCache(): string | undefined {
  const cachePath = getCachePath();
  if (cachePath && existsSync(cachePath)) {
    try {
      const stat = lstatSync(cachePath);
      if (stat.isFile() && stat.size > 0) return cachePath;
      logWarn(
        `[sdk-cli-resolver] Cached binary exists but is invalid (size=${stat.size}), re-downloading`
      );
    } catch (err) {
      logWarn(`[sdk-cli-resolver] Cannot stat cached binary: ${err}`);
    }
  }
  return undefined;
}

function sha512OfFile(filePath: string): string {
  const hash = createHash('sha512');
  const data = readFileSync(filePath);
  hash.update(data);
  return `sha512-${hash.digest('base64')}`;
}

function fetchNpmPackageMeta(
  packageName: string,
  version: string
): { tarballUrl: string; integrity: string } | undefined {
  const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${version}`;
  try {
    const result = execFileSync('curl', ['-sf', url], {
      encoding: 'utf-8',
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const meta = JSON.parse(result);
    const tarballUrl = meta?.dist?.tarball;
    const integrity = meta?.dist?.integrity;
    if (tarballUrl && integrity) return { tarballUrl, integrity };
    logWarn(
      `[sdk-cli-resolver] npm registry metadata missing dist.tarball for ${packageName}@${version}`
    );
    return undefined;
  } catch (err) {
    logWarn(
      `[sdk-cli-resolver] Could not fetch npm metadata for ${packageName}@${version}: ${err}`
    );
    return undefined;
  }
}

function downloadTarball(url: string, destPath: string): string | undefined {
  try {
    execFileSync('curl', ['-sfL', '-o', destPath, url], {
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (existsSync(destPath)) return destPath;
    logWarn(`[sdk-cli-resolver] Download succeeded but file missing: ${destPath}`);
    return undefined;
  } catch (err) {
    logWarn(`[sdk-cli-resolver] Download failed for ${url}: ${err}`);
    return undefined;
  }
}

function extractFileFromTarGz(
  tarballPath: string,
  targetFileName: string,
  destPath: string
): string | undefined {
  try {
    const compressed = readFileSync(tarballPath);
    const gunzipped = gunzipSync(compressed);

    const TAR_HEADER_SIZE = 512;
    let offset = 0;

    while (offset + TAR_HEADER_SIZE <= gunzipped.length) {
      const header = gunzipped.subarray(offset, offset + TAR_HEADER_SIZE);

      if (header.every((b: number) => b === 0)) break;

      // oxlint-disable-next-line no-control-regex -- tar headers use NUL-padding; \x00 is intentional
      const stripNul = (s: string) => s.replace(/\x00/g, '');
      const name = stripNul(header.subarray(0, 100).toString('utf-8'));
      const sizeOctal = stripNul(header.subarray(124, 136).toString('utf-8')).trim();
      const typeFlag = header.subarray(156, 157).toString('utf-8');
      const prefix = stripNul(header.subarray(345, 500).toString('utf-8'));

      const fullName = prefix ? `${prefix}${name}` : name;
      const fileSize = sizeOctal ? parseInt(sizeOctal, 8) : 0;
      const dataBlocks = Math.ceil(fileSize / TAR_HEADER_SIZE);

      const isRegularFile = typeFlag === '0' || typeFlag === '\0' || typeFlag === '';
      const baseName = fullName.replace(/^package\//, '');

      if (isRegularFile && baseName === targetFileName && fileSize > 0) {
        const fileData = gunzipped.subarray(
          offset + TAR_HEADER_SIZE,
          offset + TAR_HEADER_SIZE + fileSize
        );
        writeFileSync(destPath, fileData);
        return destPath;
      }

      offset += TAR_HEADER_SIZE + dataBlocks * TAR_HEADER_SIZE;
    }

    logWarn(`[sdk-cli-resolver] File "${targetFileName}" not found in tarball`);
    return undefined;
  } catch (err) {
    logWarn(`[sdk-cli-resolver] Tar extraction failed: ${err}`);
    return undefined;
  }
}

function safeMoveFile(src: string, dest: string): void {
  try {
    renameSync(src, dest);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EXDEV' || code === 'EPERM') {
      copyFileSync(src, dest);
      try {
        unlinkSync(src);
      } catch {
        // Non-critical — source in tmpdir will be cleaned up
      }
    } else {
      throw err;
    }
  }
}

function downloadSdkBinary(): string | undefined {
  const platformPkg = getPlatformPackageName();
  if (!platformPkg) return undefined;

  const version = getSdkVersion();
  const cachePath = getCachePath();
  if (!cachePath) return undefined;

  const binaryName = getCliBinaryName();
  const cacheDir = dirname(cachePath);

  let tmpDir: string | undefined;
  try {
    tmpDir = join(tmpdir(), `hyperneo-sdk-download-${process.pid}-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    const meta = fetchNpmPackageMeta(platformPkg, version);
    if (!meta) return undefined;

    const tarballPath = join(tmpDir, `${platformPkg.replace(/\//g, '_')}-${version}.tgz`);
    const downloaded = downloadTarball(meta.tarballUrl, tarballPath);
    if (!downloaded) return undefined;

    const actualIntegrity = sha512OfFile(tarballPath);
    if (actualIntegrity !== meta.integrity) {
      logWarn(
        `[sdk-cli-resolver] Integrity mismatch for ${platformPkg}@${version}: expected ${meta.integrity}, got ${actualIntegrity}`
      );
      return undefined;
    }

    const extractedPath = join(tmpDir, binaryName);
    const extracted = extractFileFromTarGz(tarballPath, binaryName, extractedPath);
    if (!extracted) return undefined;

    mkdirSync(cacheDir, { recursive: true });
    safeMoveFile(extracted, cachePath);
    chmodSync(cachePath, 0o755);

    copySystemRipgrepToVendor(cacheDir);

    return cachePath;
  } catch (err) {
    logWarn(`[sdk-cli-resolver] Unexpected error downloading SDK binary: ${err}`);
    return undefined;
  } finally {
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true });
      } catch {
        // Non-critical — temp dir will be cleaned by OS
      }
    }
  }
}

function getSdkVendorPlatform(): string | undefined {
  const { platform, arch } = process;
  if (platform === 'win32') return undefined;
  const os = platform === 'darwin' ? 'darwin' : 'linux';
  const cpu = arch === 'arm64' ? 'arm64' : 'x64';
  return `${cpu}-${os}`;
}

const SYSTEM_RIPGREP_PATHS = [
  '/usr/bin/rg',
  '/usr/local/bin/rg',
  '/opt/homebrew/bin/rg',
  '/opt/homebrew/opt/ripgrep/bin/rg',
];

function findSystemRipgrep(): string | undefined {
  for (const p of SYSTEM_RIPGREP_PATHS) {
    if (existsSync(p)) return p;
  }
  try {
    const result = execSync('which rg', { encoding: 'utf-8', timeout: 2000 }).trim();
    if (result && existsSync(result)) return result;
  } catch {}
  return undefined;
}

function copySystemRipgrepToVendor(cliDir: string): void {
  const platform = getSdkVendorPlatform();
  if (!platform) return;

  const ripgrepDir = join(cliDir, 'vendor', 'ripgrep', platform);
  const ripgrepDest = join(ripgrepDir, 'rg');

  try {
    const stat = lstatSync(ripgrepDest);
    if (stat.isFile() && stat.size > 0) return;
    unlinkSync(ripgrepDest);
  } catch {}

  const systemRg = findSystemRipgrep();
  if (!systemRg) return;

  try {
    mkdirSync(ripgrepDir, { recursive: true });
    copyFileSync(systemRg, ripgrepDest);
    chmodSync(ripgrepDest, 0o755);
  } catch {}
}

export interface WarmupResult {
  status: 'ready' | 'failed';
  path?: string;
  source?: 'node_modules' | 'cache' | 'download';
  packageName?: string;
  version?: string;
  error?: string;
}

let warmupInProgress = false;

export function warmupSDKCliBinary(): WarmupResult {
  if (cachedCliPath && cachedCliPath !== '') {
    const source = resolveSource(cachedCliPath);
    return {
      status: 'ready',
      path: cachedCliPath,
      source,
      packageName: getPlatformPackageName(),
      version: getSdkVersion(),
    };
  }

  if (warmupInProgress) {
    return { status: 'failed', error: 'Warmup already in progress' };
  }

  warmupInProgress = true;
  try {
    return doWarmup();
  } finally {
    warmupInProgress = false;
  }
}

function doWarmup(): WarmupResult {
  const platformPkg = getPlatformPackageName();
  const version = getSdkVersion();

  logStartup(
    `[SDK] Resolving Claude Code binary for ${platformPkg ?? 'unsupported platform'} (SDK ${version})`
  );

  if (!platformPkg) {
    const msg = `Unsupported platform: ${process.platform}-${process.arch}`;
    logStartup(
      `[SDK] Claude Code binary unavailable. Agent queries may fail until the binary is available. Error: ${msg}`
    );
    return { status: 'failed', packageName: undefined, version, error: msg };
  }

  const nodeModulesPath = resolveFromNodeModules();
  if (nodeModulesPath) {
    cachedCliPath = nodeModulesPath;
    const size = formatFileSize(getFileSize(nodeModulesPath));
    logStartup(`[SDK] Claude Code binary ready from node_modules: ${nodeModulesPath} (${size})`);
    return {
      status: 'ready',
      path: nodeModulesPath,
      source: 'node_modules',
      packageName: platformPkg,
      version,
    };
  }

  const cachedPath = resolveFromCache();
  if (cachedPath) {
    cachedCliPath = cachedPath;
    const size = formatFileSize(getFileSize(cachedPath));
    logStartup(`[SDK] Claude Code binary ready from cache: ${cachedPath} (${size})`);
    return {
      status: 'ready',
      path: cachedPath,
      source: 'cache',
      packageName: platformPkg,
      version,
    };
  }

  logStartup(`[SDK] Downloading ${platformPkg}@${version}...`);
  const downloadedPath = downloadSdkBinary();
  if (downloadedPath) {
    cachedCliPath = downloadedPath;
    const size = formatFileSize(getFileSize(downloadedPath));
    logStartup(`[SDK] Claude Code binary ready: ${downloadedPath} (${size})`);
    return {
      status: 'ready',
      path: downloadedPath,
      source: 'download',
      packageName: platformPkg,
      version,
    };
  }

  const msg = 'All resolution strategies failed (node_modules, cache, download)';
  logStartup(
    `[SDK] Claude Code binary unavailable. Agent queries may fail until the binary is available. Error: ${msg}`
  );
  return { status: 'failed', packageName: platformPkg, version, error: msg };
}

function resolveSource(path: string): 'node_modules' | 'cache' | 'download' {
  if (path.includes('node_modules')) return 'node_modules';
  if (path.includes('.hyperneo/sdk')) return 'cache';
  return 'download';
}

function getFileSize(path: string): number {
  try {
    return lstatSync(path).size;
  } catch {
    return 0;
  }
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/**
 * Reset module state for testing.
 * @public Exported for unit tests.
 */
export function _resetForTesting(): void {
  cachedCliPath = undefined;
  warmupInProgress = false;
}

export function resolveSDKCliPath(): string | undefined {
  if (cachedCliPath === '') return undefined;
  if (cachedCliPath !== undefined) return cachedCliPath;

  const nodeModulesPath = resolveFromNodeModules();
  if (nodeModulesPath) {
    cachedCliPath = nodeModulesPath;
    return cachedCliPath;
  }

  const cachedPath = resolveFromCache();
  if (cachedPath) {
    cachedCliPath = cachedPath;
    return cachedCliPath;
  }

  const downloadedPath = downloadSdkBinary();
  if (downloadedPath) {
    cachedCliPath = downloadedPath;
    return cachedCliPath;
  }

  cachedCliPath = '';
  logWarn('[sdk-cli-resolver] All resolution strategies failed — caching negative result');
  return undefined;
}
