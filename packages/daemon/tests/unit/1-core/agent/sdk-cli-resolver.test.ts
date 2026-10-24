import { describe, expect, it, beforeEach, afterEach, spyOn } from 'bun:test';
import { vi } from 'vitest';
import type * as fs from 'node:fs';
import * as zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  isBundledBinary,
  isRunningUnderBun,
  resolveSDKCliPath,
  getPlatformPackageName,
  getCliBinaryName,
  warmupSDKCliBinary,
  _resetForTesting,
  awaitSDKCliPath,
} from '../../../../src/lib/agent/sdk-cli-resolver';

const mocks = vi.hoisted(() => ({
  actualFs: null as unknown as typeof import('node:fs'),
  actualCp: null as unknown as typeof import('node:child_process'),
  existsSync: vi.fn(),
  lstatSync: vi.fn(),
  chmodSync: vi.fn(),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  execFile: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

function passthrough<Args extends unknown[], R>(
  mockFn: ReturnType<typeof vi.fn>,
  real: (...args: Args) => R
): (...args: Args) => R {
  return (...args: Args) => (mockFn.getMockImplementation() ?? real)(...args);
}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  mocks.actualFs = actual;
  return {
    ...actual,
    existsSync: passthrough(mocks.existsSync, actual.existsSync),
    lstatSync: passthrough(mocks.lstatSync, actual.lstatSync),
    chmodSync: passthrough(mocks.chmodSync, actual.chmodSync),
    renameSync: passthrough(mocks.renameSync, actual.renameSync),
    mkdirSync: passthrough(mocks.mkdirSync, actual.mkdirSync),
    writeFileSync: passthrough(mocks.writeFileSync, actual.writeFileSync),
    readFileSync: passthrough(mocks.readFileSync, actual.readFileSync),
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: passthrough(mocks.readFile, actual.readFile),
    writeFile: passthrough(mocks.writeFile, actual.writeFile),
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  mocks.actualCp = actual;
  return {
    ...actual,
    execSync: passthrough(mocks.execSync, actual.execSync),
    execFileSync: passthrough(mocks.execFileSync, actual.execFileSync),
    execFile: passthrough(mocks.execFile, actual.execFile),
  };
});

function resetModuleMocks(): void {
  for (const mockFn of [
    mocks.existsSync,
    mocks.lstatSync,
    mocks.chmodSync,
    mocks.renameSync,
    mocks.mkdirSync,
    mocks.writeFileSync,
    mocks.readFileSync,
    mocks.execSync,
    mocks.execFileSync,
    mocks.execFile,
    mocks.readFile,
    mocks.writeFile,
  ]) {
    mockFn.mockReset();
  }
}

function curlMock(run: (file: string, args?: string[]) => unknown): void {
  mocks.execFile.mockImplementation(
    (file: string, args: string[], _options: unknown, done: (...r: unknown[]) => void) => {
      try {
        const out = run(file, args);
        setImmediate(() => done(null, out, ''));
      } catch (err) {
        setImmediate(() => done(err));
      }
    }
  );
}

function readMock(read: (path: fs.PathLike) => unknown): void {
  mocks.readFileSync.mockImplementation(read);
  mocks.readFile.mockImplementation(async (path: fs.PathLike) => read(path));
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

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
    it('reflects the current runtime (true under bun test, false under Vitest)', () => {
      expect(isRunningUnderBun()).toBe(isBun);
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
      mocks.existsSync.mockReturnValue(false);
      mocks.execSync.mockImplementation(() => {
        throw new Error('not found');
      });
      mocks.execFileSync.mockImplementation(() => {
        throw new Error('not found');
      });

      const result = resolveSDKCliPath();

      expect(result).toBeUndefined();
      resetModuleMocks();
    });
  });

  describe('cache resolution', () => {
    beforeEach(() => {
      _resetForTesting();
    });

    afterEach(() => {
      resetModuleMocks();
    });

    it('resolves from cache when node_modules is unavailable', () => {
      const originalExistsSync = mocks.actualFs.existsSync;
      const binaryName = getCliBinaryName();

      mocks.lstatSync.mockImplementation((path: fs.PathLike) => {
        const p = String(path);
        if (p.includes('.hyperneo/sdk') && p.endsWith(binaryName)) {
          return { isFile: () => true, size: 200000000 } as unknown as fs.Stats;
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT', path: p });
      });

      mocks.existsSync.mockImplementation((path: fs.PathLike) => {
        const p = String(path);
        if (p.includes('node_modules')) return false;
        if (p.endsWith('/rg')) return false;
        if (p.includes('.hyperneo/sdk') && p.endsWith(binaryName)) return true;
        return originalExistsSync(p);
      });

      mocks.execSync.mockImplementation(() => {
        throw new Error('should not download');
      });

      const result = resolveSDKCliPath();

      expect(result).toBeDefined();
      expect(result!).toContain('.hyperneo/sdk');
    });

    it('skips cache when file is empty or zero-size', () => {
      const originalExistsSync = mocks.actualFs.existsSync;
      const binaryName = getCliBinaryName();

      mocks.lstatSync.mockImplementation((path: fs.PathLike) => {
        const p = String(path);
        if (p.includes('.hyperneo/sdk') && p.endsWith(binaryName)) {
          return { isFile: () => true, size: 0 } as unknown as fs.Stats;
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT', path: p });
      });

      mocks.existsSync.mockImplementation((path: fs.PathLike) => {
        const p = String(path);
        if (p.includes('node_modules')) return false;
        if (p.endsWith('/rg')) return false;
        if (p.includes('.hyperneo/sdk') && p.endsWith(binaryName)) return true;
        return originalExistsSync(p);
      });

      mocks.execSync.mockImplementation(() => {
        throw new Error('download also fails');
      });

      mocks.execFileSync.mockImplementation(() => {
        throw new Error('download also fails');
      });

      const result = resolveSDKCliPath();
      expect(result).toBeUndefined();
    });

    it('skips cache when lstatSync throws', () => {
      const originalExistsSync = mocks.actualFs.existsSync;
      const binaryName = getCliBinaryName();

      mocks.lstatSync.mockImplementation(() => {
        throw new Error('EACCES');
      });

      mocks.existsSync.mockImplementation((path: fs.PathLike) => {
        const p = String(path);
        if (p.includes('node_modules')) return false;
        if (p.endsWith('/rg')) return false;
        if (p.includes('.hyperneo/sdk') && p.endsWith(binaryName)) return true;
        return originalExistsSync(p);
      });

      mocks.execSync.mockImplementation(() => {
        throw new Error('download also fails');
      });

      mocks.execFileSync.mockImplementation(() => {
        throw new Error('download also fails');
      });

      const result = resolveSDKCliPath();
      expect(result).toBeUndefined();
    });
  });

  describe('auto-download', () => {
    let originalReadFileSync: typeof fs.readFileSync;

    beforeEach(() => {
      _resetForTesting();
      originalReadFileSync = mocks.actualFs.readFileSync;
      mocks.chmodSync.mockImplementation(() => {});
      mocks.renameSync.mockImplementation(() => {});
      mocks.mkdirSync.mockImplementation(() => undefined as unknown as string);
      mocks.writeFileSync.mockImplementation(() => {});
      mocks.writeFile.mockImplementation(async () => {});
    });

    afterEach(() => {
      resetModuleMocks();
    });

    it('attempts download when node_modules and cache are empty', async () => {
      const originalExistsSync = mocks.actualFs.existsSync;
      const originalExecFileSync = mocks.actualCp.execFileSync;

      mocks.existsSync.mockImplementation((path: fs.PathLike) => {
        const p = String(path);
        if (p.includes('node_modules')) return false;
        if (p.includes('.hyperneo/sdk')) return false;
        return originalExistsSync(p);
      });

      let registryCalled = false;
      curlMock((file: string, args?: string[]) => {
        if (file === 'curl') {
          const url = Array.isArray(args) ? args.find((a) => a.includes('registry.npmjs.org')) : '';
          if (url) {
            registryCalled = true;
            throw new Error('network error simulating registry failure');
          }
          return originalExecFileSync(file, args);
        }
        throw new Error(`unexpected execFileSync: ${file}`);
      });

      const result = (await warmupSDKCliBinary()).path;

      expect(registryCalled).toBe(true);
      expect(result).toBeUndefined();
    });

    it('verifies integrity hash before extracting', async () => {
      const originalExistsSync = mocks.actualFs.existsSync;

      const tarData = createTarGzWithFile(`package/${getCliBinaryName()}`, Buffer.from('fake'));
      const expectedIntegrity = `sha512-${createHash('sha512').update(tarData).digest('base64')}`;

      mocks.existsSync.mockImplementation((path: fs.PathLike) => {
        const p = String(path);
        if (p.includes('node_modules')) return false;
        if (p.includes('.hyperneo/sdk')) return false;
        if (p.endsWith('.tgz')) return true;
        return originalExistsSync(p);
      });

      readMock((path: fs.PathLike) => {
        const p = String(path);
        if (p.endsWith('.tgz')) {
          return Buffer.from('different-tarball-data');
        }
        return originalReadFileSync(p);
      });

      let registryFetched = false;
      curlMock((file: string, args?: string[]) => {
        if (file === 'curl') {
          const url = Array.isArray(args) ? args.find((a) => a.includes('registry.npmjs.org')) : '';
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
      });

      const result = (await warmupSDKCliBinary()).path;

      expect(registryFetched).toBe(true);
      expect(result).toBeUndefined();
    });

    it('extracts binary with pure-JS tar parser when integrity matches', async () => {
      const originalExistsSync = mocks.actualFs.existsSync;
      const binaryName = getCliBinaryName();

      const binaryContent = Buffer.from('#!/bin/bash\necho claude');
      const tarData = createTarGzWithFile(`package/${binaryName}`, binaryContent);
      const expectedIntegrity = `sha512-${createHash('sha512').update(tarData).digest('base64')}`;

      let extractedContent: Buffer | undefined;
      mocks.existsSync.mockImplementation((path: fs.PathLike) => {
        const p = String(path);
        if (p.includes('node_modules')) return false;
        if (p.includes('.hyperneo/sdk')) return false;
        if (p.endsWith('.tgz')) return true;
        return originalExistsSync(p);
      });

      readMock((path: fs.PathLike) => {
        const p = String(path);
        if (p.endsWith('.tgz')) return tarData;
        return originalReadFileSync(p);
      });

      mocks.writeFile.mockImplementation(async (path: fs.PathLike, data: unknown) => {
        const p = String(path);
        if (p.endsWith(binaryName) && !p.includes('.hyperneo')) {
          extractedContent = Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array);
        }
      });

      curlMock((file: string, args?: string[]) => {
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
      });

      const result = (await warmupSDKCliBinary()).path;

      expect(result).toBeDefined();
      expect(result!).toContain('.hyperneo/sdk');
    });

    it('fails when binary is missing from tarball', async () => {
      const originalExistsSync = mocks.actualFs.existsSync;

      const tarData = createTarGzWithFile('package/other-file.txt', Buffer.from('hello'));
      const expectedIntegrity = `sha512-${createHash('sha512').update(tarData).digest('base64')}`;

      mocks.existsSync.mockImplementation((path: fs.PathLike) => {
        const p = String(path);
        if (p.includes('node_modules')) return false;
        if (p.includes('.hyperneo/sdk')) return false;
        if (p.endsWith('.tgz')) return true;
        return originalExistsSync(p);
      });

      readMock((path: fs.PathLike) => {
        const p = String(path);
        if (p.endsWith('.tgz')) return tarData;
        return originalReadFileSync(p);
      });

      curlMock((file: string, args?: string[]) => {
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
      });

      const result = (await warmupSDKCliBinary()).path;
      expect(result).toBeUndefined();
    });
  });

  describe('_resetForTesting', () => {
    it('clears cached CLI path', () => {
      const first = resolveSDKCliPath();
      expect(first).toBeDefined();

      _resetForTesting();
      mocks.existsSync.mockReturnValue(false);
      mocks.execSync.mockImplementation(() => {
        throw new Error('not found');
      });
      mocks.execFileSync.mockImplementation(() => {
        throw new Error('not found');
      });

      const result = resolveSDKCliPath();
      expect(result).toBeUndefined();

      resetModuleMocks();
    });
  });
});

function createTarGzWithFile(fileName: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512, 0);

  header.write(fileName, 0, 'utf-8');

  header.write('0000644\0', 100, 'utf-8');

  header.write('0000000\0', 108, 'utf-8');

  header.write('0000000\0', 116, 'utf-8');

  const sizeOctal = content.length.toString(8).padStart(11, '0') + '\0';
  header.write(sizeOctal, 124, 'utf-8');

  header.write('00000000000\0', 136, 'utf-8');

  header.write('        ', 148, 'utf-8');

  header.write('0', 156, 'utf-8');

  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += header[i];
  }
  const checksumOctal = checksum.toString(8).padStart(6, '0') + '\0 ';
  header.write(checksumOctal, 148, 'utf-8');

  const contentPadded = Buffer.alloc(Math.ceil(content.length / 512) * 512, 0);
  content.copy(contentPadded);

  const endMarker = Buffer.alloc(1024, 0);

  const tarData = Buffer.concat([header, contentPadded, endMarker]);

  return zlib.gzipSync(tarData);
}

