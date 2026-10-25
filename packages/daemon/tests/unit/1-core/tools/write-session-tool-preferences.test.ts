import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables } from '../../../../src/storage/schema/index.ts';
import { createSpaceTables } from '../../helpers/space-test-db.ts';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository.ts';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { McpEnablementRepository } from '../../../../src/storage/repositories/mcp-enablement-repository.ts';
import type { ReactiveDatabase } from '../../../../src/storage/reactive-database.ts';
import { createTestSession } from '../../../helpers/database.ts';
import {
  createSessionToolPreferenceWriter,
  type PreferenceDatabase,
  type SessionToolPreferenceWriter,
} from '../../../../src/lib/tools/write-session-tool-preferences.ts';

let db: Database;
let repo: SessionRepository;
let data: PreferenceDatabase & { mcpEnablement: McpEnablementRepository };
let write: SessionToolPreferenceWriter;
let notices: string[];
const ID = 'writer-fixture';
const current = () => repo.getSession(ID)!.config;
const frozen = {
  version: 1 as const,
  choices: {
    'mcp:browser': { selected: false, aliases: ['frozen-alias'] },
    'skill:notes': { selected: false },
  },
};
beforeEach(() => {
  db = new Database(':memory:');
  createTables(db);
  createSpaceTables(db);
  const changes = { notifyChange() {} } as unknown as ReactiveDatabase;
  repo = new SessionRepository(db);
  repo.createSession({
    ...createTestSession(ID),
    config: {
      ...createTestSession(ID).config,
      sdkToolsPreset: ['Read'],
      tools: { disabledSkills: ['wrapper', 'notes'] },
      toolSelection: structuredClone(frozen),
    },
  });
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
  data = {
    gateway: gatewayFor(db),
    casSessionToolPreferences: async (...args) => repo.casSessionToolPreferences(...args),
    mcpEnablement: new McpEnablementRepository(db, changes),
  };
  notices = [];
  write = createSessionToolPreferenceWriter(data, async (id) => {
    notices.push(id);
  });
});
afterEach(() => db.close());

describe('session tool preference writer', () => {
  it('stores a multi-skill save with canonical choices and preserves aliases/native settings', async () => {
    const tools = { disabledSkills: [], useClaudeCodePreset: false };
    const result = await write(ID, { kind: 'skills', disabledSkills: [] }, tools);
    expect(result.ok).toBe(true);
    expect(current().tools).toEqual(tools);
    expect(current().toolSelection?.choices).toEqual({
      'mcp:browser': { selected: true, aliases: ['frozen-alias'] },
      'skill:notes': { selected: true, aliases: [] },
    });
    expect(current().sdkToolsPreset).toEqual(['Read']);
    expect(notices).toEqual([ID]);
  });
  it('stores and clears a session override atomically using inherited canonical defaults', async () => {
    db.prepare(
      "UPDATE global_settings SET settings=json_set(settings,'$.toolSelectionDefaults',json(?)) WHERE id=1"
    ).run(JSON.stringify(frozen));
    expect((await write(ID, { kind: 'mcp', serverId: 'browser', enabled: true })).ok).toBe(true);
    expect(data.mcpEnablement.getOverride('session', ID, 'browser')?.enabled).toBe(true);
    expect(current().toolSelection?.choices['mcp:browser']?.selected).toBe(true);
    const cleared = await write(ID, { kind: 'mcp', serverId: 'browser', enabled: null });
    expect(cleared.ok).toBe(true);
    expect(cleared.deleted).toBe(true);
    expect(data.mcpEnablement.getOverride('session', ID, 'browser')).toBeNull();
    expect(current().toolSelection?.choices['mcp:browser']?.selected).toBe(false);
    expect((await write(ID, { kind: 'mcp', serverId: 'browser', enabled: null })).deleted).toBe(
      false
    );
  });
  it('rejects missing, closed and unsupported sessions without a notice or legacy change', async () => {
    expect(await write('missing', { kind: 'skills', disabledSkills: [] }, {})).toEqual({
      ok: false,
      reason: 'session_not_found',
    });
    db.prepare("UPDATE sessions SET status='archived' WHERE id=?").run(ID);
    expect(await write(ID, { kind: 'mcp', serverId: 'browser', enabled: true })).toEqual({
      ok: false,
      reason: 'session_closed',
    });
    db.prepare(
      "UPDATE sessions SET status='active',config=json_set(config,'$.toolSelection.version',2) WHERE id=?"
    ).run(ID);
    expect(await write(ID, { kind: 'skills', disabledSkills: [] }, {})).toEqual({
      ok: false,
      reason: 'selection_version_unsupported',
    });
    expect(data.mcpEnablement.getOverride('session', ID, 'browser')).toBeNull();
    expect(notices).toEqual([]);
  });
  it('refuses a concurrent override edit without overwriting either side or notifying', async () => {
    const before = current();
    data.casSessionToolPreferences = async (...args) => {
      data.mcpEnablement.setOverride('session', ID, 'browser', false);
      return repo.casSessionToolPreferences(...args);
    };
    expect(await write(ID, { kind: 'mcp', serverId: 'browser', enabled: true })).toEqual({
      ok: false,
      reason: 'superseded',
    });
    expect(current()).toEqual(before);
    expect(data.mcpEnablement.getOverride('session', ID, 'browser')?.enabled).toBe(false);
    expect(notices).toEqual([]);
  });
  it('guards a catalog definition change between planning and commit', async () => {
    const before = current();
    data.casSessionToolPreferences = async (...args) => {
      db.prepare("UPDATE app_mcp_servers SET command='new-command' WHERE id='browser'").run();
      return repo.casSessionToolPreferences(...args);
    };
    expect(await write(ID, { kind: 'skills', disabledSkills: [] }, { disabledSkills: [] })).toEqual(
      { ok: false, reason: 'superseded' }
    );
    expect(current()).toEqual(before);
    expect(notices).toEqual([]);
  });
  it('rolls back legacy tools and canonical state together on an override SQL failure', async () => {
    const before = current();
    db.exec(
      "CREATE TRIGGER writer_failure BEFORE INSERT ON mcp_enablement BEGIN SELECT RAISE(ABORT,'synthetic failure'); END"
    );
    await expect(
      write(ID, { kind: 'mcp', serverId: 'browser', enabled: true }, { disabledSkills: [] })
    ).rejects.toThrow('synthetic failure');
    expect(current()).toEqual(before);
    expect(notices).toEqual([]);
  });
});

