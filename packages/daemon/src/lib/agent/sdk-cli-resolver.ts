/**
 * SDK CLI Path Resolver
 *
 * Resolves the path to the Claude Agent SDK's bundled CLI executable.
 *
 * Resolution priority:
 * 1. node_modules (dev mode) — the SDK's platform-specific optional dep
 * 2. Cache directory (~/.hyperneo/sdk/) — previously downloaded binary
 * 3. Auto-download — fetch the platform package from npm, extract, and cache
 *
 * In compiled binary mode (bun build --compile), the CLI is NOT embedded
 * to keep the binary small (~66 MB vs ~266 MB). Instead it's downloaded
 * on first use and cached for subsequent runs.
 */

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

/** Verbose logging — enabled via HYPERNEO_VERBOSE env var for diagnostics. */
const isVerbose = process.env.HYPERNEO_VERBOSE;
// oxlint-disable-next-line no-console
const logWarn = isVerbose ? console.warn : () => {};

/** Startup logging — always visible during daemon startup, never gated by HYPERNEO_VERBOSE. */
// oxlint-disable-next-line no-console
const logStartup = (...args: unknown[]) => console.log(...args);

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

/** Directory for cached SDK binaries: ~/.hyperneo/sdk/ */
const SDK_CACHE_DIR = join(getDataDir(), 'sdk');

/**
 * Detect whether the current Linux system uses musl libc (Alpine, etc.)
 * instead of glibc. Checks for the musl dynamic linker in /lib and /lib64.
 */
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

/**
 * Check if we're running inside a Bun compiled binary.
 */
export function isBundledBinary(): boolean {
  return import.meta.url.includes('/$bunfs/root/');
}

/**
 * Check if we're running under the Bun runtime (dev, test, or compiled binary mode).
 *
 * When running under Bun, SDK subprocesses should also use Bun to avoid
 * Node.js version mismatches. For example, `node:sqlite` was added in
 * Node.js v22.5.0 but is available in Bun via its Node.js compat layer.
 * CI runners may have an older Node.js (e.g. v20) on PATH; using 'bun'
 * ensures the subprocess gets the same compat surface as the parent process.
 */
export function isRunningUnderBun(): boolean {
  return typeof globalThis.Bun !== 'undefined';
}

/** Cached resolved real filesystem path. Empty string = resolution failed (negative cache). */
let cachedCliPath: string | undefined;

/**
 * Get the SDK version from the daemon's package.json.
 * Used to version the cache key and to know which package to download.
 */
