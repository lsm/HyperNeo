import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessageHub, SpaceAgent } from '@hyperneo/shared';
import {
  setupSpaceAgentV2Handlers,
  type SpaceAgentV2Deps,
} from '../../../../src/lib/rpc-handlers/space-agent-v2-handlers';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository';
import { SpaceAgentTemplateRepository } from '../../../../src/storage/repositories/space-agent-template-repository';
import { runMigration226 } from '../../../../src/storage/schema/m226-space-agent-templates-version';
import { runMigration227 } from '../../../../src/storage/schema/m227-space-agent-template-version-seq';
import { runMigration238 } from '../../../../src/storage/schema/m238-space-agent-template-labels';
import { createSpaceAgentTemplatesTable } from '../../../../src/storage/schema/space-agent-templates';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createSpaceTables } from '../../helpers/space-test-db';

type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

function createMockMessageHub(): { hub: MessageHub; handlers: Map<string, RequestHandler> } {
  const handlers = new Map<string, RequestHandler>();
  const hub = {
    onRequest: mock((methodName: string, handler: RequestHandler) => {
      handlers.set(methodName, handler);
      return () => handlers.delete(methodName);
    }),
  } as unknown as MessageHub;
  return { hub, handlers };
}

function call<T>(handlers: Map<string, RequestHandler>, methodName: string, data: unknown) {
  const handler = handlers.get(methodName);
  if (!handler) throw new Error(`no handler registered for ${methodName}`);
  return handler(data, {}) as Promise<T>;
}

