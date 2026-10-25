import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { AppSkill, MessageHub } from '@hyperneo/shared';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables } from '../../../../src/storage/schema/index.ts';
import { createSpaceTables } from '../../helpers/space-test-db.ts';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { SkillRepository } from '../../../../src/storage/repositories/skill-repository.ts';
import { AppMcpServerRepository } from '../../../../src/storage/repositories/app-mcp-server-repository.ts';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository.ts';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
import { SkillsManager } from '../../../../src/lib/skills-manager.ts';
import { registerSkillHandlers } from '../../../../src/lib/rpc-handlers/skill-handlers.ts';
import { createSkillValidateHandler } from '../../../../src/lib/job-handlers/skill-validate.handler.ts';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import { noOpReactiveDb } from '../../../helpers/reactive-database.ts';
import { createTestSession } from '../../../helpers/database.ts';

let db: Database;
let gateway: DbGateway;
let skills: SkillRepository;
let registry: AppMcpServerRepository;
let jobs: JobQueueRepository;
let manager: SkillsManager;
let sessions: SessionRepository;
let handlers: Map<string, (data: unknown) => unknown>;
let publish: ReturnType<typeof mock>;
const original = { version: 1, choices: { 'skill:notes': { selected: false } } };
const defaults = (space = false) =>
  JSON.parse(
    (
      db
        .prepare(
          space
            ? "SELECT config AS json FROM spaces WHERE id='space'"
            : 'SELECT settings AS json FROM global_settings WHERE id=1'
        )
        .get() as { json: string }
    ).json
  ).toolSelectionDefaults;
const call = (method: string, data: unknown) => Promise.resolve(handlers.get(method)!(data));
const create = (enabled = true) => ({
  params: {
    name: 'created',
    displayName: 'Created',
    description: '',
    sourceType: 'builtin',
    config: { type: 'builtin', commandName: 'created' },
    enabled,
  },
});
beforeEach(() => {
  db = new Database(':memory:');
  createTables(db);
  createSpaceTables(db);
  gateway = new DbGateway(':memory:', db);
  skills = new SkillRepository(db, noOpReactiveDb);
  registry = new AppMcpServerRepository(db, noOpReactiveDb);
  jobs = new JobQueueRepository(db);
  manager = new SkillsManager(skills, registry, { gateway }, jobs);
  sessions = new SessionRepository(db);
  skills.insert({
    id: 'notes',
    name: 'notes',
    displayName: 'Notes',
    description: '',
    sourceType: 'builtin',
    config: { type: 'builtin', commandName: 'notes' },
    enabled: false,
    builtIn: false,
    validationStatus: 'valid',
    createdAt: 1,
  });
  db.prepare('UPDATE global_settings SET settings=? WHERE id=1').run(
    JSON.stringify({ toolSelectionDefaults: original })
  );
  db.prepare(
    "INSERT INTO spaces (id,slug,name,workspace_path,config,created_at,updated_at) VALUES ('space','space','Space','/synthetic',?,1,1)"
  ).run(JSON.stringify({ toolSelectionDefaults: original }));
  sessions.createSession({
    ...createTestSession('frozen'),
    config: { ...createTestSession('frozen').config, toolSelection: original },
  });
  handlers = new Map();
  publish = mock(async () => {});
  registerSkillHandlers(
    {
      onRequest: (method: string, handler: (data: unknown) => unknown) =>
        handlers.set(method, handler),
    } as unknown as MessageHub,
    manager,
    { publish } as unknown as InternalEventBus<never>
  );
});
afterEach(async () => {
  await gateway.close();
  db.close();
});

