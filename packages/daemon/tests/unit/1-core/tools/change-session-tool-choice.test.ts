import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { AppSkill, SpaceWorkflow } from '@hyperneo/shared';
import { computeDefinitionVersion } from '../../../../src/lib/workflows/definition-version.ts';
import { pinnedSlotVetoes } from '../../../../src/storage/repositories/session-tool-selection-migration.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables } from '../../../../src/storage/schema/index.ts';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository.ts';
import { createTestSession } from '../../../helpers/database.ts';
import {
  changeSessionToolChoice,
  type SessionToolChoiceChangeDependencies,
} from '../../../../src/lib/tools/change-session-tool-choice.ts';

const ID = 'synthetic-choice';
let db: Database;
let repo: SessionRepository;
let deps: SessionToolChoiceChangeDependencies;
let catalog: ReturnType<SessionToolChoiceChangeDependencies['catalog']>;
const wrapper = (name = 'new-wrapper-name'): AppSkill => ({
  id: name,
  name,
  displayName: name,
  description: '',
  sourceType: 'mcp_server',
  config: { type: 'mcp_server', appMcpServerId: 'browser' },
  enabled: false,
  builtIn: false,
  validationStatus: 'valid',
  createdAt: 1,
});
const fixture = () => ({
  ...createTestSession(ID),
  sdkSessionId: 'original-sdk',
  acpSessionId: 'original-acp',
  config: {
    ...createTestSession(ID).config,
    sdkToolsPreset: ['Read'],
    autoScroll: true,
    toolSelection: {
      version: 1 as const,
      choices: { 'mcp:browser': { selected: false, aliases: ['frozen-alias'] } },
    },
  },
});
const config = () => repo.getSession(ID)!.config;
const change = (selected = true) =>
  changeSessionToolChoice({ sessionId: ID, key: 'mcp:browser', selected }, deps);
beforeEach(() => {
  db = new Database(':memory:');
  createTables(db);
  repo = new SessionRepository(db);
  repo.createSession(fixture());
  catalog = {
    registry: [
      {
        id: 'browser',
        name: 'registry-name',
        sourceType: 'stdio',
        command: 'synthetic',
        enabled: false,
      },
    ],
    skills: [wrapper()],
    overrides: [],
    disabledSkillIds: ['new-wrapper-name'],
    skillOverrides: [{ skillId: 'new-wrapper-name', enabled: false }],
  };
  deps = {
    capture: repo.captureSessionRuntimeSettings.bind(repo),
    commit: async (snapshot, patch) => repo.casSessionRuntimeSettings(snapshot, patch),
    catalog: () => catalog,
    pinnedSlotVetoes: (snapshot) => pinnedSlotVetoes(db, snapshot.metadata),
  };
});
afterEach(() => db.close());

