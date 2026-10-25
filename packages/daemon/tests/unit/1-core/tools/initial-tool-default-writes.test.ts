import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { MessageHub } from '@hyperneo/shared';
import type { Session } from '@hyperneo/shared';
import type { Database } from '../../../../src/storage/database.ts';
import { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository.ts';
import {
  createTestDb,
  createTestInternalEventBus,
  createTestSession,
} from '../../../helpers/database.ts';

let db: Database;
let hub: MessageHub;
let agents: AgentSession[];
const selection = (selected = true) => ({
  version: 1 as const,
  choices: {
    'mcp:browser': { selected, aliases: ['frozen-browser'] },
    'skill:notes': { selected, aliases: [] },
  },
});
const make = (id: string, config: Partial<Session['config']> = {}, spaceId?: string): Session => ({
  ...createTestSession(id),
  context: spaceId ? { spaceId } : undefined,
  config: { ...createTestSession(id).config, sdkToolsPreset: ['Read'], ...config },
});
beforeEach(async () => {
  db = await createTestDb();
  hub = new MessageHub({ defaultSessionId: 'global' });
  agents = [];
  const raw = db.getDatabase();
  raw
    .prepare(
      "INSERT INTO app_mcp_servers(id,name,source_type,command,enabled) VALUES ('browser','browser','stdio','not-executed',0)"
    )
    .run();
  for (const [id, config] of [
    ['wrapper', { type: 'mcp_server', appMcpServerId: 'browser' }],
    ['notes', { type: 'builtin', commandName: 'notes' }],
  ] as const)
    raw
      .prepare(
        "INSERT INTO skills(id,name,display_name,description,source_type,config,enabled,created_at) VALUES(?,?,?,'',?,?,0,1)"
      )
      .run(id, id, id, config.type, JSON.stringify(config));
  raw
    .prepare('UPDATE global_settings SET settings=? WHERE id=1')
    .run(JSON.stringify({ toolSelectionDefaults: selection() }));
});
afterEach(async () => {
  for (const agent of agents) await agent.cleanup();
  hub.cleanup();
  await db.close();
});

describe('initial canonical tool default writes', () => {
  it('freezes global intent in the inserted record and the caller snapshot despite old catalog-off flags', async () => {
    const session = make('global');
    await db.createSession(session);
    expect(db.getSession(session.id)!.config.toolSelection).toEqual(selection());
    expect(session.config.toolSelection).toEqual(selection());
    expect(session.config.sdkToolsPreset).toEqual(['Read']);
    expect(db.appMcpServers.get('browser')!.enabled).toBe(false);
  });
  it('chooses only matching Space defaults and otherwise uses global defaults', async () => {
    const spaces = new SpaceRepository(db.getDatabase());
    const first = spaces.createSpace({
      slug: 'first',
      name: 'First',
      workspacePath: '/synthetic/first',
    });
    const second = spaces.createSpace({
      slug: 'second',
      name: 'Second',
      workspacePath: '/synthetic/second',
    });
    db.getDatabase()
      .prepare('UPDATE spaces SET config=? WHERE id=?')
      .run(JSON.stringify({ toolSelectionDefaults: selection(false) }), first.id);
    for (const [id, scope, expected] of [
      ['scoped', first.id, false],
      ['inherit', second.id, true],
      ['unscoped', undefined, true],
    ] as const) {
      const session = make(id, {}, scope);
      await db.createSession(session);
      expect(session.config.toolSelection).toEqual(selection(expected));
    }
  });
  it('captures session vetoes once without mutating the saved template', async () => {
    const session = make('veto', { tools: { disabledSkills: ['notes', 'wrapper'] } });
    await db.createSession(session);
    expect(session.config.toolSelection).toEqual(selection(false));
    expect(
      JSON.parse(
        (
          db.getDatabase().prepare('SELECT settings FROM global_settings WHERE id=1').get() as {
            settings: string;
          }
        ).settings
      ).toolSelectionDefaults
    ).toEqual(selection());
    db.getDatabase()
      .prepare('UPDATE global_settings SET settings=? WHERE id=1')
      .run(JSON.stringify({ toolSelectionDefaults: selection(false) }));
    expect(db.getSession('veto')!.config.toolSelection).toEqual(selection(false));
  });
  it('captures workflow vetoes before the queued write can observe caller mutations', async () => {
    const session = make('captured-veto');
    const overrides = [{ skillId: 'wrapper', enabled: false }];
    const pending = db.createSession(session, { initialSkillOverrides: overrides });
    overrides[0].enabled = true;
    await pending;
    expect(session.config.toolSelection?.choices['mcp:browser'].selected).toBe(false);
    expect(session.config.toolSelection?.choices['skill:notes'].selected).toBe(true);
  });
  it('captures session veto arrays before the queued write can observe caller mutations', async () => {
    const disabledSkills = ['wrapper'];
    const session = make('captured-session-veto', { tools: { disabledSkills } });
    const pending = db.createSession(session);
    disabledSkills.length = 0;
    await pending;
    expect(session.config.toolSelection?.choices['mcp:browser'].selected).toBe(false);
  });
  it('does not publish a caller snapshot if insertion fails', async () => {
    const session = make('rejected-insert');
    db.getDatabase().exec(
      "CREATE TRIGGER reject_initial_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT,'synthetic creation failure'); END"
    );
    await expect(db.createSession(session)).rejects.toThrow('synthetic creation failure');
    expect(db.getSession(session.id)).toBeNull();
    expect(session.config.toolSelection).toBeUndefined();
  });
  it('freezes workflow initialization vetoes in AgentSession.fromInit and retains them on reload', async () => {
    const bus = await createTestInternalEventBus();
    const init = {
      sessionId: 'workflow',
      workspacePath: '/synthetic',
      type: 'worker' as const,
      model: 'haiku',
      sdkToolsPreset: ['Read'],
      skillOverrides: [
        { skillId: 'wrapper', enabled: false },
        { skillId: 'notes', enabled: false },
      ],
    };
    const agent = await AgentSession.fromInit(init, db, hub, bus, async () => null, 'haiku');
    agents.push(agent);
    expect(agent.getSessionData().config.toolSelection).toEqual(selection(false));
    expect(db.getSession(init.sessionId)!.config.toolSelection).toEqual(selection(false));
    await agent.cleanup();
    agents = [];
    const reloaded = await AgentSession.fromInit(
      { ...init, skillOverrides: [] },
      db,
      hub,
      bus,
      async () => null,
      'haiku'
    );
    agents.push(reloaded);
    expect(reloaded.getSessionData().config.toolSelection).toEqual(selection(false));
  });
  it('preserves a supplied frozen selection rather than reapplying new vetoes', async () => {
    const session = make('frozen', {
      toolSelection: selection(),
      tools: { disabledSkills: ['notes', 'wrapper'] },
    });
    await db.createSession(session);
    expect(db.getSession('frozen')!.config.toolSelection).toEqual(selection());
  });
  it('refuses unsupported default versions without inserting a session or altering the input', async () => {
    db.getDatabase()
      .prepare('UPDATE global_settings SET settings=? WHERE id=1')
      .run(JSON.stringify({ toolSelectionDefaults: { version: 2, choices: {} } }));
    const session = make('unsupported');
    await expect(db.createSession(session)).rejects.toThrow('selection_version_unsupported');
    expect(db.getSession(session.id)).toBeNull();
    expect(session.config.toolSelection).toBeUndefined();
  });
  it('falls back to legacy effective choices only when no template is present', async () => {
    db.getDatabase().prepare("UPDATE global_settings SET settings='{}' WHERE id=1").run();
    const session = make('legacy');
    await db.createSession(session);
    expect(session.config.toolSelection?.choices['mcp:browser'].selected).toBe(false);
    expect(session.config.toolSelection?.choices['skill:notes'].selected).toBe(false);
  });
});