describe('stored preference source integrity', () => {
  it('never recomputes a present but null canonical selection', async () => {
    db.prepare("UPDATE sessions SET config=json_set(config,'$.toolSelection',NULL) WHERE id=?").run(
      ID
    );
    const before = current();
    expect(await write(ID, { kind: 'mcp', serverId: 'browser', enabled: true })).toEqual({
      ok: false,
      reason: 'selection_version_unsupported',
    });
    expect(current()).toEqual(before);
    expect(data.mcpEnablement.getOverride('session', ID, 'browser')).toBeNull();
    expect(notices).toEqual([]);
  });
  it('does not guess inherited defaults when their stored JSON is corrupt', async () => {
    expect((await write(ID, { kind: 'mcp', serverId: 'browser', enabled: true })).ok).toBe(true);
    const before = current();
    notices = [];
    db.prepare("UPDATE global_settings SET settings='{' WHERE id=1").run();
    await expect(write(ID, { kind: 'mcp', serverId: 'browser', enabled: null })).rejects.toThrow();
    expect(current()).toEqual(before);
    expect(data.mcpEnablement.getOverride('session', ID, 'browser')?.enabled).toBe(true);
    expect(notices).toEqual([]);
  });
  it('uses matching Space defaults and refuses a concurrent default edit', async () => {
    db.prepare(
      "INSERT INTO spaces (id,name,slug,workspace_path,status,config,created_at,updated_at) VALUES ('space','Fixture','fixture','/synthetic','active',?,1,1)"
    ).run(
      JSON.stringify({
        toolSelectionDefaults: {
          ...frozen,
          choices: { 'mcp:browser': { selected: true, aliases: ['space-default'] } },
        },
      })
    );
    repo.updateSession(ID, { context: { spaceId: 'space' } });
    expect((await write(ID, { kind: 'mcp', serverId: 'browser', enabled: true })).ok).toBe(true);
    expect((await write(ID, { kind: 'mcp', serverId: 'browser', enabled: null })).ok).toBe(true);
    expect(current().toolSelection?.choices['mcp:browser']).toEqual({
      selected: true,
      aliases: ['frozen-alias'],
    });
    expect((await write(ID, { kind: 'mcp', serverId: 'browser', enabled: true })).ok).toBe(true);
    const before = current();
    notices = [];
    data.casSessionToolPreferences = async (...args) => {
      db.prepare(
        "UPDATE spaces SET config=json_set(config,'$.toolSelectionDefaults.choices.\"mcp:browser\".selected',json('false')) WHERE id='space'"
      ).run();
      return repo.casSessionToolPreferences(...args);
    };
    expect(await write(ID, { kind: 'mcp', serverId: 'browser', enabled: null })).toEqual({
      ok: false,
      reason: 'superseded',
    });
    expect(current()).toEqual(before);
    expect(data.mcpEnablement.getOverride('session', ID, 'browser')?.enabled).toBe(true);
    expect(notices).toEqual([]);
  });
});

