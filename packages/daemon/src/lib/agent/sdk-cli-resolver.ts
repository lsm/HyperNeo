import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import daemonPackage from '../../../package.json' with { type: 'json' };
import { getDataDir } from '../data-dir.ts';
import {
  describeWriteFailure,
  downloadVerifiedTarball,
  extractFileFromTarGz,
  isMusl,
  PACKAGE_DOWNLOAD_WAIT_MS,
  waitForDownload,
} from './npm-package-download.ts';

// oxlint-disable-next-line no-console
const logWarn = console.warn;

// oxlint-disable-next-line no-console
const logStartup = (...args: unknown[]) => console.log(...args);

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

const SDK_CACHE_DIR = join(getDataDir(), 'sdk');

/** @public */
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

/** @public */
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
  } catch {}

  try {
    const resolved = import.meta.resolve?.(SDK_PACKAGE);
    if (resolved) {
      const sdkPath = resolved.startsWith('file://') ? fileURLToPath(resolved) : resolved;
      const sdkPkgPath = join(dirname(sdkPath), 'package.json');
      const sdkPkg = JSON.parse(readFileSync(sdkPkgPath, 'utf-8'));
      if (sdkPkg.version) return sdkPkg.version;
    }
  } catch {}

  return daemonPackage.dependencies[SDK_PACKAGE];
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
    } catch {}
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
    } catch {}
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
    } catch {}
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
  } catch {}

  try {
    let currentDir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 10; i++) {
      const candidate = join(currentDir, 'node_modules', SDK_PACKAGE, 'cli.js');
      if (existsSync(candidate)) return candidate;
      const parentDir = dirname(currentDir);
      if (parentDir === currentDir) break;
      currentDir = parentDir;
    }
  } catch {}

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

function safeMoveFile(src: string, dest: string): void {
  try {
    renameSync(src, dest);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EXDEV' || code === 'EPERM') {
      copyFileSync(src, dest);
      try {
        unlinkSync(src);
      } catch {}
    } else {
      throw err;
    }
  }
}

async function downloadSdkBinary(platformPkg: string, cachePath: string): Promise<string> {
  const version = getSdkVersion();
  const binaryName = getCliBinaryName();
  const cacheDir = dirname(cachePath);
  const tarballPath = `${cacheDir}.tgz.partial`;
  const tmpDir = join(tmpdir(), `hyperneo-sdk-download-${process.pid}-${Date.now()}`);

  try {
    await downloadVerifiedTarball(platformPkg, version, tarballPath);
    mkdirSync(tmpDir, { recursive: true });

    const extractedPath = join(tmpDir, binaryName);
    await extractFileFromTarGz(tarballPath, binaryName, extractedPath);

    mkdirSync(cacheDir, { recursive: true });
    safeMoveFile(extractedPath, cachePath);
    chmodSync(cachePath, 0o755);

    copySystemRipgrepToVendor(cacheDir);
    rmSync(tarballPath, { force: true });

    return cachePath;
  } catch (err) {
    throw new Error(describeWriteFailure(err), { cause: err });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
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

let warmupInFlight: Promise<WarmupResult> | undefined;

export async function warmupSDKCliBinary(): Promise<WarmupResult> {
  if (cachedCliPath) {
    const source = resolveSource(cachedCliPath);
    return {
      status: 'ready',
      path: cachedCliPath,
      source,
      packageName: getPlatformPackageName(),
      version: getSdkVersion(),
    };
  }

  warmupInFlight ??= doWarmup().finally(() => {
    warmupInFlight = undefined;
  });
  return warmupInFlight;
}

export async function awaitSDKCliPathForQuery(): Promise<string | undefined> {
  return waitForDownload(awaitSDKCliPath(), PACKAGE_DOWNLOAD_WAIT_MS, 'Claude Code binary');
}

export async function awaitSDKCliPath(): Promise<string | undefined> {
  const local = resolveSDKCliPath();
  if (local) return local;
  const result = await warmupSDKCliBinary();
  if (result.status === 'ready' || !result.packageName) return result.path;
  throw new Error(`Claude Code binary unavailable: ${result.error}`);
}

async function doWarmup(): Promise<WarmupResult> {
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
  try {
    const downloadedPath = await downloadSdkBinary(platformPkg, getCachePath());
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
  } catch (err) {
    const msg = `Could not download ${platformPkg}@${version}: ${(err as Error).message}`;
    logWarn(
      `[SDK] Claude Code binary unavailable. Agent queries may fail until the binary is available. Error: ${msg}`
    );
    return { status: 'failed', packageName: platformPkg, version, error: msg };
  }
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

/** @public */
export function _resetForTesting(): void {
  cachedCliPath = undefined;
  warmupInFlight = undefined;
}

/** @public */
export function resolveSDKCliPath(): string | undefined {
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

  return undefined;
}
