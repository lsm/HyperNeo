import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemonApp } from '../../../../src/app.ts';
import { getConfig } from '../../../../src/config.ts';
import { globalSettingsWrites } from '../../../../src/storage/repositories/global-settings-writes.ts';
import { toolDefaultTransitions } from '../../../../src/storage/repositories/tool-default-transition.ts';
import { createLocalSocket } from '../../../../src/lib/pairing/local-credential.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { neoAskInputWrites } from '../../../../src/storage/repositories/neo-ask-input-worker.ts';
import { createTestSession } from '../../../helpers/database.ts';
import { createTestDb } from '../../../helpers/database.ts';
import { migrateSessionToolSelections } from '../../../../src/storage/repositories/session-tool-selection-migration.ts';
import { MessageHub, WebSocketClientTransport } from '@hyperneo/shared';

test('committed settings stay visible while repeated facade reads avoid SQLite', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'settings-cache-'));
  const previousDataDir = process.env.HYPERNEO_DATA_DIR;
  process.env.HYPERNEO_DATA_DIR = join(directory, 'data');
  try {
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
      await app.db.createSession(createTestSession('synthetic-relay-owner'));
      const todos = new NeoAskTodoRepository(raw);
      todos.openAsk({
        id: 'synthetic-relay-ask',
        projectId: null,
        sessionId: 'synthetic-relay-owner',
        originMessageId: null,
        title: 'Synthetic rule',
        request: 'Approve rule',
        createdAt: 1,
      });
      todos.askQuestion(
        'synthetic-rule-card',
        'synthetic-relay-ask',
        {
          text: 'Apply the synthetic rule?',
          kind: 'yesno',
          options: null,
          multiple: false,
          noLabel: 'Keep',
          yesLabel: 'Apply',
          startTodos: null,
        },
        1
      );
      raw
        .prepare(
          'INSERT INTO neo_rule_proposals (question_id,request_id,edit_json,question_text) VALUES (?,?,?,?)'
        )
        .run(
          'synthetic-rule-card',
          'synthetic-rule-request',
          JSON.stringify({ add: ['Relayed rule'] }),
          'Apply the synthetic rule?'
        );
      app.db.updateGlobalSettings({
        neo: {
          ...read().neo,
          standingRules: ['Committed rule'],
          relaySenders: [{ sender: 'synthetic-relay', name: 'Synthetic relay' }],
        },
      });
      expect(read().neo?.standingRules).toEqual(['Committed rule']);
      const beforeRelay = selects;
      const relay = await app.db.gateway.call(neoAskInputWrites, 'relayAnswer', {
        questionId: 'synthetic-rule-card',
        sender: 'synthetic-relay',
        where: 'Synthetic discussion',
        when: 'Synthetic time',
        words: 'yes',
        at: 2,
      });
      expect(relay).toMatchObject({
        reason: { ok: false, reason: expect.stringContaining('direct_human_required') },
      });
      expect(read().neo?.standingRules).toEqual(['Committed rule']);
      expect(todos.getQuestion('synthetic-rule-card')?.state).toBe('open');
      expect(
        raw
          .prepare('SELECT applied_at FROM neo_rule_proposals WHERE question_id=?')
          .get('synthetic-rule-card')
      ).toMatchObject({ applied_at: null });
      console.log(
        JSON.stringify({
          selects,
          repeatedReadsPerWrite: 10,
          paths: 7,
          relaySettingsSelectsOnMain: selects - beforeRelay,
        })
      );
    } finally {
      raw.prepare = prepare;
      await transport.close();
      await app.cleanup();
    }
  } finally {
    if (previousDataDir === undefined) delete process.env.HYPERNEO_DATA_DIR;
    else process.env.HYPERNEO_DATA_DIR = previousDataDir;
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