describe('skill default RPC writes', () => {
  it.each(['skill.setEnabled', 'skill.update'])(
    '%s persists intent in global and Space templates without changing frozen sessions',
    async (method) => {
      const response = (await call(method, {
        id: 'notes',
        enabled: true,
        params: { enabled: true },
      })) as { skill: AppSkill };
      expect(response.skill.enabled).toBe(true);
      expect(defaults().choices['skill:notes'].selected).toBe(true);
      expect(defaults(true).choices['skill:notes'].selected).toBe(true);
      expect(sessions.getSession('frozen')!.config.toolSelection).toEqual(original);
      expect(publish).toHaveBeenCalledTimes(1);
    }
  );
  it('creates and deletes default choices with the catalog row', async () => {
    const { skill } = (await call('skill.create', create())) as { skill: AppSkill };
    expect(defaults().choices[`skill:${skill.id}`].selected).toBe(true);
    expect(defaults(true).choices[`skill:${skill.id}`].selected).toBe(true);
    expect(jobs.listJobs({ queue: 'skill.validate' })).toHaveLength(1);
    await call('skill.delete', { id: skill.id });
    expect(skills.get(skill.id)).toBeNull();
    expect(defaults().choices[`skill:${skill.id}`].selected).toBe(false);
  });
  it('rolls back row/default failures before publishing or scheduling validation', async () => {
    db.exec(
      "CREATE TRIGGER reject_skill_default BEFORE UPDATE ON spaces BEGIN SELECT RAISE(ABORT,'synthetic skill default failure'); END"
    );
    await expect(call('skill.create', create())).rejects.toThrow('synthetic skill default failure');
    expect(skills.getByName('created')).toBeNull();
    expect(defaults()).toEqual(original);
    expect(defaults(true)).toEqual(original);
    expect(jobs.listJobs({ queue: 'skill.validate' })).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });
  it('rolls back config, pending validation and enablement as one update', async () => {
    db.exec(
      "CREATE TRIGGER reject_skill_default BEFORE UPDATE ON spaces BEGIN SELECT RAISE(ABORT,'synthetic skill default failure'); END"
    );
    await expect(
      call('skill.update', {
        id: 'notes',
        params: { enabled: true, config: { type: 'builtin', commandName: 'changed' } },
      })
    ).rejects.toThrow('synthetic skill default failure');
    expect(skills.get('notes')).toMatchObject({
      enabled: false,
      validationStatus: 'valid',
      config: { commandName: 'notes' },
    });
    expect(jobs.listJobs({ queue: 'skill.validate' })).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });
  it('maps an explicit wrapper toggle to the canonical server despite the old server veto', async () => {
    const server = registry.create({
      name: 'browser',
      sourceType: 'stdio',
      command: 'synthetic',
      enabled: false,
    });
    const { skill } = (await call('skill.create', {
      params: {
        ...create(false).params,
        sourceType: 'mcp_server',
        config: { type: 'mcp_server', appMcpServerId: server.id },
      },
    })) as { skill: AppSkill };
    await call('skill.setEnabled', { id: skill.id, enabled: true });
    expect(defaults().choices[`mcp:${server.id}`].selected).toBe(true);
    expect(defaults().choices[`skill:${skill.id}`]).toBeUndefined();
  });
  it('keeps config validation, built-in deletion and missing-id admission', async () => {
    await expect(
      call('skill.create', {
        params: { ...create().params, config: { type: 'builtin', commandName: '' } },
      })
    ).rejects.toThrow('commandName');
    skills.insert({ ...skills.get('notes')!, id: 'builtin', name: 'builtin', builtIn: true });
    await expect(call('skill.delete', { id: 'builtin' })).rejects.toThrow('cannot be removed');
    await expect(call('skill.setEnabled', { id: 'missing', enabled: true })).rejects.toThrow(
      'Skill not found: missing'
    );
    expect(publish).not.toHaveBeenCalled();
  });
  it('validation completion waits for its commit and leaves canonical intent intact', async () => {
    const handle = createSkillValidateHandler(manager, registry);
    const job = jobs.enqueue({ queue: 'skill.validate', payload: { skillId: 'notes' } });
    db.exec(
      "CREATE TRIGGER reject_skill_validation BEFORE UPDATE OF validation_status ON skills BEGIN SELECT RAISE(ABORT,'synthetic validation failure'); END"
    );
    await expect(handle(job)).rejects.toThrow('synthetic validation failure');
    expect(defaults()).toEqual(original);
  });
});