function getSdkVersion(): string {
  try {
    // Read from the daemon package.json which has the SDK as a dependency
    // Path: src/lib/agent/sdk-cli-resolver.ts → ../../.. → daemon/
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

  // Try reading the installed SDK's package.json
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

  // Hardcoded fallback — must be updated when the SDK dependency changes
  return '0.3.233';
}

/**
 * Get the cache path for the SDK binary.
 * Format: ~/.hyperneo/sdk/claude-<version>-<os>-<arch>[-musl]
 */
function getCachePath(): string {
  const platformPkg = getPlatformPackageName();
  if (!platformPkg) return '';
  const version = getSdkVersion();
  // Extract os-arch[-musl] from package name
  const platformPart = platformPkg.replace(`${SDK_PACKAGE}-`, '');
  const binaryName = getCliBinaryName();
  return join(SDK_CACHE_DIR, `claude-${version}-${platformPart}`, binaryName);
}

// ─── Resolution strategies ────────────────────────────────────────────────

/**
 * Try to resolve the CLI from node_modules (dev mode).
 */
function resolveFromNodeModules(): string | undefined {
  const binaryName = getCliBinaryName();
  const platformPkg = getPlatformPackageName();

  // Strategy 1: import.meta.resolve for platform-specific native binary
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

  // Strategy 2: Navigate from main SDK package to bun's hoisted platform binary.
  if (platformPkg) {
    try {
      const sdkModulePath = import.meta.resolve?.(SDK_PACKAGE);
      if (sdkModulePath) {
        const sdkPath = sdkModulePath.startsWith('file://')
          ? fileURLToPath(sdkModulePath)
          : sdkModulePath;
        // Navigate up 5 levels to reach .bun directory
        const bunDir = dirname(dirname(dirname(dirname(dirname(sdkPath)))));
        const hoistedPath = join(bunDir, 'node_modules', platformPkg, binaryName);
        if (existsSync(hoistedPath)) return hoistedPath;
      }
    } catch {
      // import.meta.resolve might not be available
    }
  }

  // Strategy 3: Walk up from current file to find platform-specific binary
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

  // Strategy 4: Legacy cli.js (SDK < 0.2.141)
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

  // Strategy 5: Walk up for legacy cli.js
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

/**
 * Check the cache directory for a previously downloaded SDK binary.
 */
function resolveFromCache(): string | undefined {
  const cachePath = getCachePath();
  if (cachePath && existsSync(cachePath)) {
    // Verify it's a real file with content (not a broken symlink or empty file)
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

/**
 * Compute the SHA-512 hash of a file, returned in npm's integrity format
 * (`sha512-<base64>`).
 */
function sha512OfFile(filePath: string): string {
  const hash = createHash('sha512');
  const data = readFileSync(filePath);
  hash.update(data);
  return `sha512-${hash.digest('base64')}`;
}

/**
 * Fetch the tarball URL and integrity hash for an npm package version from
 * the npm registry. Uses `curl` for synchronous HTTP — no npm CLI needed.
 * Returns `{ tarballUrl, integrity }` or undefined on failure.
 *
 * Note: Standard `fetch()` is async and cannot be used in this synchronous
 * resolution path. Bun's sync fetch (experimental) is not yet stable.
 * `curl` is available on all supported platforms (macOS, Linux, Windows via
 * Git Bash). If curl is unavailable, the resolver falls back to returning
 * undefined and the caller gets a clear error about the SDK CLI not found.
 */
function fetchNpmPackageMeta(
  packageName: string,
  version: string
): { tarballUrl: string; integrity: string } | undefined {
  const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${version}`;
  try {
    // Use execFileSync to avoid shell injection — arguments passed as array
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

/**
 * Download a tarball from a URL using curl (available on all target platforms).
 * Returns the path to the downloaded file, or undefined on failure.
 */
function downloadTarball(url: string, destPath: string): string | undefined {
  try {
    // Use execFileSync to avoid shell injection — arguments passed as array
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

/**
 * Minimal tar.gz extractor that extracts a single file from a gzip-compressed
 * tar archive. Uses Node.js zlib — no external `tar` binary required.
 *
 * Scans the tar stream for the target file entry and writes it to disk.
 * npm tarballs have the structure: `package/<binary-name>`.
 *
 * @returns Path to the extracted file, or undefined on failure.
 */
function extractFileFromTarGz(
  tarballPath: string,
  targetFileName: string,
  destPath: string
): string | undefined {
  try {
    // Read and gunzip the tarball synchronously
    const compressed = readFileSync(tarballPath);
    const gunzipped = gunzipSync(compressed);

    // Parse tar header entries (512-byte blocks)
    const TAR_HEADER_SIZE = 512;
    let offset = 0;

    while (offset + TAR_HEADER_SIZE <= gunzipped.length) {
      const header = gunzipped.subarray(offset, offset + TAR_HEADER_SIZE);

      // Check for end-of-archive (two consecutive zero blocks)
      if (header.every((b: number) => b === 0)) break;

      // Parse header fields (POSIX ustar format)
      // oxlint-disable-next-line no-control-regex -- tar headers use NUL-padding; \x00 is intentional
      const stripNul = (s: string) => s.replace(/\x00/g, '');
      const name = stripNul(header.subarray(0, 100).toString('utf-8'));
      const sizeOctal = stripNul(header.subarray(124, 136).toString('utf-8')).trim();
      const typeFlag = header.subarray(156, 157).toString('utf-8');
      const prefix = stripNul(header.subarray(345, 500).toString('utf-8'));

      const fullName = prefix ? `${prefix}${name}` : name;
      const fileSize = sizeOctal ? parseInt(sizeOctal, 8) : 0;
      const dataBlocks = Math.ceil(fileSize / TAR_HEADER_SIZE);

      // Check if this is the target file (regular file: typeFlag '0' or '\0')
      const isRegularFile = typeFlag === '0' || typeFlag === '\0' || typeFlag === '';
      const baseName = fullName.replace(/^package\//, '');

      if (isRegularFile && baseName === targetFileName && fileSize > 0) {
        // Extract the file data
        const fileData = gunzipped.subarray(
          offset + TAR_HEADER_SIZE,
          offset + TAR_HEADER_SIZE + fileSize
        );
        writeFileSync(destPath, fileData);
        return destPath;
      }

      // Advance past header + data blocks
      offset += TAR_HEADER_SIZE + dataBlocks * TAR_HEADER_SIZE;
    }

    logWarn(`[sdk-cli-resolver] File "${targetFileName}" not found in tarball`);
    return undefined;
  } catch (err) {
    logWarn(`[sdk-cli-resolver] Tar extraction failed: ${err}`);
    return undefined;
  }
}

/**
 * Move a file from src to dest, handling cross-device (EXDEV) errors by
 * falling back to copy + unlink.
 */
function safeMoveFile(src: string, dest: string): void {
  try {
    renameSync(src, dest);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EXDEV' || code === 'EPERM') {
      // Cross-device or permission issue — fall back to copy + unlink
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

/**
 * Download the SDK platform package from npm, extract the binary, and cache it.
 *
 * Uses direct HTTPS to the npm registry — no npm CLI or external tar binary
 * required. The tarball's integrity is verified against the registry's
 * `dist.integrity` field before extraction.
 *
 * This avoids embedding the 200 MB binary in the compiled HyperNeo binary
 * (reducing it from ~266 MB to ~66 MB).
 */
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
    // Create a temp directory for the download
    tmpDir = join(tmpdir(), `hyperneo-sdk-download-${process.pid}-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    // Step 1: Fetch package metadata (tarball URL + integrity hash) from npm
    const meta = fetchNpmPackageMeta(platformPkg, version);
    if (!meta) return undefined;

    // Step 2: Download the tarball via HTTPS
    const tarballPath = join(tmpDir, `${platformPkg.replace(/\//g, '_')}-${version}.tgz`);
    const downloaded = downloadTarball(meta.tarballUrl, tarballPath);
    if (!downloaded) return undefined;

    // Step 3: Verify integrity (SHA-512)
    const actualIntegrity = sha512OfFile(tarballPath);
    if (actualIntegrity !== meta.integrity) {
      logWarn(
        `[sdk-cli-resolver] Integrity mismatch for ${platformPkg}@${version}: expected ${meta.integrity}, got ${actualIntegrity}`
      );
      return undefined;
    }

    // Step 4: Extract the binary from the tarball (pure JS, no external tar)
    const extractedPath = join(tmpDir, binaryName);
    const extracted = extractFileFromTarGz(tarballPath, binaryName, extractedPath);
    if (!extracted) return undefined;

    // Step 5: Move to cache (with EXDEV fallback for cross-device moves)
    mkdirSync(cacheDir, { recursive: true });
    safeMoveFile(extracted, cachePath);
    chmodSync(cachePath, 0o755);

    // Copy ripgrep vendor binary for sandbox mode
    copySystemRipgrepToVendor(cacheDir);

    return cachePath;
  } catch (err) {
    logWarn(`[sdk-cli-resolver] Unexpected error downloading SDK binary: ${err}`);
    return undefined;
  } finally {
    // Clean up temp directory on all exit paths (success, failure, exception)
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true });
      } catch {
        // Non-critical — temp dir will be cleaned by OS
      }
    }
  }
}

