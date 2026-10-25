import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { SessionToolSelection } from '@hyperneo/shared/types/session-tool-choice';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createSpaceTables } from '../../helpers/space-test-db.ts';
import { createTables } from '../../../../src/storage/schema/index.ts';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository.ts';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository.ts';
import {
  captureToolPreferenceRow,
  commitToolPreferenceRows,
  commitToolDefaultUpdate,
  type ToolPreferenceSnapshot,
  type SessionMcpPreferenceEdit,
} from '../../../../src/storage/repositories/tool-preference-commit.ts';
import { createTestSession } from '../../../helpers/database.ts';

let db: Database;
let repo: SessionRepository;
const id = 'preference-session';
const selection: SessionToolSelection = {
  version: 1,
  choices: { 'mcp:browser': { selected: true, aliases: ['frozen-browser'] } },
};
const tools = { disabledSkills: [], useClaudeCodePreset: false };
const current = () => repo.getSession(id)!.config;
const snapshot = () => repo.captureSessionRuntimeSettings(id)!;
const server = () => captureToolPreferenceRow(db, { table: 'app_mcp_servers', id: 'browser' });
function override(): SessionMcpPreferenceEdit['before'] {
  return captureToolPreferenceRow(db, {
    table: 'mcp_enablement',
    server_id: 'browser',
    scope_type: 'session',
    scope_id: id,
  }) as SessionMcpPreferenceEdit['before'];
}
function setOverride(enabled = 1) {
  db.prepare("INSERT OR REPLACE INTO mcp_enablement VALUES ('browser','session',?,?)").run(
    id,
    enabled
  );
}
const overrideCount = () =>
  (db.prepare('SELECT COUNT(*) AS n FROM mcp_enablement').get() as { n: number }).n;
const defaults = () =>
  captureToolPreferenceRow(db, { table: 'global_settings', id: 1 }) as ToolPreferenceSnapshot & {
    key: { table: 'global_settings'; id: 1 };
  };
beforeEach(() => {
  db = new Database(':memory:');
  createTables(db);
  createSpaceTables(db);
  repo = new SessionRepository(db);
  repo.createSession({
    ...createTestSession(id),
    sdkSessionId: 'unchanged-sdk',
    config: {
      ...createTestSession(id).config,
      autoScroll: true,
      sdkToolsPreset: ['Read'],
      tools: { disabledSkills: ['wrapper'] },
      toolSelection: {
        version: 1,
        choices: { 'mcp:browser': { selected: false, aliases: ['frozen-browser'] } },
      },
    },
  });
  db.prepare(
    "INSERT INTO app_mcp_servers (id,name,source_type,command,enabled) VALUES ('browser','browser','stdio','synthetic',0)"
  ).run();
  db.prepare(
    "INSERT INTO skills (id,name,display_name,description,source_type,config,enabled,created_at) VALUES ('wrapper','wrapper','Wrapper','','mcp_server',?,0,1)"
  ).run(JSON.stringify({ type: 'mcp_server', appMcpServerId: 'browser' }));
});
afterEach(() => db.close());

