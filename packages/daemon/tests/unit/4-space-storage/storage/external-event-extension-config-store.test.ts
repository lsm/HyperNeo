import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { ExternalEventExtensionConfigStore } from '../../../../src/lib/external-events/extension-config-store';
import { createSpaceTables } from '../../helpers/space-test-db';

let db: Database;
let store: ExternalEventExtensionConfigStore;

beforeEach(() => {
  db = new Database(':memory:');
  store = new ExternalEventExtensionConfigStore(db);
});

describe('ExternalEventExtensionConfigStore', () => {
  test('creates configuration tables on construction', () => {
    const rows = db
      .prepare(
        `SELECT name FROM sqlite_master
				 WHERE type = 'table' AND name IN (
					'external_event_extension_configs',
					'space_external_event_source_configs'
				 )
				 ORDER BY name`
      )
      .all() as { name: string }[];

    expect(rows.map((row) => row.name)).toEqual([
      'external_event_extension_configs',
      'space_external_event_source_configs',
    ]);
  });

  test('returns disabled default global config when no row exists', async () => {
    await expect(store.getGlobalConfig('github')).resolves.toEqual({
      source: 'github',
      globallyEnabled: false,
      capabilities: {},
    });
  });

  test('persists and updates global config', async () => {
    await store.setGlobalConfig('github', {
      source: 'github',
      globallyEnabled: true,
      capabilities: { webhooks: true, polling: true, rpcConfig: true },
      secretsRef: 'secret/github',
      settings: { webhookPath: '/webhooks/github', pollIntervalMs: 60_000 },
    });

    await expect(store.getGlobalConfig('github')).resolves.toEqual({
      source: 'github',
      globallyEnabled: true,
      capabilities: { webhooks: true, polling: true, rpcConfig: true },
      secretsRef: 'secret/github',
      settings: { webhookPath: '/webhooks/github', pollIntervalMs: 60_000 },
    });

    await store.setGlobalConfig('github', {
      source: 'github',
      globallyEnabled: false,
      capabilities: { polling: true },
      settings: { pollIntervalMs: 120_000 },
    });

    await expect(store.getGlobalConfig('github')).resolves.toEqual({
      source: 'github',
      globallyEnabled: false,
      capabilities: { polling: true },
      settings: { pollIntervalMs: 120_000 },
    });
  });

  test('persists global config when optional settings are omitted', async () => {
    await store.setGlobalConfig('github', {
      source: 'github',
      globallyEnabled: true,
      capabilities: { webhooks: true },
    });

    await expect(store.getGlobalConfig('github')).resolves.toEqual({
      source: 'github',
      globallyEnabled: true,
      capabilities: { webhooks: true },
      settings: {},
    });
  });

  test('persists and updates per-space config', async () => {
    await expect(store.getSpaceConfig('space-1', 'github')).resolves.toBeNull();

    await store.setSpaceConfig('space-1', 'github', {
      spaceId: 'space-1',
      source: 'github',
      enabled: true,
      settings: { owner: 'neokai', repo: 'app' },
    });

    await expect(store.getSpaceConfig('space-1', 'github')).resolves.toEqual({
      spaceId: 'space-1',
      source: 'github',
      enabled: true,
      settings: { owner: 'neokai', repo: 'app' },
    });

    await store.setSpaceConfig('space-1', 'github', {
      spaceId: 'space-1',
      source: 'github',
      enabled: false,
      settings: { owner: 'neokai', repo: 'app', branch: 'dev' },
    });

    await expect(store.getSpaceConfig('space-1', 'github')).resolves.toEqual({
      spaceId: 'space-1',
      source: 'github',
      enabled: false,
      settings: { owner: 'neokai', repo: 'app', branch: 'dev' },
    });
  });

  test('lists only enabled spaces for a source', async () => {
    await store.setSpaceConfig('space-1', 'github', {
      spaceId: 'space-1',
      source: 'github',
      enabled: true,
      settings: { repo: 'one' },
    });
    await store.setSpaceConfig('space-2', 'github', {
      spaceId: 'space-2',
      source: 'github',
      enabled: false,
      settings: { repo: 'two' },
    });
    await store.setSpaceConfig('space-3', 'slack', {
      spaceId: 'space-3',
      source: 'slack',
      enabled: true,
      settings: { channel: 'alerts' },
    });

    await expect(store.listEnabledSpaces('github')).resolves.toEqual([
      {
        spaceId: 'space-1',
        source: 'github',
        enabled: true,
        settings: { repo: 'one' },
      },
    ]);
  });

  test('rejects mismatched source and space identifiers', async () => {
    await expect(
      store.setGlobalConfig('github', {
        source: 'slack',
        globallyEnabled: true,
        capabilities: {},
      })
    ).rejects.toThrow('must match');

    await expect(
      store.setSpaceConfig('space-1', 'github', {
        spaceId: 'space-2',
        source: 'github',
        enabled: true,
        settings: {},
      })
    ).rejects.toThrow('must match');
  });

  test('rejects array capabilities to keep writes consistent with reads', async () => {
    await expect(
      store.setGlobalConfig('github', {
        source: 'github',
        globallyEnabled: true,
        capabilities: [] as unknown as { webhooks?: boolean },
      })
    ).rejects.toThrow('capabilities must be an object');
  });

  test('cascades per-space config rows when spaces are deleted', async () => {
    db.close();
    db = new Database(':memory:');
    createSpaceTables(db);
    store = new ExternalEventExtensionConfigStore(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
    ).run('space-1', 'space-1', '/tmp/space-1', 'Space 1', now, now);

    await store.setSpaceConfig('space-1', 'github', {
      spaceId: 'space-1',
      source: 'github',
      enabled: true,
      settings: { repo: 'one' },
    });

    db.prepare(`DELETE FROM spaces WHERE id = ?`).run('space-1');

    await expect(store.listEnabledSpaces('github')).resolves.toEqual([]);
  });
});