// ─── Ripgrep vendor support ───────────────────────────────────────────────

/**
 * Return the SDK vendor platform string (e.g. "x64-linux") matching the
 * directory names inside @anthropic-ai/claude-agent-sdk/vendor/ripgrep/.
 * Returns undefined on unsupported platforms (Windows).
 */
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

/**
 * Copy the system ripgrep binary into the SDK's expected vendor directory.
 */
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

// ─── Public API ───────────────────────────────────────────────────────────

/** Result of SDK CLI binary warmup. */
export interface WarmupResult {
  status: 'ready' | 'failed';
  path?: string;
  source?: 'node_modules' | 'cache' | 'download';
  packageName?: string;
  version?: string;
  error?: string;
}

/** Mutex flag to prevent concurrent warmup/download races. */
let warmupInProgress = false;

/**
 * Pre-resolve the SDK CLI binary during daemon startup.
 *
 * Tries node_modules → cache → download (same priority as resolveSDKCliPath)
 * but always returns a structured result without throwing. Sets `cachedCliPath`
 * on success so subsequent `resolveSDKCliPath()` calls are instant.
 *
 * Logs progress at each step — never gated by HYPERNEO_VERBOSE.
 */
export function warmupSDKCliBinary(): WarmupResult {
  // Already resolved (e.g. a previous call or resolveSDKCliPath ran first)
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

  // Prevent concurrent warmup (startup warmup + first query racing)
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

/**
 * Internal warmup implementation. Logs progress, never throws.
 */
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

  // Priority 1: node_modules
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

  // Priority 2: cache
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

  // Priority 3: download
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

  // All strategies failed — do NOT set negative cache so resolveSDKCliPath() can retry later
  const msg = 'All resolution strategies failed (node_modules, cache, download)';
  logStartup(
    `[SDK] Claude Code binary unavailable. Agent queries may fail until the binary is available. Error: ${msg}`
  );
  return { status: 'failed', packageName: platformPkg, version, error: msg };
}