describe('setupSpaceAgentV2Handlers', () => {
  let db: Database;
  let agents: SpaceAgentRepository;
  let templates: SpaceAgentTemplateRepository;
  let handlers: Map<string, RequestHandler>;
  let deps: SpaceAgentV2Deps;
  let sessions: Map<string, { type: string; context?: { spaceId?: string | null } | null }>;
  let published: Array<{ topic: string; payload: unknown }>;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    createSpaceAgentTemplatesTable(db);
    runMigration226(db);
    runMigration227(db);
    runMigration238(db);
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('space-1', 'space-1', '/tmp/space-1', 'Space One', Date.now(), Date.now());

    agents = new SpaceAgentRepository(db);
    templates = new SpaceAgentTemplateRepository(db);
    sessions = new Map([
      ['session-1', { type: 'space_chat', context: { spaceId: 'space-1' } }],
      ['session-2', { type: 'space_chat', context: { spaceId: 'space-1' } }],
    ]);
    published = [];
    deps = {
      agents,
      templates,
      spaceExists: async (id) => id === 'space-1',
      getSession: (id) => sessions.get(id) ?? null,
      internalEventBus: {
        publish: async (topic: string, payload: unknown) => {
          published.push({ topic, payload });
        },
      } as unknown as SpaceAgentV2Deps['internalEventBus'],
    };

    const hubData = createMockMessageHub();
    handlers = hubData.handlers;
    setupSpaceAgentV2Handlers(hubData.hub, deps);
  });

  describe('registration', () => {
    test('registers the five agent methods under spaceAgentV2', () => {
      expect([...handlers.keys()].sort()).toEqual([
        'spaceAgentV2.create',
        'spaceAgentV2.delete',
        'spaceAgentV2.get',
        'spaceAgentV2.list',
        'spaceAgentV2.update',
      ]);
    });

    test('does not shadow any spaceAgent method', () => {
      for (const key of handlers.keys()) expect(key.startsWith('spaceAgentV2.')).toBe(true);
    });
  });

  describe('create', () => {
    test('creates an agent from a plain request', async () => {
      const { agent } = await call<{ agent: SpaceAgent }>(handlers, 'spaceAgentV2.create', {
        spaceId: 'space-1',
        displayName: 'My Agent',
      });

      expect(agent.handle).toBe('my-agent');
      expect(agent.displayName).toBe('My Agent');
      expect(agents.getById(agent.id)).not.toBeNull();
    });

    test('copies configuration from a template', async () => {
      templates.create({
        key: 'researcher.v1',
        handle: 'researcher',
        displayName: 'Researcher',
        description: 'Investigates things.',
        instructions: 'Research carefully.',
        suggestedAutonomyLevel: 3,
        tools: ['Read', 'Grep'],
      });

      const { agent } = await call<{ agent: SpaceAgent }>(handlers, 'spaceAgentV2.create', {
        spaceId: 'space-1',
        templateKey: 'researcher.v1',
      });

      expect(agent.instructions).toBe('Research carefully.');
      expect(agent.autonomyLevel).toBe(3);
      expect(agent.tools).toEqual(['Read', 'Grep']);
    });

    test('leaves the created row disconnected from its template', async () => {
      templates.create({
        key: 'researcher.v1',
        handle: 'researcher',
        displayName: 'Researcher',
        instructions: 'Research carefully.',
        suggestedAutonomyLevel: 2,
      });

      const { agent } = await call<{ agent: SpaceAgent }>(handlers, 'spaceAgentV2.create', {
        spaceId: 'space-1',
        templateKey: 'researcher.v1',
      });
      const row = db
        .prepare(`SELECT template_key FROM space_long_horizon_agents WHERE id = ?`)
        .get(agent.id) as { template_key: string | null };

      expect(row.template_key).toBeNull();
    });

    test('a later template edit does not touch the created agent', async () => {
      templates.create({
        key: 'researcher.v1',
        handle: 'researcher',
        displayName: 'Researcher',
        instructions: 'Original.',
        suggestedAutonomyLevel: 2,
      });
      const { agent } = await call<{ agent: SpaceAgent }>(handlers, 'spaceAgentV2.create', {
        spaceId: 'space-1',
        templateKey: 'researcher.v1',
      });

      templates.update('researcher.v1', { instructions: 'Rewritten.' });

      expect(agents.getById(agent.id)?.instructions).toBe('Original.');
    });

    test('surfaces a pipeline rejection as an error', async () => {
      await expect(
        call(handlers, 'spaceAgentV2.create', { spaceId: 'space-1', templateKey: 'missing.v1' })
      ).rejects.toThrow('Template not found: missing.v1');
    });

    test('rejects an unknown space', async () => {
      await expect(
        call(handlers, 'spaceAgentV2.create', { spaceId: 'ghost', displayName: 'X' })
      ).rejects.toThrow('Space not found: ghost');
    });

    test('requires a spaceId', async () => {
      await expect(call(handlers, 'spaceAgentV2.create', {})).rejects.toThrow(
        'spaceId is required'
      );
    });

    test('rejects a session already bound to another agent', async () => {
      await call(handlers, 'spaceAgentV2.create', {
        spaceId: 'space-1',
        displayName: 'First',
        sessionId: 'session-1',
      });

      await expect(
        call(handlers, 'spaceAgentV2.create', {
          spaceId: 'space-1',
          displayName: 'Second',
          sessionId: 'session-1',
        })
      ).rejects.toThrow('already bound');
    });

    test('rejects a session from another space', async () => {
      sessions.set('foreign', { type: 'space_chat', context: { spaceId: 'space-2' } });

      await expect(
        call(handlers, 'spaceAgentV2.create', {
          spaceId: 'space-1',
          displayName: 'X',
          sessionId: 'foreign',
        })
      ).rejects.toThrow('does not belong to space');
    });

    test('rejects a duplicate display name', async () => {
      await call(handlers, 'spaceAgentV2.create', { spaceId: 'space-1', displayName: 'Taken' });

      await expect(
        call(handlers, 'spaceAgentV2.create', { spaceId: 'space-1', displayName: 'taken' })
      ).rejects.toThrow('is already used');
    });

    test('publishes spaceAgentV2.created carrying the SpaceAgent shape', async () => {
      const { agent } = await call<{ agent: SpaceAgent }>(handlers, 'spaceAgentV2.create', {
        spaceId: 'space-1',
        displayName: 'Publisher',
        tools: ['Read'],
      });

      expect(published).toHaveLength(1);
      expect(published[0].topic).toBe('spaceAgentV2.created');
      const payload = published[0].payload as { spaceId: string; agent: SpaceAgent };
      expect(payload.spaceId).toBe('space-1');
      expect(payload.agent.id).toBe(agent.id);
      expect(payload.agent.tools).toEqual(['Read']);
    });

    test('does not publish when creation is rejected', async () => {
      await expect(
        call(handlers, 'spaceAgentV2.create', { spaceId: 'ghost', displayName: 'X' })
      ).rejects.toThrow();

      expect(published).toHaveLength(0);
    });
  });

  describe('list and get', () => {
    test('list returns agents for the space only', async () => {
      agents.create({ spaceId: 'space-1', handle: 'a' });
      const { agents: listed } = await call<{ agents: SpaceAgent[] }>(
        handlers,
        'spaceAgentV2.list',
        { spaceId: 'space-1' }
      );

      expect(listed.map((a) => a.handle)).toEqual(['a']);
    });

    test('list requires a spaceId', async () => {
      await expect(call(handlers, 'spaceAgentV2.list', {})).rejects.toThrow('spaceId is required');
    });

    test('get returns the agent', async () => {
      const created = agents.create({ spaceId: 'space-1', handle: 'a' });
      const { agent } = await call<{ agent: SpaceAgent }>(handlers, 'spaceAgentV2.get', {
        id: created.id,
      });

      expect(agent.id).toBe(created.id);
    });

    test('get throws for an unknown id', async () => {
      await expect(call(handlers, 'spaceAgentV2.get', { id: 'ghost' })).rejects.toThrow(
        'Agent not found: ghost'
      );
    });
  });

  describe('update', () => {
    test('applies only the supplied fields', async () => {
      const created = agents.create({
        spaceId: 'space-1',
        handle: 'a',
        instructions: 'Keep me.',
      });

      const { agent } = await call<{ agent: SpaceAgent }>(handlers, 'spaceAgentV2.update', {
        id: created.id,
        displayName: 'Renamed',
      });

      expect(agent.displayName).toBe('Renamed');
      expect(agent.instructions).toBe('Keep me.');
    });

    test('does not treat id as an updatable field', async () => {
      const created = agents.create({ spaceId: 'space-1', handle: 'a' });
      const { agent } = await call<{ agent: SpaceAgent }>(handlers, 'spaceAgentV2.update', {
        id: created.id,
        displayName: 'Renamed',
      });

      expect(agent.id).toBe(created.id);
    });

    test('throws for an unknown id', async () => {
      await expect(
        call(handlers, 'spaceAgentV2.update', { id: 'ghost', displayName: 'X' })
      ).rejects.toThrow('Agent not found: ghost');
    });

    test('publishes spaceAgentV2.updated', async () => {
      const created = agents.create({ spaceId: 'space-1', handle: 'a' });
      published = [];

      await call(handlers, 'spaceAgentV2.update', { id: created.id, displayName: 'Renamed' });

      expect(published.map((p) => p.topic)).toEqual(['spaceAgentV2.updated']);
    });

    test('requires an id', async () => {
      await expect(call(handlers, 'spaceAgentV2.update', { displayName: 'X' })).rejects.toThrow(
        'id is required'
      );
    });
  });

  describe('delete', () => {
    test('removes the agent', async () => {
      const created = agents.create({ spaceId: 'space-1', handle: 'a' });
      const result = await call<{ id: string }>(handlers, 'spaceAgentV2.delete', {
        id: created.id,
      });

      expect(result.id).toBe(created.id);
      expect(agents.getById(created.id)).toBeNull();
    });

    test('throws for an unknown id rather than silently succeeding', async () => {
      await expect(call(handlers, 'spaceAgentV2.delete', { id: 'ghost' })).rejects.toThrow(
        'Agent not found: ghost'
      );
    });

    test('refuses to delete the Space Manager agent', async () => {
      const coordinator = agents.create({ spaceId: 'space-1', handle: 'space-manager' });

      await expect(call(handlers, 'spaceAgentV2.delete', { id: coordinator.id })).rejects.toThrow(
        'Space Manager agent cannot be deleted'
      );
      expect(agents.getById(coordinator.id)).not.toBeNull();
    });

    test('deletes an agent even when a workflow node names it', async () => {
      const created = agents.create({ spaceId: 'space-1', handle: 'referenced' });
      const now = Date.now();
      db.prepare(
        `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run('wf-1', 'space-1', 'Release Flow', now, now);
      db.prepare(
        `INSERT INTO space_workflow_nodes (id, workflow_id, name, config, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run('node-1', 'wf-1', 'Worker', JSON.stringify({ agentId: created.id }), now, now);

      await call(handlers, 'spaceAgentV2.delete', { id: created.id });

      expect(agents.getById(created.id)).toBeNull();
    });

    test('publishes spaceAgentV2.deleted with the agent space', async () => {
      const created = agents.create({ spaceId: 'space-1', handle: 'a' });
      published = [];

      await call(handlers, 'spaceAgentV2.delete', { id: created.id });

      expect(published).toHaveLength(1);
      expect(published[0].topic).toBe('spaceAgentV2.deleted');
      expect(published[0].payload).toMatchObject({ spaceId: 'space-1', agentId: created.id });
    });
  });
});
