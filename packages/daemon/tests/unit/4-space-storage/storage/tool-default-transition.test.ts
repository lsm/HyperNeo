import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { SessionToolSelection } from '@hyperneo/shared/types/session-tool-choice';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables } from '../../../../src/storage/schema/index.ts';
import { createSpaceTables } from '../../helpers/space-test-db.ts';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository.ts';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository.ts';
import { AppMcpServerRepository } from '../../../../src/storage/repositories/app-mcp-server-repository.ts';
import { McpEnablementRepository } from '../../../../src/storage/repositories/mcp-enablement-repository.ts';
import { ChangeRecorder } from '../../../../src/storage/db-gateway/db-op.ts';
import type { ReactiveDatabase } from '../../../../src/storage/reactive-database.ts';
import {
  toolDefaultTransitions,
  type ToolDefaultTransition,
} from '../../../../src/storage/repositories/tool-default-transition.ts';
import { createTestSession } from '../../../helpers/database.ts';

let db: Database;
let gateway: DbGateway;
let sessions: SessionRepository;
let spaces: SpaceRepository;
let registry: AppMcpServerRepository;
let overrides: McpEnablementRepository;
const selection = (selected = false): SessionToolSelection => ({
  version: 1,
  choices: {
    'mcp:browser': { selected, aliases: ['frozen-browser'] },
    'skill:notes': { selected: false },
  },
});
const readGlobal = () =>
  JSON.parse(
    (db.prepare('SELECT settings FROM global_settings WHERE id=1').get() as { settings: string })
      .settings
  ).toolSelectionDefaults;
const readSpace = (id = 'space') =>
  (spaces.getSpace(id)!.config as Record<string, unknown>).toolSelectionDefaults;
const apply = (args: ToolDefaultTransition) => gateway.run(toolDefaultTransitions, args);
const update = (enabled = true): ToolDefaultTransition => ({
  mutations: [{ repository: 'registry', method: 'update', args: ['browser', { enabled }] }],
  edits: [{ key: 'mcp:browser', selected: enabled }],
});
beforeEach(() => {
  db = new Database(':memory:');
  createTables(db);
  createSpaceTables(db);
  gateway = new DbGateway(':memory:', db);
  const changes = new ChangeRecorder() as unknown as ReactiveDatabase;
  sessions = new SessionRepository(db);
  spaces = new SpaceRepository(db);
  registry = new AppMcpServerRepository(db, changes);
  overrides = new McpEnablementRepository(db, changes);
  db.prepare(
    "INSERT INTO app_mcp_servers (id,name,source_type,command,enabled) VALUES ('browser','registry-name','stdio','synthetic',0)"
  ).run();
  for (const [id, type, config] of [
    ['wrapper', 'mcp_server', { type: 'mcp_server', appMcpServerId: 'browser' }],
    ['notes', 'builtin', { type: 'builtin', commandName: 'notes' }],
  ] as const)
    db.prepare(
      "INSERT INTO skills (id,name,display_name,description,source_type,config,enabled,created_at) VALUES (?,?,?,'',?,?,0,1)"
    ).run(id, id, id, type, JSON.stringify(config));
  db.prepare('UPDATE global_settings SET settings=? WHERE id=1').run(
    JSON.stringify({ toolSelectionDefaults: selection(), keep: 'global' })
  );
  for (const id of ['space', 'other']) {
    db.prepare(
      'INSERT INTO spaces (id,slug,name,workspace_path,config,created_at,updated_at) VALUES (?,?,?,?,?,1,1)'
    ).run(
      id,
      id,
      id,
      `/synthetic/${id}`,
      JSON.stringify({ toolSelectionDefaults: selection(), keep: id })
    );
  }
  sessions.createSession({
    ...createTestSession('frozen'),
    config: { ...createTestSession('frozen').config, toolSelection: selection() },
  });
});
afterEach(async () => {
  await gateway.close();
  db.close();
});