describe('atomic tool preference commits', () => {
  it('captures complete source rows as serializable data including absence', () => {
    expect(server().row?.command).toBe('synthetic');
    expect(override().row).toBeNull();
    expect(structuredClone(server())).toEqual(server());
  });
  it('commits canonical choices, legacy tools and an override together while preserving other settings', () => {
    const result = repo.casSessionToolPreferences(
      snapshot(),
      { toolSelection: selection, tools },
      [server()],
      { before: override(), enabled: true }
    );
    expect(result).toBe('won');
    expect(current().toolSelection).toEqual(selection);
    expect(current().tools).toEqual(tools);
    expect(current().autoScroll).toBe(true);
    expect(current().sdkToolsPreset).toEqual(['Read']);
    expect(repo.getSession(id)?.sdkSessionId).toBe('unchanged-sdk');
    expect(override().row?.enabled).toBe(1);
    expect(
      db.prepare("SELECT json_type(config,'$.tools') AS t FROM sessions WHERE id=?").get(id)
    ).toEqual({ t: 'object' });
  });
  it('clears a captured override in the same commit', () => {
    setOverride();
    expect(
      repo.casSessionToolPreferences(snapshot(), { toolSelection: selection }, [], {
        before: override(),
        enabled: null,
      })
    ).toBe('won');
    expect(overrideCount()).toBe(0);
    expect(current().toolSelection).toEqual(selection);
  });
  it('refuses a stale config before changing the legacy row', () => {
    const captured = snapshot();
    const before = override();
    repo.updateSession(id, { config: { ...current(), autoScroll: false } });
    expect(
      repo.casSessionToolPreferences(captured, { toolSelection: selection }, [], {
        before,
        enabled: true,
      })
    ).toBe('superseded');
    expect(overrideCount()).toBe(0);
    expect(current().toolSelection).not.toEqual(selection);
    expect(current().autoScroll).toBe(false);
  });
  it('guards source rows and absent overrides against concurrent changes', () => {
    const captured = snapshot();
    const before = override();
    const guards = [server()];
    setOverride(0);
    expect(
      repo.casSessionToolPreferences(captured, { toolSelection: selection }, guards, {
        before,
        enabled: true,
      })
    ).toBe('superseded');
    expect(override().row?.enabled).toBe(0);
    expect(current().toolSelection).not.toEqual(selection);
    const changed = override();
    db.prepare("UPDATE app_mcp_servers SET command='new-command' WHERE id='browser'").run();
    expect(
      repo.casSessionToolPreferences(captured, { toolSelection: selection }, guards, {
        before: changed,
        enabled: true,
      })
    ).toBe('superseded');
    expect(override().row?.enabled).toBe(0);
  });
  it('rolls back the session write when the legacy write fails', () => {
    const before = current();
    db.exec(
      "CREATE TRIGGER reject_fixture BEFORE INSERT ON mcp_enablement BEGIN SELECT RAISE(ABORT,'synthetic override failure'); END"
    );
    expect(() =>
      repo.casSessionToolPreferences(snapshot(), { toolSelection: selection, tools }, [], {
        before: override(),
        enabled: true,
      })
    ).toThrow('synthetic override failure');
    expect(current()).toEqual(before);
    expect(overrideCount()).toBe(0);
  });
  it('refuses cross-session override writes and protects same-ID recreation', () => {
    const before = override();
    before.key.scope_id = 'another-session';
    expect(() =>
      repo.casSessionToolPreferences(snapshot(), { toolSelection: selection }, [], {
        before,
        enabled: true,
      })
    ).toThrow();
    const captured = snapshot();
    db.prepare('DELETE FROM sessions WHERE id=?').run(id);
    repo.createSession(createTestSession(id));
    expect(
      repo.casSessionToolPreferences(captured, { toolSelection: selection }, [], {
        before: override(),
        enabled: true,
      })
    ).toBe('superseded');
    expect(overrideCount()).toBe(0);
  });
  it('rolls back a mutator that reports failure after changing source rows', () => {
    const before = server();
    expect(
      commitToolPreferenceRows(db, [before], () => {
        db.prepare("UPDATE app_mcp_servers SET enabled=1 WHERE id='browser'").run();
        return false;
      })
    ).toBe('superseded');
    expect(server()).toEqual(before);
  });
  it('does not run a mutator after a captured definition changed or disappeared', () => {
    const before = server();
    db.prepare("DELETE FROM app_mcp_servers WHERE id='browser'").run();
    let called = false;
    expect(
      commitToolPreferenceRows(db, [before], () => {
        called = true;
        return true;
      })
    ).toBe('superseded');
    expect(called).toBe(false);
  });
});

describe('atomic tool default commits', () => {
  it('commits a catalog edit and global defaults while retaining unrelated settings and frozen sessions', () => {
    const target = defaults();
    const prior = current();
    expect(
      commitToolDefaultUpdate(db, target, [server()], selection, () => {
        db.prepare("UPDATE app_mcp_servers SET enabled=1 WHERE id='browser'").run();
        return true;
      })
    ).toBe('won');
    const value = JSON.parse(defaults().row!.settings as string);
    expect(value.toolSelectionDefaults).toEqual(selection);
    expect(value.autoScroll).toBe(JSON.parse(target.row!.settings as string).autoScroll);
    expect(server().row?.enabled).toBe(1);
    expect(current()).toEqual(prior);
  });
  it('commits Space overrides and defaults together without altering other config', () => {
    const space = new SpaceRepository(db).createSpace({
      name: 'Fixture',
      slug: 'fixture',
      workspacePath: '/synthetic',
      config: { maxConcurrentTasks: 3 },
    });
    const target = captureToolPreferenceRow(db, {
      table: 'spaces',
      id: space.id,
    }) as ToolPreferenceSnapshot & { key: { table: 'spaces'; id: string } };
    const guard = captureToolPreferenceRow(db, {
      table: 'mcp_enablement',
      server_id: 'browser',
      scope_type: 'space',
      scope_id: space.id,
    });
    expect(
      commitToolDefaultUpdate(db, target, [guard], selection, () => {
        db.prepare("INSERT INTO mcp_enablement VALUES ('browser','space',?,1)").run(space.id);
        return true;
      })
    ).toBe('won');
    const value = JSON.parse(captureToolPreferenceRow(db, target.key).row!.config as string);
    expect(value.maxConcurrentTasks).toBe(3);
    expect(value.toolSelectionDefaults).toEqual(selection);
  });
  it('refuses stale default targets and rolls back both halves on failure', () => {
    const target = defaults();
    db.prepare(
      "UPDATE global_settings SET settings=json_set(settings,'$.autoScroll',json('false')) WHERE id=1"
    ).run();
    let called = false;
    expect(
      commitToolDefaultUpdate(db, target, [], selection, () => {
        called = true;
        return true;
      })
    ).toBe('superseded');
    expect(called).toBe(false);
    const captured = defaults();
    expect(() =>
      commitToolDefaultUpdate(db, captured, [], selection, () => {
        db.prepare("UPDATE app_mcp_servers SET enabled=1 WHERE id='browser'").run();
        throw new Error('synthetic failure');
      })
    ).toThrow('synthetic failure');
    expect(server().row?.enabled).toBe(0);
    expect(defaults()).toEqual(captured);
  });
  it('refuses a missing defaults target without changing source rows', () => {
    const missing = captureToolPreferenceRow(db, {
      table: 'spaces',
      id: 'missing',
    }) as ToolPreferenceSnapshot & { key: { table: 'spaces'; id: string } };
    let called = false;
    expect(
      commitToolDefaultUpdate(db, missing, [], selection, () => {
        called = true;
        return true;
      })
    ).toBe('superseded');
    expect(called).toBe(false);
  });
});

