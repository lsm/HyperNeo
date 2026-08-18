import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { createTables } from '../../../../src/storage/schema';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';
import { AppMcpServerRepository } from '../../../../src/storage/repositories/app-mcp-server-repository';
import { seedDefaultMcpEntries } from '../../../../src/lib/mcp';
import type { ReactiveDatabase } from '../../../../src/storage/reactive-database';
import type { Database } from '../../../../src/storage/database';

function createTestDb(): { bunDb: BunDatabase; db: Database; repo: AppMcpServerRepository } {
  const bunDb = new BunDatabase(':memory:');
  createTables(bunDb);
  const reactiveDb = createReactiveDatabase({ getDatabase: () => bunDb } as never);
  const repo = new AppMcpServerRepository(bunDb, reactiveDb);
  const db = { appMcpServers: repo } as unknown as Database;
  return { bunDb, db, repo };
}

describe('seedDefaultMcpEntries', () => {
  let bunDb: BunDatabase;
  let db: Database;
  let repo: AppMcpServerRepository;

  beforeEach(() => {
    const setup = createTestDb();
    bunDb = setup.bunDb;
    db = setup.db;
    repo = setup.repo;
  });

  afterEach(() => {
    bunDb.close();
  });

  test('creates fetch-mcp entry on a fresh registry', () => {
    seedDefaultMcpEntries(db);

    const entry = repo.getByName('fetch-mcp');
    expect(entry).not.toBeNull();
    expect(entry!.name).toBe('fetch-mcp');
    expect(entry!.sourceType).toBe('stdio');
    expect(entry!.command).toBe('npx');
    expect(entry!.args).toEqual(['-y', '@tokenizin/mcp-npx-fetch']);
    expect(entry!.enabled).toBe(true);
  });

  test('fetch-mcp is enabled by default', () => {
    seedDefaultMcpEntries(db);

    const entry = repo.getByName('fetch-mcp');
    expect(entry!.enabled).toBe(true);
  });

  test('is idempotent — calling twice does not create duplicates', () => {
    seedDefaultMcpEntries(db);
    seedDefaultMcpEntries(db);

    const all = repo.list();
    const fetchEntries = all.filter((e) => e.name === 'fetch-mcp');

    expect(fetchEntries).toHaveLength(1);
  });

  test('total registry size is exactly 2 after seeding', () => {
    seedDefaultMcpEntries(db);

    expect(repo.list()).toHaveLength(2);
  });

  test('does not seed the removed Brave Search MCP entry', () => {
    seedDefaultMcpEntries(db);

    const serialized = JSON.stringify(repo.list()).toLowerCase();
    expect(repo.getByName('brave-search')).toBeNull();
    expect(serialized).not.toContain('brave');
    expect(serialized).not.toContain('server-brave-search');
  });

  test('does not overwrite a pre-existing fetch-mcp entry', () => {
    repo.create({
      name: 'fetch-mcp',
      sourceType: 'stdio',
      command: 'custom-fetch',
      enabled: false,
    });

    seedDefaultMcpEntries(db);

    const entry = repo.getByName('fetch-mcp');
    expect(entry!.command).toBe('custom-fetch');
    expect(entry!.enabled).toBe(false);
  });

  test('fetch-mcp has a non-empty description', () => {
    seedDefaultMcpEntries(db);

    const entry = repo.getByName('fetch-mcp');
    expect(entry!.description).toBeTruthy();
  });

  test('creates chrome-devtools entry on a fresh registry', () => {
    seedDefaultMcpEntries(db);

    const entry = repo.getByName('chrome-devtools');
    expect(entry).not.toBeNull();
    expect(entry!.name).toBe('chrome-devtools');
    expect(entry!.sourceType).toBe('stdio');
    expect(entry!.command).toBe('bunx');
    expect(entry!.args).toEqual(['chrome-devtools-mcp@latest', '--isolated']);
    expect(entry!.enabled).toBe(false);
  });

  test('chrome-devtools is disabled by default', () => {
    seedDefaultMcpEntries(db);

    const entry = repo.getByName('chrome-devtools');
    expect(entry!.enabled).toBe(false);
  });

  test('chrome-devtools is idempotent — calling twice does not create duplicates', () => {
    seedDefaultMcpEntries(db);
    seedDefaultMcpEntries(db);

    const all = repo.list();
    const entries = all.filter((e) => e.name === 'chrome-devtools');
    expect(entries).toHaveLength(1);
  });

  test('does not overwrite a pre-existing chrome-devtools entry', () => {
    repo.create({
      name: 'chrome-devtools',
      sourceType: 'stdio',
      command: 'custom-chrome',
      enabled: true,
    });

    seedDefaultMcpEntries(db);

    const entry = repo.getByName('chrome-devtools');
    expect(entry!.command).toBe('custom-chrome');
    expect(entry!.enabled).toBe(true);
  });

  test('chrome-devtools has a non-empty description', () => {
    seedDefaultMcpEntries(db);

    const entry = repo.getByName('chrome-devtools');
    expect(entry!.description).toBeTruthy();
  });
});