describe('inherited template presence', () => {
  it('does not recompute present-null, false or zero inherited templates', async () => {
    expect((await write(ID, { kind: 'mcp', serverId: 'browser', enabled: true })).ok).toBe(true);
    const before = current();
    notices = [];
    for (const value of [null, false, 0]) {
      db.prepare('UPDATE global_settings SET settings=? WHERE id=1').run(
        JSON.stringify({ toolSelectionDefaults: value })
      );
      await expect(write(ID, { kind: 'mcp', serverId: 'browser', enabled: null })).rejects.toThrow(
        'selection_version_unsupported'
      );
      expect(current()).toEqual(before);
      expect(data.mcpEnablement.getOverride('session', ID, 'browser')?.enabled).toBe(true);
    }
    expect(notices).toEqual([]);
  });
  it('refuses future inherited versions without a write', async () => {
    db.prepare('UPDATE global_settings SET settings=? WHERE id=1').run(
      JSON.stringify({ toolSelectionDefaults: { ...frozen, version: 2 } })
    );
    const before = current();
    expect(await write(ID, { kind: 'mcp', serverId: 'browser', enabled: null })).toEqual({
      ok: false,
      reason: 'selection_version_unsupported',
    });
    expect(current()).toEqual(before);
    expect(notices).toEqual([]);
  });
  it('uses global defaults when a new matching Space has no canonical template yet', async () => {
    db.prepare(
      "INSERT INTO spaces (id,name,slug,workspace_path,status,config,created_at,updated_at) VALUES ('space','Fixture','fixture','/synthetic','active',NULL,1,1)"
    ).run();
    repo.updateSession(ID, { context: { spaceId: 'space' } });
    db.prepare('UPDATE global_settings SET settings=? WHERE id=1').run(
      JSON.stringify({
        toolSelectionDefaults: { ...frozen, choices: { 'mcp:browser': { selected: true } } },
      })
    );
    expect((await write(ID, { kind: 'mcp', serverId: 'browser', enabled: null })).ok).toBe(true);
    expect(current().toolSelection?.choices['mcp:browser']).toEqual({
      selected: true,
      aliases: ['frozen-alias'],
    });
  });
});

describe('disabled-skill request authority', () => {
  it('persists the list even without tools and supports a disable/re-enable round trip', async () => {
    const priorTools = {
      disabledSkills: [],
      useClaudeCodePreset: false,
      loadSettingSources: false,
    };
    db.prepare('UPDATE sessions SET config=? WHERE id=?').run(
      JSON.stringify({ ...current(), tools: priorTools }),
      ID
    );
    expect((await write(ID, { kind: 'skills', disabledSkills: ['notes'] })).ok).toBe(true);
    expect(current().tools).toEqual({ ...priorTools, disabledSkills: ['notes'] });
    expect(current().toolSelection?.choices['skill:notes']?.selected).toBe(false);
    expect((await write(ID, { kind: 'skills', disabledSkills: [] })).ok).toBe(true);
    expect(current().tools).toEqual(priorTools);
    expect(current().toolSelection?.choices['skill:notes']?.selected).toBe(true);
    expect(current().sdkToolsPreset).toEqual(['Read']);
  });
  it('uses request IDs when supplied tools has a conflicting list', async () => {
    expect(
      (
        await write(
          ID,
          { kind: 'skills', disabledSkills: ['notes'] },
          { disabledSkills: ['wrapper'], useClaudeCodePreset: false }
        )
      ).ok
    ).toBe(true);
    expect(current().tools).toEqual({ disabledSkills: ['notes'], useClaudeCodePreset: false });
    expect(current().toolSelection?.choices['mcp:browser']?.selected).toBe(true);
    expect(current().toolSelection?.choices['skill:notes']?.selected).toBe(false);
    expect(
      (await write(ID, { kind: 'skills', disabledSkills: [] }, { disabledSkills: ['notes'] })).ok
    ).toBe(true);
    expect(current().tools?.disabledSkills).toEqual([]);
    expect(current().toolSelection?.choices['skill:notes']?.selected).toBe(true);
  });
  it('leaves skill vetoes unchanged on an MCP request even if optional settings supplies another list', async () => {
    const before = current().tools?.disabledSkills;
    expect(
      (
        await write(
          ID,
          { kind: 'mcp', serverId: 'browser', enabled: true },
          { disabledSkills: [], useClaudeCodePreset: false }
        )
      ).ok
    ).toBe(true);
    expect(current().tools).toEqual({ disabledSkills: before, useClaudeCodePreset: false });
    expect(current().toolSelection?.choices['skill:notes']?.selected).toBe(false);
  });
});