describe('session tool choice changes', () => {
  it('enables one frozen choice despite old preference gates while preserving aliases and other settings', async () => {
    const before = repo.getSession(ID)!;
    const result = await change();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.changed).toBe(true);
    expect(config()).toEqual({
      ...before.config,
      toolSelection: {
        version: 1,
        choices: { 'mcp:browser': { selected: true, aliases: ['frozen-alias'] } },
      },
    });
    expect(repo.getSession(ID)?.sdkSessionId).toBe('original-sdk');
    expect(repo.getSession(ID)?.acpSessionId).toBe('original-acp');
    expect(
      db
        .prepare("SELECT json_type(config, '$.toolSelection') AS type FROM sessions WHERE id=?")
        .get(ID)
    ).toEqual({ type: 'object' });
    expect(JSON.stringify(result)).not.toMatch(
      /original-sdk|command|synthetic-choice|registry-name/
    );
  });
  it('keeps repeated changes idempotent and retains aliases when disabled again', async () => {
    expect((await change()).ok).toBe(true);
    const enabled = config();
    expect(await change()).toEqual({ ok: true, changed: false, selection: enabled.toolSelection });
    expect(config()).toEqual(enabled);
    expect((await change(false)).ok).toBe(true);
    expect(config().toolSelection?.choices['mcp:browser']).toEqual({
      selected: false,
      aliases: ['frozen-alias'],
    });
  });
  it('initializes a legacy session from its effective preferences without serializing transport configuration', async () => {
    repo.updateSession(ID, { config: { ...fixture().config, toolSelection: undefined } });
    catalog.registry = [{ ...catalog.registry[0], env: { PRIVATE: 'secret' } }];
    expect((await change()).ok).toBe(true);
    expect(config().toolSelection?.choices['mcp:browser']).toEqual({
      selected: true,
      aliases: ['new-wrapper-name'],
    });
    expect(JSON.stringify(config().toolSelection)).not.toContain('secret');
  });
  it('ignores caller-supplied alias fields', async () => {
    const input = {
      sessionId: ID,
      key: 'mcp:browser' as const,
      selected: true,
      aliases: ['injected'],
    };
    expect((await changeSessionToolChoice(input, deps)).ok).toBe(true);
    expect(config().toolSelection?.choices['mcp:browser']?.aliases).toEqual(['frozen-alias']);
  });
  it('preserves a captured legacy veto when a different tool is changed', async () => {
    repo.updateSession(ID, {
      config: {
        ...fixture().config,
        toolSelection: undefined,
        tools: { disabledSkills: ['new-wrapper-name'] },
      },
    });
    catalog.registry = [{ ...catalog.registry[0], enabled: true }];
    catalog.skills = [
      { ...wrapper(), enabled: true },
      {
        ...wrapper('notes'),
        sourceType: 'builtin',
        config: { type: 'builtin', commandName: 'notes' },
      },
    ];
    delete catalog.disabledSkillIds;
    delete catalog.skillOverrides;
    expect(
      (await changeSessionToolChoice({ sessionId: ID, key: 'skill:notes', selected: true }, deps))
        .ok
    ).toBe(true);
    expect(config().toolSelection?.choices['mcp:browser']).toEqual({
      selected: false,
      aliases: ['new-wrapper-name'],
    });
    expect(config().toolSelection?.choices['skill:notes']?.selected).toBe(true);
  });
  it('projects pinned slot vetoes before freezing a legacy session, not a later workflow version', async () => {
    db.exec(`CREATE TABLE space_workflow_runs (id TEXT PRIMARY KEY, workflow_id TEXT, definition_version TEXT);
      CREATE TABLE space_workflow_definition_versions (workflow_id TEXT, version_hash TEXT, space_id TEXT, payload TEXT, source TEXT, created_at INTEGER);`);
    const workflow = {
      id: 'workflow',
      spaceId: 'space',
      name: 'Pinned fixture',
      nodes: [
        {
          id: 'node',
          name: 'Build',
          agents: [{ agentId: 'agent', name: 'Coder', disabledSkillIds: ['new-wrapper-name'] }],
        },
      ],
      startNodeId: 'node',
      tags: [],
      completionAutonomyLevel: 3,
      createdAt: 1,
      updatedAt: 1,
    } as SpaceWorkflow;
    const pinned = computeDefinitionVersion(workflow);
    const later = computeDefinitionVersion({
      ...workflow,
      nodes: [{ ...workflow.nodes[0], agents: [{ agentId: 'agent', name: 'Coder' }] }],
    });
    for (const [index, version] of [pinned, later].entries())
      db.prepare('INSERT INTO space_workflow_definition_versions VALUES (?, ?, ?, ?, ?, ?)').run(
        'workflow',
        version.versionHash,
        'space',
        version.payload,
        'create',
        index + 1
      );
    db.prepare('INSERT INTO space_workflow_runs VALUES (?, ?, ?)').run(
      'run',
      'workflow',
      pinned.versionHash
    );
    repo.updateSession(ID, {
      config: { ...fixture().config, toolSelection: undefined },
      metadata: {
        ...fixture().metadata,
        promptProvenance: {
          source: 'fixture',
          hash: 'fixture',
          workflowRunId: 'run',
          nodeId: 'node',
          agentId: 'agent',
          agentName: 'Coder',
        },
      },
    });
    catalog.registry = [{ ...catalog.registry[0], enabled: true }];
    catalog.skills = [
      { ...wrapper(), enabled: true },
      {
        ...wrapper('notes'),
        sourceType: 'builtin',
        config: { type: 'builtin', commandName: 'notes' },
      },
    ];
    delete catalog.disabledSkillIds;
    delete catalog.skillOverrides;
    expect(
      (await changeSessionToolChoice({ sessionId: ID, key: 'skill:notes', selected: true }, deps))
        .ok
    ).toBe(true);
    expect(config().toolSelection?.choices['mcp:browser']).toEqual({
      selected: false,
      aliases: ['new-wrapper-name'],
    });
    expect(config().toolSelection?.choices['skill:notes']?.selected).toBe(true);
    expect((await change()).ok).toBe(true);
    expect(config().toolSelection?.choices['mcp:browser']?.selected).toBe(true);
  });
  it('keeps later catalog additions off unless that exact choice is requested', async () => {
    catalog.registry = [
      ...catalog.registry,
      { id: 'new', name: 'new-server', sourceType: 'stdio', command: 'synthetic', enabled: true },
    ];
    expect((await change()).ok).toBe(true);
    expect(config().toolSelection?.choices['mcp:new']).toBeUndefined();
    expect(
      (await changeSessionToolChoice({ sessionId: ID, key: 'mcp:new', selected: true }, deps)).ok
    ).toBe(true);
    expect(config().toolSelection?.choices['mcp:new']).toEqual({
      selected: true,
      aliases: ['new-server'],
    });
  });
  it('refuses unknown or missing definitions without changing stored settings', async () => {
    const before = config();
    expect(
      await changeSessionToolChoice({ sessionId: ID, key: 'mcp:unknown', selected: true }, deps)
    ).toEqual({ ok: false, reason: 'missing-definition' });
    catalog.registry = [];
    expect(await change()).toEqual({ ok: false, reason: 'missing-definition' });
    expect(config()).toEqual(before);
  });
  it('refuses ambiguous new aliases instead of guessing a binding', async () => {
    repo.updateSession(ID, {
      config: {
        ...fixture().config,
        toolSelection: { version: 1, choices: { 'mcp:browser': { selected: false } } },
      },
    });
    catalog.skills = [wrapper('one'), wrapper('two')];
    const before = config();
    expect(await change()).toEqual({ ok: false, reason: 'ambiguous-alias' });
    expect(config()).toEqual(before);
  });
  it('does not persist ambiguous aliases merely by turning a choice off', async () => {
    repo.updateSession(ID, {
      config: { ...fixture().config, toolSelection: { version: 1, choices: {} } },
    });
    catalog.skills = [wrapper('one'), wrapper('two')];
    expect((await change(false)).ok).toBe(true);
    expect(config().toolSelection?.choices['mcp:browser']?.aliases).toEqual([]);
    expect(await change()).toEqual({ ok: false, reason: 'ambiguous-alias' });
  });
  it('refuses an alias collision without disabling another stored choice', async () => {
    catalog.registry = [
      ...catalog.registry,
      { id: 'other', name: 'other', sourceType: 'stdio', command: 'synthetic', enabled: true },
    ];
    const selection = {
      ...fixture().config.toolSelection,
      choices: {
        ...fixture().config.toolSelection.choices,
        'mcp:other': { selected: true, aliases: ['frozen-alias'] },
      },
    };
    repo.updateSession(ID, { config: { ...fixture().config, toolSelection: selection } });
    const before = config();
    expect(await change()).toEqual({ ok: false, reason: 'ambiguous-alias' });
    expect(config()).toEqual(before);
  });
  it('keeps policy restrictions authoritative but allows disabling a denied choice', async () => {
    catalog.denied = ['mcp:browser'];
    expect(await change()).toEqual({ ok: false, reason: 'policy-denied' });
    expect((await change(false)).ok).toBe(true);
    expect(config().toolSelection?.choices['mcp:browser']?.selected).toBe(false);
  });
  it('uses the captured Space identity to enforce Space-only instructions', async () => {
    catalog.skills = [
      {
        ...wrapper('scoped'),
        sourceType: 'builtin',
        config: { type: 'builtin', commandName: 'coordination', spaceOnly: true },
      },
    ];
    const input = { sessionId: ID, key: 'skill:scoped' as const, selected: true };
    expect(await changeSessionToolChoice(input, deps)).toEqual({
      ok: false,
      reason: 'space-required',
    });
    repo.updateSession(ID, { context: { spaceId: 'space' } });
    expect((await changeSessionToolChoice(input, deps)).ok).toBe(true);
    expect(config().toolSelection?.choices['skill:scoped']?.selected).toBe(true);
  });
  it('refuses unsupported stored selection versions without overwriting them', async () => {
    db.prepare(
      "UPDATE sessions SET config=json_set(config,'$.toolSelection.version',2) WHERE id=?"
    ).run(ID);
    const before = config();
    expect(await change()).toEqual({ ok: false, reason: 'selection_version_unsupported' });
    expect(config()).toEqual(before);
  });
  it('refuses missing and closed sessions', async () => {
    expect(
      await changeSessionToolChoice(
        { sessionId: 'missing', key: 'mcp:browser', selected: true },
        deps
      )
    ).toEqual({ ok: false, reason: 'session_not_found' });
    db.prepare("UPDATE sessions SET status='archived' WHERE id=?").run(ID);
    const before = config();
    expect(await change()).toEqual({ ok: false, reason: 'session_closed' });
    expect(config()).toEqual(before);
  });
  it('does not clobber a concurrent settings edit or retry a stale snapshot', async () => {
    deps.commit = async (snapshot, patch) => {
      db.prepare(
        "UPDATE sessions SET config=json_set(config,'$.autoScroll',json('false')) WHERE id=?"
      ).run(ID);
      return repo.casSessionRuntimeSettings(snapshot, patch);
    };
    expect(await change()).toEqual({ ok: false, reason: 'superseded' });
    expect(config().autoScroll).toBe(false);
    expect(config().toolSelection?.choices['mcp:browser']?.selected).toBe(false);
  });
  it('cannot apply to a deleted and recreated session with the same ID', async () => {
    deps.commit = async (snapshot, patch) => {
      db.prepare('DELETE FROM sessions WHERE id=?').run(ID);
      repo.createSession(fixture());
      return repo.casSessionRuntimeSettings(snapshot, patch);
    };
    expect(await change()).toEqual({ ok: false, reason: 'superseded' });
    expect(config().toolSelection?.choices['mcp:browser']?.selected).toBe(false);
  });
});
