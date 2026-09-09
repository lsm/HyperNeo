import { beforeEach, describe, expect, test } from 'bun:test';
import type { AgentModelPoolEntry, CreateSpaceAgentParams } from '@hyperneo/shared';
import { SpaceAgentRepository } from '../../../src/storage/repositories/space-agent-repository';
import { Database as BunDatabase } from '../../../src/storage/sqlite-compat';
import { createSpaceTables } from '../helpers/space-test-db';

const MODEL_POOL: AgentModelPoolEntry[] = [
  { model: 'claude-opus-5', provider: 'anthropic', maxConcurrent: 2, weight: 3 },
  { model: 'claude-sonnet-5', maxConcurrent: 4, weight: 1 },
];

function fullParams(): CreateSpaceAgentParams {
  return {
    spaceId: 'space-1',
    handle: 'researcher',
    displayName: 'Researcher',
    description: 'Investigates things.',
    instructions: 'Research carefully.',
    status: 'active',
    sessionId: 'session-1',
    autonomyLevel: 3,
    model: 'claude-opus-5',
    provider: 'anthropic',
    modelPool: MODEL_POOL,
    thinkingLevel: 'think16k',
    settingSources: ['user', 'project'],
    tools: ['Read', 'Grep', 'Glob'],
  };
}

