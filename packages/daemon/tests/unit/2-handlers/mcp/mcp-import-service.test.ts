import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTables } from '../../../../src/storage/schema';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';
import { AppMcpServerRepository } from '../../../../src/storage/repositories/app-mcp-server-repository';
import { McpImportService } from '../../../../src/lib/mcp/mcp-import-service';
import type { ReactiveDatabase } from '../../../../src/storage/reactive-database';
import type { Database } from '../../../../src/storage/database';

function buildTestDb(): {
  bunDb: BunDatabase;
  reactiveDb: ReactiveDatabase;
  repo: AppMcpServerRepository;
  db: Database;
} {
  const bunDb = new BunDatabase(':memory:');
  createTables(bunDb);
  const reactiveDb = createReactiveDatabase({ getDatabase: () => bunDb } as never);
  const repo = new AppMcpServerRepository(bunDb, reactiveDb);
  const db = { appMcpServers: repo } as unknown as Database;
  return { bunDb, reactiveDb, repo, db };
}

function writeMcpJson(path: string, payload: unknown): void {
  writeFileSync(path, JSON.stringify(payload, null, 2), 'utf-8');
}

describe('McpImportService', () => {
  let bunDb: BunDatabase;
  let repo: AppMcpServerRepository;
  let service: McpImportService;
  let tmpRoot: string;

  beforeEach(() => {
    const h = buildTestDb();
    bunDb = h.bunDb;
    repo = h.repo;
    service = new McpImportService(h.db);
    tmpRoot = mkdtempSync(join(tmpdir(), 'mcp-import-test-'));
    process.env.TEST_USER_SETTINGS_DIR = tmpRoot;
  });

  afterEach(() => {
    delete process.env.TEST_USER_SETTINGS_DIR;
    bunDb.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('refreshFromFile', () => {
    test('imports new entries with source=imported and enabled=false', () => {
      const file = join(tmpRoot, '.mcp.json');
      writeMcpJson(file, {
        mcpServers: {
          'dummy-test-server': { command: 'echo', args: ['test-server'] },
        },
      });

      const result = service.refreshFromFile(file);

      expect(result.status).toBe('ok');
      expect(result.added).toBe(1);
      expect(result.updated).toBe(0);
      expect(result.removed).toBe(0);

      const row = repo.getByName('dummy-test-server');
      expect(row).not.toBeNull();
      expect(row!.source).toBe('imported');
      expect(row!.sourcePath).toBe(file);
      expect(row!.enabled).toBe(false);
      expect(row!.command).toBe('echo');
      expect(row!.args).toEqual(['test-server']);
    });

    test('is idempotent when the file is unchanged (re-scan is no-op)', () => {
      const file = join(tmpRoot, '.mcp.json');
      writeMcpJson(file, {
        mcpServers: { stable: { command: 'node', args: ['server.js'] } },
      });

      const first = service.refreshFromFile(file);
      expect(first.added).toBe(1);

      const second = service.refreshFromFile(file);
      expect(second.added).toBe(0);
      expect(second.updated).toBe(0);
      expect(second.removed).toBe(0);

      expect(repo.listBySourcePath(file)).toHaveLength(1);
    });

    test('updates rows whose config drifted on disk', () => {
      const file = join(tmpRoot, '.mcp.json');
      writeMcpJson(file, {
        mcpServers: { drift: { command: 'node', args: ['v1.js'] } },
      });
      service.refreshFromFile(file);

      writeMcpJson(file, {
        mcpServers: { drift: { command: 'node', args: ['v2.js'] } },
      });
      const result = service.refreshFromFile(file);

      expect(result.added).toBe(0);
      expect(result.updated).toBe(1);
      expect(result.removed).toBe(0);

      const row = repo.getByName('drift');
      expect(row!.args).toEqual(['v2.js']);
    });

    test('removes rows whose name disappeared from the file', () => {
      const file = join(tmpRoot, '.mcp.json');
      writeMcpJson(file, {
        mcpServers: {
          keep: { command: 'a' },
          drop: { command: 'b' },
        },
      });
      service.refreshFromFile(file);
      expect(repo.listBySourcePath(file)).toHaveLength(2);

      writeMcpJson(file, { mcpServers: { keep: { command: 'a' } } });
      const result = service.refreshFromFile(file);

      expect(result.removed).toBe(1);
      expect(repo.getByName('drop')).toBeNull();
      expect(repo.getByName('keep')).not.toBeNull();
    });

    test('treats rename as remove + add (new row has new name)', () => {
      const file = join(tmpRoot, '.mcp.json');
      writeMcpJson(file, {
        mcpServers: { 'old-name': { command: 'node' } },
      });
      service.refreshFromFile(file);

      writeMcpJson(file, {
        mcpServers: { 'new-name': { command: 'node' } },
      });
      const result = service.refreshFromFile(file);

      expect(result.added).toBe(1);
      expect(result.removed).toBe(1);
      expect(repo.getByName('old-name')).toBeNull();
      expect(repo.getByName('new-name')).not.toBeNull();
      expect(repo.getByName('new-name')!.enabled).toBe(false);
    });

    test('missing file prunes rows previously imported from that path', () => {
      const file = join(tmpRoot, '.mcp.json');
      writeMcpJson(file, { mcpServers: { 'gone-soon': { command: 'a' } } });
      service.refreshFromFile(file);
      expect(repo.listBySourcePath(file)).toHaveLength(1);

      unlinkSync(file);
      const result = service.refreshFromFile(file);

      expect(result.status).toBe('missing');
      expect(result.removed).toBe(1);
      expect(repo.listBySourcePath(file)).toHaveLength(0);
    });

    test('malformed JSON is captured in the result and does not throw', () => {
      const file = join(tmpRoot, '.mcp.json');
      writeFileSync(file, '{ not valid json', 'utf-8');

      const result = service.refreshFromFile(file);
      expect(result.status).toBe('malformed');
      expect(result.error).toContain('parse failed');
      expect(result.added).toBe(0);
    });

    test('missing "mcpServers" object is reported as malformed', () => {
      const file = join(tmpRoot, '.mcp.json');
      writeMcpJson(file, { somethingElse: {} });

      const result = service.refreshFromFile(file);
      expect(result.status).toBe('malformed');
      expect(result.error).toMatch(/mcpServers/);
    });

    test('parse failure does NOT prune existing rows (safety)', () => {
      const file = join(tmpRoot, '.mcp.json');
      writeMcpJson(file, { mcpServers: { safe: { command: 'node' } } });
      service.refreshFromFile(file);

      writeFileSync(file, '{ broken', 'utf-8');
      service.refreshFromFile(file);

      expect(repo.getByName('safe')).not.toBeNull();
    });

    test('skips entries with missing required fields', () => {
      const file = join(tmpRoot, '.mcp.json');
      writeMcpJson(file, {
        mcpServers: {
          ok: { command: 'node' },
          'bad-stdio': {},
          'bad-http': { type: 'http' },
        },
      });

      const result = service.refreshFromFile(file);
      expect(result.added).toBe(1);
      expect(repo.getByName('ok')).not.toBeNull();
      expect(repo.getByName('bad-stdio')).toBeNull();
      expect(repo.getByName('bad-http')).toBeNull();
    });

    test('imports http entries when type=http is declared', () => {
      const file = join(tmpRoot, '.mcp.json');
      writeMcpJson(file, {
        mcpServers: {
          web: {
            type: 'http',
            url: 'https://example.test/mcp',
            headers: { Authorization: 'Bearer KEY' },
          },
        },
      });

      service.refreshFromFile(file);
      const row = repo.getByName('web');
      expect(row!.sourceType).toBe('http');
      expect(row!.url).toBe('https://example.test/mcp');
      expect(row!.headers).toEqual({ Authorization: 'Bearer KEY' });
    });

    test('imports sse entries when type=sse is declared', () => {
      const file = join(tmpRoot, '.mcp.json');
      writeMcpJson(file, {
        mcpServers: { events: { type: 'sse', url: 'https://example.test/sse' } },
      });

      service.refreshFromFile(file);
      expect(repo.getByName('events')!.sourceType).toBe('sse');
    });

    test('skips when name collides with an existing user row', () => {
      repo.create({ name: 'docs', sourceType: 'stdio', command: 'my-docs' });

      const file = join(tmpRoot, '.mcp.json');
      writeMcpJson(file, {
        mcpServers: { docs: { command: 'their-docs' } },
      });
      const result = service.refreshFromFile(file);

      expect(result.added).toBe(0);
      const row = repo.getByName('docs');
      expect(row!.source).toBe('user');
      expect(row!.command).toBe('my-docs');
    });

    test('skips when name collides with a builtin row', () => {
      repo.create({
        name: 'chrome-devtools',
        sourceType: 'stdio',
        command: 'bunx',
        source: 'builtin',
      });

      const file = join(tmpRoot, '.mcp.json');
      writeMcpJson(file, {
        mcpServers: { 'chrome-devtools': { command: 'evil' } },
      });
      const result = service.refreshFromFile(file);

      expect(result.added).toBe(0);
      expect(repo.getByName('chrome-devtools')!.command).toBe('bunx');
    });

    test('claimed (source=user) rows are NOT touched on re-scan', () => {
      const file = join(tmpRoot, '.mcp.json');
      writeMcpJson(file, { mcpServers: { claimed: { command: 'orig' } } });
      service.refreshFromFile(file);

      const row = repo.getByName('claimed')!;
      repo.update(row.id, { source: 'user', sourcePath: undefined });

      writeMcpJson(file, { mcpServers: { claimed: { command: 'changed' } } });
      const result = service.refreshFromFile(file);

      expect(result.added).toBe(0);
      expect(repo.getByName('claimed')!.source).toBe('user');
      expect(repo.getByName('claimed')!.command).toBe('orig');
    });

    test('throws when given a relative path (programmer error)', () => {
      expect(() => service.refreshFromFile('./relative/.mcp.json')).toThrow(
        'requires absolute path'
      );
    });
  });

  describe('refreshAll', () => {
    test('imports user-level ~/.claude/.mcp.json in the production path (no TEST_USER_SETTINGS_DIR)', () => {
      const savedSettingsDir = process.env.TEST_USER_SETTINGS_DIR;
      delete process.env.TEST_USER_SETTINGS_DIR;
      const fakeHome = mkdtempSync(join(tmpdir(), 'fake-home-'));
      const prodService = new McpImportService(
        { appMcpServers: repo } as unknown as Database,
        fakeHome
      );
      try {
        mkdirSync(join(fakeHome, '.claude'), { recursive: true });
        writeMcpJson(join(fakeHome, '.claude', '.mcp.json'), {
          mcpServers: {
            'codebase-memory-mcp': { command: '/usr/local/bin/codebase-memory-mcp' },
          },
        });
        writeMcpJson(join(fakeHome, '.mcp.json'), {
          mcpServers: { 'decoy-buggy-path': { command: 'should-not-import' } },
        });

        const { results } = prodService.refreshAll([]);
        const userResult = results.find(
          (r) => r.sourcePath === join(fakeHome, '.claude', '.mcp.json')
        );
        expect(userResult?.added).toBe(1);

        const imported = repo.getByName('codebase-memory-mcp');
        expect(imported).not.toBeNull();
        expect(imported!.source).toBe('imported');
        expect(imported!.sourcePath).toBe(join(fakeHome, '.claude', '.mcp.json'));
        expect(repo.getByName('decoy-buggy-path')).toBeNull();
      } finally {
        rmSync(fakeHome, { recursive: true, force: true });
        if (savedSettingsDir !== undefined) process.env.TEST_USER_SETTINGS_DIR = savedSettingsDir;
      }
    });

    test('scans each workspace plus the user-level file', () => {
      const wsA = mkdtempSync(join(tmpRoot, 'ws-a-'));
      writeMcpJson(join(wsA, '.mcp.json'), {
        mcpServers: { 'a-server': { command: 'a' } },
      });
      const wsB = mkdtempSync(join(tmpRoot, 'ws-b-'));
      writeMcpJson(join(wsB, '.mcp.json'), {
        mcpServers: { 'b-server': { command: 'b' } },
      });
      writeMcpJson(join(tmpRoot, '.mcp.json'), {
        mcpServers: { 'user-server': { command: 'u' } },
      });

      const { results } = service.refreshAll([wsA, wsB]);
      expect(results).toHaveLength(3);
      expect(results.every((r) => r.status === 'ok')).toBe(true);

      expect(repo.getByName('a-server')).not.toBeNull();
      expect(repo.getByName('b-server')).not.toBeNull();
      expect(repo.getByName('user-server')).not.toBeNull();
    });

    test('prunes imported rows whose sourcePath no longer exists on disk', () => {
      const ws = mkdtempSync(join(tmpRoot, 'ws-gone-'));
      const file = join(ws, '.mcp.json');
      writeMcpJson(file, { mcpServers: { ghost: { command: 'x' } } });

      service.refreshAll([ws]);
      expect(repo.getByName('ghost')).not.toBeNull();

      rmSync(ws, { recursive: true, force: true });

      const { results, orphanPruned } = service.refreshAll([]);
      expect(results.every((r) => r.removed === 0)).toBe(true);
      expect(orphanPruned).toBe(1);
      expect(repo.getByName('ghost')).toBeNull();
    });

    test('missing workspace `.mcp.json` produces status=missing but does not prune unrelated rows', () => {
      const wsA = mkdtempSync(join(tmpRoot, 'ws-with-'));
      writeMcpJson(join(wsA, '.mcp.json'), {
        mcpServers: { present: { command: 'x' } },
      });
      const wsB = mkdtempSync(join(tmpRoot, 'ws-without-'));

      const { results } = service.refreshAll([wsA, wsB]);
      const byStatus = Object.fromEntries(results.map((r) => [r.sourcePath, r.status]));
      expect(byStatus[join(wsA, '.mcp.json')]).toBe('ok');
      expect(byStatus[join(wsB, '.mcp.json')]).toBe('missing');

      expect(repo.getByName('present')).not.toBeNull();
    });

    test('session handler module does not reference McpImportService (scan-never-on-session-create contract)', () => {
      const sessionHandlersPath = join(
        __dirname,
        '..',
        '..',
        '..',
        '..',
        'src',
        'lib',
        'rpc-handlers',
        'session-handlers.ts'
      );
      const source = readFileSync(sessionHandlersPath, 'utf-8');
      expect(source).not.toMatch(/McpImportService/);
      expect(source).not.toMatch(/mcp-import-service/);
      expect(source).not.toMatch(/\.mcp\.json/);
    });

    test('deduplicates workspace paths (same path passed twice = one scan)', () => {
      const ws = mkdtempSync(join(tmpRoot, 'ws-dup-'));
      writeMcpJson(join(ws, '.mcp.json'), {
        mcpServers: { once: { command: 'x' } },
      });
      const { results } = service.refreshAll([ws, ws]);
      expect(results).toHaveLength(2);
      expect(repo.listBySourcePath(join(ws, '.mcp.json'))).toHaveLength(1);
    });

    test('continues the sweep when one workspace file is malformed and preserves its existing rows', () => {
      const wsGood = mkdtempSync(join(tmpRoot, 'ws-good-'));
      const goodFile = join(wsGood, '.mcp.json');
      writeMcpJson(goodFile, { mcpServers: { good: { command: 'x' } } });

      const wsBad = mkdtempSync(join(tmpRoot, 'ws-bad-'));
      const badFile = join(wsBad, '.mcp.json');
      writeMcpJson(badFile, { mcpServers: { stale: { command: 'y' } } });
      service.refreshAll([wsBad]);

      writeFileSync(badFile, '{ not json', 'utf-8');

      const { results } = service.refreshAll([wsGood, wsBad]);
      const byStatus = Object.fromEntries(results.map((r) => [r.sourcePath, r.status]));

      expect(byStatus[goodFile]).toBe('ok');
      expect(byStatus[badFile]).toBe('malformed');
      expect(repo.getByName('good')).not.toBeNull();
      expect(repo.getByName('stale')).not.toBeNull();
      expect(repo.getByName('stale')!.sourcePath).toBe(badFile);
    });
  });
});