describe('atomic tool default transition worker', () => {
  it('commits catalog intent despite a legacy wrapper gate and preserves frozen sessions', async () => {
    expect((await apply(update())).ok).toBe(true);
    expect(registry.get('browser')!.enabled).toBe(true);
    expect(readGlobal()).toEqual(selection(true));
    expect(readSpace()).toEqual(selection(true));
    expect(readSpace('other')).toEqual(selection(true));
    expect(sessions.getSession('frozen')!.config.toolSelection).toEqual(selection());
  });
  it('preserves explicit Space vetoes on global edits and clears a Space override to canonical global defaults', async () => {
    overrides.setOverride('space', 'space', 'browser', false);
    expect((await apply(update())).ok).toBe(true);
    expect(readSpace()).toEqual(selection());
    expect(readSpace('other')).toEqual(selection(true));
    expect(
      (
        await apply({
          spaceId: 'space',
          mutations: [
            {
              repository: 'overrides',
              method: 'clearOverride',
              args: ['space', 'space', 'browser'],
            },
          ],
          edits: [{ key: 'mcp:browser', selected: null }],
        })
      ).ok
    ).toBe(true);
    expect(overrides.getOverride('space', 'space', 'browser')).toBeNull();
    expect(readSpace()).toEqual(selection(true));
    expect(readGlobal()).toEqual(selection(true));
  });
  it('rolls back every legacy write and default if a later target fails, publishing no changes', async () => {
    const notices: unknown[] = [];
    gateway.onChanges = (changes) => {
      notices.push(changes);
    };
    db.exec(
      "CREATE TRIGGER reject_space_default BEFORE UPDATE ON spaces BEGIN SELECT RAISE(ABORT,'synthetic default failure'); END"
    );
    await expect(apply(update())).rejects.toThrow('synthetic default failure');
    expect(registry.get('browser')!.enabled).toBe(false);
    expect(readGlobal()).toEqual(selection());
    expect(readSpace()).toEqual(selection());
    expect(notices).toEqual([]);
  });
  it('refuses present invalid defaults before mutating and preserves absent defaults on missing targets', async () => {
    for (const value of [null, false, { version: 2, choices: {} }]) {
      db.prepare('UPDATE global_settings SET settings=? WHERE id=1').run(
        JSON.stringify({ toolSelectionDefaults: value })
      );
      expect(await apply(update())).toMatchObject({
        ok: false,
        reason: 'selection_version_unsupported',
      });
      expect(registry.get('browser')!.enabled).toBe(false);
    }
    db.prepare('UPDATE global_settings SET settings=? WHERE id=1').run('{}');
    expect(await apply({ ...update(), spaceId: 'missing' })).toMatchObject({
      ok: false,
      reason: 'default_target_not_found',
    });
    expect(readGlobal()).toBeUndefined();
  });
  it('commits a skill and registry batch atomically while preserving unrelated explicit offs', async () => {
    expect(
      (
        await apply({
          mutations: [
            { repository: 'skills', method: 'setEnabled', args: ['notes', true] },
            ...update().mutations,
          ],
          edits: [{ key: 'skill:notes', selected: true }, ...update().edits],
        })
      ).ok
    ).toBe(true);
    expect(readGlobal().choices['skill:notes'].selected).toBe(true);
    expect(readGlobal().choices['mcp:browser'].selected).toBe(true);
    expect(
      (
        await apply({
          mutations: [
            { repository: 'registry', method: 'update', args: ['browser', { name: 'renamed' }] },
          ],
          edits: [],
        })
      ).ok
    ).toBe(true);
    expect(readGlobal().choices['mcp:browser'].aliases).toEqual(['frozen-browser']);
  });
  it('keeps default timestamps unchanged when a catalog rename changes no choices', async () => {
    db.prepare('UPDATE spaces SET updated_at=1000').run();
    db.prepare("UPDATE global_settings SET updated_at='2000-01-01 00:00:00' WHERE id=1").run();
    expect(
      (
        await apply({
          mutations: [
            { repository: 'registry', method: 'update', args: ['browser', { name: 'renamed' }] },
          ],
          edits: [],
        })
      ).ok
    ).toBe(true);
    expect(spaces.getSpace('space')!.updatedAt).toBe(1000);
    expect(
      (
        db.prepare('SELECT updated_at FROM global_settings WHERE id=1').get() as {
          updated_at: string;
        }
      ).updated_at
    ).toBe('2000-01-01 00:00:00');
  });
  it('rolls back earlier batch writes on a missing mutation target without replaying notifications', async () => {
    const notices: unknown[] = [];
    gateway.onChanges = (changes) => {
      notices.push(changes);
    };
    expect(
      await apply({
        mutations: [
          ...update().mutations,
          { repository: 'registry', method: 'delete', args: ['missing'] },
        ],
        edits: update().edits,
      })
    ).toMatchObject({ ok: false, reason: 'superseded' });
    expect(registry.get('browser')!.enabled).toBe(false);
    expect(readGlobal()).toEqual(selection());
    expect(notices).toEqual([]);
  });
  it('refuses a catalog mutation restricted to one Space so other defaults cannot become stale', async () => {
    await expect(apply({ ...update(), spaceId: 'space' })).rejects.toThrow(
      'Default mutation scope mismatch'
    );
    expect(registry.get('browser')!.enabled).toBe(false);
    expect(readGlobal()).toEqual(selection());
    expect(readSpace()).toEqual(selection());
  });
  it('rejects mismatched Space mutations without changing either scope', async () => {
    await expect(
      apply({
        spaceId: 'space',
        mutations: [
          {
            repository: 'overrides',
            method: 'setOverride',
            args: ['space', 'other', 'browser', true],
          },
        ],
        edits: [{ key: 'mcp:browser', selected: true }],
      })
    ).rejects.toThrow('Space override scope mismatch');
    expect(overrides.listAll()).toEqual([]);
    expect(readSpace()).toEqual(selection());
  });
  it.each(['empty', 'rename'])(
    'keeps absent default templates and timestamps unchanged for a %s transition',
    async (kind) => {
      const server = registry.create({
        name: 'before-rename',
        sourceType: 'stdio',
        command: 'synthetic',
        enabled: true,
      });
      db.prepare(
        "UPDATE global_settings SET settings='{}',updated_at='2000-01-01 00:00:00' WHERE id=1"
      ).run();
      db.prepare("UPDATE spaces SET config='{}',updated_at=1000").run();
      expect(
        (
          await apply({
            mutations:
              kind === 'rename'
                ? [
                    {
                      repository: 'registry',
                      method: 'update',
                      args: [server.id, { name: 'after-rename' }],
                    },
                  ]
                : [],
            edits: [],
          })
        ).ok
      ).toBe(true);
      expect(readGlobal()).toBeUndefined();
      for (const id of ['space', 'other']) {
        expect(readSpace(id)).toBeUndefined();
        expect(spaces.getSpace(id)!.updatedAt).toBe(1000);
      }
      expect(
        (
          db.prepare('SELECT updated_at FROM global_settings WHERE id=1').get() as {
            updated_at: string;
          }
        ).updated_at
      ).toBe('2000-01-01 00:00:00');
      expect(registry.get(server.id)!.name).toBe(
        kind === 'rename' ? 'after-rename' : 'before-rename'
      );
    }
  );
  it('refuses missing skill updates atomically for each void-returning method', async () => {
    const notices: unknown[] = [];
    gateway.onChanges = (changes) => {
      notices.push(changes);
    };
    const mutations: ToolDefaultTransition['mutations'] = [
      { repository: 'skills', method: 'update', args: ['missing', { enabled: true }] },
      { repository: 'skills', method: 'setEnabled', args: ['missing', true] },
      { repository: 'skills', method: 'setValidationStatus', args: ['missing', 'valid'] },
    ];
    for (const mutation of mutations) {
      expect(
        await apply({ mutations: [...update().mutations, mutation], edits: update().edits })
      ).toMatchObject({ ok: false, reason: 'superseded' });
      expect(registry.get('browser')!.enabled).toBe(false);
      expect(readGlobal()).toEqual(selection());
      expect(notices).toEqual([]);
    }
  });
  it('allows a new skill insert but rolls back a duplicate insert with preceding mutations', async () => {
    const skill = {
      id: 'created',
      name: 'created',
      displayName: 'Created',
      description: '',
      sourceType: 'builtin' as const,
      config: { type: 'builtin' as const, commandName: 'created' },
      enabled: true,
      builtIn: false,
      validationStatus: 'valid' as const,
      createdAt: 1,
    };
    expect(
      (
        await apply({
          mutations: [{ repository: 'skills', method: 'insert', args: [skill] }],
          edits: [],
        })
      ).ok
    ).toBe(true);
    expect(readGlobal().choices['skill:created'].selected).toBe(true);
    await expect(
      apply({
        mutations: [
          ...update().mutations,
          { repository: 'skills', method: 'insert', args: [skill] },
        ],
        edits: update().edits,
      })
    ).rejects.toThrow();
    expect(registry.get('browser')!.enabled).toBe(false);
    expect(readGlobal().choices['mcp:browser'].selected).toBe(false);
  });
});
