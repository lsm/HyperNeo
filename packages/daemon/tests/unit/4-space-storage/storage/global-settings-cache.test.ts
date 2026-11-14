import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemonApp } from '../../../../src/app.ts';
import { getConfig } from '../../../../src/config.ts';
import { globalSettingsWrites } from '../../../../src/storage/repositories/global-settings-writes.ts';
import { toolDefaultTransitions } from '../../../../src/storage/repositories/tool-default-transition.ts';
import { createLocalSocket } from '../../../../src/lib/pairing/local-credential.ts';
import { createTestDb } from '../../../helpers/database.ts';
import { migrateSessionToolSelections } from '../../../../src/storage/repositories/session-tool-selection-migration.ts';
import { MessageHub, WebSocketClientTransport } from '@hyperneo/shared';

test('committed settings stay visible while repeated facade reads avoid SQLite', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'settings-cache-'));
  const app = await createDaemonApp({
    config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(directory, 'daemon.db') }),
    verbose: false,
  });
  const hub = new MessageHub({ defaultSessionId: 'global' });
  const transport = new WebSocketClientTransport({
    createSocket: createLocalSocket,
    url: `ws://127.0.0.1:${app.server.port}/ws`,
  });
  hub.registerTransport(transport);
  const raw = app.db.getDatabase();
  const prepare = raw.prepare.bind(raw);
  let selects = 0;
  raw.prepare = ((sql: string) => {
    if (/SELECT settings FROM global_settings/i.test(sql)) selects++;
    return prepare(sql);
  }) as typeof raw.prepare;
  const read = () => {
    const settings = app.db.getGlobalSettings();
    const before = selects;
    for (let index = 0; index < 10; index++) {
      expect(app.db.getGlobalSettings()).toEqual(settings);
    }
    expect(selects - before).toBe(0);
    return settings;
  };
  try {
    await app.jobProcessor.stop();
    await transport.initialize();
    read();
    app.db.saveGlobalSettings({ ...read(), outputStyle: 'saved' });
    expect(read().outputStyle).toBe('saved');
    app.db.updateGlobalSettings({ outputStyle: 'patched' });
    expect(read().outputStyle).toBe('patched');
    const commit = await app.db.gateway.call(globalSettingsWrites, 'apply', {
      outputStyle: 'worker',
    });
    expect(read().outputStyle).toBe('worker');
    await app.db.gateway.call(globalSettingsWrites, 'rollback', commit);
    expect(read().outputStyle).toBe('patched');
    await hub.request('settings.global.update', { updates: { outputStyle: 'rpc' } });
    expect(read().outputStyle).toBe('rpc');
    await app.db.gateway.call(globalSettingsWrites, 'neoMute', 'synthetic-session', true);
    expect(read().neo?.mutedSessions).toContain('synthetic-session');
    raw
      .prepare(
        "INSERT INTO app_mcp_servers (id,name,source_type,command,enabled) VALUES ('synthetic-browser','synthetic-browser','stdio','synthetic',0)"
      )
      .run();
    const transition = await app.db.gateway.call(toolDefaultTransitions, 'apply', {
      mutations: [
        {
          repository: 'registry',
          method: 'update',
          args: ['synthetic-browser', { enabled: true }],
        },
      ],
      edits: [{ key: 'mcp:synthetic-browser', selected: true }],
    });
    expect(transition.ok).toBe(true);
    expect(read().toolSelectionDefaults?.choices['mcp:synthetic-browser']?.selected).toBe(true);
    const detached = read();
    detached.neo!.mutedSessions!.push('caller-mutation');
    expect(read().neo?.mutedSessions).not.toContain('caller-mutation');
    console.log(JSON.stringify({ selects, repeatedReadsPerWrite: 10, paths: 7 }));
  } finally {
    raw.prepare = prepare;
    await transport.close();
    await app.cleanup();
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

test('a warmed settings cache exposes startup tool-choice migration', async () => {
  const db = await createTestDb();
  try {
    db.saveGlobalSettings({ ...db.getGlobalSettings(), toolSelectionDefaults: undefined });
    expect(db.getGlobalSettings().toolSelectionDefaults).toBeUndefined();
    expect(
      migrateSessionToolSelections(db.getDatabase(), { skills: [], registry: [], overrides: [] })
    ).toBe(1);
    expect(db.getGlobalSettings().toolSelectionDefaults).toEqual({ version: 1, choices: {} });
  } finally {
    await db.close();
  }
});

test('a settings read inside a rolled-back transaction cannot poison the cache', async () => {
  const db = await createTestDb();
  try {
    db.updateGlobalSettings({ outputStyle: 'committed' });
    expect(db.getGlobalSettings().outputStyle).toBe('committed');
    expect(() =>
      db.getDatabase().transaction(() => {
        db.updateGlobalSettings({
          outputStyle: 'rolled-back',
        });
        expect(db.getGlobalSettings().outputStyle).toBe('rolled-back');
        throw new Error('synthetic rollback');
      })()
    ).toThrow('synthetic rollback');
    expect(db.getGlobalSettings().outputStyle).toBe('committed');
  } finally {
    await db.close();
  }
});