describe('corrupt default target refusal', () => {
  it('never reports success when an array-shaped settings value cannot hold the canonical field', () => {
    db.prepare("UPDATE global_settings SET settings='[]' WHERE id=1").run();
    const target = defaults();
    let called = false;
    expect(() =>
      commitToolDefaultUpdate(db, target, [], selection, () => {
        called = true;
        db.prepare("UPDATE app_mcp_servers SET enabled=1 WHERE id='browser'").run();
        return true;
      })
    ).toThrow('JSON object');
    expect(called).toBe(false);
    expect(server().row?.enabled).toBe(0);
    expect(defaults()).toEqual(target);
  });
});

describe('default write completion', () => {
  it('rolls back when the legacy callback leaves a target that cannot store object fields', () => {
    const target = defaults();
    expect(
      commitToolDefaultUpdate(db, target, [], selection, () => {
        db.prepare("UPDATE global_settings SET settings='[]' WHERE id=1").run();
        db.prepare("UPDATE app_mcp_servers SET enabled=1 WHERE id='browser'").run();
        return true;
      })
    ).toBe('superseded');
    expect(defaults()).toEqual(target);
    expect(server().row?.enabled).toBe(0);
  });
});

describe('default commit last-change timestamps', () => {
  it('refreshes global settings time using the existing UTC text format', () => {
    db.prepare("UPDATE global_settings SET updated_at='2000-01-01 00:00:00' WHERE id=1").run();
    const target = defaults();
    const before = (db.prepare("SELECT datetime('now') AS value").get() as { value: string }).value;
    expect(commitToolDefaultUpdate(db, target, [], selection, () => true)).toBe('won');
    const after = (db.prepare("SELECT datetime('now') AS value").get() as { value: string }).value;
    const updated = defaults().row!.updated_at as string;
    expect(typeof updated).toBe('string');
    expect(updated).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(updated! >= before).toBe(true);
    expect(updated! <= after).toBe(true);
  });
  it('moves an edited Space ahead of an older edit and exposes its current millisecond timestamp', () => {
    const spaces = new SpaceRepository(db);
    const edited = spaces.createSpace({
      name: 'Edited',
      slug: 'edited',
      workspacePath: '/synthetic',
    });
    const other = spaces.createSpace({
      name: 'Other',
      slug: 'other',
      workspacePath: '/synthetic/other',
    });
    db.prepare('UPDATE spaces SET updated_at=1000 WHERE id=?').run(edited.id);
    db.prepare('UPDATE spaces SET updated_at=2000 WHERE id=?').run(other.id);
    expect(spaces.listSpaces().map((space) => space.id)).toEqual([other.id, edited.id]);
    const target = captureToolPreferenceRow(db, { table: 'spaces', id: edited.id });
    const before = Date.now();
    expect(commitToolDefaultUpdate(db, target, [], selection, () => true)).toBe('won');
    expect(spaces.listSpaces().map((space) => space.id)).toEqual([edited.id, other.id]);
    const updated = spaces.getSpace(edited.id)!.updatedAt;
    expect(typeof updated).toBe('number');
    expect(updated).toBeGreaterThanOrEqual(before);
    expect(updated).toBeLessThanOrEqual(Date.now());
  });
});
