import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { AppSkill, SpaceWorkflow } from '@hyperneo/shared';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import {
  migrateSessionToolSelections,
  type ToolSelectionCatalog,
} from '../../../../src/storage/repositories/session-tool-selection-migration.ts';
import { computeDefinitionVersion } from '../../../../src/lib/workflows/definition-version.ts';

let db: Database;
let catalog: ToolSelectionCatalog;
const wrapper = (enabled = true): AppSkill => ({
  id: 'wrapper',
  name: 'browser-alias',
  displayName: 'Browser',
  description: '',
  sourceType: 'mcp_server',
  config: { type: 'mcp_server', appMcpServerId: 'browser' },
  enabled,
  builtIn: true,
  validationStatus: 'valid',
  createdAt: 0,
});
const session = (id: string, config = {}, context = {}, metadata = {}) =>
  db
    .prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)')
    .run(id, JSON.stringify(config), JSON.stringify(context), JSON.stringify(metadata));
const read = (id: string) =>
  JSON.parse(
    (db.prepare('SELECT config FROM sessions WHERE id=?').get(id) as { config: string }).config
  );
const selected = (id: string) => read(id).toolSelection.choices['mcp:browser'].selected;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, config TEXT, session_context TEXT, metadata TEXT);
    CREATE TABLE spaces (id TEXT PRIMARY KEY, config TEXT);
    CREATE TABLE global_settings (id INTEGER PRIMARY KEY, settings TEXT);
    CREATE TABLE space_workflow_runs (id TEXT PRIMARY KEY, workflow_id TEXT, definition_version TEXT);
    CREATE TABLE space_workflow_definition_versions (workflow_id TEXT, version_hash TEXT, space_id TEXT, payload TEXT, source TEXT, created_at INTEGER);
    INSERT INTO global_settings VALUES (1, '{"settingSources":[],"nativeProfile":"untouched"}');
    INSERT INTO spaces VALUES ('space', '{"maxConcurrentTasks":3}');`);
  catalog = {
    skills: [wrapper()],
    registry: [
      {
        id: 'browser',
        name: 'registry-browser',
        enabled: true,
        sourceType: 'stdio',
        command: 'synthetic',
      },
    ],
    overrides: [],
  };
});
afterEach(() => db.close());

describe('legacy tool selection migration', () => {
  it('freezes server-on/skill-off as off with the original SDK alias', () => {
    session('inbox');
    catalog.skills = [wrapper(false)];
    migrateSessionToolSelections(db, catalog);
    expect(read('inbox').toolSelection).toEqual({
      version: 1,
      choices: { 'mcp:browser': { selected: false, aliases: ['browser-alias'] } },
    });
  });
  it('keeps session and Space overrides independent from global defaults', () => {
    session('space-session', {}, { spaceId: 'space' });
    session('session-on', {}, { spaceId: 'space' });
    session('inbox');
    catalog.overrides = [
      { scopeType: 'space', scopeId: 'space', serverId: 'browser', enabled: false },
      { scopeType: 'session', scopeId: 'session-on', serverId: 'browser', enabled: true },
    ];
    migrateSessionToolSelections(db, catalog);
    expect(selected('space-session')).toBe(false);
    expect(selected('session-on')).toBe(true);
    expect(selected('inbox')).toBe(true);
    const global = JSON.parse(
      (db.prepare('SELECT settings FROM global_settings').get() as { settings: string }).settings
    );
    const space = JSON.parse(
      (db.prepare('SELECT config FROM spaces').get() as { config: string }).config
    );
    expect(global.toolSelectionDefaults.choices['mcp:browser'].selected).toBe(true);
    expect(space.toolSelectionDefaults.choices['mcp:browser'].selected).toBe(false);
    expect(space.maxConcurrentTasks).toBe(3);
    expect(global.nativeProfile).toBe('untouched');
  });
  it('keeps explicit session skill vetoes and unrelated session settings', () => {
    session('veto', {
      model: 'haiku',
      tools: { disabledSkills: ['wrapper'] },
      sdkToolsPreset: ['Read'],
    });
    migrateSessionToolSelections(db, catalog);
    expect(selected('veto')).toBe(false);
    expect(read('veto')).toMatchObject({
      model: 'haiku',
      tools: { disabledSkills: ['wrapper'] },
      sdkToolsPreset: ['Read'],
    });
  });
  it('does not recompute a migrated choice after global or default edits', () => {
    session('existing');
    expect(migrateSessionToolSelections(db, catalog)).toBe(3);
    const before = read('existing');
    catalog.skills = [wrapper(false)];
    catalog.registry = [];
    expect(migrateSessionToolSelections(db, catalog)).toBe(0);
    expect(read('existing')).toEqual(before);
  });
  it('preserves an explicit canonical off and future selection versions byte for byte', () => {
    const original = {
      model: 'haiku',
      toolSelection: {
        version: 8,
        choices: { 'mcp:browser': { selected: false, aliases: ['frozen'] } },
      },
    };
    session('canonical', original);
    migrateSessionToolSelections(db, catalog);
    expect(read('canonical')).toEqual(original);
  });
  it('projects a newly found legacy session without changing existing frozen selections', () => {
    session('existing');
    migrateSessionToolSelections(db, catalog);
    catalog.skills = [wrapper(false)];
    session('new');
    expect(migrateSessionToolSelections(db, catalog)).toBe(1);
    expect(selected('existing')).toBe(true);
    expect(selected('new')).toBe(false);
  });
  it('takes worker vetoes from the pinned workflow version, not a newer definition', () => {
    const workflow = {
      id: 'workflow',
      spaceId: 'space',
      name: 'Fixture',
      nodes: [
        {
          id: 'node',
          name: 'Build',
          agents: [{ agentId: 'agent', name: 'Coder', disabledSkillIds: ['wrapper'] }],
        },
      ],
      startNodeId: 'node',
      tags: [],
      completionAutonomyLevel: 3,
      createdAt: 1,
      updatedAt: 1,
    } as SpaceWorkflow;
    const { versionHash, payload } = computeDefinitionVersion(workflow);
    db.prepare('INSERT INTO space_workflow_definition_versions VALUES (?, ?, ?, ?, ?, ?)').run(
      'workflow',
      versionHash,
      'space',
      payload,
      'create',
      1
    );
    db.prepare('INSERT INTO space_workflow_runs VALUES (?, ?, ?)').run(
      'run',
      'workflow',
      versionHash
    );
    session(
      'worker',
      {},
      { spaceId: 'space' },
      {
        promptProvenance: {
          workflowRunId: 'run',
          nodeId: 'node',
          agentId: 'agent',
          agentName: 'Coder',
        },
      }
    );
    const updated = computeDefinitionVersion({
      ...workflow,
      nodes: [{ ...workflow.nodes[0], agents: [{ agentId: 'agent', name: 'Coder' }] }],
    });
    db.prepare('INSERT INTO space_workflow_definition_versions VALUES (?, ?, ?, ?, ?, ?)').run(
      'workflow',
      updated.versionHash,
      'space',
      updated.payload,
      'update',
      2
    );
    migrateSessionToolSelections(db, catalog);
    expect(selected('worker')).toBe(false);
    expect(
      db
        .prepare('SELECT payload FROM space_workflow_definition_versions WHERE version_hash=?')
        .get(versionHash)
    ).toEqual({ payload });
  });
  it('keeps Space-only skills off in inbox defaults and on in Space defaults', () => {
    catalog.skills = [
      {
        ...wrapper(),
        id: 'space-skill',
        sourceType: 'builtin',
        config: { type: 'builtin', commandName: 'coordination', spaceOnly: true },
      },
    ];
    migrateSessionToolSelections(db, catalog);
    const global = JSON.parse(
      (db.prepare('SELECT settings FROM global_settings').get() as { settings: string }).settings
    );
    const space = JSON.parse(
      (db.prepare('SELECT config FROM spaces').get() as { config: string }).config
    );
    expect(global.toolSelectionDefaults.choices['skill:space-skill'].selected).toBe(false);
    expect(space.toolSelectionDefaults.choices['skill:space-skill'].selected).toBe(true);
  });
  it('rolls back the whole migration when a stored configuration cannot be parsed', () => {
    session('good');
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run('bad', '{broken', '{}', '{}');
    expect(() => migrateSessionToolSelections(db, catalog)).toThrow();
    expect(read('good').toolSelection).toBeUndefined();
    expect(
      JSON.parse(
        (db.prepare('SELECT settings FROM global_settings').get() as { settings: string }).settings
      ).toolSelectionDefaults
    ).toBeUndefined();
  });
});
