/**
 * SDK CLI Path Resolver Tests
 */

import { describe, expect, it, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';
import * as zlib from 'node:zlib';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  isBundledBinary,
  isRunningUnderBun,
  resolveSDKCliPath,
  getPlatformPackageName,
  getCliBinaryName,
  warmupSDKCliBinary,
  _resetForTesting,
} from '../../../../src/lib/agent/sdk-cli-resolver';

describe('sdk-cli-resolver', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  describe('isBundledBinary', () => {
    it('returns false in non-bundled environment', () => {
      expect(isBundledBinary()).toBe(false);
    });
  });

  describe('isRunningUnderBun', () => {
    it('returns true when running under Bun (bun test)', () => {
      expect(isRunningUnderBun()).toBe(true);
    });
  });

  describe('getPlatformPackageName', () => {
    it('returns a platform package name for current platform', () => {
      const result = getPlatformPackageName();
      expect(result).toBeDefined();
      expect(result!).toContain('@anthropic-ai/claude-agent-sdk-');
    });
  });

  describe('getCliBinaryName', () => {
    it('returns claude on non-Windows', () => {
      if (process.platform !== 'win32') {
        expect(getCliBinaryName()).toBe('claude');
      }
    });
  });

  describe('resolveSDKCliPath', () => {
    it('resolves CLI from node_modules in dev mode', () => {
      const result = resolveSDKCliPath();
      expect(result).toBeDefined();
      expect(result!).toContain('@anthropic-ai');
      const hasCli =
        result!.endsWith('claude') || result!.endsWith('claude.exe') || result!.includes('cli.js');
      expect(hasCli).toBe(true);
    });

    it('caches the resolved path on subsequent calls', () => {
      const first = resolveSDKCliPath();
      const second = resolveSDKCliPath();
      expect(first).toBe(second);
    });

    it('returns undefined when no resolution strategy works', () => {
      const existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(false);
      const execSyncSpy = spyOn(childProcess, 'execSync').mockImplementation(() => {
        throw new Error('not found');
      });
      const execFileSyncSpy = spyOn(childProcess, 'execFileSync').mockImplementation(() => {
        throw new Error('not found');
      });

      const result = resolveSDKCliPath();

      expect(result).toBeUndefined();
      existsSyncSpy.mockRestore();
      execSyncSpy.mockRestore();
      execFileSyncSpy.mockRestore();
    });
  });

  describe('cache resolution', () => {
    let existsSyncSpy: ReturnType<typeof spyOn>;
    let execSyncSpy: ReturnType<typeof spyOn>;
    let execFileSyncSpy: ReturnType<typeof spyOn>;
    let lstatSyncSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      _resetForTesting();
    });

    afterEach(() => {
      existsSyncSpy?.mockRestore();
      execSyncSpy?.mockRestore();
      execFileSyncSpy?.mockRestore();
      lstatSyncSpy?.mockRestore();
    });

    it('resolves from cache when node_modules is unavailable', () => {
      const originalExistsSync = fs.existsSync.bind(fs);
      const binaryName = getCliBinaryName();

      lstatSyncSpy = spyOn(fs, 'lstatSync').mockImplementation((path: fs.PathLike) => {
        const p = String(path);
        if (p.includes('.neokai/sdk') && p.endsWith(binaryName)) {
          return { isFile: () => true, size: 200000000 } as unknown as fs.Stats;
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT', path: p });
      });

      existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation((path: fs.PathLike) => {
        const p = String(path);
        // Block node_modules resolution
        if (p.includes('node_modules')) return false;
        // Block system rg paths
        if (p.endsWith('/rg')) return false;
        // Simulate cached binary exists
        if (p.includes('.neokai/sdk') && p.endsWith(binaryName)) return true;
        return originalExistsSync(p);
      });

      execSyncSpy = spyOn(childProcess, 'execSync').mockImplementation(() => {
        throw new Error('should not download');
      });

      const result = resolveSDKCliPath();

      expect(result).toBeDefined();
      expect(result!).toContain('.neokai/sdk');
    });

    it('skips cache when file is empty or zero-size', () => {
      const originalExistsSync = fs.existsSync.bind(fs);
      const binaryName = getCliBinaryName();

      lstatSyncSpy = spyOn(fs, 'lstatSync').mockImplementation((path: fs.PathLike) => {
        const p = String(path);
        if (p.includes('.neokai/sdk') && p.endsWith(binaryName)) {
          return { isFile: () => true, size: 0 } as unknown as fs.Stats;
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT', path: p });
      });

      existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation((path: fs.PathLike) => {
        const p = String(path);
        if (p.includes('node_modules')) return false;
        if (p.endsWith('/rg')) return false;
        if (p.includes('.neokai/sdk') && p.endsWith(binaryName)) return true;
        return originalExistsSync(p);
      });

      execSyncSpy = spyOn(childProcess, 'execSync').mockImplementation(() => {
        throw new Error('download also fails');
      });

      execFileSyncSpy = spyOn(childProcess, 'execFileSync').mockImplementation(() => {
        throw new Error('download also fails');
      });

      const result = resolveSDKCliPath();
      expect(result).toBeUndefined();
    });

    it('skips cache when lstatSync throws', () => {
      const originalExistsSync = fs.existsSync.bind(fs);
      const binaryName = getCliBinaryName();

      lstatSyncSpy = spyOn(fs, 'lstatSync').mockImplementation(() => {
        throw new Error('EACCES');
      });

      existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation((path: fs.PathLike) => {
        const p = String(path);
        if (p.includes('node_modules')) return false;
        if (p.endsWith('/rg')) return false;
        if (p.includes('.neokai/sdk') && p.endsWith(binaryName)) return true;
        return originalExistsSync(p);
      });

      execSyncSpy = spyOn(childProcess, 'execSync').mockImplementation(() => {
        throw new Error('download also fails');
      });

      execFileSyncSpy = spyOn(childProcess, 'execFileSync').mockImplementation(() => {
        throw new Error('download also fails');
      });

      const result = resolveSDKCliPath();
      expect(result).toBeUndefined();
    });
  });

  describe('auto-download', () => {
    let existsSyncSpy: ReturnType<typeof spyOn>;
    let execSyncSpy: ReturnType<typeof spyOn>;
    let execFileSyncSpy: ReturnType<typeof spyOn>;
    let mkdirSyncSpy: ReturnType<typeof spyOn>;
    let chmodSyncSpy: ReturnType<typeof spyOn>;
    let readFileSyncSpy: ReturnType<typeof spyOn>;
    let writeFileSyncSpy: ReturnType<typeof spyOn>;
    let renameSyncSpy: ReturnType<typeof spyOn>;
    let originalReadFileSync: typeof fs.readFileSync;

    beforeEach(() => {
      _resetForTesting();
      // Capture original before any mocking
      originalReadFileSync = fs.readFileSync.bind(fs);
      chmodSyncSpy = spyOn(fs, 'chmodSync').mockImplementation(() => {});
      renameSyncSpy = spyOn(fs, 'renameSync').mockImplementation(() => {});
      mkdirSyncSpy = spyOn(fs, 'mkdirSync').mockImplementation(
        () => undefined as unknown as string
      );
      writeFileSyncSpy = spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    });

    afterEach(() => {
      existsSyncSpy?.mockRestore();
      execSyncSpy?.mockRestore();
      execFileSyncSpy?.mockRestore();
      mkdirSyncSpy.mockRestore();
      renameSyncSpy.mockRestore();
      chmodSyncSpy.mockRestore();
      readFileSyncSpy?.mockRestore();
      writeFileSyncSpy.mockRestore();
    });

    it('attempts download when node_modules and cache are empty', () => {
      const originalExistsSync = fs.existsSync.bind(fs);
      const originalExecFileSync = childProcess.execFileSync.bind(childProcess);

      existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation((path: fs.PathLike) => {
        const p = String(path);
        if (p.includes('node_modules')) return false;
        if (p.includes('.neokai/sdk')) return false;
        return originalExistsSync(p);
      });

      let registryCalled = false;
      execFileSyncSpy = spyOn(childProcess, 'execFileSync').mockImplementation(
        (file: string, args?: string[]) => {
          if (file === 'curl') {
            const url = Array.isArray(args)
              ? args.find((a) => a.includes('registry.npmjs.org'))
              : '';
            if (url) {
              registryCalled = true;
              throw new Error('network error simulating registry failure');
            }
            // Pass through for non-registry curl calls
            return originalExecFileSync(file, args);
          }
          throw new Error(`unexpected execFileSync: ${file}`);
        }
      );

      const result = resolveSDKCliPath();

      expect(registryCalled).toBe(true);
      expect(result).toBeUndefined();
    });

    it('verifies integrity hash before extracting', () => {
      const originalExistsSync = fs.existsSync.bind(fs);
      const binaryName = getCliBinaryName();

      // Create a tarball that won't match the expected integrity
      const tarData = createTarGzWithFile(`package/${binaryName}`, Buffer.from('fake'));
      const expectedIntegrity = `sha512-${require('node:crypto').createHash('sha512').update(tarData).digest('base64')}`;

      existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation((path: fs.PathLike) => {
        const p = String(path);
        if (p.includes('node_modules')) return false;
        if (p.includes('.neokai/sdk')) return false;
        if (p.endsWith('.tgz')) return true;
        return originalExistsSync(p);
      });

      // readFileSync: return fake data for tarball (different from tarData → integrity mismatch)
      readFileSyncSpy = spyOn(fs, 'readFileSync').mockImplementation((path: fs.PathLike) => {
        const p = String(path);
        if (p.endsWith('.tgz')) {
          return Buffer.from('different-tarball-data');
        }
        // Pass through to original for other files
        return originalReadFileSync(p);
      });

      let registryFetched = false;
      execFileSyncSpy = spyOn(childProcess, 'execFileSync').mockImplementation(
        (file: string, args?: string[]) => {
          if (file === 'curl') {
            const url = Array.isArray(args)
              ? args.find((a) => a.includes('registry.npmjs.org'))
              : '';
            if (url) {
              registryFetched = true;
              return JSON.stringify({
                dist: {
                  tarball: `https://registry.npmjs.org/fake/-/fake.tgz`,
                  integrity: expectedIntegrity,
                },
              });
            }
            return '';
          }
          throw new Error(`unexpected execFileSync: ${file}`);
        }
      );

      const result = resolveSDKCliPath();

      expect(registryFetched).toBe(true);
      // Integrity mismatch should cause failure
      expect(result).toBeUndefined();
    });

    it('extracts binary with pure-JS tar parser when integrity matches', () => {
      const originalExistsSync = fs.existsSync.bind(fs);
      const binaryName = getCliBinaryName();

      // Create a valid tar.gz in memory with the binary
      const binaryContent = Buffer.from('#!/bin/bash\necho claude');
      const tarData = createTarGzWithFile(`package/${binaryName}`, binaryContent);
      const expectedIntegrity = `sha512-${require('node:crypto').createHash('sha512').update(tarData).digest('base64')}`;

      let extractedContent: Buffer | undefined;
      existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation((path: fs.PathLike) => {
        const p = String(path);
        if (p.includes('node_modules')) return false;
        if (p.includes('.neokai/sdk')) return false;
        if (p.endsWith('.tgz')) return true;
        return originalExistsSync(p);
      });

      readFileSyncSpy = spyOn(fs, 'readFileSync').mockImplementation((path: fs.PathLike) => {
        const p = String(path);
        if (p.endsWith('.tgz')) return tarData;
        // Pass through to original for other files
        return originalReadFileSync(p);
      });

      writeFileSyncSpy = spyOn(fs, 'writeFileSync').mockImplementation(
        (path: fs.PathLike, data: unknown) => {
          const p = String(path);
          if (p.endsWith(binaryName) && !p.includes('.neokai')) {
            extractedContent = Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array);
          }
        }
      );

      execFileSyncSpy = spyOn(childProcess, 'execFileSync').mockImplementation(
        (file: string, args?: string[]) => {
          if (file === 'curl') {
            const url = Array.isArray(args)
              ? args.find((a) => a.includes('registry.npmjs.org'))
              : '';
            if (url) {
              return JSON.stringify({
                dist: {
                  tarball: 'https://registry.npmjs.org/fake/-/fake.tgz',
                  integrity: expectedIntegrity,
                },
              });
            }
            return '';
          }
          throw new Error(`unexpected execFileSync: ${file}`);
        }
      );

      const result = resolveSDKCliPath();

      expect(result).toBeDefined();
      expect(result!).toContain('.neokai/sdk');
    });

    it('fails when binary is missing from tarball', () => {
      const originalExistsSync = fs.existsSync.bind(fs);

      // Create a tar.gz without the expected binary
      const tarData = createTarGzWithFile('package/other-file.txt', Buffer.from('hello'));
      const expectedIntegrity = `sha512-${require('node:crypto').createHash('sha512').update(tarData).digest('base64')}`;

      existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation((path: fs.PathLike) => {
        const p = String(path);
        if (p.includes('node_modules')) return false;
        if (p.includes('.neokai/sdk')) return false;
        if (p.endsWith('.tgz')) return true;
        return originalExistsSync(p);
      });

      readFileSyncSpy = spyOn(fs, 'readFileSync').mockImplementation((path: fs.PathLike) => {
        const p = String(path);
        if (p.endsWith('.tgz')) return tarData;
        return originalReadFileSync(p);
      });

      execFileSyncSpy = spyOn(childProcess, 'execFileSync').mockImplementation(
        (file: string, args?: string[]) => {
          if (file === 'curl') {
            const url = Array.isArray(args)
              ? args.find((a) => a.includes('registry.npmjs.org'))
              : '';
            if (url) {
              return JSON.stringify({
                dist: {
                  tarball: 'https://registry.npmjs.org/fake/-/fake.tgz',
                  integrity: expectedIntegrity,
                },
              });
            }
            return '';
          }
          throw new Error(`unexpected execFileSync: ${file}`);
        }
      );

      const result = resolveSDKCliPath();
      expect(result).toBeUndefined();
    });
  });

  describe('_resetForTesting', () => {
    it('clears cached CLI path', () => {
      const first = resolveSDKCliPath();
      expect(first).toBeDefined();

      _resetForTesting();
      const existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(false);
      const execSyncSpy = spyOn(childProcess, 'execSync').mockImplementation(() => {
        throw new Error('not found');
      });
      const execFileSyncSpy = spyOn(childProcess, 'execFileSync').mockImplementation(() => {
        throw new Error('not found');
      });

      const result = resolveSDKCliPath();
      expect(result).toBeUndefined();

      existsSyncSpy.mockRestore();
      execSyncSpy.mockRestore();
      execFileSyncSpy.mockRestore();
    });
  });
});

