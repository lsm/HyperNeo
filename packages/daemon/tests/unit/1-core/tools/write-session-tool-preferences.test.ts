import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables } from '../../../../src/storage/schema/index.ts';
import { createSpaceTables } from '../../helpers/space-test-db.ts';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository.ts';
import { SkillRepository } from '../../../../src/storage/repositories/skill-repository.ts';
import { AppMcpServerRepository } from '../../../../src/storage/repositories/app-mcp-server-repository.ts';
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
let data: PreferenceDatabase;
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
    getDatabase: () => db,
    captureSessionRuntimeSettings: (id) => repo.captureSessionRuntimeSettings(id),
    casSessionToolPreferences: async (...args) => repo.casSessionToolPreferences(...args),
    skills: new SkillRepository(db, changes),
    appMcpServers: new AppMcpServerRepository(db, changes),
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