describe('warmupSDKCliBinary', () => {
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    _resetForTesting();
    mocks.chmodSync.mockImplementation(() => {});
    mocks.renameSync.mockImplementation(() => {});
    mocks.mkdirSync.mockImplementation(() => undefined as unknown as string);
    mocks.writeFileSync.mockImplementation(() => {});
    mocks.writeFile.mockImplementation(async () => {});
    // oxlint-disable-next-line no-console
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    resetModuleMocks();
    logSpy.mockRestore();
  });

  it('returns ready from node_modules in dev mode', async () => {
    const result = await warmupSDKCliBinary();

    expect(result.status).toBe('ready');
    expect(result.source).toBe('node_modules');
    expect(result.path).toBeDefined();
    expect(result.path!).toContain('@anthropic-ai');
    expect(result.packageName).toBeDefined();
    expect(result.version).toBeDefined();
  });

  it('returns ready from cache when node_modules unavailable', async () => {
    const originalExistsSync = mocks.actualFs.existsSync;
    const binaryName = getCliBinaryName();

    mocks.lstatSync.mockImplementation((path: fs.PathLike) => {
      const p = String(path);
      if (p.includes('.hyperneo/sdk') && p.endsWith(binaryName)) {
        return { isFile: () => true, size: 200000000 } as unknown as fs.Stats;
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT', path: p });
    });

    mocks.existsSync.mockImplementation((path: fs.PathLike) => {
      const p = String(path);
      if (p.includes('node_modules')) return false;
      if (p.endsWith('/rg')) return false;
      if (p.includes('.hyperneo/sdk') && p.endsWith(binaryName)) return true;
      return originalExistsSync(p);
    });

    const result = await warmupSDKCliBinary();

    expect(result.status).toBe('ready');
    expect(result.source).toBe('cache');
    expect(result.path).toContain('.hyperneo/sdk');
  });

  it('returns failed when all strategies fail', async () => {
    mocks.existsSync.mockReturnValue(false);
    mocks.execSync.mockImplementation(() => {
      throw new Error('not found');
    });
    curlMock(() => {
      throw new Error('not found');
    });

    const result = await warmupSDKCliBinary();

    expect(result.status).toBe('failed');
    expect(result.error).toBeDefined();
  });

  it('returns ready on download success when node_modules and cache miss', async () => {
    const originalExistsSync = mocks.actualFs.existsSync;
    const originalReadFileSync = mocks.actualFs.readFileSync;
    const binaryName = getCliBinaryName();

    const binaryContent = Buffer.from('#!/bin/bash\necho claude');
    const tarData = createTarGzWithFile(`package/${binaryName}`, binaryContent);
    const expectedIntegrity = `sha512-${createHash('sha512').update(tarData).digest('base64')}`;

    mocks.existsSync.mockImplementation((path: fs.PathLike) => {
      const p = String(path);
      if (p.includes('node_modules')) return false;
      if (p.includes('.hyperneo/sdk')) return false;
      if (p.endsWith('.tgz')) return true;
      return originalExistsSync(p);
    });

    readMock((path: fs.PathLike) => {
      const p = String(path);
      if (p.endsWith('.tgz')) return tarData;
      return originalReadFileSync(p);
    });

    curlMock((file: string, args?: string[]) => {
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
    });

    const result = await warmupSDKCliBinary();

    expect(result.status).toBe('ready');
    expect(result.source).toBe('download');
    expect(result.path).toContain('.hyperneo/sdk');
  });

  it('keeps the event loop responsive while it downloads the binary', async () => {
    const originalExistsSync = mocks.actualFs.existsSync;
    const binaryName = getCliBinaryName();
    const tarData = createTarGzWithFile(`package/${binaryName}`, Buffer.from('claude'));
    const integrity = `sha512-${createHash('sha512').update(tarData).digest('base64')}`;
    const curl = (args: string[]) =>
      !args.includes('-o')
        ? JSON.stringify({ dist: { tarball: 'https://registry.npmjs.org/fake.tgz', integrity } })
        : '';

    mocks.existsSync.mockImplementation((path: fs.PathLike) => {
      const p = String(path);
      if (p.includes('node_modules') || p.includes('.hyperneo/sdk')) return false;
      if (p.endsWith('.tgz')) return true;
      return originalExistsSync(p);
    });
    mocks.readFileSync.mockImplementation((path: fs.PathLike) =>
      String(path).endsWith('.tgz') ? tarData : mocks.actualFs.readFileSync(path)
    );
    mocks.readFile.mockImplementation(async () => tarData);
    mocks.writeFile.mockImplementation(async () => {});
    mocks.execFileSync.mockImplementation((_file: string, args: string[]) => {
      const until = Date.now() + 200;
      while (Date.now() < until);
      return curl(args);
    });
    mocks.execFile.mockImplementation(
      (_file: string, args: string[], _options: unknown, done: (...r: unknown[]) => void) =>
        setTimeout(() => done(null, curl(args), ''), 200)
    );

    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const result = await warmupSDKCliBinary();
    clearInterval(timer);

    expect(result.status).toBe('ready');
    expect(result.source).toBe('download');
    expect(ticks).toBeGreaterThan(10);
  });

  it('lets a session started during the first download wait for it and get the binary', async () => {
    const originalExistsSync = mocks.actualFs.existsSync;
    const tarData = createTarGzWithFile(`package/${getCliBinaryName()}`, Buffer.from('claude'));
    const integrity = `sha512-${createHash('sha512').update(tarData).digest('base64')}`;
    mocks.existsSync.mockImplementation((path: fs.PathLike) => {
      const p = String(path);
      if (p.includes('node_modules') || p.includes('.hyperneo/sdk')) return false;
      if (p.endsWith('.tgz')) return true;
      return originalExistsSync(p);
    });
    readMock((path: fs.PathLike) =>
      String(path).endsWith('.tgz') ? tarData : mocks.actualFs.readFileSync(path)
    );
    let curlCalls = 0;
    curlMock((_file, args) => {
      curlCalls++;
      return args?.includes('-o')
        ? ''
        : JSON.stringify({ dist: { tarball: 'https://registry.npmjs.org/f.tgz', integrity } });
    });

    const startup = warmupSDKCliBinary();
    const session = awaitSDKCliPath();

    expect(await session).toContain('.hyperneo/sdk');
    expect((await startup).status).toBe('ready');
    expect(curlCalls).toBe(2);
  });

  it('gives a session one clear error when the download fails', async () => {
    mocks.existsSync.mockImplementation((path: fs.PathLike) => {
      const p = String(path);
      if (p.includes('node_modules') || p.includes('.hyperneo/sdk')) return false;
      return mocks.actualFs.existsSync(p);
    });
    curlMock(() => {
      throw new Error('offline');
    });

    const startup = warmupSDKCliBinary();

    await expect(awaitSDKCliPath()).rejects.toThrow(
      'Claude Code binary unavailable: All resolution strategies failed (node_modules, cache, download)'
    );
    expect((await startup).status).toBe('failed');
  });

  it('logs startup messages regardless of HYPERNEO_VERBOSE', async () => {
    delete process.env.HYPERNEO_VERBOSE;

    await warmupSDKCliBinary();

    const calls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    const sdkLogs = calls.filter((c: string) => c.includes('[SDK]'));
    expect(sdkLogs.length).toBeGreaterThan(0);
  });

  it('returns cached result on second call without re-resolving', async () => {
    const first = await warmupSDKCliBinary();
    expect(first.status).toBe('ready');

    logSpy.mockClear();

    const second = await warmupSDKCliBinary();
    expect(second.status).toBe('ready');
    expect(second.path).toBe(first.path);
  });

  it('populates cachedCliPath so subsequent resolveSDKCliPath is instant', async () => {
    await warmupSDKCliBinary();

    const resolved = resolveSDKCliPath();
    expect(resolved).toBeDefined();
  });

  it('does not set negative cache on failure, allowing resolveSDKCliPath to retry', async () => {
    mocks.existsSync.mockReturnValue(false);
    mocks.execSync.mockImplementation(() => {
      throw new Error('not found');
    });
    curlMock(() => {
      throw new Error('not found');
    });

    const result = await warmupSDKCliBinary();
    expect(result.status).toBe('failed');

    resetModuleMocks();

    const resolved = resolveSDKCliPath();
    expect(resolved).toBeDefined();
  });

  it('returns failed for unsupported platform', async () => {
    mocks.existsSync.mockReturnValue(false);
    mocks.execSync.mockImplementation(() => {
      throw new Error('not found');
    });
    curlMock(() => {
      throw new Error('not found');
    });

    const result = await warmupSDKCliBinary();

    expect(result.status).toBe('failed');
    expect(result.error).toBeDefined();
    expect(result.version).toBeDefined();
  });

  it('handles sequential warmup calls correctly (mutex releases)', async () => {
    const first = await warmupSDKCliBinary();
    expect(first.status).toBe('ready');

    const second = await warmupSDKCliBinary();
    expect(second.status).toBe('ready');
    expect(second.path).toBe(first.path);
  });
});