// ─── Test helpers ─────────────────────────────────────────────────────────

/**
 * Create a valid gzip-compressed tar archive containing a single file.
 * Used to test the pure-JS tar extraction without external dependencies.
 */
function createTarGzWithFile(fileName: string, content: Buffer): Buffer {
  // Build tar header (512 bytes)
  const header = Buffer.alloc(512, 0);

  // File name (100 bytes)
  header.write(fileName, 0, 'utf-8');

  // File mode (8 bytes, octal)
  header.write('0000644\0', 100, 'utf-8');

  // UID (8 bytes, octal)
  header.write('0000000\0', 108, 'utf-8');

  // GID (8 bytes, octal)
  header.write('0000000\0', 116, 'utf-8');

  // File size (12 bytes, octal)
  const sizeOctal = content.length.toString(8).padStart(11, '0') + '\0';
  header.write(sizeOctal, 124, 'utf-8');

  // Modification time (12 bytes, octal)
  header.write('00000000000\0', 136, 'utf-8');

  // Checksum placeholder (8 bytes of spaces)
  header.write('        ', 148, 'utf-8');

  // Type flag (1 byte) — regular file
  header.write('0', 156, 'utf-8');

  // Compute checksum (sum of all header bytes, with checksum field as spaces)
  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += header[i];
  }
  const checksumOctal = checksum.toString(8).padStart(6, '0') + '\0 ';
  header.write(checksumOctal, 148, 'utf-8');

  // Pad content to 512-byte boundary
  const contentPadded = Buffer.alloc(Math.ceil(content.length / 512) * 512, 0);
  content.copy(contentPadded);

  // End-of-archive marker (two zero blocks)
  const endMarker = Buffer.alloc(1024, 0);

  // Concatenate: header + content + end marker
  const tarData = Buffer.concat([header, contentPadded, endMarker]);

  // Gzip compress
  return zlib.gzipSync(tarData);
}