/** Determine source label from a resolved path. */
function resolveSource(path: string): 'node_modules' | 'cache' | 'download' {
  if (path.includes('node_modules')) return 'node_modules';
  if (path.includes('.hyperneo/sdk')) return 'cache';
  return 'download';
}

/** Get file size in bytes, or 0 on error. */
function getFileSize(path: string): number {
  try {
    return lstatSync(path).size;
  } catch {
    return 0;
  }
}

/** Format bytes as human-readable string. */
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

/**
 * Resolve the path to the Claude Code CLI bundled with the SDK.
 *
 * Resolution priority:
 * 1. node_modules (dev mode)
 * 2. Cache directory (~/.hyperneo/sdk/) — previously downloaded
 * 3. Auto-download from npm — fetch, extract, and cache
 *
 * Failed resolution is cached (empty string) to avoid repeated download
 * timeouts in offline/restricted environments.
 *
 * @returns Real filesystem path to the CLI, or undefined if not found
 */
export function resolveSDKCliPath(): string | undefined {
  // Empty string = negative cache (resolution previously failed)
  if (cachedCliPath === '') return undefined;
  if (cachedCliPath !== undefined) return cachedCliPath;

  // Priority 1: Resolve from node_modules (dev mode)
  const nodeModulesPath = resolveFromNodeModules();
  if (nodeModulesPath) {
    cachedCliPath = nodeModulesPath;
    return cachedCliPath;
  }

  // Priority 2: Check cache
  const cachedPath = resolveFromCache();
  if (cachedPath) {
    cachedCliPath = cachedPath;
    return cachedCliPath;
  }

  // Priority 3: Auto-download
  const downloadedPath = downloadSdkBinary();
  if (downloadedPath) {
    cachedCliPath = downloadedPath;
    return cachedCliPath;
  }

  // Cache failure to avoid repeated download timeouts
  cachedCliPath = '';
  logWarn('[sdk-cli-resolver] All resolution strategies failed — caching negative result');
  return undefined;
}
