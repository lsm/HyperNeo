import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { createTables } from '../../../../src/storage/schema';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';
import { AppMcpServerRepository } from '../../../../src/storage/repositories/app-mcp-server-repository';
import type { ReactiveDatabase } from '../../../../src/storage/reactive-database';

describe('AppMcpServerRepository', () => {
  let bunDb: BunDatabase;
  let reactiveDb: ReactiveDatabase;
  let repo: AppMcpServerRepository;
  let notifyChangeSpy: ReturnType<typeof mock>;

  beforeEach(() => {
    bunDb = new BunDatabase(':memory:');
    createTables(bunDb);

    reactiveDb = createReactiveDatabase({ getDatabase: () => bunDb } as never);

    notifyChangeSpy = mock(() => {});
    reactiveDb.notifyChange = notifyChangeSpy;

    repo = new AppMcpServerRepository(bunDb, reactiveDb);
  });

  afterEach(() => {
    bunDb.close();
  });

  describe('create', () => {
    test('creates a stdio server entry and returns it', () => {
      const server = repo.create({
        name: 'test-search',
        sourceType: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-test-search'],
        env: { TEST_API_KEY: 'TEST_API_KEY' },
      });

      expect(server.id).toBeTruthy();
      expect(server.name).toBe('test-search');
      expect(server.sourceType).toBe('stdio');
      expect(server.command).toBe('npx');
      expect(server.args).toEqual(['-y', '@modelcontextprotocol/server-test-search']);
      expect(server.env).toEqual({ TEST_API_KEY: 'TEST_API_KEY' });
      expect(server.enabled).toBe(true);
      expect(server.createdAt).toBeTruthy();
      expect(server.updatedAt).toBeTruthy();
    });

    test('defaults enabled to true when omitted', () => {
      const server = repo.create({ name: 'default-enabled', sourceType: 'stdio' });
      expect(server.enabled).toBe(true);
    });

    test('respects explicit enabled: false', () => {
      const server = repo.create({ name: 'off', sourceType: 'stdio', enabled: false });
      expect(server.enabled).toBe(false);
    });

    test('creates an SSE server entry', () => {
      const server = repo.create({
        name: 'sse-server',
        sourceType: 'sse',
        url: 'http://localhost:8080/sse',
        headers: { Authorization: 'Bearer token' },
      });

      expect(server.sourceType).toBe('sse');
      expect(server.url).toBe('http://localhost:8080/sse');
      expect(server.headers).toEqual({ Authorization: 'Bearer token' });
    });

    test('creates an HTTP server entry', () => {
      const server = repo.create({
        name: 'http-server',
        sourceType: 'http',
        url: 'http://localhost:9000',
        enabled: false,
      });

      expect(server.sourceType).toBe('http');
      expect(server.enabled).toBe(false);
    });

    test('omits optional fields when not provided', () => {
      const server = repo.create({ name: 'minimal', sourceType: 'stdio' });

      expect(server.description).toBeUndefined();
      expect(server.command).toBeUndefined();
      expect(server.args).toBeUndefined();
      expect(server.env).toBeUndefined();
      expect(server.url).toBeUndefined();
      expect(server.headers).toBeUndefined();
    });

    test('throws when name is already taken', () => {
      repo.create({ name: 'duplicate', sourceType: 'stdio' });
      expect(() => repo.create({ name: 'duplicate', sourceType: 'sse', url: 'http://x' })).toThrow(
        'already exists'
      );
    });

    test('throws when sourceType is invalid', () => {
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        repo.create({ name: 'bad-type', sourceType: 'docker' as any })
      ).toThrow('Invalid sourceType');
    });

    test('calls notifyChange("app_mcp_servers") after create', () => {
      notifyChangeSpy.mockClear();
      repo.create({ name: 'notify-test', sourceType: 'stdio' });
      expect(notifyChangeSpy).toHaveBeenCalledTimes(1);
      expect(notifyChangeSpy).toHaveBeenCalledWith('app_mcp_servers');
    });
  });

  describe('isNameTaken', () => {
    test('returns false when name is not in use', () => {
      expect(repo.isNameTaken('unused')).toBe(false);
    });

    test('returns true when name is taken', () => {
      repo.create({ name: 'taken', sourceType: 'stdio' });
      expect(repo.isNameTaken('taken')).toBe(true);
    });

    test('returns false when name is taken by the excluded id (self-rename)', () => {
      const server = repo.create({ name: 'self', sourceType: 'stdio' });
      expect(repo.isNameTaken('self', server.id)).toBe(false);
    });

    test('returns true when name is taken by a different id', () => {
      repo.create({ name: 'other', sourceType: 'stdio' });
      const server2 = repo.create({ name: 'server2', sourceType: 'stdio' });
      expect(repo.isNameTaken('other', server2.id)).toBe(true);
    });
  });

  describe('get', () => {
    test('returns server by id', () => {
      const created = repo.create({ name: 'get-test', sourceType: 'stdio' });
      const fetched = repo.get(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
    });

    test('returns null for unknown id', () => {
      expect(repo.get('nonexistent-id')).toBeNull();
    });
  });

  describe('getByName', () => {
    test('returns server by name', () => {
      repo.create({ name: 'named-server', sourceType: 'http', url: 'http://x' });
      const found = repo.getByName('named-server');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('named-server');
    });

    test('returns null for unknown name', () => {
      expect(repo.getByName('no-such-server')).toBeNull();
    });
  });

  describe('list', () => {
    test('returns all servers ordered by created_at', () => {
      repo.create({ name: 'alpha', sourceType: 'stdio' });
      repo.create({ name: 'beta', sourceType: 'stdio', enabled: false });
      repo.create({ name: 'gamma', sourceType: 'http', url: 'http://g' });

      const all = repo.list();
      expect(all).toHaveLength(3);
      const names = all.map((s) => s.name);
      expect(names).toContain('alpha');
      expect(names).toContain('beta');
      expect(names).toContain('gamma');
    });

    test('returns empty array when no servers exist', () => {
      expect(repo.list()).toHaveLength(0);
    });

    test('rows with null created_at sort after rows with a timestamp', () => {
      const nullId = 'null-created';
      bunDb.exec(
        `INSERT INTO app_mcp_servers (id, name, source_type, enabled) VALUES ('${nullId}', 'null-ts', 'stdio', 1)`
      );
      repo.create({ name: 'real-ts', sourceType: 'stdio' });

      const all = repo.list();
      expect(all[0].name).toBe('real-ts');
      expect(all[1].name).toBe('null-ts');
    });
  });

  describe('listEnabled', () => {
    test('returns only enabled servers', () => {
      repo.create({ name: 'enabled-1', sourceType: 'stdio' });
      repo.create({ name: 'disabled-1', sourceType: 'stdio', enabled: false });
      repo.create({ name: 'enabled-2', sourceType: 'http', url: 'http://e2' });

      const enabled = repo.listEnabled();
      expect(enabled).toHaveLength(2);
      expect(enabled.every((s) => s.enabled)).toBe(true);
      const names = enabled.map((s) => s.name);
      expect(names).toContain('enabled-1');
      expect(names).toContain('enabled-2');
      expect(names).not.toContain('disabled-1');
    });

    test('returns empty array when no enabled servers', () => {
      repo.create({ name: 'off', sourceType: 'stdio', enabled: false });
      expect(repo.listEnabled()).toHaveLength(0);
    });
  });

  describe('update', () => {
    test('updates name and description', () => {
      const server = repo.create({ name: 'old-name', sourceType: 'stdio' });
      const updated = repo.update(server.id, { name: 'new-name', description: 'A description' });

      expect(updated).not.toBeNull();
      expect(updated!.name).toBe('new-name');
      expect(updated!.description).toBe('A description');
    });

    test('updates enabled flag', () => {
      const server = repo.create({ name: 'toggle', sourceType: 'stdio' });
      const updated = repo.update(server.id, { enabled: false });

      expect(updated!.enabled).toBe(false);
    });

    test('updates args and env as JSON', () => {
      const server = repo.create({ name: 'json-fields', sourceType: 'stdio', command: 'node' });
      const updated = repo.update(server.id, {
        args: ['--port', '3000'],
        env: { PORT: '3000' },
      });

      expect(updated!.args).toEqual(['--port', '3000']);
      expect(updated!.env).toEqual({ PORT: '3000' });
    });

    test('returns null for unknown id', () => {
      expect(repo.update('nonexistent', { name: 'x' })).toBeNull();
    });

    test('throws when new name is already taken by another entry', () => {
      repo.create({ name: 'existing', sourceType: 'stdio' });
      const server = repo.create({ name: 'rename-me', sourceType: 'stdio' });
      expect(() => repo.update(server.id, { name: 'existing' })).toThrow('already exists');
    });

    test('allows renaming to its own current name (self-rename)', () => {
      const server = repo.create({ name: 'same-name', sourceType: 'stdio' });
      const updated = repo.update(server.id, { name: 'same-name', description: 'changed' });
      expect(updated!.name).toBe('same-name');
      expect(updated!.description).toBe('changed');
    });

    test('throws when sourceType update is invalid', () => {
      const server = repo.create({ name: 'bad-update', sourceType: 'stdio' });
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        repo.update(server.id, { sourceType: 'docker' as any })
      ).toThrow('Invalid sourceType');
    });

    test('calls notifyChange("app_mcp_servers") after update', () => {
      const server = repo.create({ name: 'notify-update', sourceType: 'stdio' });
      notifyChangeSpy.mockClear();
      repo.update(server.id, { description: 'updated' });
      expect(notifyChangeSpy).toHaveBeenCalledTimes(1);
      expect(notifyChangeSpy).toHaveBeenCalledWith('app_mcp_servers');
    });

    test('does not call notifyChange when no fields are changed', () => {
      const server = repo.create({ name: 'no-change', sourceType: 'stdio' });
      notifyChangeSpy.mockClear();
      repo.update(server.id, {});
      expect(notifyChangeSpy).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    test('deletes an existing entry and returns true', () => {
      const server = repo.create({ name: 'to-delete', sourceType: 'stdio' });
      const result = repo.delete(server.id);

      expect(result).toBe(true);
      expect(repo.get(server.id)).toBeNull();
    });

    test('returns false for unknown id', () => {
      expect(repo.delete('nonexistent')).toBe(false);
    });

    test('calls notifyChange("app_mcp_servers") after delete', () => {
      const server = repo.create({ name: 'notify-delete', sourceType: 'stdio' });
      notifyChangeSpy.mockClear();
      repo.delete(server.id);
      expect(notifyChangeSpy).toHaveBeenCalledTimes(1);
      expect(notifyChangeSpy).toHaveBeenCalledWith('app_mcp_servers');
    });

    test('does not call notifyChange when deleting nonexistent id', () => {
      notifyChangeSpy.mockClear();
      repo.delete('nonexistent');
      expect(notifyChangeSpy).not.toHaveBeenCalled();
    });
  });

  describe('source + sourcePath', () => {
    test('defaults source to "user" when omitted', () => {
      const server = repo.create({ name: 'no-source', sourceType: 'stdio' });
      expect(server.source).toBe('user');
      expect(server.sourcePath).toBeUndefined();
    });

    test('round-trips source="builtin"', () => {
      const server = repo.create({ name: 'seed', sourceType: 'stdio', source: 'builtin' });
      expect(server.source).toBe('builtin');
      expect(repo.getByName('seed')!.source).toBe('builtin');
    });

    test('round-trips source="imported" with sourcePath', () => {
      const server = repo.create({
        name: 'imported-one',
        sourceType: 'stdio',
        command: 'echo',
        source: 'imported',
        sourcePath: '/abs/.mcp.json',
      });
      expect(server.source).toBe('imported');
      expect(server.sourcePath).toBe('/abs/.mcp.json');
    });

    test('rejects invalid source values', () => {
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        repo.create({ name: 'bad', sourceType: 'stdio', source: 'vendor' as any })
      ).toThrow('Invalid source');
    });

    test('legacy rows with NULL source are exposed as "user"', () => {
      bunDb.exec(`ALTER TABLE app_mcp_servers RENAME TO app_mcp_servers_strict`);
      bunDb.exec(`
				CREATE TABLE app_mcp_servers (
					id TEXT PRIMARY KEY,
					name TEXT UNIQUE NOT NULL,
					description TEXT,
					source_type TEXT NOT NULL CHECK(source_type IN ('stdio', 'sse', 'http')),
					command TEXT,
					args TEXT,
					env TEXT,
					url TEXT,
					headers TEXT,
					enabled INTEGER NOT NULL DEFAULT 1,
					source TEXT,
					source_path TEXT,
					created_at INTEGER,
					updated_at INTEGER
				)
			`);
      bunDb.exec(
        `INSERT INTO app_mcp_servers (id, name, source_type, enabled, source)
				 VALUES ('legacy-id', 'legacy-row', 'stdio', 1, NULL)`
      );
      const row = repo.getByName('legacy-row');
      expect(row).not.toBeNull();
      expect(row!.source).toBe('user');
    });

    test('update allows transitioning source from imported → user', () => {
      const server = repo.create({
        name: 'claim-me',
        sourceType: 'stdio',
        command: 'node',
        source: 'imported',
        sourcePath: '/abs/.mcp.json',
      });
      const updated = repo.update(server.id, { source: 'user', sourcePath: undefined });
      expect(updated!.source).toBe('user');
      expect(updated!.sourcePath).toBeUndefined();
    });

    test('listBySourcePath returns only imported rows for that path', () => {
      repo.create({
        name: 'imp-a',
        sourceType: 'stdio',
        command: 'x',
        source: 'imported',
        sourcePath: '/ws/.mcp.json',
      });
      repo.create({
        name: 'imp-b',
        sourceType: 'stdio',
        command: 'y',
        source: 'imported',
        sourcePath: '/ws/.mcp.json',
      });
      repo.create({
        name: 'imp-other-path',
        sourceType: 'stdio',
        command: 'z',
        source: 'imported',
        sourcePath: '/other/.mcp.json',
      });
      repo.create({ name: 'user-row', sourceType: 'stdio', command: 'u' });

      const rows = repo.listBySourcePath('/ws/.mcp.json');
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.name).sort()).toEqual(['imp-a', 'imp-b']);
    });

    test('listImported returns only source="imported" rows', () => {
      repo.create({ name: 'user-only', sourceType: 'stdio' });
      repo.create({ name: 'builtin-only', sourceType: 'stdio', source: 'builtin' });
      repo.create({
        name: 'imp-1',
        sourceType: 'stdio',
        command: 'x',
        source: 'imported',
        sourcePath: '/p1/.mcp.json',
      });
      repo.create({
        name: 'imp-2',
        sourceType: 'stdio',
        command: 'y',
        source: 'imported',
        sourcePath: '/p2/.mcp.json',
      });
      const imp = repo.listImported();
      expect(imp).toHaveLength(2);
      expect(imp.every((r) => r.source === 'imported')).toBe(true);
    });

    test('getImportedByPathAndName returns the unique imported row', () => {
      repo.create({
        name: 'lookup',
        sourceType: 'stdio',
        command: 'x',
        source: 'imported',
        sourcePath: '/ws/.mcp.json',
      });
      const found = repo.getImportedByPathAndName('/ws/.mcp.json', 'lookup');
      expect(found).not.toBeNull();
      expect(found!.source).toBe('imported');
      expect(found!.sourcePath).toBe('/ws/.mcp.json');
    });

    test('getImportedByPathAndName returns null for unrelated path', () => {
      repo.create({
        name: 'somewhere',
        sourceType: 'stdio',
        command: 'x',
        source: 'imported',
        sourcePath: '/a/.mcp.json',
      });
      expect(repo.getImportedByPathAndName('/b/.mcp.json', 'somewhere')).toBeNull();
    });

    test('partial unique index on (source_path, name) WHERE source=imported is created', () => {
      const idx = bunDb
        .prepare(
          `SELECT sql FROM sqlite_master
					 WHERE type='index' AND name='idx_app_mcp_servers_import'`
        )
        .get() as { sql: string } | undefined;
      expect(idx).toBeTruthy();
      expect(idx!.sql).toMatch(/source_path/);
      expect(idx!.sql).toMatch(/name/);
      expect(idx!.sql).toMatch(/source = 'imported'/);
    });
  });
});