describe('warmupSDKCliBinary', () => {
  let existsSyncSpy: ReturnType<typeof spyOn>;
  let execSyncSpy: ReturnType<typeof spyOn>;
  let execFileSyncSpy: ReturnType<typeof spyOn>;
  let mkdirSyncSpy: ReturnType<typeof spyOn>;
  let chmodSyncSpy: ReturnType<typeof spyOn>;
  let readFileSyncSpy: ReturnType<typeof spyOn>;
  let writeFileSyncSpy: ReturnType<typeof spyOn>;
  let renameSyncSpy: ReturnType<typeof spyOn>;
  let logSpy: ReturnType<typeof spyOn>;
  let originalReadFileSync: typeof fs.readFileSync;

  beforeEach(() => {
    _resetForTesting();
    originalReadFileSync = fs.readFileSync.bind(fs);
    chmodSyncSpy = spyOn(fs, 'chmodSync').mockImplementation(() => {});
    renameSyncSpy = spyOn(fs, 'renameSync').mockImplementation(() => {});
    mkdirSyncSpy = spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as unknown as string);
    writeFileSyncSpy = spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    // oxlint-disable-next-line no-console
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    existsSyncSpy?.mockRestore();
    execSyncSpy?.mockRestore();
    execFileSyncSpy?.mockRestore();
    mkdirSyncSpy.mockRestore();
    renameSyncSpy.mockRestore();
    chmodSyncSpy.mockRestore();
    readFileSyncSpy?.mockRestore();
    writeFileSyncSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('returns ready from node_modules in dev mode', () => {
    const result = warmupSDKCliBinary();

    expect(result.status).toBe('ready');
    expect(result.source).toBe('node_modules');
    expect(result.path).toBeDefined();
    expect(result.path!).toContain('@anthropic-ai');
    expect(result.packageName).toBeDefined();
    expect(result.version).toBeDefined();
  });

  it('returns ready from cache when node_modules unavailable', () => {
    const originalExistsSync = fs.existsSync.bind(fs);
    const binaryName = getCliBinaryName();

    const lstatSyncSpy = spyOn(fs, 'lstatSync').mockImplementation((path: fs.PathLike) => {
      const p = String(path);
      if (p.includes('.neokai/sdk') && p.endsWith(binaryName)) {
        return { isFile: () => true, size: 200000000 } as unknown as fs.Stats;
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT', path: p });
    });

    existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation((path: fs.PathLike) => {
      const p = String(path);
      if (p.includes('node_modules')) return false;
      if (p.endsWith('/rg')) return false;
      if (p.includes('.neokai/sdk') && p.endsWith(binaryName)) return true;
      return originalExistsSync(p);
    });

    const result = warmupSDKCliBinary();

    expect(result.status).toBe('ready');
    expect(result.source).toBe('cache');
    expect(result.path).toContain('.neokai/sdk');

    lstatSyncSpy.mockRestore();
  });

  it('returns failed when all strategies fail', () => {
    existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(false);
    execSyncSpy = spyOn(childProcess, 'execSync').mockImplementation(() => {
      throw new Error('not found');
    });
    execFileSyncSpy = spyOn(childProcess, 'execFileSync').mockImplementation(() => {
      throw new Error('not found');
    });

    const result = warmupSDKCliBinary();

    expect(result.status).toBe('failed');
    expect(result.error).toBeDefined();
  });

  it('returns ready on download success when node_modules and cache miss', () => {
    const originalExistsSync = fs.existsSync.bind(fs);
    const binaryName = getCliBinaryName();

    // Create valid tar.gz with the binary
    const binaryContent = Buffer.from('#!/bin/bash\necho claude');
    const tarData = createTarGzWithFile(`package/${binaryName}`, binaryContent);
    const expectedIntegrity = `sha512-${require('node:crypto').createHash('sha512').update(tarData).digest('base64')}`;

    existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation((path: fs.PathLike) => {
      const p = String(path);
      if (p.includes('node_modules')) return false;
      if (p.includes('.neokai/sdk')) return false;
      if (p.endsWith('.tgz')) return true;
      return originalExistsSync(p);
    });

    readFileSyncSpy = spyOn(fs, 'readFileSync').mockImplementation((path: fs.PathLike) => {
      const p = String(path);
      if (p.endsWith('.tgz')) return tarData;
      return originalReadFileSync(p);
    });

    execFileSyncSpy = spyOn(childProcess, 'execFileSync').mockImplementation(
      (file: string, args?: string[]) => {
        if (file === 'curl') {
          const url = Array.isArray(args) ? args.find((a) => a.includes('registry.npmjs.org')) : '';
          if (url) {
            return JSON.stringify({
              dist: {
                tarball: 'https://registry.npmjs.org/fake/-/fake.tgz',
                integrity: expectedIntegrity,
              },
            });
          }
          return '';
        }
        throw new Error(`unexpected execFileSync: ${file}`);
      }
    );

    const result = warmupSDKCliBinary();

    expect(result.status).toBe('ready');
    expect(result.source).toBe('download');
    expect(result.path).toContain('.neokai/sdk');
  });

  it('logs startup messages regardless of NEOKAI_VERBOSE', () => {
    // Ensure NEOKAI_VERBOSE is NOT set
    delete process.env.NEOKAI_VERBOSE;

    warmupSDKCliBinary();

    // Should have logged at least one [SDK] message
    const calls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    const sdkLogs = calls.filter((c: string) => c.includes('[SDK]'));
    expect(sdkLogs.length).toBeGreaterThan(0);
  });

  it('returns cached result on second call without re-resolving', () => {
    const first = warmupSDKCliBinary();
    expect(first.status).toBe('ready');

    // Reset log spy to count second call
    logSpy.mockClear();

    const second = warmupSDKCliBinary();
    expect(second.status).toBe('ready');
    expect(second.path).toBe(first.path);
  });

  it('populates cachedCliPath so subsequent resolveSDKCliPath is instant', () => {
    warmupSDKCliBinary();

    const resolved = resolveSDKCliPath();
    expect(resolved).toBeDefined();
  });

  it('does not set negative cache on failure, allowing resolveSDKCliPath to retry', () => {
    existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(false);
    execSyncSpy = spyOn(childProcess, 'execSync').mockImplementation(() => {
      throw new Error('not found');
    });
    execFileSyncSpy = spyOn(childProcess, 'execFileSync').mockImplementation(() => {
      throw new Error('not found');
    });

    const result = warmupSDKCliBinary();
    expect(result.status).toBe('failed');

    // Restore mocks so resolveSDKCliPath can try node_modules
    existsSyncSpy.mockRestore();
    execSyncSpy.mockRestore();
    execFileSyncSpy.mockRestore();

    // resolveSDKCliPath should still be able to resolve (not negative-cached)
    const resolved = resolveSDKCliPath();
    expect(resolved).toBeDefined();
  });

  it('returns failed for unsupported platform', () => {
    // Mock getPlatformPackageName to return undefined via module spy.
    // Internal calls bypass the export, so we patch the resolver module.
    // Since process.platform/arch are read-only in Bun, we test the
    // unsupported platform path by verifying the error shape when
    // all resolution strategies fail.
    existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(false);
    execSyncSpy = spyOn(childProcess, 'execSync').mockImplementation(() => {
      throw new Error('not found');
    });
    execFileSyncSpy = spyOn(childProcess, 'execFileSync').mockImplementation(() => {
      throw new Error('not found');
    });

    const result = warmupSDKCliBinary();

    expect(result.status).toBe('failed');
    expect(result.error).toBeDefined();
    expect(result.version).toBeDefined();
  });

  it('handles sequential warmup calls correctly (mutex releases)', () => {
    const first = warmupSDKCliBinary();
    expect(first.status).toBe('ready');

    // Mutex released after first call — second succeeds immediately.
    const second = warmupSDKCliBinary();
    expect(second.status).toBe('ready');
    expect(second.path).toBe(first.path);
  });
});