describe('SpaceAgentRepository', () => {
  let repo: SpaceAgentRepository;
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    createSpaceTables(db);
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('space-1', 'space-1', '/tmp/space-1', 'Space One', Date.now(), Date.now());
    repo = new SpaceAgentRepository(db);
  });

  describe('create', () => {
    test('round-trips every field', () => {
      const agent = repo.create(fullParams());

      expect(agent.spaceId).toBe('space-1');
      expect(agent.handle).toBe('researcher');
      expect(agent.displayName).toBe('Researcher');
      expect(agent.description).toBe('Investigates things.');
      expect(agent.instructions).toBe('Research carefully.');
      expect(agent.status).toBe('active');
      expect(agent.sessionId).toBe('session-1');
      expect(agent.autonomyLevel).toBe(3);
      expect(agent.model).toBe('claude-opus-5');
      expect(agent.provider).toBe('anthropic');
      expect(agent.modelPool).toEqual(MODEL_POOL);
      expect(agent.thinkingLevel).toBe('think16k');
      expect(agent.settingSources).toEqual(['user', 'project']);
      expect(agent.tools).toEqual(['Read', 'Grep', 'Glob']);
      expect(agent.createdAt).toBeGreaterThan(0);
      expect(agent.updatedAt).toBe(agent.createdAt);
    });

    test('applies defaults for omitted optional fields', () => {
      const agent = repo.create({ spaceId: 'space-1', handle: 'minimal' });

      expect(agent.displayName).toBe('minimal');
      expect(agent.description).toBeNull();
      expect(agent.instructions).toBe('');
      expect(agent.status).toBe('active');
      expect(agent.sessionId).toBeNull();
      expect(agent.autonomyLevel).toBeNull();
      expect(agent.model).toBeNull();
      expect(agent.provider).toBeNull();
      expect(agent.modelPool).toBeNull();
      expect(agent.thinkingLevel).toBeNull();
      expect(agent.settingSources).toBeNull();
      expect(agent.tools).toBeNull();
    });

    test('honours a caller-supplied id and generates one otherwise', () => {
      const explicit = repo.create({ spaceId: 'space-1', handle: 'a', id: 'agent-fixed' });
      const generated = repo.create({ spaceId: 'space-1', handle: 'b' });

      expect(explicit.id).toBe('agent-fixed');
      expect(generated.id).not.toBe('agent-fixed');
      expect(generated.id.length).toBeGreaterThan(0);
    });

    test('stores an empty model pool as null', () => {
      const agent = repo.create({ spaceId: 'space-1', handle: 'empty-pool', modelPool: [] });

      expect(agent.modelPool).toBeNull();
    });

    test('does not record a template key on the created row', () => {
      const agent = repo.create(fullParams());
      const row = db
        .prepare(`SELECT template_key FROM space_long_horizon_agents WHERE id = ?`)
        .get(agent.id) as { template_key: string | null };

      expect(row.template_key).toBeNull();
    });
  });

  describe('reads', () => {
    test('getById returns null for an unknown id', () => {
      expect(repo.getById('nope')).toBeNull();
    });

    test('getByHandle finds an active agent and ignores archived ones', () => {
      const agent = repo.create({ spaceId: 'space-1', handle: 'researcher' });
      expect(repo.getByHandle('space-1', 'researcher')?.id).toBe(agent.id);

      repo.update(agent.id, { status: 'archived' });
      expect(repo.getByHandle('space-1', 'researcher')).toBeNull();
    });

    test('getBySessionId resolves the agent bound to a session', () => {
      const agent = repo.create({ spaceId: 'space-1', handle: 'chatty', sessionId: 'session-9' });

      expect(repo.getBySessionId('session-9')?.id).toBe(agent.id);
      expect(repo.getBySessionId('session-absent')).toBeNull();
    });

    test('listBySpaceId returns only that space, oldest first', () => {
      db.prepare(
        `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run('space-2', 'space-2', '/tmp/space-2', 'Space Two', Date.now(), Date.now());

      const first = repo.create({ spaceId: 'space-1', handle: 'first' });
      const second = repo.create({ spaceId: 'space-1', handle: 'second' });
      repo.create({ spaceId: 'space-2', handle: 'other-space' });

      const listed = repo.listBySpaceId('space-1');
      expect(listed.map((a) => a.id)).toEqual([first.id, second.id]);
    });
  });

  describe('update', () => {
    test('returns null for an unknown id', () => {
      expect(repo.update('nope', { displayName: 'X' })).toBeNull();
    });

    test('applies only the provided fields', () => {
      const agent = repo.create(fullParams());
      const updated = repo.update(agent.id, { displayName: 'Renamed', model: 'claude-sonnet-5' });

      expect(updated?.displayName).toBe('Renamed');
      expect(updated?.model).toBe('claude-sonnet-5');
      expect(updated?.instructions).toBe('Research carefully.');
      expect(updated?.provider).toBe('anthropic');
      expect(updated?.tools).toEqual(['Read', 'Grep', 'Glob']);
    });

    test('clears nullable fields when passed null', () => {
      const agent = repo.create(fullParams());
      const updated = repo.update(agent.id, {
        description: null,
        sessionId: null,
        autonomyLevel: null,
        model: null,
        provider: null,
        modelPool: null,
        thinkingLevel: null,
        settingSources: null,
        tools: null,
      });

      expect(updated?.description).toBeNull();
      expect(updated?.sessionId).toBeNull();
      expect(updated?.autonomyLevel).toBeNull();
      expect(updated?.model).toBeNull();
      expect(updated?.provider).toBeNull();
      expect(updated?.modelPool).toBeNull();
      expect(updated?.thinkingLevel).toBeNull();
      expect(updated?.settingSources).toBeNull();
      expect(updated?.tools).toBeNull();
    });

    test('preserves unknown tool permission keys when tools change', () => {
      const agent = repo.create({ spaceId: 'space-1', handle: 'legacy', tools: ['Read'] });
      db.prepare(`UPDATE space_long_horizon_agents SET tool_permissions_json = ? WHERE id = ?`).run(
        JSON.stringify({ mode: 'restricted', tools: ['Read'] }),
        agent.id
      );

      repo.update(agent.id, { tools: ['Read', 'Write'] });

      const row = db
        .prepare(`SELECT tool_permissions_json FROM space_long_horizon_agents WHERE id = ?`)
        .get(agent.id) as { tool_permissions_json: string };
      expect(JSON.parse(row.tool_permissions_json)).toEqual({
        mode: 'restricted',
        tools: ['Read', 'Write'],
      });
    });

    test('drops the tools key but keeps siblings when tools is cleared', () => {
      const agent = repo.create({ spaceId: 'space-1', handle: 'legacy', tools: ['Read'] });
      db.prepare(`UPDATE space_long_horizon_agents SET tool_permissions_json = ? WHERE id = ?`).run(
        JSON.stringify({ mode: 'restricted', tools: ['Read'] }),
        agent.id
      );

      repo.update(agent.id, { tools: null });

      const row = db
        .prepare(`SELECT tool_permissions_json FROM space_long_horizon_agents WHERE id = ?`)
        .get(agent.id) as { tool_permissions_json: string };
      expect(JSON.parse(row.tool_permissions_json)).toEqual({ mode: 'restricted' });
    });

    test('is a no-op read when no fields are supplied', () => {
      const agent = repo.create(fullParams());
      const updated = repo.update(agent.id, {});

      expect(updated).toEqual(agent);
    });
  });

  describe('delete', () => {
    test('removes the agent', () => {
      const agent = repo.create(fullParams());
      repo.delete(agent.id);

      expect(repo.getById(agent.id)).toBeNull();
    });

    test('is silent for an unknown id', () => {
      expect(() => repo.delete('nope')).not.toThrow();
    });
  });

  describe('legacy rows', () => {
    test('reads a row written by the existing long-horizon path', () => {
      const now = Date.now();
      db.prepare(
        `INSERT INTO space_long_horizon_agents (
           id, space_id, handle, display_name, template_key, status, instructions,
           tool_permissions_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'legacy-1',
        'space-1',
        'legacy',
        'Legacy Agent',
        'coder.v1',
        'active',
        'Do the thing.',
        JSON.stringify({ tools: ['Read'] }),
        now,
        now
      );

      const agent = repo.getById('legacy-1');
      expect(agent?.displayName).toBe('Legacy Agent');
      expect(agent?.instructions).toBe('Do the thing.');
      expect(agent?.tools).toEqual(['Read']);
    });

    test('maps malformed tool permissions to null tools', () => {
      const agent = repo.create({ spaceId: 'space-1', handle: 'broken' });
      db.prepare(`UPDATE space_long_horizon_agents SET tool_permissions_json = ? WHERE id = ?`).run(
        'not json',
        agent.id
      );

      expect(repo.getById(agent.id)?.tools).toBeNull();
    });
  });
});
