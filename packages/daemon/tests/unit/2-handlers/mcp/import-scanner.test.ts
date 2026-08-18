import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTables } from '../../../../src/storage/schema';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';
import { AppMcpServerRepository } from '../../../../src/storage/repositories/app-mcp-server-repository';
import type { ReactiveDatabase } from '../../../../src/storage/reactive-database';
import { scanMcpImports, buildMcpJsonPaths } from '../../../../src/lib/mcp/import-scanner';

describe('import-scanner', () => {
  let bunDb: BunDatabase;
  let reactiveDb: ReactiveDatabase;
  let repo: AppMcpServerRepository;
  let tmpRoot: string;

  beforeEach(() => {
    bunDb = new BunDatabase(':memory:');
    createTables(bunDb);
    reactiveDb = createReactiveDatabase({ getDatabase: () => bunDb } as never);
    repo = new AppMcpServerRepository(bunDb, reactiveDb);
    tmpRoot = mkdtempSync(join(tmpdir(), 'mcp-import-scanner-'));
  });

  afterEach(() => {
    bunDb.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeMcpJson(relPath: string, body: object): string {
    const fullPath = join(tmpRoot, relPath);
    mkdirSync(join(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, JSON.stringify(body, null, 2), 'utf-8');
    return fullPath;
  }

  describe('scanMcpImports', () => {
    test('inserts imported rows for stdio entries', async () => {
      const p = writeMcpJson('repo/.mcp.json', {
        mcpServers: {
          fetch: { command: 'npx', args: ['-y', '@mcp/fetch'] },
        },
      });

      const result = await scanMcpImports(repo, { mcpJsonPaths: [p] });

      expect(result.imported).toBe(1);
      expect(result.removed).toBe(0);
      const row = repo.getByName('fetch');
      expect(row).toBeTruthy();
      expect(row!.source).toBe('imported');
      expect(row!.sourcePath).toBe(p);
      expect(row!.sourceType).toBe('stdio');
      expect(row!.command).toBe('npx');
      expect(row!.args).toEqual(['-y', '@mcp/fetch']);
      expect(row!.enabled).toBe(true);
    });

    test('infers http sourceType when url is set but no type', async () => {
      const p = writeMcpJson('repo/.mcp.json', {
        mcpServers: {
          remote: { url: 'https://example.com/mcp' },
        },
      });

      await scanMcpImports(repo, { mcpJsonPaths: [p] });
      const row = repo.getByName('remote');
      expect(row?.sourceType).toBe('http');
      expect(row?.url).toBe('https://example.com/mcp');
    });

    test('honors explicit type sse', async () => {
      const p = writeMcpJson('repo/.mcp.json', {
        mcpServers: {
          sseServer: { type: 'sse', url: 'https://sse.example.com' },
        },
      });

      await scanMcpImports(repo, { mcpJsonPaths: [p] });
      expect(repo.getByName('sseServer')?.sourceType).toBe('sse');
    });

    test('is idempotent — rescanning unchanged file does not produce updates', async () => {
      const p = writeMcpJson('repo/.mcp.json', {
        mcpServers: { fetch: { command: 'npx', args: ['-y', '@mcp/fetch'] } },
      });

      const first = await scanMcpImports(repo, { mcpJsonPaths: [p] });
      expect(first.imported).toBe(1);

      const second = await scanMcpImports(repo, { mcpJsonPaths: [p] });
      expect(second.imported).toBe(0);
      expect(second.removed).toBe(0);
    });

    test('updates existing imported row when command/args change', async () => {
      const p = writeMcpJson('repo/.mcp.json', {
        mcpServers: { changer: { command: 'old', args: ['v1'] } },
      });
      await scanMcpImports(repo, { mcpJsonPaths: [p] });

      writeFileSync(
        p,
        JSON.stringify({ mcpServers: { changer: { command: 'new', args: ['v2'] } } })
      );
      const second = await scanMcpImports(repo, { mcpJsonPaths: [p] });

      expect(second.imported).toBe(1);
      const row = repo.getByName('changer');
      expect(row?.command).toBe('new');
      expect(row?.args).toEqual(['v2']);
    });

    test('removes imported rows whose source file was scanned but no longer lists them', async () => {
      const p = writeMcpJson('repo/.mcp.json', {
        mcpServers: { alpha: { command: 'a' }, beta: { command: 'b' } },
      });
      await scanMcpImports(repo, { mcpJsonPaths: [p] });
      expect(repo.getByName('alpha')).toBeTruthy();
      expect(repo.getByName('beta')).toBeTruthy();

      writeFileSync(p, JSON.stringify({ mcpServers: { beta: { command: 'b' } } }));
      const result = await scanMcpImports(repo, { mcpJsonPaths: [p] });

      expect(result.removed).toBe(1);
      expect(repo.getByName('alpha')).toBeNull();
      expect(repo.getByName('beta')).toBeTruthy();
    });

    test('does not remove imported rows whose sourcePath was NOT scanned', async () => {
      const p1 = writeMcpJson('repo1/.mcp.json', {
        mcpServers: { one: { command: 'x' } },
      });
      const p2 = writeMcpJson('repo2/.mcp.json', {
        mcpServers: { two: { command: 'y' } },
      });
      await scanMcpImports(repo, { mcpJsonPaths: [p1, p2] });

      writeFileSync(p1, JSON.stringify({ mcpServers: {} }));
      const result = await scanMcpImports(repo, { mcpJsonPaths: [p1] });

      expect(result.removed).toBe(1);
      expect(repo.getByName('one')).toBeNull();
      expect(repo.getByName('two')).toBeTruthy();
    });

    test('does not touch user or builtin rows', async () => {
      repo.create({ name: 'user-entry', sourceType: 'stdio', command: 'ok', source: 'user' });
      repo.create({
        name: 'builtin-entry',
        sourceType: 'stdio',
        command: 'ok',
        source: 'builtin',
      });

      const p = writeMcpJson('repo/.mcp.json', { mcpServers: {} });
      const result = await scanMcpImports(repo, { mcpJsonPaths: [p] });

      expect(result.removed).toBe(0);
      expect(repo.getByName('user-entry')).toBeTruthy();
      expect(repo.getByName('builtin-entry')).toBeTruthy();
    });

    test('name collision with a user row is skipped and noted', async () => {
      repo.create({
        name: 'shared-name',
        sourceType: 'stdio',
        command: 'user-cmd',
        source: 'user',
      });

      const p = writeMcpJson('repo/.mcp.json', {
        mcpServers: { 'shared-name': { command: 'imported-cmd' } },
      });
      const result = await scanMcpImports(repo, { mcpJsonPaths: [p] });

      expect(repo.getByName('shared-name')?.source).toBe('user');
      expect(repo.getByName('shared-name')?.command).toBe('user-cmd');
      expect(result.imported).toBe(0);
      expect(result.notes.some((n) => n.includes('shared-name'))).toBe(true);
    });

    test('quietly skips missing files (no error, no note)', async () => {
      const missing = join(tmpRoot, 'does-not-exist/.mcp.json');
      const result = await scanMcpImports(repo, { mcpJsonPaths: [missing] });
      expect(result.imported).toBe(0);
      expect(result.removed).toBe(0);
      expect(result.notes).toEqual([]);
    });

    test('records a parse-error note for malformed JSON', async () => {
      const p = join(tmpRoot, 'bad.mcp.json');
      writeFileSync(p, '{ not valid json ', 'utf-8');

      const result = await scanMcpImports(repo, { mcpJsonPaths: [p] });
      expect(result.imported).toBe(0);
      expect(result.notes.some((n) => n.includes('parse error'))).toBe(true);
    });

    test('notes unknown-shape entries without inserting', async () => {
      const p = writeMcpJson('repo/.mcp.json', {
        mcpServers: { weird: { notes: 'no command or url' } },
      });
      const result = await scanMcpImports(repo, { mcpJsonPaths: [p] });
      expect(result.imported).toBe(0);
      expect(result.notes.some((n) => n.includes('unknown shape'))).toBe(true);
    });

    test('returns zero when the file has no mcpServers block', async () => {
      const p = writeMcpJson('repo/.mcp.json', {});
      const result = await scanMcpImports(repo, { mcpJsonPaths: [p] });
      expect(result.imported).toBe(0);
      expect(result.removed).toBe(0);
    });
  });

  describe('buildMcpJsonPaths', () => {
    test('includes ~/.claude/.mcp.json when homeDir is set', () => {
      const paths = buildMcpJsonPaths({
        workspacePaths: [],
        homeDir: '/home/user',
      });
      expect(paths).toContain('/home/user/.claude/.mcp.json');
    });

    test('joins .mcp.json onto each unique workspace path', () => {
      const paths = buildMcpJsonPaths({
        workspacePaths: ['/ws/a', '/ws/b'],
      });
      expect(paths).toContain('/ws/a/.mcp.json');
      expect(paths).toContain('/ws/b/.mcp.json');
    });

    test('dedupes duplicate paths', () => {
      const paths = buildMcpJsonPaths({
        workspacePaths: ['/ws/a', '/ws/a'],
        additional: ['/ws/a/.mcp.json'],
      });
      const count = paths.filter((p) => p === '/ws/a/.mcp.json').length;
      expect(count).toBe(1);
    });

    test('skips empty workspace strings', () => {
      const paths = buildMcpJsonPaths({
        workspacePaths: ['', '/ws/b'],
      });
      expect(paths).toEqual(['/ws/b/.mcp.json']);
    });

    test('includes additional explicit paths', () => {
      const paths = buildMcpJsonPaths({
        workspacePaths: [],
        additional: ['/custom/file.json'],
      });
      expect(paths).toContain('/custom/file.json');
    });

    test('omits home entry when homeDir is not supplied', () => {
      const paths = buildMcpJsonPaths({ workspacePaths: ['/ws'] });
      expect(paths).toEqual(['/ws/.mcp.json']);
    });
  });
});
